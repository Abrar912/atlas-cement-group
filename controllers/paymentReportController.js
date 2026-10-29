'use strict';

/**
 * PHASE 28 — payment reporting controller (read-only).
 *
 * Exactly two authorized documents:
 *   1. historyReport  — GET /admin/hr/payments/history-report (Print-CSS document)
 *   2. paymentReceipt — GET /admin/hr/payments/:id/receipt    (PDFKit document)
 *
 * Both handlers are strictly read-only (openDb(true)). They never mutate any
 * table, never allocate, never finalize/correct/dispute, and are registered
 * GET-only with requireAdmin at the route layer (no CSRF on GET). All money
 * values are integer cents; formatting happens only at display time.
 *
 * Solar Hijri validation mirrors the frozen paymentController semantics
 * (validatePeriodMonth: regex + validateJalaliDate + cutover floor) with a
 * local read-only copy — paymentController itself is not imported or modified.
 */

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { getCurrentJalaliDate, validateJalaliDate, t: i18n } = require('../middleware/i18n');
const { computeEmployeeBalances } = require('../utils/employeeBalanceService');

const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'enterprise_cement.db');
const CUTOVER = '1405/07/01';
const ZERO_REASON_T = {
  NO_WORK_PERIOD: 'zr_no_work', ABSENCE_UNPAID: 'zr_absence', NEW_HIRE_NO_DUE: 'zr_new_hire',
  LEAVE_UNPAID: 'zr_leave', BANK_UNAVAILABLE: 'zr_bank', EMPLOYEE_ABSENT_PICKUP: 'zr_pickup',
  OTHER_APPROVED: 'zr_other'
};

