/**
 * render-logo.js — Rasterize the project logo SVG sources to PNG exports.
 *
 * Sources (editable):  public/logo/atlas-icon.svg
 *                      public/logo/atlas-erp-logo-horizontal.svg
 *                      public/logo/atlas-erp-logo-horizontal-dark.svg
 * Exports:
 *                      public/Logo.png                              (app header + favicon)
 *                      public/logo/atlas-erp-logo-horizontal.png    (light backgrounds / docs)
 *                      public/logo/atlas-erp-logo-horizontal-dark.png (dark backgrounds)
 *
 * Usage: npm run logo:build   (requires devDependency: puppeteer)
 * Offline-friendly: falls back to any Chromium found in the local
 * puppeteer cache if the pinned browser is not installed.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const LOGO_DIR = path.join(ROOT, 'public', 'logo');

const JOBS = [
    { svg: 'atlas-icon.svg', out: path.join(ROOT, 'public', 'Logo.png'), w: 512, h: 512, dsf: 1 },
    { svg: 'atlas-erp-logo-horizontal.svg', out: path.join(LOGO_DIR, 'atlas-erp-logo-horizontal.png'), w: 1600, h: 420, dsf: 2 },
    { svg: 'atlas-erp-logo-horizontal-dark.svg', out: path.join(LOGO_DIR, 'atlas-erp-logo-horizontal-dark.png'), w: 1600, h: 420, dsf: 2 },
];

function findCachedChromiums(dir) {
    const found = [];
    if (!fs.existsSync(dir)) return found;
    const stack = [dir];
    while (stack.length) {
        const cur = stack.pop();
        let entries;
        try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            const p = path.join(cur, e.name);
            if (e.isDirectory()) stack.push(p);
            else if (e.name === 'chrome.exe' || e.name === 'chrome') found.push(p);
        }
    }
    return found;
}

async function launchBrowser() {
    const puppeteer = require('puppeteer');
    const base = { headless: true, args: ['--no-sandbox', '--disable-gpu'] };
    const candidates = [
        null, // pinned browser from puppeteer config (may trigger a download if absent)
        ...findCachedChromiums(path.join(os.homedir(), '.cache', 'puppeteer')),
        ...findCachedChromiums(path.join(os.homedir(), 'AppData', 'Local', 'puppeteer')),
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ].filter((v, i, a) => v === null || (a.indexOf(v) === i && fs.existsSync(v)));

    let lastErr;
    for (const exe of candidates) {
        try {
            const opts = exe ? { ...base, executablePath: exe } : base;
            const browser = await puppeteer.launch(opts);
            console.log(`Browser: ${exe || 'pinned puppeteer browser'}`);
            return browser;
        } catch (err) {
            lastErr = err;
            console.log(`Skipping unavailable browser (${exe || 'pinned'}): ${err.message.split('\n')[0]}`);
        }
    }
    throw lastErr;
}

async function main() {
    const browser = await launchBrowser();

    for (const job of JOBS) {
        const src = path.join(LOGO_DIR, job.svg);
        if (!fs.existsSync(src)) throw new Error(`Missing SVG source: ${src}`);
        const page = await browser.newPage();
        await page.setViewport({ width: job.w, height: job.h, deviceScaleFactor: job.dsf });
        await page.goto('file:///' + src.replace(/\\/g, '/'), { waitUntil: 'load' });
        await page.screenshot({ path: job.out, omitBackground: true });
        await page.close();
        console.log(`✓ ${path.relative(ROOT, job.out)}`);
    }

    await browser.close();
    console.log('Logo build complete.');
}

main().catch(err => { console.error('logo build failed:', err.message); process.exit(1); });
