'use strict';

// In-memory rate limiter (single-process deployment).
// Restart clears counters — documented limitation for Batch 1.

const store = new Map();
const SWEEP_INTERVAL_MS = 60 * 1000;

function sweep() {
    const now = Date.now();
    for (const [key, record] of store) {
        if (record.resetTime <= now) {
            store.delete(key);
        }
    }
}

if (typeof setInterval === 'function') {
    setInterval(sweep, SWEEP_INTERVAL_MS).unref?.();
}

function checkLimit(key, maxAttempts, windowMs) {
    const now = Date.now();
    const record = store.get(key);
    if (!record || now > record.resetTime) {
        return { allowed: true, attempts: 0, remaining: maxAttempts };
    }
    if (record.attempts >= maxAttempts) {
        return {
            allowed: false,
            attempts: record.attempts,
            remaining: 0,
            retryAfterMs: record.resetTime - now
        };
    }
    return {
        allowed: true,
        attempts: record.attempts,
        remaining: maxAttempts - record.attempts
    };
}

function hitLimit(key, maxAttempts, windowMs) {
    const now = Date.now();
    const record = store.get(key);
    if (!record || now > record.resetTime) {
        store.set(key, { attempts: 1, resetTime: now + windowMs });
        return { allowed: true, attempts: 1 };
    }
    if (record.attempts >= maxAttempts) {
        return {
            allowed: false,
            attempts: record.attempts,
            retryAfterMs: record.resetTime - now
        };
    }
    record.attempts += 1;
    return { allowed: true, attempts: record.attempts };
}

function clearLimit(key) {
    store.delete(key);
}

function getClientIp(req) {
    return req.ip || req.connection?.remoteAddress || 'unknown';
}

function sendTooMany(req, res) {
    const wantsJson = (req.get('accept') || '').indexOf('application/json') !== -1 ||
        (req.path && req.path.indexOf('/api/') === 0);
    if (wantsJson) {
        return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }
    if (typeof res.redirect === 'function' && req.session && req.session.message !== undefined) {
        // Prefer existing flash pattern for auth pages when session exists.
        try {
            req.session.message = {
                type: 'error',
                text: (res.locals && res.locals.t && res.locals.t('recovery.too_many_attempts'))
                    || 'Too many attempts. Please try again later.'
            };
        } catch (e) {
            // ignore i18n failures
        }
    }
    res.status(429);
    if (typeof res.render === 'function' && !wantsJson) {
        // Fall through to simple text for non-form contexts; forms use redirect path in controllers.
        return res.send('Too many requests. Please try again later.');
    }
    return res.send('Too many requests. Please try again later.');
}

/**
 * Express middleware factory.
 * options: { keyPrefix, max, windowMs, keyFn(req) => string[] or string }
 * Blocks (429) when any key is over limit; does not increment here unless increment:true.
 */
