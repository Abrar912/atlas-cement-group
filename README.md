# Atlas Cement Group ERP

A multilingual cement company ERP built with Node.js, Express, EJS, SQLite, and JavaScript.

---

## Project Overview

Atlas Cement Group ERP is a server-rendered web application designed to manage the operational core of a cement trading business. The system provides a complete set of tools for handling customers, workers, inventory, sales, payroll, and financial reporting, all within a single-node deployment using SQLite as the embedded database.

The application is **trilingual**, supporting English, Dari, and Pashto with full right-to-left (RTL) layout support for Pashto. All three languages are fully implemented and switchable from the user interface.

The project was reviewed for public publication and cleared for release. No production secrets, private customer records, or financial data are included in the repository.

---

## Features and Modules

The application implements the following modules. Each module is accessible through the routes defined in `routes/` and handled by the corresponding controllers in `controllers/`.

### Authentication and Access Control

- **Role-based access**: Three distinct roles — `admin`, `worker`, and `customer`.
- **Admin**: Full access to all dashboards, configuration, user management, and reporting.
- **Worker**: Restricted to worker-specific dashboards, customer lists, and waybill management.
- **Customer**: Limited to public product catalog, quote requests, and account recovery.
- **CSRF protection**: Tokens are required for all state-changing actions.
- **Session security**: `HttpOnly`, `SameSite=Lax` cookies; session fixation protection.
- **Password security**: bcrypt hashing with 12 salt rounds.
- **Google OAuth**: Configured via `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (requires separate setup).
- **Password recovery**: Email-based recovery with encrypted recovery keys.


## Starting and Stopping the Application

### Start command

```powershell
npm start
```

This runs the `"start"` script defined in `package.json`, which executes `node server.js`.

### Port

The application defaults to **port 5000** (configured in `.env.example` as `PORT=5000`). If port 5000 is already in use, the server will fail to start. To change the port:

1. Edit the `PORT` variable in `.env`.
2. Or override on the command line:

```powershell
set PORT=3000 && npm start
```

### How to start

1. Open a terminal (PowerShell or cmd) in the project directory.
2. Run `npm start`.
3. The server will start and display:

```
✨ Atlas Cement Group ERP Node.js server running on port 5000
🌐 Access the application at http://localhost:5000
```

### How to stop

Press **Ctrl+C** in the terminal where the server is running. The process will shut down gracefully.

### Common port conflicts

If you see `EADDRINUSE` or similar errors:

1. Check what's using port 5000:

```powershell
netstat -ano | findstr :5000
```

2. Kill the conflicting process (replace `PID` with the process ID):

```powershell
taskkill /PID <PID> /F
```

3. Retry `npm start`.

### Startup failures

If the application fails to start:

1. **Missing secrets**: Ensure `.env` has `SESSION_SECRET` and `RECOVERY_ENCRYPTION_KEY` defined and at least 32 characters long.
2. **Database locked**: Ensure no other process has `enterprise_cement.db` open.
3. **Missing dependencies**: Run `npm ci` to reinstall.
4. **Port in use**: Change the port or kill the conflicting process.
5. **Old `.env`**: Delete `.env` and regenerate from `.env.example`.
## Database Setup

The application uses **SQLite** as the embedded database. The database file is stored as `enterprise_cement.db` in the project root directory.

### Initializing the database

On first run, the application automatically initializes all tables. The database configuration is in `config/database.js`, which creates the database file at:

```
<project-root>/enterprise_cement.db
```

### Automatic table creation

The `initDb()` function in `config/database.js` creates all required tables on first connection. The following tables are created automatically:

1. **customers** — Customer registry
2. **departments** — Department categories
3. **hr_employees** — Employee/worker profiles
4. **employee_salary_history** — Salary change history
5. **waybills** — Cement waybill records
6. **quotation_requests** — Customer quotation requests
7. **payroll_periods** — Payroll period definitions
8. **payroll_payments** — Individual payroll payments
9. **payroll_deductions** — Payroll deduction items
10. **payroll_entitlements** — Calculated employee entitlements
11. **payroll_advances** — Employee salary advances
12. **performance_reviews** — Employee performance reviews
13. **admins** — Admin user accounts
14. **recovery_tokens** — Password recovery tokens

### Migrations and seed scripts

After the initial table creation, additional migrations may be needed for existing databases. The `config/database.js` includes a migration that adds the `customer_id` column to the `customers` table if it doesn't already exist.

### Running the database reset script

**Important**: The reset script is guarded by multiple safety checks. It is designed for fresh installations only.

```powershell
npm run db:reset
```

This runs `node scripts/reset-database.js`. The script includes 8 safeguards:

- Refuses to run in production (checks `NODE_ENV`).
- Validates the database path is contained within the project directory.
- Rejects symlink paths.
- Requires interactive confirmation.
- Requires `--yes` flag for non-interactive use.
- SQL DELETE operations only use paths derived from the config.
- Never deletes the `enterprise_cement.db` file itself.
- Path must resolve to a file, not a directory.

### Fresh installation workflow

For a new installation (no existing database):

1. Install dependencies: `npm ci`
2. Copy `.env.example` to `.env` and fill in `SESSION_SECRET` and `RECOVERY_ENCRYPTION_KEY`.
3. Start the application: `npm start`
4. The database will be created automatically on first server start.
5. To populate initial data, run the reset script if desired (with caution):

```powershell
npm run db:reset
```

**Do not run `npm run db:reset` on a production database containing real records.**

### Avoiding overwriting an existing database

To keep an existing database while still running the application, simply start the server without resetting:

```powershell
npm start
```

The application will connect to the existing `enterprise_cement.db` and use its current data. No tables will be dropped or recreated.
## Environment Configuration

The application requires environment variables to be configured before first run. These are documented in `.env.example`.

### Copy the example environment file

**Windows PowerShell:**

```powershell
Copy-Item -Path ".env.example" -Destination ".env"
```

### Required environment variables

| Variable | Purpose | Minimum Length |
|---|---|---|
| `SESSION_SECRET` | Signs express-session cookies; used for session integrity verification | 32 characters |
| `RECOVERY_ENCRYPTION_KEY` | Encrypts/decrypts recovery data (must differ from SESSION_SECRET) | 32 characters |

### Generating secure random values

Never copy or reuse values from this README, `.env.example`, or any other source. Generate fresh random values for each deployment:

```powershell
# PowerShell: generate a 48-character random value (base64url)
$bytes = [byte[]]::new(48)
[RandomNumberGenerator]::FillBytes($bytes)
$sessionSecret = $bytes -join ('') # Convert to string appropriate format
```

Or using Node.js:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

The `.env.example` file shows that both `SESSION_SECRET` and `RECOVERY_ENCRYPTION_KEY` are initialized as empty strings (`SESSION_SECRET=` and `RECOVERY_ENCRYPTION_KEY=`), meaning they **must** be filled in with valid values before starting the application.

The application enforces these requirements at startup via `assertSecrets()` in `server.js`:

- Both variables must be present and non-empty.
- Both must be at least 32 characters long.
- Both must NOT match the SHA-256 hashes of known prohibited historical fallback inputs.
- `SESSION_SECRET` and `RECOVERY_ENCRYPTION_KEY` must be different values.

## First Login and Initial Setup

### New installation account provisioning

For a fresh installation, the application does not pre-create any admin accounts. The first admin account must be created through the following process:

1. **Start the application**: `npm start`
2. **Open the login page**: Go to `http://localhost:5000/login` in your web browser.
3. **The login form** will be displayed with the rebranded title: "Login - Atlas Cement Group ERP".

