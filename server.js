require('dotenv').config();

const crypto = require('crypto');

// Comparison-only denylist: SHA-256 of prohibited historical fallback inputs.
// Never assigned to session signing or recovery key material. Never logged.
const PROHIBITED_SECRET_SHA256 = [
    Buffer.from('cb509b80108c826073f0cde736d7fe7f4cced136b7eb0152ba255685c33b920b', 'hex'),
    Buffer.from('48840e36ec4d426aa3d1a95c32c5c879f8f3e1c3eb17a5e801ac1e2382e9c0c5', 'hex')
];

function sha256Buffer(value) {
    return crypto.createHash('sha256').update(String(value), 'utf8').digest();
}

function isProhibitedSecret(value) {
    const digest = sha256Buffer(value);
    return PROHIBITED_SECRET_SHA256.some((entry) => {
        return entry.length === digest.length && crypto.timingSafeEqual(entry, digest);
    });
}

function assertSecrets() {
    const fail = (message) => {
        console.error(`FATAL: ${message}`);
        process.exit(1);
    };

    const requirePresent = (name, value) => {
        if (value === undefined || value === null || String(value).trim() === '') {
            fail(`${name} is missing or empty`);
        }
        if (String(value).length < 32) {
            fail(`${name} does not meet minimum length`);
        }
    };

    const sessionSecret = process.env.SESSION_SECRET;
    const recoveryEncryptionKey = process.env.RECOVERY_ENCRYPTION_KEY;

    requirePresent('SESSION_SECRET', sessionSecret);
    requirePresent('RECOVERY_ENCRYPTION_KEY', recoveryEncryptionKey);

    if (isProhibitedSecret(sessionSecret)) {
        fail('SESSION_SECRET uses a prohibited value');
    }
    if (isProhibitedSecret(recoveryEncryptionKey)) {
        fail('RECOVERY_ENCRYPTION_KEY uses a prohibited value');
    }

    if (String(sessionSecret) === String(recoveryEncryptionKey)) {
        fail('SESSION_SECRET and RECOVERY_ENCRYPTION_KEY must differ');
    }
}

assertSecrets();

// Verbose development diagnostics gate. Lines prefixed [DEBUG], [AUTH DEBUG],
// [SSE DEBUG] or [CEMENT ANALYTICS DEBUG] may include usernames, session IDs,
// SQL text and search filters, so they print only when DEBUG_LOGS=true.
// Access logging ([HTTP REQUEST] / [HTTP nxx], redacted via utils/logSafe)
// is unaffected and always prints.
if (process.env.DEBUG_LOGS !== 'true') {
    const suppressedPrefixes = ['[DEBUG]', '[AUTH DEBUG]', '[SSE DEBUG]', '[CEMENT ANALYTICS DEBUG]'];
    const rawLog = console.log.bind(console);
    let inDebugBlock = false;
    console.log = (...args) => {
        const head = typeof args[0] === 'string' ? args[0].split('\n')[0] : '';
        // A prefixed debug line opens a suppressed block.
        if (suppressedPrefixes.some((p) => head.startsWith(p))) {
            inDebugBlock = true;
            return;
        }
        // Continuation lines of a debug block are indented (e.g. "  Query: ...").
        // They belong to the preceding [CEMENT ANALYTICS DEBUG] header, so hide them too.
        if (inDebugBlock && /^\s/.test(head)) return;
        // Any real (non-indented, non-debug) line ends the block.
        inDebugBlock = false;
        rawLog(...args);
    };
}

const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const sqlite3 = require('sqlite3');
const path = require('path');
const fs = require('fs');
const { initDb } = require('./config/database');
const { requireAdmin, requireRole } = require('./middleware/authMiddleware');
const securityHeaders = require('./middleware/securityHeaders');
const { i18nMiddleware } = require('./middleware/i18n');
const cookieParser = require('cookie-parser');
const { issueCsrfToken, verifyCsrfToken } = require('./middleware/csrf');

const app = express();
const PORT = process.env.PORT || 5000;

// TRUST_PROXY: set env TRUST_PROXY=1 (or 'loopback', a CIDR, a subnet list) when
// running behind a reverse proxy so req.ip / rate limiting see the real client
// address. Default off — X-Forwarded-For is never trusted blindly.
const trustProxySetting = process.env.TRUST_PROXY;
if (trustProxySetting) {
    app.set('trust proxy', /^\d+$/.test(trustProxySetting) ? parseInt(trustProxySetting, 10) : trustProxySetting);
}

// Initialize database
initDb().then(() => {
    console.log('✅ Database initialized successfully');
}).catch(err => {
    console.error('❌ Database initialization failed:', err);
    process.exit(1);
});

