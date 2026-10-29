const { getDbConnection } = require('../config/database');

// The cement_stock table is owned by this feature module (no other file creates it).
// Waybill sales registered through /admin/local-waybill are stored as source='waybill'
// rows with negative bags, so the net stock of a cement type = SUM(bags) over all rows.
// Entries added on the stock page keep source='entry' (the default) and are the only
// rows shown in the Registered Stock table / KPI cards.
// getDbConnection() returns a fresh connection in parallelize mode, so the CREATE and
// the column migrations run on their own serialized connection: every caller waits for
// ensureCementStock() before queueing its queries.
let tableReady = false;
let ensureWaiters = null;

function ensureCementStock(cb) {
    if (tableReady) return cb();
    if (ensureWaiters) {
        ensureWaiters.push(cb);
        return;
    }
    ensureWaiters = [cb];
    const finish = () => {
        const waiters = ensureWaiters;
        ensureWaiters = null;
        waiters.forEach((fn) => fn());
    };

    const db = getDbConnection();
    db.serialize();
    let failed = false;

    db.run(`
        CREATE TABLE IF NOT EXISTS cement_stock (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cement_type TEXT NOT NULL,
            bags REAL NOT NULL,
            tonnage REAL NOT NULL,
            price_per_bag REAL NOT NULL,
            stock_date TEXT NOT NULL,
            created_by TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            source TEXT DEFAULT 'entry',
            waybill_id INTEGER
        )
    `, (err) => {
        if (err && !/already exists/i.test(err.message || '')) {
            failed = true;
            console.error('[ERROR] cement_stock table ensure failed:', err);
        }
        // Databases created before the waybill link get the new columns here;
        // on fresh tables the columns already exist and this error is ignored.
        db.run(`ALTER TABLE cement_stock ADD COLUMN source TEXT DEFAULT 'entry'`, (err2) => {
            if (err2 && !/duplicate column/i.test(err2.message || '')) {
                failed = true;
                console.error('[ERROR] cement_stock source column ensure failed:', err2);
            }
            db.run(`ALTER TABLE cement_stock ADD COLUMN waybill_id INTEGER`, (err3) => {
                if (err3 && !/duplicate column/i.test(err3.message || '')) {
                    failed = true;
                    console.error('[ERROR] cement_stock waybill_id column ensure failed:', err3);
                }
                if (!failed) tableReady = true;
                db.close();
                finish();
            });
        });
    });
}

// Registered stock only: the waybill deduction rows are surfaced through the summary.
const REGISTERED_FILTER = `COALESCE(source, 'entry') <> 'waybill'`;

// Net bags per registry cement type (entries minus waybill sales)
const AVAILABILITY_SQL = `
    SELECT ct.cement_name AS cement_type,
           COALESCE((SELECT SUM(cs.bags) FROM cement_stock cs WHERE cs.cement_type = ct.cement_name), 0) AS available
    FROM cement_types ct
    ORDER BY ct.id ASC
`;

// GET /admin/stock — main stock page: totals cards + entries table + summary rows
function stockDashboard(req, res) {
    const db = getDbConnection();
    ensureCementStock(() => {
        db.get(`
            SELECT
                COALESCE(SUM(bags), 0) AS total_bags,
                COALESCE(SUM(tonnage), 0) AS total_tonnage,
                COALESCE(SUM(bags * price_per_bag), 0) AS total_money
            FROM cement_stock
            WHERE ${REGISTERED_FILTER}
        `, (err, totals) => {
            if (err) {
                db.close();
                console.error('[ERROR] cement stock totals:', err);
                return res.status(500).send('Database error');
            }
            db.all(`SELECT * FROM cement_stock WHERE ${REGISTERED_FILTER} ORDER BY stock_date DESC, id DESC`, (err2, rows) => {
                db.close();
                if (err2) {
                    console.error('[ERROR] cement stock list:', err2);
                    return res.status(500).send('Database error');
                }
                res.render('admin_stock', {
                    title: res.locals.t('stock.title'),
                    totals: totals || { total_bags: 0, total_tonnage: 0, total_money: 0 },
                    entries: rows || []
                });
            });
        });
    });
}

