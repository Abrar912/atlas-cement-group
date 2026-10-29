'use strict';

const crypto = require('crypto');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const TOKEN_BYTES = 32;

function ensureCsrfToken(req) {
    if (!req.session) {
        return null;
    }
    if (!req.session.csrfToken) {
        req.session.csrfToken = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
    }
    return req.session.csrfToken;
}

function timingSafeStringEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || b.length === 0) {
        return false;
    }
    const digestA = crypto.createHash('sha256').update(a, 'utf8').digest();
    const digestB = crypto.createHash('sha256').update(b, 'utf8').digest();
    return crypto.timingSafeEqual(digestA, digestB);
}

function isMultipart(req) {
    const contentType = req.get('content-type') || '';
    return contentType.toLowerCase().indexOf('multipart/form-data') !== -1;
}

function extractToken(req) {
    const headerToken = req.get('x-csrf-token');
    if (headerToken) {
        return { token: headerToken, source: 'header' };
    }
    if (req.body && typeof req.body._csrf === 'string' && req.body._csrf) {
        return { token: req.body._csrf, source: 'body' };
    }
    return { token: null, source: null };
}

function rejectCsrf(req, res) {
    const wantsJson = (req.get('accept') || '').indexOf('application/json') !== -1 ||
        (req.path && req.path.indexOf('/api/') === 0);
    if (wantsJson) {
        return res.status(403).json({ error: 'Invalid CSRF token' });
    }
    if (typeof res.render === 'function') {
        return res.status(403).render('403', {
            title: 'دسترسی ممنوع',
            message: 'درخواست نامعتبر است. لطفاً صفحه را تازه‌سازی کنید و دوباره تلاش کنید.'
        });
    }
    return res.status(403).send('Invalid CSRF token');
}

function issueCsrfToken(req, res, next) {
    const token = ensureCsrfToken(req);
    res.locals.csrfToken = token || '';
    next();
}

function verifyCsrfToken(options) {
    const opts = options || {};
    const deferMultipartBody = opts.deferMultipartBody !== false;
    // Endpoints that are anonymous BY DESIGN (public website forms with no
    // session privilege to protect, e.g. the quote request form). Forging a
    // submission there is spam, not privilege escalation — handled by rate
    // limiting, not by a session token the public page cannot meaningfully hold.
    const exemptPaths = new Set(opts.exemptPaths || []);

    return function csrfProtect(req, res, next) {
        if (SAFE_METHODS.has(req.method)) {
            return next();
        }
        if (exemptPaths.has(req.path)) {
            return next();
        }
        if (!req.session) {
            return rejectCsrf(req, res);
        }

        const expected = req.session.csrfToken;
        if (!expected) {
            return rejectCsrf(req, res);
        }

        const multipart = isMultipart(req);
        if (multipart && deferMultipartBody) {
            // Global middleware: never read multipart body fields (may be unparsed).
            // Header is optional here; route-level csrfProtect is authoritative after multer.
            const headerOnly = extractToken(req);
            if (headerOnly.source === 'header') {
                if (!timingSafeStringEqual(headerOnly.token, expected)) {
                    return rejectCsrf(req, res);
                }
                return next();
            }
            // No header: defer to route-level csrfProtect after multer parses body.
            return next();
        }

        const found = extractToken(req);
        if (!found.token || !timingSafeStringEqual(found.token, expected)) {
            return rejectCsrf(req, res);
        }
        return next();
    };
}

// Route-level authoritative check for multipart routes (multer already ran).
function csrfProtectRoute(req, res, next) {
    if (SAFE_METHODS.has(req.method)) {
        return next();
    }
    if (!req.session || !req.session.csrfToken) {
        return rejectCsrf(req, res);
    }
    const found = extractToken(req);
    if (!found.token || !timingSafeStringEqual(found.token, req.session.csrfToken)) {
        return rejectCsrf(req, res);
    }
    return next();
}

module.exports = {
    ensureCsrfToken,
    issueCsrfToken,
    verifyCsrfToken,
    csrfProtect: csrfProtectRoute,
    timingSafeStringEqual,
    isMultipart
};
