'use strict';

/**
 * PHASE 23 — payment foundation controller (minimum authorized scope).
 *
 * Phase 23 authorizes exactly two things here:
 *   1. foundationStatus — read-only JSON status of the payment foundation
 *      schema (route: GET /admin/hr/payments/foundation-status, requireAdmin).
 *   2. auditLegacyFence — payment_audit writer for the Phase 22B-approved
 *      legacy payroll cutover fence in hrController (action LEGACY_FENCE).
 *
 * PHASE 25C — payment transaction layer (draft/finalize workflow).
 * Draft create/edit/delete and finalize over the frozen Phase 24C allocation
 * engine. All money is integer cents. Every mutation runs on DatabaseSync
 * with PRAGMA busy_timeout=5000 and BEGIN IMMEDIATE; SSE notifications are
 * emitted only after COMMIT. Refusals (BLOCKED / DUPLICATE_SUBMIT) are
 * written in a separate committed mini-transaction after the main
 * transaction is rolled back. lifecycle DRAFT -> FINALIZED only; no
 * CORRECT / DISPUTE actions are ever emitted by this file.
 */

const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const notificationSSE = require('../utils/notificationSSE');
const { allocatePayment } = require('../utils/paymentAllocationEngine');
const { computeEmployeeBalances } = require('../utils/employeeBalanceService');
const { calculateEntitlement } = require('../utils/salaryEntitlementEngine');
const { getCurrentJalaliDate, validateJalaliDate } = require('../middleware/i18n');

const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'enterprise_cement.db');
const FOUNDATION5 = ['payment', 'payment_component', 'salary_obligation', 'attendance_exception', 'payment_audit'];

const CUTOVER = '1405/07/01';
const ZERO_REASONS = ['NO_WORK_PERIOD', 'ABSENCE_UNPAID', 'NEW_HIRE_NO_DUE', 'LEAVE_UNPAID',
  'BANK_UNAVAILABLE', 'EMPLOYEE_ABSENT_PICKUP', 'OTHER_APPROVED'];
const ADDITIONAL_REASONS = ['BONUS_APPROVED', 'RETENTION_INCENTIVE', 'CORRECTION_PRIOR_PERIOD',
  'ALLOWANCE_UNCLASSIFIED', 'GOODWILL_PAYMENT', 'REIMBURSEMENT', 'OTHER_APPROVED'];
