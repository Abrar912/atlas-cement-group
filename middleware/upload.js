const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDbConnection } = require('../config/database');
const { redirectBack } = require('../middleware/safeRedirect');

// Ensure uploads directory exists
const uploadDir = path.join(__dirname, '..', 'public', 'uploads', 'profiles');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Ensure homepage uploads directory exists
const homepageUploadDir = path.join(__dirname, '..', 'public', 'uploads', 'homepage');
if (!fs.existsSync(homepageUploadDir)) {
    fs.mkdirSync(homepageUploadDir, { recursive: true });
}

// Ensure employee photos directory exists
const employeePhotoDir = path.join(__dirname, '..', 'public', 'uploads', 'employees');
if (!fs.existsSync(employeePhotoDir)) {
    fs.mkdirSync(employeePhotoDir, { recursive: true });
}

// Ensure employee documents directory exists (private — NOT inside public/)
const employeeDocumentsDir = path.join(__dirname, '..', 'storage', 'employee-documents');
if (!fs.existsSync(employeeDocumentsDir)) {
    fs.mkdirSync(employeeDocumentsDir, { recursive: true });
}

// Configure multer storage for profile pictures
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        // Generate unique filename: timestamp + original extension
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, 'profile-' + uniqueSuffix + ext);
    }
});

// Configure multer storage for homepage media
const homepageStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, homepageUploadDir);
    },
    filename: function (req, file, cb) {
        // Generate unique filename: timestamp + original extension
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, 'homepage-' + uniqueSuffix + ext);
    }
});

// Configure multer storage for employee documents (PDF only)
const employeeDocumentStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, employeeDocumentsDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'employee-document-' + uniqueSuffix + '.pdf');
    }
});

// File filter to accept only PDF files with magic byte validation
const pdfFileFilter = (req, file, cb) => {
    const extname = path.extname(file.originalname).toLowerCase();
    const mimetype = file.mimetype === 'application/pdf';

    if (extname !== '.pdf' || !mimetype) {
        return cb(Object.assign(new Error('Only PDF files are allowed for employee documents.'), { safe: true }));
    }
    cb(null, true);
};

// PDF magic byte validation helper
const validatePdfMagicBytes = (filePath) => {
    return new Promise((resolve, reject) => {
        const buffer = Buffer.alloc(5);
        fs.open(filePath, 'r', (err, fd) => {
            if (err) return reject(err);
            fs.read(fd, buffer, 0, 5, 0, (err2) => {
                fs.close(fd, () => {});
                if (err2) return reject(err2);
                const header = buffer.toString('ascii', 0, 5);
                if (header !== '%PDF-') {
                    return reject(Object.assign(new Error('missing PDF magic bytes.'), { safe: true }));
                }
                resolve(true);
            });
        });
    });
};

// Configure multer with limits for employee documents
const employeeDocumentUpload = multer({
    storage: employeeDocumentStorage,
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB limit
    },
    fileFilter: pdfFileFilter
});

// Configure multer storage for employee photos
const employeePhotoStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, employeePhotoDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, 'emp-' + uniqueSuffix + ext);
    }
});

// File filter to accept only images
const fileFilter = (req, file, cb) => {
    // L3: the extension must be EXACTLY one of the allowed image extensions —
    // the previous unanchored regex also matched "jpg" inside "evil.htmljpg".
    const allowedExt = /^\.(jpe?g|png|webp)$/;
    const allowedTypes = /jpeg|jpg|png|webp/;
    const extname = allowedExt.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);

    if (extname && mimetype) {
        return cb(null, true);
    } else {
        cb(Object.assign(new Error('فقط فایل‌های تصویری (JPG, PNG, WebP) مجاز هستند.'), { safe: true }));
    }
};

// Configure multer with limits for profile pictures
const upload = multer({
    storage: storage,
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB limit
    },
    fileFilter: fileFilter
});

// Configure multer with limits for homepage media
const homepageUpload = multer({
    storage: homepageStorage,
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB limit
    },
    fileFilter: fileFilter
});

// Configure multer with limits for employee photos
const employeePhotoUpload = multer({
    storage: employeePhotoStorage,
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB limit
    },
    fileFilter: fileFilter
});

