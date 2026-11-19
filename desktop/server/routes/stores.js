const router = require('express').Router({ mergeParams: true });
const { requireAuth, requireRole, scopeToOwnStore, requireActiveStore, requireNotLocked, requireStoreSyncKey } = require('../middleware/auth');
const { upload } = require('../middleware/upload');

const usersCtrl = require('../controllers/usersController');
const productsCtrl = require('../controllers/productsController');
const inventoryCtrl = require('../controllers/inventoryController');
const receiptsCtrl = require('../controllers/receiptsController');
const imagesCtrl = require('../controllers/imagesController');
const analyticsCtrl = require('../controllers/analyticsController');
const exportCtrl = require('../controllers/exportController');
const storesCtrl = require('../controllers/storesController');
const syncCtrl = require('../controllers/syncController');
const ordersCtrl = require('../controllers/ordersController');
const billingCtrl = require('../controllers/billingController');
const storeNotifCtrl = require('../controllers/storeNotificationsController');
const replenishmentCtrl = require('../controllers/replenishmentController');
const batchesCtrl = require('../controllers/batchesController');
const cycleCountCtrl = require('../controllers/cycleCountController');
const marketplaceCtrl = require('../controllers/marketplaceController');
const supportCtrl = require('../controllers/supportController');
const auditCtrl = require('../controllers/auditController');
const suppliersCtrl = require('../controllers/suppliersController');
const webhooksCtrl = require('../controllers/webhooksController');
const customersCtrl = require('../controllers/customersController');

// Device-to-device sync (LAN relay or cloud bridge) — see backend's
// routes/stores.js for the full rationale.
router.get('/sync/export', requireStoreSyncKey, syncCtrl.exportChanges);
router.post('/sync/import', requireStoreSyncKey, syncCtrl.importChanges);

router.use(requireAuth, scopeToOwnStore);

// Online-only screens (credit, couriers, payouts, branding, transfers...) run
// in the cloud under the signed-in person's own login; everything else below
// is handled right here, with or without internet.
router.use(require('../controllers/cloudPassthroughController').cloudPassthrough);

// Subscription activation (store admin redeems a code they received) —
// deliberately NOT behind requireActiveStore, since this is how a pending
// store's admin activates it in the first place.
router.post('/redeem-code', requireRole('admin'), storesCtrl.redeemCode);

// Activity log — reachable even while locked (see cloud routes/stores.js).
router.get('/activity', requireRole('admin', 'manager'), require('../controllers/accountController').listActivity);

// Everything below requires the store to actually be active.
router.use(requireActiveStore);

// Billing status/claim-payment must stay reachable even while locked — a
// locked store needs to be able to see what's owed and claim payment.
router.get('/billing/status', billingCtrl.getBillingStatus);
router.post('/billing/claim-payment', requireRole('admin', 'manager'), billingCtrl.claimPayment);

// Backups must stay reachable even while locked too — a billing dispute
// shouldn't also hold an owner's own data hostage. See backupController.js.
const backupCtrl = require('../controllers/backupController');
router.get('/backups', requireRole('admin'), backupCtrl.list);
router.post('/backups/run', requireRole('admin'), backupCtrl.runNow);
router.post('/backups/:name/save-to', requireRole('admin'), backupCtrl.saveTo);
router.post('/backups/restore', requireRole('admin'), backupCtrl.restore);

// Everything below requires the store to also not be locked for non-payment.
router.use(requireNotLocked);

router.get('/notifications', storeNotifCtrl.list);
router.patch('/notifications/:id/read', storeNotifCtrl.markRead);

router.get('/users', usersCtrl.listUsers);
router.delete('/users/:userId', requireRole('admin'), usersCtrl.removeUser);
router.patch('/users/:userId', requireRole('admin'), usersCtrl.updateUserStatus);
router.patch('/users/:userId/password', requireRole('admin'), usersCtrl.setUserPassword);

