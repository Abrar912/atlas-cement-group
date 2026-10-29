const express = require('express');
const router = express.Router();
const recoveryController = require('../controllers/recoveryController');
const { requireAdmin, requireRole } = require('../middleware/authMiddleware');
const rateLimiter = require('../middleware/rateLimiter');

// Public recovery routes
router.get('/recovery', recoveryController.showAccountRecovery);
router.get('/recovery/user', recoveryController.showUserRecovery);
router.get('/recovery/user/request', recoveryController.showUserResetRequest);
router.get('/recovery/admin', recoveryController.showAdminRecovery);
router.get('/recovery/admin/long-key', recoveryController.showAdminLongKey);
router.get('/recovery/admin/code', recoveryController.showAdminCode);
router.get('/recovery/reset-password', recoveryController.showPasswordReset);
router.get('/recovery/success', recoveryController.showPasswordResetSuccess);
router.get('/recovery/download-pdf', rateLimiter.pdfDownloadLimit, recoveryController.downloadSuccessPagePDF);

// Authenticated recovery key download (for notifications)
router.get('/api/recovery/download-key/:keyId', rateLimiter.pdfDownloadLimit, recoveryController.downloadRecoveryKeyPDF);

// Recovery submission routes (existing 5/15min username limits remain inside controller)
router.post('/recovery/user/verify-key', rateLimiter.recoveryVerifyLimit, recoveryController.verifyUserRecoveryKey);
router.post('/recovery/admin/verify-code', rateLimiter.recoveryVerifyLimit, recoveryController.verifyAdminRecoveryCode);
router.post('/recovery/admin/verify-long-key', rateLimiter.recoveryVerifyLimit, recoveryController.verifyAdminLongKey);
router.post('/recovery/reset-password', rateLimiter.recoveryResetLimit, recoveryController.submitPasswordReset);
router.post('/recovery/user/request', rateLimiter.recoveryVerifyLimit, recoveryController.submitRecoveryRequest);

// Admin recovery management routes (require admin)
router.post('/api/admin/recovery/generate-user-key/:userId', requireAdmin, recoveryController.adminGenerateUserRecoveryKey);
router.post('/api/admin/recovery/generate-admin-codes/:userId', requireAdmin, recoveryController.adminGenerateAdminRecoveryCodes);
router.post('/api/admin/recovery/generate-admin-long-key/:userId', requireAdmin, recoveryController.adminGenerateAdminLongKey);
router.get('/api/admin/recovery/download-pdf/:userId/:type', requireAdmin, rateLimiter.pdfDownloadLimit, recoveryController.adminDownloadRecoveryPDF);
router.post('/api/admin/recovery/approve-request/:requestId', requireAdmin, recoveryController.adminApproveRecoveryRequest);
router.post('/api/admin/recovery/reject-request/:requestId', requireAdmin, recoveryController.adminRejectRecoveryRequest);
router.post('/api/admin/recovery/set-password', requireAdmin, recoveryController.adminSetUserPassword);
router.get('/api/admin/recovery/password-reset-requests', requireAdmin, recoveryController.adminGetPasswordResetRequests);
router.get('/api/admin/recovery/status/:userId', requireAdmin, recoveryController.getUserRecoveryStatus);

// Worker recovery key routes (require worker)
router.get('/api/worker/recovery/my-key', requireRole('worker'), recoveryController.workerGetMyRecoveryKey);
router.get('/api/worker/recovery/download-pdf', requireRole('worker'), rateLimiter.pdfDownloadLimit, recoveryController.workerDownloadMyRecoveryPDF);

module.exports = router;
