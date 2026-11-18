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

// KYC documents live in memory → database (never the public uploads folder).
const kycUpload = require('multer')({
  storage: require('multer').memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 6 },
  fileFilter: (req, file, cb) => (/^(image\/(jpeg|png|webp)|application\/pdf)$/.test(file.mimetype) ? cb(null, true) : cb(new Error('Documents must be JPG, PNG, WEBP or PDF'))),
}).fields([{ name: 'idDocument', maxCount: 1 }, { name: 'certificate', maxCount: 1 }, { name: 'businessReg', maxCount: 1 }, { name: 'other', maxCount: 3 }]);
const kycUploadMw = (req, res, next) => kycUpload(req, res, (err) => (err ? res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Each document must be 5 MB or smaller' : err.message }) : next()));
router.post('/auditor/signup', kycUploadMw, auditCtrl.auditorSignup);
router.post('/auditor/login', auditCtrl.auditorLogin);
router.post('/partner/login', require('../controllers/partnerController').partnerLogin);

module.exports = router;
