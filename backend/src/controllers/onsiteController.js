const db = require('../config/db');
const { networkKey } = require('../utils/onsite');
const { logActivity } = require('../utils/activityLog');

const MAX_NETWORKS = 10;

async function read(storeId) {
  const { rows } = await db.query(
    'SELECT onsite_lock, onsite_networks, onsite_lat, onsite_lng, onsite_radius_m FROM stores WHERE id = $1', [storeId]
  );
  const s = rows[0];
  return s && {
    enabled: s.onsite_lock,
    networks: s.onsite_networks || [],
    radiusM: s.onsite_radius_m,
    location: s.onsite_lat != null ? { lat: Number(s.onsite_lat), lng: Number(s.onsite_lng) } : null,
  };
}

// GET /api/stores/:storeId/onsite — also says whether the caller is on a saved connection right now.
async function getOnsite(req, res) {
  const s = await read(req.params.storeId);
  if (!s) return res.status(404).json({ error: 'Store not found' });
  const here = networkKey(req.ip);
  res.json({ ...s, onShopNetwork: s.networks.some((n) => networkKey(n.ip) === here) });
}

// PATCH /api/stores/:storeId/onsite  { enabled?, radiusM?, location?: {lat,lng} | null }
async function updateOnsite(req, res) {
  const { storeId } = req.params;
  const { enabled, radiusM, location } = req.body || {};
  const cur = await read(storeId);
  const sets = [];
  const vals = [];
  const set = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };

  if (radiusM !== undefined) {
    const r = Math.round(Number(radiusM));
    if (!Number.isFinite(r) || r < 30 || r > 2000) return res.status(400).json({ error: 'Shop radius must be between 30 and 2000 metres' });
    set('onsite_radius_m', r);
  }
  let loc = cur.location;
  if (location !== undefined) {
    if (location === null) {
      loc = null;
      set('onsite_lat', null); set('onsite_lng', null);
    } else {
      const lat = Number(location?.lat), lng = Number(location?.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        return res.status(400).json({ error: 'That location is not valid' });
      }
      loc = { lat, lng };
      set('onsite_lat', lat); set('onsite_lng', lng);
    }
  }
  const willBeOn = enabled !== undefined ? !!enabled : cur.enabled;
  if (willBeOn && !cur.networks.length && !loc) {
    return res.status(400).json({ error: 'Save the shop’s internet connection or set the shop’s location first, or no staff could work.' });
  }
  if (enabled !== undefined) set('onsite_lock', !!enabled);
  if (!sets.length) return res.status(400).json({ error: 'Nothing to change' });

  vals.push(storeId);
  await db.query(`UPDATE stores SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  await logActivity(req, {
    storeId, action: 'onsite_lock_updated', entityType: 'store', entityId: storeId,
    details: { enabled: willBeOn, radiusM: radiusM ?? cur.radiusM, locationSet: !!loc },
  });
  res.json(await read(storeId));
}

// POST /api/stores/:storeId/onsite/networks  { label? } — saves the connection this request came from.
async function addNetworkHere(req, res) {
  const { storeId } = req.params;
  const cur = await read(storeId);
  const key = networkKey(req.ip);
  if (!key) return res.status(400).json({ error: 'Could not read this connection' });
  if (cur.networks.some((n) => networkKey(n.ip) === key)) return res.status(409).json({ error: 'This connection is already saved' });
  if (cur.networks.length >= MAX_NETWORKS) return res.status(400).json({ error: `At most ${MAX_NETWORKS} connections can be saved` });
  const label = String(req.body?.label || '').trim().slice(0, 60) || `Connection ${cur.networks.length + 1}`;
  const next = [...cur.networks, { ip: key, label, addedAt: new Date().toISOString() }];
  await db.query('UPDATE stores SET onsite_networks = $1 WHERE id = $2', [JSON.stringify(next), storeId]);
  await logActivity(req, { storeId, action: 'onsite_network_added', entityType: 'store', entityId: storeId, details: { label } });
  res.status(201).json(await read(storeId));
}

// DELETE /api/stores/:storeId/onsite/networks/:index
async function removeNetwork(req, res) {
  const { storeId } = req.params;
  const cur = await read(storeId);
  const i = Number(req.params.index);
  if (!Number.isInteger(i) || i < 0 || i >= cur.networks.length) return res.status(404).json({ error: 'Not found' });
  const next = cur.networks.filter((_, k) => k !== i);
  if (cur.enabled && !next.length && !cur.location) {
    return res.status(400).json({ error: 'This is the only way staff can be confirmed in the shop. Set the shop location or switch the lock off first.' });
  }
  await db.query('UPDATE stores SET onsite_networks = $1 WHERE id = $2', [JSON.stringify(next), storeId]);
  await logActivity(req, { storeId, action: 'onsite_network_removed', entityType: 'store', entityId: storeId, details: { label: cur.networks[i].label } });
  res.json(await read(storeId));
}

module.exports = { getOnsite, updateOnsite, addNetworkHere, removeNetwork };
