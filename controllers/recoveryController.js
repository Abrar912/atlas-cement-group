const { getDbConnection } = require('../config/database');
const { safeUrl } = require('../utils/logSafe');
const bcrypt = require('bcryptjs');
const {
    generateUserRecoveryKey,
    generateAdminRecoveryCode,
    hashRecoveryKey,
    verifyRecoveryKey,
    generateBatchId,
    generateRequestId,
    generateResetToken,
    hashResetToken,
    verifyResetToken,
    generateUserRecoveryPDF,
    generateAdminRecoveryPDF,
    cleanupOldPDFs,
    encryptRecoveryKey,
    decryptRecoveryKey
} = require('../utils/recoveryUtils');
const path = require('path');
const fs = require('fs');
const notificationSSE = require('../utils/notificationSSE');
const { purgeUserSessions, keepSidFor } = require('../utils/sessionPurge');

const BCRYPT_SALT_ROUNDS = 12;

function isRecognizedBcryptHash(value) {
    if (!value || typeof value !== 'string') return false;
    return (value.length === 60 && (value.startsWith('$2a$') || value.startsWith('$2b$')));
}

// Rate limiting store (in-memory for simplicity, should use Redis in production)
const rateLimitStore = new Map();

/**
 * Check rate limit for a given identifier
 */
function checkRateLimit(identifier, maxAttempts = 5, windowMs = 15 * 60 * 1000) {
    const now = Date.now();
    const record = rateLimitStore.get(identifier);
    
    if (!record) {
        rateLimitStore.set(identifier, { attempts: 1, resetTime: now + windowMs });
        return true;
    }
    
    if (now > record.resetTime) {
        rateLimitStore.set(identifier, { attempts: 1, resetTime: now + windowMs });
        return true;
    }
    
    if (record.attempts >= maxAttempts) {
        return false;
    }
    
    record.attempts++;
    return true;
}

/**
 * Log recovery operation to audit log
 */
function logAudit(db, userId, actorId, action, details, ipAddress, result, callback) {
    db.run(`
        INSERT INTO recovery_audit_log (user_id, actor_id, action, details, ip_address, result)
        VALUES (?, ?, ?, ?, ?, ?)
    `, [userId, actorId, action, details, ipAddress, result], callback);
}

/**
 * Show account recovery page (account type selection)
 */
function showAccountRecovery(req, res) {
    const message = req.session.message;
    req.session.message = null;
    res.render('account-recovery', { message });
}

/**
 * Show user recovery page
 */
function showUserRecovery(req, res) {
    const message = req.session.message;
    req.session.message = null;
    res.render('user-recovery', { message });
}

/**
 * Show user reset request page
 */
function showUserResetRequest(req, res) {
    const message = req.session.message;
    req.session.message = null;
    res.render('user-reset-request', { message });
}

/**
 * Show admin recovery page
 */
function showAdminRecovery(req, res) {
    const message = req.session.message;
    req.session.message = null;
    res.render('admin-recovery', { message });
}

/**
 * Show admin long key recovery page
 */
function showAdminLongKey(req, res) {
    const message = req.session.message;
    req.session.message = null;
    res.render('admin-long-key', { message });
}

/**
 * Show admin code recovery page
 */
function showAdminCode(req, res) {
    const message = req.session.message;
    req.session.message = null;
    res.render('admin-code', { message });
}

/**
 * Verify user recovery key
 */
function verifyUserRecoveryKey(req, res) {
    const { username, recoveryKey } = req.body;
    const ipAddress = req.ip;
    
    if (!username || !recoveryKey) {
        req.session.message = { type: 'error', text: res.locals.t('recovery.all_fields_required') };
        return res.redirect('/recovery/user');
    }
    
    // Rate limiting
    if (!checkRateLimit(`user-recovery-${username}`)) {
        req.session.message = { type: 'error', text: res.locals.t('recovery.too_many_attempts') };
        return res.redirect('/recovery/user');
    }
    
    const db = getDbConnection();
    
    db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
        if (err) {
            db.close();
            req.session.message = { type: 'error', text: res.locals.t('recovery.database_error') };
            return res.redirect('/recovery/user');
        }
        
        // Don't reveal if user exists for security
        if (!user) {
            db.close();
            logAudit(db, null, null, 'user_recovery_key_verification', `Username: ${username}`, ipAddress, 'user_not_found', () => {});
            req.session.message = { type: 'error', text: res.locals.t('recovery.invalid_credentials') };
            return res.redirect('/recovery/user');
        }
        
        // Get active recovery key
        db.get('SELECT * FROM user_recovery_keys WHERE user_id = ? AND status = "active" ORDER BY created_at DESC LIMIT 1', [user.id], (err, recoveryKeyRecord) => {
            if (err || !recoveryKeyRecord) {
                db.close();
                logAudit(db, user.id, null, 'user_recovery_key_verification', `Username: ${username}`, ipAddress, 'no_active_key', () => {});
                req.session.message = { type: 'error', text: res.locals.t('recovery.invalid_key') };
                return res.redirect('/recovery/user');
            }
            
            // Verify the key
            const isValid = verifyRecoveryKey(recoveryKey, recoveryKeyRecord.key_hash, recoveryKeyRecord.salt);
            
            if (!isValid) {
                db.close();
                logAudit(db, user.id, null, 'user_recovery_key_verification', `Username: ${username}`, ipAddress, 'invalid_key', () => {});
                req.session.message = { type: 'error', text: res.locals.t('recovery.invalid_key') };
                return res.redirect('/recovery/user');
            }
            
            // Key is valid - create reset authorization WITHOUT consuming the key yet
            // The key will be consumed inside the password reset transaction
            const token = generateResetToken();
            const tokenHash = hashResetToken(token);
            const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 minutes
            
            db.run(`
                INSERT INTO password_reset_authorizations (user_id, token_hash, expires_at, recovery_key_id)
                VALUES (?, ?, ?, ?)
            `, [user.id, tokenHash, expiresAt, recoveryKeyRecord.id], (err) => {
                db.close();
                
                if (err) {
                    logAudit(db, user.id, null, 'user_recovery_key_verification', `Username: ${username}`, ipAddress, 'auth_creation_failed', () => {});
                    req.session.message = { type: 'error', text: res.locals.t('recovery.database_error') };
                    return res.redirect('/recovery/user');
                }
                
                logAudit(db, user.id, null, 'user_recovery_key_verification', `Username: ${username}`, ipAddress, 'success', () => {});
                
                // Redirect to password reset page with token
                req.session.message = { type: 'success', text: res.locals.t('recovery.key_verified') };
                res.redirect(`/recovery/reset-password?token=${token}`);
            });
        });
    });
}

/**
 * Verify admin recovery code
 */