// Middleware
app.use(cookieParser());
app.use(securityHeaders);
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Session configuration - use separate session database
const sessionDb = new sqlite3.Database(path.join(__dirname, 'sessions.sqlite'));

// Production HTTPS: set COOKIE_SECURE=true or NODE_ENV=production in the process env.
// Localhost HTTP must keep secure=false so cookies continue to work.
const cookieSecure = process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production';

app.use(session({
    store: new SQLiteStore({
        db: sessionDb
    }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
        httpOnly: true,
        sameSite: 'lax',
        secure: cookieSecure
    }
}));

// M8: uploaded profile pictures / employee photos are private PII and used to be
// served anonymously from public/. The URLs stay the same, but these two upload
// trees now require a logged-in session; public marketing media (/uploads/homepage,
// css/js/images) remains anonymous. Static serving therefore runs AFTER session.
function requireSessionForUploads(req, res, next) {
    if (req.session && req.session.username) return next();
    return res.status(403).send('Forbidden');
}
app.use('/uploads/employees', requireSessionForUploads);
app.use('/uploads/profiles', requireSessionForUploads);
app.use(express.static(path.join(__dirname, 'public')));

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
// Phase 4 perf fix (2026-10-20): compile each EJS view once and keep it in memory.
// Without this, Express recompiles the large header/dashboard templates on EVERY
// request (measured ~75-500ms per navigation). After this change, editing any
// views/*.ejs file requires a server restart to take effect.
app.set('view cache', true);

// Make session available to all EJS templates
app.use((req, res, next) => {
    res.locals.session = req.session;
    res.locals.message = req.session.message || null;
    delete req.session.message; // clear flash message
    // H1: server-side JSON embed helper — emits JSON that is safe to place
    // inside a <script> block ("<" escaped so "</script>" cannot break out).
    res.locals.jsonEmbed = function (value) {
        return JSON.stringify(value)
            .replace(/</g, '\\u003c')
            .replace(/\u2028/g, '\\u2028')
            .replace(/\u2029/g, '\\u2029');
    };
    next();
});

// Apply i18n middleware
app.use(i18nMiddleware);

// CSRF: issue token to views; verify non-multipart bodies/headers globally.
// Multipart body verification is deferred to route-level csrfProtect after multer.
app.use(issueCsrfToken);
// /api/quotation-requests is the anonymous public quote form (no token by
// design; spam is mitigated by rate limiting, not session forgery).
app.use(verifyCsrfToken({ deferMultipartBody: true, exemptPaths: ['/api/quotation-requests'] }));

// Phase 5 — file logging with simple size-cap rotation (console output unchanged)
const LOG_DIR = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'app.log');
const LOG_MAX_BYTES = 5 * 1024 * 1024;

function rotateLogIfNeeded() {
    try {
        if (!fs.existsSync(LOG_FILE) || fs.statSync(LOG_FILE).size < LOG_MAX_BYTES) return;
        if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);
        if (fs.existsSync(LOG_FILE + '.2')) fs.unlinkSync(LOG_FILE + '.2');
        if (fs.existsSync(LOG_FILE + '.1')) fs.renameSync(LOG_FILE + '.1', LOG_FILE + '.2');
        fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    } catch (e) { /* rotation must never crash the app */ }
}

function logLine(line) {
    try {
        if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);
        rotateLogIfNeeded();
        fs.appendFileSync(LOG_FILE, line + '\n');
    } catch (e) { /* logging must never crash the app */ }
}

// Diagnostic logging for HTTP requests (+ non-2xx evidence lines for the Phase 2 403/404 work)
const { safeUrl } = require('./utils/logSafe');
app.use((req, res, next) => {
    const lineReq = `[HTTP REQUEST] METHOD=${req.method} URL=${safeUrl(req)}`;
    console.log(lineReq);
    logLine(lineReq);
    res.on('finish', () => {
        if (res.statusCode >= 400) {
            const sessionUser = (req.session && req.session.user_id) ? 'yes' : 'no';
            const sessionRole = (req.session && req.session.role) || 'none';
            const lineErr = `[HTTP ${res.statusCode}] METHOD=${req.method} URL=${safeUrl(req)} session=${sessionUser} role=${sessionRole} ip=${req.ip}`;
            console.log(lineErr);
            logLine(lineErr);
        }
    });
    next();
});

// Route imports
const authRoutes = require('./routes/authRoutes');
const workerRoutes = require('./routes/workerRoutes');
const adminRoutes = require('./routes/adminRoutes');
const reportRoutes = require('./routes/reportRoutes');
const hrRoutes = require('./routes/hrRoutes');
const recoveryRoutes = require('./routes/recoveryRoutes');

// Mount routes
app.use('/', authRoutes);
app.use('/', workerRoutes);
app.use('/', adminRoutes);
app.use('/', reportRoutes);
app.use('/', hrRoutes);
app.use('/', recoveryRoutes);

