'use strict';
// Phase 24C pure payment allocation engine.
// Pure, deterministic, synchronous, side-effect free.
// Money: integer cents only (Number.isSafeInteger); legacy unit conversion
// happens outside this engine. Input is never mutated; candidate arrays are
// copied before any ordering. Every result carries mutated as literal false.

function isInt(v) {
  return typeof v === 'number' && Number.isSafeInteger(v);
}

function normDate(v) {
  return v.replace(/\s+/g, '');
}

function pushUnique(arr, code) {
  if (arr.indexOf(code) === -1) arr.push(code);
}

function byDateId(a, b) {
  if (a.sortDate !== b.sortDate) return a.sortDate < b.sortDate ? -1 : 1;
  return a.id - b.id;
}

function findRow(rows, id) {
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].id === id) return rows[i];
  }
  return null;
}

function anyIneligible(rows) {
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i].statusOk) return true;
  }
  return false;
}

function otAllCapacityZero(rows) {
  if (rows.length === 0) return false;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].remaining !== 0) return false;
  }
  return true;
}

function advHasReservationZeroCapacity(rows) {
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].available === 0 && rows[i].reserved > 0) return true;
  }
  return false;
}

function anyOtPartial(rows) {
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].alloc > 0 && rows[i].alloc < rows[i].remaining) return true;
  }
  return false;
}

function anyAdvPartial(rows) {
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].alloc > 0 && rows[i].alloc < rows[i].available) return true;
  }
  return false;
}

