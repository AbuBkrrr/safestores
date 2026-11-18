const router = require('express').Router();
const ctrl = require('../controllers/authController');
const auditCtrl = require('../controllers/auditController');

router.post('/super-admin/login', ctrl.superAdminLogin);
router.post('/store/signup', ctrl.storeSignup);
router.post('/admin/login', ctrl.adminLogin);
router.post('/invite/login', ctrl.inviteLogin);

const accountCtrl = require('../controllers/accountController');
router.post('/password/forgot', accountCtrl.forgotPassword);
router.post('/password/reset', accountCtrl.resetPassword);
router.post('/email/verify', accountCtrl.verifyEmail);

router.post('/auditor/signup', auditCtrl.auditorSignup);
router.post('/auditor/login', auditCtrl.auditorLogin);

module.exports = router;
