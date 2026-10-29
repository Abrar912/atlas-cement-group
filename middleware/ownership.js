'use strict';
// H3/H4 write-side IDOR guards for worker financial endpoints.
//
// A worker may only:
//   - post sales / receipts against customers they own (customers.created_by),
//   - mutate waybills sold to them (local_waybills.selled_to_agent).
// A customer whose creator is not a worker account (admin-created or legacy
// rows without a creator) is company-shared and stays accessible to every
// worker; customers registered by OTHER workers are blocked.
//
// These guards run as route middleware BEFORE the transactional controllers,
// which keeps the hr19-pinned transaction functions (workerAddSalesBatch and
// friends) byte-stable while enforcing ownership on every request.

const { getDbConnection } = require('../config/database');

function deny(res, message) {
    return res.status(403).json({ success: false, message: message, error: message });
}

// Mirror the controller's own reference semantics: a numeric value addresses
// customers.id, anything else is the customer business code (customer_id).
function customerRef(value) {
    const asInt = parseInt(value, 10);
    if (!isNaN(asInt)) {
        return { column: 'id', value: asInt };
    }
    return { column: 'customer_id', value: String(value == null ? '' : value).trim() };
}

function placeholders(n) {
    return new Array(n).fill('?').join(',');
}

// Resolve every customer reference and verify access for the session worker.
// Fail-closed: unknown ids/codes are rejected (prevents orphan financial rows
// too, since SQLite does not enforce foreign keys here).
function checkCustomers(db, username, refs, done) {
    const idRefs = [...new Set(refs.filter((r) => r.column === 'id').map((r) => r.value))];
    const codeRefs = [...new Set(refs.filter((r) => r.column === 'customer_id').map((r) => r.value))];
    const found = new Map(); // key: 'id:5' / 'code:KAB-001' -> { created_by, creator_role }

    let pending = 0;
    let failed = false;

    const finish = () => {
        if (failed) return;
        if (pending > 0) return;
        for (const ref of refs) {
            const key = (ref.column === 'id' ? 'id:' : 'code:') + ref.value;
            const row = found.get(key);
            if (!row) return done(new Error('not_found'));
            const owned = String(row.created_by || '').toLowerCase() === String(username).toLowerCase();
            const shared = row.creator_role !== 'worker'; // admin-created / legacy / orphan creator
            if (!owned && !shared) return done(new Error('foreign'));
        }
        return done(null);
    };

    if (idRefs.length > 0) {
        pending++;
        db.all(
            `SELECT c.id, c.created_by, u.role AS creator_role
             FROM customers c LEFT JOIN users u ON LOWER(u.username) = LOWER(c.created_by)
             WHERE c.id IN (${placeholders(idRefs.length)})`,
            idRefs,
            (err, rows) => {
                if (failed) return;
                if (err) { failed = true; return done(err); }
                for (const r of rows || []) found.set('id:' + r.id, r);
                pending--;
                finish();
            }
        );
    }
    if (codeRefs.length > 0) {
        pending++;
        db.all(
            `SELECT c.customer_id, c.created_by, u.role AS creator_role
             FROM customers c LEFT JOIN users u ON LOWER(u.username) = LOWER(c.created_by)
             WHERE c.customer_id IN (${placeholders(codeRefs.length)})`,
            codeRefs,
            (err, rows) => {
                if (failed) return;
                if (err) { failed = true; return done(err); }
                for (const r of rows || []) found.set('code:' + r.customer_id, r);
                pending--;
                finish();
            }
        );
    }
    if (pending === 0) finish();
}

// Verify every waybill id is sold to the session worker. Fail-closed.
function checkWaybills(db, username, ids, done) {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return done(null);
    db.all(
        `SELECT id FROM local_waybills WHERE id IN (${placeholders(unique.length)}) AND LOWER(selled_to_agent) = LOWER(?)`,
        [...unique, username],
        (err, rows) => {
            if (err) return done(err);
            return (rows || []).length === unique.length ? done(null) : done(new Error('foreign'));
        }
    );
}

// POST /worker/add-sales-batch and POST /worker/add-receipts-batch
// Body: { batch: [ { customer_id: <int customers.id>, ... } ] }
function verifySalesBatchOwnership(req, res, next) {
    if (!isWorkerSession(req)) return next();
    const batch = (req.body && req.body.batch) || [];
    if (!Array.isArray(batch) || batch.length === 0) return next();
    const refs = batch.map((item) => customerRef(item && item.customer_id));
    const db = getDbConnection();
    checkCustomers(db, req.session.username, refs, (err) => {
        db.close();
        if (err) {
            return deny(res, 'One or more customers are not registered by this agency');
        }
        return next();
    });
}

// POST /api/worker/commit-waybill-sales-batch
// Body: { salesBatch: [ { waybill_id, customer_id: <code or int>, ... } ] }
function verifyWaybillSalesBatchOwnership(req, res, next) {
    if (!isWorkerSession(req)) return next();
    const batch = (req.body && req.body.salesBatch) || [];
    if (!Array.isArray(batch) || batch.length === 0) return next();
    const waybillIds = batch.map((item) => parseInt(item && item.waybill_id, 10)).filter((n) => Number.isFinite(n));
    const refs = batch.map((item) => customerRef(item && item.customer_id));
    const db = getDbConnection();
    checkWaybills(db, req.session.username, waybillIds, (wbErr) => {
        if (wbErr) {
            db.close();
            return deny(res, 'One or more waybills are not assigned to this agency');
        }
        checkCustomers(db, req.session.username, refs, (cErr) => {
            db.close();
            if (cErr) {
                return deny(res, 'One or more customers are not registered by this agency');
            }
            return next();
        });
    });
}

// POST /api/worker/sell-waybill-direct
// Body: { waybill_id, customer_id: <code or int>, ... }
function verifySellDirectOwnership(req, res, next) {
    if (!isWorkerSession(req)) return next();
    const waybillId = parseInt(req.body && req.body.waybill_id, 10);
    if (!Number.isFinite(waybillId)) return next(); // controller rejects missing/invalid ids itself
    const db = getDbConnection();
    checkWaybills(db, req.session.username, [waybillId], (wbErr) => {
        if (wbErr) {
            db.close();
            return deny(res, 'This waybill is not assigned to this agency');
        }
        const customerId = req.body.customer_id;
        if (customerId === undefined || customerId === null || String(customerId).trim() === '') return next();
        checkCustomers(db, req.session.username, [customerRef(customerId)], (cErr) => {
            db.close();
            if (cErr) {
                return deny(res, 'This customer is not registered by this agency');
            }
            return next();
        });
    });
}

// POST /api/worker/mark-waybill-in-queue and POST /api/worker/mark-waybill-available
// Body: { waybill_id }
function verifyWaybillOwnership(req, res, next) {
    if (!isWorkerSession(req)) return next();
    const waybillId = parseInt(req.body && req.body.waybill_id, 10);
    if (!Number.isFinite(waybillId)) return next(); // controller rejects missing ids itself
    const db = getDbConnection();
    checkWaybills(db, req.session.username, [waybillId], (err) => {
        db.close();
        if (err) {
            return deny(res, 'This waybill is not assigned to this agency');
        }
        return next();
    });
}

function isWorkerSession(req) {
    return !!(req.session && req.session.role === 'worker');
}

module.exports = {
    verifySalesBatchOwnership,
    verifyWaybillSalesBatchOwnership,
    verifySellDirectOwnership,
    verifyWaybillOwnership
};