function verifyAdminRecoveryCode(req, res) {
    const { username, recoveryCode } = req.body;
    const ipAddress = req.ip;
    
    if (!username || !recoveryCode) {
        req.session.message = { type: 'error', text: res.locals.t('recovery.all_fields_required') };
        return res.redirect('/recovery/admin/code');
    }
    
    // Rate limiting
    if (!checkRateLimit(`admin-recovery-${username}`)) {
        req.session.message = { type: 'error', text: res.locals.t('recovery.too_many_attempts') };
        return res.redirect('/recovery/admin/code');
    }
    
    const db = getDbConnection();
    
    db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
        if (err) {
            db.close();
            req.session.message = { type: 'error', text: res.locals.t('recovery.database_error') };
            return res.redirect('/recovery/admin/code');
        }
        
        // Don't reveal if user exists for security
        if (!user || user.role !== 'admin') {
            db.close();
            logAudit(db, null, null, 'admin_recovery_code_verification', `Username: ${username}`, ipAddress, 'user_not_found', () => {});
            req.session.message = { type: 'error', text: res.locals.t('recovery.invalid_credentials') };
            return res.redirect('/recovery/admin/code');
        }
        
        // Get active recovery codes
        db.all('SELECT * FROM admin_recovery_codes WHERE admin_id = ? AND status = "active" ORDER BY created_at DESC', [user.id], (err, codes) => {
            if (err || !codes || codes.length === 0) {
                db.close();
                logAudit(db, user.id, null, 'admin_recovery_code_verification', `Username: ${username}`, ipAddress, 'no_active_codes', () => {});
                req.session.message = { type: 'error', text: res.locals.t('recovery.invalid_code') };
                return res.redirect('/recovery/admin/code');
            }
            
            // Try to verify against all active codes
            let matchedCode = null;
            for (const codeRecord of codes) {
                if (verifyRecoveryKey(recoveryCode, codeRecord.code_hash, codeRecord.salt)) {
                    matchedCode = codeRecord;
                    break;
                }
            }
            
            if (!matchedCode) {
                db.close();
                logAudit(db, user.id, null, 'admin_recovery_code_verification', `Username: ${username}`, ipAddress, 'invalid_code', () => {});
                req.session.message = { type: 'error', text: res.locals.t('recovery.invalid_code') };
                return res.redirect('/recovery/admin/code');
            }
            
            // Code is valid - use transaction to safely mark as used and create reset authorization
            db.run('BEGIN TRANSACTION', (err) => {
                if (err) {
                    db.close();
                    console.error('[ADMIN CODE RECOVERY] BEGIN TRANSACTION failed:', err);
                    logAudit(db, user.id, null, 'admin_recovery_code_verification', `Username: ${username}`, ipAddress, 'transaction_begin_failed', () => {});
                    req.session.message = { type: 'error', text: res.locals.t('recovery.database_error') };
                    return res.redirect('/recovery/admin/code');
                }
                
                // Mark code as used
                db.run('UPDATE admin_recovery_codes SET status = "used", used_at = CURRENT_TIMESTAMP WHERE id = ?', [matchedCode.id], function(err) {
                    if (err) {
                        db.run('ROLLBACK');
                        db.close();
                        console.error('[ADMIN CODE RECOVERY] UPDATE code failed:', err);
                        logAudit(db, user.id, null, 'admin_recovery_code_verification', `Username: ${username}`, ipAddress, 'mark_used_failed', () => {});
                        req.session.message = { type: 'error', text: res.locals.t('recovery.database_error') };
                        return res.redirect('/recovery/admin/code');
                    }
                    
                    console.log(`[ADMIN CODE RECOVERY] Marked code ${matchedCode.id} as used, affected rows: ${this.changes}`);
                    
                    // Create reset authorization
                    const token = generateResetToken();
                    const tokenHash = hashResetToken(token);
                    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 minutes
                    
                    db.run(`
                        INSERT INTO password_reset_authorizations (user_id, token_hash, expires_at)
                        VALUES (?, ?, ?)
                    `, [user.id, tokenHash, expiresAt], function(err) {
                        if (err) {
                            db.run('ROLLBACK');
                            db.close();
                            console.error('[ADMIN CODE RECOVERY] INSERT authorization failed:', err);
                            logAudit(db, user.id, null, 'admin_recovery_code_verification', `Username: ${username}`, ipAddress, 'auth_creation_failed', () => {});
                            req.session.message = { type: 'error', text: res.locals.t('recovery.database_error') };
                            return res.redirect('/recovery/admin/code');
                        }
                        
                        console.log(`[ADMIN CODE RECOVERY] Created authorization for user_id: ${user.id}`);
                        
                        // Commit transaction
                        db.run('COMMIT', (err) => {
                            if (err) {
                                db.run('ROLLBACK');
                                db.close();
                                console.error('[ADMIN CODE RECOVERY] COMMIT failed:', err);
                                logAudit(db, user.id, null, 'admin_recovery_code_verification', `Username: ${username}`, ipAddress, 'commit_failed', () => {});
                                req.session.message = { type: 'error', text: res.locals.t('recovery.database_error') };
                                return res.redirect('/recovery/admin/code');
                            }
                            
                            console.log(`[ADMIN CODE RECOVERY] Transaction committed successfully`);
                            
                            logAudit(db, user.id, null, 'admin_recovery_code_verification', `Username: ${username}`, ipAddress, 'success', () => {
                                db.close();
                                
                                // Redirect to password reset page with token
                                req.session.message = { type: 'success', text: res.locals.t('recovery.code_verified') };
                                res.redirect(`/recovery/reset-password?token=${token}`);
                            });
                        });
                    });
                });
            });
        });
    });
}

/**
 * Verify admin long key
 */
function verifyAdminLongKey(req, res) {
    const { username, recoveryKey } = req.body;
    const ipAddress = req.ip;
    
    if (!username || !recoveryKey) {
        req.session.message = { type: 'error', text: res.locals.t('recovery.all_fields_required') };
        return res.redirect('/recovery/admin/long-key');
    }
    
    // Rate limiting
    if (!checkRateLimit(`admin-long-key-${username}`)) {
        req.session.message = { type: 'error', text: res.locals.t('recovery.too_many_attempts') };
        return res.redirect('/recovery/admin/long-key');
    }
    
    const db = getDbConnection();
    
    db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
        if (err) {
            db.close();
            req.session.message = { type: 'error', text: res.locals.t('recovery.database_error') };
            return res.redirect('/recovery/admin/long-key');
        }
        
        // Don't reveal if user exists for security
        if (!user || user.role !== 'admin') {
            db.close();
            logAudit(db, null, null, 'admin_long_key_verification', `Username: ${username}`, ipAddress, 'user_not_found', () => {});
            req.session.message = { type: 'error', text: res.locals.t('recovery.invalid_credentials') };
            return res.redirect('/recovery/admin/long-key');
        }
        
        // Get active recovery key (admins can have long-term keys in user_recovery_keys table)
        db.get('SELECT * FROM user_recovery_keys WHERE user_id = ? AND status = "active" ORDER BY created_at DESC LIMIT 1', [user.id], (err, recoveryKeyRecord) => {
            if (err || !recoveryKeyRecord) {
                db.close();
                logAudit(db, user.id, null, 'admin_long_key_verification', `Username: ${username}`, ipAddress, 'no_active_key', () => {});
                req.session.message = { type: 'error', text: res.locals.t('recovery.invalid_key') };
                return res.redirect('/recovery/admin/long-key');
            }
            
            // Verify the key
            const isValid = verifyRecoveryKey(recoveryKey, recoveryKeyRecord.key_hash, recoveryKeyRecord.salt);
            
            if (!isValid) {
                db.close();
                logAudit(db, user.id, null, 'admin_long_key_verification', `Username: ${username}`, ipAddress, 'invalid_key', () => {});
                req.session.message = { type: 'error', text: res.locals.t('recovery.invalid_key') };
                return res.redirect('/recovery/admin/long-key');
            }
            
            // Key is valid - DO NOT mark as used (long-term key remains active)
            // Create reset authorization
            const token = generateResetToken();
            const tokenHash = hashResetToken(token);
            const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 minutes
            
            db.run(`
                INSERT INTO password_reset_authorizations (user_id, token_hash, expires_at)
                VALUES (?, ?, ?)
            `, [user.id, tokenHash, expiresAt], (err) => {
                db.close();
                
                if (err) {
                    logAudit(db, user.id, null, 'admin_long_key_verification', `Username: ${username}`, ipAddress, 'auth_creation_failed', () => {});
                    req.session.message = { type: 'error', text: res.locals.t('recovery.database_error') };
                    return res.redirect('/recovery/admin/long-key');
                }
                
                logAudit(db, user.id, null, 'admin_long_key_verification', `Username: ${username}`, ipAddress, 'success', () => {});
                
                // Redirect to password reset page with token
                req.session.message = { type: 'success', text: res.locals.t('recovery.key_verified') };
                res.redirect(`/recovery/reset-password?token=${token}`);
            });
        });
    });
}

/**
 * Show password reset page
 */
function showPasswordReset(req, res) {
    const { token } = req.query;
    const message = req.session.message;
    req.session.message = null;
    
    if (!token) {
        req.session.message = { type: 'error', text: res.locals.t('recovery.invalid_token') };
        return res.redirect('/recovery');
    }
    
    res.render('password-reset', { token, message });
}

/**
 * Show password reset success page
 */
function showPasswordResetSuccess(req, res) {
    const newRecoveryKey = req.session.newRecoveryKey;
    const newKeyId = req.session.newKeyId;
    const newKeyUserId = req.session.newKeyUserId;
    const newKeyUsername = req.session.newKeyUsername;
    const message = req.session.message;
    
    // Don't clear session data yet - needed for PDF download
    // Session will be cleared after PDF download or timeout
    
    res.render('password-reset-success', { 
        newRecoveryKey, 
        newKeyId, 
        newKeyUserId,
        newKeyUsername,
        message 
    });
}

/**
 * Download recovery key PDF from success page (no auth required, session-based)
 */