**Initial admin creation**: The application does not include an automatic "create first admin" script. Since the `admins` table is created by the database initialization, you may need to directly insert an admin record into the database using SQLite CLI or a database management tool, or contact the project maintainer for the initial provisioning process.

**Alternative approach**: The application's authentication system is designed to work with pre-existing admin accounts. If you need to set up the first admin account, you will need to:

- Use the SQLite command-line tool to insert a record into the `admins` table:
  ```sql
  sqlite3 enterprise_cement.db "INSERT INTO admins (username, password, role) VALUES ('admin', '<bcrypted-password>', 'admin');"
  ```
  Replace `<bcrypted-password>` with a bcrypt-hashed password.

- Or use a database management tool (DB Browser for SQLite, etc.) to add the first admin user.

### Logging in

After an admin account exists:

1. Go to `http://localhost:5000/login`.
2. Enter the username and password.
3. Click **Login**.
4. Upon successful authentication, you will be redirected to the dashboard (`/admin` or `/worker` depending on your role).

### Language selection

After logging in, you can switch languages using the language selector in the header. Available languages: English, Dari, Pashto.

### Login rate limiter

The application implements rate limiting on the login endpoint. After several failed attempts, the login page will temporarily reject further requests. Wait before retrying.

### Invalid credentials

If an incorrect password is provided, the login will fail with a 403 response. The rate limiter counts failed attempts.

