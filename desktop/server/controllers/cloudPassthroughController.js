const { tokenFor, cloudBase } = require('../utils/cloudSession');

// Online-only screens on the shop computer: credit applications, couriers,
// payouts, settlements, card payment of the bill, shop branding, transfers
// between branches, emailed reports, online-order courier/credit actions.
// They run in the cloud under the signed-in person's own cloud login (see
// utils/cloudSession.js), so the cloud applies its usual permissions.
// The role checks below mirror backend/src/routes/stores.js so a person is
// told "not allowed" here before any network call.

const ONLINE_ONLY = [
  { re: /^\/credit\/(guarantors|accounts|statement)$/, get: ['admin', 'manager', 'cashier', 'checkout'] },
  { re: /^\/credit(\/|$)/, any: ['admin', 'manager'] },
  { re: /^\/couriers$/, get: ['admin', 'manager', 'marketplace_manager'] },
  { re: /^\/couriers\//, any: ['admin', 'manager'] },
  { re: /^\/partner-invites$/, any: ['admin', 'manager'] },
  { re: /^\/lending-partners(\/|$)/, any: ['admin'] },
  { re: /^\/loyalty-settings$/, any: ['admin', 'manager'] },
  { re: /^\/branding\/(logo|background)$/, any: ['admin', 'manager'] },
  { re: /^\/payouts$/, get: ['admin', 'manager'] },
  { re: /^\/payouts(\/|$)/, any: ['admin'] },
  { re: /^\/settlements(\/|$)/, any: ['admin', 'manager'] },
  { re: /^\/billing\/charges\/[^/]+\/pay\/(initialize|verify)$/, any: ['admin', 'manager'] },
  { re: /^\/custom-domain\/check$/, any: ['admin', 'manager'] },
  { re: /^\/transfers\/[^/]+\/receive$/, any: ['admin', 'manager', 'staff'] },
  { re: /^\/transfers(\/|$)/, any: ['admin', 'manager'] },
  { re: /^\/reports\/email$/, any: ['admin', 'manager'] },
  { re: /^\/marketplace\/orders\/[^/]+\/courier$/, any: ['admin', 'manager', 'marketplace_manager'] },
  { re: /^\/marketplace\/orders\/[^/]+\/credit-settled$/, any: ['admin', 'manager'] },
];

function rolesFor(method, path) {
  for (const r of ONLINE_ONLY) {
    if (!r.re.test(path)) continue;
    if (method === 'GET' && r.get) return r.get;
    if (r.any) return r.any;
  }
  return null;
}

const OFFLINE_MSG = 'This needs the internet. Connect, then try again — your sales and stock keep working offline in the meantime.';

/** Express middleware: handles the online-only paths; anything else falls through to the local routes. */
async function cloudPassthrough(req, res, next) {
  const allowed = rolesFor(req.method, req.path);
  if (!allowed) return next();
  if (!allowed.includes(req.user?.role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const base = cloudBase();
  if (!base) return res.status(400).json({ code: 'CLOUD_NOT_CONNECTED', error: 'Connect this shop computer to your online store (Settings → Sync) to use this.' });
  const token = tokenFor(req.user.sub);
  if (!token) {
    return res.status(401).json({ code: 'CLOUD_SIGN_IN', error: 'Sign out and sign in again while connected to the internet to use this screen.' });
  }

  const url = `${base}/api/stores/${encodeURIComponent(req.params.storeId)}${req.path}${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`;
  const headers = { Authorization: `Bearer ${token}` };
  let body;
  const type = req.headers['content-type'] || '';
  if (!['GET', 'HEAD'].includes(req.method)) {
    if (type.startsWith('multipart/')) {
      headers['content-type'] = type; // the upload stream hasn't been read yet: pass it on as-is
      body = req;
    } else {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(req.body || {});
    }
  }
  try {
    const r = await fetch(url, { method: req.method, headers, body, duplex: body === req ? 'half' : undefined, signal: AbortSignal.timeout(20000) });
    res.status(r.status);
    for (const h of ['content-type', 'content-disposition']) { const v = r.headers.get(h); if (v) res.set(h, v); }
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (err) {
    console.error('[cloud passthrough]', req.method, req.path, err.message);
    res.status(503).json({ code: 'OFFLINE', error: OFFLINE_MSG });
  }
}

module.exports = { cloudPassthrough, rolesFor };
