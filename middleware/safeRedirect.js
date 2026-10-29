'use strict';

// L-finding: `res.redirect('back')` trusts the Referer header. An attacker who
// controls the Referer (crafted link / cross-origin form post) can bounce users
// to an arbitrary external site after a state-changing action — a phishing /
// open-redirect vector. Only same-origin paths are honored; anything else falls
// back to a fixed in-app location.

function redirectBack(req, res, fallbackPath) {
    const ref = req.headers.referer || req.headers.referrer;
    if (typeof ref === 'string' && ref.length < 2048) {
        try {
            // Resolve against a fixed local base: relative refs resolve to the
            // base host; absolute URLs keep their own host. Honor only when the
            // ref is relative (base host) or points at this request's own host —
            // foreign hosts fall back. res.redirect() gets a path only, so even
            // a spoofed Host cannot produce an external redirect.
            const u = new URL(ref, 'http://local.invalid');
            const sameOrigin = u.host === 'local.invalid' ||
                (!!req.headers.host && u.host === req.headers.host);
            if (sameOrigin) {
                const p = u.pathname + u.search;
                if (p.startsWith('/') && !p.startsWith('//') && !p.startsWith('/\\')) {
                    return res.redirect(p);
                }
            }
        } catch (e) { /* malformed Referer -> fallback */ }
    }
    return res.redirect(fallbackPath);
}

module.exports = { redirectBack };