// Combined multer instance for Add Employee (photo + documents in one stream)
const employeeAddCombinedStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        if (file.fieldname === 'employee_photo') {
            cb(null, employeePhotoDir);
        } else {
            cb(null, employeeDocumentsDir);
        }
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        if (file.fieldname === 'employee_photo') {
            const ext = path.extname(file.originalname);
            cb(null, 'emp-' + uniqueSuffix + ext);
        } else {
            cb(null, 'employee-document-' + uniqueSuffix + '.pdf');
        }
    }
});

const employeeAddCombinedUpload = multer({
    storage: employeeAddCombinedStorage,
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB limit (covers both photo and documents)
    },
    fileFilter: function (req, file, cb) {
        if (file.fieldname === 'employee_photo') {
            // L3: anchored extension check (same rule as fileFilter above)
            const allowedExt = /^\.(jpe?g|png|webp)$/;
            const allowedTypes = /jpeg|jpg|png|webp/;
            const extname = allowedExt.test(path.extname(file.originalname).toLowerCase());
            const mimetype = allowedTypes.test(file.mimetype);
            if (extname && mimetype) return cb(null, true);
            return cb(Object.assign(new Error('Only image files (JPG, PNG, WebP) are allowed for photos.'), { safe: true }));
        }
        // Document fields - PDF only
        const extname = path.extname(file.originalname).toLowerCase() === '.pdf';
        const mimetype = file.mimetype === 'application/pdf';
        if (extname && mimetype) return cb(null, true);
        return cb(Object.assign(new Error('Only PDF files are allowed for documents.'), { safe: true }));
    }
});

// Middleware for single profile picture upload with error handling
const uploadProfilePicture = (req, res, next) => {
    upload.single('profile_upload')(req, res, function (err) {
        if (err instanceof multer.MulterError) {
            // Multer error (file size limit, etc.)
            if (err.code === 'LIMIT_FILE_SIZE') {
                const db = getDbConnection();
                db.all('SELECT id, username, role, assigned_province, email, profile_picture, permissions FROM users ORDER BY id ASC', (err, users) => {
                    db.close();
                    if (err) {
                        return res.status(500).send('Database error');
                    }
                    return res.render('admin/manage-users', {
                        users: users,
                        error: 'حجم عکس بسیار بزرگ است. لطفاً عکس کوچک‌تر از ۵ مگابایت انتخاب کنید.',
                        session: req.session
                    });
                });
                return;
            }
            const db = getDbConnection();
            db.all('SELECT id, username, role, assigned_province, email, profile_picture, permissions FROM users ORDER BY id ASC', (err, users) => {
                db.close();
                if (err) {
                    return res.status(500).send('Database error');
                }
                return res.render('admin/manage-users', {
                    users: users,
                    error: err && err.safe ? err.message : 'خطا در آپلود عکس',
                    session: req.session
                });
            });
            return;
        } else if (err) {
            // Other errors
            const db = getDbConnection();
            db.all('SELECT id, username, role, assigned_province, email, profile_picture, permissions FROM users ORDER BY id ASC', (err, users) => {
                db.close();
                if (err) {
                    return res.status(500).send('Database error');
                }
                return res.render('admin/manage-users', {
                    users: users,
                    error: err && err.safe ? err.message : 'خطا در آپلود عکس',
                    session: req.session
                });
            });
            return;
        }
        // No error, continue
        next();
    });
};

// Middleware for single homepage media upload with error handling
const uploadHomepageMedia = (req, res, next) => {
    homepageUpload.single('homepage_media')(req, res, function (err) {
        if (err instanceof multer.MulterError) {
            // Multer error (file size limit, etc.)
            if (err.code === 'LIMIT_FILE_SIZE') {
                req.session.message = { type: 'error', text: 'حجم عکس بسیار بزرگ است. لطفاً عکس کوچک‌تر از ۵ مگابایت انتخاب کنید.' };
                return res.redirect('/admin/homepage-control');
            }
            req.session.message = { type: 'error', text: 'خطا در آپلود عکس' };
            return res.redirect('/admin/homepage-control');
        } else if (err) {
            // Other errors
            req.session.message = { type: 'error', text: err && err.safe ? err.message : 'خطا در پردازش فایل. لطفاً دوباره تلاش کنید.' };
            return res.redirect('/admin/homepage-control');
        }
        // No error, continue
        next();
    });
};

