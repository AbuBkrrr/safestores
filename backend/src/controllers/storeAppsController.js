const { Readable } = require('stream');
const db = require('../config/db');
const storeApps = require('../utils/storeApps');

async function byToken(token) {
  if (!/^[a-f0-9]{48}$/.test(String(token))) return null;
  const { rows } = await db.query('SELECT * FROM store_apps WHERE download_token = $1', [token]);
  return rows[0] || null;
}

// GET /api/store-apps/:token — the sign-up page polls this until the apps are ready.
async function status(req, res) {
  const row = await storeApps.refresh(await byToken(req.params.token));
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(storeApps.publicView(row));
}

// GET /api/store-apps/:token/:platform — streams the file under the store's own name.
async function download(req, res) {
  const file = storeApps.FILES[req.params.platform];
  const row = await byToken(req.params.token);
  if (!file || !row || row.status !== 'ready' || !row[file.col]) return res.status(404).json({ error: 'Not ready' });
  const upstream = await fetch(row[file.col], { redirect: 'follow' });
  if (!upstream.ok || !upstream.body) return res.status(502).json({ error: 'Download is not available right now. Try again shortly.' });
  const name = storeApps.fileName(row, req.params.platform);
  res.setHeader('Content-Type', file.type);
  res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  const len = upstream.headers.get('content-length');
  if (len) res.setHeader('Content-Length', len);
  Readable.fromWeb(upstream.body).pipe(res);
}

// GET /api/stores/:storeId/apps — the store's admin.
// First look starts the build for stores made before this existed (or
// before GITHUB_TOKEN was set), so every store ends up with its apps.
async function mine(req, res) {
  const { rows: stores } = await db.query('SELECT id, name, store_tier, requested_tier FROM stores WHERE id = $1', [req.params.storeId]);
  if (!stores[0]) return res.status(404).json({ error: 'Store not found' });
  const row = await storeApps.ensureBuilt(stores[0]);
  res.json(storeApps.publicView(await storeApps.refresh(row)));
}

// POST /api/super/stores/:storeId/apps — Super Admin: build or rebuild (e.g. after a rename).
async function rebuild(req, res) {
  const { rows } = await db.query('SELECT id, name, store_tier, requested_tier FROM stores WHERE id = $1', [req.params.storeId]);
  if (!rows[0]) return res.status(404).json({ error: 'Store not found' });
  const row = await storeApps.requestBuild(rows[0]);
  res.status(202).json(storeApps.publicView(row));
}

module.exports = { status, download, mine, rebuild };
