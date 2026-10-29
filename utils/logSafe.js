'use strict';
// M3: URL/params logging must never print credential-bearing values.
// Any query parameter whose NAME looks sensitive is replaced with REDACTED
// before the URL is written to server logs.
const SENSITIVE = /token|key|code|password|passwd|secret|pwd|session|auth/i;

function redactQuery(qs) {
    if (!qs) return '';
    return qs.split('&').map((pair) => {
        const eq = pair.indexOf('=');
        if (eq === -1) return pair;
        const name = pair.slice(0, eq);
        return SENSITIVE.test(name) ? name + '=REDACTED' : pair;
    }).join('&');
}

// Safe-for-logs rendering of req.originalUrl / req.url (path kept, sensitive
// query values redacted).
function safeUrl(req) {
    const raw = String((req && (req.originalUrl || req.url)) || '').split('?');
    const pathPart = raw[0];
    const qs = raw[1] || '';
    if (!qs) return pathPart;
    return pathPart + '?' + redactQuery(qs);
}

module.exports = { safeUrl, redactQuery, SENSITIVE };
