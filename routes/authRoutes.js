const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const adminController = require('../controllers/adminController');
const { setLanguage } = require('../middleware/i18n');
const { csrfProtect } = require('../middleware/csrf');
const { redirectBack } = require('../middleware/safeRedirect');
const rateLimiter = require('../middleware/rateLimiter');

router.get('/login', authController.login);
router.post('/login', authController.login);
// 12F/12D: logout is POST-only (state-changing GET removed).
router.post('/logout', csrfProtect, authController.logout);
router.get('/', authController.customerHome);
router.get('/login-portal', authController.loginPortalView);
router.get('/catalog', authController.customerCatalogView);

// Language switcher route
router.post('/set-language', (req, res) => {
    const { lang } = req.body;
    const selectedLang = setLanguage(req, res, lang);

    // Redirect back to the referring page with query parameters preserved
    // (same-origin only — Referer is attacker-controllable, never an open redirect)
    redirectBack(req, res, '/');
});

// Forgot Password routes
router.get('/forgot-password', authController.forgotPassword);
router.post('/forgot-password', rateLimiter.forgotLimit, authController.forgotPasswordSubmit);
router.get('/reset-password', authController.resetPassword);
router.post('/reset-password', rateLimiter.resetLimit, authController.resetPasswordSubmit);

// Public API endpoints (no authentication required)
router.get('/api/public/cement-types', adminController.apiPublicCementTypes);
// CSRF-exempt public form: spam/abuse is mitigated by the IP rate limit here.
router.post('/api/quotation-requests', rateLimiter.quotationLimit, authController.submitQuotationRequest);

// Public customer website pages (redesigned 4-page site)
router.get('/products', authController.customerProducts);
router.get('/about', authController.customerAbout);
router.get('/quote', authController.customerQuote);

module.exports = router;
