const { getDbConnection } = require('../config/database');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const bcrypt = require('bcryptjs');
const rateLimiter = require('../middleware/rateLimiter');
const { purgeUserSessions, keepSidFor } = require('../utils/sessionPurge');

const BCRYPT_SALT_ROUNDS = 12;

function isRecognizedBcryptHash(value) {
    if (!value || typeof value !== 'string') return false;
    return (value.length === 60 && (value.startsWith('$2a$') || value.startsWith('$2b$')));
}

// H2/M10: fixed dummy hash used to equalise response timing when a username does
// not exist, so attackers cannot enumerate valid accounts by measuring login latency.
// Value is a bcrypt hash of a throwaway string; it is not a credential for any account.
const DUMMY_BCRYPT_HASH = '$2b$12$0TGXOcF19eeRUiDxMJ9mHOTKP0lWcxjpz7QJX/Urp7TVXLTt4EsVq';

// M3: password-reset tokens are stored as SHA-256 digests, never in plaintext.
// The emailed link still carries the raw token (delivery requires it); the DB
// only ever holds the digest, so a DB leak cannot yield working reset links.
function hashResetToken(token) {
    return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function login(req, res) {
    if (req.method === 'POST') {
        const { username, password } = req.body;

        // 12G: throttle before credential check (no username disclosure)
        rateLimiter.loginPreCheck(req, res, function () {
            const db = getDbConnection();
            db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
                if (err) {
                    db.close();
                    req.session.message = { type: 'error', text: res.locals.t('auth.database_error') };
                    return res.render('login', { message: req.session.message });
                }

                function failInvalid() {
                    rateLimiter.registerLoginFailure(req);
                    req.session.message = { type: 'error', text: res.locals.t('auth.invalid_credentials') };
                    return res.render('login', { message: req.session.message });
                }

                if (!user) {
                    // M10: burn an equivalent bcrypt compare so a missing user and a
                    // wrong password cost comparable time (no username enumeration).
                    return bcrypt.compare(String(password || ''), DUMMY_BCRYPT_HASH, () => {
                        db.close();
                        return failInvalid();
                    });
                }

                const storedPassword = user.password;

                if (isRecognizedBcryptHash(storedPassword)) {
                    bcrypt.compare(password, storedPassword, (compareErr, isMatch) => {
                        db.close();
                        if (compareErr || !isMatch) {
                            return failInvalid();
                        }
                        rateLimiter.clearLoginFailures(req);
                        completeLogin(req, res, user);
                    });
                } else {
                    // H2: plaintext-stored credentials can no longer authenticate.
                    // They were migrated to bcrypt at rest by scripts/migrate_plaintext_passwords.js.
                    db.close();
                    return failInvalid();
                }
            });
        });
    } else {
        const message = req.session.message;
        req.session.message = null;
        // Make CSRF token available in the login template
        res.locals.csrfToken = req.session.csrfToken || '';
        res.render('login', { message });
    }
}

function completeLogin(req, res, user) {
    // 12D: regenerate session ID after successful authentication only.
    req.session.regenerate((regenErr) => {
        if (regenErr) {
            console.error('session_regenerate_failed');
            return req.session.destroy(() => {
                res.clearCookie('connect.sid', { path: '/' });
                // Fresh session so the error form still has a valid CSRF token.
                req.session.regenerate(() => {
                    req.session.csrfToken = crypto.randomBytes(32).toString('base64url');
                    res.locals.csrfToken = req.session.csrfToken;
                    res.status(500).render('login', {
                        message: { type: 'error', text: res.locals.t('auth.database_error') }
                    });
                });
            });
        }

        req.session.user_id = user.id;
        req.session.username = user.username;
        req.session.role = user.role;
        req.session.province = user.assigned_province;
        req.session.agency_name = user.agency_name;
        req.session.permissions = user.permissions;
        req.session.can_update = user.can_update;
        req.session.can_delete = user.can_delete;
        req.session.email = user.email;
        req.session.profile_picture = user.profile_picture;
        req.session.csrfToken = crypto.randomBytes(32).toString('base64url');
        res.locals.csrfToken = req.session.csrfToken;
        // No post-login greeting banner (owner request, 2026-10-19)

        req.session.save((saveErr) => {
            if (saveErr) {
                console.error('session_save_failed');
                return req.session.destroy(() => {
                    res.clearCookie('connect.sid', { path: '/' });
                    req.session.regenerate(() => {
                        req.session.csrfToken = crypto.randomBytes(32).toString('base64url');
                        res.locals.csrfToken = req.session.csrfToken;
                        res.status(500).render('login', {
                            message: { type: 'error', text: res.locals.t('auth.database_error') }
                        });
                    });
                });
            }

            if (user.role === 'admin') {
                return res.redirect('/admin');
            } else if (user.role === 'worker') {
                return res.redirect('/worker');
            } else {
                return res.redirect('/');
            }
        });
    });
}