// GET /admin/stock/summary — full page per cement type: available bags, tonnage and money
// (waybill sales are already subtracted; their out-rows carry price 0 so money stays registered)
function stockSummaryPage(req, res) {
    const db = getDbConnection();
    ensureCementStock(() => {
        db.all(`
            SELECT ct.cement_name AS cement_type,
                   COALESCE(SUM(cs.bags), 0) AS available_bags,
                   COALESCE(SUM(cs.tonnage), 0) AS available_tonnage,
                   COALESCE(SUM(cs.bags * cs.price_per_bag), 0) AS total_money
            FROM cement_types ct
            LEFT JOIN cement_stock cs ON cs.cement_type = ct.cement_name
            GROUP BY ct.id, ct.cement_name
            ORDER BY ct.id ASC
        `, (err, rows) => {
            db.close();
            if (err) {
                console.error('[ERROR] cement stock summary page:', err);
                return res.status(500).send('Database error');
            }
            res.render('admin_stock_summary', {
                title: res.locals.t('stock.summary_title'),
                summary: rows || []
            });
        });
    });
}

// GET /admin/stock/add — add-new form (dropdown fed by the existing cement_types registry)
function stockAddForm(req, res) {
    const db = getDbConnection();
    ensureCementStock(() => {
        db.all('SELECT id, cement_name FROM cement_types ORDER BY id ASC', (err, cementTypes) => {
            db.close();
            if (err) {
                console.error('[ERROR] cement types for stock form:', err);
                return res.status(500).send('Database error');
            }
            res.render('admin_stock_add', {
                title: res.locals.t('stock.add_title'),
                cementTypes: cementTypes || [],
                error: null,
                form: {}
            });
        });
    });
}

// POST /admin/stock/add — register a new stock entry
function stockAdd(req, res) {
    const cementType = (req.body.cement_type || '').trim();
    const bagsRaw = (req.body.bags || '').trim();
    const tonnageRaw = (req.body.tonnage || '').trim();
    const priceRaw = (req.body.price_per_bag || '').trim();
    const stockDate = (req.body.stock_date || '').trim();

    const bags = bagsRaw === '' ? null : Number(bagsRaw);
    let tonnage = tonnageRaw === '' ? null : Number(tonnageRaw);
    let bagsFinal = bags;
    const pricePerBag = priceRaw === '' ? null : Number(priceRaw);

    const fail = (error) => {
        const db = getDbConnection();
        ensureCementStock(() => {
            db.all('SELECT id, cement_name FROM cement_types ORDER BY id ASC', (err, cementTypes) => {
                db.close();
                res.status(400).render('admin_stock_add', {
                    title: res.locals.t('stock.add_title'),
                    cementTypes: cementTypes || [],
                    error: error,
                    form: { cement_type: cementType, bags: bagsRaw, tonnage: tonnageRaw, price_per_bag: priceRaw, stock_date: stockDate }
                });
            });
        });
    };

    if (!cementType) return fail(res.locals.t('stock.err_type'));
    if (bags === null && tonnage === null) return fail(res.locals.t('stock.err_amount'));
    if ((bags !== null && (isNaN(bags) || bags <= 0)) || (tonnage !== null && (isNaN(tonnage) || tonnage <= 0))) {
        return fail(res.locals.t('stock.err_amount'));
    }
    if (pricePerBag === null || isNaN(pricePerBag) || pricePerBag <= 0) return fail(res.locals.t('stock.err_price'));
    if (!stockDate) return fail(res.locals.t('stock.err_date'));

    // Auto-fill the missing side: 20 bags = 1 ton (same as waybills)
    if (bagsFinal === null) bagsFinal = tonnage * 20;
    if (tonnage === null) tonnage = bagsFinal / 20;

    const db = getDbConnection();
    ensureCementStock(() => {
        db.run(
            'INSERT INTO cement_stock (cement_type, bags, tonnage, price_per_bag, stock_date, created_by) VALUES (?, ?, ?, ?, ?, ?)',
            [cementType, bagsFinal, tonnage, pricePerBag, stockDate, req.session.username || null],
            function (err) {
                db.close();
                if (err) {
                    console.error('[ERROR] cement stock insert:', err);
                    return res.status(500).send('Database error');
                }
                res.redirect('/admin/stock');
            }
        );
    });
}

