const express = require('express');
const router = express.Router();
const reportController = require('../controllers/reportController');
const { requireLogin } = require('../middleware/authMiddleware');

router.get('/api/reports/daily-sales-report', requireLogin, reportController.apiDailySalesReport);
router.get('/api/reports/customer-details', requireLogin, reportController.apiCustomerDetails);
router.get('/api/reports/agent-log-submissions', requireLogin, reportController.apiAgentLogSubmissions);
router.get('/api/reports/remittance-ledger', requireLogin, reportController.apiRemittanceLedger);
router.get('/api/reports/customer-balances', requireLogin, reportController.apiCustomerBalances);
router.get('/api/reports/customer-financial-summary', requireLogin, reportController.apiCustomerFinancialSummary);
router.put('/api/reports/agent-log/:id', requireLogin, reportController.apiUpdateAgentLogRow);
router.delete('/api/reports/agent-log/:id', requireLogin, reportController.apiDeleteAgentLogRow);

module.exports = router;
