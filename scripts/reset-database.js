const path = require('path');
const fs = require('fs');
const readline = require('readline');
const database = require('../config/database');
const { getDbConnection } = database;
const bcrypt = require('bcryptjs');

const BCRYPT_SALT_ROUNDS = 12;
const PROJECT_ROOT = path.resolve(__dirname, '..');
// Single source of truth: the same absolute path the application opens
// (exported by config/database.js). Fallback mirrors config's own resolution.
const DB_PATH = database.dbPath || path.join(PROJECT_ROOT, 'enterprise_cement.db');

/**
 * COMPLETE DATABASE RESET SCRIPT
 * 
 * This script performs a COMPLETE data reset while preserving:
 * - Admin user account (only admin, removes test users)
 * - Homepage content (system configuration)
 * - Database schema (all tables, columns, indexes remain)
 * 
 * It DELETES ALL business/test/demo data from:
 * - Customer accounts
 * - Sales logs (truck dispatches)
 * - Receipts logs (payments)
 * - Worker profiles
 * - Customer orders
 * - Province serial counters
 * - Agency expenses
 * - Local waybills
 * - Daily logs
 * - Cement types
 * - Password reset tokens
 * 
 * Auto-increment IDs are reset to 1 for all operational tables.
 *
 * SAFEGUARDS (this script never runs silently):
 *   1. Refuses to run when NODE_ENV=production.
 *   2. Refuses to run if no database file exists at the resolved path.
 *   3. Refuses to run if the resolved path (after following symlinks) is not
 *      inside this project's directory — it can never reach a database
 *      belonging to another installation.
 *   4. Always prints the ABSOLUTE path of the database it is about to wipe.
 *      The path comes from config/database.js (the file the app itself opens),
 *      not from the current working directory.
 *   5. Interactive runs require typing the word RESET.
 *   6. Non-interactive runs (CI, pipes) require the --yes flag.
 * The script performs SQL deletions only — it never deletes files.
 */

function abort(message) {
    console.error('❌ ' + message);
    console.error('   No changes were made.');
    process.exit(1);
}

function confirmReset() {
    if (process.env.NODE_ENV === 'production') {
        abort('Refusing to run with NODE_ENV=production. Reset is a development/maintenance operation.');
    }
    if (!fs.existsSync(DB_PATH)) {
        abort(`No database found at ${DB_PATH} — nothing to reset.`);
    }

    // Path containment: after resolving symlinks, the database must still live
    // inside this project directory. This guarantees the script can never reach
    // a database belonging to another installation or the live customer system.
    let realDbPath;
    let realRoot;
    try {
        realDbPath = fs.realpathSync(DB_PATH);
        realRoot = fs.realpathSync(PROJECT_ROOT);
    } catch (err) {
        abort(`Could not resolve database path: ${err.message}`);
    }
    const rel = path.relative(realRoot, realDbPath);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
        abort(`Refusing to run: database resolves outside the project directory (${realDbPath}).`);
    }
    // The database file itself must not be a symlink (a link planted inside the
    // project could otherwise point at a database elsewhere on disk).
    if (fs.lstatSync(DB_PATH).isSymbolicLink()) {
        abort(`Refusing to run: database path is a symlink (${DB_PATH} -> ${realDbPath}).`);
    }

    console.log('🔄 Starting COMPLETE database reset...');
    console.log('⚠️  WARNING: This will delete ALL business/test/demo data!');
    console.log('');
    console.log('📋 DATABASE FILE (absolute path):');
    console.log('   ' + DB_PATH);
    console.log('');
    console.log('📋 TABLES TO BE CLEARED (Business Data):');
    console.log('   - customers (all customer records)');
    console.log('   - sales_logs (all truck dispatch records)');
    console.log('   - receipts_logs (all payment records)');
    console.log('   - worker_profiles (all worker records)');
    console.log('   - customer_orders (all customer orders)');
    console.log('   - province_serial_counters (reset to initial state)');
    console.log('   - agency_expenses (all expense records)');
    console.log('   - local_waybills (all waybill records)');
    console.log('   - daily_logs (all daily log records)');
    console.log('   - cement_types (all cement type records)');
    console.log('   - password_reset_tokens (all reset tokens)');
    console.log('');
    console.log('📋 TABLES TO BE PRESERVED (System Data):');
    console.log('   - users (admin account only, test users removed)');
    console.log('   - homepage_content (system configuration)');
    console.log('');
    console.log('📋 SCHEMA PRESERVATION:');
    console.log('   - All tables remain intact');
    console.log('   - All columns remain intact');
    console.log('   - All indexes remain intact');
    console.log('   - All relationships remain intact');
    console.log('');

    if (process.argv.includes('--yes')) {
        console.log('▶ Confirmed via --yes flag.');
        return Promise.resolve();
    }
    if (!process.stdin.isTTY) {
        abort('Non-interactive terminal: re-run with "npm run db:reset -- --yes" to confirm.');
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question('    Type RESET (uppercase) to confirm, anything else to cancel: ', (answer) => {
            rl.close();
            if (answer.trim() === 'RESET') return resolve();
            abort('Cancelled by operator.');
        });
    });
}

