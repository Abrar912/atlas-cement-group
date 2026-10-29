'use strict';
/**
 * HR-11 Gate G3 - Read-only employee balance service.
 *
 * Implements the owner-approved HR-11 Final Design Record:
 *  - Figure contract: { code, state, value_cents, reason_code, sources[], checks[] }
 *  - States: VERIFIED_AMOUNT | VALID_ZERO | UNAVAILABLE | BLOCKED | DIVERGENT
 *  - Company-owed figures (salary outstanding, eligible OT remaining) are never
 *    netted against employee-owed figures (advance owed, advance allocatable);
 *    the two groups are returned under separate keys and no combined total.
 *  - Advance invariants (per advance):
 *      O = round(amount*100)
 *      R = sum of round(repayment.amount*100)
 *      D = sum of payment_component.amount where payment.status = 'DRAFT'
 *      F = sum of payment_component.amount where payment.status = 'FINALIZED'
 *      CORRECTED payments are excluded from F (corrected amounts restore capacity)
 *      B (stored remaining) must equal O - R - F           [invariant 1]
 *      A (allocatable)      = O - R - D - F = B - D        [invariant 2, never B - D - F]
 *  - Divergence from an invariant -> state DIVERGENT, value_cents = null,
 *    detail kept in checks[] (flag only; never repaired, never inferred).
 *  - Missing/broken source -> state UNAVAILABLE, value_cents = null
 *    (never silently converted to zero).
 *  - VALID_ZERO is returned only for row-substantiated zeros: source rows
 *    (or, where the figure has an eligibility rule, eligible rows) exist and
 *    the count, sum, and non-negativity cross-checks independently confirm a
 *    zero sum (reason ROWS_SUM_ZERO). Zero rows (NO_SOURCE_ROWS) and no
 *    eligible rows (NO_ELIGIBLE_ROWS) are explicitly non-verified: state
 *    UNAVAILABLE, reason_code preserved, value_cents = null
 *    (owner decisions D-1 and D-2; zero rows never yield VALID_ZERO).
 *  - SELECT-only: every statement is built through select()/selectOne(),
 *    which refuse any statement that is not a SELECT.
 *
 * No requires, no I/O, no clock: given the same database state the output is
 * deterministic. This module never opens a database itself; the caller passes
 * an already-open connection.
 */

const CUTOVER_DEFAULT = '1405/07/01';
const OT_APPROVED = 'Approved';
const ADV_ELG = ['Active', 'Partially Repaid'];
const OT_JOB = 'Pending';

const STATES = Object.freeze({
  VERIFIED_AMOUNT: 'VERIFIED_AMOUNT',
  VALID_ZERO: 'VALID_ZERO',
  UNAVAILABLE: 'UNAVAILABLE',
  BLOCKED: 'BLOCKED',
  DIVERGENT: 'DIVERGENT'
});

const FIGURE_CODES = Object.freeze([
  'salary_outstanding',
  'ot_eligible_remaining',
  'advance_owed',
  'advance_allocatable'
]);

/* ---------------------------------------------------------------- *
 * Low-level guarded read helpers                                    *
 * ---------------------------------------------------------------- */
function normDate(v) {
  return String(v === null || v === undefined ? '' : v).replace(/\s+/g, '');
}

function toCents(realAmount) {
  return Math.round(Number(realAmount) * 100);
}

function isInt(v) {
  return typeof v === 'number' && Number.isSafeInteger(v);
}

function assertSelect(sql) {
  if (typeof sql !== 'string' || !/^\s*SELECT/i.test(sql)) {
    throw new Error('NON_SELECT_STATEMENT_BLOCKED');
  }
}

function select(db, sql, params) {
  assertSelect(sql);
  const stmt = db.prepare(sql);
  return params === undefined ? stmt.all() : stmt.all.apply(stmt, params);
}

function selectOne(db, sql, params) {
  assertSelect(sql);
  const stmt = db.prepare(sql);
  const row = params === undefined ? stmt.get() : stmt.get.apply(stmt, params);
  return row === undefined ? null : row;
}

function classifyError(e) {
  const msg = e && e.message ? String(e.message) : String(e);
  if (/no such table/i.test(msg)) return 'SOURCE_TABLE_MISSING';
  if (/no such column/i.test(msg)) return 'SOURCE_QUERY_FAILED';
  if (/NON_SELECT_STATEMENT_BLOCKED/.test(msg)) return 'SOURCE_QUERY_FAILED';
  return 'SOURCE_QUERY_FAILED';
}

