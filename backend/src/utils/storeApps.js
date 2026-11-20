// Each store's own apps: a Windows installer and an Android app carrying the
// store's name, built from templates/store-app by the "Store apps" GitHub
// workflow (.github/workflows/store-app.yml).
//
// Server settings (.env):
//   GITHUB_TOKEN   a token allowed to run workflows and read releases on the repo
//                  (fine-grained: Actions read/write + Contents read)
//   GITHUB_REPO    owner/name, default AbuBkrrr/safestores
//   STORE_APP_API_URL  address the Android app talks to (default FRONTEND_URL + /api)
// Without GITHUB_TOKEN nothing is built and the store sees "not available yet".
const crypto = require('crypto');
const db = require('../config/db');

const WORKFLOW = 'store-app.yml';
const BUILD_TIMEOUT_MIN = 60;
const repo = () => process.env.GITHUB_REPO || 'AbuBkrrr/safestores';
const token = () => process.env.GITHUB_TOKEN || '';
const apiUrl = () => process.env.STORE_APP_API_URL
  || `${String(process.env.FRONTEND_URL || '').split(',')[0].replace(/\/$/, '')}/api`;

async function github(path, options = {}) {
  const res = await fetch(`https://api.github.com/repos/${repo()}${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token()}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'store-apps',
      ...(options.headers || {}),
    },
  });
  return res;
}

/** Starts (or restarts) the build of a store's apps. Never throws. */
async function requestBuild(store) {
  const name = String(store.name || '').trim().slice(0, 60);
  const { rows } = await db.query(
    `INSERT INTO store_apps (store_id, brand_name, download_token, status, requested_at, windows_url, android_url, error, ready_at)
     VALUES ($1, $2, $3, 'queued', NOW(), NULL, NULL, NULL, NULL)
     ON CONFLICT (store_id) DO UPDATE SET brand_name = EXCLUDED.brand_name, status = 'queued', requested_at = NOW(),
       windows_url = NULL, android_url = NULL, error = NULL, ready_at = NULL
     RETURNING *`,
    [store.id, name, crypto.randomBytes(24).toString('hex')]
  );
  if (!token()) {
    await db.query(`UPDATE store_apps SET status = 'not_configured' WHERE store_id = $1`, [store.id]);
    return { ...rows[0], status: 'not_configured' };
  }
  try {
    const res = await github(`/actions/workflows/${WORKFLOW}/dispatches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ref: process.env.GITHUB_REF || 'main',
        inputs: { store_id: String(store.id), store_name: name, store_tier: store.requested_tier || store.store_tier || 'mini', api_url: apiUrl() },
      }),
    });
    if (!res.ok) throw new Error(`GitHub said ${res.status}`);
    await db.query(`UPDATE store_apps SET status = 'building' WHERE store_id = $1`, [store.id]);
    return { ...rows[0], status: 'building' };
  } catch (err) {
    await db.query(`UPDATE store_apps SET status = 'failed', error = $2 WHERE store_id = $1`, [store.id, String(err.message).slice(0, 300)]);
    return { ...rows[0], status: 'failed' };
  }
}

/** Starts a build if the store has none yet, or the last one could not run. */
async function ensureBuilt(store) {
  const { rows } = await db.query('SELECT * FROM store_apps WHERE store_id = $1', [store.id]);
  const row = rows[0];
  if (!row || (['not_configured', 'failed'].includes(row.status) && token())) return requestBuild(store);
  return row;
}

/** Looks for finished files on the store's release; updates and returns the row. */
async function refresh(row) {
  if (!row || row.status !== 'building' || !token()) return row;
  try {
    const res = await github(`/releases/tags/store-${row.store_id}`);
    if (res.ok) {
      const rel = await res.json();
      const fresh = (a) => new Date(a.updated_at) >= new Date(row.requested_at);
      const asset = (n) => (rel.assets || []).find((a) => a.name === n && fresh(a));
      const win = asset('store-windows.exe');
      const apk = asset('store-android.apk');
      if (win && apk) {
        const { rows } = await db.query(
          `UPDATE store_apps SET status = 'ready', windows_url = $2, android_url = $3, ready_at = NOW()
           WHERE store_id = $1 RETURNING *`,
          [row.store_id, win.browser_download_url, apk.browser_download_url]
        );
        return rows[0];
      }
    }
  } catch { /* GitHub unreachable: try again next time */ }
  if (Date.now() - new Date(row.requested_at).getTime() > BUILD_TIMEOUT_MIN * 60000) {
    const { rows } = await db.query(
      `UPDATE store_apps SET status = 'failed', error = 'The build took too long' WHERE store_id = $1 RETURNING *`, [row.store_id]
    );
    return rows[0];
  }
  return row;
}

const FILES = {
  windows: { col: 'windows_url', ext: 'Setup.exe', type: 'application/vnd.microsoft.portable-executable' },
  android: { col: 'android_url', ext: 'apk', type: 'application/vnd.android.package-archive' },
};

function fileName(row, platform) {
  const base = String(row.brand_name).replace(/[^\p{L}\p{N} .&'-]/gu, '').trim() || 'Store app';
  return platform === 'windows' ? `${base} Setup.exe` : `${base}.apk`;
}

/** What the store sees: status plus download links on this server. */
function publicView(row, base = '/api/store-apps') {
  if (!row) return { status: 'none' };
  const ready = row.status === 'ready';
  return {
    status: row.status,
    name: row.brand_name,
    requestedAt: row.requested_at,
    readyAt: row.ready_at,
    downloads: ready ? {
      windows: { url: `${base}/${row.download_token}/windows`, file: fileName(row, 'windows') },
      android: { url: `${base}/${row.download_token}/android`, file: fileName(row, 'android') },
    } : null,
  };
}

module.exports = { requestBuild, ensureBuilt, refresh, publicView, fileName, FILES };