---
## Installation

Navigate into the project directory and install the Node.js dependencies:

**Windows PowerShell:**

```powershell
cd C:\path\to\atlas-cement-group
npm ci
```

**Alternative (npm install):**

```powershell
cd C:\path\to\atlas-cement-group
npm install
```

The `npm ci` command uses the committed `package-lock.json` for a deterministic install. If `package-lock.json` is missing, `npm install` will work but may resolve dependencies differently.

### Verifying the Installation

After installing dependencies, verify the project structure:

```powershell
ls
```

You should see the following key items:

- `server.js` — Application entry point
- `package.json` and `package-lock.json`
- `config/database.js` — Database configuration
- `.env.example` — Environment variable template
- `controllers/`, `middleware/`, `routes/` — Source code directories
- `views/` — EJS templates
- `public/` — Static assets (logos, images)
- `locales/` — Translation files (en, da, ps)
- `scripts/` — Utility scripts
- `.gitignore` — Files excluded from version control
- `LICENSE` — ISC license text
## Downloading the Project

After the repository is published at `https://github.com/YOUR_USERNAME/atlas-cement-group`:

### Downloading as ZIP

1. Go to the repository page on GitHub.
2. Click **Code** → **Download ZIP**.
3. Save the `.zip` file to your computer.
4. Extract the ZIP archive into a writable directory (e.g., `~/atlas-cement-group` or `C:\atlas-cement-group`).
5. Open the extracted directory in a terminal or VS Code.

### Using Git

If Git is installed on your system:

```powershell
# Clone the repository
git clone https://github.com/YOUR_USERNAME/atlas-cement-group.git

# Change into the project directory
cd atlas-cement-group

# Add upstream remote if you forked
# git remote add upstream https://github.com/original-owner/atlas-cement-group.git
```

---
## Tests and Troubleshooting

### Running the test suite

The project includes a smoke test suite located at `tests/smoke.test.js`. Tests use Node.js built-in test runner.

**Prerequisites:**

- The application must be running: `npm start` (targets `http://localhost:5000`).
- Test credentials can be supplied via environment variables:

```powershell
# Set test credentials (optional; tests will skip auth-dependent tests without them)
$env:TEST_ADMIN_USERNAME = "admin"
$env:TEST_ADMIN_PASSWORD = "your-test-admin-password"
```

**Run the tests:**

```powershell
npm test
```

**Test limitations:**

- The suite requires the application to be running (`npm start`).
- Tests that require credentials (`TEST_ADMIN_USERNAME`, `TEST_ADMIN_PASSWORD`) will be skipped if not provided.
- The suite timed out in the preflight review because the application was not running during testing.
- The tests are read-only against the running application (they do not modify database data).
- One intentional failed-login attempt is counted against the login rate limiter.

