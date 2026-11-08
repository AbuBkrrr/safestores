const router = require('express').Router();
const ctrl = require('../controllers/auditController');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth, requireRole('auditor'));

router.get('/engagements', ctrl.listAuditorEngagements);
router.patch('/engagements/:id/accept', ctrl.acceptEngagement);
router.patch('/engagements/:id/complete', ctrl.completeEngagement);
router.post('/engagements/:id/invites', ctrl.inviteStockTaker);

module.exports = router;