router.get('/invites', usersCtrl.listInvites);
router.post('/invites', requireRole('admin', 'manager'), usersCtrl.createInvite);
router.post('/invites/bulk', requireRole('admin', 'manager'), usersCtrl.createBulkInvites);
router.patch('/invites/:inviteId/revoke', requireRole('admin', 'manager'), usersCtrl.revokeInvite);

router.get('/products', productsCtrl.listProducts);
router.post('/products', requireRole('admin', 'manager'), productsCtrl.createProduct);
router.put('/products/:productId', requireRole('admin', 'manager'), productsCtrl.updateProduct);
router.delete('/products/:productId', requireRole('admin'), productsCtrl.deleteProduct);
router.patch('/products/:productId/restore', requireRole('admin'), productsCtrl.restoreProduct);

// Smart Replenishment
router.get('/replenishment/suggestions', requireRole('admin', 'manager'), replenishmentCtrl.getSuggestions);
router.get('/replenishment/purchase-orders', requireRole('admin', 'manager'), replenishmentCtrl.listPurchaseOrders);
router.post('/replenishment/purchase-orders', requireRole('admin', 'manager'), replenishmentCtrl.createPurchaseOrder);
router.patch('/replenishment/purchase-orders/:id/send', requireRole('admin', 'manager'), replenishmentCtrl.sendPurchaseOrder);
router.patch('/replenishment/purchase-orders/:id/cancel', requireRole('admin', 'manager'), replenishmentCtrl.cancelPurchaseOrder);
router.post('/replenishment/purchase-orders/:id/receive', requireRole('admin', 'manager', 'staff', 'store_manager'), replenishmentCtrl.receivePurchaseOrder);

router.get('/arrivals', inventoryCtrl.listArrivals);
router.post('/arrivals', requireRole('admin', 'manager', 'staff', 'store_manager'), inventoryCtrl.createArrival);

// Expiry & Batch Tracking
router.get('/batches', requireRole('admin', 'manager'), batchesCtrl.listBatches);
router.get('/batches/expiring', requireRole('admin', 'manager'), batchesCtrl.listExpiringBatches);

// Cycle Counting & Inventory Accuracy
router.get('/cycle-counts/tasks', requireRole('admin', 'manager', 'staff'), cycleCountCtrl.listTasks);
router.post('/cycle-counts/tasks/:id/skip', requireRole('admin', 'manager'), cycleCountCtrl.skipTask);
router.post('/cycle-counts', requireRole('admin', 'manager', 'staff'), cycleCountCtrl.submitCount);
router.get('/cycle-counts/history', requireRole('admin', 'manager'), cycleCountCtrl.listHistory);
router.get('/cycle-counts/accuracy', requireRole('admin', 'manager'), cycleCountCtrl.getAccuracy);

// Online Marketplace — proxied to the cloud, see marketplaceController.js's header.
router.get('/marketplace/orders', requireRole('admin', 'manager', 'marketplace_manager'), marketplaceCtrl.listStoreOrders);
router.get('/marketplace/orders/:orderId', requireRole('admin', 'manager', 'marketplace_manager'), marketplaceCtrl.getStoreOrder);
router.patch('/marketplace/orders/:orderId/fulfill', requireRole('admin', 'manager', 'marketplace_manager'), marketplaceCtrl.fulfillOrder);
router.patch('/marketplace/orders/:orderId/cancel', requireRole('admin', 'manager', 'marketplace_manager'), marketplaceCtrl.cancelOrder);
router.patch('/marketplace/orders/:orderId/refunded', requireRole('admin', 'manager', 'marketplace_manager'), marketplaceCtrl.markRefunded);

// Support tickets — proxied to the cloud Super Admin queue, see supportController.js's header.
router.get('/support/tickets', requireRole('admin', 'manager'), supportCtrl.listMyTickets);
router.post('/support/tickets', requireRole('admin', 'manager'), supportCtrl.createTicket);
router.get('/support/tickets/:id', requireRole('admin', 'manager'), supportCtrl.getTicket);
router.post('/support/tickets/:id/reply', requireRole('admin', 'manager'), supportCtrl.addReply);

