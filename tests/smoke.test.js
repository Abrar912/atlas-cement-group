/**
 * Smoke / regression tests for Atlas Cement Group ERP.
 *
 * Uses Node's built-in test runner (no extra dependencies).
 * The application must already be running:
 *
 *   npm start
 *   npm test                       (targets http://localhost:5000)
 *   TEST_BASE_URL=http://host:port npm test
 *
 * Login tests run only when test credentials are provided via environment
 * (never hard-code credentials in this file):
 *
 *   set TEST_ADMIN_USERNAME=admin
 *   set TEST_ADMIN_PASSWORD=your-test-admin-password
 *
 * The suite is read-only except for one intentional failed-login attempt
 * (counts against the login rate limiter) and a language-cookie switch.
 */
const { test, before } = require('node:test');
const assert = require('node:assert');

const BASE = (process.env.TEST_BASE_URL || 'http://localhost:5000').replace(/\/$/, '');
const USER = process.env.TEST_ADMIN_USERNAME || '';
const PASS = process.env.TEST_ADMIN_PASSWORD || '';
const hasCreds = Boolean(USER && PASS);

const OLD_BRAND = /(^|[^a-z])(najib|aref)([^a-z]|$)/i;
const OLD_BRAND_AR = /\u0646\u062c\u064a\u0628|\u0646\u062c\u064a\u0641|\u0639\u0627\u0631\u0641/; // نجیب / نجیف / عارف

class CookieJar {
    constructor() { this.cookies = new Map(); }
    absorb(response) {
        const setCookies = typeof response.headers.getSetCookie === 'function'
            ? response.headers.getSetCookie() : [];
        for (const raw of setCookies) {
            const [pair] = raw.split(';');
            const eq = pair.indexOf('=');
            if (eq === -1) continue;
            const name = pair.slice(0, eq).trim();
            const value = pair.slice(eq + 1).trim();
            if (!value) this.cookies.delete(name);
            else this.cookies.set(name, value);
        }
    }
    header() {
        return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    get(name) { return this.cookies.get(name); }
}

async function request(path, { jar, method = 'GET', form, headers = {}, redirect = 'manual' } = {}) {
    const opts = { method, redirect, headers: { ...headers } };
    if (jar && jar.cookies.size) opts.headers.cookie = jar.header();
    if (form) {
        opts.headers['content-type'] = 'application/x-www-form-urlencoded';
        opts.body = new URLSearchParams(form).toString();
    }
    const res = await fetch(BASE + path, opts);
    if (jar) jar.absorb(res);
    return res;
}

function titleOf(html) {
    const m = html.match(/<title>([^<]+)<\/title>/);
    return m ? m[1] : '';
}

function csrfFrom(html) {
    let m = html.match(/name="_csrf"\s+value="([^"]+)"/);
    if (!m) m = html.match(/name="_csrf"[^>]*value="([^"]+)"/);
    if (!m) m = html.match(/<meta name="csrf-token" content="([^"]+)"/);
    return m ? m[1] : '';
}

before(async () => {
    try {
        const res = await fetch(BASE + '/login');
        if (!res.ok) throw new Error('HTTP ' + res.status);
    } catch (err) {
        throw new Error(`Application not reachable at ${BASE} — start it first (npm start). ${err.message}`);
    }
});

test('login page serves rebranded English title', async () => {
    const res = await request('/login');
    assert.equal(res.status, 200);
    assert.equal(titleOf(await res.text()), 'Login - Atlas Cement Group ERP');
});

test('login page serves Dari title with new brand', async () => {
    const jar = new CookieJar();
    jar.cookies.set('lang', 'da');
    const res = await request('/login', { jar });
    const title = titleOf(await res.text());
    assert.match(title, /\u0648\u0631\u0648\u062f/); // ورود
    assert.match(title, /Atlas Cement Group ERP/);
});

test('login page serves Pashto title with new brand', async () => {
    const jar = new CookieJar();
    jar.cookies.set('lang', 'ps');
    const res = await request('/login', { jar });
    const title = titleOf(await res.text());
    assert.match(title, /\u0646\u0646\u0648\u062a\u0644/); // ننوتل
    assert.match(title, /Atlas Cement Group ERP/);
});

test('customer home serves rebranded title', async () => {
    const res = await request('/');
    assert.equal(res.status, 200);
    assert.match(titleOf(await res.text()), /Atlas Cement Group/);
});