function downloadSuccessPagePDF(req, res) {
    const newKeyId = req.session.newKeyId;
    const newKeyUserId = req.session.newKeyUserId;
    const newKeyUsername = req.session.newKeyUsername;
    const newRecoveryKey = req.session.newRecoveryKey;
    
    if (!newKeyId || !newKeyUserId || !newKeyUsername || !newRecoveryKey) {
        return res.status(400).json({ error: 'No recovery key available for download' });
    }
    
    console.log(`[SUCCESS PDF] Downloading PDF for key ID ${newKeyId}, user ${newKeyUsername}`);
    
    const db = getDbConnection();
    
    // Verify the key exists and is active for this user
    db.get('SELECT * FROM user_recovery_keys WHERE id = ? AND user_id = ? AND status = "active"', [newKeyId, newKeyUserId], (err, keyRecord) => {
        if (err || !keyRecord) {
            db.close();
            console.error('[SUCCESS PDF] Key record not found or not active');
            return res.status(404).json({ error: 'Recovery key not found' });
        }
        
        // Get user details for PDF
        db.get('SELECT username, email, full_name, assigned_province FROM users WHERE id = ?', [newKeyUserId], (err, user) => {
            if (err || !user) {
                db.close();
                console.error('[SUCCESS PDF] User not found');
                return res.status(404).json({ error: 'User not found' });
            }
            
            const pdfPath = path.join(__dirname, '..', 'temp', 'recovery-pdfs', `recovery-${newKeyUserId}-${Date.now()}.pdf`);
            const pdfDir = path.dirname(pdfPath);
            
            if (!fs.existsSync(pdfDir)) {
                fs.mkdirSync(pdfDir, { recursive: true });
            }
            
            db.close();
            
            const pdfData = {
                username: user.username,
                fullName: user.full_name,
                userId: user.id,
                accountType: user.role || 'User',
                province: user.assigned_province,
                recoveryKey: newRecoveryKey,
                status: 'Active'
            };
            
            generateUserRecoveryPDF(pdfData, pdfPath)
                .then(() => {
                    console.log(`[SUCCESS PDF] PDF generated successfully for ${user.username}`);
                    
                    // Clear session data after successful PDF generation
                    req.session.newRecoveryKey = null;
                    req.session.newKeyId = null;
                    req.session.newKeyUserId = null;
                    req.session.newKeyUsername = null;
                    
                    res.download(pdfPath, `recovery-key-${user.username}.pdf`, (err) => {
                        // Cleanup after download
                        setTimeout(() => {
                            fs.unlink(pdfPath, (unlinkErr) => {
                                if (unlinkErr) console.error('Error cleaning up PDF:', unlinkErr);
                            });
                        }, 5000);
                    });
                })
                .catch((pdfErr) => {
                    console.error('[SUCCESS PDF] Error generating PDF:', pdfErr);
                    res.status(500).json({ error: 'Error generating PDF' });
                });
        });
    });
}

/**
 * Download recovery key PDF from notification (authenticated endpoint)
 * Verifies user owns the key and key is active before allowing download
 */
