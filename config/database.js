const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');

const BCRYPT_SALT_ROUNDS = 12;

const dbPath = path.join(__dirname, '..', 'enterprise_cement.db');

// 3-letter province code mapping for all 34 Afghanistan provinces
const PROVINCE_CODES = {
    'Kabul': 'KAB',
    'Herat': 'HER',
    'Balkh': 'BAL',
    'Kandahar': 'KAN',
    'Nangarhar': 'NAN',
    'Khost': 'KHO',
    'Paktia': 'PAK',
    'Paktika': 'PKT',
    'Ghazni': 'GHA',
    'Logar': 'LOG',
    'Wardak': 'WAR',
    'Parwan': 'PAR',
    'Kapisa': 'KAP',
    'Panjshir': 'PAN',
    'Laghman': 'LAG',
    'Kunar': 'KNR',
    'Nuristan': 'NUR',
    'Badakhshan': 'BAD',
    'Takhar': 'TAK',
    'Baghlan': 'BAG',
    'Samangan': 'SAM',
    'Jowzjan': 'JOW',
    'Sar-e Pol': 'SAR',
    'Faryab': 'FRY',
    'Kunduz': 'KUN',
    'Badghis': 'BDG',
    'Ghor': 'GHO',
    'Daikundi': 'DAI',
    'Bamyan': 'BAM',
    'Uruzgan': 'URU',
    'Zabul': 'ZAB',
    'Helmand': 'HEL',
    'Nimruz': 'NIM',
    'Farah': 'FAH'
};

// Export PROVINCE_CODES for use in controllers and views
module.exports.PROVINCE_CODES = PROVINCE_CODES;

function getDbConnection() {
    const db = new sqlite3.Database(dbPath);
    return db;
}

