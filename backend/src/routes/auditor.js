const router = require('express').Router();
const ctrl = require('../controllers/auditController');
const { requireAuth, requireRole } = require('../middleware/auth');

// Independent auditor firms only — a store's own audit staff also carry
// role 'auditor' but have a storeId, and belong in the store app instead.
router.use(requireAuth, requireRole('auditor'), (req, res, next) => (req.user.storeId ? res.status(403).json({ error: 'Insufficient permissions' }) : next()));

router.get('/engagements', ctrl.listAuditorEngagements);
router.patch('/engagements/:id/accept', ctrl.acceptEngagement);
router.patch('/engagements/:id/decline', ctrl.declineEngagement);
router.patch('/engagements/:id/complete', ctrl.completeEngagement);
router.post('/engagements/:id/invites', ctrl.inviteStockTaker);

module.exports = router;