// Auditor engagements — proxied to the cloud marketplace, see auditController.js's header.
router.post('/audit-engagements', requireRole('admin', 'manager'), auditCtrl.requestEngagement);
router.get('/audit-engagements', auditCtrl.listStoreEngagements);

// Supplier Performance Analytics — /pricing-alerts registered before the
// /:id routes so it isn't swallowed as a supplier id.
router.get('/suppliers/pricing-alerts', requireRole('admin', 'manager'), suppliersCtrl.listPricingAlerts);
router.get('/suppliers', requireRole('admin', 'manager'), suppliersCtrl.listSuppliers);
router.post('/suppliers', requireRole('admin', 'manager'), suppliersCtrl.createSupplier);
router.patch('/suppliers/:id', requireRole('admin', 'manager'), suppliersCtrl.updateSupplier);
router.delete('/suppliers/:id', requireRole('admin'), suppliersCtrl.deleteSupplier);
router.get('/suppliers/:id/performance', requireRole('admin', 'manager'), suppliersCtrl.getSupplierPerformance);

// Integrations (outbound webhooks) — admin-only.
router.get('/webhooks', requireRole('admin'), webhooksCtrl.listWebhooks);
router.post('/webhooks', requireRole('admin'), webhooksCtrl.createWebhook);
router.patch('/webhooks/:id', requireRole('admin'), webhooksCtrl.updateWebhook);
router.delete('/webhooks/:id', requireRole('admin'), webhooksCtrl.deleteWebhook);
router.post('/webhooks/:id/test', requireRole('admin'), webhooksCtrl.testWebhook);

// Customer credit tracking ("owing book") — same-store, same-device
// feature, so (unlike marketplace/auditor) it's available on desktop
// too. 'staff' is this edition's equivalent of cloud's cashier/checkout
// roles for list/create/payment actions.
// Registered before /customers/:customerId so 'birthdays' isn't read as an id.
router.get('/customers/birthdays', requireRole('admin', 'manager', 'cashier', 'checkout'), require('../controllers/growthController').upcomingBirthdays);
router.get('/customers', requireRole('admin', 'manager', 'cashier', 'checkout'), customersCtrl.listCustomers);
router.post('/customers', requireRole('admin', 'manager', 'cashier', 'checkout'), customersCtrl.createCustomer);
router.get('/customers/:customerId', requireRole('admin', 'manager', 'cashier', 'checkout'), customersCtrl.getCustomer);
router.patch('/customers/:customerId', requireRole('admin', 'manager'), customersCtrl.updateCustomer);
router.delete('/customers/:customerId', requireRole('admin'), customersCtrl.archiveCustomer);
router.post('/customers/:customerId/payments', requireRole('admin', 'manager', 'cashier'), customersCtrl.recordPayment);
router.post('/customers/:customerId/adjustments', requireRole('admin', 'manager'), customersCtrl.recordAdjustment);

router.get('/movements', inventoryCtrl.listMovements);
router.post('/movements', requireRole('admin', 'manager', 'staff', 'store_manager', 'shelf_manager'), inventoryCtrl.createMovement);

// Shelf audits are done and seen only by the auditor the store brought in.
router.get('/audits', requireRole('auditor', 'stock_taker'), inventoryCtrl.listAudits);
router.get('/audits/report', requireRole('auditor', 'stock_taker'), inventoryCtrl.auditReport);
router.post('/audits', requireRole('auditor', 'stock_taker'), inventoryCtrl.createAudit);
router.get('/audits/conflicts', requireRole('auditor', 'stock_taker'), inventoryCtrl.listConflicts);
router.post('/audits/conflicts/:groupId/accept', requireRole('auditor', 'stock_taker'), inventoryCtrl.acceptRecount);

