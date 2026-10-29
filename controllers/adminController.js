const { getDbConnection } = require('../config/database');
const { likeContains } = require('../utils/sqlSafety');
const notificationSSE = require('../utils/notificationSSE');
const {
    getStockAvailability,
    assertSaleWithinStock,
    upsertStockSale,
    removeStockSale,
    hasStockSale
} = require('./cementStockController');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const {
    generateUserRecoveryKey,
    generateAdminRecoveryCode,
    hashRecoveryKey,
    generateBatchId,
    encryptRecoveryKey
} = require('../utils/recoveryUtils');

const BCRYPT_SALT_ROUNDS = 12;
const { purgeUserSessions, keepSidFor } = require('../utils/sessionPurge');

function adminDashboard(req, res) {
    const db = getDbConnection();
    
    // Admin privilege: full visibility of all customers across all provinces
    db.all('SELECT * FROM customers ORDER BY name ASC', (err, customers) => {
        if (err) {
            db.close();
            return res.status(500).send('Database error');
        }
        
        db.all('SELECT customer_id, SUM(net_cement_money) as total_debit FROM sales_logs GROUP BY customer_id', (err, salesSums) => {
            if (err) {
                db.close();
                return res.status(500).send('Database error');
            }
            
            db.all('SELECT customer_id, SUM(amount_received) as total_credit FROM receipts_logs GROUP BY customer_id', (err, receiptSums) => {
                if (err) {
                    db.close();
                    return res.status(500).send('Database error');
                }
                
                // Calculate total sales money (using net_cement_money = پول خالص سمنت) and total money received
                db.all('SELECT SUM(net_cement_money) as total_sales FROM sales_logs', (err, totalSalesResult) => {
                    if (err) {
                        db.close();
                        return res.status(500).send('Database error');
                    }
                    
                    db.all('SELECT SUM(amount_received) as total_received FROM receipts_logs', (err, totalReceivedResult) => {
                        if (err) {
                            db.close();
                            return res.status(500).send('Database error');
                        }
                        
                        // Fetch all non-admin worker users for the dropdown filter
                        db.all('SELECT id, username, role, assigned_province, agency_name FROM users WHERE role = "worker" ORDER BY username ASC', (err, agentAccounts) => {
                            db.close();
                            if (err) {
                                return res.status(500).send('Database error');
                            }
                            
                            const debits = {};
                            const credits = {};
                            
                            salesSums.forEach(row => {
                                debits[row.customer_id] = row.total_debit;
                            });
                            
                            receiptSums.forEach(row => {
                                credits[row.customer_id] = row.total_credit;
                            });
                            
                            let totalReceivables = 0.0;
                            let totalPayables = 0.0;
                            
                            const allCustIds = new Set([...Object.keys(debits), ...Object.keys(credits)]);
                            allCustIds.forEach(cId => {
                                const bal = (debits[cId] || 0.0) - (credits[cId] || 0.0);
                                if (bal > 0) {
                                    totalReceivables += bal;
                                } else if (bal < 0) {
                                    totalPayables += Math.abs(bal);
                                }
                            });
                            
                            const totalSalesMoney = totalSalesResult[0]?.total_sales || 0;
                            const totalMoneyReceived = totalReceivedResult[0]?.total_received || 0;
                            
                            res.render('admin_dashboard', {
                                customers,
                                agentAccounts,
                                total_receivables: totalReceivables,
                                total_payables: totalPayables,
                                total_sales_money: totalSalesMoney,
                                total_money_received: totalMoneyReceived
                            });
                        });
                    });
                });
            });
        });
    });
}

function adminManageWorkers(req, res) {
    const db = getDbConnection();
    
    if (req.method === 'POST') {
        const { full_name, position, date_of_entrance, tazkira_details, phone_number, address } = req.body;
        
        db.run(`
            INSERT INTO worker_profiles (full_name, position, date_of_entrance, tazkira_details, phone_number, address)
            VALUES (?, ?, ?, ?, ?, ?)
        `, [full_name, position, date_of_entrance, tazkira_details, phone_number, address], (err) => {
            if (err) {
                req.session.message = { type: 'error', text: 'Error adding worker profile.' };
            } else {
                req.session.message = { type: 'success', text: 'Worker database card added to HR catalog successfully!' };
            }
            
            db.all('SELECT * FROM worker_profiles ORDER BY id DESC', (err, workers) => {
                db.close();
                const message = req.session.message;
                req.session.message = null;
                res.render('admin_workers', { workers, message });
            });
        });
    } else {
        db.all('SELECT * FROM worker_profiles ORDER BY id DESC', (err, workers) => {
            db.close();
            const message = req.session.message;
            req.session.message = null;
            res.render('admin_workers', { workers, message });
        });
    }
}

function adminDeleteWorker(req, res) {
    const { id } = req.params;
    const db = getDbConnection();
    db.run('DELETE FROM worker_profiles WHERE id = ?', [id], (err) => {
        db.close();
        req.session.message = { type: 'success', text: 'Worker database card purged from catalog records.' };
        res.redirect('/admin/manage-workers');
    });
}

function adminManageUsers(req, res) {
    const db = getDbConnection();
    const searchQuery = req.query.search ? req.query.search.trim() : '';
    
    let query = 'SELECT id, username, role, assigned_province, email, profile_picture, permissions, agency_name, password FROM users';
    let params = [];
    
    if (searchQuery) {
        query += ` WHERE 
            username LIKE ? ESCAPE '\\' 
            OR email LIKE ? ESCAPE '\\' 
            OR agency_name LIKE ? ESCAPE '\\' 
            OR assigned_province LIKE ? ESCAPE '\\' 
            ORDER BY id ASC`;
        const searchTerm = likeContains(searchQuery);
        params = [searchTerm, searchTerm, searchTerm, searchTerm];
    } else {
        query += ' ORDER BY id ASC';
    }
    
    db.all(query, params, (err, users) => {
        db.close();
        if (err) {
            return res.status(500).send('Database error');
        }
        const message = req.session.message;
        req.session.message = null;
        res.render('admin/manage-users', { users, message, session: req.session, searchQuery });
    });
}

