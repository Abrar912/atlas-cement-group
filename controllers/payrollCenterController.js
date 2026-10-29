'use strict';

const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const paymentController = require('./paymentController');
const { computeEmployeeBalances } = require('../utils/employeeBalanceService');

const ROOT = path.join(__dirname, '..');
const DEFAULT_DB_PATH = path.join(ROOT, 'enterprise_cement.db');

function resolveDbPath() {
  return process.env.HR13_DB_PATH ? path.resolve(process.env.HR13_DB_PATH) : DEFAULT_DB_PATH;
}

function buildCenterContext(db, opts) {
  const o = opts || {};
  const period = typeof o.period === 'string' ? o.period : '';
  const employeeId = (o.employeeId === undefined || o.employeeId === null) ? null : o.employeeId;
  const ownsConnection = !db;
  const center = {
    period: period,
    no_selection: employeeId === null,
    employee: null,
    obligations: [],
    payments: [],
    preview: null,
    balances: null,
    blockers: [],
    warnings: []
  };
  let conn = db || null;
  try {
    if (ownsConnection) {
      conn = new DatabaseSync(resolveDbPath(), { readOnly: true });
    }
    const internals = paymentController._internals;
    let oblSql = 'SELECT o.id, o.employee_id, e.full_name, o.earning_month, o.salary_earned, o.salary_paid, o.salary_remaining, o.status ' +
      'FROM salary_obligation o LEFT JOIN hr_employees e ON e.id = o.employee_id WHERE o.earning_month = ?';
    const oblArgs = [period];
    if (employeeId !== null) {
      oblSql += ' AND o.employee_id = ?';
      oblArgs.push(employeeId);
    }
    oblSql += ' ORDER BY o.id ASC';
    center.obligations = conn.prepare(oblSql).all(...oblArgs);
    const payFilters = { period_month: period };
    if (employeeId !== null) {
      payFilters.employee_id = employeeId;
    }
    center.payments = internals.queryPayments(conn, payFilters);
    if (employeeId !== null) {
      center.employee = conn.prepare(
        'SELECT e.id, e.full_name, e.employee_id, e.position, d.name AS department_name ' +
        'FROM hr_employees e LEFT JOIN departments d ON d.id = e.department_id WHERE e.id = ?'
      ).get(employeeId) || null;
      try {
        const run = internals.runEngine(conn, { employee_id: employeeId, period_month: period });
        center.preview = {
          engine: run.engine,
          obligation: conn.prepare(
            'SELECT id, employee_id, earning_month, salary_earned, salary_paid, salary_remaining, status ' +
            'FROM salary_obligation WHERE employee_id = ? AND earning_month = ?'
          ).get(employeeId, period) || null
        };
        center.blockers = Array.isArray(run.engine.blockers) ? run.engine.blockers.slice() : [];
        center.warnings = Array.isArray(run.engine.warnings) ? run.engine.warnings.slice() : [];
      } catch (e) {
        center.preview = null;
        center.blockers = [];
        center.warnings = [];
      }
      try {
        center.balances = computeEmployeeBalances(conn, employeeId);
      } catch (e) {
        center.balances = null;
      }
    }
    return center;
  } finally {
    if (ownsConnection && conn) {
      try { conn.close(); } catch (e) {}
    }
  }
}

module.exports = { buildCenterContext };
