'use strict';

/**
 * PHASE 26 — employee payment correction + advance dispute workflow.
 *
 * Scope (owner-approved, Phase 26 implementation):
 *   1. correctPayment  — FINALIZED -> CORRECTED for a finalized payment with a
 *      mandatory reason. Components are never modified (financial records stay
 *      immutable). One transaction: salary obligation paid-amount restore,
 *      advance balance/status restore, overpayment recovery advance removal
 *      (source_payment_id relationship), payment status flip + corrected_count,
 *      payment_audit CORRECT row. Any failure rolls the whole transaction back
 *      and writes a BLOCKED audit in a separate committed mini-transaction.
 *      OT and advance capacity restore automatically because every consume-side
 *      query and guard counts only status IN ('DRAFT','FINALIZED').
 *   2. openDispute / resolveDispute — salary_advances status toggles
 *      Active|Partially Repaid <-> Disputed with mandatory reasons and
 *      payment_audit DISPUTE_OPENED / DISPUTE_RESOLVED rows (entity 'advance').
 *      Consume-side fences (trg_component_adv_guard, trg_payment_finalize
 *      ADVANCE_DISPUTED, trg_repay_disputed_block, engine ADVANCE_NOT_ELIGIBLE)
 *      stay authoritative and unchanged.
 *
 * This file deliberately lives outside paymentController.js: the frozen
 * Phase 25C suite statically asserts that paymentController.js never emits
 * CORRECT/DISPUTE audit actions nor sets status = 'CORRECTED'.
 *
 * No schema, trigger, engine, or legacy code is modified by this file.
 * Routes: GET/POST /admin/hr/payment-correction/:id, POST /admin/hr/advances/:id/dispute,
 * POST /admin/hr/advances/:id/dispute/resolve — all requireAdmin; global CSRF
 * middleware (server.js) covers them.
 *
 * Phase 5 — the old payment detail page (which hosted the correction form) was
 * deleted; GET /admin/hr/payment-correction/:id is its small dedicated
 * replacement (summary + reason form, or the corrected note).
 */

const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const notificationSSE = require('../utils/notificationSSE');

const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'enterprise_cement.db');

const DISPUTE_STATUSES = ['Active', 'Partially Repaid'];
const MIN_REASON = 5;

const REFUSAL_T = {
  PAYMENT_NOT_FOUND: 'err_not_found',
  PAYMENT_NOT_FINALIZED: 'err_not_finalized',
  REASON_REQUIRED: 'err_reason_required',
  OBLIGATION_NOT_FOUND: 'err_obligation',
  OBLIGATION_RESTORE_INVALID: 'err_obligation_restore',
  ADVANCE_RESTORE_INVALID: 'err_advance_restore',
  RECOVERY_ADVANCE_IN_USE: 'err_recovery_in_use',
  RECOVERY_ADVANCE_MODIFIED: 'err_recovery_modified',
  ADVANCE_NOT_FOUND: 'err_adv_not_found',
  ADVANCE_NOT_DISPUTABLE: 'err_adv_not_disputable',
  ADVANCE_NOT_DISPUTED: 'err_adv_not_disputed',
  ADVANCE_DISPUTED: 'err_adv_disputed',
  INVALID_STATUS_TRANSITION: 'err_not_finalized',
  NEGATIVE_REMAINING_BALANCE: 'err_advance_restore',
  SALARY_PAID_OUT_OF_RANGE: 'err_obligation_restore',
  INTERNAL: 'err_generic'
};

const ABORT_CODES = ['INVALID_STATUS_TRANSITION', 'NEGATIVE_REMAINING_BALANCE',
  'SALARY_PAID_OUT_OF_RANGE', 'FINANCIAL_RECORD_IMMUTABLE'];

