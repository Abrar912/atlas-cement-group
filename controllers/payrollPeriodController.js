'use strict';

/**
 * PHASE 20B — Salary Obligation period opening + correction + listing.
 * Explicit period opening (rule 32), cutover 1405/07/01 (rules 33/35),
 * integer cents (D-1), employee isolation (rule 37), zero-entitlement skip
 * (rule 38), UNIQUE(employee, month) duplicate prevention (rule 39),
 * one transaction, per-obligation payment_audit rows, ONE notification (rule 42).
 * Uses the FROZEN Phase 19 engine — no calculation logic is duplicated here.
 */

const path = require('path');
const notificationSSE = require('../utils/notificationSSE');
const { getCurrentJalaliDate, validateJalaliDate } = require('../middleware/i18n');
const { calculateEntitlement } = require('../utils/salaryEntitlementEngine');

const DB_PATH = path.join(__dirname, '..', 'enterprise_cement.db');
const CUTOVER = '1405/07/01';

function openDb(readOnly) {
  const { DatabaseSync } = require('node:sqlite');
  const db = readOnly ? new DatabaseSync(DB_PATH, { readOnly: true }) : new DatabaseSync(DB_PATH);
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

function validateEarningMonth(raw) {
  if (typeof raw !== 'string' || !/^\d{4}\/\d{2}\/01$/.test(raw)) {
    return { ok: false, code: 'invalid' };
  }
  const parts = raw.split('/').map(Number);
  if (!validateJalaliDate(parts[0], parts[1], 1)) return { ok: false, code: 'invalid' };
  if (raw < CUTOVER) return { ok: false, code: 'cutover' };
  return { ok: true, month: raw };
}

function defaultMonth() {
  const current = String(getCurrentJalaliDate()).slice(0, 7) + '/01';
  return current < CUTOVER ? CUTOVER : current;
}

function centsOf(entitlement) {
  return Math.round(Number(entitlement) * 100);
}

/* ------------------------------------------------------- classification */

/**
 * Evaluate every active employee independently (rule 37) via the frozen engine.
 * Verdicts: CREATE | WARN | SKIP (ALREADY_OPEN | BLOCKED | ZERO_ENTITLEMENT | ERROR)
 * `db` must satisfy the engine API (node:sqlite DatabaseSync).
 */
function classifyEmployees(db, month) {
  const existing = new Set(
    db
      .prepare('SELECT employee_id FROM salary_obligation WHERE earning_month = ?')
      .all(month)
      .map((r) => r.employee_id)
  );

  const emps = db
    .prepare(
      `SELECT e.id, e.full_name, e.employee_id AS employee_code, d.name AS department_name
       FROM hr_employees e
       LEFT JOIN departments d ON d.id = e.department_id
       WHERE e.employment_status = 'Active'
       ORDER BY e.full_name ASC`
    )
    .all();

  const rows = [];
  for (const emp of emps) {
    const base = {
      employee_id: emp.id,
      full_name: emp.full_name,
      employee_code: emp.employee_code,
      department_name: emp.department_name,
      earning_month: month,
      verdict: 'CREATE',
      warn: false,
      skip_code: null,
      codes: [],
      message: null,
      entitlement_cents: 0
    };

    if (existing.has(emp.id)) {
      rows.push({ ...base, verdict: 'SKIP', skip_code: 'ALREADY_OPEN' });
      continue;
    }

    try {
      // countFutureDays=true: obligations store the FULL-month figure even
      // mid-month (legacy rule) - trg_payment_finalize caps paid at earned,
      // so the unpaid rest must remain on the obligation as payable balance.
      const result = calculateEntitlement(db, emp.id, month, { countFutureDays: true });
      const codes = [...new Set((result.blockers || []).map((b) => b.code))];
      const warnCodes = [...new Set((result.review_items || []).map((r) => r.code))];

      if (result.status === 'BLOCKED') {
        rows.push({ ...base, verdict: 'SKIP', skip_code: 'BLOCKED', codes });
        continue;
      }

      const cents = centsOf(result.salary_entitlement);
      if (!(cents > 0)) {
        rows.push({ ...base, verdict: 'SKIP', skip_code: 'ZERO_ENTITLEMENT', codes: warnCodes });
        continue;
      }

      if (result.status === 'REVIEW_REQUIRED') {
        rows.push({ ...base, verdict: 'CREATE', warn: true, codes: warnCodes, entitlement_cents: cents });
      } else {
        rows.push({ ...base, verdict: 'CREATE', warn: false, entitlement_cents: cents });
      }
    } catch (err) {
      rows.push({
        ...base,
        verdict: 'SKIP',
        skip_code: 'ERROR',
        message: String(err && err.message ? err.message : err)
      });
    }
  }
  return rows;
}

function summarize(rows) {
  const counts = { create: 0, warn: 0, blocked: 0, zero: 0, already: 0, error: 0 };
  for (const r of rows) {
    if (r.verdict === 'CREATE') {
      counts.create += 1;
      if (r.warn) counts.warn += 1;
    } else if (r.skip_code === 'BLOCKED') counts.blocked += 1;
    else if (r.skip_code === 'ZERO_ENTITLEMENT') counts.zero += 1;
    else if (r.skip_code === 'ALREADY_OPEN') counts.already += 1;
    else if (r.skip_code === 'ERROR') counts.error += 1;
  }
  return counts;
}

/* ------------------------------------------------------- execution (txn) */

/**
 * One BEGIN IMMEDIATE transaction. Creates eligible obligations + one
 * OBLIGATION_CREATED audit row each. Rolls back everything on any error.
 * `db` must be a read-write DatabaseSync.
 */
function executePeriodOpen(db, month, actorId) {
  db.exec('BEGIN IMMEDIATE');
  let rows;
  const created = [];
  try {
    rows = classifyEmployees(db, month);

    const ins = db.prepare(
      `INSERT INTO salary_obligation
       (employee_id, earning_month, salary_earned, salary_paid, status, created_by, created_at, source_note)
       VALUES (?, ?, ?, 0, 'OPEN', ?, CURRENT_TIMESTAMP, ?)`
    );
    const aud = db.prepare(
      `INSERT INTO payment_audit
       (payment_id, action, entity, entity_id, field_name, old_value, new_value, reason, actor_id, created_at)
       VALUES (NULL, 'OBLIGATION_CREATED', 'obligation', ?, NULL, NULL, ?, ?, ?, CURRENT_TIMESTAMP)`
    );

    for (const row of rows) {
      if (row.verdict !== 'CREATE') continue;
      const sourceNote =
        'period-open ' + month + (row.warn && row.codes.length ? '; WARN: ' + row.codes.join(',') : '');
      const rr = ins.run(row.employee_id, month, row.entitlement_cents, actorId, sourceNote);
      const obligationId = Number(rr.lastInsertRowid);
      aud.run(obligationId, String(row.entitlement_cents), 'period-open ' + month, actorId);
      created.push({ ...row, obligation_id: obligationId, source_note: sourceNote });
    }

    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (e) { /* already rolled back */ }
    throw err;
  }

  const counts = summarize(rows);
  return { month, rows, created, counts };
}

/**
 * Audited correction (Part H workflow B). Returns {ok, code}.
 * OPEN allowed, PARTIAL allowed with confirm, PAID refused (D-4).
 */
function executeCorrection(db, opts) {
  const month = opts.month;
  const employeeId = opts.employee_id;
  const reason = opts.reason;
  const actorId = opts.actor_id;
  const confirmPartial = opts.confirm_partial;

  const obl = db
    .prepare('SELECT * FROM salary_obligation WHERE employee_id = ? AND earning_month = ?')
    .get(employeeId, month);
  if (!obl) return { ok: false, code: 'NOT_FOUND' };
  if (obl.status === 'PAID') return { ok: false, code: 'PAID' };
  if (obl.status === 'PARTIAL' && confirmPartial !== true) return { ok: false, code: 'PARTIAL_CONFIRM' };

  let result;
  try {
    // countFutureDays=true: correction recomputes the FULL-month figure
    // (same rule as obligation creation) - never shrink salary_earned to a
    // mid-month slice below what is already payable on this obligation.
    result = calculateEntitlement(db, employeeId, month, { countFutureDays: true });
  } catch (err) {
    return { ok: false, code: 'BLOCKED', message: String(err && err.message ? err.message : err) };
  }
  if (result.status === 'BLOCKED') {
    const codes = [...new Set((result.blockers || []).map((b) => b.code))];
    return { ok: false, code: 'BLOCKED', codes };
  }

  const newCents = centsOf(result.salary_entitlement);
  if (!(newCents > 0)) return { ok: false, code: 'ZERO' };
  if (newCents === obl.salary_earned) return { ok: false, code: 'NO_CHANGE' };
  if (newCents < obl.salary_paid) return { ok: false, code: 'BELOW_PAID' };

  const newStatus = obl.salary_paid === 0 ? 'OPEN' : 'PARTIAL';
  const sourceNote =
    (obl.source_note ? obl.source_note + '; ' : '') + 'corrected: ' + String(reason).slice(0, 500);

  db.exec('BEGIN IMMEDIATE');
  try {
    const again = db
      .prepare('SELECT status, salary_paid, salary_earned FROM salary_obligation WHERE id = ?')
      .get(obl.id);
    if (!again) throw Object.assign(new Error('obligation disappeared'), { refusal: 'NOT_FOUND' });
    if (again.status === 'PAID') throw Object.assign(new Error('became PAID'), { refusal: 'PAID' });

    db.prepare(
      `UPDATE salary_obligation
       SET salary_earned = ?, status = ?, source_note = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(newCents, newStatus, sourceNote, obl.id);

    db.prepare(
      `INSERT INTO payment_audit
       (payment_id, action, entity, entity_id, field_name, old_value, new_value, reason, actor_id, created_at)
       VALUES (NULL, 'OBLIGATION_CORRECTED', 'obligation', ?, 'salary_earned', ?, ?, ?, ?, CURRENT_TIMESTAMP)`
    ).run(obl.id, String(obl.salary_earned), String(newCents), String(reason).slice(0, 500), actorId);

    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (e) { /* already rolled back */ }
    if (err && err.refusal) return { ok: false, code: err.refusal };
    throw err;
  }

  return {
    ok: true,
    obligation_id: obl.id,
    old_cents: obl.salary_earned,
    new_cents: newCents,
    status: newStatus
  };
}

/* ------------------------------------------------------------- GET open */

function openForm(req, res) {
  const raw = req.query.month;
  if (raw) {
    const v = validateEarningMonth(String(raw));
    if (!v.ok) {
      req.session.message = {
        type: 'error',
        text: res.locals.t(v.code === 'cutover' ? 'hr.payroll_period.pre_cutover' : 'hr.payroll_period.invalid_month')
      };
      return res.redirect('/admin/hr/payroll/periods/open');
    }
    let db = null;
    try {
      db = openDb(true);
      const rows = classifyEmployees(db, v.month);
      const counts = summarize(rows);
      return res.render('hr/payroll-period-open', {
        mode: 'preview',
        month: v.month,
        rows,
        counts,
        session: req.session
      });
    } catch (err) {
      console.error('[payrollPeriod] preview error:', err);
      req.session.message = { type: 'error', text: res.locals.t('hr.payroll_period.err_open_failed') };
      return res.redirect('/admin/hr/payroll/periods/open');
    } finally {
      if (db) { try { db.close(); } catch (e) { /* ignore */ } }
    }
  }

  return res.render('hr/payroll-period-open', {
    mode: 'form',
    month: defaultMonth(),
    session: req.session
  });
}

/* ------------------------------------------------------------ POST open */

function openExecute(req, res) {
  const v = validateEarningMonth(String(req.body.earning_month || ''));
  if (!v.ok) {
    req.session.message = {
      type: 'error',
      text: res.locals.t(v.code === 'cutover' ? 'hr.payroll_period.pre_cutover' : 'hr.payroll_period.invalid_month')
    };
    return res.redirect('/admin/hr/payroll/periods/open');
  }

  const actorId = Number(req.session.user_id);
  if (!Number.isInteger(actorId) || actorId <= 0) {
    req.session.message = { type: 'error', text: res.locals.t('hr.payroll_period.err_open_failed') };
    return res.redirect('/admin/hr/payroll/periods/open');
  }

  let db = null;
  let result = null;
  try {
    db = openDb(false);
    result = executePeriodOpen(db, v.month, actorId);
  } catch (err) {
    console.error('[payrollPeriod] open error:', err);
    if (db) { try { db.close(); } catch (e) { /* ignore */ } }
    req.session.message = { type: 'error', text: res.locals.t('hr.payroll_period.err_open_failed') };
    return res.redirect('/admin/hr/payroll/periods/open');
  }

  // Exactly ONE notification after successful commit (rule 42).
  // Notification failure never unlabels the already-committed opening.
  try {
    const username = String(req.session.username || 'admin');
    const message =
      res.locals.t('hr.payroll_period.ok_opened') +
      ' ' + v.month +
      ' — ' + res.locals.t('hr.payroll_period.result_created') + ': ' + result.counts.create +
      ', ' + res.locals.t('hr.payroll_period.total_warn') + ': ' + result.counts.warn +
      ', ' + res.locals.t('hr.payroll_period.total_blocked') + ': ' + result.counts.blocked +
      ', ' + res.locals.t('hr.payroll_period.total_zero') + ': ' + result.counts.zero +
      ', ' + res.locals.t('hr.payroll_period.total_already') + ': ' + result.counts.already;

    const nr = db
      .prepare(
        `INSERT INTO admin_notifications
         (type, message, related_record_id, related_record_type, created_by, recipient, is_read, created_at)
         VALUES ('hr_payroll_period_opened', ?, NULL, 'payroll_period', ?, ?, 0, CURRENT_TIMESTAMP)`
      )
      .run(message, username, username);

    notificationSSE.broadcast({
      id: Number(nr.lastInsertRowid),
      type: 'hr_payroll_period_opened',
      message,
      related_record_id: null,
      related_record_type: 'payroll_period',
      created_by: username,
      recipient: username,
      is_read: 0,
      created_at: new Date().toISOString()
    });
  } catch (err) {
    console.error('[payrollPeriod] notification error (opening committed):', err);
  } finally {
    if (db) { try { db.close(); } catch (e) { /* ignore */ } }
  }

  return res.render('hr/payroll-period-open', {
    mode: 'result',
    month: v.month,
    rows: result.rows,
    created: result.created,
    counts: result.counts,
    session: req.session
  });
}

/* ----------------------------------------------------- POST correct */

function correctObligation(req, res) {
  const v = validateEarningMonth(String(req.body.earning_month || ''));
  const employeeId = Number(req.body.employee_id);
  const reason = String(req.body.reason || '').trim();

  const fail = (key) => {
    req.session.message = { type: 'error', text: res.locals.t(key) };
    return res.redirect('/admin/hr/payroll/obligations');
  };

  if (!v.ok) return fail('hr.payroll_period.invalid_month');
  if (!Number.isInteger(employeeId) || employeeId <= 0) return fail('hr.payroll_period.err_correct_not_found');
  if (!reason) return fail('hr.payroll_period.err_correct_reason');

  const actorId = Number(req.session.user_id);
  if (!Number.isInteger(actorId) || actorId <= 0) return fail('hr.payroll_period.err_open_failed');

  let db = null;
  let outcome;
  try {
    db = openDb(false);
    outcome = executeCorrection(db, {
      month: v.month,
      employee_id: employeeId,
      reason,
      actor_id: actorId,
      confirm_partial: String(req.body.confirm_partial || '') === '1'
    });
  } catch (err) {
    console.error('[payrollPeriod] correction error:', err);
    return fail('hr.payroll_period.err_open_failed');
  } finally {
    if (db) { try { db.close(); } catch (e) { /* ignore */ } }
  }

  if (outcome.ok) {
    req.session.message = { type: 'success', text: res.locals.t('hr.payroll_period.ok_corrected') };
    return res.redirect('/admin/hr/payroll/obligations');
  }

  const map = {
    NOT_FOUND: 'hr.payroll_period.err_correct_not_found',
    PAID: 'hr.payroll_period.err_correct_paid',
    PARTIAL_CONFIRM: 'hr.payroll_period.err_correct_partial_confirm',
    BLOCKED: 'hr.payroll_period.err_correct_blocked',
    ZERO: 'hr.payroll_period.err_correct_zero',
    BELOW_PAID: 'hr.payroll_period.err_correct_below_paid',
    NO_CHANGE: 'hr.payroll_period.err_no_change'
  };
  return fail(map[outcome.code] || 'hr.payroll_period.err_open_failed');
}

/* ----------------------------------------------------- GET obligations */

function listObligations(req, res) {
  let db = null;
  try {
    db = openDb(true);
    const rows = db
      .prepare(
        `SELECT o.id, o.employee_id, o.earning_month, o.salary_earned, o.salary_paid,
                o.salary_remaining, o.status, o.created_by, o.created_at, o.updated_at, o.source_note,
                e.full_name, e.employee_id AS employee_code, d.name AS department_name
         FROM salary_obligation o
         LEFT JOIN hr_employees e ON e.id = o.employee_id
         LEFT JOIN departments d ON d.id = e.department_id
         ORDER BY o.earning_month DESC, e.full_name ASC`
      )
      .all();
    return res.render('hr/payroll-period-open', {
      mode: 'obligations',
      obligations: rows,
      month: defaultMonth(),
      session: req.session
    });
  } catch (err) {
    console.error('[payrollPeriod] obligations error:', err);
    req.session.message = { type: 'error', text: res.locals.t('hr.payroll_period.err_open_failed') };
    return res.redirect('/admin/hr');
  } finally {
    if (db) { try { db.close(); } catch (e) { /* ignore */ } }
  }
}

module.exports = {
  openForm,
  openExecute,
  correctObligation,
  listObligations,
  // exported for tests (no request/response involved)
  _internals: {
    classifyEmployees,
    executePeriodOpen,
    executeCorrection,
    validateEarningMonth,
    summarize,
    centsOf,
    defaultMonth,
    CUTOVER
  }
};
