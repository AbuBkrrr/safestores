const router = require('express').Router();
const ctrl = require('../controllers/authController');

router.post('/super-admin/login', ctrl.superAdminLogin);
router.post('/store/signup', ctrl.storeSignup);
router.post('/admin/login', ctrl.adminLogin);
router.post('/invite/login', ctrl.inviteLogin);

module.exports = router;