function initDb() {
    return new Promise((resolve, reject) => {
        const db = getDbConnection();
        
        db.serialize(() => {
            // 1. CUSTOMERS REGISTRY TABLE
            db.run(`
                CREATE TABLE IF NOT EXISTS customers (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    customer_id TEXT UNIQUE,
                    name TEXT NOT NULL,
                    province TEXT NOT NULL,
                    phone TEXT,
                    address TEXT,
                    UNIQUE(name, province)
                )
            `, (err) => {
                if (err) return reject(err);
                
                // Migration: Add customer_id column if it doesn't exist (for existing databases)
                db.all("PRAGMA table_info(customers)", (err, columns) => {
                    if (err) {
                        console.error('Error checking table schema:', err);
                        return;
                    }
                    
                    const hasCustomerIdColumn = columns.some(col => col.name === 'customer_id');
                    
                    if (!hasCustomerIdColumn) {
                        db.run("ALTER TABLE customers ADD COLUMN customer_id TEXT", (err) => {
                            if (err) {
                                console.error('Error adding customer_id column:', err);
                            } else {
                                console.log('Migration: Added customer_id column to customers table');
                            }
                        });
                    }
                    
                    // Migration: Add new customer profile fields
                    const newColumns = [
                        { name: 'customer_type', type: 'TEXT' },
                        { name: 'contact_person_position', type: 'TEXT' },
                        { name: 'alternative_phone', type: 'TEXT' },
                        { name: 'email', type: 'TEXT' },
                        { name: 'organization_name', type: 'TEXT' },
                        { name: 'created_by', type: 'TEXT' },
                        { name: 'created_by_agency', type: 'TEXT' }
                    ];
                    
                    newColumns.forEach(col => {
                        const hasColumn = columns.some(c => c.name === col.name);
                        if (!hasColumn) {
                            db.run(`ALTER TABLE customers ADD COLUMN ${col.name} ${col.type}`, (err) => {
                                if (err) {
                                    console.error(`Error adding ${col.name} column:`, err);
                                } else {
                                    console.log(`Migration: Added ${col.name} column to customers table`);
                                }
                            });
                        }
                    });
                });
            });

            // 1.5. PROVINCE SERIAL COUNTER TABLE
            db.run(`
                CREATE TABLE IF NOT EXISTS province_serial_counters (
                    province TEXT PRIMARY KEY,
                    next_serial INTEGER DEFAULT 1
                )
            `, (err) => {
                if (err) return reject(err);
                
                // Migration: Generate customer_id for existing customers
                db.all('SELECT id, name, province FROM customers WHERE customer_id IS NULL OR customer_id = ""', (err, customers) => {
                    if (err) {
                        console.error('Error fetching customers for migration:', err);
                        return;
                    }
                    
                    if (customers.length === 0) {
                        console.log('Migration: No customers need customer_id generation');
                        return;
                    }
                    
                    console.log(`Migration: Generating customer_id for ${customers.length} existing customers`);
                    
                    // Group customers by province and sort by id (creation order)
                    const customersByProvince = {};
                    customers.forEach(customer => {
                        const province = customer.province || 'Kabul';
                        if (!customersByProvince[province]) {
                            customersByProvince[province] = [];
                        }
                        customersByProvince[province].push(customer);
                    });
                    
                    // Sort each province's customers by id
                    Object.keys(customersByProvince).forEach(province => {
                        customersByProvince[province].sort((a, b) => a.id - b.id);
                    });
                    
                    // Generate customer_id for each customer
                    let completed = 0;
                    Object.keys(customersByProvince).forEach(province => {
                        const provinceCustomers = customersByProvince[province];
                        const provinceCode = PROVINCE_CODES[province] || province.substring(0, 3).toUpperCase();
                        
                        provinceCustomers.forEach((customer, index) => {
                            const serial = index + 1;
                            const serialStr = String(serial).padStart(3, '0');
                            const customerId = `${provinceCode}-${serialStr}-${customer.name}`;
                            
                            db.run('UPDATE customers SET customer_id = ? WHERE id = ?', 
                                [customerId, customer.id], (err) => {
                                if (err) {
                                    console.error(`Error updating customer_id for customer ${customer.id}:`, err);
                                }
                                
                                completed++;
                                if (completed === customers.length) {
                                    // Initialize province_serial_counters with next serial for each province
                                    Object.keys(customersByProvince).forEach(prov => {
                                        const nextSerial = customersByProvince[prov].length + 1;
                                        db.run('INSERT OR REPLACE INTO province_serial_counters (province, next_serial) VALUES (?, ?)',
                                            [prov, nextSerial], (err) => {
                                            if (err) {
                                                console.error(`Error setting serial counter for ${prov}:`, err);
                                            }
                                        });
                                    });
                                    console.log('Migration: Customer ID generation completed');
                                }
                            });
                        });
                    });
                });

                // Migration: Clean up customer_id values that have names appended
                db.all('SELECT id, customer_id FROM customers WHERE customer_id IS NOT NULL AND customer_id != ""', (err, customers) => {
                    if (err) {
                        console.error('Error fetching customers for ID cleanup migration:', err);
                        return;
                    }

                    let cleanedCount = 0;
                    customers.forEach(customer => {
                        const rawId = customer.customer_id;
                        // Extract prefix and number matching pattern like KAB-001
                        const match = rawId.match(/^([A-Z]{3}-\d+)/i);
                        const cleanId = match ? match[1].toUpperCase() : rawId;

                        if (cleanId !== rawId) {
                            db.run('UPDATE customers SET customer_id = ? WHERE id = ?', [cleanId, customer.id], (err) => {
                                if (err) {
                                    console.error(`Error cleaning customer_id for customer ${customer.id}:`, err);
                                } else {
                                    cleanedCount++;
                                    if (cleanedCount === 1) {
                                        console.log('Migration: Cleaning customer_id values with appended names');
                                    }
                                }
                            });
                        }
                    });
                });
            });
            
            // 2. USERS & STAFF AUTHENTICATION TABLE
            db.run(`
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT NOT NULL UNIQUE,
                    password TEXT NOT NULL,
                    role TEXT NOT NULL,
                    assigned_province TEXT,
                    email TEXT UNIQUE,
                    full_name TEXT,
                    permissions TEXT,
                    can_update INTEGER DEFAULT 0,
                    can_delete INTEGER DEFAULT 0
                )
            `, (err) => {
                if (err) return reject(err);

                // Migration: Add columns if they don't exist
                db.all("PRAGMA table_info(users)", (err, columns) => {
                    if (err) {
                        console.error('Error checking users table schema:', err);
                        return;
                    }
                    
                    const columnNames = columns.map(col => col.name);
                    
                    const migrations = [
                        { name: 'email', sql: 'ALTER TABLE users ADD COLUMN email TEXT UNIQUE' },
                        { name: 'full_name', sql: 'ALTER TABLE users ADD COLUMN full_name TEXT' },
                        { name: 'permissions', sql: 'ALTER TABLE users ADD COLUMN permissions TEXT' },
                        { name: 'can_update', sql: 'ALTER TABLE users ADD COLUMN can_update INTEGER DEFAULT 0' },
                        { name: 'can_delete', sql: 'ALTER TABLE users ADD COLUMN can_delete INTEGER DEFAULT 0' },
                        { name: 'profile_picture', sql: 'ALTER TABLE users ADD COLUMN profile_picture TEXT' },
                        { name: 'agency_name', sql: 'ALTER TABLE users ADD COLUMN agency_name TEXT' }
                    ];
                    
                    migrations.forEach(migration => {
                        if (!columnNames.includes(migration.name)) {
                            db.run(migration.sql, (err) => {
                                if (err) {
                                    console.error(`Error adding ${migration.name} column to users table:`, err);
                                } else {
                                    console.log(`Migration: Added ${migration.name} column to users table`);
                                }
                            });
                        }
                    });
                });
            });

            // 2.5. PASSWORD RESET TOKENS TABLE
            db.run(`
                CREATE TABLE IF NOT EXISTS password_reset_tokens (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    token TEXT NOT NULL UNIQUE,
                    expires_at DATETIME NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    used INTEGER DEFAULT 0,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                )
            `, (err) => {
                if (err) return reject(err);
            });

            // 3. EXTENDED WORKER/DRIVER PROFILES TABLE
            db.run(`
                CREATE TABLE IF NOT EXISTS worker_profiles (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER,
                    full_name TEXT NOT NULL,
                    position TEXT NOT NULL,
                    date_of_entrance TEXT NOT NULL,
                    tazkira_details TEXT NOT NULL,
                    phone_number TEXT NOT NULL,
                    address TEXT,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
                )
            `, (err) => {
                if (err) return reject(err);
            });
            
            // 4. TRUCK SALES LOGS TABLE
            db.run(`
                CREATE TABLE IF NOT EXISTS sales_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    sale_date TEXT NOT NULL,
                    customer_id INTEGER NOT NULL,
                    driver_name TEXT NOT NULL,
                    car_plate TEXT NOT NULL,
                    waybill_number TEXT NOT NULL,
                    cement_type TEXT NOT NULL,
                    bags_count INTEGER NOT NULL,
                    tonnage REAL NOT NULL,
                    shortage INTEGER DEFAULT 0,
                    unit_price_bag REAL NOT NULL,
                    total_sales_money REAL NOT NULL,
                    freight_per_ton REAL,
                    total_freight REAL,
                    is_company_car INTEGER DEFAULT 0,
                    net_cement_money REAL NOT NULL,
                    province_origin TEXT NOT NULL,
                    user_id INTEGER,
                    is_posted INTEGER DEFAULT 0,
                    FOREIGN KEY (customer_id) REFERENCES customers(id)
                )
            `, (err) => {
                if (err) return reject(err);
            });
            
            // 5. CAPITAL MONEY RECEIPTS TABLE
            db.run(`
                CREATE TABLE IF NOT EXISTS receipts_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    receipt_date TEXT NOT NULL,
                    customer_id INTEGER NOT NULL,
                    sender_name TEXT NOT NULL,
                    origin_source TEXT NOT NULL,
                    remittance_number TEXT NOT NULL,
                    receiving_station TEXT NOT NULL,
                    amount_received REAL NOT NULL,
                    user_id INTEGER,
                    is_posted INTEGER DEFAULT 0,
                    FOREIGN KEY (customer_id) REFERENCES customers(id)
                )
            `, (err) => {
                if (err) return reject(err);
            });
            
            // 6. DIGITAL E-COMMERCE CUSTOMER ORDERS TABLE
            db.run(`
                CREATE TABLE IF NOT EXISTS customer_orders (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    order_date TEXT NOT NULL,
                    customer_user_id INTEGER NOT NULL,
                    cement_type TEXT NOT NULL,
                    requested_tons REAL NOT NULL,
                    delivery_province TEXT NOT NULL,
                    delivery_address TEXT NOT NULL,
                    special_instructions TEXT,
                    status TEXT DEFAULT 'Pending Review',
                    FOREIGN KEY (customer_user_id) REFERENCES users(id)
                )
            `, (err) => {
                if (err) return reject(err);
            });
            
            // 7. DYNAMIC HOMEPAGE CONTENT TABLE
            db.run(`
                CREATE TABLE IF NOT EXISTS homepage_content (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    hero_headline TEXT NOT NULL,
                    hero_subtext TEXT NOT NULL,
                    about_story TEXT NOT NULL,
                    company_mission TEXT NOT NULL,
                    company_vision TEXT NOT NULL,
                    waybill_phone_1 TEXT,
                    waybill_phone_2 TEXT
                )
            `, (err) => {
                if (err) return reject(err);
                
                // Migration: Add waybill phone columns if they don't exist
                db.all("PRAGMA table_info(homepage_content)", (err, columns) => {
                    if (err) {
                        console.error('Error checking homepage_content table schema:', err);
                        return;
                    }
                    
                    const newColumns = [
                        { name: 'waybill_phone_1', type: 'TEXT' },
                        { name: 'waybill_phone_2', type: 'TEXT' }
                    ];
                    
                    newColumns.forEach(col => {
                        const hasColumn = columns.some(c => c.name === col.name);
                        if (!hasColumn) {
                            db.run(`ALTER TABLE homepage_content ADD COLUMN ${col.name} ${col.type}`, (err) => {
                                if (err) {
                                    console.error(`Error adding ${col.name} column to homepage_content:`, err);
                                } else {
                                    console.log(`Migration: Added ${col.name} column to homepage_content table`);
                                }
                            });
                        }
                    });
                });
            });

            // 8. AGENCY EXPENSES & CASH FLOW TABLE
            db.run(`
                CREATE TABLE IF NOT EXISTS agency_expenses (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    agency_username TEXT NOT NULL,
                    transaction_date TEXT NOT NULL,
                    category TEXT NOT NULL,
                    description TEXT,
                    person_involved TEXT,
                    quantity REAL DEFAULT 1,
                    unit_price REAL DEFAULT 0,
                    total_price REAL DEFAULT 0,
                    cash_in REAL DEFAULT 0,
                    cash_out REAL DEFAULT 0,
                    remarks TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `, (err) => {
                if (err) return reject(err);
                
                // Create index for faster lookups
                db.run(`
                    CREATE INDEX IF NOT EXISTS idx_agency_expenses_lookup 
                    ON agency_expenses (agency_username, transaction_date)
                `, (err) => {
                    if (err) console.error('Error creating index for agency_expenses:', err);
                });
            });

            // 9. LOCAL WAYBILLS TABLE
            // Check if table exists and needs migration
            db.all("SELECT name FROM sqlite_master WHERE type='table' AND name='local_waybills'", (err, tables) => {
                if (err) return reject(err);
                
                const tableExists = tables.length > 0;
                
                if (tableExists) {
                    // Check if table has old structure by checking for old columns
                    db.all("PRAGMA table_info(local_waybills)", (err, columns) => {
                        if (err) return reject(err);
                        
                        const columnNames = columns.map(c => c.name);
                        const hasOldColumns = columnNames.includes('destination') ||
                                            columnNames.includes('origin') ||
                                            columnNames.includes('advance_paid') ||
                                            columnNames.includes('remaining_balance');
                        
                        const missingNewColumns = !columnNames.includes('truck_type') ||
                                              !columnNames.includes('freight_per_ton') ||
                                              !columnNames.includes('total_freight');
                        
                        if (hasOldColumns || missingNewColumns) {
                            // Migrate: Create new table with correct structure
                            db.run(`
                                CREATE TABLE IF NOT EXISTS local_waybills_new (
                                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                                    waybill_serial TEXT NOT NULL UNIQUE,
                                    waybill_date TEXT NOT NULL,
                                    selled_to_agent TEXT NOT NULL,
                                    driver_name TEXT NOT NULL,
                                    driver_phone TEXT,
                                    truck_plate TEXT NOT NULL,
                                    truck_type TEXT DEFAULT 'company',
                                    freight_per_ton REAL DEFAULT 0,
                                    total_freight REAL DEFAULT 0,
                                    cement_type TEXT NOT NULL,
                                    total_bags INTEGER NOT NULL,
                                    tonnage REAL NOT NULL,
                                    loading_province TEXT NOT NULL,
                                    unloading_province TEXT NOT NULL,
                                    remarks TEXT,
                                    created_by TEXT NOT NULL,
                                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                                )
                            `, (err) => {
                                if (err) return reject(err);
                                
                                // Copy data from old table to new table
                                db.run(`
                                    INSERT INTO local_waybills_new 
                                    (waybill_serial, waybill_date, selled_to_agent, driver_name, driver_phone, truck_plate, truck_type, freight_per_ton, total_freight, cement_type, total_bags, tonnage, loading_province, unloading_province, remarks, created_by, created_at)
                                    SELECT waybill_serial, waybill_date, selled_to_agent, driver_name, driver_phone, truck_plate, 'company', 0, 0, cement_type, total_bags, tonnage, loading_province, unloading_province, remarks, created_by, created_at
                                    FROM local_waybills
                                `, (err) => {
                                    if (err) {
                                        console.error('Error migrating local_waybills data:', err);
                                        // Continue with old table if migration fails
                                        createIndex();
                                        return;
                                    }
                                    
                                    // Drop old table
                                    db.run('DROP TABLE local_waybills', (err) => {
                                        if (err) {
                                            console.error('Error dropping old local_waybills table:', err);
                                            createIndex();
                                            return;
                                        }
                                        
                                        // Rename new table to original name
                                        db.run('ALTER TABLE local_waybills_new RENAME TO local_waybills', (err) => {
                                            if (err) {
                                                console.error('Error renaming local_waybills table:', err);
                                            }
                                            createIndex();
                                        });
                                    });
                                });
                            });
                        } else {
                            // Table already has correct structure
                            createIndex();
                        }
                    });
                } else {
                    // Create new table with correct structure
                    db.run(`
                        CREATE TABLE IF NOT EXISTS local_waybills (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            waybill_serial TEXT NOT NULL UNIQUE,
                            waybill_date TEXT NOT NULL,
                            selled_to_agent TEXT NOT NULL,
                            driver_name TEXT NOT NULL,
                            driver_phone TEXT,
                            truck_plate TEXT NOT NULL,
                            truck_type TEXT DEFAULT 'company',
                            freight_per_ton REAL DEFAULT 0,
                            total_freight REAL DEFAULT 0,
                            cement_type TEXT NOT NULL,
                            total_bags INTEGER NOT NULL,
                            tonnage REAL NOT NULL,
                            loading_province TEXT NOT NULL,
                            unloading_province TEXT NOT NULL,
                            remarks TEXT,
                            created_by TEXT NOT NULL,
                            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                        )
                    `, (err) => {
                        if (err) return reject(err);
                        createIndex();
                    });
                }
                
                function createIndex() {
                    // Create index for faster lookups
                    db.run(`
                        CREATE INDEX IF NOT EXISTS idx_waybills_serial 
                        ON local_waybills (waybill_serial)
                    `, (err) => {
                        if (err) console.error('Error creating index for local_waybills:', err);
                    });
                    
                    // Migration: Add waybill lifecycle columns if they don't exist
                    db.all("PRAGMA table_info(local_waybills)", (err, columns) => {
                        if (err) {
                            console.error('Error checking local_waybills table schema:', err);
                            return;
                        }
                        
                        const newColumns = [
                            { name: 'status', type: 'VARCHAR(50)', default: "'available'" },
                            { name: 'sale_date', type: 'VARCHAR(50)' },
                            { name: 'customer_id', type: 'VARCHAR(100)' },
                            { name: 'customer_name', type: 'VARCHAR(200)' },
                            { name: 'shortage_bags', type: 'INT', default: '0' },
                            { name: 'sale_unit_price', type: 'NUMERIC(10,2)', default: '0' },
                            { name: 'total_sale_amount', type: 'NUMERIC(12,2)', default: '0' },
                            { name: 'net_cement_money', type: 'NUMERIC(12,2)', default: '0' }
                        ];
                        
                        newColumns.forEach(col => {
                            const hasColumn = columns.some(c => c.name === col.name);
                            if (!hasColumn) {
                                const defaultClause = col.default ? ` DEFAULT ${col.default}` : '';
                                db.run(`ALTER TABLE local_waybills ADD COLUMN ${col.name} ${col.type}${defaultClause}`, (err) => {
                                    if (err) {
                                        console.error(`Error adding ${col.name} column to local_waybills:`, err);
                                    } else {
                                        console.log(`Migration: Added ${col.name} column to local_waybills table`);
                                    }
                                });
                            }
                        });
                    });
                }
            });

            // 10. DAILY LOGS TABLE (Central sales records from agencies)
            db.run(`
                CREATE TABLE IF NOT EXISTS daily_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    sale_date TEXT,
                    customer_id TEXT,
                    customer_name TEXT,
                    driver_name TEXT,
                    car_plate TEXT,
                    waybill_number TEXT,
                    cement_type TEXT,
                    bags_count INTEGER DEFAULT 0,
                    tonnage REAL DEFAULT 0,
                    shortage INTEGER DEFAULT 0,
                    unit_price_bag REAL DEFAULT 0,
                    total_sales_money REAL DEFAULT 0,
                    truck_type TEXT DEFAULT 'company',
                    freight_per_ton REAL DEFAULT 0,
                    total_freight REAL DEFAULT 0,
                    net_cement_money REAL DEFAULT 0,
                    created_by_agency TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `, (err) => {
                if (err) return reject(err);
            });

            // 11. CEMENT TYPES REGISTRY TABLE
            db.run(`
                CREATE TABLE IF NOT EXISTS cement_types (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    cement_name TEXT NOT NULL,
                    source_origin TEXT NOT NULL,
                    storage_destination TEXT NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `, (err) => {
                if (err) return reject(err);
            });

            // 12. QUOTATION REQUESTS TABLE
            db.run(`
                CREATE TABLE IF NOT EXISTS quotation_requests (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    request_id TEXT UNIQUE,
                    customer_name TEXT NOT NULL,
                    company_name TEXT,
                    phone TEXT NOT NULL,
                    email TEXT,
                    delivery_address TEXT NOT NULL,
                    province TEXT NOT NULL,
                    cement_type TEXT NOT NULL,
                    quantity REAL,
                    message TEXT,
                    request_date DATETIME DEFAULT CURRENT_TIMESTAMP,
                    status TEXT DEFAULT 'pending',
                    assigned_worker TEXT,
                    assigned_worker_username TEXT,
                    source_type TEXT DEFAULT 'direct_customer',
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `, (err) => {
                if (err) return reject(err);
            });

            // 13. RECEIPTS LOGS TABLE (Money Receipts Deck)
            db.run(`
                CREATE TABLE IF NOT EXISTS receipts_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    receipt_date TEXT NOT NULL,
                    customer_id INTEGER NOT NULL,
                    sender_name TEXT NOT NULL,
                    origin_source TEXT NOT NULL,
                    origin_source_type TEXT,
                    remittance_number TEXT NOT NULL,
                    receiving_station TEXT NOT NULL,
                    amount_received REAL NOT NULL,
                    user_id INTEGER NOT NULL,
                    is_posted INTEGER DEFAULT 1,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `, (err) => {
                if (err) return reject(err);

                // Migration: Add origin_source_type column if it doesn't exist
                db.all("PRAGMA table_info(receipts_logs)", (err, columns) => {
                    if (err) {
                        console.error('Error checking receipts_logs table schema:', err);
                        return;
                    }
                    
                    const columnNames = columns.map(col => col.name);
                    
                    if (!columnNames.includes('origin_source_type')) {
                        db.run('ALTER TABLE receipts_logs ADD COLUMN origin_source_type TEXT', (err) => {
                            if (err) {
                                console.error('Error adding origin_source_type column to receipts_logs:', err);
                            } else {
                                console.log('Migration: Added origin_source_type column to receipts_logs table');
                                
                                // Backfill existing records: extract type from combined origin_source
                                db.run(`
                                    UPDATE receipts_logs 
                                    SET origin_source_type = 
                                        CASE 
                                            WHEN origin_source LIKE 'Bank%' THEN 'Bank'
                                            WHEN origin_source LIKE 'Sarafi%' THEN 'Sarafi'
                                            WHEN origin_source LIKE 'Other%' THEN 'Other'
                                            ELSE 'Unknown'
                                        END
                                    WHERE origin_source_type IS NULL
                                `, (err) => {
                                    if (err) {
                                        console.error('Error backfilling origin_source_type values:', err);
                                    } else {
                                        console.log('Migration: Backfilled origin_source_type values for existing records');
                                    }
                                });
                            }
                        });
                    }
                });
            });

            // 14. ADMIN NOTIFICATIONS TABLE
            db.run(`
                CREATE TABLE IF NOT EXISTS admin_notifications (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    type TEXT NOT NULL,
                    message TEXT NOT NULL,
                    related_record_id INTEGER,
                    related_record_type TEXT,
                    agency_name TEXT,
                    created_by TEXT,
                    recipient TEXT,
                    is_read INTEGER DEFAULT 0,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    read_at DATETIME
                )
            `, (err) => {
                if (err) return reject(err);

                // Add recipient column if it doesn't exist (for existing databases)
                db.all("PRAGMA table_info(admin_notifications)", (err, columns) => {
                    if (err) {
                        console.error('Error checking admin_notifications columns:', err);
                        return;
                    }
                    
                    const hasRecipient = columns.some(col => col.name === 'recipient');
                    if (!hasRecipient) {
                        db.run("ALTER TABLE admin_notifications ADD COLUMN recipient TEXT", (err) => {
                            if (err) {
                                console.error('Error adding recipient column to admin_notifications:', err);
                            } else {
                                console.log('Migration: Added recipient column to admin_notifications table');
                            }
                        });
                    }
                });

                // Create index for faster lookups
                db.run(`
                    CREATE INDEX IF NOT EXISTS idx_notifications_read 
                    ON admin_notifications (is_read, created_at DESC)
                `, (err) => {
                    if (err) console.error('Error creating index for admin_notifications:', err);
                });

                // Create index for recipient filtering
                db.run(`
                    CREATE INDEX IF NOT EXISTS idx_notifications_recipient 
                    ON admin_notifications (recipient)
                `, (err) => {
                    if (err) console.error('Error creating recipient index for admin_notifications:', err);
                });

                // Create index for preventing duplicates
                db.run(`
                    CREATE INDEX IF NOT EXISTS idx_notifications_unique 
                    ON admin_notifications (related_record_id, related_record_type)
                `, (err) => {
                    if (err) console.error('Error creating unique index for admin_notifications:', err);
                });
            });

            // 15. HR MODULE TABLES
            
            // 15.1. DEPARTMENTS TABLE
            db.run(`
                CREATE TABLE IF NOT EXISTS departments (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE,
                    description TEXT,
                    active INTEGER DEFAULT 1,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `, (err) => {
                if (err) return reject(err);
            });

            // 15.2. HR EMPLOYEES TABLE (Enhanced version of worker_profiles)
            db.run(`
                CREATE TABLE IF NOT EXISTS hr_employees (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    employee_id TEXT UNIQUE,
                    full_name TEXT NOT NULL,
                    father_name TEXT,
                    date_of_birth TEXT,
                    gender TEXT,
                    phone TEXT NOT NULL,
                    address TEXT,
                    emergency_contact_name TEXT,
                    emergency_contact_phone TEXT,
                    emergency_contact_relationship TEXT,
                    position TEXT NOT NULL,
                    department_id INTEGER,
                    hire_date TEXT NOT NULL,
                    employment_status TEXT DEFAULT 'Active',
                    supervisor_id INTEGER,
                    work_location TEXT,
                    contract_type TEXT,
                    payment_method TEXT,
                    employment_end_date TEXT,
                    departure_reason TEXT,
                    created_by TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (department_id) REFERENCES departments(id),
                    FOREIGN KEY (supervisor_id) REFERENCES hr_employees(id)
                )
            `, (err) => {
                if (err) return reject(err);

                // Create indexes for frequently searched fields
                db.run(`CREATE INDEX IF NOT EXISTS idx_employees_employee_id ON hr_employees(employee_id)`, (err) => {
                    if (err) console.error('Error creating index for hr_employees.employee_id:', err);
                });
                db.run(`CREATE INDEX IF NOT EXISTS idx_employees_phone ON hr_employees(phone)`, (err) => {
                    if (err) console.error('Error creating index for hr_employees.phone:', err);
                });
                db.run(`CREATE INDEX IF NOT EXISTS idx_employees_department ON hr_employees(department_id)`, (err) => {
                    if (err) console.error('Error creating index for hr_employees.department_id:', err);
                });
                db.run(`CREATE INDEX IF NOT EXISTS idx_employees_position ON hr_employees(position)`, (err) => {
                    if (err) console.error('Error creating index for hr_employees.position:', err);
                });
                db.run(`CREATE INDEX IF NOT EXISTS idx_employees_status ON hr_employees(employment_status)`, (err) => {
                    if (err) console.error('Error creating index for hr_employees.employment_status:', err);
                });
            });

            // 15.3. EMPLOYEE SALARY HISTORY TABLE
            db.run(`
                CREATE TABLE IF NOT EXISTS employee_salary_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    employee_id INTEGER NOT NULL,
                    basic_salary REAL NOT NULL,
                    allowances REAL DEFAULT 0,
                    effective_from TEXT NOT NULL,
                    effective_to TEXT,
                    notes TEXT,
                    created_by TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (employee_id) REFERENCES hr_employees(id) ON DELETE CASCADE
                )
            `, (err) => {
                if (err) return reject(err);
            });

            // 15.4. PAYROLL TABLE
            db.run(`
                CREATE TABLE IF NOT EXISTS payroll (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    employee_id INTEGER NOT NULL,
                    payroll_period TEXT NOT NULL,
                    basic_salary REAL NOT NULL,
                    allowances REAL DEFAULT 0,
                    overtime_amount REAL DEFAULT 0,
                    advance_deduction REAL DEFAULT 0,
                    attendance_deduction REAL DEFAULT 0,
                    other_deductions REAL DEFAULT 0,
                    gross_salary REAL NOT NULL,
                    total_deductions REAL DEFAULT 0,
                    net_salary REAL NOT NULL,
                    due_date TEXT,
                    payment_date TEXT,
                    payment_status TEXT DEFAULT 'Unpaid',
                    payment_method TEXT,
                    payment_reference TEXT,
                    notes TEXT,
                    created_by TEXT,
                    paid_by TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(employee_id, payroll_period),
                    FOREIGN KEY (employee_id) REFERENCES hr_employees(id) ON DELETE CASCADE
                )
            `, (err) => {
                if (err) return reject(err);

                // Create indexes for frequently searched fields
                db.run(`CREATE INDEX IF NOT EXISTS idx_payroll_employee ON payroll(employee_id)`, (err) => {
                    if (err) console.error('Error creating index for payroll.employee_id:', err);
                });
                db.run(`CREATE INDEX IF NOT EXISTS idx_payroll_period ON payroll(payroll_period)`, (err) => {
                    if (err) console.error('Error creating index for payroll.payroll_period:', err);
                });
                db.run(`CREATE INDEX IF NOT EXISTS idx_payroll_status ON payroll(payment_status)`, (err) => {
                    if (err) console.error('Error creating index for payroll.payment_status:', err);
                });
            });

            // 15.5. SALARY ADVANCES TABLE
            db.run(`
                CREATE TABLE IF NOT EXISTS salary_advances (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    employee_id INTEGER NOT NULL,
                    amount REAL NOT NULL,
                    date TEXT NOT NULL,
                    reason TEXT,
                    repayment_amount REAL DEFAULT 0,
                    remaining_balance REAL NOT NULL,
                    status TEXT DEFAULT 'Active',
                    approved_by TEXT,
                    notes TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (employee_id) REFERENCES hr_employees(id) ON DELETE CASCADE
                )
            `, (err) => {
                if (err) return reject(err);
            });

            // 15.6. SALARY ADVANCE REPAYMENTS TABLE
            db.run(`
                CREATE TABLE IF NOT EXISTS salary_advance_repayments (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    advance_id INTEGER NOT NULL,
                    employee_id INTEGER NOT NULL,
                    payroll_id INTEGER,
                    amount REAL NOT NULL,
                    payment_date TEXT NOT NULL,
                    notes TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (advance_id) REFERENCES salary_advances(id) ON DELETE CASCADE,
                    FOREIGN KEY (employee_id) REFERENCES hr_employees(id) ON DELETE CASCADE,
                    FOREIGN KEY (payroll_id) REFERENCES payroll(id) ON DELETE SET NULL
                )
            `, (err) => {
                if (err) return reject(err);
            });

            // 15.7. SALARY DEDUCTIONS TABLE
            db.run(`
                CREATE TABLE IF NOT EXISTS salary_deductions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    employee_id INTEGER NOT NULL,
                    payroll_id INTEGER,
                    deduction_type TEXT NOT NULL,
                    amount REAL NOT NULL,
                    deduction_date TEXT NOT NULL,
                    reason TEXT,
                    approved_by TEXT,
                    notes TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (employee_id) REFERENCES hr_employees(id) ON DELETE CASCADE,
                    FOREIGN KEY (payroll_id) REFERENCES payroll(id) ON DELETE SET NULL
                )
            `, (err) => {
                if (err) return reject(err);
            });

            // 15.8. ATTENDANCE TABLE
            db.run(`
                CREATE TABLE IF NOT EXISTS attendance (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    employee_id INTEGER NOT NULL,
                    attendance_date TEXT NOT NULL,
                    status TEXT NOT NULL,
                    check_in TEXT,
                    check_out TEXT,
                    late_minutes INTEGER DEFAULT 0,
                    overtime_hours REAL DEFAULT 0,
                    notes TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(employee_id, attendance_date),
                    FOREIGN KEY (employee_id) REFERENCES hr_employees(id) ON DELETE CASCADE
                )
            `, (err) => {
                if (err) return reject(err);

                // Create indexes for frequently searched fields
                db.run(`CREATE INDEX IF NOT EXISTS idx_attendance_employee ON attendance(employee_id)`, (err) => {
                    if (err) console.error('Error creating index for attendance.employee_id:', err);
                });
                db.run(`CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(attendance_date)`, (err) => {
                    if (err) console.error('Error creating index for attendance.attendance_date:', err);
                });
            });

            // 15.9. LEAVE TYPES TABLE
            db.run(`
                CREATE TABLE IF NOT EXISTS leave_types (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE,
                    description TEXT,
                    default_days INTEGER DEFAULT 0,
                    active INTEGER DEFAULT 1,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `, (err) => {
                if (err) return reject(err);
            });

            // 15.10. LEAVE REQUESTS TABLE
            db.run(`
                CREATE TABLE IF NOT EXISTS leave_requests (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    employee_id INTEGER NOT NULL,
                    leave_type_id INTEGER NOT NULL,
                    start_date TEXT NOT NULL,
                    end_date TEXT NOT NULL,
                    days INTEGER NOT NULL,
                    reason TEXT,
                    status TEXT DEFAULT 'Pending',
                    approved_by TEXT,
                    approved_at TEXT,
                    notes TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (employee_id) REFERENCES hr_employees(id) ON DELETE CASCADE,
                    FOREIGN KEY (leave_type_id) REFERENCES leave_types(id) ON DELETE CASCADE
                )
            `, (err) => {
                if (err) return reject(err);

                // Create index for frequently searched fields
                db.run(`CREATE INDEX IF NOT EXISTS idx_leave_requests_employee ON leave_requests(employee_id)`, (err) => {
                    if (err) console.error('Error creating index for leave_requests.employee_id:', err);
                });
                db.run(`CREATE INDEX IF NOT EXISTS idx_leave_requests_status ON leave_requests(status)`, (err) => {
                    if (err) console.error('Error creating index for leave_requests.status:', err);
                });
            });

            // 15.11. LEAVE BALANCES TABLE
            db.run(`
                CREATE TABLE IF NOT EXISTS leave_balances (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    employee_id INTEGER NOT NULL,
                    leave_type_id INTEGER NOT NULL,
                    year INTEGER NOT NULL,
                    allocated_days INTEGER DEFAULT 0,
                    used_days INTEGER DEFAULT 0,
                    remaining_days INTEGER DEFAULT 0,
                    UNIQUE(employee_id, leave_type_id, year),
                    FOREIGN KEY (employee_id) REFERENCES hr_employees(id) ON DELETE CASCADE,
                    FOREIGN KEY (leave_type_id) REFERENCES leave_types(id) ON DELETE CASCADE
                )
            `, (err) => {
                if (err) return reject(err);
            });

            // 15.12. OVERTIME TABLE
            db.run(`
                CREATE TABLE IF NOT EXISTS overtime (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    employee_id INTEGER NOT NULL,
                    overtime_date TEXT NOT NULL,
                    hours REAL NOT NULL,
                    rate REAL NOT NULL,
                    total_amount REAL NOT NULL,
                    reason TEXT,
                    status TEXT DEFAULT 'Pending',
                    approved_by TEXT,
                    approved_at TEXT,
                    payroll_id INTEGER,
                    notes TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (employee_id) REFERENCES hr_employees(id) ON DELETE CASCADE,
                    FOREIGN KEY (payroll_id) REFERENCES payroll(id) ON DELETE SET NULL
                )
            `, (err) => {
                if (err) return reject(err);
            });

            // 15.13. DOCUMENT TYPES TABLE
            db.run(`
                CREATE TABLE IF NOT EXISTS document_types (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE,
                    description TEXT,
                    active INTEGER DEFAULT 1,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `, (err) => {
                if (err) return reject(err);
            });

            // 15.14. EMPLOYEE DOCUMENTS TABLE
            db.run(`
                CREATE TABLE IF NOT EXISTS employee_documents (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    employee_id INTEGER NOT NULL,
                    document_type_id INTEGER NOT NULL,
                    document_number TEXT,
                    issue_date TEXT,
                    expiry_date TEXT,
                    file_path TEXT,
                    original_filename TEXT,
                    notes TEXT,
                    uploaded_by TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (employee_id) REFERENCES hr_employees(id) ON DELETE CASCADE,
                    FOREIGN KEY (document_type_id) REFERENCES document_types(id) ON DELETE CASCADE
                )
            `, (err) => {
                if (err) return reject(err);

                // Create index for expiry date tracking
                db.run(`CREATE INDEX IF NOT EXISTS idx_employee_documents_expiry ON employee_documents(expiry_date)`, (err) => {
                    if (err) console.error('Error creating index for employee_documents.expiry_date:', err);
                });
            });

            // 15.15. DISCIPLINARY RECORDS TABLE
            db.run(`
                CREATE TABLE IF NOT EXISTS disciplinary_records (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    employee_id INTEGER NOT NULL,
                    record_date TEXT NOT NULL,
                    type TEXT NOT NULL,
                    description TEXT,
                    action_taken TEXT,
                    issued_by TEXT,
                    document_path TEXT,
                    notes TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (employee_id) REFERENCES hr_employees(id) ON DELETE CASCADE
                )
            `, (err) => {
                if (err) return reject(err);
            });

            // 15.16. PERFORMANCE REVIEWS TABLE
            db.run(`
                CREATE TABLE IF NOT EXISTS performance_reviews (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    employee_id INTEGER NOT NULL,
                    review_period TEXT NOT NULL,
                    attendance_rating INTEGER,
                    work_quality_rating INTEGER,
                    discipline_rating INTEGER,
                    teamwork_rating INTEGER,
                    overall_rating INTEGER,
                    comments TEXT,
                    reviewer_id INTEGER,
                    review_date TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (employee_id) REFERENCES hr_employees(id) ON DELETE CASCADE,
                    FOREIGN KEY (reviewer_id) REFERENCES hr_employees(id) ON DELETE SET NULL
                )
            `, (err) => {
                if (err) return reject(err);

                // Migration: Add reviewer_role column if it doesn't exist
                db.run(`ALTER TABLE performance_reviews ADD COLUMN reviewer_role TEXT`, (err) => {
                    if (err && !err.message.includes('duplicate column')) {
                        console.error('Error adding reviewer_role column to performance_reviews:', err);
                    }
                });
            });

            // 15.17. WORK SCHEDULES TABLE
            db.run(`
                CREATE TABLE IF NOT EXISTS work_schedules (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    expected_check_in TEXT NOT NULL,
                    expected_check_out TEXT NOT NULL,
                    grace_period_minutes INTEGER DEFAULT 10,
                    working_days TEXT DEFAULT '1,2,3,4,5',
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `, (err) => {
                if (err) return reject(err);
            });

            // Migration: Add source column to attendance
            db.run(`ALTER TABLE attendance ADD COLUMN source TEXT DEFAULT 'MANUAL'`, (err) => {
                if (err && !err.message.includes('duplicate column')) {
                    console.error('Error adding source column to attendance:', err);
                }
            });

            // Migration: Add early_departure_minutes column to attendance
            db.run(`ALTER TABLE attendance ADD COLUMN early_departure_minutes INTEGER DEFAULT 0`, (err) => {
                if (err && !err.message.includes('duplicate column')) {
                    console.error('Error adding early_departure_minutes column to attendance:', err);
                }
            });

            // Migration: Add work_schedule_id column to hr_employees
            db.run(`ALTER TABLE hr_employees ADD COLUMN work_schedule_id INTEGER`, (err) => {
                if (err && !err.message.includes('duplicate column')) {
                    console.error('Error adding work_schedule_id column to hr_employees:', err);
                }
            });

            // Migration: Add photo_path column to hr_employees
            db.run(`ALTER TABLE hr_employees ADD COLUMN photo_path TEXT DEFAULT NULL`, (err) => {
                if (err && !err.message.includes('duplicate column')) {
                    console.error('Error adding photo_path column to hr_employees:', err);
                }
            });

            // 15.6. SALARY ADVANCE REPAYMENTS TABLE
            db.run(`
                CREATE TABLE IF NOT EXISTS salary_advance_repayments (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    advance_id INTEGER NOT NULL,
                    amount REAL NOT NULL,
                    date TEXT NOT NULL,
                    notes TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (advance_id) REFERENCES salary_advances(id) ON DELETE CASCADE
                )
            `, (err) => {
                if (err) return reject(err);
            });

            // 16. RECOVERY SYSTEM TABLES
            
            // 16.1. USER RECOVERY KEYS TABLE
            db.run(`
                CREATE TABLE IF NOT EXISTS user_recovery_keys (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    key_hash TEXT NOT NULL,
                    salt TEXT NOT NULL,
                    status TEXT DEFAULT 'active',
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    used_at DATETIME,
                    revoked_at DATETIME,
                    created_by TEXT,
                    encrypted_key TEXT,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                )
            `, (err) => {
                if (err) return reject(err);

                // Create index for user lookup
                db.run(`
                    CREATE INDEX IF NOT EXISTS idx_user_recovery_keys_user 
                    ON user_recovery_keys (user_id)
                `, (err) => {
                    if (err) console.error('Error creating index for user_recovery_keys:', err);
                });

                // Migration: Add salt column if it doesn't exist
                db.run(`ALTER TABLE user_recovery_keys ADD COLUMN salt TEXT`, (err) => {
                    if (err && !err.message.includes('duplicate column')) {
                        console.error('Error adding salt column to user_recovery_keys:', err);
                    }
                });

                // Migration: Add encrypted_key column if it doesn't exist
                db.run(`ALTER TABLE user_recovery_keys ADD COLUMN encrypted_key TEXT`, (err) => {
                    if (err && !err.message.includes('duplicate column')) {
                        console.error('Error adding encrypted_key column to user_recovery_keys:', err);
                    } else {
                        console.log('Migration: Added encrypted_key column to user_recovery_keys table');
                    }
                });
            });

            // 16.2. ADMIN RECOVERY CODES TABLE
            db.run(`
                CREATE TABLE IF NOT EXISTS admin_recovery_codes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    admin_id INTEGER NOT NULL,
                    code_hash TEXT NOT NULL,
                    salt TEXT NOT NULL,
                    status TEXT DEFAULT 'active',
                    batch_id TEXT NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    used_at DATETIME,
                    revoked_at DATETIME,
                    encrypted_code TEXT,
                    FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE CASCADE
                )
            `, (err) => {
                if (err) return reject(err);

                // Create indexes for admin lookup and batch tracking
                db.run(`
                    CREATE INDEX IF NOT EXISTS idx_admin_recovery_codes_admin 
                    ON admin_recovery_codes (admin_id)
                `, (err) => {
                    if (err) console.error('Error creating index for admin_recovery_codes (admin):', err);
                });

                db.run(`
                    CREATE INDEX IF NOT EXISTS idx_admin_recovery_codes_batch 
                    ON admin_recovery_codes (batch_id)
                `, (err) => {
                    if (err) console.error('Error creating index for admin_recovery_codes (batch):', err);
                });

                // Migration: Add salt column if it doesn't exist
                db.run(`ALTER TABLE admin_recovery_codes ADD COLUMN salt TEXT`, (err) => {
                    if (err && !err.message.includes('duplicate column')) {
                        console.error('Error adding salt column to admin_recovery_codes:', err);
                    }
                });

                // Migration: Add encrypted_code column if it doesn't exist
                db.run(`ALTER TABLE admin_recovery_codes ADD COLUMN encrypted_code TEXT`, (err) => {
                    if (err && !err.message.includes('duplicate column')) {
                        console.error('Error adding encrypted_code column to admin_recovery_codes:', err);
                    } else {
                        console.log('Migration: Added encrypted_code column to admin_recovery_codes table');
                    }
                });
            });

            // 16.3. PASSWORD RECOVERY REQUESTS TABLE
            db.run(`
                CREATE TABLE IF NOT EXISTS password_recovery_requests (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    request_id TEXT UNIQUE NOT NULL,
                    status TEXT DEFAULT 'pending',
                    reason TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    reviewed_at DATETIME,
                    reviewed_by INTEGER,
                    completed_at DATETIME,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (reviewed_by) REFERENCES users(id)
                )
            `, (err) => {
                if (err) return reject(err);

                // Create index for request lookup
                db.run(`
                    CREATE INDEX IF NOT EXISTS idx_password_recovery_requests_user 
                    ON password_recovery_requests (user_id)
                `, (err) => {
                    if (err) console.error('Error creating index for password_recovery_requests:', err);
                });
            });

            // 16.4. PASSWORD RESET AUTHORIZATIONS TABLE
            db.run(`
                CREATE TABLE IF NOT EXISTS password_reset_authorizations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    token_hash TEXT NOT NULL UNIQUE,
                    expires_at DATETIME NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    used_at DATETIME,
                    revoked_at DATETIME,
                    recovery_key_id INTEGER,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                )
            `, (err) => {
                if (err) return reject(err);

                // Create index for token lookup
                db.run(`
                    CREATE INDEX IF NOT EXISTS idx_password_reset_authorizations_user 
                    ON password_reset_authorizations (user_id)
                `, (err) => {
                    if (err) console.error('Error creating index for password_reset_authorizations:', err);
                });

                // Migration: Add recovery_key_id column if it doesn't exist
                db.all("PRAGMA table_info(password_reset_authorizations)", (err, columns) => {
                    if (err) {
                        console.error('Error checking password_reset_authorizations columns:', err);
                        return;
                    }
                    
                    const hasRecoveryKeyId = columns.some(col => col.name === 'recovery_key_id');
                    if (!hasRecoveryKeyId) {
                        db.run("ALTER TABLE password_reset_authorizations ADD COLUMN recovery_key_id INTEGER", (err) => {
                            if (err) {
                                console.error('Error adding recovery_key_id column to password_reset_authorizations:', err);
                            } else {
                                console.log('Migration: Added recovery_key_id column to password_reset_authorizations table');
                            }
                        });
                    }
                });
            });

            // 16.5. RECOVERY AUDIT LOG TABLE
            db.run(`
                CREATE TABLE IF NOT EXISTS recovery_audit_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    actor_id INTEGER,
                    action TEXT NOT NULL,
                    details TEXT,
                    ip_address TEXT,
                    result TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (actor_id) REFERENCES users(id)
                )
            `, (err) => {
                if (err) return reject(err);

                // Create index for audit log queries
                db.run(`
                    CREATE INDEX IF NOT EXISTS idx_recovery_audit_log_user 
                    ON recovery_audit_log (user_id, created_at DESC)
                `, (err) => {
                    if (err) console.error('Error creating index for recovery_audit_log:', err);
                });

                // H6/M10/L10: this boot-time auto-backfill was removed on security review.
                // It generated recovery credentials on every start WITHOUT storing the
                // decryptable copy (admins got hash-only codes that could never be shown
                // again), and it logged a freshly generated plaintext recovery key to
                // stdout (H6). Credentials are now created only through the explicit
                // admin flows (recoveryController), which store the encrypted value for
                // one-time display, honour rate limits, and never log secret material.
            });

            // 16. HOMEPAGE CMS MULTILINGUAL STRUCTURE
            
            // 16.1. HOMEPAGE TRANSLATIONS TABLE
            db.run(`
                CREATE TABLE IF NOT EXISTS homepage_translations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    language TEXT NOT NULL,
                    section TEXT NOT NULL,
                    field TEXT NOT NULL,
                    value TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(language, section, field)
                )
            `, (err) => {
                if (err) return reject(err);

                // Create index for faster lookups
                db.run(`
                    CREATE INDEX IF NOT EXISTS idx_homepage_translations_lookup 
                    ON homepage_translations (language, section, field)
                `, (err) => {
                    if (err) console.error('Error creating index for homepage_translations:', err);
                });
            });

            // 16.2. HOMEPAGE MEDIA TABLE
            db.run(`
                CREATE TABLE IF NOT EXISTS homepage_media (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    media_key TEXT NOT NULL UNIQUE,
                    file_path TEXT,
                    original_filename TEXT,
                    mime_type TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `, (err) => {
                if (err) return reject(err);

                // Create index for media key lookups
                db.run(`
                    CREATE INDEX IF NOT EXISTS idx_homepage_media_key 
                    ON homepage_media (media_key)
                `, (err) => {
                    if (err) console.error('Error creating index for homepage_media:', err);
                });
            });

            // 16.3. HOMEPAGE PRODUCTS TABLE
            db.run(`
                CREATE TABLE IF NOT EXISTS homepage_products (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    image_path TEXT,
                    display_order INTEGER DEFAULT 0,
                    is_active INTEGER DEFAULT 1,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `, (err) => {
                if (err) return reject(err);

                // Create index for ordering
                db.run(`
                    CREATE INDEX IF NOT EXISTS idx_homepage_products_order 
                    ON homepage_products (display_order)
                `, (err) => {
                    if (err) console.error('Error creating index for homepage_products:', err);
                });

                // Create index for active products
                db.run(`
                    CREATE INDEX IF NOT EXISTS idx_homepage_products_active 
                    ON homepage_products (is_active)
                `, (err) => {
                    if (err) console.error('Error creating index for homepage_products.active:', err);
                });
            });

            // 16.4. HOMEPAGE PRODUCT TRANSLATIONS TABLE
            db.run(`
                CREATE TABLE IF NOT EXISTS homepage_product_translations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    product_id INTEGER NOT NULL,
                    language TEXT NOT NULL,
                    name TEXT,
                    description TEXT,
                    specifications TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(product_id, language),
                    FOREIGN KEY (product_id) REFERENCES homepage_products(id) ON DELETE CASCADE
                )
            `, (err) => {
                if (err) return reject(err);

                // Create index for product lookups
                db.run(`
                    CREATE INDEX IF NOT EXISTS idx_homepage_product_translations_product 
                    ON homepage_product_translations (product_id)
                `, (err) => {
                    if (err) console.error('Error creating index for homepage_product_translations:', err);
                });

                // Create index for language lookups
                db.run(`
                    CREATE INDEX IF NOT EXISTS idx_homepage_product_translations_language 
                    ON homepage_product_translations (language)
                `, (err) => {
                    if (err) console.error('Error creating index for homepage_product_translations.language:', err);
                });
            });

            // Migrate existing homepage_content data to homepage_translations
            migrateHomepageContentToTranslations(db);

            // Seed default HR data (departments, leave types, document types)
            db.get("SELECT COUNT(*) as count FROM departments", (err, row) => {
                if (err) {
                    db.close();
                    return reject(err);
                }
                
                if (row.count === 0) {
                    console.log('🌱 Seeding default HR data for fresh installation...');
                    
                    // Seed departments
                    const departments = [
                        ['Management', 'Company management and administration'],
                        ['Accounting', 'Finance and accounting department'],
                        ['Transport', 'Truck drivers and logistics'],
                        ['Production', 'Cement production and manufacturing'],
                        ['Maintenance', 'Equipment and facility maintenance'],
                        ['Security', 'Security and safety personnel'],
                        ['Sales', 'Sales and marketing department'],
                        ['Administration', 'General administration and office staff']
                    ];
                    
                    departments.forEach((dept, index) => {
                        db.run('INSERT INTO departments (name, description) VALUES (?, ?)', dept, (err) => {
                            if (err) console.error('Error seeding department:', err);
                        });
                    });
                    
                    // Seed leave types
                    const leaveTypes = [
                        ['Annual', 'Annual paid leave', 20],
                        ['Sick', 'Sick leave for illness', 10],
                        ['Emergency', 'Emergency leave for urgent matters', 5],
                        ['Unpaid', 'Unpaid leave without salary', 0]
                    ];
                    
                    leaveTypes.forEach((leave, index) => {
                        db.run('INSERT INTO leave_types (name, description, default_days) VALUES (?, ?, ?)', leave, (err) => {
                            if (err) console.error('Error seeding leave type:', err);
                        });
                    });
                    
                    // Seed document types
                    const documentTypes = [
                        ['Tazkira', 'National ID card'],
                        ['Contract', 'Employment contract'],
                        ['Driver License', 'Driver\'s license'],
                        ['Certificate', 'Training or qualification certificate'],
                        ['Training Certificate', 'Training completion certificate'],
                        ['Other', 'Other HR documents']
                    ];
                    
                    documentTypes.forEach((doc, index) => {
                        db.run('INSERT INTO document_types (name, description) VALUES (?, ?)', doc, (err) => {
                            if (err) console.error('Error seeding document type:', err);
                        });
                    });
                    
                    console.log('✅ Default HR data seeded');
                } else {
                    console.log(`✅ Found ${row.count} existing department(s) - skipping HR data seed`);
                }
            });
            
            // Seed default admin account only if completely empty database instance
            // NOTE: This only runs when users table is completely empty (fresh installation)
            db.get("SELECT COUNT(*) as count FROM users", (err, row) => {
                if (err) {
                    db.close();
                    return reject(err);
                }
                
                if (row.count === 0) {
                    console.log('🌱 Seeding default admin account for fresh installation...');
                    const adminPassword = process.env.ADMIN_PASSWORD;
                    if (!adminPassword) {
                        db.close();
                        return reject(new Error('ADMIN_PASSWORD environment variable is required for fresh installation'));
                    }
                    bcrypt.hash(adminPassword, BCRYPT_SALT_ROUNDS, (hashErr, hashedPassword) => {
                        if (hashErr) {
                            db.close();
                            return reject(hashErr);
                        }
                        db.run("INSERT INTO users (username, password, role, assigned_province) VALUES (?, ?, ?, ?)", 
                            ['admin', hashedPassword, 'admin', 'Herat'], (err) => {
                                if (err) {
                                    db.close();
                                    return reject(err);
                                }
                                console.log('✅ Default admin account created (username: admin)');
                                
                                // After admin is seeded, seed homepage content
                                seedHomepageContent(db, resolve, reject);
                            });
                    });
                } else {
                    console.log(`✅ Found ${row.count} existing user(s) - skipping admin seed`);
                    // Users already exist, just seed homepage content
                    seedHomepageContent(db, resolve, reject);
                }
            });
        });
    });
}