// ---------------------------------------------------------------------------
// Shared with adminController (local-waybill <-> cement stock link)
// ---------------------------------------------------------------------------

// Availability map { cement_type: netBags } for the registry cement types
function getStockAvailability(cb) {
    ensureCementStock(() => {
        const db = getDbConnection();
        db.all(AVAILABILITY_SQL, (err, rows) => {
            db.close();
            if (err) return cb(err);
            const map = {};
            rows.forEach((r) => { map[r.cement_type] = Number(r.available) || 0; });
            cb(null, map);
        });
    });
}

// Gate for a waybill sale: cb(null) = allowed, cb('insufficient_stock') = not enough
// bags, cb('db') = database error. Untracked / empty cement types are not gated
// (they keep the legacy behavior of the waybill form).
function assertSaleWithinStock(cementType, bags, excludeWaybillId, cb) {
    const type = (cementType || '').trim();
    if (!type) return cb(null);
    ensureCementStock(() => {
        const db = getDbConnection();
        db.get('SELECT cement_name FROM cement_types WHERE cement_name = ?', [type], (errT, reg) => {
            if (errT) {
                db.close();
                return cb('db');
            }
            if (!reg) {
                db.close();
                return cb(null);
            }
            const excludeSql = excludeWaybillId
                ? " AND NOT (COALESCE(source, '') = 'waybill' AND waybill_id = ?)"
                : '';
            const params = excludeWaybillId ? [type, excludeWaybillId] : [type];
            db.get(`SELECT COALESCE(SUM(bags), 0) AS avail FROM cement_stock WHERE cement_type = ?${excludeSql}`, params, (errS, row) => {
                db.close();
                if (errS) return cb('db');
                const avail = row ? Number(row.avail) || 0 : 0;
                cb(bags > avail ? 'insufficient_stock' : null);
            });
        });
    });
}

// Replace the stock deduction row of a waybill (or remove it when the type is
// untracked / no bags). Called after a waybill is saved or edited.
function upsertStockSale(sale, cb) {
    ensureCementStock(() => {
        const db = getDbConnection();
        db.run(`DELETE FROM cement_stock WHERE source = 'waybill' AND waybill_id = ?`, [sale.waybillId], (errDel) => {
            if (errDel) {
                db.close();
                return cb(errDel);
            }
            const type = (sale.cementType || '').trim();
            const bags = Number(sale.bags) || 0;
            if (!type || bags <= 0) {
                db.close();
                return cb(null);
            }
            db.get('SELECT cement_name FROM cement_types WHERE cement_name = ?', [type], (errT, reg) => {
                if (errT) {
                    db.close();
                    return cb(errT);
                }
                if (!reg) {
                    db.close();
                    return cb(null);
                }
                db.run(
                    `INSERT INTO cement_stock (cement_type, bags, tonnage, price_per_bag, stock_date, created_by, source, waybill_id)
                     VALUES (?, ?, ?, 0, ?, ?, 'waybill', ?)`,
                    [type, -bags, -(bags / 20), sale.stockDate || '', sale.createdBy || null, sale.waybillId],
                    function (errIns) {
                        db.close();
                        cb(errIns || null);
                    }
                );
            });
        });
    });
}

// Remove the stock deduction row of a waybill (legacy waybills have none — no-op)
function removeStockSale(waybillId, cb) {
    ensureCementStock(() => {
        const db = getDbConnection();
        db.run(`DELETE FROM cement_stock WHERE source = 'waybill' AND waybill_id = ?`, [waybillId], (err) => {
            db.close();
            cb(err || null);
        });
    });
}

// Does this waybill carry a stock deduction row? (only waybills saved after the
// cement stock link are tracked)
function hasStockSale(waybillId, cb) {
    ensureCementStock(() => {
        const db = getDbConnection();
        db.get(`SELECT id FROM cement_stock WHERE source = 'waybill' AND waybill_id = ?`, [waybillId], (err, row) => {
            db.close();
            if (err) return cb(err);
            cb(null, !!row);
        });
    });
}

module.exports = {
    stockDashboard,
    stockSummaryPage,
    stockAddForm,
    stockAdd,
    ensureCementStock,
    getStockAvailability,
    assertSaleWithinStock,
    upsertStockSale,
    removeStockSale,
    hasStockSale
};
