// ------------------------------------------------------------
// Auditor engagements — matching this store with an external auditor is
// inherently a cloud/marketplace concern (the auditor isn't a desktop
// user), so requesting/viewing engagement status is a thin proxy, same
// pattern as marketplaceController.js. Once an auditor is matched, the
// store admin invites them locally as a normal 'auditor'-role user (see
// usersController.js) — the actual counting then happens entirely on
// this device, no further cloud involvement (see inventoryController.js).
// ------------------------------------------------------------

const axios = require('axios');
const { cloudClientOrError, currentUserName, forwardError } = require('./cloudProxyHelpers');

// GET /api/stores/:storeId/audit-engagements
async function listStoreEngagements(req, res) {
  const cloud = cloudClientOrError(res);
  if (!cloud) return;
  try {
    const { data } = await axios.get(`${cloud.baseUrl}/api/stores/${cloud.storeId}/audit-engagements`, {
      headers: cloud.headers, timeout: 10000,
    });
    res.json(data);
  } catch (err) { forwardError(err, res); }
}

// POST /api/stores/:storeId/audit-engagements   { notes? }
async function requestEngagement(req, res) {
  const cloud = cloudClientOrError(res);
  if (!cloud) return;
  try {
    const { data } = await axios.post(
      `${cloud.baseUrl}/api/stores/${cloud.storeId}/audit-engagements`,
      { ...req.body, requestedByName: currentUserName(req) },
      { headers: cloud.headers, timeout: 10000 }
    );
    res.status(201).json(data);
  } catch (err) { forwardError(err, res); }
}

module.exports = { listStoreEngagements, requestEngagement };