function downloadRecoveryKeyPDF(req, res) {
    const keyId = parseInt(req.params.keyId);
    
    if (!keyId) {
        return res.status(400).json({ error: 'Invalid key ID' });
    }
    
    // Require authentication - use existing session structure (user_id, username)
    if (!req.session || !req.session.user_id) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    
    const userId = req.session.user_id;
    const username = req.session.username;
    
    console.log(`[NOTIFICATION PDF] User ${username} requesting PDF for key ID ${keyId}`);
    
    const db = getDbConnection();
    
    // Verify key belongs to authenticated user and is active
    db.get('SELECT * FROM user_recovery_keys WHERE id = ? AND user_id = ? AND status = "active"', [keyId, userId], (err, keyRecord) => {
        if (err) {
            db.close();
            console.error('[NOTIFICATION PDF] Database error:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        
        if (!keyRecord) {
            db.close();
            console.log('[NOTIFICATION PDF] Key not found, not active, or does not belong to user');
            return res.status(403).json({ error: 'Access denied' });
        }
        
        // Get user details for PDF
        db.get('SELECT username, email, full_name, assigned_province, role FROM users WHERE id = ?', [userId], (err, user) => {
            if (err || !user) {
                db.close();
                console.error('[NOTIFICATION PDF] User not found');
                return res.status(404).json({ error: 'User not found' });
            }
            
            // Decrypt the recovery key
            let recoveryKey;
            try {
                if (keyRecord.encrypted_key) {
                    recoveryKey = decryptRecoveryKey(keyRecord.encrypted_key);
                } else {
                    console.error('[NOTIFICATION PDF] Key has no encrypted_key field');
                    db.close();
                    return res.status(500).json({ error: 'Key not encrypted' });
                }
            } catch (decryptErr) {
                console.error('[NOTIFICATION PDF] Error decrypting key:', decryptErr);
                db.close();
                return res.status(500).json({ error: 'Error decrypting key' });
            }
            
            const pdfPath = path.join(__dirname, '..', 'temp', 'recovery-pdfs', `recovery-${userId}-${Date.now()}.pdf`);
            const pdfDir = path.dirname(pdfPath);
            
            if (!fs.existsSync(pdfDir)) {
                fs.mkdirSync(pdfDir, { recursive: true });
            }
            
            db.close();
            
            const pdfData = {
                username: user.username,
                fullName: user.full_name,
                userId: user.id,
                accountType: user.role || 'User',
                province: user.assigned_province,
                recoveryKey: recoveryKey,
                status: 'Active'
            };
            
            generateUserRecoveryPDF(pdfData, pdfPath)
                .then(() => {
                    console.log(`[NOTIFICATION PDF] PDF generated successfully for ${user.username}`);
                    
                    // Note: We do NOT mark the key as used when downloading PDF
                    // The key remains ACTIVE until used for actual password recovery
                    
                    res.download(pdfPath, `recovery-key-${user.username}.pdf`, (err) => {
                        // Cleanup after download
                        setTimeout(() => {
                            fs.unlink(pdfPath, (unlinkErr) => {
                                if (unlinkErr) console.error('Error cleaning up PDF:', unlinkErr);
                            });
                        }, 5000);
                    });
                })
                .catch((pdfErr) => {
                    console.error('[NOTIFICATION PDF] Error generating PDF:', pdfErr);
                    res.status(500).json({ error: 'Error generating PDF' });
                });
        });
    });
}

/**
 * Submit password reset
 */
function submitPasswordReset(req, res) {
    const { token, password, confirmPassword } = req.body;
    const ipAddress = req.ip;
    
    if (!token || !password || !confirmPassword) {
        req.session.message = { type: 'error', text: res.locals.t('recovery.all_fields_required') };
        return res.redirect(`/recovery/reset-password?token=${token}`);
    }
    
    if (password !== confirmPassword) {
        req.session.message = { type: 'error', text: res.locals.t('recovery.passwords_not_match') };
        return res.redirect(`/recovery/reset-password?token=${token}`);
    }
    
    if (password.length < 6) {
        req.session.message = { type: 'error', text: res.locals.t('recovery.password_too_short') };
        return res.redirect(`/recovery/reset-password?token=${token}`);
    }
    
    const db = getDbConnection();
    const tokenHash = hashResetToken(token);
    
    // Begin transaction for atomic password update + new key generation
    db.run('BEGIN TRANSACTION', (err) => {
        if (err) {
            db.close();
            console.error('[PASSWORD RESET] BEGIN TRANSACTION failed:', err);
            logAudit(db, null, null, 'password_reset', `Token: ${tokenHash}`, ipAddress, 'transaction_begin_failed', () => {});
            req.session.message = { type: 'error', text: res.locals.t('recovery.database_error') };
            return res.redirect(`/recovery/reset-password?token=${token}`);
        }
        
        db.get(`
            SELECT * FROM password_reset_authorizations 
            WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > datetime("now")
        `, [tokenHash], (err, auth) => {
            if (err || !auth) {
                db.run('ROLLBACK');
                db.close();
                logAudit(db, null, null, 'password_reset', `Token: ${tokenHash}`, ipAddress, 'invalid_token', () => {});
                req.session.message = { type: 'error', text: res.locals.t('recovery.invalid_token') };
                return res.redirect('/recovery');
            }
            
            // Hash password before update
            console.log(`[PASSWORD RESET] Hashing password for user_id: ${auth.user_id}`);
            bcrypt.hash(password, BCRYPT_SALT_ROUNDS, (hashErr, hashedPassword) => {
                if (hashErr) {
                    db.run('ROLLBACK');
                    db.close();
                    console.error(`[PASSWORD RESET] Hash error:`, hashErr);
                    req.session.message = { type: 'error', text: res.locals.t('recovery.database_error') };
                    return res.redirect(`/recovery/reset-password?token=${token}`);
                }
            
            // Update user password
            console.log(`[PASSWORD RESET] Updating password for user_id: ${auth.user_id}`);
            db.run('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, auth.user_id], function(err) {
                if (err) {
                    db.run('ROLLBACK');
                    db.close();
                    console.error(`[PASSWORD RESET] Database error:`, err);
                    logAudit(db, auth.user_id, null, 'password_reset', `Token: ${tokenHash}`, ipAddress, 'update_failed', () => {});
                    req.session.message = { type: 'error', text: res.locals.t('recovery.database_error') };
                    return res.redirect(`/recovery/reset-password?token=${token}`);
                }
                
                console.log(`[PASSWORD RESET] UPDATE affected ${this.changes} rows`);
                if (this.changes === 0) {
                    db.run('ROLLBACK');
                    db.close();
                    console.error(`[PASSWORD RESET] WARNING: No rows updated! user_id: ${auth.user_id}`);
                    logAudit(db, auth.user_id, null, 'password_reset', `Token: ${tokenHash}`, ipAddress, 'update_failed', () => {});
                    req.session.message = { type: 'error', text: res.locals.t('recovery.database_error') };
                    return res.redirect(`/recovery/reset-password?token=${token}`);
                }
                
                // Get user role before consuming key
                db.get('SELECT role, username FROM users WHERE id = ?', [auth.user_id], (err, user) => {
                    if (err) {
                        db.run('ROLLBACK');
                        db.close();
                        logAudit(db, auth.user_id, null, 'password_reset', `Token: ${tokenHash}`, ipAddress, 'user_fetch_failed', () => {});
                        req.session.message = { type: 'error', text: res.locals.t('recovery.database_error') };
                        return res.redirect(`/recovery/reset-password?token=${token}`);
                    }
                    
                    // Consume the recovery key that was verified (mark as used)
                    // This must happen inside the transaction to ensure atomicity
                    if (auth.recovery_key_id) {
                        db.run('UPDATE user_recovery_keys SET status = "used", used_at = CURRENT_TIMESTAMP WHERE id = ?', [auth.recovery_key_id], (err) => {
                            if (err) {
                                db.run('ROLLBACK');
                                db.close();
                                console.error('[PASSWORD RESET] Error consuming recovery key:', err);
                                logAudit(db, auth.user_id, null, 'password_reset', `Token: ${tokenHash}`, ipAddress, 'key_consume_failed', () => {});
                                req.session.message = { type: 'error', text: res.locals.t('recovery.database_error') };
                                return res.redirect(`/recovery/reset-password?token=${token}`);
                            }
                            
                            console.log(`[PASSWORD RESET] Consumed recovery key ID ${auth.recovery_key_id}`);
                            
                            // Mark authorization as used
                            db.run('UPDATE password_reset_authorizations SET used_at = CURRENT_TIMESTAMP WHERE id = ?', [auth.id], (err) => {
                                if (err) {
                                    db.run('ROLLBACK');
                                    db.close();
                                    logAudit(db, auth.user_id, null, 'password_reset', `Token: ${tokenHash}`, ipAddress, 'mark_used_failed', () => {});
                                    req.session.message = { type: 'error', text: res.locals.t('recovery.database_error') };
                                    return res.redirect(`/recovery/reset-password?token=${token}`);
                                }
                                
                                continuePasswordReset(db, auth, user, tokenHash, ipAddress, req, res);
                            });
                        });
                    } else {
                        // Legacy authorization without recovery_key_id - mark as used and continue
                        db.run('UPDATE password_reset_authorizations SET used_at = CURRENT_TIMESTAMP WHERE id = ?', [auth.id], (err) => {
                            if (err) {
                                db.run('ROLLBACK');
                                db.close();
                                logAudit(db, auth.user_id, null, 'password_reset', `Token: ${tokenHash}`, ipAddress, 'mark_used_failed', () => {});
                                req.session.message = { type: 'error', text: res.locals.t('recovery.database_error') };
                                return res.redirect(`/recovery/reset-password?token=${token}`);
                            }
                            
                            continuePasswordReset(db, auth, user, tokenHash, ipAddress, req, res);
                        });
                    }
                });
            }); // close bcrypt.hash callback
        });
    });
    });
}

/**
 * Continue password reset after key consumption (helper function)
 */
function continuePasswordReset(db, auth, user, tokenHash, ipAddress, req, res) {
    // Revoke ALL existing recovery keys for this user
    db.run('UPDATE user_recovery_keys SET status = "revoked", revoked_at = CURRENT_TIMESTAMP WHERE user_id = ?', [auth.user_id], (err) => {
        if (err) {
            db.run('ROLLBACK');
            db.close();
            console.error('[PASSWORD RESET] Error revoking old keys:', err);
            logAudit(db, auth.user_id, null, 'password_reset', `Token: ${tokenHash}`, ipAddress, 'revoke_failed', () => {});
            req.session.message = { type: 'error', text: res.locals.t('recovery.database_error') };
            return res.redirect(`/recovery/reset-password?token=${token}`);
        }
        
        console.log(`[PASSWORD RESET] Revoked all existing keys for user ${user.username}`);
        
        // Generate new recovery key
        const newKey = generateUserRecoveryKey();
        const { hash, salt } = hashRecoveryKey(newKey);
        const encryptedKey = encryptRecoveryKey(newKey);
        
        db.run(`
            INSERT INTO user_recovery_keys (user_id, key_hash, salt, status, created_by, encrypted_key)
            VALUES (?, ?, ?, 'active', 'system', ?)
        `, [auth.user_id, hash, salt, encryptedKey], function(err) {
            if (err) {
                db.run('ROLLBACK');
                db.close();
                console.error('[PASSWORD RESET] Error inserting new key:', err);
                logAudit(db, auth.user_id, null, 'password_reset', `Token: ${tokenHash}`, ipAddress, 'new_key_failed', () => {});
                req.session.message = { type: 'error', text: res.locals.t('recovery.database_error') };
                return res.redirect(`/recovery/reset-password?token=${token}`);
            }
            
            const newKeyId = this.lastID;
            console.log(`[PASSWORD RESET] Generated new recovery key ID ${newKeyId} for user ${user.username}`);
            
            // Create recovery success notification inside transaction
            const notificationMessage = res.locals.t('notifications.password_recovery_completed_description') || 
                'Your password has been changed successfully. A new recovery key has been generated for your account. Please download and securely store it.';
            
            db.run(`
                INSERT INTO admin_notifications (type, message, related_record_id, related_record_type, recipient, created_by, is_read, created_at)
                VALUES (?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
            `, ['password_recovery_completed', notificationMessage, newKeyId, 'user_recovery_key', user.username, 'system'], function(err) {
                if (err) {
                    db.run('ROLLBACK');
                    db.close();
                    console.error('[PASSWORD RESET] Error creating notification:', err);
                    logAudit(db, auth.user_id, null, 'password_reset', `Token: ${tokenHash}`, ipAddress, 'notification_failed', () => {});
                    req.session.message = { type: 'error', text: res.locals.t('recovery.database_error') };
                    return res.redirect(`/recovery/reset-password?token=${token}`);
                }
                
                const notificationId = this.lastID;
                console.log(`[PASSWORD RESET] Created notification ID ${notificationId} for user ${user.username}`);
                
                // Commit transaction
                db.run('COMMIT', (err) => {
                    if (err) {
                        db.run('ROLLBACK');
                        db.close();
                        console.error('[PASSWORD RESET] COMMIT failed:', err);
                        logAudit(db, auth.user_id, null, 'password_reset', `Token: ${tokenHash}`, ipAddress, 'commit_failed', () => {});
                        req.session.message = { type: 'error', text: res.locals.t('recovery.database_error') };
                        return res.redirect(`/recovery/reset-password?token=${token}`);
                    }
                    
                    console.log(`[PASSWORD RESET] Transaction committed successfully`);
                    
                    logAudit(db, auth.user_id, null, 'password_reset', `Token: ${tokenHash}`, ipAddress, 'success', () => {
                        db.close();
                        
                        // Broadcast notification via SSE
                        notificationSSE.broadcast({
                            id: notificationId,
                            type: 'password_recovery_completed',
                            message: notificationMessage,
                            related_record_id: newKeyId,
                            related_record_type: 'user_recovery_key',
                            recipient: user.username,
                            created_by: 'system',
                            is_read: 0,
                            created_at: new Date().toISOString()
                        });
                        
                        // Store new key in session for success page and PDF download
                        req.session.newRecoveryKey = newKey;
                        req.session.newKeyId = newKeyId;
                        req.session.newKeyUserId = auth.user_id;
                        req.session.newKeyUsername = user.username;
                        
                        req.session.message = { type: 'success', text: res.locals.t('recovery.password_reset_success') };
                        // M6: password changed via recovery — destroy every other session
                        // for this account, then continue to the success page.
                        purgeUserSessions(req.sessionStore, auth.user_id, keepSidFor(req, auth.user_id), () => {
                            res.redirect('/recovery/success');
                        });
                    });
                });
            });
        });
    });
}

/**
 * Submit password recovery request (user → admin)
 */
function submitRecoveryRequest(req, res) {
    const { username, reason } = req.body;
    const ipAddress = req.ip;
    
    if (!username) {
        req.session.message = { type: 'error', text: res.locals.t('recovery.username_required') };
        return res.redirect('/recovery/user');
    }
    
    // Rate limiting
    if (!checkRateLimit(`recovery-request-${username}`)) {
        req.session.message = { type: 'error', text: res.locals.t('recovery.too_many_attempts') };
        return res.redirect('/recovery/user');
    }
    
    const db = getDbConnection();
    
    db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
        if (err) {
            db.close();
            req.session.message = { type: 'error', text: res.locals.t('recovery.database_error') };
            return res.redirect('/recovery/user');
        }
        
        // Don't reveal if user exists for security
        if (!user) {
            db.close();
            logAudit(db, null, null, 'recovery_request', `Username: ${username}`, ipAddress, 'user_not_found', () => {});
            req.session.message = { type: 'success', text: res.locals.t('recovery.request_submitted') };
            return res.redirect('/recovery/user');
        }
        
        // Check for existing pending request
        db.get(`
            SELECT * FROM password_recovery_requests 
            WHERE user_id = ? AND status = 'pending'
        `, [user.id], (err, existingRequest) => {
            if (existingRequest) {
                db.close();
                logAudit(db, user.id, null, 'recovery_request', `Username: ${username}`, ipAddress, 'duplicate_request', () => {});
                req.session.message = { type: 'error', text: res.locals.t('recovery.request_already_pending') };
                return res.redirect('/recovery/user');
            }
            
            // Create new request
            const requestId = generateRequestId();
            
            db.run(`
                INSERT INTO password_recovery_requests (user_id, request_id, status, reason)
                VALUES (?, ?, 'pending', ?)
            `, [user.id, requestId, reason || null], (err) => {
                if (err) {
                    db.close();
                    logAudit(db, user.id, null, 'recovery_request', `Username: ${username}`, ipAddress, 'creation_failed', () => {});
                    req.session.message = { type: 'error', text: res.locals.t('recovery.database_error') };
                    return res.redirect('/recovery/user');
                }
                
                // Create admin notification
                db.run(`
                    INSERT INTO admin_notifications (type, message, related_record_id, related_record_type, recipient, is_read)
                    VALUES (?, ?, ?, ?, 'admin', 0)
                `, ['password_recovery_request', `User ${username} has requested password recovery`, user.id, 'user'], (err) => {
                    db.close();
                    
                    if (err) {
                        console.error('Error creating notification:', err);
                    }
                    
                    logAudit(db, user.id, null, 'recovery_request', `Username: ${username}`, ipAddress, 'success', () => {});
                    req.session.message = { type: 'success', text: res.locals.t('recovery.request_submitted') };
                    res.redirect('/recovery/user');
                });
            });
        });
    });
}

