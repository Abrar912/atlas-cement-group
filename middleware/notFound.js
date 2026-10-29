'use strict';

// Phase 2 — global 404 catch-all (mounted after every router; only unmatched
// URLs reach it). Always answers with status 404 (never 200) so API clients
// keep their expected semantics. API paths get JSON; everything else gets a
// small self-contained HTML page (no view file, no locale dependency).

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function notFound(req, res) {
    const path = req.path || '';
    const isApi = path === '/api' || path.startsWith('/api/');
    const accept = req.get ? (req.get('Accept') || '') : '';
    const wantsJson = isApi || accept.indexOf('application/json') !== -1;

    if (wantsJson) {
        return res.status(404).json({
            success: false,
            error: 'Not found',
            path: req.originalUrl
        });
    }

    res.status(404).send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>404 — Page not found</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         font-family: system-ui, -apple-system, "Segoe UI", Tahoma, sans-serif;
         background: #f6f7f9; color: #1b1f24; }
  @media (prefers-color-scheme: dark) {
    body { background: #0d1117; color: #e6edf3; }
  }
  .card { max-width: 560px; padding: 40px 32px; text-align: center; border: 1px solid #d8dee4;
          border-radius: 12px; background: #fff; }
  @media (prefers-color-scheme: dark) {
    .card { background: #161b22; border-color: #30363d; }
  }
  h1 { margin: 0 0 8px; font-size: 64px; letter-spacing: 6px; }
  p { margin: 6px 0; line-height: 1.6; }
  code { padding: 2px 6px; border-radius: 6px; background: rgba(127,127,127,.16); word-break: break-all; }
  a { display: inline-block; margin-top: 18px; padding: 10px 18px; border-radius: 8px;
      background: #2563eb; color: #fff; text-decoration: none; }
  a:hover { background: #1d4ed8; }
</style>
</head>
<body>
  <div class="card">
    <h1>404</h1>
    <p><strong>Page not found</strong> &mdash; این صفحه وجود ندارد</p>
    <p><code>${escapeHtml(path)}</code></p>
    <p>The address may be old, or the page may have moved.</p>
    <a href="/">&larr; Back to home</a>
  </div>
</body>
</html>`);
}

module.exports = notFound;