function logout(req, res) {
    // Tear down this session's live SSE notification streams immediately —
    // destroying the session alone would leave open tabs receiving notifications.
    try {
        const notificationSSE = require('../utils/notificationSSE');
        notificationSSE.removeConnection(req.sessionID);
    } catch (e) { /* teardown must never block logout */ }
    req.session.destroy((err) => {
        res.clearCookie('connect.sid', { path: '/' });
        if (err) {
            return res.redirect('/');
        }
        res.redirect('/login');
    });
}

// Shared data loader for the public customer website (home, products, about, quote).
// Never fails: query errors fall back to empty content, as before.
function loadCustomerSiteData(req, callback) {
    const db = getDbConnection();
    const currentLang = req.session.lang || req.cookies.lang || 'en';
    
    // Helper function to get translation with fallback
    const getTranslation = (translations, section, field, fallbackValue) => {
        // Try requested language first
        const requested = translations.find(t => 
            t.language === currentLang && t.section === section && t.field === field
        );
        if (requested && requested.value) return requested.value;
        
        // Fallback to English
        const english = translations.find(t => 
            t.language === 'en' && t.section === section && t.field === field
        );
        if (english && english.value) return english.value;
        
        // Fallback to legacy value
        return fallbackValue;
    };
    
    // Get all homepage translations
    db.all('SELECT * FROM homepage_translations', (err, translations) => {
        if (err) {
            console.error('Error fetching homepage translations:', err);
            translations = [];
        }
        
        // Get homepage media
        db.all('SELECT * FROM homepage_media', (err, mediaRecords) => {
            if (err) {
                console.error('Error fetching homepage media:', err);
                mediaRecords = [];
            }
            
            // Convert media records to object keyed by media_key
            const media = {};
            mediaRecords.forEach(m => {
                media[m.media_key] = m.file_path;
            });
            
            // Get active homepage products with language fallback
            db.all(`
                SELECT 
                    hp.id,
                    hp.image_path,
                    hp.display_order,
                    hpt.language,
                    hpt.name,
                    hpt.description,
                    hpt.specifications
                FROM homepage_products hp
                LEFT JOIN homepage_product_translations hpt 
                    ON hp.id = hpt.product_id
                WHERE hp.is_active = 1
                ORDER BY hp.display_order ASC, hp.id ASC
            `, (err, productRows) => {
                if (err) {
                    console.error('Error fetching homepage products:', err);
                    productRows = [];
                }
                
                // Group translations by product and apply language fallback
                const productsMap = {};
                productRows.forEach(row => {
                    if (!productsMap[row.id]) {
                        productsMap[row.id] = {
                            id: row.id,
                            image_path: row.image_path,
                            display_order: row.display_order,
                            translations: {}
                        };
                    }
                    if (row.language) {
                        productsMap[row.id].translations[row.language] = {
                            name: row.name,
                            description: row.description,
                            specifications: row.specifications
                        };
                    }
                });
                
                // Convert to array with language fallback applied
                const products = Object.values(productsMap).map(product => {
                    const trans = product.translations;
                    const current = trans[currentLang] || {};
                    const english = trans['en'] || {};
                    
                    return {
                        id: product.id,
                        image_path: product.image_path,
                        display_order: product.display_order,
                        name: current.name || english.name || '',
                        description: current.description || english.description || '',
                        specifications: current.specifications || english.specifications || ''
                    };
                });
                
                // Get legacy content as final fallback
                db.get('SELECT * FROM homepage_content WHERE id = 1', (err, legacyContent) => {
                    db.close();
                    
                    const legacy = legacyContent || {};
                    
                    // Build content object with language fallback
                    const content = {
                        hero_headline: getTranslation(translations, 'hero', 'headline', legacy.hero_headline || 'Premium Quality Cement for Stronger Construction'),
                        hero_subtext: getTranslation(translations, 'hero', 'subtext', legacy.hero_subtext || 'Driving modern architectural stability across every province with transparent ledger accounting.'),
                        about_story: getTranslation(translations, 'about', 'story', legacy.about_story || 'Our enterprise delivers high-grade premium cement tailored for structural durability.'),
                        company_mission: getTranslation(translations, 'about', 'mission', legacy.company_mission || 'To provide premium construction components with flawless transparency.'),
                        company_vision: getTranslation(translations, 'about', 'vision', legacy.company_vision || 'Driving modern construction stability through premium manufacturing standards.'),
                        footer_address: getTranslation(translations, 'footer', 'address', 'Kabul Agent Sub-Station Depot'),
                        footer_phone: getTranslation(translations, 'footer', 'phone', '+93 (0) 799-XXXXXX'),
                        footer_email: getTranslation(translations, 'footer', 'email', 'info@example.com')
                    };
                    
                    callback({ content, media, products });
                });
            });
        });
    });
}