function openDb(readOnly) {
  const db = readOnly ? new DatabaseSync(DB_PATH, { readOnly: true }) : new DatabaseSync(DB_PATH);
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

function isInt(v) {
  return typeof v === 'number' && Number.isSafeInteger(v);
}

function validReason(raw) {
  return typeof raw === 'string' && raw.trim().length >= MIN_REASON;
}

function refusalError(code, detail) {
  const e = new Error(code);
  e.refusal = code;
  e.detail = detail || null;
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

function auditBlocked(db, entity, entityId, reason, actorId) {
  try {
    db.exec('BEGIN IMMEDIATE');
    audit(db, {
      payment_id: entity === 'payment' ? entityId : null,
      action: 'BLOCKED',
      entity,
      entity_id: entityId === undefined ? null : entityId,
      reason
    }, actorId);
    db.exec('COMMIT');
    return true;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* not in txn */ }
    console.error('[paymentCorrection] BLOCKED audit failed:', e && e.message);
    return false;
  }
}

function refused(db, entity, entityId, code, detail, actorId) {
  const reason = detail ? code + ': ' + detail : code;
  auditBlocked(db, entity, entityId, reason, actorId);
  return { ok: false, refusal: code, detail: detail || null };
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
    console.error('[paymentCorrection] notification error (transaction committed):', e && e.message);
  }
}

/* ----------------------------------------------------------------- cores */

/**
 * FINALIZED -> CORRECTED. Mandatory reason. Transactional restore + rollback.
 * db must be an open writable DatabaseSync handle owned by the caller.
 */