// Phase 6 — SSE streams for dashboard financial metrics (replace the old 5s client polling).
// The existing controller functions are reused through a tiny res-shim that captures their JSON.
const adminController = require('./controllers/adminController');
const workerController = require('./controllers/workerController');

function sseHead(res) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-store, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    res.write(': connected\n\n');
}

function metricsSseStream(req, res, controllerFn, intervalMs) {
    sseHead(res);
    const push = () => {
        // Re-validate the session store on every tick so a logged-out tab stops receiving data.
        req.sessionStore.get(req.sessionID, (err, sess) => {
            if (res.writableEnded) return;
            if (err || !sess) {
                try { res.write('event: session-lost\ndata: {}\n\n'); } catch (e) { /* ignore */ }
                return res.end();
            }
            const shimRes = {
                statusCode: 200,
                status(code) { this.statusCode = code; return this; },
                json(data) {
                    if (res.writableEnded) return;
                    if (this.statusCode !== 200) {
                        res.write('event: error\ndata: ' + JSON.stringify(data) + '\n\n');
                        return;
                    }
                    res.write('data: ' + JSON.stringify(data) + '\n\n');
                },
                send(data) { this.json(typeof data === 'string' ? { raw: data } : data); },
                set() { return this; },
                header() { return this; },
                redirect() { try { res.end(); } catch (e) { /* ignore */ } }
            };
            try {
                controllerFn(req, shimRes);
            } catch (e) {
                if (!res.writableEnded) res.write('event: error\ndata: {}\n\n');
            }
        });
    };
    push();
    const timer = setInterval(push, intervalMs);
    req.on('close', () => { clearInterval(timer); });
}

// Admin dashboard metrics stream (requireAdmin; controller re-checks the role as well)
app.get('/api/admin/financial-metrics/stream', requireAdmin, (req, res) => {
    metricsSseStream(req, res, adminController.apiFinancialMetrics, 10000);
});

// Worker command deck metrics stream (requireRole redirects unauthenticated -> client handles the error)
app.get('/api/worker/financial-metrics/stream', requireRole('worker'), (req, res) => {
    metricsSseStream(req, res, workerController.apiWorkerFinancialMetrics, 10000);
});

// Hourly housekeeping (timers are unref'd so they never delay shutdown):
// - dead SSE responses (closed tabs whose 'close' event was missed)
// - stale recovery PDFs left behind by crashed downloads (temp/recovery-pdfs)
const notificationSSE = require('./utils/notificationSSE');
const { cleanupOldPDFs } = require('./utils/recoveryUtils');
const recoveryPdfDir = path.join(__dirname, 'temp', 'recovery-pdfs');
setInterval(() => { try { notificationSSE.cleanupStaleConnections(); } catch (e) { /* housekeeping must never crash */ } }, 60 * 60 * 1000).unref();
setInterval(() => { try { cleanupOldPDFs(recoveryPdfDir); } catch (e) { /* housekeeping must never crash */ } }, 60 * 60 * 1000).unref();

// Phase 2 — 404 catch-all: JSON for API paths, friendly HTML for pages (always status 404)
const notFoundHandler = require('./middleware/notFound');
app.use(notFoundHandler);

// M5: global error handler — full details logged server-side only; clients get
// a generic message (no stack/message leakage). JSON for APIs, text for pages.
// eslint-disable-next-line no-unused-vars
// Global error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    console.error(
        '[ERROR]',
        new Date().toISOString(),
        req.method,
        safeUrl(req),
        '\n',
        (err && err.stack) || err
    );

    if (res.headersSent) {
        return res.end();
    }

    if ((req.path || '').startsWith('/api/')) {
        return res.status(500).json({
            error: 'Internal server error'
        });
    }

    return res.status(500).send('Internal server error');
});

// M5: background async faults are logged with full detail and do not kill the
// process (financial ERP must stay available; details live in the server log).
// Faults BEFORE the server is listening (e.g. EADDRINUSE) are fatal startup
// errors — logging alone would leave a zombie process that serves nothing.
let isListening = false;
process.on('uncaughtException', (err) => {
    console.error('[FATAL] uncaughtException', new Date().toISOString(), '\n', (err && err.stack) || err);
    if (!isListening) process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    console.error('[FATAL] unhandledRejection', new Date().toISOString(), '\n', (reason && reason.stack) || reason);
    if (!isListening) process.exit(1);
});

// Start server
app.listen(PORT, () => {
    isListening = true;
    console.log(`✨ Atlas Cement Group ERP Node.js server running on port ${PORT}`);
    console.log(`🌐 Access the application at http://localhost:${PORT}`);
});
