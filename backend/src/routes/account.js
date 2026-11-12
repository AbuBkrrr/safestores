// Signed-in self-service for any account type (store user or super admin).
const router = require('express').Router();
const ctrl = require('../controllers/accountController');
const { requireAuth, requireRole } = require('../middleware/auth');

const PEOPLE = ['super_admin', 'admin', 'manager', 'staff', 'cashier', 'checkout', 'stock_taker'];
router.use(requireAuth, requireRole(...PEOPLE));

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