**Smoke test coverage:**

The test suite exercises:

- Rebranded English title on the login page.
- Dari title with new brand (language cookie switch).
- Pashto title with new brand (RTL support).
- 404 handling for unknown routes.
- Anonymous access to public pages (403 Forbidden for /admin).
- Session cookie flags (HttpOnly, SameSite=Lax).
- Language switching via `POST /set-language`.
- Admin login flow (with valid credentials).
- Invalid password rejection (403 on /admin).
- Logout ending the session.

### npm scripts reference

| Script | Description |
|---|---|
| `npm start` | Start the production server (`node server.js`). |
| `npm dev` | Start development mode (`node server.js`). |
| `npm db:reset` | Reset the database (guarded by 8 safety checks). |
| `npm i18n:audit` | Run i18n audit script to check translation coverage. |
| `npm logo:build` | Build/reproduce the logo PNGs from SVG sources (requires puppeteer). |
| `npm test` | Run the smoke test suite against a running app. |

### Troubleshooting guide

| Symptom | Likely Cause | Fix |
|---|---|---|
| Server starts but pages return 404 | Route mismatch | Verify URL paths match defined routes. |
| Login fails after correct credentials | Rate limiter | Wait 30+ seconds before retrying. |
| Dashboard shows old branding | Cache | Clear browser cache; old branding was fully replaced. |
| PDFs fail to generate | Missing logo files | Run `npm run logo:build` to regenerate PNGs from SVGs. |
| `EADDRINUSE` error | Port 5000 occupied | Change PORT in `.env` or kill the conflicting process. |
| Database errors | Corrupted `enterprise_cement.db` | Delete `enterprise_cement.db` and restart `npm start` to regenerate. |
| Language switching has no effect | Cookie not accepted | Ensure cookies are enabled for `localhost`. |
| `npm test` times out | Application not running | Start `npm start` before running tests. |
| `npm run logo:build` fails | Puppeteer not installed | `npm install` ensures devDependencies are included. |

### Known limitations

- **Email delivery**: Email functionality requires Gmail app-specific credentials. Without these, password recovery and email-based features will not work.
- **Google OAuth**: Requires separate setup in Google Cloud Console. Buttons will not function without valid credentials.
- **SQLite scaling**: The application uses a single-file SQLite database. It is designed for single-node deployment and may not scale to multi-user concurrent write scenarios without a server-side database.
- **Dev dependencies**: `pdfjs-dist`, `puppeteer`, and `puppeteer-core` are dev dependencies. `npm run logo:build` requires puppeteer to be installed.
- **No built-in migration versioning**: Schema migrations are managed manually through `config/database.js`. For production deployments, consider adding a migration tool.
- **Single admin account**: The system does not include an automated "create first admin" workflow. Initial admin setup requires database-level intervention or maintainer assistance.
## Using the ERP

### Signing in

1. Start the application: `npm start`.
2. Open `http://localhost:5000/login` in your browser.
3. Enter your username and password.
4. Click **Login**.

### Dashboard navigation

After signing in, the dashboard is accessible at:

- **Admin**: `http://localhost:5000/admin`
- **Worker**: `http://localhost:5000/worker`

The dashboard provides a summary of the system and quick links to all modules.

### Language switching

To switch the interface language:

1. Click the language selector in the page header.
2. Select **English**, **Dari**, or **Pashto**.
3. The page will reload in the selected language.
4. The language preference is stored in a cookie (`lang`) for future visits.

Supported languages:

| Language | Locale File | Direction |
|---|---|---|
| English | `locales/en.json` | LTR (left-to-right) |
| Dari | `locales/da.json` | RTL (right-to-left) |
| Pashto | `locales/ps.json` | RTL (right-to-left) |

### Managing customers

