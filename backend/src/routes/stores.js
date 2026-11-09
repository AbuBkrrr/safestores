// ============================================================
// Per-store operational API.
//
// UPDATE: this was previously stripped down to only cross-party/cloud
// concerns under the assumption every store would run exclusively on the
// desktop app. That's not the only supported deployment anymore — a store
// can instead self-host backend/+frontend/ on its own LAN, with its own
// admin/manager/cashier/staff accounts logging in over the local network
// from any device's browser, offline-first the same way desktop is, and
// only needing real internet for the genuinely cloud-native things: going
// live on the public Marketplace, and syncing to Super Admin for billing
// and off-site backup. Real per-user JWT logins (requireAuth) now cover
// everything below except the device-to-device sync channel, matching
// desktop/server/routes/stores.js's own auth pattern — this file mirrors
// it route-for-route, backed by Postgres controllers instead of desktop's
// SQLite ones. Keep the two in sync when adding a new store-operational
// feature to either edition. (desktop's local-SQLite-file backups/restore
// routes have no equivalent here — a Postgres-backed deployment backs up
// at the database level, not a single portable file.)
// ============================================================

const router = require('express').Router({ mergeParams: true });
const { requireAuth, requireRole, scopeToOwnStore, requireActiveStore, requireStoreSyncKey, requireAuthOrStoreSyncKey, requireActiveEngagement } = require('../middleware/auth');
const { upload } = require('../middleware/upload');

const storesCtrl = require('../controllers/storesController');
const syncCtrl = require('../controllers/syncController');
const billingCtrl = require('../controllers/billingController');
const auditCtrl = require('../controllers/auditController');
const supportCtrl = require('../controllers/supportController');
const marketplaceCtrl = require('../controllers/marketplaceController');
const productsCtrl = require('../controllers/productsController');
const inventoryCtrl = require('../controllers/inventoryController');
const ordersCtrl = require('../controllers/ordersController');
const usersCtrl = require('../controllers/usersController');
const replenishmentCtrl = require('../controllers/replenishmentController');
const batchesCtrl = require('../controllers/batchesController');
const cycleCountCtrl = require('../controllers/cycleCountController');
const suppliersCtrl = require('../controllers/suppliersController');
const customersCtrl = require('../controllers/customersController');
const lendingCtrl = require('../controllers/lendingController');
const webhooksCtrl = require('../controllers/webhooksController');
const receiptsCtrl = require('../controllers/receiptsController');
const imagesCtrl = require('../controllers/imagesController');
const analyticsCtrl = require('../controllers/analyticsController');
const exportCtrl = require('../controllers/exportController');
const storeNotifCtrl = require('../controllers/storeNotificationsController');

// Device-to-device sync (LAN relay or cloud backup bridge) is the one
// thing here that's inherently NOT a specific logged-in user's action —
// it moves the whole store's data, so it stays authenticated by the
// store's shared sync_key (device trust) rather than a JWT.
router.get('/sync/export', requireStoreSyncKey, syncCtrl.exportChanges);
router.post('/sync/import', requireStoreSyncKey, syncCtrl.importChanges);

// Support tickets: reachable both directly from a browser (a web store
// admin/manager's own JWT) and via the desktop edition's proxy, which
// authenticates with the store's sync key instead — it has no per-admin
// JWT to forward to the cloud (see desktop/server/controllers/
// cloudProxyHelpers.js). Registered here, before the blanket requireAuth
// below, for the same reason the sync routes above are: that global
// middleware only accepts a JWT, and would reject the sync-key path
// before requireAuthOrStoreSyncKey ever got a chance to accept it.
router.get('/support/tickets', requireAuthOrStoreSyncKey('admin', 'manager'), supportCtrl.listMyTickets);
router.post('/support/tickets', requireAuthOrStoreSyncKey('admin', 'manager'), supportCtrl.createTicket);
router.get('/support/tickets/:id', requireAuthOrStoreSyncKey('admin', 'manager'), supportCtrl.getTicket);
router.post('/support/tickets/:id/reply', requireAuthOrStoreSyncKey('admin', 'manager'), supportCtrl.addReply);

// Audit engagements: same dual-mode reasoning as support tickets above —
// desktop's Auditor page (server/controllers/auditController.js) proxies
// both of these with the store's sync key, not a per-admin JWT. GET was
// previously reachable by any authenticated store role with no explicit
// restriction; that's preserved here by listing every store role rather
// than tightening it as a side effect of this fix.
router.get('/audit-engagements', requireAuthOrStoreSyncKey('admin', 'manager', 'staff', 'cashier', 'checkout'), auditCtrl.listStoreEngagements);
router.post('/audit-engagements', requireAuthOrStoreSyncKey('admin', 'manager'), auditCtrl.requestEngagement);

