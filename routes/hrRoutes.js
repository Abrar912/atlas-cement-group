const express = require('express');
const router = express.Router();
const hrController = require('../controllers/hrController');
const { requireAdmin } = require('../middleware/authMiddleware');
const { uploadEmployeePhoto, uploadEmployeeDocument, uploadEmployeeDocumentsMulti, uploadEmployeeAddCombined } = require('../middleware/upload');
const { csrfProtect } = require('../middleware/csrf');
const payrollPeriodController = require('../controllers/payrollPeriodController');
const paymentController = require('../controllers/paymentController');
const paymentCorrectionController = require('../controllers/paymentCorrectionController');
const paymentReportController = require('../controllers/paymentReportController');
const addSalaryController = require('../controllers/addSalaryController');
const salaryHistoryController = require('../controllers/salaryHistoryController');

// HR Dashboard
router.get('/admin/hr', requireAdmin, hrController.hrDashboard);

// Employees
router.get('/admin/hr/employees', requireAdmin, hrController.hrEmployees);
router.get('/admin/hr/employees/add', requireAdmin, hrController.hrAddEmployee);
router.post('/admin/hr/employees/add', requireAdmin, uploadEmployeeAddCombined, csrfProtect, hrController.hrAddEmployee);
router.get('/admin/hr/employees/:id/edit', requireAdmin, hrController.hrEditEmployee);
router.post('/admin/hr/employees/:id/edit', requireAdmin, uploadEmployeePhoto, csrfProtect, hrController.hrEditEmployee);
router.get('/admin/hr/employees/:id', requireAdmin, hrController.hrEmployeeProfile);
router.post('/admin/hr/employees/:id/delete', requireAdmin, hrController.hrDeleteEmployee);
router.get('/admin/hr/employees/:id/contract', requireAdmin, hrController.hrGenerateContract);

// Departments
router.get('/admin/hr/departments', requireAdmin, hrController.hrDepartments);
router.post('/admin/hr/departments', requireAdmin, hrController.hrDepartments);
router.post('/admin/hr/departments/:id/delete', requireAdmin, hrController.hrDeleteDepartment);

// Salary History
router.get('/admin/hr/employees/:id/salary-history', requireAdmin, hrController.hrSalaryHistory);
router.post('/admin/hr/employees/:id/salary-history', requireAdmin, hrController.hrSalaryHistory);

// Payroll
// Phase 20B: must be registered BEFORE GET /admin/hr/payroll/:id below
router.get('/admin/hr/payroll/obligations', requireAdmin, payrollPeriodController.listObligations);
// Phase 23: payment foundation status (read-only, requireAdmin, no state change)
router.get('/admin/hr/payments/foundation-status', requireAdmin, paymentController.foundationStatus);
router.get('/admin/hr/payroll', requireAdmin, hrController.hrPayroll);
router.post('/admin/hr/payroll/preview', requireAdmin, hrController.hrPreviewPayroll);
router.post('/admin/hr/payroll/create-selected', requireAdmin, hrController.hrCreateSelectedPayroll);
// HR-12: Add Salary shell (read-only preparation; must be BEFORE GET /admin/hr/payroll/:id)
router.get('/admin/hr/payroll/add-salary', requireAdmin, addSalaryController.addSalaryShell);
router.get('/admin/hr/payroll/add-salary/step2', requireAdmin, addSalaryController.addSalaryStep2);
router.get('/admin/hr/payroll/add-salary/step3', requireAdmin, addSalaryController.addSalaryStep3);
router.post('/admin/hr/payroll/add-salary/step3', requireAdmin, addSalaryController.addSalaryStep3Accept);
// Phase 4 — simple payment history (literal path BEFORE GET /admin/hr/payroll/:id)
router.get('/admin/hr/payroll/salary-history', requireAdmin, salaryHistoryController.salaryHistory);
router.get('/admin/hr/payroll/:id', requireAdmin, hrController.hrPayrollDetail);
router.post('/admin/hr/payroll/:id/mark-paid', requireAdmin, hrController.hrMarkPayrollPaid);

// Advances
router.get('/admin/hr/advances', requireAdmin, hrController.hrAdvances);
router.post('/admin/hr/advances', requireAdmin, hrController.hrAddAdvance);
router.post('/admin/hr/advances/:id/repay', requireAdmin, hrController.hrAdvanceRepayment);
// Phase 26 — advance dispute open/resolve (requireAdmin; global CSRF covers POST)
router.post('/admin/hr/advances/:id/dispute', requireAdmin, paymentCorrectionController.openDispute);
router.post('/admin/hr/advances/:id/dispute/resolve', requireAdmin, paymentCorrectionController.resolveDispute);

// Deductions
router.get('/admin/hr/deductions', requireAdmin, hrController.hrDeductions);
router.post('/admin/hr/deductions', requireAdmin, hrController.hrAddDeduction);