function migrateHomepageContentToTranslations(db) {
    db.get("SELECT COUNT(*) as count FROM homepage_translations", (err, row) => {
        if (err) {
            console.error('Error checking homepage_translations for migration:', err);
            return;
        }
        
        // Only migrate if translations table is empty (first-time migration)
        if (row.count === 0) {
            console.log('🔄 Migrating existing homepage_content to homepage_translations...');
            
            db.get('SELECT * FROM homepage_content WHERE id = 1', (err, content) => {
                if (err) {
                    console.error('Error fetching homepage_content for migration:', err);
                    return;
                }
                
                if (content) {
                    const translations = [
                        // Hero section
                        ['en', 'hero', 'headline', content.hero_headline],
                        ['en', 'hero', 'subtext', content.hero_subtext],
                        // About section
                        ['en', 'about', 'story', content.about_story],
                        ['en', 'about', 'mission', content.company_mission],
                        ['en', 'about', 'vision', content.company_vision]
                    ];
                    
                    let completed = 0;
                    translations.forEach((translation, index) => {
                        db.run(`
                            INSERT INTO homepage_translations (language, section, field, value)
                            VALUES (?, ?, ?, ?)
                        `, translation, (err) => {
                            if (err) {
                                console.error(`Error inserting translation ${index}:`, err);
                            } else {
                                completed++;
                                if (completed === translations.length) {
                                    console.log('✅ Homepage content migrated to translations table');
                                }
                            }
                        });
                    });
                } else {
                    console.log('ℹ️ No existing homepage_content found to migrate');
                }
            });
        } else {
            console.log(`✅ Found ${row.count} existing translation(s) - skipping migration`);
        }
    });
}