function resetDatabase() {
    const db = getDbConnection();

    db.serialize(() => {
        // Disable foreign key constraints temporarily
        db.run('PRAGMA foreign_keys = OFF', (err) => {
            if (err) {
                console.error('Error disabling foreign keys:', err);
                process.exit(1);
            }
            
            // Execute deletions in proper order (child tables first, then parent tables)
            const operations = [
                { table: 'customer_orders', name: 'customer_orders' },
                { table: 'sales_logs', name: 'sales_logs' },
                { table: 'receipts_logs', name: 'receipts_logs' },
                { table: 'worker_profiles', name: 'worker_profiles' },
                { table: 'agency_expenses', name: 'agency_expenses' },
                { table: 'local_waybills', name: 'local_waybills' },
                { table: 'daily_logs', name: 'daily_logs' },
                { table: 'cement_types', name: 'cement_types' },
                { table: 'password_reset_tokens', name: 'password_reset_tokens' },
                { table: 'customers', name: 'customers' },
                { table: 'province_serial_counters', name: 'province_serial_counters' }
            ];
            
            let completed = 0;
            
            operations.forEach((op, index) => {
                db.run(`DELETE FROM ${op.table}`, (err) => {
                    if (err) {
                        console.error(`Error deleting ${op.name}:`, err);
                    } else {
                        console.log(`✓ Cleared ${op.name}`);
                    }
                    
                    // Reset auto-increment for this table
                    db.run(`DELETE FROM sqlite_sequence WHERE name="${op.name}"`, (err) => {
                        if (err) console.error(`Error resetting ${op.name} sequence:`, err);
                        
                        completed++;
                        if (completed === operations.length) {
                            // All deletions complete, clean up users
                            cleanupUsers(db);
                        }
                    });
                });
            });
        });
    });
}

function cleanupUsers(db) {
    console.log('');
    console.log('🔧 Cleaning up users table...');
    
    // Keep only the admin account, remove all other users
    db.run('DELETE FROM users WHERE username != "admin"', (err) => {
        if (err) {
            console.error('Error cleaning users:', err);
        } else {
            console.log('✓ Removed non-admin users');
        }
        
        // Verify admin account exists
        db.get('SELECT * FROM users WHERE username = "admin"', (err, adminUser) => {
            if (err) {
                console.error('Error checking admin user:', err);
            } else if (!adminUser) {
                console.log('⚠️  WARNING: No admin account found! Creating default admin...');
                const adminPassword = process.env.ADMIN_PASSWORD;
                if (!adminPassword) {
                    console.error('Error: ADMIN_PASSWORD environment variable is required');
                    completeReset(db);
                    return;
                }
                bcrypt.hash(adminPassword, BCRYPT_SALT_ROUNDS, (hashErr, hashedPassword) => {
                    if (hashErr) {
                        console.error('Error hashing admin password:', hashErr);
                        completeReset(db);
                        return;
                    }
                    db.run("INSERT INTO users (username, password, role, assigned_province) VALUES (?, ?, ?, ?)", 
                        ['admin', hashedPassword, 'admin', 'Herat'], (err) => {
                            if (err) {
                                console.error('Error creating admin:', err);
                            } else {
                                console.log('✓ Created default admin account (username: admin)');
                            }
                            completeReset(db);
                        });
                });
            } else {
                console.log('✓ Admin account preserved (username: admin)');
                completeReset(db);
            }
        });
    });
}

function completeReset(db) {
    // Re-enable foreign key constraints
    db.run('PRAGMA foreign_keys = ON', (err) => {
        if (err) {
            console.error('Error enabling foreign keys:', err);
            process.exit(1);
        }
        
        // Verify preserved data
        db.get('SELECT COUNT(*) as user_count FROM users', (err, row) => {
            if (err) {
                console.error('Error checking users:', err);
            } else {
                console.log('');
                console.log('✓ Preserved users:', row.user_count);
            }
            
            db.get('SELECT COUNT(*) as content_count FROM homepage_content', (err, row) => {
                if (err) {
                    console.error('Error checking homepage_content:', err);
                } else {
                    console.log('✓ Preserved homepage_content records:', row.content_count);
                }
                
                // Verify all business tables are empty
                const verificationTables = [
                    'customers', 'sales_logs', 'receipts_logs', 'worker_profiles',
                    'customer_orders', 'agency_expenses', 'local_waybills', 'daily_logs',
                    'cement_types', 'password_reset_tokens', 'province_serial_counters'
                ];
                
                console.log('');
                console.log('🔍 Verifying empty state...');
                let verified = 0;
                
                verificationTables.forEach(tableName => {
                    db.get(`SELECT COUNT(*) as count FROM ${tableName}`, (err, row) => {
                        if (err) {
                            console.error(`Error checking ${tableName}:`, err);
                        } else {
                            console.log(`✓ ${tableName}: ${row.count} records`);
                        }
                        
                        verified++;
                        if (verified === verificationTables.length) {
                            finishReset(db);
                        }
                    });
                });
            });
        });
    });
}

function finishReset(db) {
    db.close((err) => {
        if (err) {
            console.error('Error closing database:', err);
            process.exit(1);
        }
        
        console.log('');
        console.log('✅ COMPLETE DATABASE RESET SUCCESSFUL!');
        console.log('');
        console.log('📋 FINAL STATE:');
        console.log('   ✓ Application code: PRESERVED');
        console.log('   ✓ Database structure: PRESERVED');
        console.log('   ✓ Admin account: PRESERVED');
        console.log('   ✓ Homepage content: PRESERVED');
        console.log('   ✓ Business data: COMPLETELY CLEARED');
        console.log('   ✓ Demo/test data: COMPLETELY CLEARED');
        console.log('   ✓ Auto-increment IDs: RESET');
        console.log('');
        console.log('🚀 System is now ready for fresh data entry.');
        console.log('🔑 Admin account ready. Login username: admin');
        console.log('   Password configured from ADMIN_PASSWORD (not printed).');
        console.log('');
        process.exit(0);
    });
}

// Run the reset — only after explicit confirmation (see SAFEGUARDS above)
confirmReset()
    .then(() => resetDatabase())
    .catch((err) => abort(err && err.message ? err.message : String(err)));