// Marketplace profile: same dual-mode reasoning as above. Notably, this
// GET is also what desktop's own setup wizard calls (with a bare sync
// key, no admin logged in yet) to validate a Store ID/Sync Key pair
// during initial cloud linking — with this route JWT-only, that
// validation step would reject every legitimately-paired key, blocking
// desktop's cloud-linking setup entirely, not just the marketplace
// listing management page.
router.get('/marketplace-profile', requireAuthOrStoreSyncKey('admin', 'manager'), storesCtrl.getMarketplaceProfile);
router.patch('/marketplace-profile', requireAuthOrStoreSyncKey('admin', 'manager'), storesCtrl.updateMarketplaceProfile);

// Marketplace order management — same dual-mode reasoning as above;
// desktop's marketplaceController.js proxies all three with the sync key.
router.get('/marketplace/orders', requireAuthOrStoreSyncKey('admin', 'manager'), marketplaceCtrl.listStoreOrders);
router.get('/marketplace/orders/:orderId', requireAuthOrStoreSyncKey('admin', 'manager'), marketplaceCtrl.getStoreOrder);
router.patch('/marketplace/orders/:orderId/fulfill', requireAuthOrStoreSyncKey('admin', 'manager'), marketplaceCtrl.fulfillOrder);

// Everything else on this router is a specific staff member's action
// (or, for the eleven routes above, either that or the store-as-a-whole
// acting through its desktop sync key).
router.use(requireAuth, scopeToOwnStore);

// Subscription activation — deliberately NOT behind requireActiveStore,
// since this is how a pending store's admin activates it in the first place.
router.post('/redeem-code', requireRole('admin'), storesCtrl.redeemCode);

// A store's public marketplace listing (category/address/city, opt-out
// toggle) — see routes/marketplace.js's listStores for where this shows up.
router.get('/loyalty-settings', requireRole('admin', 'manager'), storesCtrl.getLoyaltySettings);
router.patch('/loyalty-settings', requireRole('admin', 'manager'), storesCtrl.updateLoyaltySettings);

// Billing status/claim-payment must stay reachable even for a locked
// store, so its admin can see why, know what's owed, and claim payment.
router.get('/billing/status', billingCtrl.getBillingStatus);
router.post('/billing/claim-payment', requireRole('admin', 'manager'), billingCtrl.claimPayment);
// Online payment via Paystack — an alternative to the manual claim above,
// available only once a Super Admin has configured and enabled it (see
// initializeGatewayPayment's own check). Same locked-store exemption as
// claim-payment: a locked store's admin needs a way to pay, gateway or not.
router.post('/billing/charges/:chargeId/pay/initialize', requireRole('admin', 'manager'), billingCtrl.initializeGatewayPayment);
router.post('/billing/charges/:chargeId/pay/verify', requireRole('admin', 'manager'), billingCtrl.verifyGatewayPayment);

// In-app notifications (recount alerts, PO auto-generation, etc.) — also
// kept reachable regardless of lock state so a locked store's admin still
// sees why/what's going on.
router.get('/notifications', storeNotifCtrl.list);

// Store closure (data-protection erasure, 30-day grace) and the activity
// log stay reachable for a locked store too — an owner leaving because
// of billing must still be able to close their account and see history.
const accountCtrl = require('../controllers/accountController');
router.get('/deletion', requireRole('admin'), accountCtrl.getStoreDeletion);
router.post('/deletion', requireRole('admin'), accountCtrl.requestStoreDeletion);
router.delete('/deletion', requireRole('admin'), accountCtrl.cancelStoreDeletion);
router.get('/activity', requireRole('admin', 'manager'), accountCtrl.listActivity);

// Store settings (currency, time zone, tax, receipt text, till rules).
const storePaymentsCtrl = require('../controllers/storePaymentsController');
router.get('/payouts', requireRole('admin', 'manager'), storePaymentsCtrl.getPayouts);
router.get('/payouts/banks', requireRole('admin'), storePaymentsCtrl.listBanks);
router.post('/payouts/resolve', requireRole('admin'), storePaymentsCtrl.resolveAccount);
router.put('/payouts', requireRole('admin'), storePaymentsCtrl.connectPayouts);
router.patch('/payouts', requireRole('admin'), storePaymentsCtrl.updatePaymentOptions);
const storeSettingsCtrl = require('../controllers/storeSettingsController');
router.get('/settings', storeSettingsCtrl.getSettings);
router.patch('/settings', requireRole('admin'), storeSettingsCtrl.updateSettings);
router.patch('/notifications/:id/read', storeNotifCtrl.markRead);

