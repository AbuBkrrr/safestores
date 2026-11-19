// Signed-in self-service for any account type (store user or super admin).
const router = require('express').Router();
const ctrl = require('../controllers/accountController');
const { requireAuth, requireRole } = require('../middleware/auth');

const PEOPLE = ['super_admin', 'admin', 'manager', 'staff', 'cashier', 'checkout', 'stock_taker', 'marketplace_manager', 'security', 'store_manager', 'shelf_manager'];
// A store's own audit staff (role 'auditor' + storeId) are store users too;
// independent auditor firms (no storeId) are not handled here.
const storeAuditor = (req, res, next) => (req.user?.role === 'auditor' && req.user.storeId ? next() : requireRole(...PEOPLE)(req, res, next));
router.use(requireAuth, storeAuditor);

router.get('/me', ctrl.me);
router.post('/password', ctrl.changePassword);
router.post('/logout-all', ctrl.logoutAll);
router.post('/email/resend', ctrl.resendVerification);
router.post('/2fa/setup', ctrl.setupTwoFactor);
router.post('/2fa/enable', ctrl.enableTwoFactor);
router.post('/2fa/disable', ctrl.disableTwoFactor);
router.get('/export', ctrl.exportMyData);
router.delete('/', ctrl.deleteMyAccount);

module.exports = router;