function correctPaymentTxn(db, params) {
  const p = params || {};
  const paymentId = Number(p.payment_id);
  const actorId = isInt(p.actor_id) && p.actor_id > 0 ? p.actor_id : 0;
  const reasonText = typeof p.reason === 'string' ? p.reason.trim() : '';

  if (!isInt(paymentId) || paymentId <= 0) {
    return refused(db, 'payment', null, 'PAYMENT_NOT_FOUND', String(p.payment_id), actorId);
  }
  if (!validReason(reasonText)) {
    return refused(db, 'payment', paymentId, 'REASON_REQUIRED', null, actorId);
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const payment = db.prepare('SELECT * FROM payment WHERE id = ?').get(paymentId);
    if (!payment) throw refusalError('PAYMENT_NOT_FOUND', String(paymentId));
    if (payment.status !== 'FINALIZED') throw refusalError('PAYMENT_NOT_FINALIZED', payment.status);

    const comps = db.prepare(
      'SELECT type, amount, advance_id FROM payment_component WHERE payment_id = ?'
    ).all(paymentId);
    let salarySum = 0;
    const advRestore = new Map();
    for (const c of comps) {
      if (c.type === 'SALARY') salarySum += c.amount;
      else if (c.type === 'ADVANCE' && c.advance_id !== null && c.advance_id !== undefined) {
        advRestore.set(c.advance_id, (advRestore.get(c.advance_id) || 0) + c.amount);
      }
    }

    const recoveryChk = db.prepare(
      'SELECT id FROM salary_advances WHERE source_payment_id = ?'
    ).get(paymentId);
    const disputedCheckIds = Array.from(advRestore.keys());
    if (recoveryChk) disputedCheckIds.push(recoveryChk.id);
    for (const chkId of disputedCheckIds) {
      const chkRow = db.prepare('SELECT status FROM salary_advances WHERE id = ?').get(chkId);
      if (chkRow && chkRow.status === 'Disputed') {
        throw refusalError('ADVANCE_DISPUTED', String(chkId));
      }
    }

    if (salarySum > 0) {
      const obl = db.prepare(
        'SELECT id, employee_id, salary_earned, salary_paid FROM salary_obligation WHERE id = ?'
      ).get(payment.obligation_id);
      if (!obl || obl.employee_id !== payment.employee_id) {
        throw refusalError('OBLIGATION_NOT_FOUND', String(payment.obligation_id));
      }
      const newPaid = obl.salary_paid - salarySum;
      if (newPaid < 0) throw refusalError('OBLIGATION_RESTORE_INVALID', String(payment.obligation_id));
      const newStatus = newPaid >= obl.salary_earned ? 'PAID' : (newPaid > 0 ? 'PARTIAL' : 'OPEN');
      db.prepare(
        'UPDATE salary_obligation SET salary_paid = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
      ).run(newPaid, newStatus, obl.id);
    }

    const advancesRestored = [];
    for (const [advId, cents] of advRestore) {
      const adv = db.prepare(
        'SELECT id, employee_id, amount, remaining_balance, status FROM salary_advances WHERE id = ?'
      ).get(advId);
      if (!adv || adv.employee_id !== payment.employee_id) {
        throw refusalError('ADVANCE_RESTORE_INVALID', String(advId));
      }
      const restoreUnits = cents / 100;
      const newBal = Number(adv.remaining_balance) + restoreUnits;
      const amountUnits = Number(adv.amount);
      if (newBal < 0 || newBal - amountUnits > 1e-6) {
        throw refusalError('ADVANCE_RESTORE_INVALID', String(advId));
      }
      const newAdvStatus = newBal <= 0 ? 'Fully Repaid'
        : (newBal < amountUnits ? 'Partially Repaid' : 'Active');
      db.prepare('UPDATE salary_advances SET remaining_balance = ?, status = ? WHERE id = ?')
        .run(newBal, newAdvStatus, advId);
      advancesRestored.push({ advance_id: advId, cents, new_status: newAdvStatus });
    }

    const recovery = db.prepare(
      'SELECT id, amount, remaining_balance FROM salary_advances WHERE source_payment_id = ?'
    ).get(paymentId) || null;
    let recoveryDeleted = null;
    if (recovery) {
      const inUse = db.prepare(
        `SELECT COUNT(*) c FROM payment_component pc JOIN payment p ON p.id = pc.payment_id
         WHERE pc.advance_id = ? AND p.status IN ('DRAFT','FINALIZED')`
      ).get(recovery.id).c;
      if (inUse > 0) throw refusalError('RECOVERY_ADVANCE_IN_USE', String(recovery.id));
      const repaid = db.prepare(
        'SELECT COALESCE(SUM(CAST(ROUND(amount * 100) AS INTEGER)), 0) AS s FROM salary_advance_repayments WHERE advance_id = ?'
      ).get(recovery.id).s;
      const touched = repaid > 0 ||
        Math.round(Number(recovery.remaining_balance) * 100) < Math.round(Number(recovery.amount) * 100);
      if (touched) throw refusalError('RECOVERY_ADVANCE_MODIFIED', String(recovery.id));
      const del = db.prepare('DELETE FROM salary_advances WHERE id = ?').run(recovery.id);
      if (del.changes !== 1) throw refusalError('RECOVERY_ADVANCE_IN_USE', String(recovery.id));
      recoveryDeleted = recovery.id;
    }

    const upd = db.prepare(
      `UPDATE payment
       SET status = 'CORRECTED', corrected_count = corrected_count + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'FINALIZED'`
    ).run(paymentId);
    if (upd.changes !== 1) throw refusalError('PAYMENT_NOT_FINALIZED', 'status changed during correction');

    const after = db.prepare('SELECT corrected_count, payment_serial FROM payment WHERE id = ?').get(paymentId);

    audit(db, {
      payment_id: paymentId,
      action: 'CORRECT',
      entity: 'payment',
      entity_id: paymentId,
      field_name: 'status',
      old_value: 'FINALIZED',
      new_value: 'CORRECTED',
      reason: JSON.stringify({
        reason: reasonText,
        payment_serial: payment.payment_serial,
        obligation_id: payment.obligation_id,
        salary_restored_cents: salarySum,
        advances_restored: advancesRestored,
        recovery_advance_id: recoveryDeleted,
        corrected_count: after.corrected_count
      })
    }, actorId);

    db.exec('COMMIT');

    notify(db, 'hr_payment_corrected',
      'Payment ' + (payment.payment_serial || '#' + paymentId) + ' corrected (status CORRECTED)',
      paymentId, 'payment', p.actor_name || 'admin');

    return {
      ok: true,
      payment_id: paymentId,
      status: 'CORRECTED',
      corrected_count: after.corrected_count,
      salary_restored_cents: salarySum,
      advances_restored: advancesRestored,
      recovery_advance_id: recoveryDeleted
    };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
    const msg = String(err && err.message ? err.message : err);
    if (err && err.refusal) {
      return refused(db, 'payment', paymentId, err.refusal, err.detail, actorId);
    }
    return refused(db, 'payment', paymentId, extractAbortCode(msg) || 'INTERNAL', msg, actorId);
  }
}

