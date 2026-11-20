const router = require('express').Router();
const ctrl = require('../controllers/setupController');

router.get('/status', ctrl.status);
router.post('/super-admin', ctrl.createSuperAdmin);
router.post('/connect', ctrl.connect);

module.exports = router;