function customerHome(req, res) {
    loadCustomerSiteData(req, ({ content, media, products }) => {
        res.render('customer_home', { content, media, products, activePage: 'home' });
    });
}

// Public website pages: /products, /about, /quote — same data, new modern design
function customerProducts(req, res) {
    loadCustomerSiteData(req, ({ content, media, products }) => {
        res.render('customer_products', { content, media, products, activePage: 'products' });
    });
}

function customerAbout(req, res) {
    loadCustomerSiteData(req, ({ content, media, products }) => {
        res.render('customer_about', { content, media, products, activePage: 'about' });
    });
}

function customerQuote(req, res) {
    loadCustomerSiteData(req, ({ content, media, products }) => {
        res.render('customer_quote', { content, media, products, activePage: 'quote' });
    });
}

function loginPortalView(req, res) {
    res.redirect('/login');
}

function customerCatalogView(req, res) {
    res.redirect('/#products');
}

// Forgot Password - Show form
function forgotPassword(req, res) {
    const message = req.session.message;
    req.session.message = null;
    res.render('forgot-password', { message });
}

// Forgot Password - Generate token and send email
function forgotPasswordSubmit(req, res) {
    const { username } = req.body;
    
    if (!username) {
        req.session.message = { type: 'error', text: 'لطفاً نام کاربری را وارد کنید' };
        return res.redirect('/forgot-password');
    }

    const db = getDbConnection();
    db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
        if (err) {
            db.close();
            req.session.message = { type: 'error', text: 'خطا در پایگاه داده' };
            return res.redirect('/forgot-password');
        }

        if (!user) {
            db.close();
            // Don't reveal if user exists for security
            req.session.message = { type: 'success', text: 'اگر نام کاربری معتبر باشد، لینک بازیابی به ایمیل شما ارسال می‌شود' };
            return res.redirect('/forgot-password');
        }

        // Generate secure token
        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 minutes

        // Store token digest in database (M3: never the plaintext token)
        db.run('INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)',
            [user.id, hashResetToken(token), expiresAt], (err) => {
                if (err) {
                    db.close();
                    req.session.message = { type: 'error', text: 'خطا در ایجاد توکن بازیابی' };
                    return res.redirect('/forgot-password');
                }

                // Send email
                sendResetEmail(user.username, token, (emailErr) => {
                    db.close();
                    
                    if (emailErr) {
                        console.error('Email error:', emailErr);
                        req.session.message = { type: 'error', text: 'خطا در ارسال ایمیل. لطفاً با مدیر سیستم تماس بگیرید.' };
                    } else {
                        req.session.message = { type: 'success', text: 'لینک بازیابی رمز عبور به ایمیل شما ارسال شد' };
                    }
                    res.redirect('/forgot-password');
                });
            });
    });
}