// Everything below requires the store to actually be active (requireActiveStore
// also covers "not locked for non-payment" — see middleware/auth.js).
router.use(requireActiveStore);

// Staff & Invites — how a store admin/manager brings on cashiers/staff over the LAN.
router.get('/users', usersCtrl.listUsers);
router.delete('/users/:userId', requireRole('admin'), usersCtrl.removeUser);
router.patch('/users/:userId', requireRole('admin'), usersCtrl.updateUserStatus);
router.patch('/users/:userId/password', requireRole('admin'), usersCtrl.setUserPassword);
router.get('/invites', usersCtrl.listInvites);
router.post('/invites', requireRole('admin', 'manager'), usersCtrl.createInvite);
router.post('/invites/bulk', requireRole('admin', 'manager'), usersCtrl.createBulkInvites);
router.patch('/invites/:inviteId/revoke', requireRole('admin', 'manager'), usersCtrl.revokeInvite);

const onboardingCtrl = require('../controllers/onboardingController');
router.get('/onboarding', requireRole('admin', 'manager'), onboardingCtrl.status);
router.post('/onboarding/sample-data', requireRole('admin'), onboardingCtrl.loadSamples);
router.get('/products', productsCtrl.listProducts);
const stockToolsCtrl = require('../controllers/stockToolsController');
router.post('/products/import', requireRole('admin', 'manager'), stockToolsCtrl.importProducts);
router.get('/transfers', requireRole('admin', 'manager'), stockToolsCtrl.listTransfers);
router.get('/transfers/destinations', requireRole('admin', 'manager'), stockToolsCtrl.destinations);
router.post('/transfers', requireRole('admin', 'manager'), stockToolsCtrl.createTransfer);
router.post('/transfers/:transferId/receive', requireRole('admin', 'manager', 'staff'), stockToolsCtrl.receiveTransfer);
router.post('/transfers/:transferId/cancel', requireRole('admin', 'manager'), stockToolsCtrl.cancelTransfer);
router.post('/products', requireRole('admin', 'manager'), productsCtrl.createProduct);
router.put('/products/:productId', requireRole('admin', 'manager'), productsCtrl.updateProduct);
router.delete('/products/:productId', requireRole('admin'), productsCtrl.deleteProduct);
router.patch('/products/:productId/restore', requireRole('admin'), productsCtrl.restoreProduct);

// Smart Replenishment — reorder suggestions + purchase order lifecycle.
router.get('/replenishment/suggestions', requireRole('admin', 'manager'), replenishmentCtrl.getSuggestions);
router.get('/replenishment/purchase-orders', requireRole('admin', 'manager'), replenishmentCtrl.listPurchaseOrders);
router.post('/replenishment/purchase-orders', requireRole('admin', 'manager'), replenishmentCtrl.createPurchaseOrder);
router.patch('/replenishment/purchase-orders/:id/send', requireRole('admin', 'manager'), replenishmentCtrl.sendPurchaseOrder);
router.patch('/replenishment/purchase-orders/:id/cancel', requireRole('admin', 'manager'), replenishmentCtrl.cancelPurchaseOrder);
router.post('/replenishment/purchase-orders/:id/receive', requireRole('admin', 'manager', 'staff'), replenishmentCtrl.receivePurchaseOrder);

router.get('/arrivals', inventoryCtrl.listArrivals);
router.post('/arrivals', requireRole('admin', 'manager', 'staff'), inventoryCtrl.createArrival);

// Expiry & Batch Tracking.
router.get('/batches', requireRole('admin', 'manager'), batchesCtrl.listBatches);
router.get('/batches/expiring', requireRole('admin', 'manager'), batchesCtrl.listExpiringBatches);

// Cycle Counting & Inventory Accuracy
router.get('/cycle-counts/tasks', requireRole('admin', 'manager', 'staff'), cycleCountCtrl.listTasks);
router.post('/cycle-counts/tasks/:id/skip', requireRole('admin', 'manager'), cycleCountCtrl.skipTask);
router.post('/cycle-counts', requireRole('admin', 'manager', 'staff'), cycleCountCtrl.submitCount);
router.get('/cycle-counts/history', requireRole('admin', 'manager'), cycleCountCtrl.listHistory);
router.get('/cycle-counts/accuracy', requireRole('admin', 'manager'), cycleCountCtrl.getAccuracy);

// Online marketplace order management.

// Support tickets — talking to the Super Admin support queue.

