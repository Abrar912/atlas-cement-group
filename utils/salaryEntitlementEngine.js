'use strict';
/**
 * PHASE 19 - Working-Day Salary Entitlement & Attendance Review Engine
 * NEW calculation path. Coexists beside the legacy calculateEmployeePayroll.
 *
 * READ-ONLY: performs SELECT queries only. Writes nothing to the database.
 * Supersedes (in this engine only, never in frozen code): calendar /30 divisors,
 * hour-based lateness (L1738), hard-coded 10-minute threshold grace,
 * silent missing attendance, allowance-inclusive rate basis.
 *
 * Reuses ONLY exported frozen helpers from middleware/i18n.js.
 */

const {
  getDaysInJalaliMonth,
  validateJalaliDate,
  compareJalaliDates,
  addOneJalaliDay,
  calculateJalaliDaysBetween,
  getCurrentJalaliDate
} = require('../middleware/i18n');

const CUTOVER = '1405/07/01';
const MINUTES_PER_WORKDAY = 8 * 60; // 8-hour day (locked Example A rule)

/* ------------------------------------------------------------------ *
 * Date helpers (string normalization; no data is modified anywhere)  *
 * ------------------------------------------------------------------ */

function pad2(n) { return String(n).padStart(2, '0'); }

/** Normalize "1405/ 06/ 14" / "1405/6/4" -> "1405/06/14" or null if invalid. */
function normalizeJalaliDate(value) {
  if (typeof value !== 'string') return null;
  const s = value.replace(/\s+/g, '');
  const m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (!validateJalaliDate(y, mo, d)) return null;
  return `${y}/${pad2(mo)}/${pad2(d)}`;
}

/** Normalize "YYYY/MM" or "YYYY/MM/01" -> {year, month} or null. */
function normalizeJalaliMonth(value) {
  if (typeof value !== 'string') return null;
  const s = value.replace(/\s+/g, '');
  const m = s.match(/^(\d{4})\/(\d{1,2})(?:\/0?1)?$/);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]);
  if (!validateJalaliDate(y, mo, 1)) return null;
  return { year: y, month: mo };
}

function dateObj(dateStr) {
  const [y, m, d] = dateStr.split('/').map(Number);
  return { year: y, month: m, day: d };
}