router.get('/receipts', receiptsCtrl.listReceipts);
router.post('/receipts', requireRole('admin', 'manager', 'staff', 'store_manager'), upload.single('receipt'), receiptsCtrl.uploadReceipt);
router.post('/receipts/:receiptId/apply', requireRole('admin', 'manager', 'store_manager'), receiptsCtrl.applyReceipt);
router.post('/receipts/:receiptId/reject', requireRole('admin', 'manager', 'store_manager'), receiptsCtrl.rejectReceipt);

router.get('/images', imagesCtrl.listImages);
router.post('/images', requireRole('admin', 'manager', 'staff'), upload.single('photo'), imagesCtrl.uploadImage);
router.delete('/images/:imageId', requireRole('admin', 'manager'), imagesCtrl.deleteImage);
router.get('/barcode-lookup', imagesCtrl.barcodeLookup);

router.get('/analytics/summary', analyticsCtrl.summary);
router.get('/analytics/stock-by-category', analyticsCtrl.stockByCategory);
router.get('/analytics/top-products', analyticsCtrl.topProducts);
router.get('/analytics/movement-trends', analyticsCtrl.movementTrends);
router.get('/analytics/low-stock-distribution', analyticsCtrl.lowStockDistribution);
router.get('/analytics/reorder-alerts', analyticsCtrl.reorderAlerts);
router.get('/analytics/expiring-soon', analyticsCtrl.expiringSoon);
router.get('/analytics/shrinkage', requireRole('admin', 'manager'), analyticsCtrl.shrinkageReport);

router.get('/export/csv', requireRole('admin'), exportCtrl.exportCsv);
router.get('/export/json', requireRole('admin'), exportCtrl.exportJson);

// POS checkout/cashier — offline-capable, same as everything else here.
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

// Shifts, end-of-day reporting and store settings — see shiftsController.js.
const shiftsCtrl = require('../controllers/shiftsController');
const TILL = ['admin', 'manager', 'cashier', 'checkout'];
router.get('/shifts/current', requireRole(...TILL), shiftsCtrl.currentShift);
router.get('/shifts', requireRole(...TILL), shiftsCtrl.listShifts);
router.post('/shifts', requireRole(...TILL), shiftsCtrl.openShift);
router.post('/shifts/:shiftId/close', requireRole(...TILL), shiftsCtrl.closeShift);
router.get('/shifts/:shiftId/report', requireRole(...TILL), shiftsCtrl.shiftReport);
router.get('/reports/daily', requireRole('admin', 'manager'), shiftsCtrl.dailyReport);
router.get('/onboarding', requireRole('admin', 'manager'), require('../controllers/onboardingController').status);
router.post('/onboarding/sample-data', requireRole('admin'), require('../controllers/onboardingController').loadSamples);
router.get('/settings', shiftsCtrl.getSettings);

// Insights, product import, loyalty — see growthController.js.
const growthCtrl = require('../controllers/growthController');
router.get('/insights/profit', requireRole('admin', 'manager'), growthCtrl.profit);
router.get('/insights/abc', requireRole('admin', 'manager'), growthCtrl.abc);
router.get('/insights/dead-stock', requireRole('admin', 'manager'), growthCtrl.deadStock);
router.get('/insights/forecast', requireRole('admin', 'manager'), growthCtrl.forecast);
router.get('/insights/heatmap', requireRole('admin', 'manager'), growthCtrl.heatmap);
router.post('/products/import', requireRole('admin', 'manager'), growthCtrl.importProducts);
router.get('/customers/:customerId/points', requireRole('admin', 'manager', 'cashier', 'checkout'), growthCtrl.getPoints);
router.post('/orders/:orderId/redeem-points', requireRole('admin', 'manager', 'cashier', 'checkout'), growthCtrl.redeemPoints);
router.post('/orders/:orderId/customer', requireRole('admin', 'manager', 'cashier', 'checkout'), growthCtrl.attachCustomer);
router.patch('/settings', requireRole('admin'), shiftsCtrl.updateSettings);