// Auditor engagements (the admin-facing "Auditor" tab: request/view status
// of a match with an external auditor via the marketplace).

// Supplier Performance Analytics.
router.get('/suppliers/pricing-alerts', requireRole('admin', 'manager'), suppliersCtrl.listPricingAlerts);
router.get('/suppliers', requireRole('admin', 'manager'), suppliersCtrl.listSuppliers);
router.post('/suppliers', requireRole('admin', 'manager'), suppliersCtrl.createSupplier);
router.patch('/suppliers/:id', requireRole('admin', 'manager'), suppliersCtrl.updateSupplier);
router.delete('/suppliers/:id', requireRole('admin'), suppliersCtrl.deleteSupplier);
router.get('/suppliers/:id/performance', requireRole('admin', 'manager'), suppliersCtrl.getSupplierPerformance);

// Customer credit tracking — cashiers/managers can record sales and
// payments day-to-day; only admin can archive a customer record outright.
const loyaltyCtrl = require('../controllers/loyaltyController');
router.get('/customers/birthdays', requireRole('admin', 'manager', 'cashier', 'checkout'), loyaltyCtrl.upcomingBirthdays);
router.get('/customers', requireRole('admin', 'manager', 'cashier', 'checkout'), customersCtrl.listCustomers);
router.get('/customers/:customerId/points', requireRole('admin', 'manager', 'cashier', 'checkout'), loyaltyCtrl.getPoints);
router.post('/orders/:orderId/redeem-points', requireRole('admin', 'manager', 'cashier', 'checkout'), loyaltyCtrl.redeemPoints);
router.post('/orders/:orderId/customer', requireRole('admin', 'manager', 'cashier', 'checkout'), loyaltyCtrl.attachCustomer);
router.post('/customers', requireRole('admin', 'manager', 'cashier', 'checkout'), customersCtrl.createCustomer);
router.get('/customers/:customerId', requireRole('admin', 'manager', 'cashier', 'checkout'), customersCtrl.getCustomer);
router.patch('/customers/:customerId', requireRole('admin', 'manager'), customersCtrl.updateCustomer);
router.delete('/customers/:customerId', requireRole('admin'), customersCtrl.archiveCustomer);
router.post('/customers/:customerId/payments', requireRole('admin', 'manager', 'cashier'), customersCtrl.recordPayment);
router.post('/customers/:customerId/adjustments', requireRole('admin', 'manager'), customersCtrl.recordAdjustment);

// Lending partners — a store admin sees available partners and opts in/out
router.get('/lending-partners', requireRole('admin'), lendingCtrl.listAvailablePartners);
router.post('/lending-partners/:partnerId/consent', requireRole('admin'), lendingCtrl.grantConsent);
router.delete('/lending-partners/:partnerId/consent', requireRole('admin'), lendingCtrl.revokeConsent);

// Outbound integrations.
router.get('/webhooks', requireRole('admin'), webhooksCtrl.listWebhooks);
router.post('/webhooks', requireRole('admin'), webhooksCtrl.createWebhook);
router.patch('/webhooks/:id', requireRole('admin'), webhooksCtrl.updateWebhook);
router.delete('/webhooks/:id', requireRole('admin'), webhooksCtrl.deleteWebhook);
router.post('/webhooks/:id/test', requireRole('admin'), webhooksCtrl.testWebhook);

router.get('/movements', inventoryCtrl.listMovements);
router.post('/movements', requireRole('admin', 'manager', 'staff'), inventoryCtrl.createMovement);

// Shelf Audits — a standing feature for a store's own staff (and an
// engaged external 'auditor', matching desktop's role list exactly),
// not gated behind a separate engagement check on every call — the
// engagement itself is how an auditor got invited into the store at all.
router.get('/audits', inventoryCtrl.listAudits);
router.get('/audits/report', inventoryCtrl.auditReport);
router.post('/audits', requireRole('admin', 'manager', 'staff', 'auditor', 'stock_taker'), requireActiveEngagement, inventoryCtrl.createAudit);
router.get('/audits/conflicts', requireRole('admin', 'manager', 'staff', 'auditor', 'stock_taker'), inventoryCtrl.listConflicts);
router.post('/audits/conflicts/:groupId/accept', requireRole('admin', 'manager', 'staff', 'auditor', 'stock_taker'), requireActiveEngagement, inventoryCtrl.acceptRecount);

// Receipt scanning (OCR).
router.get('/receipts', receiptsCtrl.listReceipts);
router.post('/receipts', requireRole('admin', 'manager', 'staff'), upload.single('receipt'), receiptsCtrl.uploadReceipt);
router.post('/receipts/:receiptId/apply', requireRole('admin', 'manager'), receiptsCtrl.applyReceipt);
router.post('/receipts/:receiptId/reject', requireRole('admin', 'manager'), receiptsCtrl.rejectReceipt);