/**
 * Admin: Download recovery PDF
 */
function adminDownloadRecoveryPDF(req, res) {
    console.log(`[PDF HANDLER ENTERED] method=${req.method} url=${safeUrl(req)} userId=${req.params.userId} type=${req.params.type}`);
    
    const { userId, type } = req.params;
    const adminId = req.session.user_id;
    
    console.log(`[PDF] handler entered`);
    console.log(`[PDF] validating user`);
    
    const db = getDbConnection();
    
    db.get('SELECT * FROM users WHERE id = ?', [userId], (err, user) => {
        if (err || !user) {
            db.close();
            return res.status(404).json({ error: 'User not found' });
        }
        
        console.log(`[PDF] user found`);
        console.log(`[PDF] querying active recovery key`);
        
        // Use type parameter to determine which recovery data to retrieve
        // Type can be: 'user-key', 'admin-long-key', 'admin-codes'
        const isKeyRequest = type && (type.includes('key') || type.includes('long-key'));
        const isCodesRequest = type && type.includes('codes');
        
        if (isCodesRequest) {
            // Get active recovery codes with encrypted data
            db.all('SELECT * FROM admin_recovery_codes WHERE admin_id = ? AND status = "active" ORDER BY created_at DESC LIMIT 10', [userId], (err, codes) => {
                if (err || !codes || codes.length === 0) {
                    console.error(`[PDF Request] No active recovery codes found for admin ${userId}`);
                    db.close();
                    return res.status(404).json({ error: 'No active recovery codes found' });
                }
                
                console.log(`[PDF Request] Found ${codes.length} recovery codes, Batch ID: ${codes[0].batch_id}`);
                
                // Decrypt the codes for PDF
                const decryptedCodes = codes.map(c => {
                    if (c.encrypted_code) {
                        try {
                            const decrypted = decryptRecoveryKey(c.encrypted_code);
                            console.log(`[PDF Request] Decrypted code ID ${c.id}: success`);
                            return decrypted;
                        } catch (decryptErr) {
                            console.error(`[PDF Request] Error decrypting code ID ${c.id}:`, decryptErr.message);
                            return 'XXXX-XXXX-XXXX-XXXX';
                        }
                    }
                    console.log(`[PDF Request] Code ID ${c.id} has no encrypted_code field`);
                    return 'XXXX-XXXX-XXXX-XXXX';
                });
                
                const pdfPath = path.join(__dirname, '..', 'temp', 'recovery-pdfs', `recovery-${userId}-${Date.now()}.pdf`);
                const pdfDir = path.dirname(pdfPath);
                
                if (!fs.existsSync(pdfDir)) {
                    fs.mkdirSync(pdfDir, { recursive: true });
                }
                
                db.close();
                
                generateAdminRecoveryPDF({
                    username: user.username,
                    codes: decryptedCodes,
                    batchId: codes[0].batch_id,
                    activeCount: codes.length
                }, pdfPath).then(() => {
                    console.log(`[PDF Request] PDF generated successfully for admin ${user.username} (codes)`);
                    res.download(pdfPath, `recovery-codes-${user.username}.pdf`, () => {
                        // Cleanup after download
                        setTimeout(() => {
                            fs.unlink(pdfPath, () => {});
                        }, 5000);
                    });
                }).catch(err => {
                    console.error('PDF generation error:', err);
                    res.status(500).json({ error: 'PDF generation failed' });
                });
            });
        } else {
            // Get active recovery key with encrypted data (for both user-key and admin-long-key)
            console.log(`[PDF Request] Querying user_recovery_keys for user_id: ${userId}, status: active`);
            
            db.get('SELECT * FROM user_recovery_keys WHERE user_id = ? AND status = "active" ORDER BY created_at DESC LIMIT 1', [userId], (err, keyRecord) => {
                console.log(`[PDF] database query returned`);
                
                if (err || !keyRecord) {
                    console.error(`[PDF Request] No active recovery key found for user ${userId}`);
                    db.close();
                    return res.status(404).json({ error: 'No active recovery key found' });
                }
                
                console.log(`[PDF] selected recordId=${keyRecord.id} status=${keyRecord.status}`);
                
                console.log(`[PDF Request] === DATABASE QUERY RESULTS ===`);
                console.log(`[PDF Request] Record ID: ${keyRecord.id}`);
                console.log(`[PDF Request] user_id: ${keyRecord.user_id}`);
                console.log(`[PDF Request] status: ${keyRecord.status}`);
                console.log(`[PDF Request] created_at: ${keyRecord.created_at}`);
                console.log(`[PDF Request] Has encrypted_key field: ${!!keyRecord.encrypted_key}`);
                console.log(`[PDF Request] encrypted_key length: ${keyRecord.encrypted_key ? keyRecord.encrypted_key.length : 'NULL'}`);
                console.log(`[PDF] encrypted_key present=${!!keyRecord.encrypted_key}`);
                
                // Calculate SHA-256 hash of encrypted_key for forensic verification
                let encryptedKeyHash = 'NULL';
                if (keyRecord.encrypted_key) {
                    const crypto = require('crypto');
                    encryptedKeyHash = crypto.createHash('sha256').update(keyRecord.encrypted_key).digest('hex');
                }
                console.log(`[RECOVERY PDF] userId=${keyRecord.user_id} recordId=${keyRecord.id} status=${keyRecord.status} created_at=${keyRecord.created_at} encrypted_key_hash=${encryptedKeyHash}`);
                
                // Decrypt the key for PDF
                let recoveryKey = 'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX';
                let decryptionSuccess = false;
                
                if (keyRecord.encrypted_key) {
                    try {
                        recoveryKey = decryptRecoveryKey(keyRecord.encrypted_key);
                        decryptionSuccess = true;
                        console.log(`[PDF Request] === DECRYPTION SUCCESS ===`);
                        console.log(`[PDF Request] Decrypted key from record ID ${keyRecord.id}`);
                        console.log(`[PDF Request] Key generated during request: FALSE`);
                        console.log(`[PDF Request] Key source: database record ID ${keyRecord.id}`);
                        console.log(`[PDF] decrypt successful=true`);
                    } catch (decryptErr) {
                        console.error(`[PDF Request] === DECRYPTION FAILED ===`);
                        console.error(`[PDF Request] Error decrypting key ID ${keyRecord.id}:`, decryptErr.message);
                        console.error(`[PDF Request] Stack:`, decryptErr.stack);
                    }
                } else {
                    console.log(`[PDF Request] === NO ENCRYPTED KEY ===`);
                    console.log(`[PDF Request] Key ID ${keyRecord.id} has no encrypted_key field (legacy record)`);
                }
                
                console.log(`[PDF Request] === PDF GENERATION ===`);
                console.log(`[PDF Request] Using recovery key from record ID: ${keyRecord.id}`);
                console.log(`[PDF Request] Decryption successful: ${decryptionSuccess}`);
                console.log(`[PDF] calling generateUserRecoveryPDF`);
                
                const pdfPath = path.join(__dirname, '..', 'temp', 'recovery-pdfs', `recovery-${userId}-${Date.now()}.pdf`);
                const pdfDir = path.dirname(pdfPath);
                
                if (!fs.existsSync(pdfDir)) {
                    fs.mkdirSync(pdfDir, { recursive: true });
                }
                
                db.close();
                
                generateUserRecoveryPDF({
                    username: user.username,
                    recoveryKey: recoveryKey,
                    status: 'Active'
                }, pdfPath).then(() => {
                    console.log(`[PDF Request] PDF generated successfully for user ${user.username} (key)`);
                    console.log(`[PDF] PDF generated successfully`);
                    res.download(pdfPath, `recovery-key-${user.username}.pdf`, () => {
                        // Cleanup after download
                        setTimeout(() => {
                            fs.unlink(pdfPath, () => {});
                        }, 5000);
                    });
                }).catch(err => {
                    console.error('PDF generation error:', err);
                    res.status(500).json({ error: 'PDF generation failed' });
                });
            });
        }
    });
}

