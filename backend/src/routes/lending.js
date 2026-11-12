const router = require('express').Router();
const lendingCtrl = require('../controllers/lendingController');
const { requireLendingPartnerKey } = require('../middleware/auth');

router.use(requireLendingPartnerKey);

router.get('/stores', lendingCtrl.listConsentingStores);
router.get('/stores/:storeId/summary', lendingCtrl.getStoreSummary);

module.exports = router;