function allocatePayment(input) {
  const BLOCKERS = [
    'OBLIGATION_NOT_FOUND',
    'OBLIGATION_FULLY_PAID',
    'SOURCE_UNAVAILABLE',
    'OT_NOT_ELIGIBLE',
    'ADVANCE_NOT_ELIGIBLE',
    'OVER_ALLOCATION',
    'INVALID_MANUAL_SELECTION',
    'RESERVATION_CONFLICT',
    'INCONSISTENT_BALANCE',
    'INVALID_REQUESTED_AMOUNT'
  ];
  const WARNINGS = [
    'PARTIAL_SALARY',
    'PARTIAL_OT',
    'PARTIAL_ADVANCE',
    'ADDITIONAL_PAYMENT',
    'OVERPAYMENT_REVIEW',
    'ATTENDANCE_REVIEW_CONTEXT',
    'DRAFT_RESERVATION_SALARY_UNGUARDED'
  ];
  const DEFAULT_CUTOVER = '1405/07/01';
  const OT_APPROVED = 'Approved';
  const ADV_ALLOWED = ['Active', 'Partially Repaid'];
  const MODES = ['FIFO', 'MANUAL', 'OLDEST_FIRST'];

  const src = (input !== null && typeof input === 'object') ? input : {};
  const blockers = [];
  let inconsistent = false;

  // ---- mode ------------------------------------------------------------
  let mode = (src.mode === undefined || src.mode === null) ? 'FIFO' : src.mode;
  let modeInvalid = false;
  if (MODES.indexOf(mode) === -1) {
    modeInvalid = true;
    pushUnique(blockers, 'INVALID_MANUAL_SELECTION');
  }

  // ---- requested_cents -------------------------------------------------
  const reqPresent = Object.prototype.hasOwnProperty.call(src, 'requested_cents') &&
    src.requested_cents !== undefined;
  const reqValid = reqPresent && isInt(src.requested_cents) && src.requested_cents >= 0;
  if (reqPresent && !reqValid) pushUnique(blockers, 'INVALID_REQUESTED_AMOUNT');
  let demand = reqValid ? src.requested_cents : Infinity;

  // ---- locked flags ----------------------------------------------------
  const flags = (src.locked_flags !== null && typeof src.locked_flags === 'object')
    ? src.locked_flags : {};
  const flagAttendance = flags.attendance_review_required === true;
  const flagDraft = flags.salary_draft_contention === true;
  const cutover = (typeof flags.cutover === 'string' && flags.cutover.length > 0)
    ? flags.cutover : DEFAULT_CUTOVER;

  // ---- obligation snapshot --------------------------------------------
  const obl = (src.obligation !== null && typeof src.obligation === 'object')
    ? src.obligation : null;
  let obligationId = null;
  let salaryRemaining = 0;
  let salaryAvailable = 0;
  let salaryUsable = false;

  if (!obl) {
    pushUnique(blockers, 'OBLIGATION_NOT_FOUND');
  } else {
    if (obl.id !== undefined && obl.id !== null) obligationId = obl.id;
    const rem = obl.salary_remaining;
    if (!isInt(rem)) {
      inconsistent = true;
    } else {
      salaryRemaining = rem > 0 ? rem : 0;
      if (obl.status === 'PAID' || rem <= 0) {
        pushUnique(blockers, 'OBLIGATION_FULLY_PAID');
      } else {
        salaryUsable = true;
        salaryAvailable = rem;
      }
    }
  }

  // ---- candidate snapshots (engine-local rows, input untouched) --------
  const otRaw = Array.isArray(src.ot_candidates) ? src.ot_candidates : [];
  const advRaw = Array.isArray(src.advance_candidates) ? src.advance_candidates : [];

  const otRows = [];
  for (let i = 0; i < otRaw.length; i++) {
    const c = otRaw[i];
    const ok = c !== null && typeof c === 'object' && isInt(c.id) && c.id > 0 &&
      isInt(c.remaining_cents) && c.remaining_cents >= 0 &&
      typeof c.overtime_date === 'string' && normDate(c.overtime_date).length > 0;
    if (!ok) {
      inconsistent = true;
      continue;
    }
    const statusOk = c.status === OT_APPROVED &&
      (c.payroll_id === null || c.payroll_id === undefined) &&
      normDate(c.overtime_date) >= cutover;
    otRows.push({
      id: c.id,
      sortDate: normDate(c.overtime_date),
      remaining: c.remaining_cents,
      statusOk: statusOk,
      alloc: 0
    });
  }

  const advRows = [];
  for (let i = 0; i < advRaw.length; i++) {
    const c = advRaw[i];
    const baseOk = c !== null && typeof c === 'object' && isInt(c.id) && c.id > 0 &&
      typeof c.date === 'string' && normDate(c.date).length > 0 &&
      isInt(c.original_amount_cents) && c.original_amount_cents >= 0;
    if (!baseOk) {
      inconsistent = true;
      continue;
    }
    let rep = 0;
    let draft = 0;
    let fin = 0;
    let partsOk = true;
    const parts = [
      ['repayment_cents', 0],
      ['draft_reserved_cents', 0],
      ['finalized_allocated_cents', 0]
    ];
    for (let p = 0; p < parts.length; p++) {
      const raw = c[parts[p][0]];
      if (raw === undefined || raw === null) continue;
      if (isInt(raw) && raw >= 0) {
        if (p === 0) rep = raw;
        else if (p === 1) draft = raw;
        else fin = raw;
      } else {
        partsOk = false;
      }
    }
    const available = c.original_amount_cents - rep - draft - fin;
    if (!partsOk || available < 0) {
      inconsistent = true;
      continue;
    }
    advRows.push({
      id: c.id,
      sortDate: normDate(c.date),
      available: available,
      reserved: draft + fin,
      statusOk: ADV_ALLOWED.indexOf(c.status) !== -1,
      alloc: 0
    });
  }

  if (inconsistent) pushUnique(blockers, 'INCONSISTENT_BALANCE');

  // ---- ordering (copies sorted; input arrays never touched) ------------
  const otSorted = otRows.slice().sort(byDateId);
  const advSorted = advRows.slice().sort(byDateId);
  const otTrace = [];
  const advTrace = [];

  // ---- allocation -------------------------------------------------------
  const blocked = modeInvalid || (reqPresent && !reqValid);
  let salaryAlloc = 0;
  let otTotal = 0;
  let advTotal = 0;

  if (!blocked && mode !== 'MANUAL') {
    if (salaryUsable) {
      const a = Math.min(demand, salaryAvailable);
      salaryAlloc = a;
      demand -= a;
    }
    for (let i = 0; i < otSorted.length; i++) {
      const r = otSorted[i];
      if (!(demand > 0)) break;
      if (!r.statusOk || r.remaining <= 0) continue;
      const a = Math.min(demand, r.remaining);
      r.alloc = a;
      demand -= a;
      otTotal += a;
      if (a > 0) otTrace.push(r.id);
    }
    let capLeft = salaryAlloc + otTotal;
    for (let i = 0; i < advSorted.length; i++) {
      const r = advSorted[i];
      if (!(capLeft > 0)) break;
      if (!r.statusOk || r.available <= 0) continue;
      const a = Math.min(capLeft, r.available);
      r.alloc = a;
      capLeft -= a;
      advTotal += a;
      if (a > 0) advTrace.push(r.id);
    }
  }

  if (!blocked && mode === 'MANUAL') {
    const sels = Array.isArray(src.manual_selections) ? src.manual_selections : null;
    if (sels === null) {
      pushUnique(blockers, 'INVALID_MANUAL_SELECTION');
    } else {
      const seen = [];
      const advQueue = [];
      for (let i = 0; i < sels.length; i++) {
        const sel = sels[i];
        const st = (sel !== null && typeof sel === 'object') ? sel.source_type : undefined;
        if (st === 'ADVANCE') {
          advQueue.push(sel);
          continue;
        }
        if (st !== 'SALARY' && st !== 'OVERTIME') {
          pushUnique(blockers, 'INVALID_MANUAL_SELECTION');
          continue;
        }
        if (!isInt(sel.amount_cents) || sel.amount_cents <= 0 ||
            !isInt(sel.source_id) || sel.source_id <= 0) {
          pushUnique(blockers, 'INVALID_MANUAL_SELECTION');
          continue;
        }
        const key = st + ':' + sel.source_id;
        if (seen.indexOf(key) !== -1) {
          pushUnique(blockers, 'INVALID_MANUAL_SELECTION');
          continue;
        }
        seen.push(key);
        if (st === 'SALARY') {
          if (!obl || obligationId === null || sel.source_id !== obligationId ||
              !isInt(obl.salary_remaining)) {
            pushUnique(blockers, 'INVALID_MANUAL_SELECTION');
            continue;
          }
          const avail = (obl.status === 'PAID' || obl.salary_remaining <= 0)
            ? 0 : obl.salary_remaining;
          if (sel.amount_cents > avail) {
            pushUnique(blockers, 'INVALID_MANUAL_SELECTION');
            pushUnique(blockers, 'OVER_ALLOCATION');
            continue;
          }
          salaryAlloc = sel.amount_cents;
          demand -= salaryAlloc;
        } else {
          const row = findRow(otRows, sel.source_id);
          if (row === null) {
            pushUnique(blockers, 'INVALID_MANUAL_SELECTION');
            continue;
          }
          if (!row.statusOk) {
            pushUnique(blockers, 'INVALID_MANUAL_SELECTION');
            pushUnique(blockers, 'OT_NOT_ELIGIBLE');
            continue;
          }
          if (row.remaining <= 0 || sel.amount_cents > row.remaining) {
            pushUnique(blockers, 'INVALID_MANUAL_SELECTION');
            pushUnique(blockers, 'OVER_ALLOCATION');
            continue;
          }
          row.alloc = sel.amount_cents;
          demand -= sel.amount_cents;
          otTotal += sel.amount_cents;
          otTrace.push(row.id);
        }
      }
      const advCap = salaryAlloc + otTotal;
      let advApplied = 0;
      for (let i = 0; i < advQueue.length; i++) {
        const sel = advQueue[i];
        if (sel === null || typeof sel !== 'object' ||
            !isInt(sel.amount_cents) || sel.amount_cents <= 0 ||
            !isInt(sel.source_id) || sel.source_id <= 0) {
          pushUnique(blockers, 'INVALID_MANUAL_SELECTION');
          continue;
        }
        const key = 'ADVANCE:' + sel.source_id;
        if (seen.indexOf(key) !== -1) {
          pushUnique(blockers, 'INVALID_MANUAL_SELECTION');
          continue;
        }
        seen.push(key);
        const row = findRow(advRows, sel.source_id);
        if (row === null) {
          pushUnique(blockers, 'INVALID_MANUAL_SELECTION');
          continue;
        }
        if (!row.statusOk) {
          pushUnique(blockers, 'INVALID_MANUAL_SELECTION');
          pushUnique(blockers, 'ADVANCE_NOT_ELIGIBLE');
          continue;
        }
        if (row.available <= 0 || sel.amount_cents > row.available) {
          pushUnique(blockers, 'INVALID_MANUAL_SELECTION');
          pushUnique(blockers, 'OVER_ALLOCATION');
          continue;
        }
        if (sel.amount_cents > advCap - advApplied) {
          pushUnique(blockers, 'INVALID_MANUAL_SELECTION');
          pushUnique(blockers, 'OVER_ALLOCATION');
          continue;
        }
        row.alloc = sel.amount_cents;
        advApplied += sel.amount_cents;
        advTotal += sel.amount_cents;
        advTrace.push(row.id);
      }
    }
  }

  // ---- source classification (auto modes) -------------------------------
  // OT: only when a valid request still has uncovered demand.
  if (!blocked && mode !== 'MANUAL' && reqValid && demand > 0) {
    if (otRaw.length === 0) {
      pushUnique(blockers, 'SOURCE_UNAVAILABLE');
    } else if (anyIneligible(otRows)) {
      pushUnique(blockers, 'OT_NOT_ELIGIBLE');
    } else if (otTotal === 0 && otAllCapacityZero(otRows)) {
      pushUnique(blockers, 'RESERVATION_CONFLICT');
    }
  }
  // Advances: whenever earnings exist but no advance could be applied
  // (eligibility or reservation capacity is the reason).
  if (!blocked && mode !== 'MANUAL' &&
      salaryAlloc + otTotal > 0 && advRaw.length > 0 && advTotal === 0) {
    if (anyIneligible(advRows)) {
      pushUnique(blockers, 'ADVANCE_NOT_ELIGIBLE');
    } else if (advHasReservationZeroCapacity(advRows)) {
      pushUnique(blockers, 'RESERVATION_CONFLICT');
    }
  }

  // ---- classification of excess ----------------------------------------
  const excess = (reqValid && demand > 0) ? demand : 0;
  const partialSalary = salaryAlloc > 0 && salaryAlloc < salaryAvailable;
  const partialOt = anyOtPartial(otRows) ||
    (reqValid && demand > 0 && otTotal > 0);
  const partialAdv = anyAdvPartial(advRows);
  const wFlags = [
    partialSalary,
    partialOt,
    partialAdv,
    excess > 0,
    excess > 0,
    flagAttendance,
    flagDraft
  ];
  const warnings = [];
  for (let i = 0; i < WARNINGS.length; i++) {
    if (wFlags[i]) warnings.push(WARNINGS[i]);
  }

  blockers.sort(function (a, b) {
    return BLOCKERS.indexOf(a) - BLOCKERS.indexOf(b);
  });

  const zero = salaryAlloc === 0 && otTotal === 0 && advTotal === 0;
  const auditIntents = [];
  if (excess > 0) auditIntents.push({ action: 'DATA_WARNING', entity: 'payment' });
  if (zero) auditIntents.push({ action: 'ZERO_PAID', entity: 'payment' });

  const outOt = [];
  for (let i = 0; i < otSorted.length; i++) {
    const r = otSorted[i];
    outOt.push({
      id: r.id,
      available_before: r.remaining,
      allocated_cents: r.alloc,
      eligible: r.statusOk && r.remaining > 0
    });
  }
  const outAdv = [];
  for (let i = 0; i < advSorted.length; i++) {
    const r = advSorted[i];
    outAdv.push({
      id: r.id,
      available_before: r.available,
      allocated_cents: r.alloc,
      eligible: r.statusOk && r.available > 0
    });
  }

  const earnings = salaryAlloc + otTotal;
  return {
    mutated: false,
    blockers: blockers,
    warnings: warnings,
    salary: {
      obligation_id: obligationId,
      allocated_cents: salaryAlloc,
      remaining_before: salaryRemaining,
      remaining_after: salaryRemaining - salaryAlloc,
      partial: partialSalary
    },
    overtime: outOt,
    advance: outAdv,
    totals: {
      salary_total: salaryAlloc,
      overtime_total: otTotal,
      additional_total: 0,
      earnings_total: earnings,
      advance_deduction_total: advTotal,
      entered_total: reqValid ? src.requested_cents : 0,
      net_cents: earnings - advTotal
    },
    salary_remaining_after: salaryRemaining - salaryAlloc,
    unexplained_excess_cents: excess,
    additional: {
      required: excess > 0,
      possible: excess > 0
    },
    overpayment: {
      required: excess > 0,
      excess_cents: excess
    },
    zero: zero,
    ordering_trace: {
      ot: otTrace,
      adv: advTrace,
      mode: mode
    },
    audit_intents: auditIntents
  };
}

module.exports = { allocatePayment: allocatePayment };
