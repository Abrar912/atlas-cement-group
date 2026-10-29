'use strict';

/**
 * Add Salary — STEP 1 of the 3-step payment wizard ("Who and when").
 *
 * Route: GET /admin/hr/payroll/add-salary (requireAdmin), registered in
 * routes/hrRoutes.js BEFORE GET /admin/hr/payroll/:id.
 *
 * Scope:
 *   1. GET only — no POST handler, no financial writes of any kind.
 *   2. Loads the Active employee list (same source as paymentController).
 *   3. Supplies defaults: current Jalali period month + today's Jalali date.
 *   4. Continue submits employee_id / period_month / payment_date to Step 2:
 *      GET /admin/hr/payroll/add-salary/step2  (added in Phase 2).
 *
 * HR12_DB_PATH — test-only redirection hook for disposable fixture DBs
 * (production leaves it unset; the project DB is opened read-only).
 */

const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { getCurrentJalaliMonth, getCurrentJalaliDate, validateJalaliDate } = require('../middleware/i18n');
const { calculateEntitlement } = require('../utils/salaryEntitlementEngine');
const { computeEmployeeBalances } = require('../utils/employeeBalanceService');
const paymentInternals = require('./paymentController')._internals;

const ROOT = path.join(__dirname, '..');
const DEFAULT_DB_PATH = path.join(ROOT, 'enterprise_cement.db');
const CUTOVER = '1405/07/01';

function resolveDbPath() {
  return process.env.HR12_DB_PATH ? path.resolve(process.env.HR12_DB_PATH) : DEFAULT_DB_PATH;
}

function openReadOnlyDb() {
  return new DatabaseSync(resolveDbPath(), { readOnly: true });
}

/* Same employee source/shape as paymentController.loadEmployees (Active only). */
function loadEmployeeList(db) {
  return db.prepare(
    `SELECT e.id, e.full_name, e.employee_id AS employee_code, d.name AS department_name
     FROM hr_employees e LEFT JOIN departments d ON d.id = e.department_id
     WHERE e.employment_status = 'Active' ORDER BY e.full_name ASC`
  ).all();
}

function loadEmployeeInfo(db, id) {
  return db.prepare(
    `SELECT e.id, e.full_name, e.employee_id AS employee_code, e.position,
            e.employment_status, d.name AS department_name
     FROM hr_employees e LEFT JOIN departments d ON d.id = e.department_id
     WHERE e.id = ?`
  ).get(id) || null;
}

/* Authoritative current salary row only (effective_to IS NULL). No calculation. */
function loadCurrentSalary(db, id) {
  return db.prepare(
    `SELECT basic_salary, allowances, effective_from
     FROM employee_salary_history
     WHERE employee_id = ? AND effective_to IS NULL
     ORDER BY id DESC LIMIT 1`
  ).get(id) || null;
}

function pad2(n) { return String(n).padStart(2, '0'); }

/* Accepts the Step-1 'YYYY/MM' input (and the normalized 'YYYY/MM/01'
 * form passed along by Step 2), returns normalized 'YYYY/MM/01'
 * (must be a real Jalali month and not before the engine cutover) or null. */
function normalizePeriodMonth(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  let parts = null;
  const m = /^(\d{4})\/(\d{1,2})$/.exec(s);
  const m2 = /^(\d{4})\/(\d{1,2})\/01$/.exec(s);
  if (m) parts = [Number(m[1]), Number(m[2])];
  else if (m2) parts = [Number(m2[1]), Number(m2[2])];
  if (!parts || !validateJalaliDate(parts[0], parts[1], 1)) return null;
  const norm = `${parts[0]}/${pad2(parts[1])}/01`;
  return norm < CUTOVER ? null : norm;
}

function normalizePaymentDate(raw) {
  if (typeof raw !== 'string' || !/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(raw.trim())) return null;
  const parts = raw.trim().split('/').map(Number);
  if (!validateJalaliDate(parts[0], parts[1], parts[2])) return null;
  return `${parts[0]}/${pad2(parts[1])}/${pad2(parts[2])}`;
}

/* G3 figure -> { state, afn } for the view (cents -> AFN). */
function figureOf(balances, group, code) {
  const fig = balances && balances[group] && balances[group][code] ? balances[group][code] : null;
  if (!fig) return { state: 'UNAVAILABLE', afn: null };
  const usable = (fig.state === 'VERIFIED_AMOUNT' || fig.state === 'VALID_ZERO') &&
    typeof fig.value_cents === 'number';
  return { state: fig.state, afn: usable ? fig.value_cents / 100 : null, reason: fig.reason_code || null };
}