function rateLimit(options) {
    const opts = options || {};
    const max = opts.max || 10;
    const windowMs = opts.windowMs || 15 * 60 * 1000;
    const prefix = opts.keyPrefix || 'rl';
    const keyFn = opts.keyFn || ((req) => [getClientIp(req)]);

    return function rateLimitMiddleware(req, res, next) {
        if (SAFE_METHODS.has(req.method)) {
            return next();
        }
        const rawKeys = keyFn(req);
        const keys = (Array.isArray(rawKeys) ? rawKeys : [rawKeys])
            .filter(Boolean)
            .map(k => prefix + ':' + k);

        for (const key of keys) {
            const result = checkLimit(key, max, windowMs);
            if (!result.allowed) {
                return sendTooMany(req, res);
            }
        }

        if (opts.increment !== false) {
            for (const key of keys) {
                hitLimit(key, max, windowMs);
            }
        }

        req.rateLimitKeys = keys;
        req.rateLimitMax = max;
        req.rateLimitWindowMs = windowMs;
        next();
    };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const DEFAULTS = {
    loginFailUser: { max: 10, windowMs: 15 * 60 * 1000 },
    loginIp: { max: 30, windowMs: 15 * 60 * 1000 },
    forgotUser: { max: 5, windowMs: 15 * 60 * 1000 },
    forgotIp: { max: 15, windowMs: 15 * 60 * 1000 },
    resetIp: { max: 10, windowMs: 15 * 60 * 1000 },
    recoveryResetIp: { max: 10, windowMs: 15 * 60 * 1000 }
};

function loginKeys(req) {
    const ip = getClientIp(req);
    const username = String((req.body && req.body.username) || '').trim().toLowerCase();
    const keys = ['ip:' + ip];
    if (username) {
        keys.push('fail:' + username + '|' + ip);
    }
    return keys;
}

function forgotKeys(req) {
    const ip = getClientIp(req);
    const username = String((req.body && req.body.username) || '').trim().toLowerCase();
    const keys = ['ip:' + ip];
    if (username) {
        keys.push('user:' + username + '|' + ip);
    }
    return keys;
}

function ipKey(req) {
    return ['ip:' + getClientIp(req)];
}

function makeMiddleware(keyPrefix, conf, keyFn, increment) {
    return rateLimit({
        keyPrefix,
        max: conf.max,
        windowMs: conf.windowMs,
        keyFn,
        increment: increment !== false
    });
}

// Login: check only (increments handled carefully around success/failure in controller via helpers)
function loginPreCheck(req, res, next) {
    if (SAFE_METHODS.has(req.method)) return next();
    const ip = getClientIp(req);
    const username = String((req.body && req.body.username) || '').trim().toLowerCase();
    const ipKeyFull = 'login:ip:' + ip;
    const userKey = username ? 'login:fail:' + username + '|' + ip : null;

    const ipCheck = checkLimit(ipKeyFull, DEFAULTS.loginIp.max, DEFAULTS.loginIp.windowMs);
    if (!ipCheck.allowed) return sendTooMany(req, res);
    if (userKey) {
        const userCheck = checkLimit(userKey, DEFAULTS.loginFailUser.max, DEFAULTS.loginFailUser.windowMs);
        if (!userCheck.allowed) return sendTooMany(req, res);
    }
    next();
}

function registerLoginFailure(req) {
    const ip = getClientIp(req);
    const username = String((req.body && req.body.username) || '').trim().toLowerCase();
    hitLimit('login:ip:' + ip, DEFAULTS.loginIp.max, DEFAULTS.loginIp.windowMs);
    if (username) {
        hitLimit('login:fail:' + username + '|' + ip, DEFAULTS.loginFailUser.max, DEFAULTS.loginFailUser.windowMs);
    }
}

function clearLoginFailures(req) {
    const ip = getClientIp(req);
    const username = String((req.body && req.body.username) || '').trim().toLowerCase();
    if (username) {
        clearLimit('login:fail:' + username + '|' + ip);
    }
}

const forgotPreCheck = makeMiddleware('forgot', DEFAULTS.forgotIp, (req) => {
    // check both user and ip: custom middleware for dual-key
    return null;
}, false);

function forgotLimit(req, res, next) {
    if (SAFE_METHODS.has(req.method)) return next();
    const ip = getClientIp(req);
    const username = String((req.body && req.body.username) || '').trim().toLowerCase();
    const ipKeyFull = 'forgot:ip:' + ip;
    const userKey = username ? 'forgot:user:' + username + '|' + ip : null;

    if (!checkLimit(ipKeyFull, DEFAULTS.forgotIp.max, DEFAULTS.forgotIp.windowMs).allowed) {
        return sendTooMany(req, res);
    }
    if (userKey && !checkLimit(userKey, DEFAULTS.forgotUser.max, DEFAULTS.forgotUser.windowMs).allowed) {
        return sendTooMany(req, res);
    }
    hitLimit(ipKeyFull, DEFAULTS.forgotIp.max, DEFAULTS.forgotIp.windowMs);
    if (userKey) hitLimit(userKey, DEFAULTS.forgotUser.max, DEFAULTS.forgotUser.windowMs);
    next();
}

const resetLimit = makeMiddleware('reset', DEFAULTS.resetIp, ipKey, true);
const recoveryResetLimit = makeMiddleware('recovery-reset', DEFAULTS.recoveryResetIp, ipKey, true);
// Public quote form (CSRF-exempt by design): IP cap turns abuse into 429s.
const quotationLimit = makeMiddleware('quotation', { max: 10, windowMs: 10 * 60 * 1000 }, ipKey, true);
// Recovery key/code verification: brute-force guard per IP (per-username caps
// live inside the controllers).
const recoveryVerifyLimit = makeMiddleware('recovery-verify', { max: 15, windowMs: 15 * 60 * 1000 }, ipKey, true);
// Recovery PDF downloads: generous cap that still stops URL-guessing crawls.
const pdfDownloadLimit = makeMiddleware('pdf-dl', { max: 30, windowMs: 5 * 60 * 1000 }, ipKey, true);

module.exports = {
    store,
    checkLimit,
    hitLimit,
    clearLimit,
    getClientIp,
    rateLimit,
    loginPreCheck,
    registerLoginFailure,
    clearLoginFailures,
    forgotLimit,
    resetLimit,
    recoveryResetLimit,
    quotationLimit,
    recoveryVerifyLimit,
    pdfDownloadLimit,
    DEFAULTS
};