test('forgot-password page serves rebranded title', async () => {
    const res = await request('/forgot-password');
    assert.equal(res.status, 200);
    assert.match(titleOf(await res.text()), /Atlas Cement Group ERP/);
});

test('unknown route returns 404', async () => {
    const res = await request('/definitely-not-a-page-xyz');
    assert.equal(res.status, 404);
});

test('anonymous admin access returns 403', async () => {
    const res = await request('/admin');
    assert.equal(res.status, 403);
});

test('login page HTML contains no old branding', async () => {
    const res = await request('/login');
    const html = await res.text();
    assert.ok(!OLD_BRAND.test(html), 'Latin old brand found in /login');
    assert.ok(!OLD_BRAND_AR.test(html), 'Arabic-script old brand found in /login');
    assert.match(html, /Atlas Cement Group/);
});

test('new logo assets are served', async () => {
    const logo = await request('/Logo.png');
    assert.equal(logo.status, 200);
    assert.match(logo.headers.get('content-type') || '', /image\/png/);
    const bytes = Buffer.from(await logo.arrayBuffer());
    assert.ok(bytes.length > 50000, `Logo.png unexpectedly small: ${bytes.length}`);
    assert.equal(bytes.subarray(1, 4).toString('ascii'), 'PNG');

    const svg = await request('/logo/atlas-icon.svg');
    assert.equal(svg.status, 200);
    assert.match(svg.headers.get('content-type') || '', /svg\+xml/);

    const wide = await request('/logo/atlas-erp-logo-horizontal.png');
    assert.equal(wide.status, 200);
});

test('session cookie is HttpOnly and SameSite=Lax', async () => {
    const res = await request('/login', { redirect: 'manual' });
    const raw = (res.headers.getSetCookie && res.headers.getSetCookie().join(' ')) || '';
    if (raw) {
        assert.match(raw, /HttpOnly/i);
        assert.match(raw, /SameSite=Lax/i);
    }
});

test('POST /set-language switches the interface language', async () => {
    const jar = new CookieJar();
    const page = await request('/login', { jar });
    const token = csrfFrom(await page.text());
    const res = await request('/set-language', {
        jar, method: 'POST',
        form: { lang: 'da', _csrf: token },
    });
    assert.ok([200, 302].includes(res.status), 'unexpected status ' + res.status);
    const after = await request('/login', { jar });
    assert.match(titleOf(await after.text()), /\u0648\u0631\u0648\u062f/); // ورود
});

test('admin login flow reaches the dashboard', { skip: !hasCreds }, async () => {
    const jar = new CookieJar();
    const page = await request('/login', { jar });
    const token = csrfFrom(await page.text());
    assert.ok(token, 'CSRF token not found on login page');
    const res = await request('/login', {
        jar, method: 'POST',
        form: { username: USER, password: PASS, _csrf: token },
    });
    // follow the redirect manually so cookies are absorbed
    assert.ok([302, 303].includes(res.status), 'login POST status ' + res.status);
    const dest = res.headers.get('location') || '/admin';
    const dash = await request(dest, { jar });
    assert.equal(dash.status, 200, 'dashboard status ' + dash.status);
    const html = await dash.text();
    assert.equal(titleOf(html), 'Atlas Cement Group ERP');
    assert.ok(!OLD_BRAND.test(html), 'old brand on dashboard');
});

test('invalid password does not authenticate', { skip: !hasCreds }, async () => {
    const jar = new CookieJar();
    const page = await request('/login', { jar });
    const token = csrfFrom(await page.text());
    await request('/login', {
        jar, method: 'POST',
        form: { username: USER, password: 'definitely-wrong-password-123', _csrf: token },
    });
    const admin = await request('/admin', { jar });
    assert.equal(admin.status, 403, 'wrong password must not open /admin');
});

test('logout ends the session', { skip: !hasCreds }, async () => {
    const jar = new CookieJar();
    const page = await request('/login', { jar });
    let token = csrfFrom(await page.text());
    const login = await request('/login', {
        jar, method: 'POST',
        form: { username: USER, password: PASS, _csrf: token },
    });
    const dest = login.headers.get('location') || '/admin';
    const dash = await request(dest, { jar });
    token = csrfFrom(await dash.text());
    assert.ok(token, 'CSRF token not found on dashboard');
    const out = await request('/logout', { jar, method: 'POST', form: { _csrf: token } });
    assert.ok([200, 302, 303].includes(out.status), 'logout status ' + out.status);
    const admin = await request('/admin', { jar });
    assert.equal(admin.status, 403, '/admin must be closed after logout');
});
