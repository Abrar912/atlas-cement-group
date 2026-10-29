'use strict';

/**
 * Salary payment history — the simple replacement for the old payment
 * history report (Phase 4 of the payment wizard redesign).
 *
 * Route: GET /admin/hr/payroll/salary-history (requireAdmin), registered
 * in routes/hrRoutes.js BEFORE GET /admin/hr/payroll/:id.
 *
 * Scope (deliberately minimal):
 *   1. GET only — read-only, no financial writes of any kind.
 *   2. Lists FINALIZED payments (newest first) with two filters:
 *      employee (dropdown) and period month ('YYYY/MM' text).
 *   3. Rows link to the existing printable receipt:
 *      /admin/hr/payments/:id/receipt
 *   4. The whole page is printable (filters/buttons hidden by CSS).
 *
 * HR12_DB_PATH — test-only redirection hook (production leaves it unset).
 */

const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { validateJalaliDate } = require('../middleware/i18n');

function resolveDbPath() {
  return process.env.HR12_DB_PATH || path.join(__dirname, '..', 'enterprise_cement.db');
}

function openReadOnlyDb() {
  const db = new DatabaseSync(resolveDbPath(), { readOnly: true });
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

/* 'YYYY/MM' (or normalized 'YYYY/MM/01') -> 'YYYY/MM/01'; anything else -> null. */
function normalizeMonthFilter(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  const m = /^(\d{4})\/(\d{1,2})$/.exec(s);
  const m2 = /^(\d{4})\/(\d{1,2})\/01$/.exec(s);
  const parts = m ? [Number(m[1]), Number(m[2])] : (m2 ? [Number(m2[1]), Number(m2[2])] : null);
  if (!parts || !validateJalaliDate(parts[0], parts[1], 1)) return null;
  const mm = String(parts[1]).padStart(2, '0');
  return parts[0] + '/' + mm + '/01';
}

function salaryHistory(req, res) {
  let db;
  try {
    // --- employee filter ---
    const rawEmp = req.query.employee_id;
    const emp = Number(rawEmp);
    const employeeFilter = (rawEmp !== '' && rawEmp !== null && rawEmp !== undefined &&
      Number.isInteger(emp) && emp > 0) ? emp : null;

    // --- month filter (invalid input bounces back with a flash) ---
    const rawMonth = typeof req.query.period_month === 'string' ? req.query.period_month.trim() : '';
    let monthFilter = null;
    if (rawMonth !== '') {
      monthFilter = normalizeMonthFilter(rawMonth);
      if (!monthFilter) {
        req.session.message = { type: 'error', text: res.locals.t('hr.salaryHistory.err_month_invalid') };
        return res.redirect('/admin/hr/payroll/salary-history');
      }
    }

    db = openReadOnlyDb();
    const where = ["status = 'FINALIZED'"];
    const args = [];
    if (employeeFilter !== null) { where.push('employee_id = ?'); args.push(employeeFilter); }
    if (monthFilter) { where.push('period_month = ?'); args.push(monthFilter); }

    // --- inline correction form deep-link (?edit=<payment id>) ---
    const rawEdit = typeof req.query.edit === 'string' ? req.query.edit.trim() : '';
    const editNum = Number(rawEdit);
    const editId = (rawEdit !== '' && Number.isInteger(editNum) && editNum > 0) ? editNum : null;

    const payments = db.prepare(
      `SELECT id, payment_serial, employee_name, department_name, period_month, payment_date,
              salary_total, overtime_total, advance_deduction_total, net_cash_paid,
              salary_remaining_after, payment_method, finalized_at
       FROM payment
       WHERE ${where.join(' AND ')}
       ORDER BY id DESC`
    ).all(...args);

    const employees = db.prepare(
      `SELECT id, full_name FROM hr_employees
       WHERE employment_status = 'Active' ORDER BY full_name ASC`
    ).all();

    return res.render('hr/payment-history', {
      payments: payments,
      employees: employees,
      filters: { employee_id: employeeFilter || '', period_month: rawMonth, edit: editId }
    });
  } catch (err) {
    console.error('[salaryHistory] error:', err);
    req.session.message = { type: 'error', text: res.locals.t('hr.salaryHistory.err_load') };
    return res.redirect('/admin/hr/payroll');
  } finally {
    if (db) { try { db.close(); } catch (e) { /* already closed */ } }
  }
}

module.exports = { salaryHistory };
