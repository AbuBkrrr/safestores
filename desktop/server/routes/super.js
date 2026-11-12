const router = require('express').Router();
const ctrl = require('../controllers/storesController');
const billingCtrl = require('../controllers/billingController');
const notificationsCtrl = require('../controllers/notificationsController');
const settingsCtrl = require('../controllers/settingsController');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth, requireRole('super_admin'));

router.get('/stores', ctrl.listStores);
router.get('/activity', require('../controllers/accountController').listActivity);
router.get('/referrals', ctrl.listReferrals);
router.get('/users', ctrl.listAllUsers);
router.patch('/users/:id', ctrl.updateAnyUserStatus);
router.delete('/users/:id', ctrl.deleteAnyUser);
router.post('/stores', ctrl.createStore);
router.patch('/stores/:id', ctrl.updateStore);
router.patch('/stores/:id/activate', ctrl.activateStore);
router.patch('/stores/:id/suspend', ctrl.suspendStore);
router.delete('/stores/:id', ctrl.deleteStore);
router.patch('/stores/:id/billing', billingCtrl.updateBilling);

// Store size tiers (mini/midi/mega) and their limits
router.get('/tiers', ctrl.listPlans);
router.get('/plans', ctrl.listPlans); // legacy alias

router.get('/access-codes', ctrl.listCodes);
router.post('/access-codes', ctrl.generateCode);
router.patch('/access-codes/:id/revoke', ctrl.revokeCode);

// Billing automation
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

module.exports = router;
