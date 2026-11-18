// ------------------------------------------------------------
// Online Marketplace — admin side, desktop.
//
// Unlike everything else in this app, the marketplace genuinely can't run
// locally: random customers on the internet need something reachable from
// anywhere, which a store's own PC isn't. So the cloud (see
// backend/src/controllers/marketplaceController.js) owns
// browsing/signup/placing orders AND the admin-facing order list/fulfill
// actions — this file is just a thin proxy so the store's existing local
// UI (frontend/src/pages/Marketplace.jsx, unmodified) can reach it.
// ------------------------------------------------------------

const axios = require('axios');
const { cloudClientOrError, forwardError } = require('./cloudProxyHelpers');

// GET /api/stores/:storeId/marketplace/orders
async function listStoreOrders(req, res) {
  const cloud = cloudClientOrError(res);
  if (!cloud) return;
  try {
    const { data } = await axios.get(`${cloud.baseUrl}/api/stores/${cloud.storeId}/marketplace/orders`, {
      headers: cloud.headers, timeout: 10000,
    });
    res.json(data);
  } catch (err) { forwardError(err, res); }
}

// GET /api/stores/:storeId/marketplace/orders/:orderId
async function getStoreOrder(req, res) {
  const cloud = cloudClientOrError(res);
  if (!cloud) return;
  try {
    const { data } = await axios.get(`${cloud.baseUrl}/api/stores/${cloud.storeId}/marketplace/orders/${req.params.orderId}`, {
      headers: cloud.headers, timeout: 10000,
    });
    res.json(data);
  } catch (err) { forwardError(err, res); }
}

// PATCH /api/stores/:storeId/marketplace/orders/:orderId/fulfill
// The cloud does the actual stock deduction against its own copy of this
// store's products (that's the copy customers were shown and ordered
// against) — the resulting stock_movements row flows back down into this
// device's local database automatically on the next sync pull (same
// idempotent replay as LAN device sync), typically within one sync
// interval. No separate reconciliation step needed here.
async function fulfillOrder(req, res) {
  const cloud = cloudClientOrError(res);
  if (!cloud) return;
  try {
    const { data } = await axios.patch(
      `${cloud.baseUrl}/api/stores/${cloud.storeId}/marketplace/orders/${req.params.orderId}/fulfill`,
      {}, { headers: cloud.headers, timeout: 10000 }
    );
    res.json(data);
  } catch (err) { forwardError(err, res); }
}

function proxyPatch(action) {
  return async (req, res) => {
    const cloud = cloudClientOrError(res);
    if (!cloud) return;
    try {
      const { data } = await axios.patch(
        `${cloud.baseUrl}/api/stores/${cloud.storeId}/marketplace/orders/${req.params.orderId}/${action}`,
        req.body || {}, { headers: cloud.headers, timeout: 10000 }
      );
      res.json(data);
    } catch (err) { forwardError(err, res); }
  };
}
const cancelOrder = proxyPatch('cancel');
const markRefunded = proxyPatch('refunded');

module.exports = { listStoreOrders, getStoreOrder, fulfillOrder, cancelOrder, markRefunded };