1. Navigate to the **Customers** module from the admin dashboard.
2. Use the **Add Customer** form to register new customers.
3. Customer fields: name (required), province (required), phone, address, customer type, contact person position, alternative phone, email, organization name.
4. The system enforces `UNIQUE(name, province)` — duplicate entries are rejected.
5. View, edit, and list existing customers.

### Managing workers/employees

1. Navigate to the **HR** module from the admin dashboard.
2. Use the **Add Employee** form to register new workers.
3. Employee fields: full name (required), father's name, date of birth, gender, phone (required), address, emergency contact, position, department, hire date, employment status, supervisor, work location, contract type, payment method.
4. View employee salary history and performance reviews.
5. Filter by status, position, or department.

### Recording sales and waybills

1. Navigate to the **Waybills** module from the admin dashboard.
2. Use the **Register Waybill** form to create a new waybill.
3. Associated data: customer, cement type, quantity, date, remarks.
4. The system can generate a **PDF waybill** with the project logo.
5. View the **agency remittance ledger** for tracked payments.
6. Manage **quotation requests** from potential customers.

### Reviewing financial information and reports

1. Navigate to the **Financial Reports** module from the admin dashboard.
2. View **payment reports**, **remittance ledgers**, and **payment allocations**.
3. Financial metrics streams are available via SSE (Server-Sent Events) for real-time monitoring.
4. Admin-only endpoint: `GET /api/admin/financial-metrics/stream`.
5. Worker-accessible endpoint: `GET /api/worker/financial-metrics/stream`.

### Using HR features

1. Navigate to the **HR** module from the admin or worker dashboard.
2. View **employee lists**, **salary histories**, and **performance reviews**.
3. Use the **payroll period** management to define payment cycles.
4. Record **payroll payments** and **deductions**.
5. Track **salary advances** and **entitlements**.
6. Generate **salary entitlement reports**.

### Accessing the customer portal

Customers can interact with the system through the public-facing endpoints:

- View the product catalog without authentication.
- Submit quotation requests (which create `quotation_requests` table records).
- Recover account access using the "Forgot Password" flow (`/forgot-password`, `/reset-password`).
## Security Contact

If you discover a security vulnerability in this project, please report it via email at:

**abrar.shirzad@gmail.com**

We will investigate all reported vulnerabilities and respond in a responsible timeframe. Do not disclose security issues publicly before they are resolved.

---

## License

This project is licensed under the **ISC License**.

Copyright (c) 2026 Abrar Shirzad.

Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
## Tests and Troubleshooting

### Running the test suite

The project includes a smoke test suite located at `tests/smoke.test.js`. Tests use Node.js built-in test runner.

**Prerequisites:**

- The application must be running: `npm start` (targets `http://localhost:5000`).
- Test credentials can be supplied via environment variables:

```powershell
# Set test credentials (optional; tests will skip auth-dependent tests without them)
$env:TEST_ADMIN_USERNAME = "admin"
$env:TEST_ADMIN_PASSWORD = "your-test-admin-password"
```

**Run the tests:**

```powershell
npm test
```

**Test limitations:**

- The suite requires the application to be running (`npm start`).
- Tests that require credentials (`TEST_ADMIN_USERNAME`, `TEST_ADMIN_PASSWORD`) will be skipped if not provided.
- The suite timed out in the preflight review because the application was not running during testing.
- The tests are read-only against the running application (they do not modify database data).
- One intentional failed-login attempt is counted against the login rate limiter.

**Smoke test coverage:**

The test suite exercises:

- Rebranded English title on the login page.
- Dari title with new brand (language cookie switch).
- Pashto title with new brand (RTL support).
- 404 handling for unknown routes.
- Anonymous access to public pages (403 Forbidden for /admin).
- Session cookie flags (HttpOnly, SameSite=Lax).
- Language switching via `POST /set-language`.
- Admin login flow (with valid credentials).
- Invalid password rejection (403 on /admin).
- Logout ending the session.

### npm scripts reference