/* ---------------------------------------------------------------- *
 * Figure builder                                                    *
 * ---------------------------------------------------------------- */
function figure(code, state, valueCents, reasonCode, sources, checks) {
  if (FIGURE_CODES.indexOf(code) === -1) throw new Error('UNKNOWN_FIGURE_CODE');
  if (!Object.prototype.hasOwnProperty.call(STATES, state)) throw new Error('UNKNOWN_STATE');
  if (state === STATES.VERIFIED_AMOUNT || state === STATES.VALID_ZERO) {
    if (!isInt(valueCents) || valueCents < 0) throw new Error('BAD_VALUE_FOR_' + state);
  } else if (valueCents !== null) {
    throw new Error('BAD_VALUE_FOR_' + state);
  }
  return {
    code: code,
    state: state,
    value_cents: valueCents,
    reason_code: reasonCode === undefined ? null : reasonCode,
    sources: sources || [],
    checks: checks || []
  };
}

function chk(name, ok, detail) {
  return { name: name, ok: ok === true, detail: detail === undefined ? null : detail };
}

function unavailable(code, reason, sourceLabel, e) {
  return figure(code, STATES.UNAVAILABLE, null, reason, [sourceLabel],
    [chk('source_query', false, e && e.message ? String(e.message) : String(e))]);
}

function blockedAll(reason) {
  const out = {};
  for (let i = 0; i < FIGURE_CODES.length; i++) {
    out[FIGURE_CODES[i]] = figure(FIGURE_CODES[i], STATES.BLOCKED, null, reason, [], []);
  }
  return out;
}

function wrapFigure(code, sourceLabel, worker) {
  try {
    return worker();
  } catch (e) {
    return unavailable(code, classifyError(e), sourceLabel, e);
  }
}

/* ---------------------------------------------------------------- *
 * 1. salary_outstanding (company-owed)                              *
 * ---------------------------------------------------------------- */
function salaryFigure(db, employeeId) {
  const SRC = "salary_obligation WHERE employee_id = ? AND status IN ('OPEN','PARTIAL')";
  return wrapFigure('salary_outstanding', SRC, function () {
    const rows = select(db,
      "SELECT id, earning_month, salary_remaining, status FROM salary_obligation " +
      "WHERE employee_id = ? AND status IN ('OPEN','PARTIAL')", [employeeId]);
    const agg = selectOne(db,
      "SELECT COUNT(*) AS c, COALESCE(SUM(salary_remaining), 0) AS s FROM salary_obligation " +
      "WHERE employee_id = ? AND status IN ('OPEN','PARTIAL')", [employeeId]) ||
      { c: 0, s: 0 };

    let js = 0;
    let negative = null;
    for (let i = 0; i < rows.length; i++) {
      const v = Number(rows[i].salary_remaining);
      if (!isInt(v)) { negative = { id: rows[i].id, value: rows[i].salary_remaining }; break; }
      if (v < 0) { negative = { id: rows[i].id, value: v }; break; }
      js += v;
    }
    const sql = Number(agg.s);

    const checks = [
      chk('source_table_present', true, 'salary_obligation'),
      chk('row_count_cross_check', Number(agg.c) === rows.length,
        'count=' + agg.c + ' fetched=' + rows.length),
      chk('sum_cross_check', negative === null && sql === js,
        'sql=' + sql + ' js=' + js),
      chk('non_negative_rows', negative === null,
        negative === null ? 'ok' : JSON.stringify(negative))
    ];
    const failed = [];
    for (let i = 0; i < checks.length; i++) if (!checks[i].ok) failed.push(checks[i].name);

    if (failed.length > 0) {
      const reason = negative !== null ? 'NEGATIVE_SALARY_REMAINING' : 'SUM_COUNT_MISMATCH';
      return figure('salary_outstanding', STATES.DIVERGENT, null, reason, [SRC], checks);
    }
    if (js > 0) return figure('salary_outstanding', STATES.VERIFIED_AMOUNT, js, null, [SRC], checks);
    if (rows.length === 0) {
      return figure('salary_outstanding', STATES.UNAVAILABLE, null, 'NO_SOURCE_ROWS', [SRC], checks);
    }
    return figure('salary_outstanding', STATES.VALID_ZERO, 0, 'ROWS_SUM_ZERO', [SRC], checks);
  });
}