// Leave Management
router.get('/admin/hr/leave', requireAdmin, hrController.hrLeaveRequests);
router.post('/admin/hr/leave', requireAdmin, hrController.hrAddLeaveRequest);
router.post('/admin/hr/leave/:id/:action', requireAdmin, hrController.hrProcessLeaveRequest);
router.get('/admin/hr/leave-balances', requireAdmin, hrController.hrLeaveBalances);

// Leave Type Management
router.get('/admin/hr/leave-types', requireAdmin, hrController.hrLeaveTypes);
router.get('/admin/hr/leave-types/:id/edit', requireAdmin, hrController.hrEditLeaveType);
router.post('/admin/hr/leave-types/:id/edit', requireAdmin, hrController.hrUpdateLeaveType);
router.post('/admin/hr/leave-types/:id/toggle', requireAdmin, hrController.hrToggleLeaveType);

// Documents
router.get('/admin/hr/documents', requireAdmin, hrController.hrDocuments);
router.post('/admin/hr/documents', requireAdmin, hrController.hrAddDocument);

// Employee Document Infrastructure (C4.1)
router.post('/admin/hr/employees/:employeeId/documents', requireAdmin, uploadEmployeeDocument, csrfProtect, hrController.hrUploadDocument);
router.post('/admin/hr/employees/:employeeId/documents/:documentId/replace', requireAdmin, uploadEmployeeDocument, csrfProtect, hrController.hrReplaceDocument);
router.post('/admin/hr/employees/:employeeId/documents/:documentId/remove', requireAdmin, hrController.hrRemoveDocument);
router.get('/admin/hr/employees/:employeeId/documents/:documentId/view', requireAdmin, hrController.hrViewDocument);

// Attendance
router.get('/admin/hr/attendance', requireAdmin, hrController.hrAttendance);
router.post('/admin/hr/attendance', requireAdmin, hrController.hrAddAttendance);
router.post('/admin/hr/attendance/bulk', requireAdmin, hrController.hrBulkAttendance);
router.post('/admin/hr/attendance/mark-all-present', requireAdmin, hrController.hrMarkAllPresent);
router.post('/admin/hr/attendance/bulk-status', requireAdmin, hrController.hrBulkStatusApply);
router.get('/admin/hr/attendance/monthly-summary', requireAdmin, hrController.hrMonthlyAttendanceSummary);
router.get('/admin/hr/attendance/:id/edit', requireAdmin, hrController.hrEditAttendance);
router.post('/admin/hr/attendance/:id/edit', requireAdmin, hrController.hrUpdateAttendance);

// Work Schedules
router.get('/admin/hr/schedules', requireAdmin, hrController.hrWorkSchedules);
router.post('/admin/hr/schedules', requireAdmin, hrController.hrAddWorkSchedule);
router.get('/admin/hr/schedules/:id/edit', requireAdmin, hrController.hrEditWorkSchedule);
router.post('/admin/hr/schedules/:id/edit', requireAdmin, hrController.hrEditWorkSchedule);
router.post('/admin/hr/schedules/:id/delete', requireAdmin, hrController.hrDeleteWorkSchedule);

// Overtime
router.get('/admin/hr/overtime', requireAdmin, hrController.hrOvertime);
router.post('/admin/hr/overtime', requireAdmin, hrController.hrAddOvertime);
router.post('/admin/hr/overtime/:id/:action', requireAdmin, hrController.hrProcessOvertime);

// Disciplinary Records
router.get('/admin/hr/disciplinary', requireAdmin, hrController.hrDisciplinary);
router.post('/admin/hr/disciplinary', requireAdmin, hrController.hrAddDisciplinary);

// Performance Reviews
router.get('/admin/hr/performance', requireAdmin, hrController.hrPerformance);
router.post('/admin/hr/performance', requireAdmin, hrController.hrAddPerformance);

// Phase 20B — Salary Obligation period opening / correction (explicit, cutover 1405/07/01)
router.get('/admin/hr/payroll/periods/open', requireAdmin, payrollPeriodController.openForm);
router.post('/admin/hr/payroll/periods/open', requireAdmin, payrollPeriodController.openExecute);
router.post('/admin/hr/payroll/periods/correct', requireAdmin, payrollPeriodController.correctObligation);

// Phase 5 (Add Salary redesign) — old payment pages removed: list/create/detail/edit/finalize/delete
// and history-report. Only the PDF receipt survives (linked from the new payment history page).
router.get('/admin/hr/payments/:id/receipt', requireAdmin, paymentReportController.paymentReceipt);
// Phase 26 — payment correction FINALIZED -> CORRECTED (mandatory reason; requireAdmin; global CSRF)
// Phase 5 — no dedicated GET form page; the correction form is inline on the payment history page
router.post('/admin/hr/payment-correction/:id', requireAdmin, paymentCorrectionController.correctPayment);
// HR-16 — read-only payment correction history (owner-amended path: outside Phase 25C J2 /admin/hr/payments inventory)
router.get('/admin/hr/payment-corrections', requireAdmin, paymentReportController.correctionsHistory);

module.exports = router;
