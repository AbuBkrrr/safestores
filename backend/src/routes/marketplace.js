const router = require('express').Router({ mergeParams: true });
const ctrl = require('../controllers/marketplaceController');
const { requireAuth, optionalAuth, requireRole } = require('../middleware/auth');

// Online payment for an order — public, identified by the order's
// unguessable tracking token (what the shopper's link/redirect carries).
const storePaymentsCtrl = require('../controllers/storePaymentsController');
router.post('/orders/:token/pay', storePaymentsCtrl.startOrderPayment);
router.post('/orders/:token/verify', storePaymentsCtrl.verifyOrderPayment);

// A shop can be addressed by its custom slug as well as its id.
router.param('storeId', require('../utils/shopSlug').shopParam);

// Public — a shopper can browse without an account
router.get('/stores', ctrl.listStores);
router.get('/search-products', ctrl.searchProducts);
router.get('/:storeId/products', ctrl.browseProducts);
router.post('/:storeId/signup', ctrl.customerSignup);
router.post('/:storeId/login', ctrl.customerLogin);

// Guest-or-authenticated: an account is optional at checkout — see
// placeOrder's guest-contact-details path.
router.post('/:storeId/orders', optionalAuth, ctrl.placeOrder);

// Customer-authenticated only — order history needs an account to attach to.
router.get('/:storeId/my-orders', requireAuth, requireRole('customer'), ctrl.listMyOrders);

// Guaranteed credit — guarantors are public, the account is the logged-in customer's.
const creditCtrl = require('../controllers/creditController');
router.get('/:storeId/credit', optionalAuth, creditCtrl.myCredit);
router.post('/:storeId/credit/apply', requireAuth, requireRole('customer'), creditCtrl.applyForCredit);

module.exports = router;