/**
 * Admin: Approve recovery request
 */
function adminApproveRecoveryRequest(req, res) {
    const { requestId } = req.params;
    const adminId = req.session.user_id;
    const ipAddress = req.ip;
    
    const db = getDbConnection();
    
    db.get('SELECT * FROM password_recovery_requests WHERE request_id = ? AND status = "pending"', [requestId], (err, request) => {
        if (err || !request) {
            db.close();
            return res.status(404).json({ error: 'Request not found' });
        }
        
        // Create reset authorization
        const token = generateResetToken();
        const tokenHash = hashResetToken(token);
        const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 minutes
        
        db.run(`
            INSERT INTO password_reset_authorizations (user_id, token_hash, expires_at)
            VALUES (?, ?, ?)
        `, [request.user_id, tokenHash, expiresAt], (err) => {
            if (err) {
                db.close();
                return res.status(500).json({ error: 'Database error' });
            }
            
            // Update request status
            db.run(`
                UPDATE password_recovery_requests 
                SET status = 'approved', reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ?
                WHERE id = ?
            `, [adminId, request.id], (err) => {
                db.close();
                
                if (err) {
                    return res.status(500).json({ error: 'Database error' });
                }
                
                logAudit(db, request.user_id, adminId, 'admin_approve_recovery_request', `Request: ${requestId}`, ipAddress, 'success', () => {});
                
                res.json({ 
                    success: true, 
                    token,
                    message: 'Request approved. User can now reset password.' 
                });
            });
        });
    });
}

/**
 * Admin: Reject recovery request
 */
function adminRejectRecoveryRequest(req, res) {
    const { requestId } = req.params;
    const adminId = req.session.user_id;
    const ipAddress = req.ip;
    
    const db = getDbConnection();
    
    db.run(`
        UPDATE password_recovery_requests 
        SET status = 'rejected', reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ?
        WHERE request_id = ?
    `, [adminId, requestId], (err) => {
        db.close();
        
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }
        
        logAudit(db, null, adminId, 'admin_reject_recovery_request', `Request: ${requestId}`, ipAddress, 'success', () => {});
        
        res.json({ 
            success: true, 
            message: 'Request rejected.' 
        });
    });
}

/**
 * Admin: Set user password directly (for password reset requests)
 */