function seedHomepageContent(db, resolve, reject) {
    db.get("SELECT COUNT(*) as count FROM homepage_content", (err, row) => {
        if (err) {
            db.close();
            return reject(err);
        }
        
        if (row.count === 0) {
            console.log('🌱 Seeding default homepage content for fresh installation...');
            db.run(`
                INSERT INTO homepage_content (id, hero_headline, hero_subtext, about_story, company_mission, company_vision)
                VALUES (1, ?, ?, ?, ?, ?)
            `, [
                'Premium Quality Cement for Stronger Construction',
                'Driving modern infrastructure and structural stability across provinces with elite international manufacturing standards.',
                'Baqran Cement Enterprise delivers top-tier industrial strength solutions tailored for high-durability projects.',
                'To supply premium construction materials safely, efficiently, and transparently.',
                'Building a resilient, sustainable future for global infrastructure.'
            ], (err) => {
                if (err) {
                    db.close();
                    return reject(err);
                }
                console.log('✅ Default homepage content created');
                
                db.close((err) => {
                    if (err) return reject(err);
                    resolve();
                });
            });
        } else {
            console.log(`✅ Found ${row.count} existing homepage content record(s) - skipping homepage seed`);
            db.close((err) => {
                if (err) return reject(err);
                resolve();
            });
        }
    });
}

module.exports = { getDbConnection, initDb, PROVINCE_CODES };
// Absolute path of the database file this config opens. Exported so tooling
// (e.g. scripts/reset-database.js) can display exactly the file it targets
// instead of duplicating the path logic.
module.exports.dbPath = dbPath;
