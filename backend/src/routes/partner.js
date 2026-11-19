const router = require('express').Router();
const ctrl = require('../controllers/partnerController');
const { requireAuth, requireRole } = require('../middleware/auth');

router.get('/invite/:token', ctrl.getInvite);
router.post('/accept', ctrl.acceptInvite);

router.get('/guarantor', requireAuth, requireRole('guarantor'), ctrl.guarantorOverview);
router.patch('/guarantor/accounts/:id/verify', requireAuth, requireRole('guarantor'), ctrl.verifyMember);
router.post('/guarantor/orders/:id/report-payment', requireAuth, requireRole('guarantor'), ctrl.reportPayment);

router.get('/courier', requireAuth, requireRole('courier'), ctrl.courierJobs);
router.patch('/courier/jobs/:id/picked-up', requireAuth, requireRole('courier'), ctrl.pickedUp);
router.patch('/courier/jobs/:id/delivered', requireAuth, requireRole('courier'), ctrl.delivered);

module.exports = router;
