const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

function deriveRecoveryKeyMaterial(input) {
    if (input === undefined || input === null || String(input).trim() === '') {
        return null;
    }
    return crypto.createHash('sha256').update(String(input), 'utf8').digest().slice(0, 32);
}

const PRIMARY_KEY = deriveRecoveryKeyMaterial(process.env.RECOVERY_ENCRYPTION_KEY);

const STRICT_BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isValidStrictBase64(value) {
    if (typeof value !== 'string' || value.length === 0) {
        return false;
    }
    if (value.length % 4 !== 0) {
        return false;
    }
    return STRICT_BASE64_PATTERN.test(value);
}

class RecoveryDecryptError extends Error {
    constructor(code) {
        super('Recovery decryption failed');
        this.name = 'RecoveryDecryptError';
        this.code = code;
    }
}

// Node v22.23.2 probe: GCM wrong-key / bad-tag / corrupt-ct failures surface as
// Error with message exactly "Unsupported state or unable to authenticate data"
// and no err.code. Parameter errors (e.g. ERR_CRYPTO_INVALID_KEYLEN) are RangeError
// or carry err.code — those are treated as malformed input, not auth failure.
function isAuthFailure(err) {
    if (!err || err.name !== 'Error') {
        return false;
    }
    if (err.code) {
        return false;
    }
    return err.message === 'Unsupported state or unable to authenticate data';
}

function aesGcmDecrypt(key, iv, authTag, ciphertext) {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(ciphertext);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString('utf8');
}

/**
 * Encrypt a plaintext recovery key using AES-256-GCM (PRIMARY key only)
 * @param {string} plaintext - The plaintext key to encrypt
 * @returns {string} Base64-encoded encrypted data with IV and auth tag
 */
function encryptRecoveryKey(plaintext) {
    if (!PRIMARY_KEY) {
        throw new Error('Recovery encryption key not configured');
    }
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', PRIMARY_KEY, iv);

    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    // Combine IV + authTag + encrypted data
    const combined = Buffer.concat([iv, authTag, Buffer.from(encrypted, 'hex')]);
    return combined.toString('base64');
}

/**
 * Decrypt an encrypted recovery key (PRIMARY key only)
 * @param {string} encryptedBase64 - Base64-encoded encrypted data
 * @returns {string} The plaintext recovery key
 */
function decryptRecoveryKey(encryptedBase64) {
    if (!isValidStrictBase64(encryptedBase64)) {
        throw new RecoveryDecryptError('MALFORMED');
    }

    const combined = Buffer.from(encryptedBase64, 'base64');
    if (combined.length <= 32) {
        throw new RecoveryDecryptError('MALFORMED');
    }

    const iv = combined.slice(0, 16);
    const authTag = combined.slice(16, 32);
    const encrypted = combined.slice(32);
    if (authTag.length !== 16 || encrypted.length < 1) {
        throw new RecoveryDecryptError('MALFORMED');
    }

    if (!PRIMARY_KEY) {
        throw new Error('Recovery encryption key not configured');
    }

    try {
        return aesGcmDecrypt(PRIMARY_KEY, iv, authTag, encrypted);
    } catch (primaryErr) {
        if (!isAuthFailure(primaryErr)) {
            throw new RecoveryDecryptError('MALFORMED');
        }
        throw new RecoveryDecryptError('AUTH_FAILED');
    }
}

/**
 * Generate a cryptographically secure recovery key for users
 * Format: XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX (32 hex chars, 8 groups of 4)
 * @returns {string} The plaintext recovery key
 */
function generateUserRecoveryKey() {
    // Generate 16 random bytes (128 bits of entropy)
    const randomBytes = crypto.randomBytes(16);
    // Convert to hex and format with dashes
    const hex = randomBytes.toString('hex').toUpperCase();
    return hex.match(/.{1,4}/g).join('-');
}