function openDisputeTxn(db, params) {
  const p = params || {};
  const advanceId = Number(p.advance_id);
  const actorId = isInt(p.actor_id) && p.actor_id > 0 ? p.actor_id : 0;
  const reasonText = typeof p.reason === 'string' ? p.reason.trim() : '';

  if (!isInt(advanceId) || advanceId <= 0) {
    return refused(db, 'advance', null, 'ADVANCE_NOT_FOUND', String(p.advance_id), actorId);
  }
  if (!validReason(reasonText)) {
    return refused(db, 'advance', advanceId, 'REASON_REQUIRED', null, actorId);
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const adv = db.prepare(
      'SELECT id, employee_id, amount, remaining_balance, status, source_payment_id FROM salary_advances WHERE id = ?'
    ).get(advanceId);
    if (!adv) throw refusalError('ADVANCE_NOT_FOUND', String(advanceId));
    if (adv.source_payment_id !== null && adv.source_payment_id !== undefined) {
      throw refusalError('ADVANCE_NOT_DISPUTABLE', 'recovery');
    }
    if (DISPUTE_STATUSES.indexOf(adv.status) === -1) {
      throw refusalError('ADVANCE_NOT_DISPUTABLE', adv.status);
    }
    const upd = db.prepare(
      "UPDATE salary_advances SET status = 'Disputed' WHERE id = ? AND status = ?"
    ).run(advanceId, adv.status);
    if (upd.changes !== 1) throw refusalError('ADVANCE_NOT_DISPUTABLE', adv.status);

    audit(db, {
      payment_id: null,
      action: 'DISPUTE_OPENED',
      entity: 'advance',
      entity_id: advanceId,
      field_name: 'status',
      old_value: adv.status,
      new_value: 'Disputed',
      reason: JSON.stringify({
        reason: reasonText,
        employee_id: adv.employee_id,
        amount: adv.amount,
        remaining_balance: adv.remaining_balance
      })
    }, actorId);

    db.exec('COMMIT');

    notify(db, 'hr_advance_disputed',
      'Advance #' + advanceId + ' disputed', advanceId, 'advance', p.actor_name || 'admin');

    return { ok: true, advance_id: advanceId, status: 'Disputed', previous_status: adv.status };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
    const msg = String(err && err.message ? err.message : err);
    if (err && err.refusal) {
      return refused(db, 'advance', advanceId, err.refusal, err.detail, actorId);
    }
    return refused(db, 'advance', advanceId, extractAbortCode(msg) || 'INTERNAL', msg, actorId);
  }
}

function resolveDisputeTxn(db, params) {
  const p = params || {};
  const advanceId = Number(p.advance_id);
  const actorId = isInt(p.actor_id) && p.actor_id > 0 ? p.actor_id : 0;
  const reasonText = typeof p.reason === 'string' ? p.reason.trim() : '';

  if (!isInt(advanceId) || advanceId <= 0) {
    return refused(db, 'advance', null, 'ADVANCE_NOT_FOUND', String(p.advance_id), actorId);
  }
  if (!validReason(reasonText)) {
    return refused(db, 'advance', advanceId, 'REASON_REQUIRED', null, actorId);
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const adv = db.prepare(
      'SELECT id, employee_id, amount, remaining_balance, status FROM salary_advances WHERE id = ?'
    ).get(advanceId);
    if (!adv) throw refusalError('ADVANCE_NOT_FOUND', String(advanceId));
    if (adv.status !== 'Disputed') throw refusalError('ADVANCE_NOT_DISPUTED', adv.status);

    const bal = Number(adv.remaining_balance);
    const amountUnits = Number(adv.amount);
    const newStatus = bal <= 0 ? 'Fully Repaid'
      : (bal < amountUnits ? 'Partially Repaid' : 'Active');
    const upd = db.prepare(
      "UPDATE salary_advances SET status = ? WHERE id = ? AND status = 'Disputed'"
    ).run(newStatus, advanceId);
    if (upd.changes !== 1) throw refusalError('ADVANCE_NOT_DISPUTED', adv.status);

    audit(db, {
      payment_id: null,
      action: 'DISPUTE_RESOLVED',
      entity: 'advance',
      entity_id: advanceId,
      field_name: 'status',
      old_value: 'Disputed',
      new_value: newStatus,
      reason: JSON.stringify({
        reason: reasonText,
        employee_id: adv.employee_id,
        amount: adv.amount,
        remaining_balance: adv.remaining_balance,
        resolved_status: newStatus
      })
    }, actorId);

    db.exec('COMMIT');

    notify(db, 'hr_advance_dispute_resolved',
      'Advance #' + advanceId + ' dispute resolved', advanceId, 'advance', p.actor_name || 'admin');

    return { ok: true, advance_id: advanceId, status: newStatus, previous_status: 'Disputed' };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
    const msg = String(err && err.message ? err.message : err);
    if (err && err.refusal) {
      return refused(db, 'advance', advanceId, err.refusal, err.detail, actorId);
    }
    return refused(db, 'advance', advanceId, extractAbortCode(msg) || 'INTERNAL', msg, actorId);
  }
}

