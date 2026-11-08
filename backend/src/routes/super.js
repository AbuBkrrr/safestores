const router = require('express').Router();
const ctrl = require('../controllers/storesController');
const billingCtrl = require('../controllers/billingController');
const auditCtrl = require('../controllers/auditController');
const notificationsCtrl = require('../controllers/notificationsController');
const settingsCtrl = require('../controllers/settingsController');
const supportCtrl = require('../controllers/supportController');
const lendingCtrl = require('../controllers/lendingController');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth, requireRole('super_admin'));

router.get('/stores', ctrl.listStores);
router.get('/referrals', ctrl.listReferrals);
router.post('/stores', ctrl.createStore);
router.patch('/stores/:id', ctrl.updateStore);
router.get('/users', ctrl.listAllUsers);
router.patch('/users/:id', ctrl.updateAnyUserStatus);
router.delete('/users/:id', ctrl.deleteAnyUser);
router.patch('/stores/:id/activate', ctrl.activateStore);
router.patch('/stores/:id/suspend', ctrl.suspendStore);
router.patch('/stores/:id/billing', billingCtrl.updateBilling);
router.delete('/stores/:id', ctrl.deleteStore);

// Store size tiers (mini/midi/mega) and their limits
router.get('/tiers', ctrl.listPlans);

router.get('/access-codes', ctrl.listCodes);
router.post('/access-codes', ctrl.generateCode);
router.patch('/access-codes/:id/revoke', ctrl.revokeCode);

// Billing
router.get('/billing-charges', billingCtrl.listCharges);
router.patch('/billing-charges/:id/mark-paid', billingCtrl.markPaid);
router.patch('/billing-charges/:id/waive', billingCtrl.waiveCharge);
router.patch('/payment-settings', billingCtrl.updatePaymentSettings);
router.patch('/currency', settingsCtrl.updateCurrency);

// Notifications (payment claims, overdue warnings, lockouts)
router.get('/notifications', notificationsCtrl.listNotifications);
router.get('/notifications/unread-count', notificationsCtrl.unreadCount);
router.patch('/notifications/:id/dismiss', notificationsCtrl.dismissNotification);
router.patch('/notifications/dismiss-all', notificationsCtrl.dismissAll);

// Support tickets — shared queue across every store
router.get('/support/tickets', supportCtrl.listAllTicketsSuper);
router.get('/support/tickets/:id', supportCtrl.getTicketSuper);
router.patch('/support/tickets/:id', supportCtrl.updateTicketStatusSuper);
router.post('/support/tickets/:id/reply', supportCtrl.addReplySuper);

// Auditor marketplace
router.get('/auditors', auditCtrl.listAuditors);
router.patch('/auditors/:id/activate', auditCtrl.activateAuditor);
router.patch('/auditors/:id/suspend', auditCtrl.suspendAuditor);

// Lending / microfinance partners
router.get('/lending-partners', lendingCtrl.listPartners);
router.post('/lending-partners', lendingCtrl.createPartner);
router.patch('/lending-partners/:id', lendingCtrl.updatePartnerStatus);
router.post('/lending-partners/:id/regenerate-key', lendingCtrl.regenerateApiKey);

module.exports = router;
