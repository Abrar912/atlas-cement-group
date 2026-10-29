const express = require('express');
const router = express.Router();
const workerController = require('../controllers/workerController');
const { requireRole } = require('../middleware/authMiddleware');
const { csrfProtect } = require('../middleware/csrf');
// H3/H4: write-side ownership guards (customers.created_by / waybill selled_to_agent)
const ownership = require('../middleware/ownership');

router.get('/worker', requireRole('worker'), workerController.workerSalesView);
router.post('/worker/add-sales-batch', requireRole('worker'), ownership.verifySalesBatchOwnership, workerController.workerAddSalesBatch);
router.get('/worker/money-receipts', requireRole('worker'), workerController.workerReceiptsView);
router.post('/worker/add-receipts-batch', requireRole('worker'), ownership.verifySalesBatchOwnership, workerController.workerAddReceiptsBatch);
router.get('/worker/manage-customers', requireRole('worker'), workerController.workerManageCustomers);
router.post('/worker/manage-customers', requireRole('worker'), workerController.workerManageCustomers);
router.post('/worker/edit-customer/:id', requireRole('worker'), workerController.workerEditCustomer);
// 12F: state-changing delete converted from GET to POST + CSRF.
router.post('/worker/delete-customer/:id', requireRole('worker'), csrfProtect, workerController.workerDeleteCustomer);
router.get('/worker/command-deck', requireRole('worker'), workerController.workerCommandDeck);
router.get('/worker/agent-remittances', requireRole('worker'), workerController.workerAgentRemittances);
router.get('/worker/daily-expenses', requireRole('worker'), workerController.workerDailyExpenses);
router.post('/worker/add-expense', requireRole('worker'), workerController.workerAddExpense);
router.post('/worker/add-expenses-batch', requireRole('worker'), workerController.workerAddExpensesBatch);
router.get('/api/agency/customers', requireRole('worker'), workerController.apiAgencyCustomers);
router.get('/api/worker/financial-metrics', requireRole('worker'), workerController.apiWorkerFinancialMetrics);
router.get('/api/worker/agent-log-submissions', requireRole('worker'), workerController.apiWorkerAgentLogSubmissions);
router.get('/api/worker/remittance-ledger', requireRole('worker'), workerController.apiWorkerRemittanceLedger);
router.get('/api/worker/expenses', requireRole('worker'), workerController.apiWorkerExpenses);
router.get('/api/worker/expenses-summary', requireRole('worker'), workerController.apiWorkerExpensesSummary);
router.get('/api/worker/incoming-waybills', requireRole('worker'), workerController.apiWorkerIncomingWaybills);
router.get('/api/worker/waiting-queue', requireRole('worker'), workerController.apiWorkerWaitingQueue);
router.post('/api/worker/commit-waybill-sales-batch', requireRole('worker'), ownership.verifyWaybillSalesBatchOwnership, workerController.apiWorkerCommitWaybillSalesBatch);
router.post('/api/worker/sell-waybill-direct', requireRole('worker'), ownership.verifySellDirectOwnership, workerController.apiWorkerSellWaybillDirect);
router.post('/api/worker/mark-waybill-in-queue', requireRole('worker'), ownership.verifyWaybillOwnership, workerController.apiWorkerMarkWaybillInQueue);
router.post('/api/worker/mark-waybill-available', requireRole('worker'), ownership.verifyWaybillOwnership, workerController.apiWorkerMarkWaybillAvailable);
router.get('/api/worker/cement-summary', requireRole('worker'), workerController.apiWorkerCementSummaryReport);
router.get('/api/worker/customer-balances', requireRole('worker'), workerController.apiWorkerCustomerBalances);
router.get('/api/worker/customer-financial-summary', requireRole('worker'), workerController.apiWorkerCustomerFinancialSummary);

// Quotation Requests Routes
router.get('/worker/quotation-requests', requireRole('worker'), workerController.workerQuotationRequests);
router.get('/api/worker/quotation-requests', requireRole('worker'), workerController.apiWorkerQuotationRequests);
router.get('/api/worker/quotation-requests/:id', requireRole('worker'), workerController.apiWorkerQuotationRequestDetails);
router.post('/api/worker/quotation-requests/update-status', requireRole('worker'), workerController.apiWorkerUpdateQuotationRequestStatus);

module.exports = router;
