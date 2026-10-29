# Atlas Cement Group ERP — Portfolio Summary

A complete, production-shaped ERP system for a cement trading company, built end-to-end
with Node.js, Express, EJS and SQLite. This document summarises what the project is, the
engineering decisions behind it, and the specific areas worth reviewing.

> Companion document: [README.md](../README.md) — installation, configuration, testing.

---

## What it is

Atlas ERP is a server-rendered web application covering the operational core of a cement
trading business:

- **Human resources & payroll** — employees, contracts, attendance, leave, salary advances,
  deductions, overtime, entitlements and payroll periods.
- **Sales & waybills** — local waybill registration with PDF output, receipts, an agency
  remittance ledger and quotation requests.
- **Inventory** — cement stock with summaries and low-stock alerts.
- **Customer portal** — a public product catalog, quote requests and self-service account
  recovery.
- **Access control** — distinct admin, worker and customer roles with per-page and
  per-action permission checks.
- **Trilingual UI** — English, Dari and Pashto with full right-to-left layout support.

It is a real, working system: authentication, a relational data model, server-rendered
pages, PDF generation and a deliberate security posture — not a mock-up.

## Technical highlights

- **Server-rendered architecture.** Express routes → controllers → EJS views, keeping a
  clear separation of concerns without a client-side SPA build step.
- **Internationalization with RTL.** Three languages (English, Dari, Pashto) from shared
  JSON locale files, per-user language switching, and layout that mirrors correctly for
  right-to-left scripts.
- **PDF generation.** Waybills and payment reports are produced server-side with `pdfkit`,
  embedding the project logo.
- **Security by default.** bcrypt hashing, session fixation protection, CSRF tokens,
  rate limiting, encrypted recovery keys, parameterised SQL, restricted file uploads,
  hardened security headers, generic client-facing errors and diagnostic logging that is
  off by default with redacted access logs.
- **Tooling.** Database-reset script with strong safety guards, a read-only i18n coverage
  audit, an SVG→PNG logo build pipeline, and a dependency-free regression test suite.

## Engineering decisions

- **SQLite + synchronous driver.** A single-file database with the synchronous `sqlite3`
  API keeps the data layer simple and predictable for a single-node deployment; schema
  migration happens automatically on first boot.
- **Server-side sessions.** `express-session` backed by SQLite keeps authentication state
  on the server, which simplifies CSRF and fixation handling.
- **No heavy front-end toolchain.** EJS templates and a few client libraries (e.g.
  Chart.js) mean the project runs with `npm ci && npm start` and no build step.
- **Original branding as source-controlled SVG.** The logo is a hand-authored "A" monogram
  with editable SVG sources and reproducible PNG exports (`npm run logo:build`), rather
  than an imported raster asset.
- **Safe-by-default operations.** The destructive database-reset path is guarded behind an
  explicit confirmation and refuses to run in production.

## Testing approach

A regression/smoke suite (`tests/`) runs against a live instance using Node's built-in
test runner — no extra test dependencies. It exercises rebranded titles across all three
languages, public and recovery pages, 404 and anonymous-access (403) handling, absence of
legacy branding, serving of the logo assets, session-cookie flags, language switching, a
full admin login flow, rejection of invalid credentials, and logout closing the session.
Credentials are supplied only through the environment.

## Security review

The publication candidate was reviewed for common web vulnerabilities: SQL injection
(parameterised queries throughout), CSRF (tokens on every state-changing action), session
handling (`HttpOnly`/`SameSite` cookies, fixation protection), authentication (bcrypt,
rate limiting on login and recovery), file-upload hardening (extension allow-list plus PDF
magic-byte validation, private documents outside the web root), security headers, generic
error responses and redacted, opt-in diagnostic logging.

## What I'd improve next

- Resolve the extra Dari/Pashto locale keys reported by `npm run i18n:audit`.
- Exercise the email-recovery and Google OAuth integrations end-to-end with real
  credentials.
- Add automated tests for the deeper HR/sales workflows beyond the current smoke suite.
- Introduce a migration/versioning story and CI for the test suite.
- Consider a deployment profile for a hosted (non-SQLite) database if scaling is needed.

## Role and scope

Designed and implemented as a full-stack portfolio project, covering application
architecture, data modelling, authentication and authorization, internationalization,
PDF output, security hardening, documentation and testing.

## At a glance

| Aspect | Detail |
|---|---|
| Runtime | Node.js 22 |
| Framework | Express 4 |
| Views | EJS (server-rendered) |
| Database | SQLite (`sqlite3`) |
| Sessions | `express-session` + `connect-sqlite3` |
| PDF | `pdfkit` |
| Email | `nodemailer` (Gmail SMTP) |
| Languages | English, Dari, Pashto (RTL) |
| Tests | Node built-in test runner (`node --test`) |
| License | ISC (see `LICENSE`) |