/* ---------------------------------------------------------------- *
 * 2. ot_eligible_remaining (company-owed)                           *
 *    Eligible: status = 'Approved' AND payroll_id IS NULL            *
 *              AND normalized overtime_date >= cutover (R5-B).       *
 * ---------------------------------------------------------------- */
function otFigure(db, employeeId, cutover) {
  const SRC = "overtime WHERE employee_id = ? ; payment_component JOIN payment ('DRAFT','FINALIZED') per overtime_id";
  return wrapFigure('ot_eligible_remaining', SRC, function () {
    const rows = select(db,
      'SELECT id, overtime_date, status, payroll_id, total_amount FROM overtime WHERE employee_id = ?',
      [employeeId]);
    const cnt = selectOne(db, 'SELECT COUNT(*) AS c FROM overtime WHERE employee_id = ?', [employeeId]) ||
      { c: rows.length };

    const per = [];
    const excluded = [];
    let js = 0;
    let eligibleCount = 0;
    let negative = null;
    let correctedTotal = 0;

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const usedRow = selectOne(db,
        "SELECT COALESCE(SUM(pc.amount), 0) AS s FROM payment_component pc " +
        "JOIN payment p ON p.id = pc.payment_id " +
        "WHERE pc.overtime_id = ? AND p.status IN ('DRAFT','FINALIZED')", [r.id]) || { s: 0 };
      const corrRow = selectOne(db,
        "SELECT COALESCE(SUM(pc.amount), 0) AS s FROM payment_component pc " +
        "JOIN payment p ON p.id = pc.payment_id " +
        "WHERE pc.overtime_id = ? AND p.status = 'CORRECTED'", [r.id]) || { s: 0 };
      const totalC = toCents(r.total_amount);
      const remaining = totalC - Number(usedRow.s);
      correctedTotal += Number(corrRow.s);

      if (!isInt(remaining)) {
        negative = { id: r.id, value: r.total_amount, used: usedRow.s };
        break;
      }
      if (remaining < 0) { negative = { id: r.id, remaining: remaining }; break; }

      const d = normDate(r.overtime_date);
      const statusOk = r.status === OT_APPROVED;
      const linkOk = r.payroll_id === null || r.payroll_id === undefined;
      const dateOk = d.length > 0 && d >= cutover;
      const eligible = statusOk && linkOk && dateOk;
      per.push({ id: r.id, remaining: remaining, eligible: eligible });
      if (!eligible) {
        excluded.push({
          id: r.id,
          reason: !statusOk ? 'NOT_APPROVED' : (!linkOk ? 'LINKED_TO_PAYROLL' : 'PRE_CUTOVER')
        });
      } else {
        js += remaining;
        eligibleCount++;
      }
    }

    let sql = null;
    if (negative === null) {
      const agg = selectOne(db,
        "SELECT COALESCE(SUM(x), 0) AS s FROM (" +
        "  SELECT (CAST(ROUND(o.total_amount * 100) AS INTEGER)" +
        "    - COALESCE((SELECT SUM(pc.amount) FROM payment_component pc" +
        "      JOIN payment p ON p.id = pc.payment_id" +
        "      WHERE pc.overtime_id = o.id AND p.status IN ('DRAFT','FINALIZED')), 0)) AS x" +
        "  FROM overtime o" +
        "  WHERE o.employee_id = ? AND o.status = 'Approved' AND o.payroll_id IS NULL" +
        "    AND replace(o.overtime_date, ' ', '') >= ?)", [employeeId, cutover]);
      sql = Number(agg ? agg.s : 0);
    }

    const checks = [
      chk('source_table_present', true, 'overtime'),
      chk('row_count_cross_check', Number(cnt.c) === rows.length,
        'count=' + cnt.c + ' fetched=' + rows.length),
      chk('eligibility_partition', negative === null &&
        (function () {
          let eligibleCount = 0;
          for (let i = 0; i < per.length; i++) if (per[i].eligible) eligibleCount++;
          return eligibleCount + excluded.length === rows.length;
        })(),
        'eligible+excluded must equal total rows'),
      chk('sum_cross_check', negative === null && sql === js,
        'sql=' + sql + ' js=' + js),
      chk('corrected_payment_exclusion', negative === null && (correctedTotal === 0 || sql === js),
        'corrected_excluded_cents=' + correctedTotal),
      chk('non_negative_remaining', negative === null,
        negative === null ? 'ok' : JSON.stringify(negative))
    ];
    const failed = [];
    for (let i = 0; i < checks.length; i++) if (!checks[i].ok) failed.push(checks[i].name);

    if (failed.length > 0) {
      const reason = negative !== null ? 'NEGATIVE_OT_REMAINING' : 'SUM_COUNT_MISMATCH';
      return figure('ot_eligible_remaining', STATES.DIVERGENT, null, reason, [SRC],
        checks.concat([chk('excluded_rows', true, JSON.stringify(excluded))]));
    }
    const base = checks.concat([chk('excluded_rows', true, JSON.stringify(excluded))]);
    if (js > 0) return figure('ot_eligible_remaining', STATES.VERIFIED_AMOUNT, js, null, [SRC], base);
    if (rows.length === 0) {
      return figure('ot_eligible_remaining', STATES.UNAVAILABLE, null, 'NO_SOURCE_ROWS', [SRC], base);
    }
    if (eligibleCount === 0) {
      return figure('ot_eligible_remaining', STATES.UNAVAILABLE, null, 'NO_ELIGIBLE_ROWS', [SRC], base);
    }
    return figure('ot_eligible_remaining', STATES.VALID_ZERO, 0, 'ROWS_SUM_ZERO', [SRC], base);
  });
}