const PAYMENT_METHODS = ['CASH', 'BANK', 'OTHER'];
const ZERO_REASON_T = {
  NO_WORK_PERIOD: 'zr_no_work', ABSENCE_UNPAID: 'zr_absence', NEW_HIRE_NO_DUE: 'zr_new_hire',
  LEAVE_UNPAID: 'zr_leave', BANK_UNAVAILABLE: 'zr_bank', EMPLOYEE_ABSENT_PICKUP: 'zr_pickup',
  OTHER_APPROVED: 'zr_other'
};
const ADDITIONAL_REASON_T = {
  BONUS_APPROVED: 'ar_bonus', RETENTION_INCENTIVE: 'ar_retention', CORRECTION_PRIOR_PERIOD: 'ar_correction',
  ALLOWANCE_UNCLASSIFIED: 'ar_allowance', GOODWILL_PAYMENT: 'ar_goodwill', REIMBURSEMENT: 'ar_reimbursement',
  OTHER_APPROVED: 'ar_other'
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ABORT_CODES = ['INITIAL_STATUS_MUST_BE_DRAFT', 'INVALID_STATUS_TRANSITION', 'IDEMPOTENCY_KEY_REQUIRED',
  'ZERO_PAYMENT_REASON_REQUIRED', 'OBLIGATION_NOT_FOUND', 'SALARY_OVER_OBLIGATION', 'ADVANCE_DISPUTED',
  'ADVANCE_SETTLEMENT_EXCEEDS_BALANCE', 'PAYMENT_NOT_DRAFT', 'FINANCIAL_RECORD_IMMUTABLE',
  'OVERTIME_ALLOCATION_INVALID', 'ADVANCE_ALLOCATION_INVALID', 'SALARY_PAID_OUT_OF_RANGE',
  'NEGATIVE_REMAINING_BALANCE', 'AUDIT_IMMUTABLE', 'LEGACY_PAYROLL_CUTOVER_FENCE',
  'LEGACY_PAYROLL_LINK_FENCE', 'OPEN_ADVANCE_RECEIVABLE'];
const REFUSAL_T = {
  BLOCKED: 'err_blocked', DUPLICATE_SUBMIT: 'err_duplicate_submit',
  DUPLICATE_PAYMENT_NOT_CONFIRMED: 'err_dup_not_confirmed', IDEMPOTENCY_KEY_REQUIRED: 'err_idem_required',
  INVALID_IDEMPOTENCY_KEY: 'err_idem_invalid', EMPLOYEE_NOT_FOUND: 'err_employee',
  INVALID_PERIOD: 'err_period', INVALID_PAYMENT_DATE: 'err_date', INVALID_INPUT: 'err_input',
  INVALID_ADDITIONAL_AMOUNT: 'err_input', INVALID_ADDITIONAL_REASON: 'err_input',
  INVALID_ZERO_REASON: 'err_zero_reason_invalid', PAYMENT_NOT_FOUND: 'err_not_found',
  NOT_DRAFT: 'err_not_draft', BLOCKERS: 'err_blocked', OVER_ALLOCATION: 'err_over_allocation',
  OBLIGATION_NOT_FOUND: 'err_obligation', OBLIGATION_FULLY_PAID: 'err_obligation_paid',
  ZERO_PAYMENT_REASON_REQUIRED: 'err_zero_reason', INVALID_OVERPAYMENT_CENTS: 'err_overpayment',
  SALARY_OVER_OBLIGATION: 'err_salary_over', OVERTIME_ALLOCATION_INVALID: 'err_ot_invalid',
  ADVANCE_ALLOCATION_INVALID: 'err_adv_invalid', ADVANCE_DISPUTED: 'err_adv_invalid',
  ADVANCE_SETTLEMENT_EXCEEDS_BALANCE: 'err_adv_balance', RECOVERY_ALREADY_EXISTS: 'err_recovery_exists',
  FINANCIAL_RECORD_IMMUTABLE: 'err_immutable', PAYMENT_NOT_DRAFT: 'err_not_draft',
  INITIAL_STATUS_MUST_BE_DRAFT: 'err_not_draft', INVALID_STATUS_TRANSITION: 'err_not_draft',
  SERIAL_ALLOCATION_FAILED: 'err_internal'
};

function openDb(readOnly) {
  const db = readOnly ? new DatabaseSync(DB_PATH, { readOnly: true }) : new DatabaseSync(DB_PATH);
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

function foundationStatus(req, res) {
  let db;
  try {
    db = new DatabaseSync(DB_PATH, { readOnly: true });
    const cols = (t) => db.prepare(`SELECT name FROM pragma_table_info('${t}')`).all().map((r) => r.name);
    const cnt = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;

    const paymentCols = cols('payment');
    const advanceCols = cols('salary_advances');
    const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").all().map((r) => r.name);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
    const foundation = {};
    for (const t of FOUNDATION5) foundation[t] = cnt(t);

    const migrated = paymentCols.includes('payment_serial') &&
      advanceCols.includes('source_payment_id') &&
      tables.includes('payment_serial_counters') &&
      triggers.length > 0;

    res.json({
      ok: true,
      phase: 23,
      migrated,
      foundation_rows: foundation,
      payment_columns: paymentCols.length,
      has_source_payment_id: advanceCols.includes('source_payment_id'),
      has_payment_serial: paymentCols.includes('payment_serial'),
      serial_counters: tables.includes('payment_serial_counters') ? cnt('payment_serial_counters') : null,
      triggers,
      legacy_counts: { payroll: cnt('payroll'), overtime: cnt('overtime'), salary_advances: cnt('salary_advances') }
    });
  } catch (e) {
    console.error('foundationStatus error:', e && e.message);
    res.status(500).json({ ok: false, error: 'foundation status unavailable' });
  } finally {
    if (db) { try { db.close(); } catch (_) { /* already closed */ } }
  }
}

/**
 * Writes a payment_audit LEGACY_FENCE row for a blocked post-cutover legacy
 * payroll request, then always invokes done() (fence applies even if the
 * audit write fails, e.g. on an unmigrated schema).
 */
function auditLegacyFence(db, req, payrollPeriod, done) {
  const actorId = Number(req.session && req.session.user_id) || 0;
  db.run(
    `INSERT INTO payment_audit
       (payment_id, action, entity, entity_id, field_name, old_value, new_value, reason, actor_id, created_at)
     VALUES (NULL, 'LEGACY_FENCE', 'legacy_payroll', NULL, 'payroll_period', NULL, ?, NULL, ?, CURRENT_TIMESTAMP)`,
    [String(payrollPeriod), actorId],
    (err) => {
      if (err) console.error('LEGACY_FENCE audit failed:', err.message);
      if (typeof done === 'function') done();
    }
  );
}

/* ------------------------------------------------------------ 25C helpers */

function isInt(v) {
  return typeof v === 'number' && Number.isSafeInteger(v);
}

function centsFromUnits(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}

function validatePeriodMonth(raw) {
  if (typeof raw !== 'string' || !/^\d{4}\/\d{2}\/01$/.test(raw)) return false;
  const parts = raw.split('/').map(Number);
  if (!validateJalaliDate(parts[0], parts[1], 1)) return false;
  return raw >= CUTOVER;
}

function validatePaymentDate(raw) {
  if (typeof raw !== 'string' || !/^\d{4}\/\d{2}\/\d{2}$/.test(raw)) return false;
  const parts = raw.split('/').map(Number);
  return validateJalaliDate(parts[0], parts[1], parts[2]);
}

function defaultMonth() {
  const current = String(getCurrentJalaliDate()).slice(0, 7) + '/01';
  return current < CUTOVER ? CUTOVER : current;
}

function refusalError(code, detail, blockers) {
  const e = new Error(code);
  e.refusal = code;
  e.detail = detail || null;
  e.blockers = blockers || [];
  return e;
}

function extractAbortCode(msg) {
  for (const c of ABORT_CODES) if (msg.includes(c)) return c;
  return null;
}

function audit(db, row, actorId) {
  db.prepare(
    `INSERT INTO payment_audit
       (payment_id, action, entity, entity_id, field_name, old_value, new_value, reason, actor_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
  ).run(
    row.payment_id === undefined ? null : row.payment_id,
    row.action,
    row.entity,
    row.entity_id === undefined ? null : row.entity_id,
    row.field_name === undefined ? null : row.field_name,
    row.old_value === undefined ? null : row.old_value,
    row.new_value === undefined ? null : row.new_value,
    row.reason === undefined ? null : row.reason,
    actorId
  );
}

function auditBlocked(db, paymentId, reason, actorId) {
  try {
    db.exec('BEGIN IMMEDIATE');
    audit(db, {
      payment_id: paymentId === undefined || paymentId === null ? null : paymentId,
      action: 'BLOCKED',
      entity: 'payment',
      entity_id: paymentId === undefined || paymentId === null ? null : paymentId,
      reason: reason
    }, actorId);
    db.exec('COMMIT');
    return true;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* not in txn */ }
    console.error('[payment] BLOCKED audit failed:', e && e.message);
    return false;
  }
}

function auditDuplicateSubmit(db, paymentId, key, actorId) {
  try {
    db.exec('BEGIN IMMEDIATE');
    audit(db, {
      payment_id: paymentId,
      action: 'DUPLICATE_SUBMIT',
      entity: 'payment',
      entity_id: paymentId,
      field_name: 'idempotency_key',
      new_value: String(key),
      reason: 'duplicate submit'
    }, actorId);
    db.exec('COMMIT');
    return true;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* not in txn */ }
    console.error('[payment] DUPLICATE_SUBMIT audit failed:', e && e.message);
    return false;
  }
}

function refused(db, p, code, detail, blockers, actorId) {
  const reason = detail ? code + ': ' + detail : code;
  auditBlocked(db, p && p.payment_id, reason, actorId);
  return {
    ok: false,
    refusal: code,
    detail: detail || null,
    blockers: blockers || [],
    payment_id: p && p.payment_id ? p.payment_id : null
  };
}

function buildEngineInput(db, employeeId, periodMonth, opts) {
  const o = opts || {};
  const obl = db.prepare(
    'SELECT id, status, salary_remaining FROM salary_obligation WHERE employee_id = ? AND earning_month = ?'
  ).get(employeeId, periodMonth) || null;

  const otCandidates = db.prepare(
    'SELECT id, overtime_date, status, payroll_id, total_amount FROM overtime WHERE employee_id = ?'
  ).all(employeeId).map((r) => {
    const used = db.prepare(
      `SELECT COALESCE(SUM(pc.amount), 0) AS s
       FROM payment_component pc JOIN payment p ON p.id = pc.payment_id
       WHERE pc.overtime_id = ? AND p.status IN ('DRAFT','FINALIZED')`
    ).get(r.id).s;
    return {
      id: r.id,
      overtime_date: String(r.overtime_date === null || r.overtime_date === undefined ? '' : r.overtime_date),
      status: r.status,
      payroll_id: r.payroll_id === undefined ? null : r.payroll_id,
      remaining_cents: Math.round(Number(r.total_amount) * 100) - used
    };
  });

  const advanceCandidates = db.prepare(
    'SELECT id, date, amount, status FROM salary_advances WHERE employee_id = ?'
  ).all(employeeId).map((r) => {
    const rep = db.prepare(
      `SELECT COALESCE(SUM(CAST(ROUND(r.amount * 100) AS INTEGER)), 0) AS s
       FROM salary_advance_repayments r WHERE r.advance_id = ?`
    ).get(r.id).s;
    const draft = db.prepare(
      `SELECT COALESCE(SUM(pc.amount), 0) AS s
       FROM payment_component pc JOIN payment p ON p.id = pc.payment_id
       WHERE pc.advance_id = ? AND p.status = 'DRAFT'`
    ).get(r.id).s;
    const fin = db.prepare(
      `SELECT COALESCE(SUM(pc.amount), 0) AS s
       FROM payment_component pc JOIN payment p ON p.id = pc.payment_id
       WHERE pc.advance_id = ? AND p.status = 'FINALIZED'`
    ).get(r.id).s;
    const originalCents = Math.round(Number(r.amount) * 100);
    return {
      id: r.id,
      date: String(r.date === null || r.date === undefined ? '' : r.date),
      status: r.status,
      original_amount_cents: originalCents,
      repayment_cents: rep,
      draft_reserved_cents: draft,
      finalized_allocated_cents: fin,
      available_cents: originalCents - rep - draft - fin
    };
  });

  const input = {
    mode: o.mode,
    locked_flags: {},
    obligation: obl,
    ot_candidates: otCandidates,
    advance_candidates: advanceCandidates
  };
  if (o.requested_cents !== undefined) input.requested_cents = o.requested_cents;
  if (o.manual_selections !== undefined) input.manual_selections = o.manual_selections;

  /* HR-25 include/exclude gate - candidate curation only, inside
   * buildEngineInput. The engine consumes the curated input; the ungated
   * candidate rows are kept on input.uncurated for workspace display.
   * No allocation math happens here - the frozen allocation engine owns it. */
  const inc = o.includes;
  if (inc && (!inc.salary || !inc.overtime || !inc.advance)) {
    input.uncurated = {
      obligation: input.obligation,
      ot_candidates: input.ot_candidates,
      advance_candidates: input.advance_candidates,
      manual_selections: input.manual_selections
    };
    if (!inc.salary) input.obligation = null;
    if (!inc.overtime) input.ot_candidates = [];
    if (!inc.advance) input.advance_candidates = [];
    if (Array.isArray(input.manual_selections)) {
      input.manual_selections = input.manual_selections.filter(function (s) {
        if (!s) return false;
        if (s.source_type === 'SALARY') return !!inc.salary;
        if (s.source_type === 'OVERTIME') return !!inc.overtime;
        if (s.source_type === 'ADVANCE') return !!inc.advance;
        return true;
      });
    }
  }
  return input;
}

function runEngine(db, params) {
  const input = buildEngineInput(db, params.employee_id, params.period_month, params);
  const engine = allocatePayment(input);
  return { input, engine };
}

function componentRowsFor(engine, periodMonth, additional) {
  const mode = engine.ordering_trace.mode;
  const rows = [];
  if (engine.salary.allocated_cents > 0) {
    rows.push({
      type: 'SALARY', amount: engine.salary.allocated_cents, target_month: periodMonth,
      overtime_id: null, advance_id: null, reason_code: null, reason_note: null,
      selection_mode: mode, seq: 0
    });
  }
  for (const r of engine.overtime) {
    if (r.allocated_cents > 0) {
      rows.push({
        type: 'OVERTIME', amount: r.allocated_cents, target_month: null,
        overtime_id: r.id, advance_id: null, reason_code: null, reason_note: null,
        selection_mode: mode, seq: engine.ordering_trace.ot.indexOf(r.id) + 1
      });
    }
  }
  for (const r of engine.advance) {
    if (r.allocated_cents > 0) {
      rows.push({
        type: 'ADVANCE', amount: r.allocated_cents, target_month: null,
        overtime_id: null, advance_id: r.id, reason_code: null, reason_note: null,
        selection_mode: mode, seq: engine.ordering_trace.adv.indexOf(r.id) + 1
      });
    }
  }
  if (additional) {
    rows.push({
      type: 'ADDITIONAL', amount: additional.amount, target_month: null,
      overtime_id: null, advance_id: null, reason_code: additional.reason_code,
      reason_note: additional.reason_note, selection_mode: null, seq: 0
    });
  }
  return rows;
}

function insertComponents(db, paymentId, rows) {
  const ins = db.prepare(
    `INSERT INTO payment_component
       (payment_id, type, amount, target_month, overtime_id, advance_id, reason_code, reason_note,
        selection_mode, seq, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
  );
  for (const r of rows) {
    ins.run(paymentId, r.type, r.amount, r.target_month, r.overtime_id, r.advance_id,
      r.reason_code, r.reason_note, r.selection_mode, r.seq);
  }
}

function compSummary(list) {
  const buckets = { SALARY: [], OVERTIME: [], ADVANCE: [], ADDITIONAL: [] };
  for (const c of list) {
    if (buckets[c.type]) buckets[c.type].push(c);
  }
  const out = {};
  for (const k of Object.keys(buckets)) {
    const sum = buckets[k].reduce((a, c) => a + c.amount, 0);
    let extra = '';
    if (k === 'ADDITIONAL' && buckets[k].length) {
      extra = ';reasons=' + buckets[k].map((c) => c.reason_code).sort().join('|');
    }
    out[k] = 'count=' + buckets[k].length + ';sum=' + sum + extra;
  }
  return out;
}

function resolveAdditional(fields, engine) {
  const rawAmount = fields ? fields.additional_amount : undefined;
  const hasOther = fields && (fields.additional_reason || fields.additional_note);
  if (rawAmount === undefined || rawAmount === null || rawAmount === '') {
    if (hasOther) return { error: 'INVALID_ADDITIONAL_AMOUNT' };
    return null;
  }
  const amount = centsFromUnits(rawAmount);
  if (!isInt(amount) || amount <= 0) return { error: 'INVALID_ADDITIONAL_AMOUNT' };
  const code = fields.additional_reason;
  if (!ADDITIONAL_REASONS.includes(code)) return { error: 'INVALID_ADDITIONAL_REASON' };
  const note = fields.additional_note === undefined || fields.additional_note === null
    ? '' : String(fields.additional_note).trim();
  if (code === 'OTHER_APPROVED' && note.length < 10) return { error: 'INVALID_ADDITIONAL_REASON' };
  if (amount > engine.unexplained_excess_cents) {
    return { error: 'OVER_ALLOCATION', detail: 'additional ' + amount + ' exceeds excess ' + engine.unexplained_excess_cents };
  }
  return { amount, reason_code: code, reason_note: note ? note.slice(0, 500) : null };
}

function summarizeEngine(engine) {
  const otRemaining = engine.overtime.reduce((s, r) => s + (r.available_before - r.allocated_cents), 0);
  const advRemaining = engine.advance.reduce((s, r) => s + (r.available_before - r.allocated_cents), 0);
  return { otRemaining, advRemaining };
}

/* --------------------------------------------------------- 25C internals */

function createDraft(db, p) {
  const actorId = p.actor_id;
  if (!isInt(p.employee_id) || p.employee_id <= 0) {
    return refused(db, p, 'EMPLOYEE_NOT_FOUND', null, null, actorId);
  }
  if (!validatePeriodMonth(p.period_month)) {
    return refused(db, p, 'INVALID_PERIOD', String(p.period_month), null, actorId);
  }
  if (!validatePaymentDate(p.payment_date)) {
    return refused(db, p, 'INVALID_PAYMENT_DATE', String(p.payment_date), null, actorId);
  }
  if (typeof p.idempotency_key !== 'string' || !UUID_RE.test(p.idempotency_key)) {
    return refused(db, p, 'INVALID_IDEMPOTENCY_KEY', null, null, actorId);
  }
  if (p.payment_method !== undefined && p.payment_method !== null && p.payment_method !== '' &&
      !PAYMENT_METHODS.includes(p.payment_method)) {
    return refused(db, p, 'INVALID_INPUT', 'payment_method', null, actorId);
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const emp = db.prepare(
      "SELECT id FROM hr_employees WHERE id = ? AND employment_status = 'Active'"
    ).get(p.employee_id);
    if (!emp) throw refusalError('EMPLOYEE_NOT_FOUND', String(p.employee_id));

    const dup = db.prepare('SELECT id FROM payment WHERE idempotency_key = ?').get(p.idempotency_key);
    if (dup) {
      db.exec('ROLLBACK');
      auditDuplicateSubmit(db, dup.id, p.idempotency_key, actorId);
      return {
        ok: false, refusal: 'DUPLICATE_SUBMIT', detail: null, blockers: [],
        payment_id: dup.id, existing_id: dup.id
      };
    }

    const same = db.prepare(
      `SELECT id FROM payment
       WHERE employee_id = ? AND period_month = ? AND status IN ('DRAFT','FINALIZED')
       ORDER BY id DESC LIMIT 1`
    ).get(p.employee_id, p.period_month);
    if (same && !p.duplicate_confirmed) {
      throw refusalError('DUPLICATE_PAYMENT_NOT_CONFIRMED', 'existing payment #' + same.id);
    }

    const { engine } = runEngine(db, {
      employee_id: p.employee_id,
      period_month: p.period_month,
      requested_cents: p.requested_cents,
      mode: p.mode,
      manual_selections: p.manual_selections,
      includes: p.includes
    });
    if (engine.blockers.length) {
      throw refusalError('BLOCKED', engine.blockers.join(','), engine.blockers.slice());
    }

    const additional = resolveAdditional(p, engine);
    if (additional && additional.error) {
      throw refusalError(additional.error, additional.detail || null);
    }

    const snap = db.prepare(
      `SELECT e.full_name, e.position, e.contract_type, d.name AS department_name
       FROM hr_employees e LEFT JOIN departments d ON d.id = e.department_id
       WHERE e.id = ?`
    ).get(p.employee_id);
    const sal = db.prepare(
      `SELECT basic_salary FROM employee_salary_history
       WHERE employee_id = ? ORDER BY effective_from DESC, id DESC LIMIT 1`
    ).get(p.employee_id);
    const basic = sal ? Math.round(Number(sal.basic_salary) * 100) : 0;
    const sums = summarizeEngine(engine);
    const method = PAYMENT_METHODS.includes(p.payment_method) ? p.payment_method : 'CASH';

    const rr = db.prepare(
      `INSERT INTO payment
         (employee_id, payment_date, period_month, status, payment_method, payment_reference, notes,
          obligation_id, idempotency_key, duplicate_confirmed, employee_name, department_name, position,
          contract_type, basic_salary_applied, salary_remaining_after, ot_remaining_after,
          advance_remaining_after, created_by, created_at)
       VALUES (?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
    ).run(
      p.employee_id, p.payment_date, p.period_month, method,
      p.payment_reference ? String(p.payment_reference).slice(0, 200) : null,
      p.notes ? String(p.notes).slice(0, 1000) : null,
      engine.salary.obligation_id, p.idempotency_key, p.duplicate_confirmed ? 1 : 0,
      snap.full_name || '', snap.department_name || '', snap.position || '', snap.contract_type || '',
      basic, engine.salary_remaining_after, sums.otRemaining, sums.advRemaining,
      actorId
    );
    const paymentId = Number(rr.lastInsertRowid);

    const rows = componentRowsFor(engine, p.period_month, additional);
    insertComponents(db, paymentId, rows);

    audit(db, {
      payment_id: paymentId, action: 'CREATE', entity: 'payment', entity_id: paymentId,
      field_name: 'status', old_value: null, new_value: 'DRAFT',
      reason: JSON.stringify({
        idempotency_key: p.idempotency_key,
        duplicate_confirmed: p.duplicate_confirmed ? 1 : 0,
        components: rows.length,
        requested_cents: isInt(p.requested_cents) ? p.requested_cents : null
      })
    }, actorId);

    for (const intent of engine.audit_intents) {
      if (intent.action === 'DATA_WARNING') {
        audit(db, {
          payment_id: paymentId, action: 'DATA_WARNING', entity: 'payment', entity_id: paymentId,
          field_name: 'requested_cents', new_value: String(p.requested_cents),
          reason: 'excess=' + engine.unexplained_excess_cents
        }, actorId);
      }
      if (intent.action === 'ZERO_PAID') {
        audit(db, {
          payment_id: paymentId, action: 'ZERO_PAID', entity: 'payment', entity_id: paymentId,
          field_name: 'status', new_value: 'DRAFT',
          reason: 'zero draft; requested=' + (isInt(p.requested_cents) ? String(p.requested_cents) : 'all')
        }, actorId);
      }
    }

    db.exec('COMMIT');
    return { ok: true, payment_id: paymentId, engine, components: rows };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
    const msg = String(err && err.message ? err.message : err);
    if (/idempotency/i.test(msg)) {
      const existing = db.prepare('SELECT id FROM payment WHERE idempotency_key = ?').get(p.idempotency_key);
      if (existing) {
        auditDuplicateSubmit(db, existing.id, p.idempotency_key, actorId);
        return {
          ok: false, refusal: 'DUPLICATE_SUBMIT', detail: null, blockers: [],
          payment_id: existing.id, existing_id: existing.id
        };
      }
    }
    if (err && err.refusal) {
      return refused(db, p, err.refusal, err.detail, err.blockers, actorId);
    }
    return refused(db, p, extractAbortCode(msg) || 'INTERNAL', msg, [], actorId);
  }
}

function editDraft(db, p) {
  const actorId = p.actor_id;
  if (!isInt(p.payment_id) || p.payment_id <= 0) {
    return refused(db, p, 'PAYMENT_NOT_FOUND', String(p.payment_id), null, actorId);
  }
  if (!validatePaymentDate(p.payment_date)) {
    return refused(db, p, 'INVALID_PAYMENT_DATE', String(p.payment_date), null, actorId);
  }
  if (p.payment_method !== undefined && p.payment_method !== null && p.payment_method !== '' &&
      !PAYMENT_METHODS.includes(p.payment_method)) {
    return refused(db, p, 'INVALID_INPUT', 'payment_method', null, actorId);
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const payment = db.prepare('SELECT * FROM payment WHERE id = ?').get(p.payment_id);
    if (!payment) throw refusalError('PAYMENT_NOT_FOUND', String(p.payment_id));
    if (payment.status !== 'DRAFT') throw refusalError('NOT_DRAFT', payment.status);

    const { engine } = runEngine(db, {
      employee_id: payment.employee_id,
      period_month: payment.period_month,
      requested_cents: p.requested_cents,
      mode: p.mode,
      manual_selections: p.manual_selections,
      includes: p.includes
    });
    if (engine.blockers.length) {
      throw refusalError('BLOCKED', engine.blockers.join(','), engine.blockers.slice());
    }
    const additional = resolveAdditional(p, engine);
    if (additional && additional.error) {
      throw refusalError(additional.error, additional.detail || null);
    }

    const oldComps = db.prepare('SELECT * FROM payment_component WHERE payment_id = ?').all(p.payment_id);
    const oldSummary = compSummary(oldComps);

    // D1: delete ADVANCE rows first so trg_component_agg_del never recomputes
    // net_cash_paid below 0 (salary rows temporarily leaving advance behind).
    db.prepare(`DELETE FROM payment_component WHERE payment_id = ? AND type = 'ADVANCE'`).run(p.payment_id);
    db.prepare('DELETE FROM payment_component WHERE payment_id = ?').run(p.payment_id);
    const rows = componentRowsFor(engine, payment.period_month, additional);
    insertComponents(db, p.payment_id, rows);

    const method = PAYMENT_METHODS.includes(p.payment_method) ? p.payment_method : payment.payment_method;
    const ref = p.payment_reference === undefined || p.payment_reference === null || p.payment_reference === ''
      ? payment.payment_reference : String(p.payment_reference).slice(0, 200);
    const notes = p.notes === undefined || p.notes === null || p.notes === ''
      ? payment.notes : String(p.notes).slice(0, 1000);
    const sums = summarizeEngine(engine);

    db.prepare(
      `UPDATE payment
       SET payment_date = ?, payment_method = ?, payment_reference = ?, notes = ?,
           salary_remaining_after = ?, ot_remaining_after = ?, advance_remaining_after = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'DRAFT'`
    ).run(p.payment_date, method, ref, notes, engine.salary_remaining_after,
      sums.otRemaining, sums.advRemaining, p.payment_id);

    const headerFields = [
      ['payment_date', payment.payment_date, p.payment_date],
      ['payment_method', payment.payment_method, method],
      ['payment_reference', payment.payment_reference || '', ref || ''],
      ['notes', payment.notes || '', notes || '']
    ];
    for (const [field, oldV, newV] of headerFields) {
      if (String(oldV) !== String(newV)) {
        audit(db, {
          payment_id: p.payment_id, action: 'DRAFT_EDIT', entity: 'payment', entity_id: p.payment_id,
          field_name: field, old_value: String(oldV), new_value: String(newV), reason: 'draft edit'
        }, actorId);
      }
    }

    const newSummary = compSummary(rows);
    const reallocMap = { SALARY: 'REALLOC_SALARY', OVERTIME: 'REALLOC_OT', ADVANCE: 'REALLOC_ADV' };
    for (const type of Object.keys(reallocMap)) {
      if (oldSummary[type] !== newSummary[type]) {
        audit(db, {
          payment_id: p.payment_id, action: reallocMap[type], entity: 'payment', entity_id: p.payment_id,
          field_name: type, old_value: oldSummary[type], new_value: newSummary[type],
          reason: 'draft edit'
        }, actorId);
      }
    }
    if (oldSummary.ADDITIONAL !== newSummary.ADDITIONAL) {
      audit(db, {
        payment_id: p.payment_id, action: 'DRAFT_EDIT', entity: 'payment', entity_id: p.payment_id,
        field_name: 'ADDITIONAL', old_value: oldSummary.ADDITIONAL, new_value: newSummary.ADDITIONAL,
        reason: 'draft edit'
      }, actorId);
    }

    for (const intent of engine.audit_intents) {
      if (intent.action === 'DATA_WARNING') {
        audit(db, {
          payment_id: p.payment_id, action: 'DATA_WARNING', entity: 'payment', entity_id: p.payment_id,
          field_name: 'requested_cents', new_value: isInt(p.requested_cents) ? String(p.requested_cents) : 'all',
          reason: 'excess=' + engine.unexplained_excess_cents
        }, actorId);
      }
      if (intent.action === 'ZERO_PAID') {
        audit(db, {
          payment_id: p.payment_id, action: 'ZERO_PAID', entity: 'payment', entity_id: p.payment_id,
          field_name: 'status', new_value: 'DRAFT', reason: 'zero draft'
        }, actorId);
      }
    }

    db.exec('COMMIT');
    return { ok: true, payment_id: p.payment_id, engine, components: rows };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
    const msg = String(err && err.message ? err.message : err);
    if (err && err.refusal) {
      return refused(db, p, err.refusal, err.detail, err.blockers, actorId);
    }
    return refused(db, p, extractAbortCode(msg) || 'INTERNAL', msg, [], actorId);
  }
}

function deleteDraft(db, p) {
  const actorId = p.actor_id;
  if (!isInt(p.payment_id) || p.payment_id <= 0) {
    return refused(db, p, 'PAYMENT_NOT_FOUND', String(p.payment_id), null, actorId);
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const payment = db.prepare('SELECT * FROM payment WHERE id = ?').get(p.payment_id);
    if (!payment) throw refusalError('PAYMENT_NOT_FOUND', String(p.payment_id));
    if (payment.status !== 'DRAFT') throw refusalError('NOT_DRAFT', payment.status);

    const summary = JSON.stringify({
      id: payment.id,
      employee_id: payment.employee_id,
      period_month: payment.period_month,
      earnings_total: payment.earnings_total,
      advance_deduction_total: payment.advance_deduction_total,
      net_cash_paid: payment.net_cash_paid,
      components: payment.total_payment_components
    });

    // D1: delete ADVANCE rows first so trg_component_agg_del never recomputes
    // net_cash_paid below 0 (salary rows temporarily leaving advance behind).
    db.prepare(`DELETE FROM payment_component WHERE payment_id = ? AND type = 'ADVANCE'`).run(p.payment_id);
    db.prepare('DELETE FROM payment_component WHERE payment_id = ?').run(p.payment_id);
    db.prepare('DELETE FROM payment WHERE id = ?').run(p.payment_id);

    audit(db, {
      payment_id: p.payment_id, action: 'DRAFT_DELETE', entity: 'payment', entity_id: p.payment_id,
      field_name: 'status', old_value: 'DRAFT', new_value: 'DELETED',
      reason: 'draft deleted; ' + summary
    }, actorId);

    db.exec('COMMIT');
    return { ok: true, payment_id: p.payment_id };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
    const msg = String(err && err.message ? err.message : err);
    if (err && err.refusal) {
      return refused(db, p, err.refusal, err.detail, err.blockers, actorId);
    }
    return refused(db, p, extractAbortCode(msg) || 'INTERNAL', msg, [], actorId);
  }
}

function finalizeDraft(db, p) {
  const actorId = p.actor_id;
  if (!isInt(p.payment_id) || p.payment_id <= 0) {
    return refused(db, p, 'PAYMENT_NOT_FOUND', String(p.payment_id), null, actorId);
  }
  const op = p.overpayment_cents === undefined || p.overpayment_cents === null ? 0 : p.overpayment_cents;
  if (!isInt(op) || op < 0 || op % 100 !== 0) {
    return refused(db, p, 'INVALID_OVERPAYMENT_CENTS', String(p.overpayment_cents), null, actorId);
  }

  let zeroCode = p.zero_reason_code === undefined || p.zero_reason_code === null || p.zero_reason_code === ''
    ? null : String(p.zero_reason_code);
  let zeroNote = p.zero_reason_note === undefined || p.zero_reason_note === null || p.zero_reason_note === ''
    ? null : String(p.zero_reason_note).slice(0, 500);
  if (zeroCode !== null) {
    if (!ZERO_REASONS.includes(zeroCode)) {
      return refused(db, p, 'INVALID_ZERO_REASON', zeroCode, null, actorId);
    }
    if (zeroCode === 'OTHER_APPROVED' && (!zeroNote || zeroNote.trim().length < 10)) {
      return refused(db, p, 'INVALID_ZERO_REASON', 'note', null, actorId);
    }
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const payment = db.prepare('SELECT * FROM payment WHERE id = ?').get(p.payment_id);
    if (!payment) throw refusalError('PAYMENT_NOT_FOUND', String(p.payment_id));
    if (payment.status !== 'DRAFT') throw refusalError('NOT_DRAFT', payment.status);
    if (!payment.idempotency_key || String(payment.idempotency_key).trim() === '') {
      throw refusalError('IDEMPOTENCY_KEY_REQUIRED', null);
    }

    const comps = db.prepare('SELECT * FROM payment_component WHERE payment_id = ?').all(p.payment_id);
    let salarySum = 0;
    let earningsSum = 0;
    let advSum = 0;
    for (const c of comps) {
      if (!isInt(c.amount) || c.amount <= 0) throw refusalError('INCONSISTENT_BALANCE', 'component amount');
      if (c.type === 'SALARY') { salarySum += c.amount; earningsSum += c.amount; }
      else if (c.type === 'ADVANCE') { advSum += c.amount; }
      else { earningsSum += c.amount; }
    }
    if (earningsSum !== payment.earnings_total || advSum !== payment.advance_deduction_total ||
        earningsSum + advSum !== payment.entered_total) {
      throw refusalError('INCONSISTENT_BALANCE', 'payment aggregates do not match components');
    }

    if (earningsSum === 0) {
      if (zeroCode === null) throw refusalError('ZERO_PAYMENT_REASON_REQUIRED', null);
      if (op > 0) throw refusalError('INVALID_OVERPAYMENT_CENTS', 'zero earnings');
    }

    const obl = db.prepare(
      'SELECT id, status, salary_remaining FROM salary_obligation WHERE id = ? AND employee_id = ?'
    ).get(payment.obligation_id, payment.employee_id);
    if (!obl) throw refusalError('OBLIGATION_NOT_FOUND', String(payment.obligation_id));
    if (salarySum > 0) {
      if (obl.status === 'PAID' || obl.salary_remaining <= 0) {
        throw refusalError('OBLIGATION_FULLY_PAID', String(payment.obligation_id));
      }
      if (salarySum > obl.salary_remaining) throw refusalError('SALARY_OVER_OBLIGATION', null);
    }

    for (const c of comps) {
      if (c.type === 'OVERTIME') {
        const ot = db.prepare(
          'SELECT employee_id, status, payroll_id, total_amount FROM overtime WHERE id = ?'
        ).get(c.overtime_id);
        if (!ot) throw refusalError('OVERTIME_ALLOCATION_INVALID', 'overtime #' + c.overtime_id + ' missing');
        const rowOk = ot.employee_id === payment.employee_id && ot.status === 'Approved' &&
          (ot.payroll_id === null || ot.payroll_id === undefined);
        const used = db.prepare(
          `SELECT COALESCE(SUM(pc.amount), 0) AS s
           FROM payment_component pc JOIN payment p ON p.id = pc.payment_id
           WHERE pc.overtime_id = ? AND pc.payment_id <> ? AND p.status IN ('DRAFT','FINALIZED')`
        ).get(c.overtime_id, payment.id).s;
        const capacity = Math.round(Number(ot.total_amount) * 100);
        if (!rowOk || capacity - used < c.amount) {
          throw refusalError('OVERTIME_ALLOCATION_INVALID', 'overtime #' + c.overtime_id);
        }
      }
      if (c.type === 'ADVANCE') {
        const adv = db.prepare(
          'SELECT employee_id, status, amount, remaining_balance FROM salary_advances WHERE id = ?'
        ).get(c.advance_id);
        if (!adv) throw refusalError('ADVANCE_ALLOCATION_INVALID', 'advance #' + c.advance_id + ' missing');
        if (adv.status === 'Disputed') throw refusalError('ADVANCE_DISPUTED', 'advance #' + c.advance_id);
        if (adv.employee_id !== payment.employee_id ||
            (adv.status !== 'Active' && adv.status !== 'Partially Repaid')) {
          throw refusalError('ADVANCE_ALLOCATION_INVALID', 'advance #' + c.advance_id);
        }
        if (Math.round(Number(adv.remaining_balance) * 100) - c.amount < 0) {
          throw refusalError('ADVANCE_SETTLEMENT_EXCEEDS_BALANCE', 'advance #' + c.advance_id);
        }
        const rep = db.prepare(
          `SELECT COALESCE(SUM(CAST(ROUND(r.amount * 100) AS INTEGER)), 0) AS s
           FROM salary_advance_repayments r WHERE r.advance_id = ?`
        ).get(c.advance_id).s;
        const otherUsed = db.prepare(
          `SELECT COALESCE(SUM(pc.amount), 0) AS s
           FROM payment_component pc JOIN payment p ON p.id = pc.payment_id
           WHERE pc.advance_id = ? AND pc.payment_id <> ? AND p.status IN ('DRAFT','FINALIZED')`
        ).get(c.advance_id, payment.id).s;
        if (Math.round(Number(adv.amount) * 100) - rep - otherUsed < c.amount) {
          throw refusalError('ADVANCE_ALLOCATION_INVALID', 'advance #' + c.advance_id);
        }
      }
    }

    const upd = db.prepare(
      `UPDATE payment
       SET status = 'FINALIZED', finalized_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP,
           zero_reason_code = ?, zero_reason_note = ?
       WHERE id = ? AND status = 'DRAFT'`
    ).run(zeroCode, zeroNote, p.payment_id);
    if (upd.changes !== 1) throw refusalError('NOT_DRAFT', 'status changed during finalize');

    const after = db.prepare('SELECT payment_serial FROM payment WHERE id = ?').get(p.payment_id);
    if (!after.payment_serial || !/^PAY-\d{4}-\d{6}$/.test(after.payment_serial)) {
      throw refusalError('SERIAL_ALLOCATION_FAILED', null);
    }
    const serial = after.payment_serial;

    let recoveryId = null;
    if (op > 0) {
      const exists = db.prepare('SELECT id FROM salary_advances WHERE source_payment_id = ?').get(p.payment_id);
      if (exists) throw refusalError('RECOVERY_ALREADY_EXISTS', String(exists.id));
      const amount = op / 100;
      const rr = db.prepare(
        `INSERT INTO salary_advances
           (employee_id, amount, date, reason, status, remaining_balance, repayment_amount,
            approved_by, notes, source_payment_id, created_at)
         VALUES (?, ?, ?, ?, 'Active', ?, 0, ?, NULL, ?, CURRENT_TIMESTAMP)`
      ).run(
        payment.employee_id, amount, payment.payment_date,
        'overpayment recovery: payment ' + p.payment_id,
        amount, String(p.actor_name || 'admin'), p.payment_id
      );
      recoveryId = Number(rr.lastInsertRowid);
    }

    audit(db, {
      payment_id: p.payment_id, action: 'FINALIZE', entity: 'payment', entity_id: p.payment_id,
      field_name: 'status', old_value: 'DRAFT', new_value: serial,
      reason: JSON.stringify({
        earnings_total: earningsSum,
        advance_deduction_total: advSum,
        net_cash_paid: earningsSum - advSum,
        overpayment_cents: op,
        zero_reason_code: earningsSum === 0 ? zeroCode : null
      })
    }, actorId);

    if (earningsSum === 0) {
      audit(db, {
        payment_id: p.payment_id, action: 'ZERO_PAID', entity: 'payment', entity_id: p.payment_id,
        field_name: 'zero_reason_code', new_value: zeroCode, reason: zeroNote || 'zero payment'
      }, actorId);
    }
    if (op > 0) {
      audit(db, {
        payment_id: p.payment_id, action: 'OVERPAYMENT_CREATED', entity: 'advance', entity_id: recoveryId,
        field_name: 'amount', new_value: String(op),
        reason: 'overpayment recovery for payment #' + p.payment_id
      }, actorId);
    }

    db.exec('COMMIT');
    return {
      ok: true, payment_id: p.payment_id, serial, recovery_id: recoveryId,
      overpayment_cents: op, earnings_total: earningsSum,
      advance_deduction_total: advSum, net_cash_paid: earningsSum - advSum
    };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
    const msg = String(err && err.message ? err.message : err);
    if (err && err.refusal) {
      return refused(db, p, err.refusal, err.detail, err.blockers, actorId);
    }
    return refused(db, p, extractAbortCode(msg) || 'INTERNAL', msg, [], actorId);
  }
}

/* -------------------------------------------------------- 25C handlers */

function wantsJson(req) {
  return String(req.headers && req.headers.accept ? req.headers.accept : '').includes('application/json') ||
    (req.headers && req.headers['x-requested-with'] === 'XMLHttpRequest');
}

function refusalMessage(t, refusal, blockers) {
  const mapped = REFUSAL_T[refusal];
  let msg = t('hr.payments.' + (mapped || 'err_generic'));
  if (blockers && blockers.length) msg += ': ' + blockers.join(', ');
  else if (!mapped && refusal) msg += ': ' + refusal;
  return msg;
}

function loadEmployees(db) {
  return db.prepare(
    `SELECT e.id, e.full_name, e.employee_id AS employee_code, d.name AS department_name
     FROM hr_employees e LEFT JOIN departments d ON d.id = e.department_id
     WHERE e.employment_status = 'Active' ORDER BY e.full_name ASC`
  ).all();
}

function loadFilterEmployees(db) {
  return db.prepare(
    `SELECT e.id, e.full_name, e.employee_id AS employee_code, d.name AS department_name
     FROM hr_employees e LEFT JOIN departments d ON d.id = e.department_id
     WHERE e.employment_status = 'Active'
     UNION
     SELECT e.id, e.full_name, e.employee_id AS employee_code, d.name AS department_name
     FROM hr_employees e LEFT JOIN departments d ON d.id = e.department_id
     WHERE EXISTS (SELECT 1 FROM payment p WHERE p.employee_id = e.id)
     ORDER BY full_name ASC`
  ).all();
}

/* ------------------------------------------------ HR-24 workspace (read-only) */

function loadWorkspaceEmployee(db, employeeId, periodMonth) {
  try {
    const row = db.prepare(
      `SELECT e.id, e.employee_id AS employee_code, e.full_name, e.father_name, e.date_of_birth,
              e.phone, e.position, e.contract_type, e.hire_date, e.employment_status,
              e.work_schedule_id, d.name AS department_name
       FROM hr_employees e LEFT JOIN departments d ON d.id = e.department_id
       WHERE e.id = ?`
    ).get(employeeId) || null;
    if (row) {
      const sal = currentBasicSalary(db, employeeId, periodMonth);
      row.basic_salary = sal.basic_salary;
      row.basic_salary_from = sal.basic_salary_from;
    }
    return row;
  } catch (e) {
    return null;
  }
}

function listOpenObligations(db, employeeId) {
  try {
    return db.prepare(
      `SELECT id, employee_id, earning_month, salary_earned, salary_paid, salary_remaining,
              status, source_note, created_at
       FROM salary_obligation
       WHERE employee_id = ? AND status IN ('OPEN','PARTIAL')
       ORDER BY earning_month DESC, id DESC`
    ).all(employeeId);
  } catch (e) {
    return [];
  }
}

function queryEmployeeHistory(db, employeeId) {
  try {
    return db.prepare(
      `SELECT id, payment_serial, period_month, payment_date, status, earnings_total, salary_total,
              overtime_total, additional_total, advance_deduction_total, entered_total, net_cash_paid,
              payment_method, position, basic_salary_applied, created_at, finalized_at
       FROM payment
       WHERE employee_id = ?
       ORDER BY id DESC
       LIMIT 24`
    ).all(employeeId);
  } catch (e) {
    return [];
  }
}

function safeBalances(db, employeeId) {
  try {
    return computeEmployeeBalances(db, employeeId);
  } catch (e) {
    return null;
  }
}

function safeEntitlement(db, employeeId, month) {
  try {
    return calculateEntitlement(db, employeeId, month);
  } catch (e) {
    return null;
  }
}

/* HR-25 G1 - display read of the current contract basic salary from
 * employee_salary_history (same table the entitlement engine reads).
 * Covers the selected period when possible, falls back to the latest row.
 * Display only; no allocation or entitlement math happens here. */
function currentBasicSalary(db, employeeId, periodMonth) {
  const empty = { basic_salary: null, basic_salary_from: null };
  try {
    const rows = db.prepare(
      `SELECT basic_salary, effective_from, effective_to
       FROM employee_salary_history
       WHERE employee_id = ?
       ORDER BY effective_from DESC, id DESC`
    ).all(employeeId);
    if (!rows || !rows.length) return empty;
    const pm = typeof periodMonth === 'string' ? periodMonth : '';
    if (/^\d{4}\/\d{2}\/01$/.test(pm)) {
      let ny = Number(pm.slice(0, 4));
      let nm = Number(pm.slice(5, 7)) + 1;
      if (nm > 12) { nm = 1; ny += 1; }
      const nextStart = ny + '/' + String(nm).padStart(2, '0') + '/01';
      for (const r of rows) {
        const from = String(r.effective_from === null || r.effective_from === undefined ? '' : r.effective_from);
        const to = r.effective_to === null || r.effective_to === undefined ? null : String(r.effective_to);
        if (from !== '' && from < nextStart && (to === null || to >= pm)) {
          return { basic_salary: r.basic_salary, basic_salary_from: from };
        }
      }
    }
    return { basic_salary: rows[0].basic_salary,
      basic_salary_from: rows[0].effective_from === null || rows[0].effective_from === undefined
        ? null : String(rows[0].effective_from) };
  } catch (e) {
    return empty;
  }
}

/* HR-25 G6 - presentation-only aggregates over already-authoritative G3
 * figures. Company group = salary_outstanding + ot_eligible_remaining
 * (disjoint). Employee group = advance_owed only (advance_allocatable is a
 * subset and is never added). Any missing component yields null (rendered
 * as "-"); the two groups are never netted against each other. */
function computeBalTotals(bal) {
  const out = { company: null, employee: null };
  if (!bal) return out;
  const val = function (f) {
    return f && typeof f.value_cents === 'number' ? f.value_cents : null;
  };
  const co = bal.company_owed || {};
  const em = bal.employee_owed || {};
  const a = val(co.salary_outstanding);
  const b = val(co.ot_eligible_remaining);
  const c = val(em.advance_owed);
  if (a !== null && b !== null) out.company = a + b;
  out.employee = c;
  return out;
}

/* Assembles MANUAL selections from the named workspace input fields
 * (msal_<id> / mot_<id> / madv_<id>, amounts in display units). Conversion
 * to integer cents happens here, server-side; empty fields are no intent. */
function assembleManual(body) {
  const out = [];
  const seen = {};
  const prefixes = [['msal_', 'SALARY'], ['mot_', 'OVERTIME'], ['madv_', 'ADVANCE']];
  let anyField = false;
  for (let i = 0; i < prefixes.length; i++) {
    const prefix = prefixes[i][0];
    const type = prefixes[i][1];
    for (const key of Object.keys(body)) {
      if (key.indexOf(prefix) !== 0) continue;
      const id = Number(key.slice(prefix.length));
      if (!Number.isInteger(id) || id <= 0) continue;
      anyField = true;
      const raw = body[key];
      if (raw === undefined || raw === null || String(raw).trim() === '') continue;
      const n = Number(String(raw).trim());
      const dedupe = type + ':' + id;
      if (seen[dedupe]) continue;
      seen[dedupe] = true;
      out.push({
        source_type: type,
        source_id: id,
        amount_cents: Number.isFinite(n) ? Math.round(n * 100) : NaN
      });
    }
  }
  if (!anyField) return undefined;
  return out.length ? out : undefined;
}

function collectManualValues(body) {
  const out = {};
  for (const key of Object.keys(body)) {
    if (/^(msal|madv|mot)_\d+$/.test(key)) out[key] = String(body[key]);
  }
  return out;
}

function notify(db, type, message, relatedId, relatedType, username) {
  try {
    const nr = db.prepare(
      `INSERT INTO admin_notifications
         (type, message, related_record_id, related_record_type, created_by, recipient, is_read, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)`
    ).run(type, message, relatedId, relatedType, username, username);
    notificationSSE.broadcast({
      id: Number(nr.lastInsertRowid),
      type,
      message,
      related_record_id: relatedId,
      related_record_type: relatedType,
      created_by: username,
      recipient: username,
      is_read: 0,
      created_at: new Date().toISOString()
    });
  } catch (e) {
    console.error('[payment] notification error (transaction committed):', e && e.message);
  }
}

function parseManual(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed;
    } catch (e) {
      return raw;
    }
  }
  return raw;
}

/* HR-25 include/exclude controls. include_controls marker distinguishes new
 * checkbox requests from legacy bodies: without the marker every component
 * stays included (exact HR-24 behavior). */
function parseIncludes(body) {
  const b = body || {};
  const controlled = String(b.include_controls || '') === '1';
  if (!controlled) {
    return { salary: true, overtime: true, advance: true, controlled: false };
  }
  return {
    salary: String(b.include_salary || '') === '1',
    overtime: String(b.include_overtime || '') === '1',
    advance: String(b.include_advance || '') === '1',
    controlled: true
  };
}

function includesNone(inc) {
  return !!(inc && inc.controlled && !inc.salary && !inc.overtime && !inc.advance);
}

function baseForm(body) {
  return {
    employee_id: body.employee_id === undefined ? '' : String(body.employee_id),
    period_month: body.period_month === undefined ? '' : String(body.period_month),
    payment_date: body.payment_date === undefined ? '' : String(body.payment_date),
    requested_amount: body.requested_amount === undefined ? '' : String(body.requested_amount),
    mode: body.mode === undefined || body.mode === '' ? 'FIFO' : String(body.mode),
    payment_method: body.payment_method === undefined || body.payment_method === '' ? 'CASH' : String(body.payment_method),
    payment_reference: body.payment_reference === undefined ? '' : String(body.payment_reference),
    notes: body.notes === undefined ? '' : String(body.notes),
    duplicate_confirmed: String(body.duplicate_confirmed || '') === '1',
    idempotency_key: body.idempotency_key === undefined ? '' : String(body.idempotency_key),
    additional_amount: body.additional_amount === undefined ? '' : String(body.additional_amount),
    additional_reason: body.additional_reason === undefined ? '' : String(body.additional_reason),
    additional_note: body.additional_note === undefined ? '' : String(body.additional_note),
    manual_values: collectManualValues(body)
  };
}

function draftParams(body, session) {
  const form = baseForm(body);
  const parsedManual = parseManual(body.manual_selections);
  const manualSelections = (parsedManual !== undefined && parsedManual !== null)
    ? parsedManual
    : (form.mode === 'MANUAL' ? assembleManual(body) : undefined);
  return {
    employee_id: Number(form.employee_id),
    period_month: form.period_month,
    payment_date: form.payment_date,
    requested_cents: centsFromUnits(form.requested_amount),
    mode: form.mode,
    manual_selections: manualSelections,
    includes: parseIncludes(body),
    idempotency_key: form.idempotency_key,
    duplicate_confirmed: form.duplicate_confirmed,
    payment_method: form.payment_method,
    payment_reference: form.payment_reference,
    notes: form.notes,
    additional_amount: form.additional_amount,
    additional_reason: form.additional_reason,
    additional_note: form.additional_note,
    actor_id: Number(session.user_id)
  };
}

/* PHASE 26 — optional list filters (employee_id / period_month / status).
 * Invalid values are ignored, never injected: values are bound as parameters
 * and the no-filter path keeps the original plain ORDER BY id DESC query. */
function normalizeFilters(f) {
  const out = {};
  const raw = f && f.employee_id !== undefined ? f.employee_id : '';
  const emp = Number(raw);
  if (raw !== '' && raw !== null && raw !== undefined && Number.isInteger(emp) && emp > 0) {
    out.employee_id = emp;
  }
  const pm = f && typeof f.period_month === 'string' ? f.period_month : '';
  if (validatePeriodMonth(pm)) out.period_month = pm;
  const st = f && typeof f.status === 'string' ? f.status : '';
  if (st === 'DRAFT' || st === 'FINALIZED' || st === 'CORRECTED') out.status = st;
  return out;
}

function queryPayments(db, filters) {
  const f = normalizeFilters(filters);
  const where = [];
  const args = [];
  if (f.employee_id !== undefined) { where.push('employee_id = ?'); args.push(f.employee_id); }
  if (f.period_month !== undefined) { where.push('period_month = ?'); args.push(f.period_month); }
  if (f.status !== undefined) { where.push('status = ?'); args.push(f.status); }
  const sql =
    `SELECT id, payment_serial, employee_id, employee_name, department_name, period_month, payment_date,
            status, earnings_total, advance_deduction_total, net_cash_paid, total_payment_components,
            created_at, finalized_at, duplicate_confirmed
     FROM payment` +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY id DESC';
  return db.prepare(sql).all(...args);
}

function listPayments(req, res) {
  let db;
  try {
    db = openDb(true);
    const filters = normalizeFilters(req.query);
    const payments = queryPayments(db, filters);
    const employees = loadFilterEmployees(db);
    return res.render('hr/payments', { mode: 'list', payments, employees, filters });
  } catch (err) {
    console.error('[payment] list error:', err);
    req.session.message = { type: 'error', text: res.locals.t('hr.payments.err_generic') };
    return res.redirect('/admin/hr');
  } finally {
    if (db) { try { db.close(); } catch (e) { /* ignore */ } }
  }
}

function createForm(req, res) {
  let db;
  try {
    db = openDb(true);
    const employees = loadEmployees(db);
    const form = baseForm(req.query);
    form.employee_id = req.query.employee_id ? String(req.query.employee_id) : '';
    const qMonth = req.query.period_month ? String(req.query.period_month)
      : (req.query.month ? String(req.query.month) : '');
    form.period_month = validatePeriodMonth(qMonth) ? qMonth : defaultMonth();
    if (!validatePaymentDate(form.payment_date)) {
      form.payment_date = getCurrentJalaliDate();
    }
    form.idempotency_key = crypto.randomUUID();
    const includes = parseIncludes(req.query);
    const isPreview = String(req.query.preview || '') === '1';

    let preview = null;
    const empId = Number(form.employee_id);
    if (form.employee_id !== '' && isInt(empId) && empId > 0 && validatePeriodMonth(form.period_month)) {
      try {
        const engineParams = { employee_id: empId, period_month: form.period_month };
        if (isPreview) {
          const p = draftParams(req.query, req.session || {});
          engineParams.mode = p.mode;
          engineParams.requested_cents = p.requested_cents;
          engineParams.manual_selections = p.manual_selections;
          engineParams.includes = p.includes;
        }
        const { engine, input } = runEngine(db, engineParams);
        const obl = db.prepare(
          'SELECT * FROM salary_obligation WHERE employee_id = ? AND earning_month = ?'
        ).get(empId, form.period_month) || null;
        preview = { engine, obligation: obl, sources: input, includes };
        if (isPreview) {
          preview.mode_preview = true;
          preview.after = summarizeEngine(engine);
        }
      } catch (e) {
        preview = null;
      }
      if (preview) {
        preview.employee = loadWorkspaceEmployee(db, empId, form.period_month);
        preview.balances = safeBalances(db, empId);
        preview.balTotals = computeBalTotals(preview.balances);
        preview.attendance = safeEntitlement(db, empId, form.period_month);
        preview.openObligations = listOpenObligations(db, empId);
        preview.history = queryEmployeeHistory(db, empId);
      }
    }
    return res.render('hr/payments', { mode: 'create', form, employees, preview, includes });
  } catch (err) {
    console.error('[payment] create form error:', err);
    req.session.message = { type: 'error', text: res.locals.t('hr.payments.err_generic') };
    return res.redirect('/admin/hr');
  } finally {
    if (db) { try { db.close(); } catch (e) { /* ignore */ } }
  }
}

function paymentDetail(req, res) {
  const id = Number(req.params.id);
  if (!isInt(id) || id <= 0) {
    req.session.message = { type: 'error', text: res.locals.t('hr.payments.err_not_found') };
    return res.redirect('/admin/hr/payments');
  }
  let db;
  try {
    db = openDb(true);
    const payment = db.prepare('SELECT * FROM payment WHERE id = ?').get(id);
    if (!payment) {
      req.session.message = { type: 'error', text: res.locals.t('hr.payments.err_not_found') };
      return res.redirect('/admin/hr/payments');
    }
    const components = db.prepare(
      `SELECT * FROM payment_component WHERE payment_id = ?
       ORDER BY CASE type WHEN 'SALARY' THEN 0 WHEN 'OVERTIME' THEN 1 WHEN 'ADDITIONAL' THEN 2 ELSE 3 END, seq, id`
    ).all(id);
    const audits = db.prepare(
      'SELECT * FROM payment_audit WHERE payment_id = ? ORDER BY id DESC'
    ).all(id);
    const obligation = payment.obligation_id
      ? db.prepare('SELECT * FROM salary_obligation WHERE id = ?').get(payment.obligation_id) || null
      : null;
    const recovery = db.prepare(
      'SELECT id, amount, status, remaining_balance, created_at FROM salary_advances WHERE source_payment_id = ?'
    ).get(id) || null;
    return res.render('hr/payments', {
      mode: 'detail', payment, components, audits, obligation, recovery
    });
  } catch (err) {
    console.error('[payment] detail error:', err);
    req.session.message = { type: 'error', text: res.locals.t('hr.payments.err_generic') };
    return res.redirect('/admin/hr/payments');
  } finally {
    if (db) { try { db.close(); } catch (e) { /* ignore */ } }
  }
}

function createPayment(req, res) {
  const params = draftParams(req.body, req.session);
  if (!isInt(params.actor_id) || params.actor_id <= 0) {
    req.session.message = { type: 'error', text: res.locals.t('hr.payments.err_generic') };
    return res.redirect('/admin/hr/payments/create');
  }
  if (includesNone(params.includes)) {
    req.session.message = { type: 'error', text: res.locals.t('hr.payws.val_none_selected') };
    return res.redirect('/admin/hr/payments/create');
  }
  const form = baseForm(req.body);
  let db;
  let result;
  try {
    db = openDb(false);
    result = createDraft(db, params);
  } catch (err) {
    console.error('[payment] create error:', err);
    if (db) { try { db.close(); } catch (e) { /* ignore */ } }
    if (wantsJson(req)) return res.status(500).json({ ok: false, refusal: 'INTERNAL' });
    req.session.message = { type: 'error', text: res.locals.t('hr.payments.err_generic') };
    return res.redirect('/admin/hr/payments/create');
  }

  if (result.ok) {
    const username = String(req.session.username || 'admin');
    notify(db, 'hr_payment_created',
      res.locals.t('hr.payments.ok_created') + ' #' + result.payment_id,
      result.payment_id, 'payment', username);
    db.close();
    if (wantsJson(req)) return res.json({ ok: true, payment_id: result.payment_id });
    req.session.message = { type: 'success', text: res.locals.t('hr.payments.ok_created') + ' #' + result.payment_id };
    return res.redirect('/admin/hr/payments/' + result.payment_id);
  }

  db.close();
  if (wantsJson(req)) {
    return res.status(409).json({
      ok: false, refusal: result.refusal, blockers: result.blockers, payment_id: result.payment_id
    });
  }
  if (result.refusal === 'DUPLICATE_SUBMIT') {
    req.session.message = { type: 'error', text: res.locals.t('hr.payments.err_duplicate_submit') };
    return res.redirect(303, '/admin/hr/payments/' + result.existing_id);
  }
  let employees = [];
  let preview = null;
  let db2;
  try {
    db2 = openDb(true);
    employees = loadEmployees(db2);
    const empId = Number(form.employee_id);
    if (isInt(empId) && empId > 0 && validatePeriodMonth(form.period_month)) {
      const { engine, input } = runEngine(db2, { employee_id: empId, period_month: form.period_month,
        requested_cents: centsFromUnits(form.requested_amount), mode: form.mode,
        manual_selections: form.mode === 'MANUAL'
          ? (parseManual(req.body.manual_selections) || assembleManual(req.body))
          : parseManual(req.body.manual_selections),
        includes: parseIncludes(req.body) });
      preview = { engine, obligation: db2.prepare(
        'SELECT * FROM salary_obligation WHERE employee_id = ? AND earning_month = ?'
      ).get(empId, form.period_month) || null, sources: input, includes: parseIncludes(req.body) };
      preview.employee = loadWorkspaceEmployee(db2, empId, form.period_month);
      preview.balances = safeBalances(db2, empId);
      preview.attendance = safeEntitlement(db2, empId, form.period_month);
      preview.openObligations = listOpenObligations(db2, empId);
      preview.history = queryEmployeeHistory(db2, empId);
    }
  } catch (e) {
    employees = employees || [];
  } finally {
    if (db2) { try { db2.close(); } catch (e) { /* ignore */ } }
  }
  return res.status(200).render('hr/payments', {
    mode: 'create', form, employees, preview, includes: parseIncludes(req.body),
    refusal: result.refusal, blockers: result.blockers,
    engine: result.engine || (preview && preview.engine) || null
  });
}

function editPayment(req, res) {
  const id = Number(req.params.id);
  const params = draftParams(req.body, req.session);
  params.payment_id = id;
  if (!isInt(params.actor_id) || params.actor_id <= 0) {
    req.session.message = { type: 'error', text: res.locals.t('hr.payments.err_generic') };
    return res.redirect('/admin/hr/payments');
  }
  if (includesNone(params.includes)) {
    req.session.message = { type: 'error', text: res.locals.t('hr.payws.val_none_selected') };
    return res.redirect('/admin/hr/payments');
  }
  let db;
  let result;
  try {
    db = openDb(false);
    result = editDraft(db, params);
  } catch (err) {
    console.error('[payment] edit error:', err);
    if (db) { try { db.close(); } catch (e) { /* ignore */ } }
    if (wantsJson(req)) return res.status(500).json({ ok: false, refusal: 'INTERNAL' });
    req.session.message = { type: 'error', text: res.locals.t('hr.payments.err_generic') };
    return res.redirect('/admin/hr/payments');
  }
  db.close();

  if (result.ok) {
    if (wantsJson(req)) return res.json({ ok: true, payment_id: result.payment_id });
    req.session.message = { type: 'success', text: res.locals.t('hr.payments.ok_updated') + ' #' + result.payment_id };
    return res.redirect('/admin/hr/payments/' + result.payment_id);
  }
  if (wantsJson(req)) {
    return res.status(409).json({
      ok: false, refusal: result.refusal, blockers: result.blockers, payment_id: result.payment_id
    });
  }
  if (result.refusal === 'PAYMENT_NOT_FOUND' || result.refusal === 'NOT_DRAFT') {
    req.session.message = { type: 'error', text: refusalMessage(res.locals.t, result.refusal) };
    return res.redirect('/admin/hr/payments');
  }
  let db2;
  try {
    db2 = openDb(true);
    const payment = db2.prepare('SELECT * FROM payment WHERE id = ?').get(id);
    const components = db2.prepare(
      'SELECT * FROM payment_component WHERE payment_id = ? ORDER BY type, seq, id'
    ).all(id);
    const employees = loadEmployees(db2);
    return res.status(200).render('hr/payments', {
      mode: 'edit', payment, components, employees,
      form: baseForm(req.body),
      includes: parseIncludes(req.body),
      refusal: result.refusal, blockers: result.blockers, engine: result.engine || null
    });
  } catch (e) {
    req.session.message = { type: 'error', text: res.locals.t('hr.payments.err_generic') };
    return res.redirect('/admin/hr/payments');
  } finally {
    if (db2) { try { db2.close(); } catch (e) { /* ignore */ } }
  }
}

function finalizePayment(req, res) {
  const id = Number(req.params.id);
  const body = req.body || {};
  const params = {
    payment_id: id,
    overpayment_cents: centsFromUnits(body.overpayment_amount),
    zero_reason_code: body.zero_reason_code === undefined ? '' : String(body.zero_reason_code),
    zero_reason_note: body.zero_reason_note === undefined ? '' : String(body.zero_reason_note),
    actor_id: Number(req.session.user_id),
    actor_name: String(req.session.username || 'admin')
  };
  if (!isInt(params.actor_id) || params.actor_id <= 0) {
    req.session.message = { type: 'error', text: res.locals.t('hr.payments.err_generic') };
    return res.redirect('/admin/hr/payments');
  }
  let db;
  let result;
  try {
    db = openDb(false);
    result = finalizeDraft(db, params);
  } catch (err) {
    console.error('[payment] finalize error:', err);
    if (db) { try { db.close(); } catch (e) { /* ignore */ } }
    if (wantsJson(req)) return res.status(500).json({ ok: false, refusal: 'INTERNAL' });
    req.session.message = { type: 'error', text: res.locals.t('hr.payments.err_generic') };
    return res.redirect('/admin/hr/payments');
  }

  if (result.ok) {
    const username = String(req.session.username || 'admin');
    notify(db, 'hr_payment_finalized',
      res.locals.t('hr.payments.ok_finalized') + ' ' + result.serial,
      result.payment_id, 'payment', username);
    db.close();
    if (wantsJson(req)) {
      return res.json({ ok: true, payment_id: result.payment_id, serial: result.serial,
        overpayment_cents: result.overpayment_cents, recovery_id: result.recovery_id });
    }
    req.session.message = { type: 'success', text: res.locals.t('hr.payments.ok_finalized') + ' ' + result.serial };
    return res.redirect('/admin/hr/payments/' + result.payment_id);
  }

  db.close();
  if (wantsJson(req)) {
    return res.status(409).json({
      ok: false, refusal: result.refusal, blockers: result.blockers, payment_id: result.payment_id
    });
  }
  req.session.message = { type: 'error', text: refusalMessage(res.locals.t, result.refusal, result.blockers) };
  return res.redirect('/admin/hr/payments/' + id);
}

function deletePayment(req, res) {
  const id = Number(req.params.id);
  const params = { payment_id: id, actor_id: Number(req.session.user_id) };
  if (!isInt(params.actor_id) || params.actor_id <= 0) {
    req.session.message = { type: 'error', text: res.locals.t('hr.payments.err_generic') };
    return res.redirect('/admin/hr/payments');
  }
  let db;
  let result;
  try {
    db = openDb(false);
    result = deleteDraft(db, params);
  } catch (err) {
    console.error('[payment] delete error:', err);
    if (db) { try { db.close(); } catch (e) { /* ignore */ } }
    if (wantsJson(req)) return res.status(500).json({ ok: false, refusal: 'INTERNAL' });
    req.session.message = { type: 'error', text: res.locals.t('hr.payments.err_generic') };
    return res.redirect('/admin/hr/payments');
  }
  db.close();

  if (result.ok) {
    if (wantsJson(req)) return res.json({ ok: true, payment_id: result.payment_id });
    req.session.message = { type: 'success', text: res.locals.t('hr.payments.ok_deleted') + ' #' + result.payment_id };
    return res.redirect('/admin/hr/payments');
  }
  if (wantsJson(req)) {
    return res.status(409).json({
      ok: false, refusal: result.refusal, blockers: result.blockers, payment_id: result.payment_id
    });
  }
  req.session.message = { type: 'error', text: refusalMessage(res.locals.t, result.refusal, result.blockers) };
  return res.redirect('/admin/hr/payments/' + id);
}

module.exports = {
  foundationStatus,
  auditLegacyFence,
  listPayments,
  createForm,
  paymentDetail,
  createPayment,
  editPayment,
  finalizePayment,
  deletePayment,
  _internals: {
    CUTOVER,
    ZERO_REASONS,
    ADDITIONAL_REASONS,
    ZERO_REASON_T,
    ADDITIONAL_REASON_T,
    isInt,
    centsFromUnits,
    validatePeriodMonth,
    validatePaymentDate,
    defaultMonth,
    parseIncludes,
    includesNone,
    computeBalTotals,
    currentBasicSalary,
    buildEngineInput,
    runEngine,
    componentRowsFor,
    compSummary,
    resolveAdditional,
    notify,
    audit,
    auditBlocked,
    auditDuplicateSubmit,
    createDraft,
    editDraft,
    deleteDraft,
    finalizeDraft,
    normalizeFilters,
    queryPayments
  }
};