// Send reset email
function sendResetEmail(username, token, callback) {
    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS
        }
    });

    const resetLink = `${process.env.APP_URL || 'http://localhost:5000'}/reset-password?token=${token}`;

    const mailOptions = {
        from: process.env.EMAIL_USER,
        to: username,
        subject: 'بازیابی رمز عبور - سیستم مدیریت سمنت باقران',
        text: `برای بازیابی رمز عبور خود روی لینک زیر کلیک کنید:\n\n${resetLink}\n\nاین لینک تنها ۱۵ دقیقه معتبر است.\n\nاگر شما درخواست بازیابی رمز عبور نکرده‌اید، این ایمیل را نادیده بگیرید.`
    };

    transporter.sendMail(mailOptions, callback);
}

// Reset Password - Show form
function resetPassword(req, res) {
    const { token } = req.query;
    
    if (!token) {
        req.session.message = { type: 'error', text: 'توکن بازیابی نامعتبر است' };
        return res.redirect('/forgot-password');
    }

    const db = getDbConnection();
    db.get('SELECT * FROM password_reset_tokens WHERE token = ? AND used = 0 AND expires_at > datetime("now")',
        [hashResetToken(token)], (err, resetToken) => {
            db.close();
            
            if (err || !resetToken) {
                req.session.message = { type: 'error', text: 'توکن بازیابی منقضی شده یا نامعتبر است' };
                return res.redirect('/forgot-password');
            }

            const message = req.session.message;
            req.session.message = null;
            res.render('reset-password', { token, message });
        });
}

// Reset Password - Update password
function resetPasswordSubmit(req, res) {
    const { token, password, confirmPassword } = req.body;

    if (!token || !password || !confirmPassword) {
        req.session.message = { type: 'error', text: 'لطفاً تمام فیلدها را پر کنید' };
        return res.redirect(`/reset-password?token=${token}`);
    }

    if (password !== confirmPassword) {
        req.session.message = { type: 'error', text: 'رمز عبور و تکرار آن مطابقت ندارند' };
        return res.redirect(`/reset-password?token=${token}`);
    }

    if (password.length < 6) {
        req.session.message = { type: 'error', text: 'رمز عبور باید حداقل ۶ کاراکتر باشد' };
        return res.redirect(`/reset-password?token=${token}`);
    }

    const db = getDbConnection();
    db.get('SELECT * FROM password_reset_tokens WHERE token = ? AND used = 0 AND expires_at > datetime("now")',
        [hashResetToken(token)], (err, resetToken) => {
            if (err || !resetToken) {
                db.close();
                req.session.message = { type: 'error', text: 'توکن بازیابی منقضی شده یا نامعتبر است' };
                return res.redirect('/forgot-password');
            }

            bcrypt.hash(password, BCRYPT_SALT_ROUNDS, (hashErr, hashedPassword) => {
                if (hashErr) {
                    db.close();
                    req.session.message = { type: 'error', text: 'خطا در به‌روزرسانی رمز عبور' };
                    return res.redirect(`/reset-password?token=${token}`);
                }

                db.run('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, resetToken.user_id], (err) => {
                    if (err) {
                        db.close();
                        req.session.message = { type: 'error', text: 'خطا در به‌روزرسانی رمز عبور' };
                        return res.redirect(`/reset-password?token=${token}`);
                    }

                    db.run('UPDATE password_reset_tokens SET used = 1 WHERE id = ?', [resetToken.id], (err) => {
                        db.close();
                        // M6: password changed — destroy every other server-side session
                        // for this account (stolen/hijacked sessions must die with it).
                        purgeUserSessions(req.sessionStore, resetToken.user_id, keepSidFor(req, resetToken.user_id), () => {
                            req.session.message = { type: 'success', text: 'رمز عبور شما با موفقیت تغییر کرد. لطفاً وارد شوید.' };
                            res.redirect('/login');
                        });
                    });
                });
            });
        });
}