| Script | Description |
|---|---|
| `npm start` | Start the production server (`node server.js`). |
| `npm dev` | Start development mode (`node server.js`). |
| `npm db:reset` | Reset the database (guarded by 8 safety checks). |
| `npm i18n:audit` | Run i18n audit script to check translation coverage. |
| `npm logo:build` | Build/reproduce the logo PNGs from SVG sources (requires puppeteer). |
| `npm test` | Run the smoke test suite against a running app. |

### Troubleshooting guide

| Symptom | Likely Cause | Fix |
|---|---|---|
| Server starts but pages return 404 | Route mismatch | Verify URL paths match defined routes. |
| Login fails after correct credentials | Rate limiter | Wait 30+ seconds before retrying. |
| Dashboard shows old branding | Cache | Clear browser cache; old branding was fully replaced. |
| PDFs fail to generate | Missing logo files | Run `npm run logo:build` to regenerate PNGs from SVGs. |
| `EADDRINUSE` error | Port 5000 occupied | Change PORT in `.env` or kill the conflicting process. |
| Database errors | Corrupted `enterprise_cement.db` | Delete `enterprise_cement.db` and restart `npm start` to regenerate. |
| Language switching has no effect | Cookie not accepted | Ensure cookies are enabled for `localhost`. |
| `npm test` times out | Application not running | Start `npm start` before running tests. |
| `npm run logo:build` fails | Puppeteer not installed | `npm install` ensures devDependencies are included. |

### Known limitations

- **Email delivery**: Email functionality requires Gmail app-specific credentials. Without these, password recovery and email-based features will not work.
- **Google OAuth**: Requires separate setup in Google Cloud Console. Buttons will not function without valid credentials.
- **SQLite scaling**: The application uses a single-file SQLite database. It is designed for single-node deployment and may not scale to multi-user concurrent write scenarios without a server-side database.
- **Dev dependencies**: `pdfjs-dist`, `puppeteer`, and `puppeteer-core` are dev dependencies. `npm run logo:build` requires puppeteer to be installed.
- **No built-in migration versioning**: Schema migrations are managed manually through `config/database.js`. For production deployments, consider adding a migration tool.
- **Single admin account**: The system does not include an automated "create first admin" workflow. Initial admin setup requires database-level intervention or maintainer assistance.
## Database Setup

The application uses **SQLite** as the embedded database. The database file is stored as `enterprise_cement.db` in the project root directory.

### Initializing the database

On first run, the application automatically initializes all tables. The database configuration is in `config/database.js`, which creates the database file at:

```
<project-root>/enterprise_cement.db
```

### Automatic table creation

The `initDb()` function in `config/database.js` creates all required tables on first connection. The following tables are created automatically:

1. **customers** — Customer registry
2. **departments** — Department categories
3. **hr_employees** — Employee/worker profiles
4. **employee_salary_history** — Salary change history
5. **waybills** — Cement waybill records
6. **quotation_requests** — Customer quotation requests
7. **payroll_periods** — Payroll period definitions
8. **payroll_payments** — Individual payroll payments
9. **payroll_deductions** — Payroll deduction items
10. **payroll_entitlements** — Calculated employee entitlements
11. **payroll_advances** — Employee salary advances
12. **performance_reviews** — Employee performance reviews
13. **admins** — Admin user accounts
14. **recovery_tokens** — Password recovery tokens

### Migrations and seed scripts

After the initial table creation, additional migrations may be needed for existing databases. The `config/database.js` includes a migration that adds the `customer_id` column to the `customers` table if it doesn't already exist.

### Running the database reset script

**Important**: The reset script is guarded by multiple safety checks. It is designed for fresh installations only.

```powershell
npm run db:reset
```

This runs `node scripts/reset-database.js`. The script includes 8 safeguards:

