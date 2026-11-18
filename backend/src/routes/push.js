const router = require('express').Router();
const ctrl = require('../controllers/pushController');
const { requireAuth } = require('../middleware/auth');

// Any logged-in user (any role, any store) can register a device — this
// isn't store-operational data, just "where do I send this user's pushes".
router.post('/register', requireAuth, ctrl.registerToken);
router.delete('/register', requireAuth, ctrl.unregisterToken);

module.exports = router;
