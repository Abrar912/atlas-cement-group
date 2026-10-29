const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const cementStockController = require('../controllers/cementStockController');
const { requireRole, requireAdmin, checkPagePermission, requireUpdatePermission, requireDeletePermission } = require('../middleware/authMiddleware');
const { uploadProfilePicture, uploadHomepageMedia } = require('../middleware/upload');
const { csrfProtect } = require('../middleware/csrf');
const notificationSSE = require('../utils/notificationSSE');

// M7: dashboard embeds company-wide customers/totals server-side -> admin-only
router.get('/admin', requireAdmin, checkPagePermission, adminController.adminDashboard);
router.get('/admin/manage-users', requireAdmin, adminController.adminManageUsers);
router.post('/admin/manage-users/add', requireAdmin, uploadProfilePicture, csrfProtect, adminController.adminAddUser);
router.post('/admin/manage-users/update', requireAdmin, uploadProfilePicture, csrfProtect, adminController.adminUpdateUser);
// 12F: state-changing delete converted from GET to POST + CSRF.
router.post('/admin/manage-users/delete/:id', requireAdmin, csrfProtect, adminController.adminDeleteUser);
router.get('/admin/homepage-control', checkPagePermission, adminController.adminHomepageControl);
// M7: settings mutation (siblings below are all admin-only) -> admin-only
router.post('/admin/homepage-control', requireAdmin, checkPagePermission, adminController.adminHomepageControl);
router.post('/admin/homepage-control/media', requireAdmin, checkPagePermission, uploadHomepageMedia, csrfProtect, adminController.adminHomepageMediaUpload);
router.post('/admin/homepage-control/media/delete', requireAdmin, checkPagePermission, adminController.adminHomepageMediaDelete);
router.post('/admin/homepage-control/products', requireAdmin, checkPagePermission, adminController.adminHomepageProductCreate);
router.post('/admin/homepage-control/products/update', requireAdmin, checkPagePermission, adminController.adminHomepageProductUpdate);
router.post('/admin/homepage-control/products/delete', requireAdmin, checkPagePermission, adminController.adminHomepageProductDelete);
router.post('/admin/homepage-control/products/toggle', requireAdmin, checkPagePermission, adminController.adminHomepageProductToggle);
router.post('/admin/homepage-control/products/image', requireAdmin, checkPagePermission, uploadHomepageMedia, csrfProtect, adminController.adminHomepageProductImageUpload);
router.post('/admin/homepage-control/products/image/delete', requireAdmin, checkPagePermission, adminController.adminHomepageProductImageDelete);
router.get('/api/admin/agents', checkPagePermission, adminController.apiAdminAgents);
router.get('/api/admin/financial-metrics', checkPagePermission, adminController.apiFinancialMetrics);
// M7: admin ledger page (embeds worker/agency dropdown data) -> admin-only
router.get('/agent-remittances', requireAdmin, checkPagePermission, adminController.agentRemittances);
router.get('/admin/all-agency-expenses', checkPagePermission, adminController.adminAllAgencyExpenses);
router.get('/api/admin/agencies-list', checkPagePermission, adminController.apiAdminAgenciesList);
router.get('/api/admin/agency-users', checkPagePermission, adminController.apiAdminAgenciesList);
router.get('/api/admin/agency-expenses-summary', checkPagePermission, adminController.apiAdminAgencyExpensesSummary);
router.get('/api/admin/agency-expenses', checkPagePermission, adminController.apiAdminAgencyExpenses);
router.get('/admin/local-waybill', checkPagePermission, adminController.adminCreateWaybill);
router.post('/api/admin/save-waybill', checkPagePermission, adminController.apiAdminSaveWaybill);
router.get('/api/admin/next-waybill-serial', checkPagePermission, adminController.apiAdminNextWaybillSerial);
router.get('/api/admin/waybill-history', checkPagePermission, adminController.apiAdminWaybillHistory);
router.delete('/api/admin/waybill/:id', checkPagePermission, requireDeletePermission, adminController.apiAdminDeleteWaybill);
router.put('/api/admin/waybill/:id', checkPagePermission, requireUpdatePermission, adminController.apiAdminUpdateWaybill);
router.get('/waybills/new', checkPagePermission, adminController.waybillGenerator);
router.post('/api/waybills', checkPagePermission, adminController.apiSaveWaybill);
router.get('/api/config/cement-types', checkPagePermission, adminController.apiConfigCementTypes);
router.post('/api/config/cement-types', checkPagePermission, requireUpdatePermission, adminController.apiConfigCementTypes);
router.delete('/api/config/cement-types/:id', checkPagePermission, requireDeletePermission, adminController.apiConfigDeleteCementType);
router.get('/api/reports/cement-summary', checkPagePermission, adminController.apiCementSummaryReport);
router.get('/api/admin/customer-balances', checkPagePermission, requireAdmin, adminController.apiCustomerBalances);
router.get('/api/admin/tonnage-statistics', checkPagePermission, adminController.apiTonnageStatistics);
router.get('/api/admin/tonnage-years', checkPagePermission, adminController.apiTonnageYears);
router.get('/api/admin/cement-sales-distribution', checkPagePermission, adminController.apiCementSalesDistribution);
router.get('/api/admin/province-sales', checkPagePermission, adminController.apiProvinceSales);