function adminAddUser(req, res) {
    const { 
        username, 
        password, 
        role, 
        assigned_province, 
        email, 
        profile_picture,
        permissions
    } = req.body;
    
    // Input sanitization & trimming
    const cleanUsername = username ? username.trim() : '';
    const cleanEmail = email && email.trim() !== '' ? email.trim().toLowerCase() : null;
    const assignedProvince = assigned_province || '';
    const userRole = role || 'worker';
    const userPermissions = permissions ? JSON.stringify(permissions) : JSON.stringify(['waybill-entry']);
    const profilePicture = profile_picture || null;
    
    // Validate role - only allow 'worker' or 'admin'
    if (userRole !== 'worker' && userRole !== 'admin') {
        const db = getDbConnection();
        db.all('SELECT id, username, role, assigned_province, email, profile_picture, permissions FROM users ORDER BY id ASC', (err, users) => {
            db.close();
            if (err) {
                return res.status(500).send('Database error');
            }
            res.render('admin/manage-users', { 
                users, 
                error: 'نقش کاربری نامعتبر است. فقط کارمند (Worker) و مدیر (Admin) مجاز هستند.',
                session: req.session 
            });
        });
        return;
    }
    
    if (!cleanUsername || !password) {
        const db = getDbConnection();
        db.all('SELECT id, username, role, assigned_province, email, profile_picture, permissions FROM users ORDER BY id ASC', (err, users) => {
            db.close();
            if (err) {
                return res.status(500).send('Database error');
            }
            res.render('admin/manage-users', { 
                users, 
                error: 'لطفاً نام کاربری و رمز عبور را وارد کنید.',
                session: req.session 
            });
        });
        return;
    }
    
    // Validate password length (minimum 8 characters)
    if (password.length < 8) {
        const db = getDbConnection();
        db.all('SELECT id, username, role, assigned_province, email, profile_picture, permissions FROM users ORDER BY id ASC', (err, users) => {
            db.close();
            if (err) {
                return res.status(500).send('Database error');
            }
            res.render('admin/manage-users', { 
                users, 
                error: 'کلمه عبور باید حداقل ۸ کاراکتر باشد.',
                session: req.session 
            });
        });
        return;
    }
    
    const db = getDbConnection();
    
    // Check for existing username or email
    db.get(
        `SELECT id, username, email FROM users 
         WHERE LOWER(username) = LOWER(?) 
         OR (? IS NOT NULL AND LOWER(email) = LOWER(?))`,
        [cleanUsername, cleanEmail, cleanEmail],
        (err, existingUser) => {
            if (err) {
                db.close();
                return res.status(500).send('Database error');
            }
            
            if (existingUser) {
                db.close();
                db.all('SELECT id, username, role, assigned_province, email, full_name, permissions FROM users ORDER BY id ASC', (err, users) => {
                    if (err) {
                        return res.status(500).send('Database error');
                    }
                    let error;
                    if (existingUser.username.toLowerCase() === cleanUsername.toLowerCase()) {
                        error = 'این نام کاربری (username) قبلاً در سیستم ثبت شده است. لطفاً یک نام کاربری جدید انتخاب کنید.';
                    } else if (cleanEmail && existingUser.email && existingUser.email.toLowerCase() === cleanEmail.toLowerCase()) {
                        error = 'این آدرس ایمیل قبلاً در سیستم ثبت شده است.';
                    } else {
                        error = 'خطا: نام کاربری یا ایمیل قبلاً در سیستم ثبت شده است.';
                    }
                    res.render('admin/manage-users', { users, error, session: req.session });
                });
                return;
            }
            
            // Hash password before inserting
            bcrypt.hash(password, BCRYPT_SALT_ROUNDS, (hashErr, hashedPassword) => {
                if (hashErr) {
                    db.close();
                    db.all('SELECT id, username, role, assigned_province, email, profile_picture, permissions, agency_name FROM users ORDER BY id ASC', (err, users) => {
                        if (err) {
                            return res.status(500).send('Database error');
                        }
                        res.render('admin/manage-users', {
                            users,
                            error: 'خطا در ایجاد حساب کاربری.',
                            session: req.session
                        });
                    });
                    return;
                }

            // Insert new user
            db.run(
                `INSERT INTO users (username, password, role, assigned_province, email, profile_picture, permissions, agency_name)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    cleanUsername,
                    hashedPassword,
                    userRole,
                    assignedProvince,
                    cleanEmail,
                    profilePicture,
                    userPermissions,
                    req.body.agency_name || ''
                ],
                function(err) {
                    if (err) {
                        db.close();
                        db.all('SELECT id, username, role, assigned_province, email, profile_picture, permissions, agency_name FROM users ORDER BY id ASC', (err, users) => {
                            if (err) {
                                return res.status(500).send('Database error');
                            }
                            res.render('admin/manage-users', {
                                users,
                                error: 'خطا در ایجاد حساب کاربری.',
                                session: req.session
                            });
                        });
                    } else {
                        const userId = this.lastID;
                        const adminName = req.session.username || 'admin';
                        let recoveryKey = null;
                        
                        // Generate recovery key for users or recovery codes for admins
                        if (userRole === 'admin') {
                            // Generate 10 recovery codes for admin (L10: store the
                            // encrypted copy too — hash-only codes can never be shown
                            // to the admin again, making them useless for recovery PDFs)
                            const batchId = generateBatchId();
                            const codes = [];
                            for (let i = 0; i < 10; i++) {
                                const code = generateAdminRecoveryCode();
                                const { hash, salt } = hashRecoveryKey(code);
                                codes.push({ code, hash, salt, encryptedCode: encryptRecoveryKey(code) });
                            }
                            
                            let inserted = 0;
                            codes.forEach(({ code, hash, salt, encryptedCode }) => {
                                db.run(`
                                    INSERT INTO admin_recovery_codes (admin_id, code_hash, salt, status, batch_id, encrypted_code)
                                    VALUES (?, ?, ?, 'active', ?, ?)
                                `, [userId, hash, salt, batchId, encryptedCode], (err) => {
                                    inserted++;
                                    if (err) {
                                        console.error('Error inserting admin recovery code:', err);
                                    }
                                    if (inserted === codes.length) {
                                        console.log(`Generated 10 recovery codes for admin ${cleanUsername}`);
                                    }
                                });
                            });
                        } else {
                            // Generate 1 recovery key for worker
                            recoveryKey = generateUserRecoveryKey();
                            const { hash, salt } = hashRecoveryKey(recoveryKey);
                            const encryptedKey = encryptRecoveryKey(recoveryKey);
                            
                            // Verify userId is valid before inserting recovery key
                            if (!userId) {
                                console.error('[ERROR] Cannot insert recovery key: userId is null/undefined');
                            } else {
                                db.run(`
                                    INSERT INTO user_recovery_keys (user_id, key_hash, salt, status, created_by, encrypted_key)
                                    VALUES (?, ?, ?, 'active', ?, ?)
                                `, [userId, hash, salt, adminName, encryptedKey], (err) => {
                                    if (err) {
                                        console.error('Error inserting user recovery key:', err);
                                    } else {
                                        // Create notification for the new user with their recovery key
                                        const userNotificationMessage = `${res.locals.t('recovery_key.notification_title')}\n\n${res.locals.t('recovery_key.notification_message')}\n\n${res.locals.t('recovery_key.recovery_key_label')} ${recoveryKey}\n\n${res.locals.t('recovery_key.keep_safe')}`;
                                        
                                        db.run(`
                                            INSERT INTO admin_notifications (type, message, related_record_id, related_record_type, recipient, is_read, created_at)
                                            VALUES (?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
                                        `, ['recovery_key_generated', userNotificationMessage, userId, 'user', cleanUsername], function(notifErr) {
                                            if (notifErr) {
                                                console.error('[ERROR] Error creating recovery key notification for user:', notifErr);
                                            } else {
                                                // Broadcast notification to the new user via SSE
                                                const notification = {
                                                    id: this.lastID,
                                                    type: 'recovery_key_generated',
                                                    message: userNotificationMessage,
                                                    related_record_id: userId,
                                                    related_record_type: 'user',
                                                    recipient: cleanUsername,
                                                    is_read: 0,
                                                    created_at: new Date().toISOString()
                                                };
                                                notificationSSE.broadcast(notification);
                                            }
                                        });
                                        
                                        // Send email to new user with recovery key if email is provided
                                        if (cleanEmail) {
                                            const nodemailer = require('nodemailer');
                                            const transporter = nodemailer.createTransport({
                                                service: 'gmail',
                                                auth: {
                                                    user: process.env.EMAIL_USER,
                                                    pass: process.env.EMAIL_PASS
                                                }
                                            });
                                            
                                            const emailBody = res.locals.t('recovery_key.email_body', { username: cleanUsername, key: recoveryKey });
                                            const mailOptions = {
                                                from: process.env.EMAIL_USER,
                                                to: cleanEmail,
                                                subject: res.locals.t('recovery_key.email_subject'),
                                                text: emailBody
                                            };
                                            
                                            transporter.sendMail(mailOptions, (emailErr, info) => {
                                                if (emailErr) {
                                                    console.error('[ERROR] Error sending recovery key email:', emailErr);
                                                }
                                            });
                                        }
                                    }
                                });
                            }
                        }
                        
                        // Create notification for user created (Event 6)
                        const notificationMessage = `کاربر ${cleanUsername} توسط ادمین ${adminName} ایجاد شد`;
                        db.run(`
                            INSERT INTO admin_notifications (type, message, related_record_id, related_record_type, recipient, created_by, is_read, created_at)
                            VALUES (?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
                        `, ['user_created', notificationMessage, userId, 'user', 'admin', adminName], (notifErr) => {
                            if (notifErr) {
                                console.error('[ERROR] Error creating user created notification:', notifErr);
                            }
                        });
                        
                        db.all('SELECT id, username, role, assigned_province, email, profile_picture, permissions, agency_name FROM users ORDER BY id ASC', (err, users) => {
                            db.close();
                            if (err) {
                                return res.status(500).send('Database error');
                            }
                            
                            // Show recovery key to admin in success message (one-time display)
                            let successMessage = `حساب کاربری برای '${cleanUsername}' با موفقیت ایجاد شد.`;
                            if (userRole !== 'admin') {
                                successMessage += `\n\n${res.locals.t('recovery_key.admin_success_with_key', { key: recoveryKey })}`;
                            }
                            
                            res.render('admin/manage-users', {
                                users,
                                message: { type: 'success', text: successMessage },
                                session: req.session
                            });
                        });
                    }
                }
            );
            }); // close bcrypt.hash
        }
    );
}

function adminUpdateUser(req, res) {
    const {
        user_id,
        username,
        password: inputPassword,
        role,
        assigned_province,
        email,
        permissions,
        agency_name
    } = req.body;
    
    // Handle uploaded profile picture
    let profilePicture = null;
    if (req.file) {
        profilePicture = '/uploads/profiles/' + req.file.filename;
    } else if (req.body.profile_picture) {
        // Keep existing profile picture if no new file uploaded
        profilePicture = req.body.profile_picture;
    }
    
    // Input sanitization & trimming
    const cleanUsername = username ? username.trim() : '';
    const cleanEmail = email && email.trim() !== '' ? email.trim().toLowerCase() : null;
    const userId = parseInt(user_id);
    const userRole = role || 'worker';
    const userPermissions = permissions ? JSON.stringify(permissions) : JSON.stringify(['waybill-entry']);
    let password = inputPassword; // Use let so it can be reassigned
    // M6: track whether this edit actually changes the credential (blank input
    // preserves the existing stored hash above and must NOT trigger a purge).
    const passwordChanged = Boolean(inputPassword && String(inputPassword).trim() !== '');
    
    // Validate role - only allow 'worker' or 'admin'
    if (userRole !== 'worker' && userRole !== 'admin') {
        const db = getDbConnection();
        db.all('SELECT id, username, role, assigned_province, email, profile_picture, permissions, agency_name FROM users ORDER BY id ASC', (err, users) => {
            db.close();
            if (err) {
                return res.status(500).send('Database error');
            }
            res.render('admin/manage-users', {
                users,
                error: 'نقش کاربری نامعتبر است. فقط کارمند (Worker) و مدیر (Admin) مجاز هستند.',
                session: req.session
            });
        });
        return;
    }

    if (!cleanUsername || !userId) {
        const db = getDbConnection();
        db.all('SELECT id, username, role, assigned_province, email, profile_picture, permissions, agency_name FROM users ORDER BY id ASC', (err, users) => {
            db.close();
            if (err) {
                return res.status(500).send('Database error');
            }
            res.render('admin/manage-users', {
                users,
                error: 'لطفاً نام کاربری را وارد کنید.',
                session: req.session
            });
        });
        return;
    }

    // Validate password length if provided (minimum 8 characters)
    if (password && password.trim() !== '' && password.length < 8) {
        const db = getDbConnection();
        db.all('SELECT id, username, role, assigned_province, email, profile_picture, permissions, agency_name FROM users ORDER BY id ASC', (err, users) => {
            db.close();
            if (err) {
                return res.status(500).send('Database error');
            }
            res.render('admin/manage-users', {
                users,
                error: 'کلمه عبور باید حداقل ۸ کاراکتر باشد.',
                session: req.session
            });
        });
        return;
    }

    // If password is empty, fetch the existing password from database to preserve it
    if (!password || password.trim() === '') {
        const db = getDbConnection();
        db.get('SELECT password FROM users WHERE id = ?', [userId], (err, user) => {
            if (err || !user) {
                db.close();
                return res.status(500).send('Database error');
            }
            password = user.password;
            proceedWithUpdate();
        });
    } else {
        proceedWithUpdate();
    }

    function proceedWithUpdate() {
        const db = getDbConnection();

        // Check for existing username or email (excluding current user)
        db.get(
            `SELECT id, username, email FROM users
             WHERE (LOWER(username) = LOWER(?)
             OR (? IS NOT NULL AND LOWER(email) = LOWER(?)))
             AND id != ?`,
            [cleanUsername, cleanEmail, cleanEmail, userId],
            (err, existingUser) => {
                if (err) {
                    db.close();
                    return res.status(500).send('Database error');
                }

                if (existingUser) {
                    db.close();
                    db.all('SELECT id, username, role, assigned_province, email, profile_picture, permissions, agency_name FROM users ORDER BY id ASC', (err, users) => {
                        if (err) {
                            return res.status(500).send('Database error');
                        }
                        let error;
                        if (existingUser.username.toLowerCase() === cleanUsername.toLowerCase()) {
                            error = 'این نام کاربری قبلاً در سیستم ثبت شده است.';
                        } else if (cleanEmail && existingUser.email && existingUser.email.toLowerCase() === cleanEmail.toLowerCase()) {
                            error = 'این آدرس ایمیل قبلاً در سیستم ثبت شده است.';
                        } else {
                            error = 'خطا: نام کاربری یا ایمیل قبلاً در سیستم ثبت شده است.';
                        }
                        res.render('admin/manage-users', { users, error, session: req.session });
                    });
                    return;
                }

                // Build update query - always include password since we preserved it if empty
                const query = `UPDATE users SET username = ?, password = ?, role = ?, assigned_province = ?, email = ?, profile_picture = ?, permissions = ?, agency_name = ? WHERE id = ?`;
                
                function doUpdate(pwValue) {
                const params = [
                    cleanUsername,
                    pwValue,
                    userRole,
                    assigned_province,
                    cleanEmail,
                    profilePicture,
                    userPermissions,
                    agency_name || '',
                    userId
                ];

                db.run(query, params, (err) => {
                    if (err) {
                        db.close();
                        db.all('SELECT id, username, role, assigned_province, email, profile_picture, permissions, agency_name FROM users ORDER BY id ASC', (err, users) => {
                            if (err) {
                                return res.status(500).send('Database error');
                            }
                            res.render('admin/manage-users', {
                                users,
                                error: 'خطا در به‌روزرسانی اطلاعات کاربر.',
                                session: req.session
                            });
                        });
                        return;
                    }

                    const adminName = req.session.username || 'admin';

                    // M6: when this edit changed the password, destroy the target
                    // account's other server-side sessions (keeps the acting admin's
                    // own session when editing themselves).
                    if (passwordChanged) {
                        purgeUserSessions(req.sessionStore, userId, keepSidFor(req, userId), () => {});
                    }
                    
                    // Create notification for user edited (Event 7)
                    const notificationMessage = `کاربر ${cleanUsername} توسط ادمین ${adminName} ویرایش شد`;
                    db.run(`
                        INSERT INTO admin_notifications (type, message, related_record_id, related_record_type, recipient, created_by, is_read, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
                    `, ['user_edited', notificationMessage, userId, 'user', 'admin', adminName], (notifErr) => {
                        if (notifErr) {
                            console.error('[ERROR] Error creating user edited notification:', notifErr);
                        } else {
                            console.log('[DEBUG] User edited notification created for:', cleanUsername);
                        }
                    });

                    // If updating the currently logged-in user, refresh their session
                    if (req.session.user_id == userId) {
                        db.get('SELECT * FROM users WHERE id = ?', [userId], (err, user) => {
                            db.close();
                            if (!err && user) {
                                req.session.role = user.role;
                                req.session.permissions = user.permissions;
                                req.session.profile_picture = user.profile_picture;
                            }
                            db.all('SELECT id, username, role, assigned_province, email, profile_picture, permissions, agency_name FROM users ORDER BY id ASC', (err, users) => {
                                if (err) {
                                    return res.status(500).send('Database error');
                                }
                                res.render('admin/manage-users', {
                                    users,
                                    message: { type: 'success', text: `اطلاعات کاربر '${cleanUsername}' با موفقیت به‌روزرسانی شد.` },
                                    session: req.session
                                });
                            });
                        });
                    } else {
                        db.close();
                        db.all('SELECT id, username, role, assigned_province, email, profile_picture, permissions, agency_name FROM users ORDER BY id ASC', (err, users) => {
                            if (err) {
                                return res.status(500).send('Database error');
                            }
                            res.render('admin/manage-users', {
                                users,
                                message: { type: 'success', text: `اطلاعات کاربر '${cleanUsername}' با موفقیت به‌روزرسانی شد.` },
                                session: req.session
                            });
                        });
                    }
                });
                } // end doUpdate

                // L4/H2: hash a NEWLY supplied password. When the form left the password
                // blank, the existing stored value (already a bcrypt hash) was preserved
                // verbatim above and must be written back UNCHANGED — never re-hashed.
                // This removes the old path that stored any bcrypt-lookalike string as-is.
                if (passwordChanged) {
                    bcrypt.hash(password, BCRYPT_SALT_ROUNDS, (hashErr, hashedPassword) => {
                        if (hashErr) {
                            db.close();
                            return res.status(500).send('Database error');
                        }
                        doUpdate(hashedPassword);
                    });
                } else {
                    doUpdate(password);
                }
            }
        );
    }
}

function adminDeleteUser(req, res) {
    const { id } = req.params;
    const db = getDbConnection();
    
    db.get('SELECT username FROM users WHERE id = ?', [id], (err, targetUser) => {
        if (err) {
            db.close();
            req.session.message = { type: 'error', text: 'Database error.' };
            return res.redirect('/admin/manage-users');
        }
        
        if (targetUser && targetUser.username === req.session.username) {
            db.close();
            req.session.message = { type: 'error', text: 'Action aborted: You cannot delete your own active administrative credentials.' };
            return res.redirect('/admin/manage-users');
        } else {
            db.run('DELETE FROM users WHERE id = ?', [id], (err) => {
                db.close();
                req.session.message = { type: 'success', text: 'Identity credentials successfully expunged from the registry logs.' };
                res.redirect('/admin/manage-users');
            });
        }
    });
}

function adminHomepageControl(req, res) {
    const db = getDbConnection();
    // Homepage Content Language (separate from global system language)
    const contentLang = req.query.contentLang || req.body.contentLang || req.session.contentLang || 'en';
    
    // Store content language in session for persistence
    req.session.contentLang = contentLang;
    
    // Helper function to get translation for a specific language
    const getTranslation = (translations, section, field, language) => {
        const translation = translations.find(t => 
            t.language === language && t.section === section && t.field === field
        );
        return translation ? translation.value : '';
    };
    
    if (req.method === 'POST') {
        const { hero_headline, hero_subtext, about_story, company_mission, company_vision, waybill_phone_1, waybill_phone_2, footer_address, footer_phone, footer_email, contentLang: formContentLang } = req.body;
        const targetLang = formContentLang || contentLang;
        
        // Update waybill phones in legacy table
        db.run(`
            UPDATE homepage_content 
            SET waybill_phone_1 = ?, waybill_phone_2 = ?
            WHERE id = 1
        `, [waybill_phone_1, waybill_phone_2], (err) => {
            if (err) {
                console.error('Error updating waybill phones:', err);
            }
        });
        
        // Upsert translations for the selected language
        const translations = [
            [targetLang, 'hero', 'headline', hero_headline],
            [targetLang, 'hero', 'subtext', hero_subtext],
            [targetLang, 'about', 'story', about_story],
            [targetLang, 'about', 'mission', company_mission],
            [targetLang, 'about', 'vision', company_vision],
            [targetLang, 'footer', 'address', footer_address],
            [targetLang, 'footer', 'phone', footer_phone],
            [targetLang, 'footer', 'email', footer_email]
        ];
        
        let completed = 0;
        translations.forEach((translation) => {
            const [language, section, field, value] = translation;
            
            // Use INSERT OR REPLACE to handle both new and existing translations
            db.run(`
                INSERT OR REPLACE INTO homepage_translations (language, section, field, value, updated_at)
                VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            `, [language, section, field, value], (err) => {
                if (err) {
                    console.error(`Error saving translation for ${language}/${section}/${field}:`, err);
                }
                completed++;
                
                if (completed === translations.length) {
                    const adminName = req.session.username || 'admin';
                    
                    // Create notification for homepage updated (Event 8)
                    const notificationMessage = `صفحه اصلی توسط ادمین ${adminName} به‌روزرسانی شد`;
                    db.run(`
                        INSERT INTO admin_notifications (type, message, related_record_type, recipient, created_by, is_read, created_at)
                        VALUES (?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
                    `, ['homepage_updated', notificationMessage, 'homepage', 'admin', adminName], (notifErr) => {
                        if (notifErr) {
                            console.error('[ERROR] Error creating homepage updated notification:', notifErr);
                        }
                    });
                    
                    req.session.message = { type: 'success', text: 'Homepage text modifications published live successfully!' };
                    
                    // Reload data for the selected language
                    loadAndRender(targetLang);
                }
            });
        });
    } else {
        loadAndRender(contentLang);
    }
    
    function loadAndRender(lang) {
        // Get all translations
        db.all('SELECT * FROM homepage_translations', (err, translations) => {
            if (err) {
                console.error('Error fetching translations:', err);
                translations = [];
            }
            
            // Get homepage media
            db.all('SELECT * FROM homepage_media', (err, mediaRecords) => {
                if (err) {
                    console.error('Error fetching homepage media:', err);
                    mediaRecords = [];
                }
                
                // Convert media records to object keyed by media_key (extract file_path string only)
                const media = {};
                mediaRecords.forEach(m => {
                    media[m.media_key] = m.file_path;
                });
                
                // Get homepage products with translations for selected language
                db.all(`
                    SELECT 
                        hp.id,
                        hp.image_path,
                        hp.display_order,
                        hp.is_active,
                        hpt.name,
                        hpt.description,
                        hpt.specifications
                    FROM homepage_products hp
                    LEFT JOIN homepage_product_translations hpt 
                        ON hp.id = hpt.product_id AND hpt.language = ?
                    ORDER BY hp.display_order ASC, hp.id ASC
                `, [lang], (err, products) => {
                    if (err) {
                        console.error('Error fetching homepage products:', err);
                        products = [];
                    }
                    
                    // Get legacy content for waybill phones
                    db.get('SELECT * FROM homepage_content WHERE id = 1', (err, legacyContent) => {
                        db.close();
                        
                        const legacy = legacyContent || {};
                        
                        // Build content object for the selected language
                        const content = {
                            hero_headline: getTranslation(translations, 'hero', 'headline', lang),
                            hero_subtext: getTranslation(translations, 'hero', 'subtext', lang),
                            about_story: getTranslation(translations, 'about', 'story', lang),
                            company_mission: getTranslation(translations, 'about', 'mission', lang),
                            company_vision: getTranslation(translations, 'about', 'vision', lang),
                            waybill_phone_1: legacy.waybill_phone_1 || '+93 700 000 000',
                            waybill_phone_2: legacy.waybill_phone_2 || '+93 780 000 000',
                            footer_address: getTranslation(translations, 'footer', 'address', lang) || 'Kabul Agent Sub-Station Depot',
                            footer_phone: getTranslation(translations, 'footer', 'phone', lang) || '+93 (0) 799-XXXXXX',
                            footer_email: getTranslation(translations, 'footer', 'email', lang) || 'info@example.com'
                        };
                        
                        const message = req.session.message;
                        req.session.message = null;
                        
                        res.render('admin_homepage_manager', { content, message, selectedLang: contentLang, media, products });
                    });
                });
            });
        });
    }
}

function adminHomepageMediaUpload(req, res) {
    if (!req.session || req.session.role !== 'admin') {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    const db = getDbConnection();
    const { media_key } = req.body;
    const isAjax = req.headers['x-requested-with'] === 'XMLHttpRequest' || req.query.ajax === 'true';
    
    if (!req.file) {
        if (isAjax) {
            db.close();
            return res.json({ success: false, message: 'No file uploaded' });
        }
        req.session.message = { type: 'error', text: 'No file uploaded' };
        return res.redirect('/admin/homepage-control');
    }
    
    if (!media_key || !['hero_background', 'about_image', 'logo'].includes(media_key)) {
        if (isAjax) {
            db.close();
            return res.json({ success: false, message: 'Invalid media key' });
        }
        req.session.message = { type: 'error', text: 'Invalid media key' };
        return res.redirect('/admin/homepage-control');
    }
    
    const webPath = '/uploads/homepage/' + req.file.filename;
    
    // Get existing media record to delete old file if exists
    db.get('SELECT * FROM homepage_media WHERE media_key = ?', [media_key], (err, existingMedia) => {
        if (err) {
            console.error('Error fetching existing media:', err);
            if (isAjax) {
                db.close();
                return res.json({ success: false, message: 'Database error' });
            }
            req.session.message = { type: 'error', text: 'Database error' };
            db.close();
            return res.redirect('/admin/homepage-control');
        }
        
        // Insert or replace media record
        db.run(`
            INSERT OR REPLACE INTO homepage_media (media_key, file_path, original_filename, mime_type, updated_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        `, [media_key, webPath, req.file.originalname, req.file.mimetype], (err) => {
            if (err) {
                console.error('Error saving media record:', err);
                if (isAjax) {
                    db.close();
                    return res.json({ success: false, message: 'Error saving media record' });
                }
                req.session.message = { type: 'error', text: 'Error saving media record' };
                db.close();
                return res.redirect('/admin/homepage-control');
            }
            
            // Delete old file if it exists and is different
            if (existingMedia && existingMedia.file_path !== webPath) {
                const oldFilePath = path.join(__dirname, '..', 'public', existingMedia.file_path);
                fs.unlink(oldFilePath, (err) => {
                    if (err && err.code !== 'ENOENT') {
                        console.error('Error deleting old file:', err);
                    }
                });
            }
            
            if (isAjax) {
                db.close();
                return res.json({ 
                    success: true, 
                    message: 'Image uploaded successfully',
                    media: {
                        media_key: media_key,
                        file_path: webPath
                    }
                });
            }
            
            req.session.message = { type: 'success', text: 'Image uploaded successfully' };
            db.close();
            res.redirect('/admin/homepage-control');
        });
    });
}

function adminHomepageMediaDelete(req, res) {
    if (!req.session || req.session.role !== 'admin') {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    const db = getDbConnection();
    const { media_key } = req.body;
    const isAjax = req.headers['x-requested-with'] === 'XMLHttpRequest' || req.query.ajax === 'true';
    
    if (!media_key || !['hero_background', 'about_image', 'logo'].includes(media_key)) {
        if (isAjax) {
            db.close();
            return res.json({ success: false, message: 'Invalid media key' });
        }
        req.session.message = { type: 'error', text: 'Invalid media key' };
        return res.redirect('/admin/homepage-control');
    }
    
    // Get media record to delete file
    db.get('SELECT * FROM homepage_media WHERE media_key = ?', [media_key], (err, media) => {
        if (err) {
            console.error('Error fetching media:', err);
            if (isAjax) {
                db.close();
                return res.json({ success: false, message: 'Database error' });
            }
            req.session.message = { type: 'error', text: 'Database error' };
            db.close();
            return res.redirect('/admin/homepage-control');
        }
        
        // Delete database record
        db.run('DELETE FROM homepage_media WHERE media_key = ?', [media_key], (err) => {
            if (err) {
                console.error('Error deleting media record:', err);
                if (isAjax) {
                    db.close();
                    return res.json({ success: false, message: 'Error deleting media record' });
                }
                req.session.message = { type: 'error', text: 'Error deleting media record' };
                db.close();
                return res.redirect('/admin/homepage-control');
            }
            
            // Delete file from disk
            if (media && media.file_path) {
                const filePath = path.join(__dirname, '..', 'public', media.file_path);
                fs.unlink(filePath, (err) => {
                    if (err && err.code !== 'ENOENT') {
                        console.error('Error deleting file:', err);
                    }
                });
            }
            
            if (isAjax) {
                db.close();
                return res.json({ 
                    success: true, 
                    message: 'Media removed successfully',
                    media: {
                        media_key: media_key
                    }
                });
            }
            
            req.session.message = { type: 'success', text: 'Media removed successfully' };
            db.close();
            res.redirect('/admin/homepage-control');
        });
    });
}

function adminHomepageProductCreate(req, res) {
    if (!req.session || req.session.role !== 'admin') {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    const db = getDbConnection();
    const { name, description, specifications, display_order, contentLang } = req.body;
    
    if (!name || !display_order) {
        req.session.message = { type: 'error', text: 'Name and display order are required' };
        return res.redirect('/admin/homepage-control');
    }
    
    const lang = contentLang || 'en';
    
    // Create product
    db.run(`
        INSERT INTO homepage_products (display_order, is_active)
        VALUES (?, 1)
    `, [display_order], function(err) {
        if (err) {
            console.error('Error creating product:', err);
            req.session.message = { type: 'error', text: 'Error creating product' };
            db.close();
            return res.redirect('/admin/homepage-control');
        }
        
        const productId = this.lastID;
        
        // Add translation
        db.run(`
            INSERT INTO homepage_product_translations (product_id, language, name, description, specifications)
            VALUES (?, ?, ?, ?, ?)
        `, [productId, lang, name, description || '', specifications || ''], (err) => {
            if (err) {
                console.error('Error adding translation:', err);
                req.session.message = { type: 'error', text: 'Error adding translation' };
                db.close();
                return res.redirect('/admin/homepage-control');
            }
            
            req.session.message = { type: 'success', text: 'Product created successfully' };
            db.close();
            res.redirect('/admin/homepage-control');
        });
    });
}

function adminHomepageProductUpdate(req, res) {
    if (!req.session || req.session.role !== 'admin') {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    const db = getDbConnection();
    const { product_id, name, description, specifications, display_order, contentLang } = req.body;
    
    if (!product_id || !name || !display_order) {
        req.session.message = { type: 'error', text: 'Product ID, name, and display order are required' };
        return res.redirect('/admin/homepage-control');
    }
    
    const lang = contentLang || 'en';
    
    // Update product display order
    db.run(`
        UPDATE homepage_products 
        SET display_order = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `, [display_order, product_id], (err) => {
        if (err) {
            console.error('Error updating product:', err);
            req.session.message = { type: 'error', text: 'Error updating product' };
            db.close();
            return res.redirect('/admin/homepage-control');
        }
        
        // Upsert translation
        db.run(`
            INSERT OR REPLACE INTO homepage_product_translations 
            (product_id, language, name, description, specifications, updated_at)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `, [product_id, lang, name, description || '', specifications || ''], (err) => {
            if (err) {
                console.error('Error updating translation:', err);
                req.session.message = { type: 'error', text: 'Error updating translation' };
                db.close();
                return res.redirect('/admin/homepage-control');
            }
            
            req.session.message = { type: 'success', text: 'Product updated successfully' };
            db.close();
            res.redirect('/admin/homepage-control');
        });
    });
}

function adminHomepageProductDelete(req, res) {
    if (!req.session || req.session.role !== 'admin') {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    const db = getDbConnection();
    const { product_id } = req.body;
    
    if (!product_id) {
        req.session.message = { type: 'error', text: 'Product ID is required' };
        return res.redirect('/admin/homepage-control');
    }
    
    // Get product to delete image
    db.get('SELECT * FROM homepage_products WHERE id = ?', [product_id], (err, product) => {
        if (err) {
            console.error('Error fetching product:', err);
            req.session.message = { type: 'error', text: 'Database error' };
            db.close();
            return res.redirect('/admin/homepage-control');
        }
        
        if (!product) {
            req.session.message = { type: 'error', text: 'Product not found' };
            db.close();
            return res.redirect('/admin/homepage-control');
        }
        
        // Delete product (cascade will delete translations)
        db.run('DELETE FROM homepage_products WHERE id = ?', [product_id], (err) => {
            if (err) {
                console.error('Error deleting product:', err);
                req.session.message = { type: 'error', text: 'Error deleting product' };
                db.close();
                return res.redirect('/admin/homepage-control');
            }
            
            // Delete image file if exists
            if (product.image_path) {
                const filePath = path.join(__dirname, '..', 'public', product.image_path);
                fs.unlink(filePath, (err) => {
                    if (err && err.code !== 'ENOENT') {
                        console.error('Error deleting image file:', err);
                    }
                });
            }
            
            req.session.message = { type: 'success', text: 'Product deleted successfully' };
            db.close();
            res.redirect('/admin/homepage-control');
        });
    });
}

function adminHomepageProductToggle(req, res) {
    if (!req.session || req.session.role !== 'admin') {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    const db = getDbConnection();
    const { product_id } = req.body;
    
    if (!product_id) {
        req.session.message = { type: 'error', text: 'Product ID is required' };
        return res.redirect('/admin/homepage-control');
    }
    
    // Toggle active status
    db.run(`
        UPDATE homepage_products 
        SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `, [product_id], (err) => {
        if (err) {
            console.error('Error toggling product:', err);
            req.session.message = { type: 'error', text: 'Error toggling product' };
            db.close();
            return res.redirect('/admin/homepage-control');
        }
        
        req.session.message = { type: 'success', text: 'Product status updated successfully' };
        db.close();
        res.redirect('/admin/homepage-control');
    });
}

function adminHomepageProductImageUpload(req, res) {
    if (!req.session || req.session.role !== 'admin') {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    const db = getDbConnection();
    const { product_id } = req.body;
    const isAjax = req.headers['x-requested-with'] === 'XMLHttpRequest' || req.query.ajax === 'true';
    
    if (!req.file) {
        if (isAjax) {
            db.close();
            return res.json({ success: false, message: 'No file uploaded' });
        }
        req.session.message = { type: 'error', text: 'No file uploaded' };
        return res.redirect('/admin/homepage-control');
    }
    
    if (!product_id) {
        if (isAjax) {
            db.close();
            return res.json({ success: false, message: 'Product ID is required' });
        }
        req.session.message = { type: 'error', text: 'Product ID is required' };
        return res.redirect('/admin/homepage-control');
    }
    
    const webPath = '/uploads/homepage/' + req.file.filename;
    
    // Get existing product to delete old image
    db.get('SELECT * FROM homepage_products WHERE id = ?', [product_id], (err, product) => {
        if (err) {
            console.error('Error fetching product:', err);
            if (isAjax) {
                db.close();
                return res.json({ success: false, message: 'Database error' });
            }
            req.session.message = { type: 'error', text: 'Database error' };
            db.close();
            return res.redirect('/admin/homepage-control');
        }
        
        // Update product image
        db.run(`
            UPDATE homepage_products 
            SET image_path = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [webPath, product_id], (err) => {
            if (err) {
                console.error('Error updating product image:', err);
                if (isAjax) {
                    db.close();
                    return res.json({ success: false, message: 'Error updating product image' });
                }
                req.session.message = { type: 'error', text: 'Error updating product image' };
                db.close();
                return res.redirect('/admin/homepage-control');
            }
            
            // Delete old image if exists and different
            if (product && product.image_path && product.image_path !== webPath) {
                const oldFilePath = path.join(__dirname, '..', 'public', product.image_path);
                fs.unlink(oldFilePath, (err) => {
                    if (err && err.code !== 'ENOENT') {
                        console.error('Error deleting old image:', err);
                    }
                });
            }
            
            if (isAjax) {
                db.close();
                return res.json({ 
                    success: true, 
                    message: 'Product image uploaded successfully',
                    product: {
                        id: parseInt(product_id),
                        image_path: webPath
                    }
                });
            }
            
            req.session.message = { type: 'success', text: 'Product image uploaded successfully' };
            db.close();
            res.redirect('/admin/homepage-control');
        });
    });
}

function adminHomepageProductImageDelete(req, res) {
    if (!req.session || req.session.role !== 'admin') {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    const db = getDbConnection();
    const { product_id } = req.body;
    const isAjax = req.headers['x-requested-with'] === 'XMLHttpRequest' || req.query.ajax === 'true';
    
    if (!product_id) {
        if (isAjax) {
            db.close();
            return res.json({ success: false, message: 'Product ID is required' });
        }
        req.session.message = { type: 'error', text: 'Product ID is required' };
        return res.redirect('/admin/homepage-control');
    }
    
    // Get product to delete image
    db.get('SELECT * FROM homepage_products WHERE id = ?', [product_id], (err, product) => {
        if (err) {
            console.error('Error fetching product:', err);
            if (isAjax) {
                db.close();
                return res.json({ success: false, message: 'Database error' });
            }
            req.session.message = { type: 'error', text: 'Database error' };
            db.close();
            return res.redirect('/admin/homepage-control');
        }
        
        // Update product to remove image
        db.run(`
            UPDATE homepage_products 
            SET image_path = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [product_id], (err) => {
            if (err) {
                console.error('Error removing product image:', err);
                if (isAjax) {
                    db.close();
                    return res.json({ success: false, message: 'Error removing product image' });
                }
                req.session.message = { type: 'error', text: 'Error removing product image' };
                db.close();
                return res.redirect('/admin/homepage-control');
            }
            
            // Delete image file if exists
            if (product && product.image_path) {
                const filePath = path.join(__dirname, '..', 'public', product.image_path);
                fs.unlink(filePath, (err) => {
                    if (err && err.code !== 'ENOENT') {
                        console.error('Error deleting image file:', err);
                    }
                });
            }
            
            if (isAjax) {
                db.close();
                return res.json({ 
                    success: true, 
                    message: 'Product image removed successfully',
                    product: {
                        id: parseInt(product_id),
                        image_path: null
                    }
                });
            }
            
            req.session.message = { type: 'success', text: 'Product image removed successfully' };
            db.close();
            res.redirect('/admin/homepage-control');
        });
    });
}

function apiAdminAgents(req, res) {
    if (!req.session.role || req.session.role !== 'admin') {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    
    const db = getDbConnection();
    
    db.all('SELECT id, username, role, assigned_province FROM users WHERE role = "worker" ORDER BY username ASC', (err, agents) => {
        db.close();
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }
        
        res.json({ agents });
    });
}

function apiFinancialMetrics(req, res) {
    if (!req.session.role || req.session.role !== 'admin') {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    
    const db = getDbConnection();
    
    db.all('SELECT customer_id, SUM(net_cement_money) as total_debit FROM sales_logs GROUP BY customer_id', (err, salesSums) => {
        if (err) {
            db.close();
            return res.status(500).json({ error: 'Database error' });
        }
        
        db.all('SELECT customer_id, SUM(amount_received) as total_credit FROM receipts_logs GROUP BY customer_id', (err, receiptSums) => {
            if (err) {
                db.close();
                return res.status(500).json({ error: 'Database error' });
            }
            
            // F-A4: the dashboard renderer consumes total_sales_money and
            // total_money_received (the initial server render has always
            // provided them) but this API returned only the two balance
            // fields, so every SSE tick/poll threw mid-apply in
            // applyFinancialMetrics and those two tiles never refreshed.
            // Same admin-wide SUMs as the adminDashboard render path.
            db.all('SELECT SUM(net_cement_money) as total_sales FROM sales_logs', (err, totalSalesResult) => {
            if (err) {
                db.close();
                return res.status(500).json({ error: 'Database error' });
            }
            db.all('SELECT SUM(amount_received) as total_received FROM receipts_logs', (err, totalReceivedResult) => {
            if (err) {
                db.close();
                return res.status(500).json({ error: 'Database error' });
            }
            
            const debits = {};
            const credits = {};
            
            salesSums.forEach(row => {
                debits[row.customer_id] = row.total_debit;
            });
            
            receiptSums.forEach(row => {
                credits[row.customer_id] = row.total_credit;
            });
            
            let totalReceivables = 0.0;
            let totalPayables = 0.0;
            
            const allCustIds = new Set([...Object.keys(debits), ...Object.keys(credits)]);
            allCustIds.forEach(cId => {
                const bal = (debits[cId] || 0.0) - (credits[cId] || 0.0);
                if (bal > 0) {
                    totalReceivables += bal;
                } else if (bal < 0) {
                    totalPayables += Math.abs(bal);
                }
            });
            
            const totalSalesMoney = totalSalesResult[0]?.total_sales || 0;
            const totalMoneyReceived = totalReceivedResult[0]?.total_received || 0;
            
            db.close();
            res.json({
                total_receivables: totalReceivables,
                total_payables: totalPayables,
                total_sales_money: totalSalesMoney,
                total_money_received: totalMoneyReceived
            });
            });
            });
        });
    });
}

function agentRemittances(req, res) {
    const db = getDbConnection();
    
    // Fetch all customers for the dropdown
    db.all('SELECT id, customer_id, name, province FROM customers ORDER BY name ASC', (err, rawCustomers) => {
        if (err) {
            db.close();
            return res.status(500).send('Database error');
        }
        
        // Filter out duplicates based on trimmed customer name
        const seenNames = new Set();
        const uniqueCustomers = [];
        
        rawCustomers.forEach(cust => {
            const cleanName = (cust.name || '').trim().toLowerCase();
            if (cleanName && !seenNames.has(cleanName)) {
                seenNames.add(cleanName);
                uniqueCustomers.push(cust);
            }
        });
        
        // Fetch all users/workers for the admin filter dropdown
        db.all('SELECT id, username, role, assigned_province FROM users WHERE role = "worker" ORDER BY username ASC', (err, users) => {
            if (err) {
                db.close();
                return res.status(500).send('Database error');
            }

            // Fetch distinct agency names from users table for the agency filter dropdown
            db.all('SELECT DISTINCT agency_name FROM users WHERE agency_name IS NOT NULL AND agency_name != "" ORDER BY agency_name ASC', (err, agencies) => {
                if (err) {
                    db.close();
                    return res.status(500).send('Database error');
                }

                // Fetch remittance records
                db.all('SELECT * FROM receipts_logs ORDER BY receipt_date DESC', (err, remittances) => {
                    db.close();
                    if (err) {
                        return res.status(500).send('Database error');
                    }

                    res.render('admin_remittance_ledger', {
                        title: 'Admin Financial Remittance Ledger',
                        user: req.user,
                        customers: uniqueCustomers,
                        users: users || [],
                        agencies: agencies || [],
                        remittances: remittances || []
                    });
                });
            });
        });
    });
}

function adminAllAgencyExpenses(req, res) {
    if (!req.session.role || req.session.role !== 'admin') {
        return res.status(403).send('Unauthorized');
    }
    res.render('admin_all_agency_expenses');
}

function apiAdminAgenciesList(req, res) {
    if (!req.session.role || req.session.role !== 'admin') {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    
    const db = getDbConnection();
    db.all('SELECT id, username, agency_name FROM users WHERE agency_name IS NOT NULL AND agency_name != "" ORDER BY agency_name ASC', (err, rows) => {
        db.close();
        if (err) {
            return res.status(500).json({ error: 'Database error', details: 'Internal error' });
        }
        // Return user objects with id and agency_name for the dropdown
        res.json({ agencies: rows });
    });
}

function apiAdminAgencyExpensesSummary(req, res) {
    if (!req.session.role || req.session.role !== 'admin') {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    
    const { agencies, start_date, end_date } = req.query;
    const db = getDbConnection();
    
    let query = `
        SELECT 
            COALESCE(u.agency_name, ae.agency_username) as agency_name,
            COALESCE(SUM(ae.cash_in), 0) AS total_cash_in,
            COALESCE(SUM(ae.cash_out), 0) AS total_cash_out
        FROM agency_expenses ae
        LEFT JOIN users u ON ae.agency_username = u.username
        WHERE 1=1
    `;
    const params = [];
    
    // Handle multi-select agency filter by agency_name
    if (agencies && agencies !== 'All' && agencies.trim() !== '') {
        const agencyList = agencies.split(',').map(a => a.trim()).filter(Boolean);
        if (agencyList.length > 0) {
            const placeholders = agencyList.map(() => '?').join(', ');
            query += ` AND (u.agency_name IN (${placeholders}) OR ae.agency_username IN (${placeholders}))`;
            params.push(...agencyList, ...agencyList);
        }
    }
    if (start_date && start_date.trim() !== '') {
        const normalizedStart = start_date.trim().replace(/-/g, '/');
        params.push(normalizedStart);
        query += ` AND transaction_date >= ?`;
    }
    if (end_date && end_date.trim() !== '') {
        const normalizedEnd = end_date.trim().replace(/-/g, '/');
        params.push(normalizedEnd);
        query += ` AND transaction_date <= ?`;
    }
    
    query += ` GROUP BY COALESCE(u.agency_name, ae.agency_username)`;
    
    db.all(query, params, (err, rows) => {
        if (err) {
            db.close();
            return res.status(500).json({ error: 'Database error', details: 'Internal error' });
        }
        
        let aggregateTotalExpenses = 0;   // Sum of worker's cash_out (Operational Expenses)
        let aggregateTotalCashOut = 0;    // Sum of worker's cash_in (Funds Disbursed / HQ Inflow)
        let aggregateAvailableBalance = 0; 
        let aggregateReimbursementDue = 0;

        rows.forEach(row => {
            const workerCashIn = parseFloat(row.total_cash_in) || 0;   // Money sent to branch
            const workerCashOut = parseFloat(row.total_cash_out) || 0; // Money spent by branch
            const netBalance = workerCashIn - workerCashOut;

            // Mapping Adjustments:
            aggregateTotalExpenses += workerCashOut; // 🔴 مجموعه مصارف = Total Spent by Worker
            aggregateTotalCashOut += workerCashIn;   // 🔻 مجموع پول رفت = Total Sent by HQ (Worker Cash In)

            if (netBalance > 0) {
                aggregateAvailableBalance += netBalance;
            } else if (netBalance < 0) {
                aggregateReimbursementDue += Math.abs(netBalance);
            }
        });
        
        db.close();
        res.json({
            total_expenses: aggregateTotalExpenses,
            total_cash_out: aggregateTotalCashOut,
            available_balance: aggregateAvailableBalance,
            reimbursement_owed: aggregateReimbursementDue
        });
    });
}

function apiAdminAgencyExpenses(req, res) {
    if (!req.session.role || req.session.role !== 'admin') {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    
    const { 
        agencies, categories, start_date, end_date,
        adv_agency, adv_start_date, adv_end_date, adv_category,
        adv_person, adv_cash_in, adv_cash_out, adv_description,
        adv_quantity, adv_unit_price, adv_remarks 
    } = req.query;
    
    const db = getDbConnection();
    
    let query = `
        SELECT 
            ae.*,
            u.agency_name
        FROM agency_expenses ae
        LEFT JOIN users u ON ae.agency_username = u.username
        WHERE 1=1
    `;
    const params = [];
    
    // Agency Filter - filter by agency_name from users table
    const effectiveAgency = adv_agency || agencies;
    if (effectiveAgency && effectiveAgency !== 'All' && effectiveAgency.trim() !== '') {
        const agencyList = effectiveAgency.split(',').map(a => a.trim()).filter(Boolean);
        if (agencyList.length > 0) {
            const placeholders = agencyList.map(() => '?').join(', ');
            query += ` AND (u.agency_name IN (${placeholders}) OR ae.agency_username IN (${placeholders}))`;
            params.push(...agencyList, ...agencyList);
        }
    }
    
    // Multi-Select Category Filter
    const catValue = adv_category || categories;
    if (catValue && catValue !== 'All' && catValue.trim() !== '') {
        const catList = catValue.split(',').map(c => c.trim()).filter(Boolean);
        if (catList.length > 0) {
            const placeholders = catList.map(() => '?').join(', ');
            query += ` AND (category IN (${placeholders}))`;
            params.push(...catList);
        }
    }
    
    // Date Range Filter
    const effectiveStart = adv_start_date || start_date;
    const effectiveEnd = adv_end_date || end_date;
    if (effectiveStart && effectiveStart.trim() !== '') {
        const normalizedStart = effectiveStart.trim().replace(/-/g, '/');
        params.push(normalizedStart);
        query += ` AND transaction_date >= ?`;
    }
    if (effectiveEnd && effectiveEnd.trim() !== '') {
        const normalizedEnd = effectiveEnd.trim().replace(/-/g, '/');
        params.push(normalizedEnd);
        query += ` AND transaction_date <= ?`;
    }
    
    // Text Matches (SQLite LIKE is case-insensitive for ASCII)
    if (adv_person && adv_person.trim() !== '') {
        params.push(likeContains(adv_person.trim()));
        query += ` AND person_involved LIKE ? ESCAPE '\\'`;
    }
    if (adv_description && adv_description.trim() !== '') {
        params.push(likeContains(adv_description.trim()));
        query += ` AND description LIKE ? ESCAPE '\\'`;
    }
    if (adv_remarks && adv_remarks.trim() !== '') {
        params.push(likeContains(adv_remarks.trim()));
        query += ` AND remarks LIKE ? ESCAPE '\\'`;
    }
    
    // Numeric Matches
    if (adv_cash_in && !isNaN(parseFloat(adv_cash_in))) {
        params.push(parseFloat(adv_cash_in));
        query += ` AND cash_in = ?`;
    }
    if (adv_cash_out && !isNaN(parseFloat(adv_cash_out))) {
        params.push(parseFloat(adv_cash_out));
        query += ` AND cash_out = ?`;
    }
    if (adv_quantity && !isNaN(parseFloat(adv_quantity))) {
        params.push(parseFloat(adv_quantity));
        query += ` AND quantity = ?`;
    }
    if (adv_unit_price && !isNaN(parseFloat(adv_unit_price))) {
        params.push(parseFloat(adv_unit_price));
        query += ` AND unit_price = ?`;
    }
    
    query += ` ORDER BY transaction_date DESC, id DESC`;
    
    db.all(query, params, (err, rows) => {
        if (err) {
            db.close();
            return res.status(500).json({ error: 'Database error', details: 'Internal error' });
        }
        
        db.close();
        res.json({ records: rows || [] });
    });
}

function adminCreateWaybill(req, res) {
    if (!req.session.role || req.session.role !== 'admin') {
        return res.status(403).send('Unauthorized');
    }

    // Cement stock availability per registry type: feeds the Bag Count gate on the form
    getStockAvailability((stockErr, stockAvailability) => {
        if (stockErr) {
            console.error('[ERROR] Error retrieving cement stock availability:', stockErr);
            return res.status(500).send('Server Error');
        }

        const db = getDbConnection();

        // Retrieve dynamic homepage copy blocks (including waybill_phone_1 & waybill_phone_2)
        db.get('SELECT * FROM homepage_content WHERE id = 1', (err, content) => {
            db.close();
            if (err) {
                console.error('[ERROR] Error retrieving homepage content:', err);
                return res.status(500).send('Server Error');
            }

            res.render('admin_local_waybill', { content, stockAvailability });
        });
    });
}

function apiAdminSaveWaybill(req, res) {
    console.log('[DEBUG] apiAdminSaveWaybill called');
    console.log('[DEBUG] Request body:', req.body);
    
    if (!req.session.role || req.session.role !== 'admin') {
        return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    const {
        waybill_serial,
        waybill_date,
        selled_to_agent,
        driver_name,
        driver_phone,
        truck_plate,
        truck_type,
        freight_per_ton,
        total_freight,
        cement_type,
        total_bags,
        tonnage,
        loading_province,
        unloading_province,
        remarks
    } = req.body;

    console.log('[DEBUG] selled_to_agent value received:', selled_to_agent);
    console.log('[DEBUG] selled_to_agent type:', typeof selled_to_agent);
    console.log('[DEBUG] selled_to_agent trimmed:', selled_to_agent ? selled_to_agent.trim() : 'EMPTY/NULL');

    // Validate required fields
    if (!waybill_serial || !waybill_date || !driver_name || !truck_plate) {
        return res.status(400).json({ success: false, error: 'لطفاً تمام فیلدهای ضروری را پر کنید' });
    }

    // Validate bags count range (650-950)
    const bagsCount = parseInt(total_bags) || 0;
    if (bagsCount < 650 || bagsCount > 950) {
        return res.status(400).json({ success: false, error: 'تعداد کیسه باید بین ۶۵۰ تا ۹۵۰ باشد.' });
    }

    // Validate driver phone number format (E164 international format)
    if (driver_phone) {
        const cleanPhone = driver_phone.trim();
        // Check if it starts with + and contains only digits after that
        if (!cleanPhone.match(/^\+\d{8,15}$/)) {
            return res.status(400).json({ success: false, error: 'Invalid driver phone number format. Please use international format (e.g., +93701234567).' });
        }
    }

    const username = req.session?.username || 'admin';

    const db = getDbConnection();

    // Check if serial already exists (UNIQUE constraint)
    db.get('SELECT id FROM local_waybills WHERE waybill_serial = ?', [waybill_serial], (err, row) => {
        if (err) {
            db.close();
            return res.status(500).json({ success: false, error: 'Database error' });
        }

        if (row) {
            db.close();
            return res.status(409).json({ success: false, error: 'Waybill serial already exists' });
        }

        const selledToAgentValue = selled_to_agent ? selled_to_agent.trim() : '';
        console.log('[DEBUG] About to insert selled_to_agent value:', selledToAgentValue);

        // If selled_to_agent is a user ID (numeric), fetch the username for storage
        // This maintains backward compatibility while allowing new ID-based assignment
        let finalSelledToAgent = selledToAgentValue;
        if (!isNaN(parseInt(selledToAgentValue))) {
            // It's a user ID, fetch the username
            db.get('SELECT username FROM users WHERE id = ?', [parseInt(selledToAgentValue)], (err, user) => {
                if (err || !user) {
                    db.close();
                    return res.status(400).json({ success: false, error: 'Invalid user selected' });
                }
                finalSelledToAgent = user.username;
                insertWaybill(finalSelledToAgent);
            });
        } else {
            // It's already a username (backward compatibility)
            insertWaybill(finalSelledToAgent);
        }

        function insertWaybill(agentUsername) {
            // Cement stock gate: a registry cement type cannot sell more bags than are in stock
            assertSaleWithinStock(cement_type, bagsCount, null, (gateCode) => {
                if (gateCode === 'insufficient_stock') {
                    db.close();
                    return res.status(400).json({
                        success: false,
                        code: 'insufficient_stock',
                        error: res.locals.t('waybill.js_stock_insufficient_error')
                    });
                }
                if (gateCode) {
                    db.close();
                    return res.status(500).json({ success: false, error: 'Database error' });
                }
                insertWaybillRecord(agentUsername);
            });
        }

        function insertWaybillRecord(agentUsername) {
            // Insert new waybill with default value handling
            db.run(
                `INSERT INTO local_waybills
                (waybill_serial, waybill_date, selled_to_agent, driver_name, driver_phone, truck_plate, truck_type, freight_per_ton, total_freight, cement_type, total_bags, tonnage, loading_province, unloading_province, remarks, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    waybill_serial.trim(),
                    waybill_date.trim(),
                    agentUsername,
                    driver_name.trim(),
                    driver_phone ? driver_phone.trim() : '',
                    truck_plate.trim(),
                    truck_type || 'company',
                    parseFloat(freight_per_ton) || 0,
                    parseFloat(total_freight) || 0,
                    cement_type ? cement_type.trim() : 'سیمنت ممتاز باقران',
                    parseInt(total_bags) || 0,
                    parseFloat(tonnage) || 0,
                    loading_province ? loading_province.trim() : '',
                    unloading_province ? unloading_province.trim() : '',
                    remarks ? remarks.trim() : '',
                    username
                ],
            function(err) {
                if (err) {
                    db.close();
                    console.error('[ERROR] Error saving waybill:', err);
                    return res.status(500).json({ success: false, error: 'Failed to save waybill' });
                }
                console.log('[DEBUG] Waybill saved successfully with ID:', this.lastID);
                console.log('[DEBUG] Saved selled_to_agent:', agentUsername);
                
                const waybillId = this.lastID;
                
                // Create notification for waybill generation (Event 4)
                const notificationMessage = `بارنامه شماره ${waybill_serial} با موفقیت توسط ادمین ${username} ایجاد شد`;
                db.run(`
                    INSERT INTO admin_notifications (type, message, related_record_id, related_record_type, recipient, created_by, is_read, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
                `, ['waybill_generated', notificationMessage, waybillId, 'local_waybill', agentUsername, username], function(notifErr) {
                    if (notifErr) {
                        console.error('[ERROR] Error creating waybill generation notification:', notifErr);
                    } else {
                        console.log('[DEBUG] Waybill generation notification created');
                        
                        // Broadcast the notification via SSE to admins
                        const notification = {
                            id: this.lastID,
                            type: 'waybill_generated',
                            message: notificationMessage,
                            related_record_id: waybillId,
                            related_record_type: 'local_waybill',
                            created_by: username,
                            recipient: 'admin',
                            is_read: 0,
                            created_at: new Date().toISOString()
                        };
                        notificationSSE.broadcast(notification);
                    }
                });
                
                // Create worker notification for waybill received (Worker Event 1)
                // Only create if a worker/agent was assigned
                if (agentUsername && agentUsername.trim() !== '') {
                    const workerNotificationMessage = `بارنامه شماره ${waybill_serial} از اداره مرکزی دریافت شد`;
                    
                    db.run(`
                        INSERT INTO admin_notifications (type, message, related_record_id, related_record_type, created_by, recipient, is_read, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
                    `, ['worker_waybill_received', workerNotificationMessage, waybillId, 'waybill', username, agentUsername], function(workerNotifErr) {
                        if (workerNotifErr) {
                            console.error('[ERROR] Error creating worker waybill notification:', workerNotifErr);
                        } else {
                            // Broadcast the notification via SSE
                            const notification = {
                                id: this.lastID,
                                type: 'worker_waybill_received',
                                message: workerNotificationMessage,
                                related_record_id: waybillId,
                                related_record_type: 'waybill',
                                created_by: username,
                                recipient: agentUsername,
                                is_read: 0,
                                created_at: new Date().toISOString()
                            };
                            notificationSSE.broadcast(notification);
                        }
                    });
                }
                
                // Deduct the sold bags from cement stock (source='waybill' out-row)
                upsertStockSale({
                    waybillId: waybillId,
                    cementType: cement_type,
                    bags: bagsCount,
                    stockDate: waybill_date,
                    createdBy: username
                }, (stockErr) => {
                    if (stockErr) {
                        console.error('[ERROR] cement stock deduction after waybill save:', stockErr);
                    }
                });

                db.close();
                res.json({ success: true, id: waybillId, waybill_serial });
            }
            );
        }
    });
}

function apiAdminNextWaybillSerial(req, res) {
    if (!req.session.role || req.session.role !== 'admin') {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    const db = getDbConnection();

    // Use SQL to extract and find the maximum numeric part from waybill_serial
    // This ensures deleted serial numbers are NEVER reused - always increments forward
    db.get(`
        SELECT MAX(
            CAST(
                SUBSTR(waybill_serial, 4) AS INTEGER
            )
        ) as max_seq 
        FROM local_waybills
        WHERE waybill_serial LIKE 'WB-%'
    `, (err, row) => {
        if (err) {
            console.error('[ERROR] Error generating 4-digit serial:', err);
            db.close();
            return res.status(500).json({ error: 'Database error' });
        }

        const nextNumber = (row.max_seq || 0) + 1;
        const paddedSerial = String(nextNumber).padStart(4, '0');
        const waybillSerial = `WB-${paddedSerial}`;

        db.close();
        res.json({ serial: waybillSerial });
    });
}

function apiAdminWaybillHistory(req, res) {
    if (!req.session.role || req.session.role !== 'admin') {
        return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    const db = getDbConnection();

    db.all(`
        SELECT lw.id, lw.waybill_serial, lw.waybill_date, lw.selled_to_agent, lw.driver_name, lw.driver_phone,
               lw.truck_plate, lw.cement_type, lw.total_bags, lw.tonnage, lw.loading_province, lw.unloading_province,
               lw.remarks, lw.created_by, lw.created_at, lw.status, lw.truck_type, lw.freight_per_ton, lw.total_freight,
               u.agency_name
        FROM local_waybills lw
        LEFT JOIN users u ON lw.selled_to_agent = u.username
        ORDER BY lw.created_at DESC
    `, (err, rows) => {
        if (err) {
            db.close();
            return res.status(500).json({ success: false, error: 'Database error' });
        }

        db.close();
        res.json({ success: true, records: rows });
    });
}

function apiAdminDeleteWaybill(req, res) {
    if (!req.session.role || req.session.role !== 'admin') {
        return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    const waybillId = req.params.id;

    if (!waybillId) {
        return res.status(400).json({ success: false, error: 'Missing waybill ID' });
    }

    const db = getDbConnection();

    // Remove the matching cement stock deduction row first (legacy waybills have none)
    removeStockSale(waybillId, (stockErr) => {
        if (stockErr) {
            console.error('[ERROR] cement stock deduction removal on waybill delete:', stockErr);
        }

        db.run('DELETE FROM local_waybills WHERE id = ?', [waybillId], function(err) {
            if (err) {
                db.close();
                return res.status(500).json({ success: false, error: 'Failed to delete waybill' });
            }

            db.close();
            res.json({ success: true, deletedId: waybillId });
        });
    });
}

function apiAdminUpdateWaybill(req, res) {
    if (!req.session.role || req.session.role !== 'admin') {
        return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    const waybillId = req.params.id;

    if (!waybillId) {
        return res.status(400).json({ success: false, error: 'Missing waybill ID' });
    }

    const {
        waybill_date,
        selled_to_agent,
        driver_name,
        driver_phone,
        truck_plate,
        truck_type,
        freight_per_ton,
        total_freight,
        cement_type,
        total_bags,
        tonnage,
        loading_province,
        unloading_province,
        remarks
    } = req.body;

    // Validate driver phone number format (E164 international format)
    if (driver_phone) {
        const cleanPhone = driver_phone.trim();
        // Check if it starts with + and contains only digits after that
        if (!cleanPhone.match(/^\+\d{8,15}$/)) {
            return res.status(400).json({ success: false, error: 'Invalid driver phone number format. Please use international format (e.g., +93701234567).' });
        }
    }

    const db = getDbConnection();

    // First, get the current waybill to check for assignment changes
    db.get('SELECT selled_to_agent, waybill_serial FROM local_waybills WHERE id = ?', [waybillId], (err, currentWaybill) => {
        if (err) {
            db.close();
            return res.status(500).json({ success: false, error: 'Database error' });
        }
        if (!currentWaybill) {
            db.close();
            return res.status(404).json({ success: false, error: 'Waybill not found' });
        }

        const oldAssignment = currentWaybill.selled_to_agent || '';
        const waybillSerial = currentWaybill.waybill_serial;

        // If selled_to_agent is a user ID (numeric), fetch the username for storage
        // This maintains backward compatibility while allowing new ID-based assignment
        let finalSelledToAgent = selled_to_agent ? selled_to_agent.trim() : '';
        if (!isNaN(parseInt(finalSelledToAgent))) {
            // It's a user ID, fetch the username
            db.get('SELECT username FROM users WHERE id = ?', [parseInt(finalSelledToAgent)], (err, user) => {
                if (err || !user) {
                    db.close();
                    return res.status(400).json({ success: false, error: 'Invalid user selected' });
                }
                finalSelledToAgent = user.username;
                updateWaybill(finalSelledToAgent, oldAssignment, waybillSerial);
            });
        } else {
            // It's already a username (backward compatibility)
            updateWaybill(finalSelledToAgent, oldAssignment, waybillSerial);
        }
    });

    function updateWaybill(agentUsername, oldAssignment, waybillSerial) {
        let trackStockOutRow = false;

        // Cement stock link: only waybills saved after the stock feature carry a deduction row
        hasStockSale(waybillId, (linkErr, tracked) => {
            if (linkErr) {
                db.close();
                return res.status(500).json({ success: false, error: 'Database error' });
            }
            if (!tracked) return doUpdate();

            // Editing a tracked waybill may not push its deduction past the available stock
            assertSaleWithinStock(cement_type, parseInt(total_bags) || 0, waybillId, (gateCode) => {
                if (gateCode === 'insufficient_stock') {
                    db.close();
                    return res.status(400).json({
                        success: false,
                        code: 'insufficient_stock',
                        error: res.locals.t('waybill.js_stock_insufficient_error')
                    });
                }
                if (gateCode) {
                    db.close();
                    return res.status(500).json({ success: false, error: 'Database error' });
                }
                trackStockOutRow = true;
                doUpdate();
            });
        });

        function doUpdate() {
        db.run(`
            UPDATE local_waybills
            SET waybill_date = ?,
                selled_to_agent = ?,
                driver_name = ?,
                driver_phone = ?,
                truck_plate = ?,
                truck_type = ?,
                freight_per_ton = ?,
                total_freight = ?,
                cement_type = ?,
                total_bags = ?,
                tonnage = ?,
                loading_province = ?,
                unloading_province = ?,
                remarks = ?
            WHERE id = ?
        `, [
            waybill_date,
            agentUsername,
            driver_name.trim(),
            driver_phone ? driver_phone.trim() : '',
            truck_plate.trim(),
            truck_type || 'company',
            parseFloat(freight_per_ton) || 0,
            parseFloat(total_freight) || 0,
            cement_type ? cement_type.trim() : 'سمنت ممتاز باقران',
            parseInt(total_bags) || 0,
            parseFloat(tonnage) || 0,
            loading_province ? loading_province.trim() : '',
            unloading_province ? unloading_province.trim() : '',
            remarks ? remarks.trim() : '',
            waybillId
        ], function(err) {
            if (err) {
                db.close();
                console.error('[ERROR] Error updating waybill:', err);
                return res.status(500).json({ success: false, error: 'Failed to update waybill' });
            }

            // Keep the cement stock deduction row in sync with the edited values
            if (trackStockOutRow) {
                upsertStockSale({
                    waybillId: waybillId,
                    cementType: cement_type,
                    bags: parseInt(total_bags) || 0,
                    stockDate: waybill_date,
                    createdBy: req.session.username || 'admin'
                }, (stockErr) => {
                    if (stockErr) {
                        console.error('[ERROR] cement stock sync after waybill update:', stockErr);
                    }
                });
            }

            // Check if assignment changed to a different worker
            const assignmentChanged = (oldAssignment !== agentUsername);
            const hasNewAssignment = (agentUsername && agentUsername.trim() !== '');

            if (assignmentChanged && hasNewAssignment) {
                // Create notification for the new worker
                const workerNotificationMessage = `بارنامه شماره ${waybillSerial} از اداره مرکزی دریافت شد`;
                
                db.run(`
                    INSERT INTO admin_notifications (type, message, related_record_id, related_record_type, created_by, recipient, is_read, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
                `, ['worker_waybill_received', workerNotificationMessage, waybillId, 'waybill', req.session.username || 'admin', agentUsername], function(notifErr) {
                    if (notifErr) {
                        console.error('[ERROR] Error creating worker waybill notification on update:', notifErr);
                    } else {
                        // Broadcast the notification via SSE
                        const notification = {
                            id: this.lastID,
                            type: 'worker_waybill_received',
                            message: workerNotificationMessage,
                            related_record_id: waybillId,
                            related_record_type: 'waybill',
                            created_by: req.session.username || 'admin',
                            recipient: agentUsername,
                            is_read: 0,
                            created_at: new Date().toISOString()
                        };
                        notificationSSE.broadcast(notification);
                    }
                    db.close();
                    res.json({ success: true, id: waybillId });
                });
            } else {
                // No notification needed - either no assignment change or no new assignment
                db.close();
                res.json({ success: true, id: waybillId });
            }
        });
        }
    }
}

function waybillGenerator(req, res) {
    if (!req.session.role || req.session.role !== 'admin') {
        return res.status(403).send('Unauthorized');
    }

    try {
        const db = getDbConnection();

        // Fetch all worker/agent users for the dropdown
        db.all('SELECT id, username, role, assigned_province FROM users WHERE role = "worker" OR role = "agent" ORDER BY username ASC', (err, agencies) => {
            db.close();
            if (err) {
                console.error('[ERROR] Error fetching agencies:', err);
                console.error('[ERROR] SQL Error Details:', err.message);
                return res.status(500).send('Database error loading agencies');
            }

            res.render('waybill', { agencies: agencies || [] });
        });
    } catch (error) {
        console.error('[ERROR] Unexpected error in waybillGenerator:', error);
        return res.status(500).send('Server error loading waybill generator');
    }
}

function apiSaveWaybill(req, res) {
    if (!req.session.role || req.session.role !== 'admin') {
        return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    try {
        const {
            wb_serial,
            wb_date,
            wb_selled_to,
            wb_driver_name,
            wb_driver_phone,
            wb_truck_plate,
            wb_type,
            wb_bags,
            wb_tonnage,
            wb_truck_type,
            wb_freight_per_ton,
            wb_total_freight,
            wb_loading_province
        } = req.body;

        // Server-side validation
        if (!wb_serial || !wb_date || !wb_selled_to || !wb_driver_name || !wb_driver_phone || !wb_truck_plate || !wb_bags || !wb_loading_province) {
            return res.status(400).json({ success: false, error: 'Missing required fields' });
        }

        // Validate phone number (E164 international format)
        const cleanPhone = wb_driver_phone.trim();
        if (!cleanPhone.match(/^\+\d{8,15}$/)) {
            return res.status(400).json({ success: false, error: 'Invalid phone number format. Please use international format (e.g., +93701234567).' });
        }

        // Validate bags (must be positive integer)
        if (isNaN(wb_bags) || wb_bags <= 0) {
            return res.status(400).json({ success: false, error: 'Invalid bags count' });
        }

        // Validate freight fields if rented truck
        if (wb_truck_type === 'rented') {
            if (isNaN(wb_freight_per_ton) || wb_freight_per_ton <= 0) {
                return res.status(400).json({ success: false, error: 'Invalid freight per ton' });
            }
        }

        const db = getDbConnection();

        db.run(`
            INSERT INTO local_waybills (
                waybill_serial,
                waybill_date,
                selled_to_agent,
                driver_name,
                driver_phone,
                truck_plate,
                truck_type,
                freight_per_ton,
                total_freight,
                cement_type,
                total_bags,
                tonnage,
                loading_province,
                unloading_province,
                created_by,
                created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `, [
            wb_serial,
            wb_date,
            wb_selled_to,
            wb_driver_name,
            wb_driver_phone,
            wb_truck_plate,
            wb_truck_type || 'company',
            parseFloat(wb_freight_per_ton) || 0,
            parseFloat(wb_total_freight) || 0,
            wb_type || 'سمنت ممتاز باقران',
            parseInt(wb_bags),
            parseFloat(wb_tonnage),
            wb_loading_province,
            wb_loading_province, // Use loading province as default for unloading
            req.session.username || 'admin'
        ], function(err) {
            if (err) {
                console.error('[ERROR] Error saving waybill:', err);
                console.error('[ERROR] SQL Error Details:', err.message);
                db.close();
                return res.status(500).json({ success: false, error: 'Failed to save waybill to database' });
            }

            const waybillId = this.lastID;

            db.close();
            res.json({ success: true, waybillId: waybillId });
        });
    } catch (error) {
        console.error('[ERROR] Unexpected error in apiSaveWaybill:', error);
        return res.status(500).json({ success: false, error: 'Server error processing waybill' });
    }
}

// Cement Types Registry API Functions
function apiConfigCementTypes(req, res) {
    const db = getDbConnection();

    if (req.method === 'POST') {
        // POST requires admin role
        if (!req.session.role || req.session.role !== 'admin') {
            db.close();
            return res.status(403).json({ error: 'Unauthorized' });
        }

        const { cement_name, source_origin, storage_destination } = req.body;

        if (!cement_name || !source_origin || !storage_destination) {
            db.close();
            return res.status(400).json({ error: 'Missing required fields' });
        }

        db.run(`
            INSERT INTO cement_types (cement_name, source_origin, storage_destination)
            VALUES (?, ?, ?)
        `, [cement_name, source_origin, storage_destination], function(err) {
            if (err) {
                db.close();
                return res.status(500).json({ error: 'Database error' });
            }
            
            const cementId = this.lastID;
            const adminName = req.session.username || 'admin';
            
            // Create notification for cement registered (Event 9)
            const notificationMessage = `نوع سمنت ${cement_name} توسط ادمین ${adminName} ثبت شد`;
            db.run(`
                INSERT INTO admin_notifications (type, message, related_record_id, related_record_type, recipient, created_by, is_read, created_at)
                VALUES (?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
            `, ['cement_registered', notificationMessage, cementId, 'cement_type', 'admin', adminName], (notifErr) => {
                if (notifErr) {
                    console.error('[ERROR] Error creating cement registered notification:', notifErr);
                } else {
                    console.log('[DEBUG] Cement registered notification created for:', cement_name);
                }
                db.close();
                res.json({ success: true, id: cementId });
            });
        });
    } else if (req.method === 'GET') {
        // GET is allowed for all authenticated users (admin and workers)
        if (!req.session.role) {
            db.close();
            return res.status(403).json({ error: 'Unauthorized' });
        }

        db.all('SELECT * FROM cement_types ORDER BY id DESC', (err, rows) => {
            db.close();
            if (err) {
                return res.status(500).json({ error: 'Database error' });
            }
            res.json(rows);
        });
    }
}

// Public API endpoint for cement types (no authentication required)
function apiPublicCementTypes(req, res) {
    const db = getDbConnection();

    db.all('SELECT id, cement_name FROM cement_types ORDER BY id ASC', (err, rows) => {
        db.close();
        if (err) {
            console.error('Error fetching public cement types:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        res.json(rows);
    });
}

function apiConfigDeleteCementType(req, res) {
    if (!req.session.role || req.session.role !== 'admin') {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    const { id } = req.params;
    const db = getDbConnection();

    db.run('DELETE FROM cement_types WHERE id = ?', [id], function(err) {
        db.close();
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }
        res.json({ success: true });
    });
}

// Cement Summary Report API
function apiCementSummaryReport(req, res) {
    if (!req.session.role || req.session.role !== 'admin') {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    const { startDate, endDate } = req.query;
    const db = getDbConnection();

    // Get all registered cement types
    db.all('SELECT cement_name FROM cement_types ORDER BY cement_name', (err, cementTypes) => {
        if (err) {
            db.close();
            return res.status(500).json({ error: 'Database error fetching cement types' });
        }

        // Get cement type names
        const cementTypeNames = cementTypes.map(ct => ct.cement_name);
        
        // If no cement types registered, return empty result
        if (cementTypeNames.length === 0) {
            db.close();
            return res.json({ records: [], totals: null });
        }

        // Build SQL query to aggregate data by cement type from sales_logs
        const cementTypePlaceholders = cementTypeNames.map(() => '?').join(',');
        let query = `
            SELECT 
                cement_type,
                COUNT(DISTINCT waybill_number) as total_waybills,
                SUM(bags_count) as total_bags,
                SUM(tonnage) as total_tonnage,
                SUM(shortage) as total_shortage,
                SUM(CASE WHEN is_company_car = 1 THEN 1 ELSE 0 END) as company_trucks_count,
                SUM(CASE WHEN is_company_car = 0 THEN 1 ELSE 0 END) as rental_trucks_count,
                SUM(total_freight) as total_freight,
                SUM(total_sales_money) as total_sales,
                SUM(net_cement_money) as total_net_cement
            FROM sales_logs
            WHERE cement_type IN (${cementTypePlaceholders})
        `;
        const params = [...cementTypeNames];

        // Add date filters if provided
        if (startDate) {
            query += ` AND sale_date >= ?`;
            params.push(startDate);
        }
        if (endDate) {
            query += ` AND sale_date <= ?`;
            params.push(endDate);
        }

        query += ` GROUP BY cement_type`;

        db.all(query, params, (err, records) => {
            if (err) {
                db.close();
                return res.status(500).json({ error: 'Database error fetching summary data' });
            }

            // Create a map of cement type to its data for easy lookup
            const recordsMap = {};
            records.forEach(record => {
                recordsMap[record.cement_type] = record;
            });

            // Generate records for ALL cement types from master list
            const allRecords = cementTypeNames.map(cementName => {
                const data = recordsMap[cementName];
                if (data) {
                    return data;
                } else {
                    // Return zero record for cement types with no data
                    return {
                        cement_type: cementName,
                        total_waybills: 0,
                        total_bags: 0,
                        total_tonnage: 0,
                        total_shortage: 0,
                        company_trucks_count: 0,
                        rental_trucks_count: 0,
                        total_freight: 0,
                        total_sales: 0,
                        total_net_cement: 0
                    };
                }
            });

            // Calculate totals across all cement types
            const totals = {
                cement_type: 'جمع کل (Totals)',
                total_waybills: 0,
                total_bags: 0,
                total_tonnage: 0,
                total_shortage: 0,
                company_trucks_count: 0,
                rental_trucks_count: 0,
                total_freight: 0,
                total_sales: 0,
                total_net_cement: 0
            };

            allRecords.forEach(record => {
                totals.total_waybills += (record.total_waybills || 0);
                totals.total_bags += (record.total_bags || 0);
                totals.total_tonnage += (record.total_tonnage || 0);
                totals.total_shortage += (record.total_shortage || 0);
                totals.company_trucks_count += (record.company_trucks_count || 0);
                totals.rental_trucks_count += (record.rental_trucks_count || 0);
                totals.total_freight += (record.total_freight || 0);
                totals.total_sales += (record.total_sales || 0);
                totals.total_net_cement += (record.total_net_cement || 0);
            });

            db.close();
            res.json({ records: allRecords, totals });
        });
    });
}

// Quotation Requests Management
function adminQuotationRequests(req, res) {
    res.render('admin_quotation_requests');
}

function apiAdminQuotationRequests(req, res) {
    if (!req.session.role || req.session.role !== 'admin') {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    const { status, province, source } = req.query;
    const db = getDbConnection();

    let query = 'SELECT * FROM quotation_requests WHERE 1=1';
    const params = [];

    if (status && status !== 'all') {
        query += ' AND status = ?';
        params.push(status);
    }
    if (province && province !== 'all') {
        query += ' AND province = ?';
        params.push(province);
    }
    if (source && source !== 'all') {
        query += ' AND source_type = ?';
        params.push(source);
    }

    query += ' ORDER BY created_at DESC';

    db.all(query, params, (err, rows) => {
        db.close();
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }
        res.json(rows);
    });
}

function apiAdminQuotationRequestDetails(req, res) {
    if (!req.session.role || req.session.role !== 'admin') {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    const { id } = req.params;
    const db = getDbConnection();

    db.get('SELECT * FROM quotation_requests WHERE id = ?', [id], (err, row) => {
        db.close();
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }
        if (!row) {
            return res.status(404).json({ error: 'Request not found' });
        }
        res.json(row);
    });
}

function apiAdminWorkersList(req, res) {
    if (!req.session.role || req.session.role !== 'admin') {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    const db = getDbConnection();

    db.all('SELECT id, username, full_name, assigned_province FROM users WHERE role = "worker" ORDER BY username ASC', (err, rows) => {
        db.close();
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }
        res.json(rows);
    });
}

function apiAdminAssignQuotationRequest(req, res) {
    if (!req.session.role || req.session.role !== 'admin') {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    const { request_id, worker_username } = req.body;

    if (!request_id || !worker_username) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const db = getDbConnection();

    // Get worker details
    db.get('SELECT id, username, full_name, assigned_province FROM users WHERE username = ? AND role = "worker"', [worker_username], (err, worker) => {
        if (err) {
            db.close();
            return res.status(500).json({ error: 'Database error' });
        }
        if (!worker) {
            db.close();
            return res.status(404).json({ error: 'Worker not found' });
        }

        // Get quotation request details before updating
        db.get('SELECT * FROM quotation_requests WHERE id = ?', [request_id], (err, quotationRequest) => {
            if (err) {
                db.close();
                return res.status(500).json({ error: 'Database error' });
            }
            if (!quotationRequest) {
                db.close();
                return res.status(404).json({ error: 'Quotation request not found' });
            }

            const customerName = quotationRequest.customer_name;
            const oldStatus = quotationRequest.status;

            // Update quotation request
            db.run(`
                UPDATE quotation_requests 
                SET assigned_worker = ?, 
                    assigned_worker_username = ?, 
                    source_type = 'admin_assigned',
                    status = 'assigned_to_worker',
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `, [worker.full_name || worker.username, worker.username, request_id], function(err) {
                if (err) {
                    db.close();
                    return res.status(500).json({ error: 'Failed to assign request' });
                }

                // Create notification for quotation request delivered (Event 11)
                // Only create if status actually changed to assigned_to_worker
                if (oldStatus !== 'assigned_to_worker') {
                    const agencyName = worker.full_name || worker.username;
                    const notificationMessage = `درخواست مشتری ${customerName} به نمایندگی ${agencyName} ارسال شد`;
                    const adminName = req.session.username || 'admin';
                    
                    db.run(`
                        INSERT INTO admin_notifications (type, message, related_record_id, related_record_type, recipient, created_by, is_read, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
                    `, ['quotation_request_delivered', notificationMessage, request_id, 'quotation_request', worker.username, adminName], (notifErr) => {
                        if (notifErr) {
                            console.error('[ERROR] Error creating quotation request delivered notification:', notifErr);
                        } else {
                            console.log('[DEBUG] Quotation request delivered notification created');
                            
                            // Broadcast the notification via SSE to the worker
                            const notification = {
                                id: this.lastID,
                                type: 'quotation_request_delivered',
                                message: notificationMessage,
                                related_record_id: request_id,
                                related_record_type: 'quotation_request',
                                created_by: adminName,
                                recipient: worker.username,
                                is_read: 0,
                                created_at: new Date().toISOString()
                            };
                            notificationSSE.broadcast(notification);
                        }
                        db.close();
                        res.json({ success: true });
                    });
                } else {
                    db.close();
                    res.json({ success: true });
                }
            });
        });
    });
}

// Notification API Functions
function apiAdminNotifications(req, res) {
    if (!req.session.role) {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    
    const db = getDbConnection();
    const currentUser = req.session.username;
    const userRole = req.session.role;
    
    // Build query based on role. Conditions are wrapped in parentheses so the
    // unread-count filter below applies to the whole condition, not just its
    // last OR branch.
    let conditions = '';
    let params = [];
    
    if (userRole === 'admin') {
        // Admin sees all notifications intended for admin
        conditions = '(recipient = ? OR recipient IS NULL OR recipient = "admin")';
        params = ['admin'];
    } else {
        // Workers only see notifications intended for them or for all workers
        conditions = '(recipient = ? OR recipient = "all_workers")';
        params = [currentUser];
    }
    
    // Pagination: fetch one extra row to learn whether more pages exist.
    const pageSize = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const pageOffset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    
    db.all(`
        SELECT * FROM admin_notifications 
        WHERE ${conditions}
        ORDER BY is_read ASC, created_at DESC 
        LIMIT ? OFFSET ?
    `, [...params, pageSize + 1, pageOffset], (err, rows) => {
        if (err) {
            db.close();
            return res.status(500).json({ error: 'Database error' });
        }
        
        const hasMore = Array.isArray(rows) && rows.length > pageSize;
        const notifications = hasMore ? rows.slice(0, pageSize) : (rows || []);
        
        db.get(`SELECT COUNT(*) as count FROM admin_notifications WHERE ${conditions} AND is_read = 0`, params, (err, unreadRow) => {
            db.close();
            if (err) {
                return res.status(500).json({ error: 'Database error' });
            }
            
            const unreadCount = unreadRow ? unreadRow.count : 0;
            
            res.json({
                notifications: notifications,
                unread_count: unreadCount,
                has_more: hasMore
            });
        });
    });
}

function apiAdminMarkNotificationRead(req, res) {
    if (!req.session.role) {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    
    const { notification_id } = req.body;
    
    if (!notification_id) {
        return res.status(400).json({ error: 'Notification ID required' });
    }
    
    const db = getDbConnection();
    const currentUser = req.session.username;
    const userRole = req.session.role;
    
    // Build WHERE clause to ensure user can only mark their own notifications as read
    let whereClause = '';
    let params = [notification_id];
    
    if (userRole === 'admin') {
        whereClause = 'AND (recipient = ? OR recipient IS NULL OR recipient = "admin")';
        params.push('admin');
    } else {
        whereClause = 'AND (recipient = ? OR recipient = "all_workers")';
        params.push(currentUser);
    }
    
    db.run(`
        UPDATE admin_notifications 
        SET is_read = 1, read_at = CURRENT_TIMESTAMP 
        WHERE id = ? ${whereClause}
    `, params, function(err) {
        if (err) {
            db.close();
            return res.status(500).json({ error: 'Database error' });
        }
        
        // Calculate current unread count for this user
        let unreadWhereClause = '';
        let unreadParams = [];
        
        if (userRole === 'admin') {
            unreadWhereClause = '(recipient = ? OR recipient IS NULL OR recipient = "admin")';
            unreadParams = ['admin'];
        } else {
            unreadWhereClause = '(recipient = ? OR recipient = "all_workers")';
            unreadParams = [currentUser];
        }
        
        db.get(`
            SELECT COUNT(*) as unread_count 
            FROM admin_notifications 
            WHERE is_read = 0 AND (${unreadWhereClause})
        `, unreadParams, function(countErr, row) {
            db.close();
            if (countErr) {
                console.error('Error counting unread notifications:', countErr);
                return res.json({ success: true, notification_id: notification_id, unread_count: 0 });
            }
            res.json({ 
                success: true, 
                notification_id: notification_id, 
                unread_count: row.unread_count 
            });
        });
    });
}

function apiAdminMarkAllNotificationsRead(req, res) {
    if (!req.session.role) {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    
    const db = getDbConnection();
    const currentUser = req.session.username;
    const userRole = req.session.role;
    
    // Build WHERE clause to ensure user can only mark their own notifications as read
    let whereClause = '';
    let params = [];
    
    if (userRole === 'admin') {
        whereClause = 'recipient = ? OR recipient IS NULL OR recipient = "admin"';
        params = ['admin'];
    } else {
        whereClause = 'recipient = ? OR recipient = "all_workers"';
        params = [currentUser];
    }
    
    db.run(`
        UPDATE admin_notifications 
        SET is_read = 1, read_at = CURRENT_TIMESTAMP 
        WHERE is_read = 0 AND (${whereClause})
    `, params, function(err) {
        if (err) {
            db.close();
            return res.status(500).json({ error: 'Database error' });
        }
        
        // Calculate current unread count for this user (should be 0 after marking all as read)
        let unreadWhereClause = '';
        let unreadParams = [];
        
        if (userRole === 'admin') {
            unreadWhereClause = '(recipient = ? OR recipient IS NULL OR recipient = "admin")';
            unreadParams = ['admin'];
        } else {
            unreadWhereClause = '(recipient = ? OR recipient = "all_workers")';
            unreadParams = [currentUser];
        }
        
        db.get(`
            SELECT COUNT(*) as unread_count 
            FROM admin_notifications 
            WHERE is_read = 0 AND (${unreadWhereClause})
        `, unreadParams, function(countErr, row) {
            db.close();
            if (countErr) {
                console.error('Error counting unread notifications:', countErr);
                return res.json({ success: true, unread_count: 0 });
            }
            res.json({ 
                success: true, 
                unread_count: row.unread_count 
            });
        });
    });
}

function apiAdminCreateNotification(req, res) {
    // This is an internal API, should be called from server-side only
    // Not exposed to client for security
    const { type, message, related_record_id, related_record_type, agency_name, created_by, recipient } = req.body;
    
    if (!type || !message) {
        return res.status(400).json({ error: 'Type and message required' });
    }
    
    const db = getDbConnection();
    
    // Remove duplicate check to allow multiple notifications for the same record
    // Each event should create its own notification
    db.run(`
        INSERT INTO admin_notifications (type, message, related_record_id, related_record_type, agency_name, created_by, recipient)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [type, message, related_record_id, related_record_type, agency_name, created_by, recipient || 'admin'], function(err) {
        db.close();
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }
        res.json({ success: true, notification_id: this.lastID });
    });
}

function apiAdminClearAllNotifications(req, res) {
    if (!req.session.role) {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    
    const db = getDbConnection();
    const currentUser = req.session.username;
    const userRole = req.session.role;
    
    // Build WHERE clause to ensure user can only clear their own notifications
    let whereClause = '';
    let params = [];
    
    if (userRole === 'admin') {
        whereClause = 'recipient = ? OR recipient IS NULL OR recipient = "admin"';
        params = ['admin'];
    } else {
        whereClause = 'recipient = ? OR recipient = "all_workers"';
        params = [currentUser];
    }
    
    db.run(`
        DELETE FROM admin_notifications 
        WHERE (${whereClause})
    `, params, function(err) {
        db.close();
        if (err) {
            return res.status(500).json({ error: 'Database error' });
        }
        res.json({ success: true, deleted_count: this.changes });
    });
}

function apiCustomerBalances(req, res) {
    if (!req.session || req.session.role !== 'admin') {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    const db = getDbConnection();
    
    // Query to get customer balances with all required information
    const query = `
        SELECT 
            c.id,
            c.customer_id,
            c.name,
            c.province,
            c.address,
            c.customer_type,
            c.email,
            c.phone,
            u.agency_name,
            COALESCE(SUM(sl.net_cement_money), 0) as total_cement_purchases,
            COALESCE(SUM(rl.amount_received), 0) as total_payments_receipts
        FROM customers c
        LEFT JOIN users u ON c.created_by = u.username
        LEFT JOIN sales_logs sl ON c.id = sl.customer_id
        LEFT JOIN receipts_logs rl ON c.id = rl.customer_id
        GROUP BY c.id, c.customer_id, c.name, c.province, c.address, c.customer_type, c.email, c.phone, u.agency_name
        ORDER BY 
            CASE 
                WHEN COALESCE(SUM(sl.net_cement_money), 0) - COALESCE(SUM(rl.amount_received), 0) != 0 THEN 0
                ELSE 1
            END,
            c.name ASC
    `;
    
    db.all(query, (err, customers) => {
        if (err) {
            db.close();
            return res.status(500).json({ error: 'Database error' });
        }
        
        // Calculate balances for each customer
        const customerBalances = customers.map((customer, index) => {
            const totalDebit = customer.total_cement_purchases || 0;
            const totalCredit = customer.total_payments_receipts || 0;
            const balance = totalDebit - totalCredit;
            
            let companyOwesCustomer = 0;
            let customerOwesCompany = 0;
            
            if (balance > 0) {
                customerOwesCompany = balance;
            } else if (balance < 0) {
                companyOwesCustomer = Math.abs(balance);
            }
            
            return {
                '#': index + 1,
                'ID': customer.customer_id || `CUST-${customer.id}`,
                'Name': customer.name,
                'Agency': customer.agency_name || '-',
                'Province': customer.province,
                'Full Address': customer.address || '-',
                'Customer Type': customer.customer_type || '-',
                'Email': customer.email || '-',
                'Phone Number': customer.phone || '-',
                'Total Cement Purchases': totalDebit,
                'Total Payments / Receipts': totalCredit,
                'Company Owes Customer': companyOwesCustomer,
                'Customer Owes Company': customerOwesCompany
            };
        });
        
        db.close();
        res.json(customerBalances);
    });
}

// Helper function to process tonnage query and build response
function processTonnageQuery(startDate, endDate, period, cementTypes, agency, month, year, res) {
    const db = getDbConnection();

    // Build base query
    let query = `
        SELECT 
            sale_date,
            cement_type,
            SUM(tonnage) as total_tonnage,
            au.agency_name
        FROM sales_logs sl
        LEFT JOIN customers c ON sl.customer_id = c.id
        LEFT JOIN users au ON c.created_by = au.username
        WHERE 1=1
    `;
    const params = [];

    // Add date filters based on period
    if (period === 'monthly' && month && year) {
        query += ` AND substr(sale_date, 1, 7) = ?`;
        params.push(`${year}/${month}`);
    } else if (period === 'yearly') {
        // Yearly mode is handled in the yearly branch below, don't add params here
    } else {
        // Daily mode with manual date range
        if (startDate) {
            query += ` AND sale_date >= ?`;
            params.push(startDate);
        }
        if (endDate) {
            query += ` AND sale_date <= ?`;
            params.push(endDate);
        }
    }

    // Add cement type filter
    if (cementTypes && cementTypes !== 'all') {
        const types = cementTypes.split(',');
        const placeholders = types.map(() => '?').join(',');
        query += ` AND cement_type IN (${placeholders})`;
        params.push(...types);
    }

    // Add agency filter
    if (agency && agency !== 'all') {
        query += ` AND au.agency_name = ?`;
        params.push(agency);
    }

    // Group by based on period
    if (period === 'yearly') {
        query = `
            SELECT 
                substr(sale_date, 6, 2) as month,
                cement_type,
                SUM(tonnage) as total_tonnage,
                au.agency_name
            FROM sales_logs sl
            LEFT JOIN customers c ON sl.customer_id = c.id
            LEFT JOIN users au ON c.created_by = au.username
            WHERE 1=1
        `;
        // Re-add year filter for yearly
        if (year) {
            query += ` AND substr(sale_date, 1, 4) = ?`;
            params.push(year);
        }
        if (cementTypes && cementTypes !== 'all') {
            const types = cementTypes.split(',');
            const placeholders = types.map(() => '?').join(',');
            query += ` AND cement_type IN (${placeholders})`;
            params.push(...types);
        }
        if (agency && agency !== 'all') {
            query += ` AND au.agency_name = ?`;
            params.push(agency);
        }
        query += ` GROUP BY substr(sale_date, 6, 2), cement_type ORDER BY month, cement_type`;
    } else if (period === 'monthly') {
        // Monthly mode - group by actual sale_date within the selected month
        query += ` GROUP BY sale_date, cement_type ORDER BY sale_date, cement_type`;
    } else {
        // Daily (default)
        query += ` GROUP BY sale_date, cement_type ORDER BY sale_date, cement_type`;
    }

    db.all(query, params, (err, rows) => {
        if (err) {
            console.error('[ERROR] Tonnage statistics query error:', err);
            console.error('[ERROR] Query:', query);
            console.error('[ERROR] Params:', params);
            db.close();
            return res.status(500).json({ error: 'Database error' });
        }

        // Get unique cement types and dates
        const cementTypeSet = new Set();
        const dateSet = new Set();
        rows.forEach(row => {
            cementTypeSet.add(row.cement_type);
            const dateValue = row.sale_date || row.year || row.month;
            if (dateValue) {
                dateSet.add(dateValue);
            }
        });

        const cementTypesList = Array.from(cementTypeSet).sort();
        let datesList = Array.from(dateSet).sort();

        // For daily mode without manual date range, take latest 31 existing dates
        if (period === 'daily' && !startDate && !endDate) {
            datesList = datesList.slice(-31);
        }

        // For yearly mode, always use all 12 months in chronological order
        if (period === 'yearly') {
            const jalaliMonthNames = {
                '01': 'حمل',
                '02': 'ثور',
                '03': 'جوزا',
                '04': 'سرطان',
                '05': 'اسد',
                '06': 'سنبله',
                '07': 'میزان',
                '08': 'عقرب',
                '09': 'قوس',
                '10': 'جدی',
                '11': 'دلو',
                '12': 'حوت'
            };
            // Always use all 12 months in order
            const allMonths = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];
            datesList = allMonths.map(month => jalaliMonthNames[month] || month);
        }

        // Build datasets for each cement type
        const datasets = cementTypesList.map((cementType, index) => {
            const data = datesList.map(date => {
                let row = null;
                if (period === 'yearly') {
                    // For yearly, convert Jalali month name back to month number for matching
                    const jalaliMonthNames = {
                        'حمل': '01',
                        'ثور': '02',
                        'جوزا': '03',
                        'سرطان': '04',
                        'اسد': '05',
                        'سنبله': '06',
                        'میزان': '07',
                        'عقرب': '08',
                        'قوس': '09',
                        'جدی': '10',
                        'دلو': '11',
                        'حوت': '12'
                    };
                    const monthNum = jalaliMonthNames[date];
                    row = rows.find(r => r.cement_type === cementType && r.month === monthNum);
                } else {
                    row = rows.find(r => 
                        r.cement_type === cementType && 
                        (r.sale_date === date || r.year === date || r.month === date)
                    );
                }
                return row ? row.total_tonnage : 0;
            });

            if (period === 'yearly') {
                console.log('[TONNAGE YEARLY DEBUG] Dataset for', cementType, ':', data);
                console.log('[TONNAGE YEARLY DEBUG] Dataset length:', data.length);
            }

            // Professional color palette
            const colors = [
                '#3b82f6', // Blue
                '#10b981', // Green
                '#f59e0b', // Amber
                '#ef4444', // Red
                '#8b5cf6', // Purple
                '#ec4899', // Pink
                '#06b6d4', // Cyan
                '#84cc16'  // Lime
            ];
            const color = colors[index % colors.length];

            return {
                label: cementType,
                data: data,
                borderColor: color,
                backgroundColor: color + '20', // Add transparency
                fill: true,
                tension: 0.4,
                pointRadius: 4,
                pointHoverRadius: 6
            };
        });

        // Calculate totals
        const totalTonnage = rows.reduce((sum, row) => sum + (row.total_tonnage || 0), 0);
        const averageDaily = datesList.length > 0 ? totalTonnage / datesList.length : 0;

        db.close();
        res.json({
            labels: datesList,
            datasets: datasets,
            totals: {
                totalTonnage: Math.round(totalTonnage * 10) / 10,
                averageDaily: Math.round(averageDaily * 10) / 10,
                dataPoints: rows.length
            }
        });
    });
}

// Tonnage Statistics API for Chart
function apiTonnageStatistics(req, res) {
    if (!req.session.role || req.session.role !== 'admin') {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    const { startDate, endDate, period, cementTypes, agency, month, year } = req.query;
    
    processTonnageQuery(startDate, endDate, period, cementTypes, agency, month, year, res);
}

// API to get available years from sales_logs
function apiTonnageYears(req, res) {
    if (!req.session.role || req.session.role !== 'admin') {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    const db = getDbConnection();
    
    db.all('SELECT DISTINCT substr(sale_date, 1, 4) as year FROM sales_logs WHERE sale_date IS NOT NULL ORDER BY year', (err, rows) => {
        if (err) {
            console.error('[ERROR] Tonnage years query error:', err);
            db.close();
            return res.status(500).json({ error: 'Database error' });
        }

        const years = rows.map(row => row.year);
        db.close();
        res.json({ years: years });
    });
}

// Cement Sales Distribution API for Donut Chart
function apiCementSalesDistribution(req, res) {
    if (!req.session.role || req.session.role !== 'admin') {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    const { startDate, endDate, month, year, cementTypes, agency } = req.query;
    
    // DEBUG: Log incoming filter values
    console.log('[CEMENT ANALYTICS DEBUG] Filter values:');
    console.log('  startDate:', startDate);
    console.log('  endDate:', endDate);
    console.log('  month:', month);
    console.log('  year:', year);
    console.log('  cementTypes:', cementTypes);
    console.log('  agency:', agency);
    
    const db = getDbConnection();

    // Build base query
    let query = `
        SELECT 
            cement_type,
            SUM(tonnage) as total_tonnage
        FROM sales_logs sl
        LEFT JOIN customers c ON sl.customer_id = c.id
        LEFT JOIN users au ON c.created_by = au.username
        WHERE 1=1
    `;
    const params = [];

    // Add date filters
    if (startDate && endDate) {
        query += ` AND sale_date >= ? AND sale_date <= ?`;
        params.push(startDate, endDate);
    } else if (month) {
        query += ` AND substr(sale_date, 1, 7) = ?`;
        params.push(month);
    } else if (year) {
        query += ` AND substr(sale_date, 1, 4) = ?`;
        params.push(year);
    }

    // Add cement type filter
    if (cementTypes && cementTypes !== 'all') {
        const types = cementTypes.split(',');
        const placeholders = types.map(() => '?').join(',');
        query += ` AND cement_type IN (${placeholders})`;
        params.push(...types);
    }

    // Add agency filter
    if (agency && agency !== 'all') {
        query += ` AND au.agency_name = ?`;
        params.push(agency);
    }

    query += ` GROUP BY cement_type ORDER BY total_tonnage DESC`;

    db.all(query, params, (err, rows) => {
        if (err) {
            console.error('[ERROR] Cement sales distribution query error:', err);
            db.close();
            return res.status(500).json({ error: 'Database error' });
        }

        // DEBUG: Log query results
        console.log('[CEMENT ANALYTICS DEBUG] Query results:');
        console.log('  Records returned:', rows.length);
        console.log('  Query:', query);
        console.log('  Params:', params);
        if (rows.length > 0) {
            console.log('  First record keys:', Object.keys(rows[0]));
            console.log('  First record:', rows[0]);
        }

        // Calculate total tonnage
        const totalTonnage = rows.reduce((sum, row) => sum + (row.total_tonnage || 0), 0);

        // Build distribution data with percentages
        const distribution = rows.map(row => {
            const percentage = totalTonnage > 0 ? (row.total_tonnage / totalTonnage) * 100 : 0;
            return {
                cement_type: row.cement_type,
                tonnage: Math.round(row.total_tonnage * 10) / 10,
                percentage: Math.round(percentage * 10) / 10
            };
        });

        // Professional color palette (same as line chart for consistency)
        const colors = [
            '#3b82f6', // Blue
            '#10b981', // Green
            '#f59e0b', // Amber
            '#ef4444', // Red
            '#8b5cf6', // Purple
            '#ec4899', // Pink
            '#06b6d4', // Cyan
            '#84cc16'  // Lime
        ];

        // Assign colors to cement types
        const distributionWithColors = distribution.map((item, index) => ({
            ...item,
            color: colors[index % colors.length]
        }));

        db.close();
        res.json({
            distribution: distributionWithColors,
            totalTonnage: Math.round(totalTonnage * 10) / 10,
            cementTypesCount: distribution.length
        });
    });
}

// Province Sales API for Bar Chart
function apiProvinceSales(req, res) {
    if (!req.session.role || req.session.role !== 'admin') {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    const { startDate, endDate, month, year, cementTypes, agency } = req.query;
    const db = getDbConnection();

    // Afghanistan provinces - matches Worker dropdown (source of truth)
    const allProvinces = [
        'Kabul', 'Kapisa', 'Parwan', 'Wardak', 'Logar', 'Nangarhar', 'Laghman',
        'Panjshir', 'Baghlan', 'Bamyan', 'Ghazni', 'Paktika', 'Paktia', 'Kunar',
        'Nuristan', 'Badakhshan', 'Takhar', 'Kunduz', 'Balkh', 'Jowzjan', 'Faryab',
        'Sar-e Pol', 'Samangan', 'Herat', 'Badghis', 'Ghor', 'Farah', 'Nimroz',
        'Helmand', 'Kandahar', 'Zabul', 'Uruzgan', 'Daykundi', 'Khost'
    ];

    // Build base query
    let query = `
        SELECT 
            c.province,
            SUM(sl.tonnage) as total_tonnage
        FROM sales_logs sl
        LEFT JOIN customers c ON sl.customer_id = c.id
        LEFT JOIN users au ON c.created_by = au.username
        WHERE 1=1
    `;
    const params = [];

    // Add date filters
    if (startDate && endDate) {
        query += ` AND sale_date >= ? AND sale_date <= ?`;
        params.push(startDate, endDate);
    } else if (month) {
        query += ` AND substr(sale_date, 1, 7) = ?`;
        params.push(month);
    } else if (year) {
        query += ` AND substr(sale_date, 1, 4) = ?`;
        params.push(year);
    }

    // Add cement type filter
    if (cementTypes && cementTypes !== 'all') {
        const types = cementTypes.split(',');
        const placeholders = types.map(() => '?').join(',');
        query += ` AND cement_type IN (${placeholders})`;
        params.push(...types);
    }

    // Add agency filter
    if (agency && agency !== 'all') {
        query += ` AND au.agency_name = ?`;
        params.push(agency);
    }

    query += ` GROUP BY c.province`;

    db.all(query, params, (err, rows) => {
        if (err) {
            console.error('[ERROR] Province sales query error:', err);
            db.close();
            return res.status(500).json({ error: 'Database error' });
        }

        // Create a map of province to tonnage
        const provinceMap = {};
        rows.forEach(row => {
            provinceMap[row.province] = row.total_tonnage;
        });

        // Build result for all 34 provinces
        const provinceSales = allProvinces.map(province => ({
            province: province,
            tonnage: Math.round((provinceMap[province] || 0) * 10) / 10
        }));

        // Sort by tonnage descending (highest first)
        provinceSales.sort((a, b) => b.tonnage - a.tonnage);

        // Calculate total tonnage
        const totalTonnage = provinceSales.reduce((sum, item) => sum + item.tonnage, 0);

        // Add percentages
        const provinceSalesWithPercentage = provinceSales.map(item => ({
            ...item,
            percentage: totalTonnage > 0 ? Math.round((item.tonnage / totalTonnage) * 1000) / 10 : 0
        }));

        db.close();
        res.json({
            provinces: provinceSalesWithPercentage,
            totalTonnage: Math.round(totalTonnage * 10) / 10,
            provincesCount: allProvinces.length
        });
    });
}

module.exports = {
    adminDashboard,
    adminManageWorkers,
    adminDeleteWorker,
    adminManageUsers,
    adminAddUser,
    adminUpdateUser,
    adminDeleteUser,
    adminHomepageControl,
    adminHomepageMediaUpload,
    adminHomepageMediaDelete,
    adminHomepageProductCreate,
    adminHomepageProductUpdate,
    adminHomepageProductDelete,
    adminHomepageProductToggle,
    adminHomepageProductImageUpload,
    adminHomepageProductImageDelete,
    apiAdminAgents,
    apiFinancialMetrics,
    agentRemittances,
    adminAllAgencyExpenses,
    apiAdminAgenciesList,
    apiAdminAgencyExpensesSummary,
    apiAdminAgencyExpenses,
    adminCreateWaybill,
    apiAdminSaveWaybill,
    apiAdminNextWaybillSerial,
    apiAdminWaybillHistory,
    apiAdminDeleteWaybill,
    apiAdminUpdateWaybill,
    apiCustomerBalances,
    waybillGenerator,
    apiSaveWaybill,
    apiConfigCementTypes,
    apiConfigDeleteCementType,
    apiPublicCementTypes,
    apiCementSummaryReport,
    adminQuotationRequests,
    apiAdminQuotationRequests,
    apiAdminQuotationRequestDetails,
    apiAdminNotifications,
    apiAdminMarkNotificationRead,
    apiAdminMarkAllNotificationsRead,
    apiAdminCreateNotification,
    apiAdminClearAllNotifications,
    apiAdminWorkersList,
    apiAdminAssignQuotationRequest,
    apiTonnageStatistics,
    apiTonnageYears,
    apiCementSalesDistribution,
    apiProvinceSales
};