function adminSetUserPassword(req, res) {
    const { requestId, newPassword } = req.body;
    const adminId = req.session.user_id;
    const ipAddress = req.ip;
    
    if (!requestId || !newPassword) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    
    if (newPassword.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    
    const db = getDbConnection();
    
    db.run('BEGIN TRANSACTION', (err) => {
        if (err) {
            db.close();
            console.error('[ADMIN SET PASSWORD] BEGIN TRANSACTION failed:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        
        db.get('SELECT * FROM password_recovery_requests WHERE request_id = ? AND status = "pending"', [requestId], (err, request) => {
            if (err || !request) {
                db.run('ROLLBACK');
                db.close();
                console.error('[ADMIN SET PASSWORD] Request not found or not pending');
                return res.status(404).json({ error: 'Request not found or already processed' });
            }
            
            bcrypt.hash(newPassword, BCRYPT_SALT_ROUNDS, (hashErr, hashedPassword) => {
                if (hashErr) {
                    db.run('ROLLBACK');
                    db.close();
                    console.error('[ADMIN SET PASSWORD] Hash error:', hashErr);
                    return res.status(500).json({ error: 'Database error' });
                }
                
                db.run('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, request.user_id], function(err) {
                    if (err) {
                        db.run('ROLLBACK');
                        db.close();
                        console.error('[ADMIN SET PASSWORD] UPDATE password failed:', err);
                        return res.status(500).json({ error: 'Database error' });
                    }
                    
                    console.log('[ADMIN SET PASSWORD] Updated password for user_id: ' + request.user_id + ', affected rows: ' + this.changes);
                    
                    if (this.changes === 0) {
                        db.run('ROLLBACK');
                        db.close();
                        console.error('[ADMIN SET PASSWORD] No rows updated');
                        return res.status(500).json({ error: 'Failed to update password' });
                    }
                    
                    db.get('SELECT password FROM users WHERE id = ?', [request.user_id], (err, verifyUser) => {
                        if (err || !verifyUser || !isRecognizedBcryptHash(verifyUser.password)) {
                            db.run('ROLLBACK');
                            db.close();
                            console.error('[ADMIN SET PASSWORD] Password verification failed');
                            return res.status(500).json({ error: 'Password verification failed' });
                        }
                        
                        bcrypt.compare(newPassword, verifyUser.password, (cmpErr, isMatch) => {
                            if (cmpErr || !isMatch) {
                                db.run('ROLLBACK');
                                db.close();
                                console.error('[ADMIN SET PASSWORD] Password verification failed');
                                return res.status(500).json({ error: 'Password verification failed' });
                            }
                            
                            db.run('UPDATE password_recovery_requests SET status = ?, reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?', ['approved', adminId, request.id], (err) => {
                                if (err) {
                                    db.run('ROLLBACK');
                                    db.close();
                                    console.error('[ADMIN SET PASSWORD] UPDATE request status failed:', err);
                                    return res.status(500).json({ error: 'Database error' });
                                }
                                
                                db.run('COMMIT', (err) => {
                                    if (err) {
                                        db.run('ROLLBACK');
                                        db.close();
                                        console.error('[ADMIN SET PASSWORD] COMMIT failed:', err);
                                        return res.status(500).json({ error: 'Database error' });
                                    }
                                    
                                    console.log('[ADMIN SET PASSWORD] Transaction committed successfully');
                                    
                                    logAudit(db, request.user_id, adminId, 'admin_set_user_password', 'Request: ' + requestId, ipAddress, 'success', () => {
                                        db.close();
                                        // M6: admin changed this user's password — destroy all
                                        // of that user's existing sessions (keep the admin's own).
                                        purgeUserSessions(req.sessionStore, request.user_id, keepSidFor(req, request.user_id), () => {
                                            res.json({ 
                                                success: true, 
                                                message: 'Password updated successfully and request approved.' 
                                            });
                                        });
                                    });
                                });
                            });
                        });
                    });
                });
            });
        });
    });
}

/**
 * Admin: Get all password reset requests
 */
function adminGetPasswordResetRequests(req, res) {
    const db = getDbConnection();
    
    db.all(`
        SELECT 
            prr.id,
            prr.request_id,
            prr.user_id,
            prr.status,
            prr.reason,
            prr.created_at,
            prr.reviewed_at,
            prr.completed_at,
            u.username,
            u.email,
            u.agency_name,
            u.assigned_province,
            u.role
        FROM password_recovery_requests prr
        JOIN users u ON prr.user_id = u.id
        WHERE u.role != 'admin'
        ORDER BY prr.created_at DESC
    `, (err, requests) => {
        if (err) {
            db.close();
            console.error('[ADMIN GET REQUESTS] Database error:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        
        db.close();
        res.json({ requests });
    });
}

function getUserRecoveryStatus(req, res) {
    const { userId } = req.params;
    
    console.log(`[Status API] Request for user ID: ${userId}`);
    
    const db = getDbConnection();
    
    db.get('SELECT role, username FROM users WHERE id = ?', [userId], (err, user) => {
        if (err || !user) {
            db.close();
            return res.status(404).json({ error: 'User not found' });
        }
        
        console.log(`[Status API] User found: ${user.username}, Role: ${user.role}`);
        
        // Always query user_recovery_keys for long-term Account Recovery Key
        // Must filter by status = 'active' to match PDF query behavior
        db.get('SELECT * FROM user_recovery_keys WHERE user_id = ? AND status = "active" ORDER BY created_at DESC LIMIT 1', [userId], (err, keyRecord) => {
            if (err) {
                db.close();
                return res.status(500).json({ error: 'Database error' });
            }
            
            let keyData = {
                hasKey: false,
                recoveryKey: null,
                status: 'none',
                created_at: null,
                used_at: null,
                created_by: null
            };
            
            if (keyRecord) {
                console.log(`[Status API] === MODAL QUERY RESULTS ===`);
                console.log(`[Status API] Record ID: ${keyRecord.id}`);
                console.log(`[Status API] user_id: ${keyRecord.user_id}`);
                console.log(`[Status API] status: ${keyRecord.status}`);
                console.log(`[Status API] created_at: ${keyRecord.created_at}`);
                console.log(`[Status API] Has encrypted_key field: ${!!keyRecord.encrypted_key}`);
                console.log(`[Status API] encrypted_key length: ${keyRecord.encrypted_key ? keyRecord.encrypted_key.length : 'NULL'}`);
                
                // Calculate SHA-256 hash of encrypted_key for forensic verification
                let encryptedKeyHash = 'NULL';
                if (keyRecord.encrypted_key) {
                    const crypto = require('crypto');
                    encryptedKeyHash = crypto.createHash('sha256').update(keyRecord.encrypted_key).digest('hex');
                }
                console.log(`[RECOVERY MODAL] userId=${keyRecord.user_id} recordId=${keyRecord.id} status=${keyRecord.status} created_at=${keyRecord.created_at} encrypted_key_hash=${encryptedKeyHash}`);
                
                keyData.hasKey = true;
                keyData.status = keyRecord.status;
                keyData.created_at = keyRecord.created_at;
                keyData.used_at = keyRecord.used_at;
                keyData.created_by = keyRecord.created_by;
                
                if (keyRecord.encrypted_key && keyRecord.status === 'active') {
                    try {
                        keyData.recoveryKey = decryptRecoveryKey(keyRecord.encrypted_key);
                        console.log(`[Status API] === DECRYPTION SUCCESS ===`);
                        console.log(`[Status API] Decrypted key from record ID ${keyRecord.id}`);
                        console.log(`[Status API] Key generated during request: FALSE`);
                        console.log(`[Status API] Key source: database record ID ${keyRecord.id}`);
                    } catch (decryptErr) {
                        console.error(`[Status API] === DECRYPTION FAILED ===`);
                        console.error(`[Status API] Error decrypting key ID ${keyRecord.id}:`, decryptErr.message);
                    }
                } else if (keyRecord.status === 'active') {
                    console.log(`[Status API] === NO ENCRYPTED KEY ===`);
                    console.log(`[Status API] Key is active but has no encrypted_key (legacy record)`);
                }
            } else {
                console.log(`[Status API] No key record found for user ${user.username}`);
            }
            
            // If admin, also query admin_recovery_codes for One-Time Recovery Codes
            if (user.role === 'admin') {
                // Get latest batch ID first
                db.get('SELECT batch_id FROM admin_recovery_codes WHERE admin_id = ? ORDER BY created_at DESC LIMIT 1', [userId], (err, batchRow) => {
                    if (err) {
                        db.close();
                        return res.status(500).json({ error: 'Database error' });
                    }
                    
                    const latestBatchId = batchRow ? batchRow.batch_id : null;
                    
                    if (!latestBatchId) {
                        // No codes exist yet
                        db.close();
                        console.log(`[Status API] No admin recovery codes found for ${user.username}`);
                        res.json({ 
                            type: 'admin', 
                            username: user.username,
                            // Long-term Account Recovery Key
                            hasKey: keyData.hasKey,
                            recoveryKey: keyData.recoveryKey,
                            status: keyData.status,
                            created_at: keyData.created_at,
                            used_at: keyData.used_at,
                            created_by: keyData.created_by,
                            // One-Time Recovery Codes
                            hasCodes: false,
                            codes: [],
                            activeCount: 0, 
                            usedCount: 0,
                            total: 10,
                            latestBatchId: null
                        });
                        return;
                    }
                    
                    // Query only codes from the latest batch
                    db.all('SELECT id, status, created_at, used_at, encrypted_code FROM admin_recovery_codes WHERE admin_id = ? AND batch_id = ? ORDER BY created_at DESC', [userId, latestBatchId], (err, codes) => {
                        if (err) {
                            db.close();
                            return res.status(500).json({ error: 'Database error' });
                        }
                        
                        const activeCount = codes.filter(c => c.status === 'active').length;
                        const usedCount = codes.filter(c => c.status === 'used').length;
                        
                        console.log(`[Status API] Found ${codes.length} admin recovery codes (latest batch), Active: ${activeCount}, Used: ${usedCount}, Batch: ${latestBatchId}`);
                        
                        // Decrypt codes for display
                        const decryptedCodes = codes.map(c => {
                            let code = null;
                            if (c.encrypted_code && c.status === 'active') {
                                try {
                                    code = decryptRecoveryKey(c.encrypted_code);
                                    console.log(`[Status API] Decrypted code ID ${c.id}: success`);
                                } catch (decryptErr) {
                                    console.error(`[Status API] Error decrypting code ID ${c.id}:`, decryptErr.message);
                                }
                            }
                            return {
                                id: c.id,
                                status: c.status,
                                created_at: c.created_at,
                                used_at: c.used_at,
                                code: code
                            };
                        });
                        
                        db.close();
                        
                        console.log(`[Status API] Returning admin status for ${user.username} with both key and codes`);
                        res.json({ 
                            type: 'admin', 
                            username: user.username,
                            // Long-term Account Recovery Key (use same property names as non-admin for consistency)
                            hasKey: keyData.hasKey,
                            recoveryKey: keyData.recoveryKey,
                            status: keyData.status,
                            created_at: keyData.created_at,
                            used_at: keyData.used_at,
                            created_by: keyData.created_by,
                            // One-Time Recovery Codes
                            hasCodes: codes.length > 0,
                            codes: decryptedCodes,
                            activeCount, 
                            usedCount,
                            total: 10,
                            latestBatchId: latestBatchId
                        });
                    });
                });
            } else {
                // Non-admin: return only key data
                db.close();
                console.log(`[Status API] Returning user status for ${user.username} with key: ${keyData.recoveryKey ? 'YES' : 'NO'}`);
                res.json({ 
                    type: 'user', 
                    username: user.username,
                    hasKey: keyData.hasKey, 
                    status: keyData.status,
                    created_at: keyData.created_at,
                    used_at: keyData.used_at,
                    created_by: keyData.created_by,
                    recoveryKey: keyData.recoveryKey
                });
            }
        });
    });
}

/**
 * Admin: Generate new recovery key for a user
 */
function adminGenerateUserRecoveryKey(req, res) {
    const { userId } = req.params;
    const adminId = req.session.user_id;
    const ipAddress = req.ip;
    
    const db = getDbConnection();
    
    // Get user info
    db.get('SELECT id, username, role FROM users WHERE id = ?', [userId], (err, user) => {
        if (err || !user) {
            db.close();
            return res.status(404).json({ error: 'User not found' });
        }
        
        if (user.role === 'admin') {
            db.close();
            return res.status(400).json({ error: 'Cannot generate user recovery key for admin account' });
        }
        
        // Mark existing active key as revoked (if any)
        db.run('UPDATE user_recovery_keys SET status = "revoked", revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND status = "active"', [userId], (err) => {
            if (err) {
                console.error('Error revoking old key:', err);
            }
            
            // Generate new recovery key
            const recoveryKey = generateUserRecoveryKey();
            const { hash, salt } = hashRecoveryKey(recoveryKey);
            const encryptedKey = encryptRecoveryKey(recoveryKey);
            
            db.run(`
                INSERT INTO user_recovery_keys (user_id, key_hash, salt, status, created_by, encrypted_key)
                VALUES (?, ?, ?, 'active', ?, ?)
            `, [userId, hash, salt, req.session.username, encryptedKey], (err) => {
                if (err) {
                    db.close();
                    return res.status(500).json({ error: 'Database error' });
                }
                
                logAudit(db, userId, adminId, 'admin_generate_user_recovery_key', `Username: ${user.username}`, ipAddress, 'success', () => {
                    db.close();
                    res.json({ 
                        success: true, 
                        recoveryKey,
                        message: 'Recovery key generated successfully' 
                    });
                });
            });
        });
    });
}

/**
 * Admin: Generate new admin recovery codes batch
 */
function adminGenerateAdminRecoveryCodes(req, res) {
    const { userId } = req.params;
    const adminId = req.session.user_id;
    const ipAddress = req.ip;
    
    const db = getDbConnection();
    
    // Get user info
    db.get('SELECT id, username, role FROM users WHERE id = ?', [userId], (err, user) => {
        if (err || !user) {
            db.close();
            return res.status(404).json({ error: 'User not found' });
        }
        
        if (user.role !== 'admin') {
            db.close();
            return res.status(400).json({ error: 'Cannot generate admin recovery codes for non-admin account' });
        }
        
        // Begin transaction for atomic DELETE + INSERT
        db.run('BEGIN TRANSACTION', (err) => {
            if (err) {
                db.close();
                return res.status(500).json({ error: 'Database error' });
            }
            
            // Delete all existing codes for this admin
            db.run('DELETE FROM admin_recovery_codes WHERE admin_id = ?', [userId], (err) => {
                if (err) {
                    db.run('ROLLBACK');
                    db.close();
                    console.error('Error deleting old codes:', err);
                    return res.status(500).json({ error: 'Database error' });
                }
                
                // Generate new batch of 10 codes
                const batchId = generateBatchId();
                const codes = [];
                for (let i = 0; i < 10; i++) {
                    const code = generateAdminRecoveryCode();
                    const { hash, salt } = hashRecoveryKey(code);
                    const encryptedCode = encryptRecoveryKey(code);
                    codes.push({ code, hash, salt, encryptedCode });
                }
                
                let inserted = 0;
                codes.forEach(({ code, hash, salt, encryptedCode }) => {
                    db.run(`
                        INSERT INTO admin_recovery_codes (admin_id, code_hash, salt, status, batch_id, encrypted_code)
                        VALUES (?, ?, ?, 'active', ?, ?)
                    `, [userId, hash, salt, batchId, encryptedCode], (err) => {
                        if (err) {
                            db.run('ROLLBACK');
                            db.close();
                            console.error('Error inserting admin recovery code:', err);
                            return res.status(500).json({ error: 'Database error' });
                        }
                        
                        inserted++;
                        if (inserted === codes.length) {
                            // All codes inserted successfully, commit transaction
                            db.run('COMMIT', (err) => {
                                if (err) {
                                    db.run('ROLLBACK');
                                    db.close();
                                    console.error('Error committing transaction:', err);
                                    return res.status(500).json({ error: 'Database error' });
                                }
                                
                                logAudit(db, userId, adminId, 'admin_generate_admin_recovery_codes', `Username: ${user.username}, Batch: ${batchId}`, ipAddress, 'success', () => {
                                    db.close();
                                    res.json({ 
                                        success: true, 
                                        codes: codes.map(c => c.code),
                                        batchId,
                                        message: '10 recovery codes generated successfully' 
                                    });
                                });
                            });
                        }
                    });
                });
            });
        });
    });
}

/**
 * Admin: Generate long recovery key for admin (alternative to 10 codes)
 */
function adminGenerateAdminLongKey(req, res) {
    console.log(`[RECOVERY GENERATION CALLED] method=${req.method} url=${safeUrl(req)} userId=${req.params.userId}`);
    
    const { userId } = req.params;
    const adminId = req.session.user_id;
    const ipAddress = req.ip;
    
    const db = getDbConnection();
    
    // Get user info
    db.get('SELECT id, username, role FROM users WHERE id = ?', [userId], (err, user) => {
        if (err || !user) {
            db.close();
            return res.status(404).json({ error: 'User not found' });
        }
        
        if (user.role !== 'admin') {
            db.close();
            return res.status(400).json({ error: 'Cannot generate admin long key for non-admin account' });
        }
        
        // Generate long recovery key (same format as user keys)
        const recoveryKey = generateUserRecoveryKey();
        const { hash, salt } = hashRecoveryKey(recoveryKey);
        const encryptedKey = encryptRecoveryKey(recoveryKey);
        
        // Store in user_recovery_keys table (admins can have both)
        // Mark existing active key as revoked
        db.run('UPDATE user_recovery_keys SET status = "revoked", revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND status = "active"', [userId], (err) => {
            if (err) {
                console.error('Error revoking old key:', err);
            }
            
            db.run(`
                INSERT INTO user_recovery_keys (user_id, key_hash, salt, status, created_by, encrypted_key)
                VALUES (?, ?, ?, 'active', ?, ?)
            `, [userId, hash, salt, req.session.username, encryptedKey], (err) => {
                if (err) {
                    db.close();
                    return res.status(500).json({ error: 'Database error' });
                }
                
                logAudit(db, userId, adminId, 'admin_generate_admin_long_key', `Username: ${user.username}`, ipAddress, 'success', () => {
                    db.close();
                    res.json({ 
                        success: true, 
                        recoveryKey,
                        message: 'Admin long recovery key generated successfully' 
                    });
                });
            });
        });
    });
}

/**
 * Worker: Get my recovery key
 */
function workerGetMyRecoveryKey(req, res) {
    const userId = req.session.user_id;
    const username = req.session.username;
    
    if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const db = getDbConnection();
    
    db.get('SELECT * FROM user_recovery_keys WHERE user_id = ? AND status = "active"', [userId], (err, keyRecord) => {
        if (err) {
            db.close();
            return res.status(500).json({ error: 'Database error' });
        }
        
        if (!keyRecord) {
            db.close();
            return res.status(404).json({ error: 'No active recovery key found' });
        }
        
        db.get('SELECT username, email, full_name FROM users WHERE id = ?', [userId], (err, user) => {
            db.close();
            
            if (err || !user) {
                return res.status(500).json({ error: 'User not found' });
            }
            
            // Decrypt the recovery key
            let recoveryKey = null;
            if (keyRecord.encrypted_key) {
                try {
                    recoveryKey = decryptRecoveryKey(keyRecord.encrypted_key);
                } catch (decryptErr) {
                    console.error('Error decrypting recovery key:', decryptErr);
                    return res.status(500).json({ error: 'Error decrypting recovery key' });
                }
            }
            
            res.json({
                success: true,
                hasKey: true,
                recoveryKey: recoveryKey,
                createdAt: keyRecord.created_at,
                user: {
                    username: user.username,
                    email: user.email,
                    fullName: user.full_name
                }
            });
        });
    });
}

/**
 * Worker: Download my recovery key as PDF
 */
function workerDownloadMyRecoveryPDF(req, res) {
    const userId = req.session.user_id;
    const username = req.session.username;
    
    if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const db = getDbConnection();
    
    db.get('SELECT * FROM user_recovery_keys WHERE user_id = ? AND status = "active"', [userId], (err, keyRecord) => {
        if (err) {
            db.close();
            return res.status(500).json({ error: 'Database error' });
        }
        
        if (!keyRecord) {
            db.close();
            return res.status(404).json({ error: 'No active recovery key found' });
        }
        
        db.get('SELECT username, email, full_name, assigned_province FROM users WHERE id = ?', [userId], (err, user) => {
            db.close();
            
            if (err || !user) {
                return res.status(500).json({ error: 'User not found' });
            }
            
            // Decrypt the recovery key
            let recoveryKey = null;
            if (keyRecord.encrypted_key) {
                try {
                    recoveryKey = decryptRecoveryKey(keyRecord.encrypted_key);
                } catch (decryptErr) {
                    console.error('Error decrypting recovery key:', decryptErr);
                    return res.status(500).json({ error: 'Error decrypting recovery key' });
                }
            }
            
            // Generate PDF
            const pdfDir = path.join(__dirname, '../temp/recovery-pdfs');
            if (!fs.existsSync(pdfDir)) {
                fs.mkdirSync(pdfDir, { recursive: true });
            }
            
            const pdfPath = path.join(pdfDir, `recovery-key-${userId}-${Date.now()}.pdf`);
            
            const pdfData = {
                username: user.username,
                fullName: user.full_name,
                userId: userId,
                accountType: 'Worker',
                province: user.assigned_province,
                recoveryKey: recoveryKey,
                status: 'Active'
            };
            
            generateUserRecoveryPDF(pdfData, pdfPath)
                .then(() => {
                    res.download(pdfPath, `recovery-key-${user.username}.pdf`, (err) => {
                        // Clean up PDF after download
                        setTimeout(() => {
                            fs.unlink(pdfPath, (unlinkErr) => {
                                if (unlinkErr) console.error('Error cleaning up PDF:', unlinkErr);
                            });
                        }, 5000);
                    });
                })
                .catch((pdfErr) => {
                    console.error('Error generating PDF:', pdfErr);
                    res.status(500).json({ error: 'Error generating PDF' });
                });
        });
    });
}

module.exports = {
    showAccountRecovery,
    showUserRecovery,
    showUserResetRequest,
    showAdminRecovery,
    showAdminLongKey,
    showAdminCode,
    showPasswordReset,
    showPasswordResetSuccess,
    downloadSuccessPagePDF,
    downloadRecoveryKeyPDF,
    verifyUserRecoveryKey,
    verifyAdminRecoveryCode,
    verifyAdminLongKey,
    submitPasswordReset,
    submitRecoveryRequest,
    adminGenerateUserRecoveryKey,
    adminGenerateAdminRecoveryCodes,
    adminGenerateAdminLongKey,
    adminDownloadRecoveryPDF,
    adminApproveRecoveryRequest,
    adminRejectRecoveryRequest,
    adminSetUserPassword,
    adminGetPasswordResetRequests,
    getUserRecoveryStatus,
    workerGetMyRecoveryKey,
    workerDownloadMyRecoveryPDF
};