// Quotation Requests Routes
router.get('/admin/quotation-requests', requireAdmin, adminController.adminQuotationRequests);
router.get('/api/admin/quotation-requests', checkPagePermission, adminController.apiAdminQuotationRequests);
router.get('/api/admin/quotation-requests/:id', checkPagePermission, adminController.apiAdminQuotationRequestDetails);
router.get('/api/admin/workers-list', checkPagePermission, adminController.apiAdminWorkersList);
router.post('/api/admin/quotation-requests/assign', checkPagePermission, requireUpdatePermission, adminController.apiAdminAssignQuotationRequest);

// Cement Stock / Inventory Routes
router.get('/admin/stock', requireAdmin, cementStockController.stockDashboard);
router.get('/admin/stock/add', requireAdmin, cementStockController.stockAddForm);
router.post('/admin/stock/add', requireAdmin, csrfProtect, cementStockController.stockAdd);

router.get('/admin/stock/summary', requireAdmin, cementStockController.stockSummaryPage);

// Notification Routes - Allow both admin and workers
router.get('/api/admin/notifications', (req, res, next) => {
    if (!req.session || (req.session.role !== 'admin' && req.session.role !== 'worker')) {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    // Disable caching for notification endpoint
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
}, adminController.apiAdminNotifications);

router.post('/api/admin/notifications/mark-read', (req, res, next) => {
    if (!req.session || (req.session.role !== 'admin' && req.session.role !== 'worker')) {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    next();
}, adminController.apiAdminMarkNotificationRead);

router.post('/api/admin/notifications/mark-all-read', (req, res, next) => {
    if (!req.session || (req.session.role !== 'admin' && req.session.role !== 'worker')) {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    next();
}, adminController.apiAdminMarkAllNotificationsRead);

router.post('/api/admin/notifications/clear-all', (req, res, next) => {
    if (!req.session || (req.session.role !== 'admin' && req.session.role !== 'worker')) {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    next();
}, adminController.apiAdminClearAllNotifications);

router.post('/api/admin/notifications/create', (req, res, next) => {
    if (!req.session || req.session.role !== 'admin') {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    next();
}, adminController.apiAdminCreateNotification);

// SSE Notification Stream Endpoint
router.get('/api/notifications/stream', (req, res) => {
    // Authentication check
    if (!req.session || !req.session.username || !req.session.role) {
        console.log('[SSE DEBUG] Connection rejected: no valid session');
        return res.status(401).end();
    }

    const sessionID = req.sessionID;
    const username = req.session.username;
    const role = req.session.role;

    console.log(`[SSE DEBUG] New connection request from ${username} (${role}), session: ${sessionID}`);

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

    // Send initial connection message
    const connectionMsg = { type: 'connected', username, role };
    console.log('[SSE DEBUG] Sending connection confirmation:', connectionMsg);
    res.write(`data: ${JSON.stringify(connectionMsg)}\n\n`);

    // Add connection to SSE manager
    const connectionId = notificationSSE.addConnection(sessionID, res, username, role);
    console.log(`[SSE DEBUG] Connection added with ID: ${connectionId}`);

    // Handle client disconnect
    req.on('close', () => {
        console.log(`[SSE DEBUG] Client disconnected: ${username} (${role}), session: ${sessionID}, conn: ${connectionId}`);
        notificationSSE.removeConnection(sessionID, res);
        clearInterval(sessionRevalidate);
    });

    req.on('end', () => {
        console.log(`[SSE DEBUG] Client ended: ${username} (${role}), session: ${sessionID}, conn: ${connectionId}`);
        notificationSSE.removeConnection(sessionID, res);
        clearInterval(sessionRevalidate);
    });

    // Re-validate the session store every minute so a logged-out / expired tab
    // stops receiving notification data even if its 'close' event never fired.
    const sessionRevalidate = setInterval(() => {
        if (res.writableEnded) {
            clearInterval(sessionRevalidate);
            return notificationSSE.removeConnection(sessionID, res);
        }
        req.sessionStore.get(req.sessionID, (err, sess) => {
            if (err || !sess) {
                clearInterval(sessionRevalidate);
                notificationSSE.removeConnection(sessionID, res);
                try { res.write('event: session-lost\ndata: {}\n\n'); } catch (e) { /* ignore */ }
                return res.end();
            }
        });
    }, 60 * 1000);
    if (typeof sessionRevalidate.unref === 'function') sessionRevalidate.unref();
});

module.exports = router;