// Middleware for single employee photo upload with error handling
const uploadEmployeePhoto = (req, res, next) => {
    employeePhotoUpload.single('employee_photo')(req, res, function (err) {
        if (err instanceof multer.MulterError) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                req.session.message = { type: 'error', text: 'Photo is too large. Please select a photo smaller than 5MB.' };
                const employeeId = req.params.id;
                if (employeeId) {
                    return res.redirect(`/admin/hr/employees/${employeeId}/edit`);
                }
                return res.redirect('/admin/hr/employees/add');
            }
            req.session.message = { type: 'error', text: 'Photo upload error' };
            const employeeId = req.params.id;
            if (employeeId) {
                return res.redirect(`/admin/hr/employees/${employeeId}/edit`);
            }
            return res.redirect('/admin/hr/employees/add');
        } else if (err) {
            req.session.message = { type: 'error', text: err && err.safe ? err.message : 'خطا در پردازش فایل. لطفاً دوباره تلاش کنید.' };
            const employeeId = req.params.id;
            if (employeeId) {
                return res.redirect(`/admin/hr/employees/${employeeId}/edit`);
            }
            return res.redirect('/admin/hr/employees/add');
        }
        next();
    });
};

// Middleware for single employee document upload with error handling
const uploadEmployeeDocument = (req, res, next) => {
    employeeDocumentUpload.single('file')(req, res, function (err) {
        if (err instanceof multer.MulterError) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                req.session.message = { type: 'error', text: 'Document file is too large. Maximum size is 10MB.' };
                return redirectBack(req, res, req.params.employeeId ? '/admin/hr/employees/' + req.params.employeeId : '/admin/hr/employees');
            }
            req.session.message = { type: 'error', text: 'Document upload error' };
            return redirectBack(req, res, req.params.employeeId ? '/admin/hr/employees/' + req.params.employeeId : '/admin/hr/employees');
        } else if (err) {
            req.session.message = { type: 'error', text: err && err.safe ? err.message : 'خطا در پردازش فایل. لطفاً دوباره تلاش کنید.' };
            return redirectBack(req, res, req.params.employeeId ? '/admin/hr/employees/' + req.params.employeeId : '/admin/hr/employees');
        }
        next();
    });
};

// Middleware for multiple employee document uploads (Add Employee flow)
const uploadEmployeeDocumentsMulti = (req, res, next) => {
    employeeDocumentUpload.fields([
        { name: 'document_tazkira_passport', maxCount: 1 },
        { name: 'document_cv', maxCount: 1 },
        { name: 'document_degrees_certificates', maxCount: 1 },
        { name: 'document_other', maxCount: 1 }
    ])(req, res, function (err) {
        if (err instanceof multer.MulterError) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                req.session.message = { type: 'error', text: 'One or more document files exceed the 10MB limit.' };
                return res.redirect('/admin/hr/employees/add');
            }
            req.session.message = { type: 'error', text: 'Document upload error' };
            return res.redirect('/admin/hr/employees/add');
        } else if (err) {
            req.session.message = { type: 'error', text: err && err.safe ? err.message : 'خطا در پردازش فایل. لطفاً دوباره تلاش کنید.' };
            return res.redirect('/admin/hr/employees/add');
        }
        next();
    });
};

// Combined middleware for Add Employee: photo + documents in single stream
const uploadEmployeeAddCombined = (req, res, next) => {
    employeeAddCombinedUpload.fields([
        { name: 'employee_photo', maxCount: 1 },
        { name: 'document_tazkira_passport', maxCount: 1 },
        { name: 'document_cv', maxCount: 1 },
        { name: 'document_degrees_certificates', maxCount: 1 },
        { name: 'document_other', maxCount: 1 }
    ])(req, res, function (err) {
        if (err instanceof multer.MulterError) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                req.session.message = { type: 'error', text: 'File is too large. Maximum size is 10MB.' };
                return res.redirect('/admin/hr/employees/add');
            }
            req.session.message = { type: 'error', text: 'Upload error' };
            return res.redirect('/admin/hr/employees/add');
        } else if (err) {
            req.session.message = { type: 'error', text: err && err.safe ? err.message : 'خطا در پردازش فایل. لطفاً دوباره تلاش کنید.' };
            return res.redirect('/admin/hr/employees/add');
        }
        next();
    });
};

module.exports = { uploadProfilePicture, uploadHomepageMedia, uploadEmployeePhoto, uploadEmployeeDocument, uploadEmployeeDocumentsMulti, uploadEmployeeAddCombined, validatePdfMagicBytes };