function addSalaryShell(req, res) {
  let db;
  try {
    db = openReadOnlyDb();
    const employees = loadEmployeeList(db);

    return res.render('hr/add-salary', {
      employees: employees,
      defaultMonth: getCurrentJalaliMonth(),
      defaultDate: getCurrentJalaliDate()
    });
  } catch (err) {
    console.error('[addSalary] step1 error:', err);
    return res.redirect('/admin/hr');
  } finally {
    if (db) { try { db.close(); } catch (e) { /* already closed */ } }
  }
}

/* ------------------------------------------------------------------ *
 * STEP 2 — "What to pay" (GET only, read-only data load).
 * Shows the attendance summary + amounts, and the three payment
 * sections (Salary / Overtime / Advance) with editable amounts.
 * Continue hands everything to STEP 3 for confirmation.
 * ------------------------------------------------------------------ */
function addSalaryStep2(req, res) {
  let db;
  try {
    const empId = Number(req.query.employee_id);
    const period = normalizePeriodMonth(req.query.period_month);
    const paymentDate = normalizePaymentDate(req.query.payment_date);
    if (!Number.isInteger(empId) || empId <= 0 || !period || !paymentDate) {
      req.session.message = { type: 'error', text: res.locals.t('hr.addSalary.err_period_invalid') };
      return res.redirect('/admin/hr/payroll/add-salary');
    }

    db = openReadOnlyDb();

    const employee = loadEmployeeInfo(db, empId);
    if (!employee) {
      req.session.message = { type: 'error', text: res.locals.t('hr.addSalary.err_employee_required') };
      return res.redirect('/admin/hr/payroll/add-salary');
    }

    const salary = loadCurrentSalary(db, empId);

    let entitlement = null;
    try { entitlement = calculateEntitlement(db, empId, period); } catch (e) { entitlement = null; }

    let balances = null;
    try { balances = computeEmployeeBalances(db, empId); } catch (e) { balances = null; }

    const obl = db.prepare(
      'SELECT salary_earned, salary_paid, status FROM salary_obligation WHERE employee_id = ? AND earning_month = ?'
    ).get(empId, period) || null;

    /* --- Prefill amounts (AFN, whole/fractional) --------------------- */
    // OWNER POLICY (manual authority + unrecorded-day rule): the box
    // SUGGESTS what is earned so far (recorded days - already paid), but the
    // operator may fill in ANY amount up to the unpaid total: salaryMax =
    // the obligation's remaining balance, GROWN to the live recorded-days
    // figure minus paid when more attendance was recorded since the
    // obligation opened (persisted upward-only by ensureObligation at
    // accept). Unrecorded days earn nothing - there is no paying ahead of
    // recorded attendance. The DB triggers still hard-cap paid at
    // salary_earned.
    let salaryDue = null;
    let salaryMax = null;
    if (obl && typeof obl.salary_earned === 'number' && typeof obl.salary_paid === 'number') {
      let liveFull = null;
      try { liveFull = calculateEntitlement(db, empId, period, { countFutureDays: true }); } catch (e) { liveFull = null; }
      const liveCents = (liveFull && liveFull.status !== 'BLOCKED' && typeof liveFull.salary_entitlement === 'number')
        ? Math.round(liveFull.salary_entitlement * 100) : null;
      const storedRemaining = Math.max(0, obl.salary_earned - obl.salary_paid);
      const remainingCents = liveCents !== null
        ? Math.max(storedRemaining, liveCents - obl.salary_paid)
        : storedRemaining;
      const elapsedCents = (entitlement && typeof entitlement.salary_entitlement === 'number')
        ? Math.round(entitlement.salary_entitlement * 100) : null;
      const dueCents = elapsedCents !== null
        ? Math.min(remainingCents, Math.max(0, elapsedCents - obl.salary_paid))
        : remainingCents;
      salaryDue = dueCents / 100;
      salaryMax = remainingCents / 100;
    } else if (entitlement && typeof entitlement.salary_entitlement === 'number') {
      salaryDue = entitlement.salary_entitlement; // shown with warning chips if any
      // No obligation yet: the cap is the recorded-days figure the
      // auto-open records (countFutureDays=true); null when attendance is
      // BLOCKED.
      let fullEnt = null;
      try { fullEnt = calculateEntitlement(db, empId, period, { countFutureDays: true }); } catch (e) { fullEnt = null; }
      if (fullEnt && fullEnt.status !== 'BLOCKED' && typeof fullEnt.salary_entitlement === 'number') {
        salaryMax = Math.round(fullEnt.salary_entitlement * 100) / 100;
      }
    }

    const otFig = figureOf(balances, 'company_owed', 'ot_eligible_remaining');
    const advFig = figureOf(balances, 'employee_owed', 'advance_owed');
    const salaryOutFig = figureOf(balances, 'company_owed', 'salary_outstanding');

    // Late-minutes money (engine: salary_entitlement ALREADY has it removed;
    // the step-2 checkbox lets the operator FORGIVE it - the box then goes
    // UP by this amount - and step 3 warns when the forgiveness was taken).
    const lateDeduction = (entitlement && typeof entitlement.lateness_deduction_total === 'number' &&
      entitlement.lateness_deduction_total > 0)
      ? Math.round(entitlement.lateness_deduction_total * 100) / 100 : null;

    return res.render('hr/add-salary-step2', {
      employee: employee,
      period: period,
      periodLabel: period.slice(0, 7),
      paymentDate: paymentDate,
      salary: salary,
      entitlement: entitlement,
      oblStatus: obl ? obl.status : null,
      prefill: {
        salaryDue: salaryDue,
        salaryMax: salaryMax,
        ot: otFig.afn,
        advance: advFig.afn,
        salaryOutstanding: salaryOutFig.afn,
        otState: otFig.state,
        advState: advFig.state,
        salaryOutState: salaryOutFig.state
      },
      lateDeduction: lateDeduction
    });
  } catch (err) {
    console.error('[addSalary] step2 error:', err);
    return res.redirect('/admin/hr/payroll/add-salary');
  } finally {
    if (db) { try { db.close(); } catch (e) { /* already closed */ } }
  }
}