/* ---------------------------------------------------------------- *
 * 3+4. advance_owed and advance_allocatable (employee-owed)         *
 * ---------------------------------------------------------------- */
function advanceFigures(db, employeeId) {
  const SRC = "salary_advances WHERE employee_id = ? ; salary_advance_repayments per advance_id ; payment_component JOIN payment ('DRAFT','FINALIZED','CORRECTED') per advance_id";
  const out = {};
  try {
    const rows = select(db,
      'SELECT id, date, amount, status, remaining_balance FROM salary_advances WHERE employee_id = ?',
      [employeeId]);
    const cnt = selectOne(db,
      'SELECT COUNT(*) AS c FROM salary_advances WHERE employee_id = ?', [employeeId]) ||
      { c: rows.length };

    const per = [];
    let storedMismatch = null;
    let negativeB = null;
    let negativeA = null;
    let correctedTotal = 0;

    for (let i = 0; i < rows.length; i++) {
      const a = rows[i];
      const repRow = selectOne(db,
        'SELECT COALESCE(SUM(CAST(ROUND(r.amount * 100) AS INTEGER)), 0) AS s ' +
        'FROM salary_advance_repayments r WHERE r.advance_id = ?', [a.id]) || { s: 0 };
      const dRow = selectOne(db,
        "SELECT COALESCE(SUM(pc.amount), 0) AS s FROM payment_component pc " +
        "JOIN payment p ON p.id = pc.payment_id " +
        "WHERE pc.advance_id = ? AND p.status = 'DRAFT'", [a.id]) || { s: 0 };
      const fRow = selectOne(db,
        "SELECT COALESCE(SUM(pc.amount), 0) AS s FROM payment_component pc " +
        "JOIN payment p ON p.id = pc.payment_id " +
        "WHERE pc.advance_id = ? AND p.status = 'FINALIZED'", [a.id]) || { s: 0 };
      const cRow = selectOne(db,
        "SELECT COALESCE(SUM(pc.amount), 0) AS s FROM payment_component pc " +
        "JOIN payment p ON p.id = pc.payment_id " +
        "WHERE pc.advance_id = ? AND p.status = 'CORRECTED'", [a.id]) || { s: 0 };
      correctedTotal += Number(cRow.s);

      const O = toCents(a.amount);
      const R = Number(repRow.s);
      const D = Number(dRow.s);
      const F = Number(fRow.s);
      const B = O - R - F;               // invariant 1 (computed)
      const A = O - R - D - F;           // invariant 2 = B - D (never B - D - F)
      const stored = toCents(a.remaining_balance);
      const statusOk = ADV_ELG.indexOf(a.status) !== -1;

      if (!isInt(B) || !isInt(A) || !isInt(stored)) {
        storedMismatch = { id: a.id, reason: 'NON_INTEGER_ARITHMETIC' };
        break;
      }
      if (stored !== B && storedMismatch === null) {
        storedMismatch = { id: a.id, stored: stored, computed: B };
      }
      if (B < 0 && negativeB === null) negativeB = { id: a.id, B: B };
      if (A < 0 && negativeA === null) negativeA = { id: a.id, A: A };

      per.push({
        id: a.id, O: O, R: R, D: D, F: F, B: B, A: A, stored: stored,
        status: a.status, eligible: statusOk,
        eligibility_reason: statusOk ? null : (a.status === 'Disputed' ? 'ADVANCE_DISPUTED' : 'ADVANCE_NOT_ELIGIBLE')
      });
    }

    let sqlOwed = null;
    let sqlAlloc = null;
    if (storedMismatch === null && negativeB === null && negativeA === null) {
      const aggOwed = selectOne(db,
        "SELECT COALESCE(SUM(o - r - f), 0) AS s FROM (" +
        "  SELECT CAST(ROUND(a.amount * 100) AS INTEGER) AS o," +
        "    COALESCE((SELECT SUM(CAST(ROUND(r.amount * 100) AS INTEGER))" +
        "      FROM salary_advance_repayments r WHERE r.advance_id = a.id), 0) AS r," +
        "    COALESCE((SELECT SUM(pc.amount) FROM payment_component pc" +
        "      JOIN payment p ON p.id = pc.payment_id" +
        "      WHERE pc.advance_id = a.id AND p.status = 'FINALIZED'), 0) AS f" +
        "  FROM salary_advances a WHERE a.employee_id = ?)", [employeeId]);
      const aggAlloc = selectOne(db,
        "SELECT COALESCE(SUM(o - r - d - f), 0) AS s FROM (" +
        "  SELECT CAST(ROUND(a.amount * 100) AS INTEGER) AS o," +
        "    COALESCE((SELECT SUM(CAST(ROUND(r.amount * 100) AS INTEGER))" +
        "      FROM salary_advance_repayments r WHERE r.advance_id = a.id), 0) AS r," +
        "    COALESCE((SELECT SUM(pc.amount) FROM payment_component pc" +
        "      JOIN payment p ON p.id = pc.payment_id" +
        "      WHERE pc.advance_id = a.id AND p.status = 'DRAFT'), 0) AS d," +
        "    COALESCE((SELECT SUM(pc.amount) FROM payment_component pc" +
        "      JOIN payment p ON p.id = pc.payment_id" +
        "      WHERE pc.advance_id = a.id AND p.status = 'FINALIZED'), 0) AS f" +
        "  FROM salary_advances a WHERE a.employee_id = ? AND a.status IN ('Active','Partially Repaid'))",
        [employeeId]);
      sqlOwed = Number(aggOwed ? aggOwed.s : 0);
      sqlAlloc = Number(aggAlloc ? aggAlloc.s : 0);
    }

    let jsOwed = 0;
    let jsAlloc = 0;
    let eligibleCount = 0;
    const eligibilityList = [];
    for (let i = 0; i < per.length; i++) {
      jsOwed += per[i].B;
      if (per[i].eligible) { jsAlloc += per[i].A; eligibleCount++; }
      eligibilityList.push({ id: per[i].id, eligible: per[i].eligible, reason: per[i].eligibility_reason });
    }

    const shared = [
      chk('source_table_present', true, 'salary_advances'),
      chk('row_count_cross_check', Number(cnt.c) === rows.length,
        'count=' + cnt.c + ' fetched=' + rows.length),
      chk('stored_matches_computed', storedMismatch === null,
        storedMismatch === null ? 'ok' : JSON.stringify(storedMismatch)),
      chk('invariant_a_eq_b_minus_d', per.every(function (p) { return p.A === p.B - p.D; }),
        'per-advance A === B - D'),
      chk('corrected_payment_exclusion', (function () {
        if (correctedTotal === 0) return true;
        return sqlOwed === jsOwed && sqlAlloc === jsAlloc;
      })(), 'corrected_excluded_cents=' + correctedTotal),
      chk('eligibility_partition', per.length === rows.length,
        'analysed=' + per.length + ' rows=' + rows.length)
    ];

    /* --- advance_owed --- */
    const owedChecks = shared.concat([
      chk('sum_cross_check', sqlOwed === jsOwed, 'sql=' + sqlOwed + ' js=' + jsOwed),
      chk('non_negative_balance', negativeB === null,
        negativeB === null ? 'ok' : JSON.stringify(negativeB))
    ]);
    out.advance_owed = pickAdvanceFigure('advance_owed', SRC, owedChecks,
      storedMismatch, negativeB, jsOwed, rows.length, eligibleCount, false);

    /* --- advance_allocatable --- */
    const allocChecks = shared.concat([
      chk('sum_cross_check', sqlAlloc === jsAlloc, 'sql=' + sqlAlloc + ' js=' + jsAlloc),
      chk('non_negative_allocatable', negativeA === null,
        negativeA === null ? 'ok' : JSON.stringify(negativeA)),
      chk('eligibility_rows', true, JSON.stringify(eligibilityList))
    ]);
    out.advance_allocatable = pickAdvanceFigure('advance_allocatable', SRC, allocChecks,
      storedMismatch, negativeA, jsAlloc, rows.length, eligibleCount, true);
    return out;
  } catch (e) {
    out.advance_owed = unavailable('advance_owed', classifyError(e), SRC, e);
    out.advance_allocatable = unavailable('advance_allocatable', classifyError(e), SRC, e);
    return out;
  }
}