- Refuses to run in production (checks `NODE_ENV`).
- Validates the database path is contained within the project directory.
- Rejects symlink paths.
- Requires interactive confirmation.
- Requires `--yes` flag for non-interactive use.
- SQL DELETE operations only use paths derived from the config.
- Never deletes the `enterprise_cement.db` file itself.
- Path must resolve to a file, not a directory.

### Fresh installation workflow

For a new installation (no existing database):

1. Install dependencies: `npm ci`
2. Copy `.env.example` to `.env` and fill in `SESSION_SECRET` and `RECOVERY_ENCRYPTION_KEY`.
3. Start the application: `npm start`
4. The database will be created automatically on first server start.
5. To populate initial data, run the reset script if desired (with caution):

```powershell
npm run db:reset
```

**Do not run `npm run db:reset` on a production database containing real records.**

### Avoiding overwriting an existing database

To keep an existing database while still running the application, simply start the server without resetting:

```powershell
npm start
```

The application will connect to the existing `enterprise_cement.db` and use its current data. No tables will be dropped or recreated.
## Environment Configuration

The application requires environment variables to be configured before first run. These are documented in `.env.example`.

### Copy the example environment file

**Windows PowerShell:**

```powershell
Copy-Item -Path ".env.example" -Destination ".env"
```

### Required environment variables

| Variable | Purpose | Minimum Length |
|---|---|---|
| `SESSION_SECRET` | Signs express-session cookies; used for session integrity verification | 32 characters |
| `RECOVERY_ENCRYPTION_KEY` | Encrypts/decrypts recovery data (must differ from SESSION_SECRET) | 32 characters |

### Generating secure random values

Never copy or reuse values from this README, `.env.example`, or any other source. Generate fresh random values for each deployment:

```powershell
# PowerShell: generate a 48-character random value (base64url)
$bytes = [byte[]]::new(48)
[RandomNumberGenerator]::FillBytes($bytes)
$sessionSecret = $bytes -join ('') # Convert to string appropriate format
```

Or using Node.js:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

The `.env.example` file shows that both `SESSION_SECRET` and `RECOVERY_ENCRYPTION_KEY` are initialized as empty strings (`SESSION_SECRET=` and `RECOVERY_ENCRYPTION_KEY=`), meaning they **must** be filled in with valid values before starting the application.

The application enforces these requirements at startup via `assertSecrets()` in `server.js`:

- Both variables must be present and non-empty.
- Both must be at least 32 characters long.
- Both must NOT match the SHA-256 hashes of known prohibited historical fallback inputs.
- `SESSION_SECRET` and `RECOVERY_ENCRYPTION_KEY` must be different values.

### Optional environment variables

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | Server port | `5000` |
| `APP_URL` | Base URL for the application | `http://localhost:5000` |
| `COOKIE_SECURE` | Set to `true` behind HTTPS/in production | `false` |
| `TRUST_PROXY` | Set to `1` behind a reverse proxy so rate limiting sees real IPs | _off_ |
| `DEBUG_LOGS` | Set to `true` for verbose development diagnostics (SQL text, session IDs) | _off_ |
| `EMAIL_USER` | Gmail SMTP username | _not set_ |
| `EMAIL_PASS` | Gmail app password | _not set_ |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID | _not set_ |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret | _not set_ |
| `GOOGLE_CALLBACK_URL` | Google OAuth callback URL | `https://your-domain.example.com/auth/google/callback` |

### Important — Do NOT commit `.env`

The `.gitignore` file explicitly excludes `.env`:

```
# Secrets & environment
.env
```

Copy `.env.example` to `.env` and fill in your own values. Never commit a `.env` file with real secrets to the repository.

---
## Security Contact

If you discover a security vulnerability in this project, please report it via email at:

**abrar.shirzad@gmail.com**

We will investigate all reported vulnerabilities and respond in a responsible timeframe. Do not disclose security issues publicly before they are resolved.

---

## License

This project is licensed under the **ISC License**.

Copyright (c) 2026 Abrar Shirzad.

Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.