// Camera/gallery images + barcode-to-product lookup.
router.get('/images', imagesCtrl.listImages);
router.post('/images', requireRole('admin', 'manager', 'staff'), upload.single('photo'), imagesCtrl.uploadImage);
router.delete('/images/:imageId', requireRole('admin', 'manager'), imagesCtrl.deleteImage);
router.get('/barcode-lookup', imagesCtrl.barcodeLookup);

// Analytics dashboard.
router.get('/analytics/summary', analyticsCtrl.summary);
router.get('/analytics/stock-by-category', analyticsCtrl.stockByCategory);
router.get('/analytics/top-products', analyticsCtrl.topProducts);
router.get('/analytics/movement-trends', analyticsCtrl.movementTrends);
router.get('/analytics/low-stock-distribution', analyticsCtrl.lowStockDistribution);
router.get('/analytics/reorder-alerts', analyticsCtrl.reorderAlerts);
router.get('/analytics/expiring-soon', analyticsCtrl.expiringSoon);
router.get('/analytics/shrinkage', requireRole('admin', 'manager'), analyticsCtrl.shrinkageReport);
const insightsCtrl = require('../controllers/insightsController');
router.get('/insights/profit', requireRole('admin', 'manager'), insightsCtrl.profit);
router.get('/insights/abc', requireRole('admin', 'manager'), insightsCtrl.abc);
router.get('/insights/dead-stock', requireRole('admin', 'manager'), insightsCtrl.deadStock);
router.get('/insights/forecast', requireRole('admin', 'manager'), insightsCtrl.forecast);
router.get('/insights/heatmap', requireRole('admin', 'manager'), insightsCtrl.heatmap);

// Data export.
router.get('/export/csv', requireRole('admin'), exportCtrl.exportCsv);
// Also admin-only: the attached CSV includes cost_price per product, same
// sensitivity level as the plain CSV export above — not just the
// aggregated "Stock Value" figure Reports.jsx shows on screen.
router.post('/reports/email', requireRole('admin', 'manager'), exportCtrl.emailReport);
router.get('/export/json', requireRole('admin'), exportCtrl.exportJson);

// POS checkout — offline-capable the same way as everything above; the
// frontend's outbox (src/offline/) queues these the same way it queues
// arrivals/movements when the LAN or the browser drops.
router.post('/orders', requireRole('admin', 'manager', 'cashier', 'checkout'), ordersCtrl.createOrder);
router.get('/orders', requireRole('admin', 'manager', 'cashier', 'checkout'), ordersCtrl.listOrders);
router.get('/orders/:orderId', requireRole('admin', 'manager', 'cashier', 'checkout'), ordersCtrl.getOrder);
router.post('/orders/:orderId/items', requireRole('admin', 'manager', 'cashier', 'checkout'), ordersCtrl.addItem);
router.delete('/orders/:orderId/items/:itemId', requireRole('admin', 'manager', 'cashier', 'checkout'), ordersCtrl.removeItem);
router.post('/orders/:orderId/pay', requireRole('admin', 'manager', 'cashier'), ordersCtrl.payOrder);
router.post('/orders/:orderId/cancel', requireRole('admin', 'manager', 'cashier', 'checkout'), ordersCtrl.cancelOrder);
router.post('/orders/:orderId/discount', requireRole('admin', 'manager', 'cashier', 'checkout'), ordersCtrl.applyDiscount);
router.patch('/orders/:orderId/park', requireRole('admin', 'manager', 'cashier', 'checkout'), ordersCtrl.parkOrder);
router.post('/orders/:orderId/refunds', requireRole('admin', 'manager'), ordersCtrl.refundOrder);

// Cashier shifts + end-of-day reporting.
const shiftsCtrl = require('../controllers/shiftsController');
const TILL = ['admin', 'manager', 'cashier', 'checkout'];
router.get('/shifts/current', requireRole(...TILL), shiftsCtrl.currentShift);
router.get('/shifts', requireRole(...TILL), shiftsCtrl.listShifts);
router.post('/shifts', requireRole(...TILL), shiftsCtrl.openShift);
router.post('/shifts/:shiftId/close', requireRole(...TILL), shiftsCtrl.closeShift);
router.get('/shifts/:shiftId/report', requireRole(...TILL), shiftsCtrl.shiftReport);
router.get('/reports/daily', requireRole('admin', 'manager'), shiftsCtrl.dailyReport);

module.exports = router;