function pickAdvanceFigure(code, src, checks, storedMismatch, negative, js, rowCount, eligibleCount, requireEligible) {
  const failed = [];
  for (let i = 0; i < checks.length; i++) if (!checks[i].ok) failed.push(checks[i].name);
  if (failed.length > 0) {
    let reason = 'SUM_COUNT_MISMATCH';
    if (storedMismatch !== null) reason = 'STORED_REMAINDER_DIVERGENT';
    else if (negative !== null) reason = code === 'advance_owed' ? 'NEGATIVE_ADVANCE_BALANCE' : 'NEGATIVE_ADVANCE_AVAILABLE';
    return figure(code, STATES.DIVERGENT, null, reason, [src], checks);
  }
  if (js > 0) return figure(code, STATES.VERIFIED_AMOUNT, js, null, [src], checks);
  if (rowCount === 0) {
    return figure(code, STATES.UNAVAILABLE, null, 'NO_SOURCE_ROWS', [src], checks);
  }
  if (requireEligible && eligibleCount === 0) {
    return figure(code, STATES.UNAVAILABLE, null, 'NO_ELIGIBLE_ROWS', [src], checks);
  }
  return figure(code, STATES.VALID_ZERO, 0, 'ROWS_SUM_ZERO', [src], checks);
}

