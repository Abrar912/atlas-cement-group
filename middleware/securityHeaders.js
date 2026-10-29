'use strict';

// M4 — baseline security headers for every response.
// CSP is intentionally NOT set globally: the EJS views contain large inline
// <script>/<style> blocks, so a strict CSP would break every page unless the
// views are reworked nonce-by-nonce. That is documented as deferred work in
// SECURITY_REMEDIATION_REPORT.md rather than shipping a header that would
// either be ignored or break the ERP.

function securityHeaders(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    // HSTS only when cookies are secure (COOKIE_SECURE=true / NODE_ENV=production):
    // sending HSTS over plain-HTTP localhost would poison browser trust for dev.
    if (process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production') {
        res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    }
    next();
}

module.exports = securityHeaders;