function openDb(readOnly) {
  const db = readOnly ? new DatabaseSync(DB_PATH, { readOnly: true }) : new DatabaseSync(DB_PATH);
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

function isInt(v) {
  return typeof v === 'number' && Number.isSafeInteger(v);
}

/* Read-only local copy of the frozen paymentController period validation:
 * first-day Solar Hijri month, valid Jalali month, cutover floor. */
function validatePeriodMonth(raw) {
  if (typeof raw !== 'string' || !/^\d{4}\/\d{2}\/01$/.test(raw)) return false;
  const parts = raw.split('/').map(Number);
  if (!validateJalaliDate(parts[0], parts[1], 1)) return false;
  return raw >= CUTOVER;
}

function money(cents) {
  return (Number(cents) / 100).toFixed(2);
}

function flashError(req, res, key) {
  req.session.message = { type: 'error', text: res.locals.t(key) };
  return res.redirect('/admin/hr/payroll/salary-history');
}

/* Period options: cutover .. max(current Jalali month, latest payment period). */
function buildPeriodOptions(db) {
  let last = String(getCurrentJalaliDate()).slice(0, 7) + '/01';
  if (last < CUTOVER) last = CUTOVER;
  const maxRow = db.prepare('SELECT MAX(period_month) AS m FROM payment').get();
  if (maxRow && maxRow.m && typeof maxRow.m === 'string' && maxRow.m > last) last = maxRow.m;
  const out = [];
  let y = Number(CUTOVER.slice(0, 4));
  let m = Number(CUTOVER.slice(5, 7));
  const ly = Number(last.slice(0, 4));
  const lm = Number(last.slice(5, 7));
  let guard = 0;
  while ((y < ly || (y === ly && m <= lm)) && guard < 600) {
    out.push(String(y).padStart(4, '0') + '/' + String(m).padStart(2, '0') + '/01');
    m += 1;
    if (m > 12) { m = 1; y += 1; }
    guard += 1;
  }
  if (out.length === 0) out.push(CUTOVER);
  return out;
}

/* ---------------------------------------------------------------------------
 * HR-27 — live G3 balance presentation helpers (read-only, display-only).
 *
 * Sole authority for current owed figures: utils/employeeBalanceService
 * (computeEmployeeBalances). Figure contract: { code, state, value_cents, ... }
 * with states VERIFIED_AMOUNT | VALID_ZERO | UNAVAILABLE | BLOCKED | DIVERGENT.
 *
 * reportFigureCents — accepts a figure only in a verified state
 *   (VERIFIED_AMOUNT / VALID_ZERO, the owner-approved "VALID" family);
 *   any failure state, malformed figure, or missing figure yields null and the
 *   view renders an em dash. Never infers, repairs, or substitutes a value.
 *
 * liveReportTotals — company_cents = salary_outstanding + ot_eligible_remaining
 *   when BOTH figures are verified (approved workspace balance-total semantics);
 *   employee_cents = advance_owed when that figure is verified.
 *   The two directions are returned separately and are NEVER netted.
 *   Snapshot columns (remaining-after etc.) are never derived from these.
 * ------------------------------------------------------------------------- */
function reportFigureCents(fig) {
  if (!fig || typeof fig !== 'object') return null;
  if (fig.state !== 'VERIFIED_AMOUNT' && fig.state !== 'VALID_ZERO') return null;
  const n = Number(fig.value_cents);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function liveReportTotals(bal) {
  const empty = { company_cents: null, employee_cents: null };
  if (!bal || typeof bal !== 'object' || !bal.company_owed || !bal.employee_owed) return empty;
  const salary = reportFigureCents(bal.company_owed.salary_outstanding);
  const ot = reportFigureCents(bal.company_owed.ot_eligible_remaining);
  const advance = reportFigureCents(bal.employee_owed.advance_owed);
  return {
    company_cents: salary !== null && ot !== null ? salary + ot : null,
    employee_cents: advance
  };
}

/* ---------------------------------------------------------------------------
 * Document 1 — Payment History & Summary (Print-CSS view, read-only)
 * ------------------------------------------------------------------------- */
function historyReport(req, res) {
  let db;
  try {
    db = openDb(true);
    const periodOptions = buildPeriodOptions(db);
    const defaultTo = periodOptions[periodOptions.length - 1];

    const rawFrom = req.query.from === undefined || req.query.from === '' ? CUTOVER : String(req.query.from);
    const rawTo = req.query.to === undefined || req.query.to === '' ? defaultTo : String(req.query.to);
    const rawEmp = req.query.employee_id === undefined || req.query.employee_id === '' ? '' : String(req.query.employee_id);
    const rawStatus = req.query.status === undefined || req.query.status === '' ? '' : String(req.query.status);
    const rawDept = req.query.department === undefined || req.query.department === '' ? '' : String(req.query.department);

    if (!validatePeriodMonth(rawFrom) || !validatePeriodMonth(rawTo) || rawFrom > rawTo) {
      return res.status(400).send(res.locals.t('hr.payment_report.err_bad_period'));
    }

    let employeeId = null;
    if (rawEmp !== '') {
      const n = Number(rawEmp);
      if (!isInt(n) || n <= 0) {
        return res.status(400).send(res.locals.t('hr.payment_report.err_bad_employee'));
      }
      const inEmployees = db.prepare('SELECT 1 AS x FROM hr_employees WHERE id = ?').get(n);
      const inPayments = db.prepare(
        "SELECT 1 AS x FROM payment WHERE employee_id = ? AND status IN ('FINALIZED','CORRECTED') LIMIT 1"
      ).get(n);
      if (!inEmployees && !inPayments) {
        return res.status(400).send(res.locals.t('hr.payment_report.err_bad_employee'));
      }
      employeeId = n;
    }

    if (rawStatus !== '' && rawStatus !== 'FINALIZED' && rawStatus !== 'CORRECTED') {
      return res.status(400).send(res.locals.t('hr.payment_report.err_bad_status'));
    }

    let department = null;
    if (rawDept !== '') {
      const dept = db.prepare(
        "SELECT 1 AS x FROM payment WHERE department_name = ? AND status IN ('FINALIZED','CORRECTED') LIMIT 1"
      ).get(rawDept);
      if (!dept) {
        return res.status(400).send(res.locals.t('hr.payment_report.err_bad_department'));
      }
      department = rawDept;
    }

    const where = ['p.period_month >= ?', 'p.period_month <= ?'];
    const args = [rawFrom, rawTo];
    if (rawStatus === '') {
      where.push("p.status IN ('FINALIZED','CORRECTED')");
    } else {
      where.push('p.status = ?');
      args.push(rawStatus);
    }
    if (employeeId !== null) { where.push('p.employee_id = ?'); args.push(employeeId); }
    if (department !== null) { where.push('p.department_name = ?'); args.push(department); }

    const rows = db.prepare(
      `SELECT p.*, e.employee_id AS employee_code
       FROM payment p
       LEFT JOIN hr_employees e ON e.id = p.employee_id
       WHERE ${where.join(' AND ')}
       ORDER BY p.employee_name COLLATE NOCASE ASC, p.period_month ASC, p.id ASC`
    ).all(...args);

    const groups = [];
    const byKey = new Map();
    for (const r of rows) {
      let g = byKey.get(r.employee_id);
      if (!g) {
        g = {
          employee_id: r.employee_id,
          employee_name: r.employee_name,
          employee_code: r.employee_code,
          department_name: r.department_name,
          position: r.position,
          rows: [],
          paid_count: 0,
          voided_count: 0,
          salary_cents: 0,
          overtime_cents: 0,
          additional_cents: 0,
          advance_cents: 0,
          net_cents: 0
        };
        byKey.set(r.employee_id, g);
        groups.push(g);
      }
      g.rows.push(r);
      if (r.status === 'FINALIZED') {
        g.paid_count += 1;
        g.salary_cents += Number(r.salary_total);
        g.overtime_cents += Number(r.overtime_total);
        g.additional_cents += Number(r.additional_total);
        g.advance_cents += Number(r.advance_deduction_total);
        g.net_cents += Number(r.net_cash_paid);
      } else {
        g.voided_count += 1;
      }
    }

    /* HR-27 — attach live G3 balances to each report group (presentation-only).
     * Authoritative source: computeEmployeeBalances (read-only). A failed or
     * blocked G3 call never breaks the report: totals fall back to null and the
     * view renders an em dash. */
    for (const g of groups) {
      try {
        g.live = liveReportTotals(computeEmployeeBalances(db, g.employee_id));
      } catch (e) {
        g.live = { company_cents: null, employee_cents: null };
      }
    }

    const grand = {
      paid_count: 0, voided_count: 0,
      salary_cents: 0, overtime_cents: 0, additional_cents: 0, advance_cents: 0, net_cents: 0
    };
    for (const g of groups) {
      grand.paid_count += g.paid_count;
      grand.voided_count += g.voided_count;
      grand.salary_cents += g.salary_cents;
      grand.overtime_cents += g.overtime_cents;
      grand.additional_cents += g.additional_cents;
      grand.advance_cents += g.advance_cents;
      grand.net_cents += g.net_cents;
    }

    const employeeOptions = db.prepare(
      "SELECT DISTINCT employee_id AS id, employee_name AS name FROM payment WHERE employee_name <> '' AND status IN ('FINALIZED','CORRECTED') ORDER BY employee_name COLLATE NOCASE ASC"
    ).all();
    const departmentOptions = db.prepare(
      "SELECT DISTINCT department_name AS name FROM payment WHERE department_name <> '' AND status IN ('FINALIZED','CORRECTED') ORDER BY department_name COLLATE NOCASE ASC"
    ).all();

    return res.render('hr/payment-history-report', {
      filters: { from: rawFrom, to: rawTo, employee_id: rawEmp, status: rawStatus, department: rawDept },
      periodOptions,
      employeeOptions,
      departmentOptions,
      groups,
      grand,
      rowCount: rows.length,
      generated: getCurrentJalaliDate(),
      money
    });
  } catch (err) {
    console.error('[paymentReport] history report error:', err);
    return flashError(req, res, 'hr.payments.err_generic');
  } finally {
    if (db) { try { db.close(); } catch (e) { /* ignore */ } }
  }
}

/* ---------------------------------------------------------------------------
 * Document 2 — Employee Payment Receipt / Acceptance (PDFKit, read-only)
 * ------------------------------------------------------------------------- */
function paymentReceipt(req, res) {
  const lang = req.query.lang || 'en';
  if (!['en', 'da', 'ps'].includes(lang)) {
    return res.status(400).send('Unsupported language. Use en, da, or ps.');
  }
  const id = Number(req.params.id);
  if (!isInt(id) || id <= 0) {
    return flashError(req, res, 'hr.payments.err_not_found');
  }
  let db;
  try {
    db = openDb(true);
    const payment = db.prepare('SELECT * FROM payment WHERE id = ?').get(id);
    if (!payment) {
      return flashError(req, res, 'hr.payments.err_not_found');
    }
    if (payment.status !== 'FINALIZED') {
      return flashError(req, res, 'hr.payment_report.err_receipt_ineligible');
    }
    const emp = db.prepare('SELECT employee_id AS code FROM hr_employees WHERE id = ?').get(payment.employee_id);
    const components = db.prepare(
      `SELECT * FROM payment_component WHERE payment_id = ?
       ORDER BY CASE type WHEN 'SALARY' THEN 0 WHEN 'OVERTIME' THEN 1 WHEN 'ADDITIONAL' THEN 2 ELSE 3 END, seq, id`
    ).all(id);
    renderReceiptPdf(res, lang, payment, emp ? emp.code : null, components);
  } catch (err) {
    console.error('[paymentReport] receipt error:', err);
    return flashError(req, res, 'hr.payments.err_generic');
  } finally {
    if (db) { try { db.close(); } catch (e) { /* ignore */ } }
  }
}

function renderReceiptPdf(res, lang, payment, employeeCode, components) {
  const PDFDocument = require('pdfkit');
  const todayJalali = getCurrentJalaliDate();
  const isRTL = (lang === 'da' || lang === 'ps');
  const fontRegular = isRTL ? 'C:/Windows/Fonts/tahoma.ttf' : 'Helvetica';
  const fontBold = isRTL ? 'C:/Windows/Fonts/tahomabd.ttf' : 'Helvetica-Bold';

  const serialOk = typeof payment.payment_serial === 'string' && /^PAY-\d{4}-\d{6}$/.test(payment.payment_serial);
  const filename = serialOk ? payment.payment_serial : ('payment_' + payment.id);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '.pdf"');

  const doc = new PDFDocument({ size: 'A4', margin: 60 });
  doc.pipe(res);
  doc.registerFont('ReceiptFont', fontRegular);
  doc.registerFont('ReceiptFontBold', fontBold);
  doc.font('ReceiptFont');

  const contentL = 60;
  const contentR = doc.page.width - 60;
  const pageW = contentR - contentL;
  const labelColW = 170;
  const valueColW = 235;
  const amountColW = 170;

  function tr(key) { return i18n(lang, 'hr.payment_report.' + key) || key; }
  function tp(ns, key) { return i18n(lang, ns + '.' + key) || key; }
  function labelX() { return isRTL ? (contentR - labelColW) : contentL; }
  function valueX() { return isRTL ? contentL : (contentL + labelColW + 10); }
  function alignSide() { return isRTL ? 'right' : 'left'; }
  function amountX() { return isRTL ? contentL : (contentR - amountColW); }
  function amountAlign() { return isRTL ? 'left' : 'right'; }
  function infoLabelW() { return isRTL ? (contentR - labelX()) : (valueX() - labelX() - 10); }
  function moneyLabelW() { return isRTL ? (contentR - labelX()) : (amountX() - labelX() - 5); }

  let y = 40;
  const logoPath = path.join(ROOT, 'public', 'Logo.png');
  if (fs.existsSync(logoPath)) {
    doc.image(logoPath, 60 + (pageW - 56) / 2, y, { width: 56, height: 56 });
    y += 66;
  }
  doc.font('ReceiptFontBold').fontSize(15).text(tp('hr.contract', 'company_name'), 60, y, { align: 'center', width: pageW });
  y = doc.y + 4;
  doc.fontSize(18).text(tr('receipt_title'), 60, y, { align: 'center', width: pageW });
  y = doc.y + 8;
  doc.moveTo(60, y).lineTo(60 + pageW, y).stroke();
  y += 14;

  function sectionHeader(text) {
    doc.font('ReceiptFontBold').fontSize(12).text(text, 60, y, { align: alignSide(), width: pageW });
    y = doc.y + 6;
  }
  function infoRow(label, value) {
    doc.font('ReceiptFont').fontSize(10);
    doc.text(label + ':', labelX(), y, { width: infoLabelW(), align: alignSide() });
    const afterLabel = doc.y;
    doc.text(String(value || ''), valueX(), y, { width: valueColW, align: alignSide() });
    y = Math.max(afterLabel, doc.y) + 4;
  }
  function moneyRow(label, valueCents, bold) {
    doc.font(bold ? 'ReceiptFontBold' : 'ReceiptFont').fontSize(10);
    doc.text(label, labelX(), y, { width: moneyLabelW(), align: alignSide() });
    const afterLabel = doc.y;
    doc.text(money(valueCents) + ' ' + tp('hr.contract', 'currency'), amountX(), y, { width: amountColW, align: amountAlign() });
    y = Math.max(afterLabel, doc.y) + 4;
  }

  sectionHeader(tp('hr.contract', 'section_employee_info'));
  infoRow(tp('hr.contract', 'full_name'), payment.employee_name);
  infoRow(tp('hr.contract', 'employee_id'), employeeCode || String(payment.employee_id));
  infoRow(tp('hr.contract', 'department'), payment.department_name);
  infoRow(tp('hr.contract', 'position'), payment.position);

  y += 6;
  sectionHeader(tr('sec_info'));
  infoRow(tp('hr.payments', 'col_period'), payment.period_month);
  infoRow(tp('hr.payments', 'col_date'), payment.payment_date);
  infoRow(tp('hr.payments', 'col_serial'), payment.payment_serial || ('#' + payment.id));
  const methodKey = payment.payment_method === 'BANK' ? 'method_bank' : payment.payment_method === 'OTHER' ? 'method_other' : 'method_cash';
  infoRow(tp('hr.payments', 'form_method'), tp('hr.payments', methodKey));
  if (payment.payment_reference) {
    infoRow(tp('hr.payments', 'form_reference'), payment.payment_reference);
  }

  y += 6;
  sectionHeader(tr('sec_breakdown'));
  moneyRow(tp('hr.payments', 't_salary'), payment.salary_total, false);
  moneyRow(tp('hr.payments', 't_overtime'), payment.overtime_total, false);
  moneyRow(tp('hr.payments', 't_additional'), payment.additional_total, false);
  moneyRow(tp('hr.payments', 't_entered'), payment.earnings_total, false);
  moneyRow(tp('hr.payments', 't_advance'), payment.advance_deduction_total, false);
  moneyRow(tp('hr.payments', 't_net'), payment.net_cash_paid, true);

  if (payment.zero_reason_code) {
    const zrKey = ZERO_REASON_T[payment.zero_reason_code] || null;
    doc.font('ReceiptFont').fontSize(9.5);
    let zrText = tp('hr.payments', 'zero_reason_label') + ': ' + (zrKey ? tp('hr.payments', zrKey) : payment.zero_reason_code);
    if (payment.zero_reason_note) zrText += ' — ' + payment.zero_reason_note;
    doc.text(zrText, 60, y, { width: pageW, align: alignSide() });
    y = doc.y + 4;
  }

  if (components && components.length > 0) {
    y += 6;
    sectionHeader(tp('hr.payments', 'components_title'));
    for (const c of components) {
      doc.font('ReceiptFont').fontSize(9.5);
      const typeLabel = tp('hr.payments', 'type_' + String(c.type).toLowerCase());
      const line = typeLabel + (c.target_month ? ' (' + c.target_month + ')' : '') + ' — ' + money(c.amount) + ' ' + tp('hr.contract', 'currency');
      doc.text(line, labelX(), y, { width: moneyLabelW(), align: alignSide() });
      const afterLine = doc.y;
      doc.text(money(c.amount) + ' ' + tp('hr.contract', 'currency'), amountX(), y, { width: amountColW, align: amountAlign() });
      y = Math.max(afterLine, doc.y) + 3;
    }
  }

  y += 10;
  doc.font('ReceiptFontBold').fontSize(10).text(tr('acceptance'), 60, y, { width: pageW, align: alignSide() });
  y = doc.y + 22;

  doc.moveTo(60, y).lineTo(60 + pageW, y).stroke();
  y += 12;
  doc.font('ReceiptFontBold').fontSize(11).text(tp('hr.contract', 'signatures'), 60, y, { align: 'center', width: pageW });
  y = doc.y + 18;

  function signatureBlock(x, heading, nameValue) {
    let sy = y;
    doc.font('ReceiptFontBold').fontSize(10).text(heading, x, sy, { width: 180, align: alignSide() });
    sy = doc.y + 4;
    doc.font('ReceiptFont').fontSize(9.5);
    doc.text(tr('sig_name') + ': ' + nameValue, x, sy, { width: 180, align: alignSide() });
    sy = doc.y + 4;
    doc.text(tr('sig_signature') + ':', x, sy, { width: 180, align: alignSide() });
    const sigBottom = doc.y;
    doc.moveTo(x, sigBottom + 3).lineTo(x + 180, sigBottom + 3).stroke();
    doc.text(tp('hr.contract', 'date_line'), x, sigBottom + 12, { width: 180, align: alignSide() });
    return doc.y;
  }
  const sigEnd = Math.max(
    signatureBlock(70, tp('hr.contract', 'employee_label'), payment.employee_name),
    signatureBlock(350, tp('hr.contract', 'hr_representative'), tp('hr.contract', 'hr_name'))
  );
  y = sigEnd + 14;

  doc.moveTo(60, y).lineTo(60 + pageW, y).stroke();
  y += 8;
  doc.font('ReceiptFont').fontSize(8)
    .text(tp('hr.contract', 'footer_generated').replace('{date}', todayJalali), 60, y, { align: 'center', width: pageW });

  doc.end();
}

module.exports = { historyReport, paymentReceipt };

/* HR-16 - Payment Correction History (read-only, SELECT-only; append-only)
 *
 * Chronological read of the existing payment_audit authority, optionally joined
 * to payment for serial/employee/period context. Opens the database read-only
 * (openDb(true)); contains no data-modifying SQL and performs no financial
 * calculation or mutation. Empty state is handled by the view.
 */
function correctionsHistory(req, res) {
  let db;
  try {
    db = openDb(true);
    const rows = db.prepare(
      `SELECT a.id, a.payment_id, a.action, a.entity, a.entity_id, a.field_name,
              a.old_value, a.new_value, a.reason, a.actor_id, a.created_at,
              p.payment_serial, p.employee_name, p.period_month, p.status
       FROM payment_audit a
       LEFT JOIN payment p ON p.id = a.payment_id
       ORDER BY a.created_at DESC, a.id DESC`
    ).all();
    return res.render('hr/payment-corrections', {
      rows,
      rowCount: rows.length,
      generated: getCurrentJalaliDate()
    });
  } catch (err) {
    console.error('[paymentReport] correction history error:', err);
    return flashError(req, res, 'hr.payments.err_generic');
  } finally {
    if (db) { try { db.close(); } catch (e) { /* ignore */ } }
  }
}

module.exports.correctionsHistory = correctionsHistory;

/* HR-27 — display-mapping helpers exported for the focused test suite only;
 * request handlers above are unchanged in authority and behaviour. */
module.exports.reportFigureCents = reportFigureCents;
module.exports.liveReportTotals = liveReportTotals;