// ---- Shop floor, fully offline (mirrors the cloud routes and roles) ----
const handoverCtrl = require('../controllers/handoverController');
const roleDash = require('../controllers/roleDashboardController');
const productionCtrl = require('../controllers/productionController');
const jobsCtrl = require('../controllers/jobsController');

router.get('/my-dashboard', roleDash.myDashboard);
router.get('/exit-check', requireRole('admin', 'manager', 'security'), roleDash.lookup);
router.post('/exit-check/:orderId', requireRole('admin', 'manager', 'security'), roleDash.markChecked);
router.post('/exit-check/:orderId/returns', requireRole('admin', 'manager', 'security'), roleDash.confirmReturn);

router.get('/handovers', requireRole('admin', 'manager', 'staff', 'store_manager', 'shelf_manager'), handoverCtrl.listHandovers);
router.post('/handovers', requireRole('admin', 'manager', 'store_manager'), handoverCtrl.issueHandover);
router.post('/handovers/:id/receive', requireRole('admin', 'manager', 'staff', 'shelf_manager'), handoverCtrl.receiveHandover);
router.post('/handovers/:id/cancel', requireRole('admin', 'manager', 'store_manager'), handoverCtrl.cancelHandover);
router.get('/returns', requireRole('admin', 'manager', 'store_manager', 'security'), handoverCtrl.listReturns);
router.post('/returns/:id/receive', requireRole('admin', 'manager', 'store_manager'), handoverCtrl.receiveReturn);

const PROD_ROLES = ['admin', 'manager', 'staff', 'store_manager'];
router.get('/production/recipes', requireRole(...PROD_ROLES), productionCtrl.listRecipes);
router.post('/production/recipes', requireRole('admin', 'manager', 'store_manager'), productionCtrl.saveRecipe);
router.delete('/production/recipes/:id', requireRole('admin', 'manager', 'store_manager'), productionCtrl.archiveRecipe);
router.get('/production/runs', requireRole(...PROD_ROLES), productionCtrl.listRuns);
router.post('/production/runs', requireRole(...PROD_ROLES), productionCtrl.runProduction);
router.get('/waste', requireRole('admin', 'manager', 'staff', 'store_manager', 'shelf_manager'), productionCtrl.wasteSummary);

const JOB_ROLES = ['admin', 'manager', 'staff', 'cashier', 'checkout'];
router.get('/jobs/customers', requireRole(...JOB_ROLES), jobsCtrl.findCustomers);
router.patch('/jobs/customers/:customerId/measurements', requireRole(...JOB_ROLES), jobsCtrl.saveMeasurements);
router.get('/jobs', requireRole(...JOB_ROLES), jobsCtrl.listJobs);
router.post('/jobs', requireRole(...JOB_ROLES), jobsCtrl.createJob);
router.get('/jobs/tag/:code', requireRole(...JOB_ROLES), jobsCtrl.getByTag);
router.get('/jobs/:id', requireRole(...JOB_ROLES), jobsCtrl.getJob);
router.patch('/jobs/:id/repair', requireRole(...JOB_ROLES), jobsCtrl.updateRepair);
router.post('/jobs/:id/notes', requireRole(...JOB_ROLES), jobsCtrl.addNote);
router.patch('/jobs/:id/status', requireRole(...JOB_ROLES), jobsCtrl.setStatus);
router.post('/jobs/:id/payments', requireRole(...JOB_ROLES), jobsCtrl.addPayment);
router.post('/jobs/:id/collect', requireRole(...JOB_ROLES), jobsCtrl.collect);
router.post('/jobs/:id/materials', requireRole('admin', 'manager', 'staff'), jobsCtrl.addMaterial);

module.exports = router;