/**
 * Generate a cryptographically secure recovery code for admins
 * Format: XXXX-XXXX-XXXX-XXXX (16 hex chars, 4 groups of 4)
 * @returns {string} The plaintext recovery code
 */
function generateAdminRecoveryCode() {
    // Generate 8 random bytes (64 bits of entropy)
    const randomBytes = crypto.randomBytes(8);
    // Convert to hex and format with dashes
    const hex = randomBytes.toString('hex').toUpperCase();
    return hex.match(/.{1,4}/g).join('-');
}

/**
 * Hash a recovery key/code using SHA-256 with salt
 * @param {string} key - The plaintext key/code
 * @param {string} salt - Optional salt (if not provided, generates one)
 * @returns {object} Object containing hash and salt
 */
function hashRecoveryKey(key, salt = null) {
    if (!salt) {
        salt = crypto.randomBytes(16).toString('hex');
    }
    const hash = crypto.pbkdf2Sync(key, salt, 100000, 64, 'sha512').toString('hex');
    return { hash, salt };
}

/**
 * Verify a recovery key against a stored hash
 * @param {string} key - The plaintext key to verify
 * @param {string} storedHash - The stored hash
 * @param {string} salt - The salt used for hashing
 * @returns {boolean} True if the key matches
 */
function verifyRecoveryKey(key, storedHash, salt) {
    const { hash } = hashRecoveryKey(key, salt);
    return hash === storedHash;
}

/**
 * Generate a unique batch ID for admin recovery codes
 * @returns {string} Batch ID
 */
function generateBatchId() {
    return `BATCH-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

/**
 * Generate a unique request ID for password recovery requests
 * @returns {string} Request ID
 */
function generateRequestId() {
    return `REQ-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

/**
 * Generate a secure token for password reset authorization
 * @returns {string} The plaintext token
 */
function generateResetToken() {
    return crypto.randomBytes(32).toString('hex');
}

/**
 * Hash a reset token
 * @param {string} token - The plaintext token
 * @returns {string} The hashed token
 */
function hashResetToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Verify a reset token against a stored hash
 * @param {string} token - The plaintext token to verify
 * @param {string} storedHash - The stored hash
 * @returns {boolean} True if the token matches
 */
function verifyResetToken(token, storedHash) {
    const hash = hashResetToken(token);
    return hash === storedHash;
}

/**
 * Generate PDF for user recovery key
 * @param {object} data - Data for the PDF
 * @param {string} outputPath - Path to save the PDF
 * @returns {Promise<void>}
 */
async function generateUserRecoveryPDF(data, outputPath) {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ margin: 50, size: 'A4' });
            const stream = fs.createWriteStream(outputPath);
            
            doc.pipe(stream);

            // Header
            doc.fontSize(24).font('Helvetica-Bold').text('ACCOUNT RECOVERY INFORMATION', { align: 'center' });
            doc.moveDown();
            
            // Company name
            doc.fontSize(14).font('Helvetica').text('Atlas Cement Group ERP', { align: 'center' });
            doc.moveDown();
            
            // Separator line
            doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
            doc.moveDown();

            // Account information
            doc.fontSize(12).font('Helvetica-Bold').text('Account Information:', { continued: false });
            doc.fontSize(11).font('Helvetica').text(`Username: ${data.username}`);
            if (data.fullName) doc.text(`Full Name: ${data.fullName}`);
            if (data.userId) doc.text(`User ID: ${data.userId}`);
            doc.text(`Account Type: ${data.accountType || 'User'}`);
            if (data.province) doc.text(`Province: ${data.province}`);
            doc.moveDown();

            // Recovery key
            doc.fontSize(12).font('Helvetica-Bold').text('Recovery Key:', { continued: false });
            doc.fontSize(16).font('Courier-Bold').fillColor('red').text(data.recoveryKey);
            doc.fillColor('black');
            doc.moveDown();

            // Important notice
            doc.fontSize(10).font('Helvetica-Bold').text('Important:', { continued: false });
            doc.fontSize(9).font('Helvetica').text('Keep this recovery key in a secure location.');
            doc.text('Anyone who has this key may be able to recover your account.');
            doc.text('This key can only be used once.');
            doc.moveDown();

            // Metadata
            doc.fontSize(10).font('Helvetica').text(`Generated: ${new Date().toLocaleDateString()}`);
            doc.text(`Status: ${data.status || 'Active'}`);
            
            doc.end();

            stream.on('finish', resolve);
            stream.on('error', reject);
        } catch (error) {
            reject(error);
        }
    });
}