/* -------------------------------------------------------------- handlers */

function wantsJson(req) {
  return String(req.headers && req.headers.accept ? req.headers.accept : '').includes('application/json') ||
    (req.headers && req.headers['x-requested-with'] === 'XMLHttpRequest');
}

function refusalMessage(t, refusal) {
  const mapped = REFUSAL_T[refusal];
  const msg = t('hr.correction.' + (mapped || 'err_generic'));
  return mapped ? msg : msg + ': ' + refusal;
}

function sessionFlash(req, res, type, text) {
  if (req.session) req.session.message = { type, text };
}

function runHandler(req, res, core, entityId, backUrl, successKey, errBackUrl) {
  const actorId = Number(req.session && req.session.user_id);
  const actorName = (req.session && req.session.username) || 'admin';
  const params = Object.assign({}, req.body || {}, {
    actor_id: actorId,
    actor_name: actorName
  });
  params[entityId] = Number(req.params.id);
  if (req.body && req.body.context_employee_id) params.context_employee_id = Number(req.body.context_employee_id);

  let db;
  let result;
  try {
    db = openDb(false);
    result = core(db, params);
  } catch (err) {
    console.error('[paymentCorrection] handler error:', err && err.message);
    if (db) { try { db.close(); } catch (_) { /* ignore */ } }
    if (wantsJson(req)) return res.status(500).json({ ok: false, refusal: 'INTERNAL' });
    sessionFlash(req, res, 'error', res.locals.t('hr.correction.err_generic'));
    return res.redirect(errBackUrl || backUrl);
  }
  if (db) { try { db.close(); } catch (_) { /* ignore */ } }

  if (wantsJson(req)) {
    return result.ok ? res.json(result) : res.status(409).json(result);
  }
  if (result.ok) {
    sessionFlash(req, res, 'success', res.locals.t('hr.correction.' + successKey));
  } else {
    sessionFlash(req, res, 'error', refusalMessage(res.locals.t, result.refusal));
  }
  return res.redirect(result.ok ? backUrl : (errBackUrl || backUrl));
}

function correctPayment(req, res) {
  // Phase 5 — the correction form is inline on the payment history page (?edit=<id> deep-link):
  // success lands on the correction audit history; a refusal returns to the same
  // history row so the error flash shows next to the still-unsubmitted payment.
  return runHandler(req, res, correctPaymentTxn, 'payment_id',
    '/admin/hr/payment-corrections', 'success_correct',
    '/admin/hr/payroll/salary-history?edit=' + Number(req.params.id));
}

function disputeBackUrl(req) {
  const ctx = Number((req.body && req.body.context_employee_id) || (req.query && req.query.employee_id) || 0);
  return '/admin/hr/advances' + (isInt(ctx) && ctx > 0 ? '?employee_id=' + ctx : '');
}

function openDispute(req, res) {
  return runHandler(req, res, openDisputeTxn, 'advance_id', disputeBackUrl(req), 'success_dispute');
}

function resolveDispute(req, res) {
  return runHandler(req, res, resolveDisputeTxn, 'advance_id', disputeBackUrl(req), 'success_resolve');
}

module.exports = {
  correctPayment,
  openDispute,
  resolveDispute,
  _internals: {
    REFUSAL_T,
    DISPUTE_STATUSES,
    MIN_REASON,
    validReason,
    correctPaymentTxn,
    openDisputeTxn,
    resolveDisputeTxn,
    audit
  }
};