/* ---------------------------------------------------------------- *
 * Public entry point                                                *
 * ---------------------------------------------------------------- */
function computeEmployeeBalances(db, employeeId, opts) {
  const o = opts || {};
  const cutover = typeof o.cutover === 'string' && o.cutover.length > 0 ? o.cutover : CUTOVER_DEFAULT;

  const meta = {
    employee_id: employeeId,
    cutover: cutover,
    contract: 'HR-11-FINAL',
    source_mode: 'read-only',
    netting_applied: false
  };

  let emp = null;
  try {
    emp = selectOne(db, 'SELECT id, employment_status FROM hr_employees WHERE id = ?', [employeeId]);
  } catch (e) {
    const reason = classifyError(e);
    const figures = {};
    for (let i = 0; i < FIGURE_CODES.length; i++) {
      figures[FIGURE_CODES[i]] = unavailable(FIGURE_CODES[i], reason, 'hr_employees', e);
    }
    return Object.assign(meta, {
      employment_status: null,
      company_owed: { salary_outstanding: figures.salary_outstanding, ot_eligible_remaining: figures.ot_eligible_remaining },
      employee_owed: { advance_owed: figures.advance_owed, advance_allocatable: figures.advance_allocatable }
    });
  }
  if (emp === null) {
    const blocked = blockedAll('EMPLOYEE_NOT_FOUND');
    return Object.assign(meta, {
      employment_status: null,
      company_owed: { salary_outstanding: blocked.salary_outstanding, ot_eligible_remaining: blocked.ot_eligible_remaining },
      employee_owed: { advance_owed: blocked.advance_owed, advance_allocatable: blocked.advance_allocatable }
    });
  }

  const salary = salaryFigure(db, employeeId);
  const ot = otFigure(db, employeeId, cutover);
  const adv = advanceFigures(db, employeeId);

  return Object.assign(meta, {
    employment_status: emp.employment_status,
    company_owed: { salary_outstanding: salary, ot_eligible_remaining: ot },
    employee_owed: { advance_owed: adv.advance_owed, advance_allocatable: adv.advance_allocatable }
  });
}

module.exports = {
  computeEmployeeBalances: computeEmployeeBalances,
  STATES: STATES,
  FIGURE_CODES: FIGURE_CODES,
  CUTOVER_DEFAULT: CUTOVER_DEFAULT,
  ADV_ELG: Object.freeze(ADV_ELG.slice()),
  OT_JOB: OT_JOB
};