// Quotation Request Submission (Public endpoint)
function submitQuotationRequest(req, res) {
    const { customer_name, company_name, email, phone, province, cement_type, quantity, delivery_address, message } = req.body;

    if (!customer_name || !phone || !province || !cement_type || !quantity || !delivery_address) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const db = getDbConnection();

    // Find worker assigned to the selected province
    db.all('SELECT id, username, full_name FROM users WHERE role = "worker" AND assigned_province = ?', [province], (err, workers) => {
        if (err) {
            db.close();
            return res.status(500).json({ error: 'Database error' });
        }

        let assignedWorker = null;
        let assignedWorkerUsername = null;
        let sourceType = 'direct_customer';
        let status = 'pending';

        if (workers.length === 1) {
            // Exactly one worker found - assign to them
            assignedWorker = workers[0].full_name || workers[0].username;
            assignedWorkerUsername = workers[0].username;
            status = 'assigned_to_worker';
        } else if (workers.length > 1) {
            // Multiple workers found - this is an error condition
            db.close();
            return res.status(500).json({ 
                error: 'Multiple workers assigned to this province. Please contact administration to resolve this configuration.' 
            });
        } else {
            // No workers found - assign to Admin
            sourceType = 'direct_customer_no_worker';
            status = 'pending_admin_review';
        }

        // Generate unique request ID
        const timestamp = Date.now();
        const requestId = `QT-${timestamp}`;

        db.run(`
            INSERT INTO quotation_requests (
                request_id, customer_name, company_name, phone, email, 
                delivery_address, province, cement_type, quantity, message,
                status, assigned_worker, assigned_worker_username, source_type
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            requestId, customer_name, company_name, phone, email,
            delivery_address, province, cement_type, quantity, message,
            status, assignedWorker, assignedWorkerUsername, sourceType
        ], function(err) {
            if (err) {
                db.close();
                return res.status(500).json({ error: 'Failed to save quotation request' });
            }

            const quotationRequestId = this.lastID;
            
            // Create admin notification for quotation request received (Event 10)
            const notificationMessage = `مشتری ${customer_name} برای سمنت ${cement_type} به مقدار ${quantity} تن درخواست قیمت کرده است`;
            
            db.run(`
                INSERT INTO admin_notifications (type, message, related_record_id, related_record_type, recipient, is_read, created_at)
                VALUES (?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
            `, ['quotation_request_received', notificationMessage, quotationRequestId, 'quotation_request', 'admin'], (notifErr) => {
                if (notifErr) {
                    console.error('Error creating notification:', notifErr);
                }
                db.close();

                // Return appropriate success message based on routing
                let successMessage = '';
                if (assignedWorker) {
                    successMessage = 'درخواست شما با موفقیت ثبت شد و برای نمایندگی مربوطه ارسال گردید.';
                } else {
                    successMessage = 'درخواست شما با موفقیت ثبت شد و برای بررسی به اداره مرکزی ارسال گردید.';
                }

                res.json({ 
                    success: true, 
                    message: successMessage,
                    request_id: requestId,
                    assigned_to_worker: !!assignedWorker
                });
            });
        });
    });
}

module.exports = {
    login,
    logout,
    customerHome,
    customerProducts,
    customerAbout,
    customerQuote,
    loginPortalView,
    customerCatalogView,
    forgotPassword,
    forgotPasswordSubmit,
    resetPassword,
    resetPasswordSubmit,
    submitQuotationRequest
};