/** Parse "HH:MM" (H:MM tolerated) -> total minutes, or null when malformed/empty. */
function parseTimeToMinutes(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (s === '') return null;
  const m = s.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/* ------------------------------------------------------------------ *
 * Weekday: 1=Saturday .. 7=Friday (locked mapping)                    *
 * Derived from the frozen i18n Jalali arithmetic + system clock       *
 * anchor. Deterministic when options.reference is supplied (tests).   *
 * ------------------------------------------------------------------ */

function defaultWeekdayReference() {
  const [y, m, d] = getCurrentJalaliDate().split('/').map(Number);
  return { year: y, month: m, day: d, jsWeekday: new Date().getDay() };
}

/** jsDay 0=Sun..6=Sat -> locked weekday 1=Sat..7=Fri */
function jsToLocked(jsDay) { return jsDay === 6 ? 1 : jsDay + 2; }

/**
 * Weekday of a Jalali date under the locked mapping.
 * reference: {year, month, day, jsWeekday} anchor (defaults to "today").
 */
function weekdayForJalali(year, month, day, reference) {
  const ref = reference || defaultWeekdayReference();
  const target = { year, month, day };
  const cmp = compareJalaliDates(target, ref);
  let delta = 0;
  if (cmp > 0) delta = calculateJalaliDaysBetween(ref, target);
  else if (cmp < 0) delta = -calculateJalaliDaysBetween(target, ref);
  const jsDay = (((ref.jsWeekday + delta) % 7) + 7) % 7;
  return jsToLocked(jsDay);
}

/* ------------------------------------------------------------------ *
 * Exact rational arithmetic (BigInt) - integer cents, one rounding    *
 * ------------------------------------------------------------------ */

function gcdBig(a, b) { while (b) { const t = a % b; a = b; b = t; } return a < 0n ? -a : a; }

function rat(n, d) {
  n = BigInt(n); d = BigInt(d);
  if (d < 0n) { n = -n; d = -d; }
  const g = gcdBig(n, d) || 1n;
  return { n: n / g, d: d / g };
}

function ratAdd(a, b) {
  const g = gcdBig(a.d, b.d) || 1n;
  const lcm = (a.d / g) * b.d;
  return rat(a.n * (lcm / a.d) + b.n * (lcm / b.d), lcm);
}

function ratSub(a, b) { return ratAdd(a, { n: -b.n, d: b.d }); }

/** ROUND_HALF_UP to integer cents (positive values). */
function roundHalfUp(a) {
  if (a.d === 1n) return Number(a.n);
  const q = a.n / a.d;
  const r = a.n % a.d;
  const half = r * 2n >= a.d;
  return Number(half ? q + 1n : q);
}

/* ------------------------------------------------------------------ *
 * Main entry point                                                    *
 * ------------------------------------------------------------------ */

/**
 * Calculate the working-day salary entitlement for (employeeId, earningMonth).
 * @param {object} db     node:sqlite DatabaseSync handle (used READ-ONLY)
 * @param {number} employeeId
 * @param {string} earningMonth  'YYYY/MM/01'
 * @param {object} [options] { reference: {year,month,day,jsWeekday},
 *                             countFutureDays?: boolean }  countFutureDays=true
 *   counts future scheduled days too (used by obligation storage: future
 *   unrecorded days are UNPAID there); default (false) = OWNER POLICY: future
 *   days are NOT_DUE (neither paid nor unpaid); any unrecorded scheduled day
 *   that is reached (past/today) is UNPAID - pay counts only recorded days
 * @returns structured calculation result (never written to DB)
 */
function calculateEntitlement(db, employeeId, earningMonth, options = {}) {
  const blockers = [];
  const reviewItems = [];
  const notes = [
    'Rate basis: BASIC SALARY ONLY (allowances excluded) - locked rule.',
    'Calendar /30 divisors are NOT used; divisor = scheduled working days inside the employment window.',
    'Stored attendance.late_minutes is ignored; lateness recomputed from check-in vs schedule (frozen Phase 6.3 storage untouched).',
    'Early departure produces NO deduction (locked rule).',
    'HOLIDAY/CLOSURE SOURCE: only attendance status markers ("Holiday"/"Leave") are available; there is NO dedicated holiday/closure table in the current schema (UNAVAILABLE as a reliable independent source - reported, not invented).',
    'Unrecorded-day rule: a scheduled working day with no attendance record, no approved leave, and no exception is UNPAID at read time - pay counts only explicitly recorded days; no rows, no timestamps, and no exception rows are ever created by this engine. Recorded rows, approved leave and authorized exceptions stay authoritative.'
  ];

  const base = {
    employee_id: employeeId,
    earning_month: earningMonth,
    status: 'CALCULATED',
    blockers,
    review_items: reviewItems,
    schedule_id: null,
    schedule_name: null,
    working_days: null,
    expected_check_in: null,
    grace_period_minutes: null,
    employment_start: null,
    employment_end: null,
    calendar_days: 0,
    non_working_days: 0,
    scheduled_working_days: 0,
    paid_working_days: 0,
    unpaid_working_days: 0,
    leave_days: 0,
    holiday_marker_days: 0,
    exception_paid_days: 0,
    missing_attendance_days: 0,
    salary_segments: [],
    basic_salary_total: 0,
    base_entitlement_total: 0,
    lateness_minutes_total: 0,
    lateness_deduction_total: 0,
    salary_entitlement: 0,
    unpaid_dates: [],
    days: [],
    calculation_notes: notes
  };

  const finish = () => {
    base.status = blockers.length ? 'BLOCKED' : (reviewItems.length ? 'REVIEW_REQUIRED' : 'CALCULATED');
    return base;
  };

  /* 1. Validate earning month -------------------------------------- */
  const month = normalizeJalaliMonth(earningMonth);
  if (!month) {
    blockers.push({ code: 'INVALID_EARNING_MONTH', message: `Invalid earning month: ${earningMonth}` });
    return finish();
  }
  base.earning_month = `${month.year}/${pad2(month.month)}/01`;
  const monthDays = getDaysInJalaliMonth(month.year, month.month);
  base.calendar_days = monthDays;
  if (base.earning_month < CUTOVER) {
    notes.push(`PRE_CUTOVER: earning month precedes ${CUTOVER}. This engine only calculates; no salary obligation may be opened for this month (Phase 20 writer enforces cutover).`);
  }

  /* 2. Employee ------------------------------------------------------ */
  const emp = db.prepare(
    'SELECT id, full_name, hire_date, employment_end_date, work_schedule_id FROM hr_employees WHERE id = ?'
  ).get(employeeId);
  if (!emp) {
    blockers.push({ code: 'EMPLOYEE_NOT_FOUND', message: `Employee ${employeeId} not found` });
    return finish();
  }

  /* 3. Work schedule (authoritative; NO fallback - NO_SCHEDULE blocks) */
  if (emp.work_schedule_id === null || emp.work_schedule_id === undefined) {
    blockers.push({
      code: 'NO_SCHEDULE',
      message: 'No work schedule assigned. Payment/calculation blocked until an admin assigns a schedule. No schedule is invented by this engine.'
    });
    // still resolve employment window info for display
    base.employment_start = normalizeJalaliDate(emp.hire_date);
    base.employment_end = emp.employment_end_date ? normalizeJalaliDate(emp.employment_end_date) : null;
    return finish();
  }
  const sched = db.prepare(
    'SELECT id, name, expected_check_in, expected_check_out, grace_period_minutes, working_days FROM work_schedules WHERE id = ?'
  ).get(emp.work_schedule_id);
  if (!sched) {
    blockers.push({ code: 'SCHEDULE_INVALID', message: `Work schedule ${emp.work_schedule_id} not found` });
    return finish();
  }
  base.schedule_id = sched.id;
  base.schedule_name = sched.name;

  const wdSet = new Set();
  if (typeof sched.working_days === 'string') {
    for (const part of sched.working_days.split(',')) {
      const v = Number(part.trim());
      if (!Number.isInteger(v) || v < 1 || v > 7) {
        blockers.push({ code: 'SCHEDULE_INVALID', message: `Malformed working_days: ${sched.working_days}` });
        return finish();
      }
      wdSet.add(v);
    }
  }
  if (wdSet.size === 0) {
    blockers.push({ code: 'SCHEDULE_INVALID', message: 'working_days is empty' });
    return finish();
  }
  base.working_days = [...wdSet].sort((a, b) => a - b);
  base.expected_check_in = sched.expected_check_in || null;

  const grace = Number.isFinite(Number(sched.grace_period_minutes)) && sched.grace_period_minutes !== null
    ? Math.max(0, Math.trunc(Number(sched.grace_period_minutes)))
    : null;
  base.grace_period_minutes = grace === null ? 0 : grace;
  if (grace === null) {
    reviewItems.push({ code: 'GRACE_NOT_CONFIGURED', message: 'grace_period_minutes is NULL; grace treated as 0.' });
  }
  const expectedIn = parseTimeToMinutes(sched.expected_check_in);
  if (expectedIn === null) {
    reviewItems.push({ code: 'NO_EXPECTED_TIME', message: 'Schedule has no valid expected_check_in; lateness cannot be computed (no deduction assumed).' });
  }

  /* 4. Employment window -------------------------------------------- */
  const hire = normalizeJalaliDate(emp.hire_date);
  const end = emp.employment_end_date ? normalizeJalaliDate(emp.employment_end_date) : null;
  if (emp.employment_end_date && !end) {
    blockers.push({ code: 'EMPLOYMENT_DATA_INVALID', message: `Malformed employment_end_date: ${emp.employment_end_date}` });
  }
  if (!hire) {
    blockers.push({ code: 'EMPLOYMENT_DATA_INVALID', message: `Malformed hire_date: ${emp.hire_date}` });
    return finish();
  }
  base.employment_start = hire;
  base.employment_end = end;

  const monthStart = `${month.year}/${pad2(month.month)}/01`;
  const monthEnd = `${month.year}/${pad2(month.month)}/${pad2(monthDays)}`;
  const cmpStart = compareJalaliDates(dateObj(hire), dateObj(monthStart));
  const eligStart = cmpStart > 0 ? hire : monthStart;
  let eligEnd = monthEnd;
  if (end) {
    const cmpEnd = compareJalaliDates(dateObj(end), dateObj(monthEnd));
    if (cmpEnd < 0) eligEnd = end;
  }
  if (compareJalaliDates(dateObj(eligStart), dateObj(eligEnd)) > 0) {
    notes.push('OUTSIDE_EMPLOYMENT_WINDOW: employee is not employed during this earning month; entitlement = 0.');
    return finish();
  }

  /* 5. Salary history segments -------------------------------------- */
  const histRows = db.prepare(
    'SELECT id, basic_salary, allowances, effective_from, effective_to FROM employee_salary_history WHERE employee_id = ? ORDER BY effective_from, id'
  ).all(employeeId);

  if (histRows.length === 0) {
    blockers.push({ code: 'SALARY_HISTORY_MISSING', message: 'No salary history rows for this employee.' });
  }

  const salaryRows = [];
  for (const r of histRows) {
    const from = normalizeJalaliDate(r.effective_from);
    const to = r.effective_to ? normalizeJalaliDate(r.effective_to) : null;
    if (!from || (r.effective_to && !to)) {
      blockers.push({ code: 'SALARY_HISTORY_INVALID', message: `Malformed effective range on row ${r.id}: ${r.effective_from} .. ${r.effective_to}` });
      continue;
    }
    if (to && compareJalaliDates(dateObj(from), dateObj(to)) > 0) {
      blockers.push({ code: 'SALARY_HISTORY_INVALID', message: `effective_from after effective_to on row ${r.id}` });
      continue;
    }
    salaryRows.push({ rowId: r.id, basicCents: Math.round(Number(r.basic_salary) * 100), from, to });
  }

  /* 6. Load per-employee data (SELECT only) -------------------------- */
  const attByDate = new Map();
  for (const a of db.prepare('SELECT attendance_date, status, check_in, check_out, late_minutes, early_departure_minutes FROM attendance WHERE employee_id = ?').all(employeeId)) {
    const key = normalizeJalaliDate(a.attendance_date);
    if (key) attByDate.set(key, a);
  }
  const leaves = [];
  for (const l of db.prepare('SELECT start_date, end_date, status FROM leave_requests WHERE employee_id = ?').all(employeeId)) {
    const s = normalizeJalaliDate(l.start_date);
    const e = normalizeJalaliDate(l.end_date);
    if (s && e && l.status === 'Approved') leaves.push({ from: s, to: e });
  }
  const excByDate = new Map();
  for (const x of db.prepare('SELECT exception_date, status, payroll_treatment, reason FROM attendance_exception WHERE employee_id = ?').all(employeeId)) {
    const key = normalizeJalaliDate(x.exception_date);
    if (key) excByDate.set(key, x);
  }

  /* 7. Walk every eligible day -------------------------------------- */
  const ref = options.reference || defaultWeekdayReference();
  const gapDates = [];
  const overlapDates = [];
  let allSwd = 0; // scheduled working days inside the employment window (locked divisor)

  let cursor = eligStart;
  let segmentOfDate = null;

  const segAgg = new Map(); // rowId -> { basicCents, swd, unpaid, lateMinutes, dates }

  while (compareJalaliDates(dateObj(cursor), dateObj(eligEnd)) <= 0) {
    const cur = dateObj(cursor);
    const weekday = weekdayForJalali(cur.year, cur.month, cur.day, ref);
    const isScheduled = wdSet.has(weekday);

    // salary coverage for this eligible day
    const covering = salaryRows.filter(r =>
      compareJalaliDates(dateObj(cursor), dateObj(r.from)) >= 0 &&
      (!r.to || compareJalaliDates(dateObj(cursor), dateObj(r.to)) <= 0)
    );
    if (covering.length === 0) { gapDates.push(cursor); segmentOfDate = null; }
    else if (covering.length > 1) { overlapDates.push(cursor); segmentOfDate = null; }
    else segmentOfDate = covering[0];

    const dayDetail = {
      date: cursor,
      weekday,
      scheduled: isScheduled,
      source: null,        // ATTENDANCE | LEAVE | EXCEPTION | NONE
      treatment: null,     // PAID | UNPAID | BLOCKED | NON_WORKING | NOT_DUE
      attendance_status: null,
      raw_lateness_minutes: 0,
      deductible_lateness_minutes: 0,
      stored_late_minutes: null,
      early_departure_minutes: null,
      salary_row_id: covering.length === 1 ? covering[0].rowId : null
    };

    if (!isScheduled) {
      base.non_working_days++;
      dayDetail.treatment = 'NON_WORKING';
      base.days.push(dayDetail);
      cursor = nextDate(cursor);
      continue;
    }

    base.scheduled_working_days++;
    allSwd++;

    const att = attByDate.get(cursor);
    const approvedLeave = leaves.some(l =>
      compareJalaliDates(dateObj(cursor), dateObj(l.from)) >= 0 &&
      compareJalaliDates(dateObj(cursor), dateObj(l.to)) <= 0
    );
    const exc = excByDate.get(cursor);

    let resolvedTreatment = null;

    if (att) {
      dayDetail.source = 'ATTENDANCE';
      dayDetail.attendance_status = att.status;
      dayDetail.stored_late_minutes = att.late_minutes;
      dayDetail.early_departure_minutes = att.early_departure_minutes;

      if (att.status === 'Holiday' || att.status === 'Leave') {
        // Explicit marker rows: paid, no check-in expectation (matches frozen
        // late-query exclusions and the locked Paid/No-deduction treatment).
        resolvedTreatment = 'PAID';
        if (att.status === 'Holiday') base.holiday_marker_days++;
        else base.leave_days++;
      } else {
        const inMin = parseTimeToMinutes(att.check_in);
        if (inMin === null) {
          // Missing/empty check-in: NO assumed lateness, NO automatic deduction.
          if (att.status === 'Absent') {
            // EXPLICIT ABSENT: sole override of default-present (existing authority).
            if (exc && exc.status === 'RESOLVED') {
              resolvedTreatment = applyExceptionTreatment(exc, dayDetail, blockers, cursor);
            } else {
              blockers.push({
                code: 'MISSING_CHECK_IN',
                date: cursor,
                message: `Attendance row exists on ${cursor} (status: Absent) but check-in is missing/empty. Unresolved: no lateness assumed, no deduction taken. Requires corrected attendance or a RESOLVED exception.`
              });
            }
          } else if (exc && exc.status === 'RESOLVED') {
            resolvedTreatment = applyExceptionTreatment(exc, dayDetail, blockers, cursor);
          } else if (exc && exc.status === 'PENDING') {
            blockers.push({
              code: 'PENDING_EXCEPTION',
              date: cursor,
              message: `Attendance exception on ${cursor} is PENDING REVIEW (reason: ${exc.reason}). Payment calculation blocked until admin resolves it.`
            });
            resolvedTreatment = 'BLOCKED';
          } else if (exc) {
            blockers.push({ code: 'EXCEPTION_INVALID', date: cursor, message: `Unknown exception status on ${cursor}` });
            resolvedTreatment = 'BLOCKED';
          } else {
            // DEFAULT PRESENT (timeless non-absent row, no flag): present and paid
            // by default. No lateness assumed, no deduction taken.
            resolvedTreatment = 'PAID';
          }
        } else if (expectedIn === null) {
          resolvedTreatment = 'PAID';
          dayDetail.source = 'ATTENDANCE';
        } else {
          const raw = Math.max(0, inMin - expectedIn);
          const deductible = Math.max(0, raw - base.grace_period_minutes);
          dayDetail.raw_lateness_minutes = raw;
          dayDetail.deductible_lateness_minutes = deductible;
          resolvedTreatment = 'PAID';
          if (att.late_minutes !== null && att.late_minutes !== undefined && Number(att.late_minutes) !== raw) {
            reviewItems.push({
              code: 'STORED_LATE_MINUTES_IGNORED',
              date: cursor,
              message: `Stored late_minutes=${att.late_minutes} differs from computed raw=${raw}; engine uses computed value (frozen storage untouched).`
            });
          }
        }
      }
    } else if (approvedLeave) {
      dayDetail.source = 'LEAVE';
      resolvedTreatment = 'PAID'; // approved leave: paid, remains in divisor
      base.leave_days++;
    } else if (exc) {
      dayDetail.source = 'EXCEPTION';
      if (exc.status === 'PENDING') {
        blockers.push({
          code: 'PENDING_EXCEPTION',
          date: cursor,
          message: `Attendance exception on ${cursor} is PENDING REVIEW (reason: ${exc.reason}). Payment calculation blocked until admin resolves it.`
        });
        resolvedTreatment = 'BLOCKED';
      } else if (exc.status === 'RESOLVED') {
        resolvedTreatment = applyExceptionTreatment(exc, dayDetail, blockers, cursor);
      } else {
        blockers.push({ code: 'EXCEPTION_INVALID', date: cursor, message: `Unknown exception status on ${cursor}` });
        resolvedTreatment = 'BLOCKED';
      }
    } else {
      // UNRECORDED DAY (owner policy): scheduled working day with no
      // attendance, no approved leave, no exception -> UNPAID. Pay counts only
      // explicitly recorded days; nothing is assumed present. READ-TIME ONLY:
      // no row is ever created, no timestamp is invented, nothing is written.
      // Future scheduled days (after the reference date) stay NOT_DUE - they
      // have not happened yet, so they are neither paid nor unpaid yet; a
      // NOT_DUE day leaves the numerator (agg.swd) while allSwd (the locked
      // month-total divisor) is unchanged. Under countFutureDays = true
      // (obligation storage) future unrecorded days are UNPAID too, so
      // salary_earned stores the recorded-days figure and grows as days are
      // recorded; trg_payment_finalize caps paid at that earned. Explicit
      // rows, approved leave and the exception branch above stay authoritative
      // on ANY date.
      dayDetail.source = 'NONE';
      const isFutureDay = compareJalaliDates(cur, ref) > 0;
      resolvedTreatment = (isFutureDay && options.countFutureDays !== true) ? 'NOT_DUE' : 'UNPAID';
    }

    dayDetail.treatment = resolvedTreatment;
    if (dayDetail.source === 'EXCEPTION' && resolvedTreatment === 'PAID') {
      base.exception_paid_days++;
    }

    // aggregate for segment math (only fully-resolved paid/unpaid days)
    if (segmentOfDate && (resolvedTreatment === 'PAID' || resolvedTreatment === 'UNPAID')) {
      let agg = segAgg.get(segmentOfDate.rowId);
      if (!agg) {
        agg = { basicCents: segmentOfDate.basicCents, swd: 0, unpaid: 0, lateMinutes: 0, from: segmentOfDate.from, to: segmentOfDate.to, rowId: segmentOfDate.rowId };
        segAgg.set(segmentOfDate.rowId, agg);
      }
      agg.swd++;
      if (resolvedTreatment === 'UNPAID') {
        agg.unpaid++;
        base.unpaid_working_days++;
        base.unpaid_dates.push(cursor);
      } else {
        base.paid_working_days++;
      }
      agg.lateMinutes += dayDetail.deductible_lateness_minutes;
      base.lateness_minutes_total += dayDetail.deductible_lateness_minutes;
    } else if (!segmentOfDate) {
      // gap/overlap day already flagged
    }

    base.days.push(dayDetail);
    cursor = nextDate(cursor);
  }

  /* salary history structural checks */
  if (gapDates.length) blockers.push({ code: 'SALARY_HISTORY_GAP', message: `No salary history coverage for eligible dates (first: ${gapDates[0]}${gapDates.length > 1 ? `, ${gapDates.length} day(s)` : ''}). Never silently repaired.`, dates: gapDates });
  if (overlapDates.length) blockers.push({ code: 'SALARY_HISTORY_OVERLAP', message: `Overlapping salary history rows on eligible dates (first: ${overlapDates[0]}${overlapDates.length > 1 ? `, ${overlapDates.length} day(s)` : ''}). Never silently repaired.`, dates: overlapDates });
  // missing_attendance_days: unrecorded-day rule marks missing scheduled days
  // UNPAID (counted through unpaid_working_days / unpaid_dates). Field
  // retained (= 0) for frozen payment-workspace display compatibility.

  /* 8. Segment entitlement math (exact rationals, ONE rounding) ------
   * Divisor = month-total scheduled working days inside the employment
   * window (single-segment and multi-segment proration share it). */
  let totalBase = rat(0, 1);
  let totalLate = rat(0, 1);
  let basicTotalCents = 0;

  for (const [rowId, agg] of segAgg) {
    const segFrom = agg.from, segTo = agg.to;
    const baseEnt = allSwd > 0 ? rat(BigInt(agg.basicCents) * BigInt(agg.swd - agg.unpaid), BigInt(allSwd)) : rat(0, 1);
    const lateEnt = allSwd > 0 ? rat(BigInt(agg.basicCents) * BigInt(agg.lateMinutes), BigInt(allSwd * MINUTES_PER_WORKDAY)) : rat(0, 1);
    totalBase = ratAdd(totalBase, baseEnt);
    totalLate = ratAdd(totalLate, lateEnt);
    basicTotalCents += agg.basicCents;

    const swd = agg.swd;
    base.salary_segments.push({
      salary_row_id: rowId,
      basic_salary: roundHalfUp(rat(agg.basicCents, 1)) / 100,
      effective_from: segFrom,
      effective_to: segTo,
      scheduled_days: swd,
      unpaid_days: agg.unpaid,
      lateness_minutes: agg.lateMinutes,
      base_entitlement: roundHalfUp(baseEnt) / 100,
      lateness_deduction: roundHalfUp(lateEnt) / 100,
      rates: {
        daily: allSwd ? roundHalfUp(rat(agg.basicCents, BigInt(allSwd))) / 100 : 0,
        hourly: allSwd ? roundHalfUp(rat(agg.basicCents, BigInt(allSwd * 8))) / 100 : 0,
        minute: allSwd ? roundHalfUp(rat(agg.basicCents, BigInt(allSwd * MINUTES_PER_WORKDAY))) / 100 : 0
      }
    });
  }

  // segments that were never reached (e.g., blocked early) but exist in history: still show them
  for (const r of salaryRows) {
    if (!segAgg.has(r.rowId)) {
      base.salary_segments.push({
        salary_row_id: r.rowId,
        basic_salary: r.basicCents / 100,
        effective_from: r.from,
        effective_to: r.to,
        scheduled_days: 0, unpaid_days: 0, lateness_minutes: 0,
        base_entitlement: 0, lateness_deduction: 0,
        rates: { daily: 0, hourly: 0, minute: 0 }
      });
    }
  }
  base.basic_salary_total = basicTotalCents / 100;

  const baseCents = roundHalfUp(totalBase);
  const lateCents = roundHalfUp(totalLate);
  let entitlementCents = roundHalfUp(ratSub(totalBase, totalLate));
  if (entitlementCents < 0) {
    entitlementCents = 0;
    reviewItems.push({ code: 'LATENESS_CLAMPED', message: 'Computed lateness deductions exceeded base entitlement; entitlement clamped to 0 (never negative).' });
  }
  base.base_entitlement_total = baseCents / 100;
  base.lateness_deduction_total = lateCents / 100;
  base.salary_entitlement = entitlementCents / 100;

  return finish();
}

/** Apply a RESOLVED exception treatment; returns PAID | UNPAID | null(+blocker). */
function applyExceptionTreatment(exc, dayDetail, blockers, date) {
  switch (exc.payroll_treatment) {
    case 'PAID_NO_DEDUCTION':
      return 'PAID';
    case 'NO_PAYROLL_EFFECT':
      return 'PAID';
    case 'UNPAID_DEDUCT':
      return 'UNPAID';
    case 'FOLLOW_CORRECTED':
      blockers.push({
        code: 'CORRECTED_ATTENDANCE_MISSING',
        date,
        message: `Exception on ${date} is FOLLOW_CORRECTED but no corrected attendance record exists. Blocked (safe: nothing assumed).`
      });
      return 'BLOCKED';
    default:
      blockers.push({ code: 'EXCEPTION_INVALID', date, message: `Unknown payroll_treatment on ${date}` });
      return 'BLOCKED';
  }
}

function nextDate(dateStr) {
  const o = dateObj(dateStr);
  const n = addOneJalaliDay(o.year, o.month, o.day);
  return `${n.year}/${pad2(n.month)}/${pad2(n.day)}`;
}

module.exports = {
  calculateEntitlement,
  weekdayForJalali,
  defaultWeekdayReference,
  normalizeJalaliDate,
  normalizeJalaliMonth,
  parseTimeToMinutes,
  roundHalfUp,
  rat,
  ratAdd,
  ratSub
};