/* ------------------------------------------------------------------ *
 * STEP 3 — "Confirm" (GET summary, POST = create + finalize).
 *
 * The wizard never leaves a DRAFT behind: Accept calls the existing
 * frozen machinery (createDraft -> finalizeDraft) and, if finalize is
 * refused, removes the just-created draft again (deleteDraft).
 * If the period was never opened, the obligation is created here
 * (same rules as the period-open flow: BLOCKED attendance refuses).
 * ------------------------------------------------------------------ */

function openWritableDb() {
  const db = new DatabaseSync(resolveDbPath());
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

/* AFN string -> integer cents. null = absent, NaN = invalid. */
function parseWizAmount(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = Number(String(raw).trim());
  if (!isFinite(n) || n <= 0) return NaN;
  const cents = Math.round(n * 100);
  return cents > 0 ? cents : NaN;
}

/* Eligible overtime rows (engine rules: Approved, unlinked, >= cutover,
 * remaining > 0), oldest first. Mirrors buildEngineInput. */
function eligibleOvertimes(db, empId) {
  const rows = db.prepare(
    'SELECT id, overtime_date, status, payroll_id, total_amount FROM overtime WHERE employee_id = ?'
  ).all(empId);
  const out = [];
  for (const r of rows) {
    const used = db.prepare(
      `SELECT COALESCE(SUM(pc.amount), 0) AS s
       FROM payment_component pc JOIN payment p ON p.id = pc.payment_id
       WHERE pc.overtime_id = ? AND p.status IN ('DRAFT','FINALIZED')`
    ).get(r.id).s;
    const remaining = Math.round(Number(r.total_amount) * 100) - used;
    const ok = r.status === 'Approved' &&
      (r.payroll_id === null || r.payroll_id === undefined) &&
      String(r.overtime_date) >= CUTOVER && remaining > 0;
    if (ok) out.push({ id: r.id, date: String(r.overtime_date), capacity: remaining });
  }
  out.sort((a, b) => (a.date === b.date ? a.id - b.id : (a.date < b.date ? -1 : 1)));
  return out;
}

/* Eligible advance rows (engine rules: Active / Partially Repaid,
 * available > 0), oldest first. Mirrors buildEngineInput. */
function eligibleAdvances(db, empId) {
  const rows = db.prepare(
    'SELECT id, date, amount, status FROM salary_advances WHERE employee_id = ?'
  ).all(empId);
  const out = [];
  for (const r of rows) {
    const rep = db.prepare(
      `SELECT COALESCE(SUM(CAST(ROUND(amount * 100) AS INTEGER)), 0) AS s
       FROM salary_advance_repayments WHERE advance_id = ?`
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
    const available = Math.round(Number(r.amount) * 100) - rep - draft - fin;
    const ok = (r.status === 'Active' || r.status === 'Partially Repaid') && available > 0;
    if (ok) out.push({ id: r.id, date: String(r.date), capacity: available });
  }
  out.sort((a, b) => (a.date === b.date ? a.id - b.id : (a.date < b.date ? -1 : 1)));
  return out;
}

/* Build + validate the Step-3 state from query/body.
 * Returns null when the structural params are unusable (caller redirects
 * to Step 1); otherwise a full state object with any validation errors. */
function buildStep3State(db, src) {
  const empId = Number(src.employee_id);
  const period = normalizePeriodMonth(src.period_month);
  const paymentDate = normalizePaymentDate(src.payment_date);
  if (!Number.isInteger(empId) || empId <= 0 || !period || !paymentDate) return null;

  const employee = loadEmployeeInfo(db, empId);
  if (!employee) return null;

  const sel = {
    salary: String(src.pay_salary || '') === '1',
    ot: String(src.pay_ot || '') === '1',
    advance: String(src.pay_advance || '') === '1'
  };
  const errors = [];
  const amounts = { salary: null, ot: null, advance: null };

  if (!sel.salary && !sel.ot && !sel.advance) errors.push({ key: 'err_select_one' });
  if (sel.salary) amounts.salary = parseWizAmount(src.salary_amount);
  if (sel.ot) amounts.ot = parseWizAmount(src.ot_amount);
  if (sel.advance) amounts.advance = parseWizAmount(src.advance_amount);
  ['salary', 'ot', 'advance'].forEach(function (k) {
    if (sel[k] && (amounts[k] === null || Number.isNaN(amounts[k]))) {
      errors.push({ key: 'err_amount_invalid' });
    }
  });

  const salaryCents = sel.salary && Number.isFinite(amounts.salary) ? amounts.salary : 0;
  const otCents = sel.ot && Number.isFinite(amounts.ot) ? amounts.ot : 0;
  const advCents = sel.advance && Number.isFinite(amounts.advance) ? amounts.advance : 0;

  let entitlement = null;
  try { entitlement = calculateEntitlement(db, empId, period); } catch (e) { entitlement = null; }
  const obl = db.prepare(
    `SELECT id, status, salary_remaining, salary_earned, salary_paid
     FROM salary_obligation WHERE employee_id = ? AND earning_month = ?`
  ).get(empId, period) || null;

  const otRows = eligibleOvertimes(db, empId);
  const advRows = eligibleAdvances(db, empId);
  const otCap = otRows.reduce((s, r) => s + r.capacity, 0);
  const advCap = advRows.reduce((s, r) => s + r.capacity, 0);

  // Salary capacity: OWNER POLICY (manual authority + unrecorded-day rule)
  // - the cap is the FULL unpaid total (the obligation's remaining balance),
  // GROWN to the live recorded-days figure minus paid when more attendance
  // was recorded since the obligation opened (ensureObligation persists the
  // growth at accept). NOT the elapsed-days prefill, which only SUGGESTS
  // what is earned so far. Unrecorded days earn nothing - no paying ahead.
  // null when attendance is BLOCKED and no obligation exists yet (the
  // auto-open would refuse); 0 when nothing is unpaid ("already fully paid").
  let salaryCap = null;
  if (obl) {
    let liveFull = null;
    try { liveFull = calculateEntitlement(db, empId, period, { countFutureDays: true }); } catch (e) { liveFull = null; }
    const liveCents = (liveFull && liveFull.status !== 'BLOCKED' && typeof liveFull.salary_entitlement === 'number')
      ? Math.round(liveFull.salary_entitlement * 100) : null;
    const storedCap = obl.status === 'PAID' ? 0 : Math.max(0, obl.salary_remaining);
    salaryCap = liveCents !== null
      ? Math.max(storedCap, liveCents - obl.salary_paid)
      : storedCap;
  } else {
    let fullEnt = null;
    try { fullEnt = calculateEntitlement(db, empId, period, { countFutureDays: true }); } catch (e) { fullEnt = null; }
    if (fullEnt && fullEnt.status !== 'BLOCKED' && typeof fullEnt.salary_entitlement === 'number') {
      salaryCap = Math.round(fullEnt.salary_entitlement * 100);
    }
  }

  if (sel.salary && Number.isFinite(amounts.salary)) {
    if (salaryCap === null) {
      const blocked = entitlement && entitlement.status === 'BLOCKED';
      errors.push(blocked
        ? { key: 'err_attendance_blocked', codes: (entitlement.blockers || []).map(b => b.code) }
        : { key: 'err_no_obligation' });
    } else if (salaryCap <= 0) {
      errors.push({ key: 'err_salary_already_paid' });
    } else if (amounts.salary > salaryCap) {
      errors.push({ key: 'err_amount_over' });
    }
  }
  if (sel.ot && Number.isFinite(amounts.ot) && amounts.ot > otCap) {
    errors.push({ key: 'err_amount_over' });
  }
  if (sel.advance && Number.isFinite(amounts.advance)) {
    if (advCents > advCap) errors.push({ key: 'err_amount_over' });
    if (advCents > salaryCents + otCents) errors.push({ key: 'err_advance_exceeds' });
  }

  const existingPayment = db.prepare(
    `SELECT id, payment_serial, status FROM payment
     WHERE employee_id = ? AND period_month = ? AND status IN ('DRAFT','FINALIZED')
     ORDER BY id DESC LIMIT 1`
  ).get(empId, period) || null;

  return {
    employee: employee,
    period: period,
    paymentDate: paymentDate,
    sel: sel,
    amounts: amounts,
    errors: errors,
    salaryCap: salaryCap,
    otCap: otCap,
    advCap: advCap,
    entitlement: entitlement,
    obl: obl,
    otRows: otRows,
    advRows: advRows,
    existingPayment: existingPayment,
    // Step-2 "deduct late minutes" choice (1 = deduction stays applied -
    // the default; anything else = the operator forgave the late money).
    lateApplied: String(src.deduct_late || '') === '1',
    raw: {
      salary_amount: src.salary_amount === undefined ? '' : String(src.salary_amount),
      ot_amount: src.ot_amount === undefined ? '' : String(src.ot_amount),
      advance_amount: src.advance_amount === undefined ? '' : String(src.advance_amount)
    }
  };
}

/* Auto-open the period obligation (same business rules as the period-open
 * flow). BLOCKED attendance / zero entitlement refuse - never invented. */
function ensureObligation(db, empId, period, actorId) {
  const selSql =
    'SELECT id, status, salary_remaining, salary_earned, salary_paid FROM salary_obligation WHERE employee_id = ? AND earning_month = ?';
  const existing = db.prepare(selSql).get(empId, period);
  if (existing) {
    // GROW-ONLY refresh (unrecorded-day policy): once more attendance days
    // are recorded, the payable figure grows with them. salary_earned is
    // refreshed UPWARD only and never below what is already paid (same guard
    // as the correction flow) - a mid-month payment can no longer strand the
    // rest of the month on a stale figure. Triggers still cap paid at earned.
    let fresh = null;
    try { fresh = calculateEntitlement(db, empId, period, { countFutureDays: true }); } catch (e) { fresh = null; }
    if (fresh && fresh.status !== 'BLOCKED' && typeof fresh.salary_entitlement === 'number') {
      const freshCents = Math.round(Number(fresh.salary_entitlement) * 100);
      const again = db.prepare(selSql).get(empId, period);
      if (again && freshCents > again.salary_earned && freshCents >= again.salary_paid) {
        db.exec('BEGIN IMMEDIATE');
        try {
          const locked = db.prepare(selSql).get(empId, period);
          if (!locked || locked.salary_earned !== again.salary_earned) {
            db.exec('ROLLBACK');
          } else {
            db.prepare('UPDATE salary_obligation SET salary_earned = ?, salary_remaining = ?, status = ? WHERE id = ?')
              .run(freshCents, freshCents - locked.salary_paid, locked.salary_paid > 0 ? 'PARTIAL' : 'OPEN', locked.id);
            db.prepare(
              `INSERT INTO payment_audit
               (payment_id, action, entity, entity_id, field_name, old_value, new_value, reason, actor_id, created_at)
               VALUES (NULL, 'OBLIGATION_EARNED_UPDATED', 'obligation', ?, 'salary_earned', ?, ?, ?, ?, CURRENT_TIMESTAMP)`
            ).run(locked.id, String(locked.salary_earned), String(freshCents), 'grew with newly recorded attendance days', actorId);
            db.exec('COMMIT');
          }
        } catch (err) {
          try { db.exec('ROLLBACK'); } catch (e) { /* already rolled back */ }
          console.error('[addSalary] obligation grow error:', err);
        }
      }
    }
    return { ok: true, obligation: db.prepare(selSql).get(empId, period) };
  }

  let ent = null;
  // countFutureDays=true: the obligation records the recorded-days figure
  // (unrecorded-day policy) - trg_payment_finalize caps paid at
  // salary_earned. When more attendance days are recorded later, this
  // obligation's earned grows upward-only (block above), so the rest of the
  // month stays payable; unrecorded days earn nothing, so there is no
  // paying ahead of recorded attendance.
  try { ent = calculateEntitlement(db, empId, period, { countFutureDays: true }); } catch (e) { ent = null; }
  if (!ent) return { ok: false, error: { key: 'err_no_obligation' } };
  if (ent.status === 'BLOCKED') {
    return {
      ok: false,
      error: { key: 'err_attendance_blocked', codes: (ent.blockers || []).map(b => b.code) }
    };
  }
  const cents = Math.round(Number(ent.salary_entitlement) * 100);
  if (!isFinite(cents) || cents <= 0) return { ok: false, error: { key: 'err_no_obligation' } };

  db.exec('BEGIN IMMEDIATE');
  try {
    const again = db.prepare(selSql).get(empId, period);
    if (again) { db.exec('ROLLBACK'); return { ok: true, obligation: again }; }
    const note = 'add-salary wizard auto-open ' + period +
      (ent.status === 'REVIEW_REQUIRED' ? '; WARN: REVIEW_REQUIRED' : '');
    const rr = db.prepare(
      `INSERT INTO salary_obligation
       (employee_id, earning_month, salary_earned, salary_paid, status, created_by, created_at, source_note)
       VALUES (?, ?, ?, 0, 'OPEN', ?, CURRENT_TIMESTAMP, ?)`
    ).run(empId, period, cents, actorId, note);
    const oid = Number(rr.lastInsertRowid);
    db.prepare(
      `INSERT INTO payment_audit
       (payment_id, action, entity, entity_id, field_name, old_value, new_value, reason, actor_id, created_at)
       VALUES (NULL, 'OBLIGATION_CREATED', 'obligation', ?, NULL, NULL, ?, ?, ?, CURRENT_TIMESTAMP)`
    ).run(oid, String(cents), note, actorId);
    db.exec('COMMIT');
    return { ok: true, obligation: db.prepare(selSql).get(empId, period) };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (e) { /* already rolled back */ }
    console.error('[addSalary] obligation auto-open error:', err);
    return { ok: false, error: { key: 'err_no_obligation' } };
  }
}

/* Spread an amount over eligible rows (oldest first) as MANUAL selections. */
function spreadSelections(type, amountCents, rows) {
  let left = amountCents;
  const sels = [];
  for (const r of rows) {
    if (left <= 0) break;
    const take = Math.min(left, r.capacity);
    if (take <= 0) continue;
    sels.push({ source_type: type, source_id: r.id, amount_cents: take });
    left -= take;
  }
  return left > 0 ? null : sels;
}

function resolveErrors(t, errs) {
  return (errs || []).map(function (e) {
    let txt = t('hr.addSalary.' + e.key);
    if (e.codes && e.codes.length) txt += ': ' + e.codes.join(', ');
    if (e.detail) txt += ' (' + e.detail + ')';
    return txt;
  });
}

const REFUSAL_KEYS = {
  EMPLOYEE_NOT_FOUND: 'err_employee_required',
  INVALID_PERIOD: 'err_period_invalid',
  INVALID_PAYMENT_DATE: 'err_period_invalid',
  OBLIGATION_NOT_FOUND: 'err_no_obligation',
  OBLIGATION_FULLY_PAID: 'err_salary_already_paid',
  SALARY_OVER_OBLIGATION: 'err_amount_over',
  OVER_ALLOCATION: 'err_amount_over',
  INVALID_MANUAL_SELECTION: 'err_save_failed',
  ADVANCE_NOT_ELIGIBLE: 'err_amount_over',
  OT_NOT_ELIGIBLE: 'err_amount_over',
  DUPLICATE_SUBMIT: 'err_duplicate_payment',
  DUPLICATE_PAYMENT_NOT_CONFIRMED: 'err_duplicate_payment'
};

function refusalErrors(refusal, blockers) {
  const errs = [{ key: REFUSAL_KEYS[refusal] || 'err_save_failed', detail: refusal }];
  if (blockers && blockers.length) errs.push({ key: 'err_refused', codes: blockers });
  return errs;
}

function step3ViewData(res, st, errors, saved) {
  const salaryCents = st.sel.salary && Number.isFinite(st.amounts.salary) ? st.amounts.salary : 0;
  const otCents = st.sel.ot && Number.isFinite(st.amounts.ot) ? st.amounts.ot : 0;
  const advCents = st.sel.advance && Number.isFinite(st.amounts.advance) ? st.amounts.advance : 0;
  const lateCents = (st.entitlement && typeof st.entitlement.lateness_deduction_total === 'number')
    ? Math.round(st.entitlement.lateness_deduction_total * 100) : 0;
  return {
    employee: st.employee,
    period: st.period,
    periodLabel: st.period.slice(0, 7),
    paymentDate: st.paymentDate,
    sel: st.sel,
    salaryCents: st.sel.salary ? salaryCents : null,
    otCents: st.sel.ot ? otCents : null,
    advCents: st.sel.advance ? advCents : null,
    netCents: salaryCents + otCents - advCents,
    salaryCapCents: st.salaryCap,
    remainingAfterCents: (st.sel.salary && st.salaryCap !== null) ? (st.salaryCap - salaryCents) : null,
    entitlement: st.entitlement,
    oblStatus: st.obl ? st.obl.status : null,
    existingPayment: st.existingPayment,
    lateApplied: st.lateApplied,
    // Pre-accept only: warn when the salary is being paid WITHOUT the
    // late-minutes deduction (the operator unticked the step-2 checkbox).
    lateWarnCents: (!saved && st.sel.salary && !st.lateApplied && lateCents > 0) ? lateCents : null,
    errors: resolveErrors(res.locals.t, errors),
    saved: saved || null,
    raw: st.raw,
    backUrl: '/admin/hr/payroll/add-salary/step2?employee_id=' + st.employee.id +
      '&period_month=' + encodeURIComponent(st.period.slice(0, 7)) +
      '&payment_date=' + encodeURIComponent(st.paymentDate)
  };
}

/* STEP 3 GET — printable confirmation summary (read-only). */
function addSalaryStep3(req, res) {
  let db;
  try {
    db = openReadOnlyDb();
    const st = buildStep3State(db, req.query);
    if (!st) {
      req.session.message = { type: 'error', text: res.locals.t('hr.addSalary.err_period_invalid') };
      return res.redirect('/admin/hr/payroll/add-salary');
    }
    return res.render('hr/add-salary-step3', step3ViewData(res, st, st.errors, null));
  } catch (err) {
    console.error('[addSalary] step3 error:', err);
    req.session.message = { type: 'error', text: res.locals.t('hr.addSalary.err_save_failed') };
    return res.redirect('/admin/hr/payroll/add-salary');
  } finally {
    if (db) { try { db.close(); } catch (e) { /* already closed */ } }
  }
}

/* STEP 3 POST (Accept) — create + finalize in one user action.
 * A draft that fails to finalize is deleted again: never left behind. */
function addSalaryStep3Accept(req, res) {
  let db;
  try {
    const actorId = Number(req.session && req.session.user_id);
    if (!Number.isInteger(actorId) || actorId <= 0) {
      req.session.message = { type: 'error', text: res.locals.t('hr.addSalary.err_save_failed') };
      return res.redirect('/admin/hr/payroll/add-salary');
    }

    db = openWritableDb();
    const st = buildStep3State(db, req.body);
    if (!st) {
      req.session.message = { type: 'error', text: res.locals.t('hr.addSalary.err_period_invalid') };
      return res.redirect('/admin/hr/payroll/add-salary');
    }
    if (st.errors.length) {
      return res.render('hr/add-salary-step3', step3ViewData(res, st, st.errors, null));
    }

    // Behind the scenes: open the period if it was never opened.
    const eff = ensureObligation(db, st.employee.id, st.period, actorId);
    if (!eff.ok) {
      return res.render('hr/add-salary-step3', step3ViewData(res, st, [eff.error], null));
    }

    const selections = [];
    if (st.sel.salary) {
      selections.push({ source_type: 'SALARY', source_id: eff.obligation.id, amount_cents: st.amounts.salary });
    }
    if (st.sel.ot) {
      const otSels = spreadSelections('OVERTIME', st.amounts.ot, st.otRows);
      if (!otSels) {
        return res.render('hr/add-salary-step3', step3ViewData(res, st, [{ key: 'err_amount_over' }], null));
      }
      selections.push.apply(selections, otSels);
    }
    if (st.sel.advance) {
      const advSels = spreadSelections('ADVANCE', st.amounts.advance, st.advRows);
      if (!advSels) {
        return res.render('hr/add-salary-step3', step3ViewData(res, st, [{ key: 'err_amount_over' }], null));
      }
      selections.push.apply(selections, advSels);
    }

    const result = paymentInternals.createDraft(db, {
      employee_id: st.employee.id,
      period_month: st.period,
      payment_date: st.paymentDate,
      mode: 'MANUAL',
      manual_selections: selections,
      includes: { salary: true, overtime: true, advance: true },
      idempotency_key: crypto.randomUUID(),
      duplicate_confirmed: !!st.existingPayment,
      payment_method: 'CASH',
      payment_reference: null,
      notes: null,
      actor_id: actorId
    });
    if (!result.ok) {
      console.warn('[addSalary] create refused:', result.refusal, result.blockers);
      return res.render('hr/add-salary-step3',
        step3ViewData(res, st, refusalErrors(result.refusal, result.blockers), null));
    }

    const fin = paymentInternals.finalizeDraft(db, {
      payment_id: result.payment_id,
      overpayment_cents: 0,
      zero_reason_code: '',
      zero_reason_note: '',
      actor_id: actorId,
      actor_name: String(req.session.username || 'admin')
    });
    if (!fin.ok) {
      console.warn('[addSalary] finalize refused:', fin.refusal, fin.blockers, '- removing draft');
      paymentInternals.deleteDraft(db, { payment_id: result.payment_id, actor_id: actorId });
      return res.render('hr/add-salary-step3',
        step3ViewData(res, st, refusalErrors(fin.refusal, fin.blockers), null));
    }

    const pay = db.prepare(
      `SELECT id, payment_serial, status, earnings_total, advance_deduction_total,
              net_cash_paid, salary_remaining_after, finalized_at
       FROM payment WHERE id = ?`
    ).get(result.payment_id);

    try {
      paymentInternals.notify(db, 'hr_payment_finalized',
        res.locals.t('hr.payments.ok_finalized') + ' ' + fin.serial,
        result.payment_id, 'payment', String(req.session.username || 'admin'));
    } catch (e) {
      console.error('[addSalary] notification error (payment committed):', e && e.message);
    }

    console.log('[addSalary] saved FINAL payment #' + pay.id + ' ' + pay.payment_serial +
      ' employee=' + st.employee.id + ' period=' + st.period +
      ' net=' + pay.net_cash_paid + 'c');

    return res.render('hr/add-salary-step3', step3ViewData(res, st, [], {
      serial: pay.payment_serial,
      paymentId: pay.id,
      earningsCents: pay.earnings_total,
      advCents: pay.advance_deduction_total,
      netCents: pay.net_cash_paid,
      salaryRemainingAfterCents: pay.salary_remaining_after,
      finalizedAt: pay.finalized_at
    }));
  } catch (err) {
    console.error('[addSalary] step3 accept error:', err);
    req.session.message = { type: 'error', text: res.locals.t('hr.addSalary.err_save_failed') };
    return res.redirect('/admin/hr/payroll/add-salary');
  } finally {
    if (db) { try { db.close(); } catch (e) { /* already closed */ } }
  }
}

module.exports = {
  addSalaryShell: addSalaryShell,
  addSalaryStep2: addSalaryStep2,
  addSalaryStep3: addSalaryStep3,
  addSalaryStep3Accept: addSalaryStep3Accept
};
