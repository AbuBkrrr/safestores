// Signed-in self-service (desktop). See controllers/accountController.js.
const router = require('express').Router();
const ctrl = require('../controllers/accountController');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth, requireRole('super_admin', 'admin', 'manager', 'staff', 'cashier', 'checkout', 'stock_taker'));
router.get('/me', ctrl.me);
router.post('/password', ctrl.changePassword);
router.post('/logout-all', ctrl.logoutAll);
router.get('/export', ctrl.exportMyData);

module.exports = router;