/**
 * Generate PDF for admin recovery codes
 * @param {object} data - Data for the PDF
 * @param {string} outputPath - Path to save the PDF
 * @returns {Promise<void>}
 */
async function generateAdminRecoveryPDF(data, outputPath) {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ margin: 50, size: 'A4' });
            const stream = fs.createWriteStream(outputPath);
            
            doc.pipe(stream);

            // Header
            doc.fontSize(24).font('Helvetica-Bold').text('ADMINISTRATOR RECOVERY CODES', { align: 'center' });
            doc.moveDown();
            
            // Company name
            doc.fontSize(14).font('Helvetica').text('Atlas Cement Group ERP', { align: 'center' });
            doc.moveDown();
            
            // Separator line
            doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
            doc.moveDown();

            // Account information
            doc.fontSize(12).font('Helvetica-Bold').text('Account Information:', { continued: false });
            doc.fontSize(11).font('Helvetica').text(`Username: ${data.username}`);
            if (data.fullName) doc.text(`Full Name: ${data.fullName}`);
            if (data.userId) doc.text(`User ID: ${data.userId}`);
            doc.text(`Account Type: ${data.accountType || 'Administrator'}`);
            if (data.province) doc.text(`Province: ${data.province}`);
            doc.moveDown();

            // Recovery codes
            doc.fontSize(12).font('Helvetica-Bold').text('Recovery Codes:', { continued: false });
            doc.moveDown();
            
            data.codes.forEach((code, index) => {
                const codeNum = String(index + 1).padStart(2, '0');
                doc.fontSize(10).font('Helvetica-Bold').text(`Recovery Code ${codeNum}:`, { continued: true });
                doc.fontSize(14).font('Courier-Bold').fillColor('red').text(` ${code}`);
                doc.fillColor('black');
                doc.moveDown(0.5);
            });

            // Important notice
            doc.fontSize(10).font('Helvetica-Bold').text('Important:', { continued: false });
            doc.fontSize(9).font('Helvetica').text('Keep these recovery codes in a secure location.');
            doc.text('Each code can only be used once.');
            doc.text('Anyone who has these codes may be able to recover your account.');
            doc.moveDown();

            // Metadata
            doc.fontSize(10).font('Helvetica').text(`Generated: ${new Date().toLocaleDateString()}`);
            if (data.batchId) doc.text(`Batch ID: ${data.batchId}`);
            doc.text(`Active Codes: ${data.activeCount || data.codes.length} / 10`);
            
            doc.end();

            stream.on('finish', resolve);
            stream.on('error', reject);
        } catch (error) {
            reject(error);
        }
    });
}

/**
 * Clean up old PDF files
 * @param {string} directory - Directory to clean
 * @param {number} maxAge - Maximum age in milliseconds (default: 1 hour)
 */
function cleanupOldPDFs(directory, maxAge = 3600000) {
    try {
        const files = fs.readdirSync(directory);
        const now = Date.now();
        
        files.forEach(file => {
            if (file.endsWith('.pdf')) {
                const filePath = path.join(directory, file);
                const stats = fs.statSync(filePath);
                
                if (now - stats.mtimeMs > maxAge) {
                    fs.unlinkSync(filePath);
                    console.log(`Cleaned up old PDF: ${file}`);
                }
            }
        });
    } catch (error) {
        console.error('Error cleaning up PDFs:', error);
    }
}

module.exports = {
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
};
