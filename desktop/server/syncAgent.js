// ------------------------------------------------------------
// Sync agent — ties LAN discovery together with the export/import
// endpoints to keep this device's data merged with every other device
// for the same store, whether that's a LAN peer (no internet needed) or
// the cloud (whenever internet is available).
//
// Every cycle, for every known remote (LAN peers found via UDP broadcast,
// plus the cloud if configured):
//   1. Pull: fetch what changed on the remote since our last pull, merge
//      it in locally (idempotent — see syncController.js).
//   2. Push: send the remote what's changed here since our last push to
//      IT specifically (each remote gets its own cursor, since a LAN peer
//      and the cloud are independent destinations).
//
// A network hiccup on one remote in one cycle just means we try again
// next cycle — nothing is lost, since cursors only advance after a
// successful round-trip.
// ------------------------------------------------------------

const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const axios = require('axios');
const db = require('./db');
const { startDiscovery } = require('./lan');
const syncCtrl = require('./controllers/syncController');

const SYNC_INTERVAL_MS = 15000;

function configPath() {
  return path.join(app.getPath('userData'), 'sync-config.json');
}

// Config lives in a plain JSON file the operator (or a future settings UI)
// can edit: { "cloudUrl": "https://yourdomain.com", "cloudEnabled": true,
// "lanEnabled": true }. Defaults to LAN-only, no cloud, until configured.
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return { cloudUrl: null, cloudEnabled: false, lanEnabled: true };
  }
}

function getStoreRow() {
  // The desktop edition is single-store-per-install, so there's at most one row.
  return db.prepare('SELECT id, sync_key FROM stores LIMIT 1').get();
}

function getCursor(peerKey, storeId) {
  let row = db.prepare('SELECT * FROM sync_cursors WHERE peer_key = ?').get(peerKey);
  if (!row) {
    db.prepare('INSERT INTO sync_cursors (peer_key, store_id) VALUES (?, ?)').run(peerKey, storeId);
    row = db.prepare('SELECT * FROM sync_cursors WHERE peer_key = ?').get(peerKey);
  }
  return row;
}

function setCursor(peerKey, field, value) {
  db.prepare(`UPDATE sync_cursors SET ${field} = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE peer_key = ?`).run(value, peerKey);
}

// Calls the local (in-process) controller functions directly rather than
// over HTTP — it's the same SQLite connection, so no need for a network
// round-trip just to talk to ourselves.
function importLocally(storeId, exportedPayload) {
  let errorPayload = null;
  const fakeReq = { params: { storeId }, body: exportedPayload };
  const fakeRes = { status: (code) => ({ json: (data) => { if (code >= 400) errorPayload = data; } }), json: () => {} };
  syncCtrl.importChanges(fakeReq, fakeRes);
  if (errorPayload) throw new Error(`local import failed: ${JSON.stringify(errorPayload)}`);
}

function exportLocally(storeId, since) {
  let result = null;
  const fakeReq = { params: { storeId }, query: { since } };
  const fakeRes = { json: (data) => { result = data; } };
  syncCtrl.exportChanges(fakeReq, fakeRes);
  return result;
}

async function syncWithRemote({ peerKey, baseUrl, storeId, syncKey, log }) {
  const headers = { 'X-Store-Sync-Key': syncKey };
  const cursor = getCursor(peerKey, storeId);

  // --- Pull their changes since our last successful pull, merge locally ---
  try {
    const { data } = await axios.get(`${baseUrl}/api/stores/${storeId}/sync/export`, {
      headers, params: { since: cursor.last_pulled_at }, timeout: 8000,
    });
    importLocally(storeId, data);
    setCursor(peerKey, 'last_pulled_at', data.serverTime);
  } catch (err) {
    log(`pull from ${peerKey} failed (will retry next cycle): ${err.message}`);
    return;
  }

  // --- Push our changes since our last successful push to THIS remote ---
  try {
    const exported = exportLocally(storeId, cursor.last_pushed_at);
    await axios.post(`${baseUrl}/api/stores/${storeId}/sync/import`, exported, { headers, timeout: 8000 });
    setCursor(peerKey, 'last_pushed_at', exported.serverTime);
  } catch (err) {
    log(`push to ${peerKey} failed (will retry next cycle): ${err.message}`);
  }
}

function startSyncAgent(localPort, { log = () => {} } = {}) {
  const discovery = startDiscovery({
    getAnnouncement: () => {
      const store = getStoreRow();
      return store ? { storeId: store.id, port: localPort } : null;
    },
  });

  const interval = setInterval(async () => {
    const store = getStoreRow();
    if (!store) return; // nothing set up on this device yet
    const config = loadConfig();

    if (config.lanEnabled !== false) {
      for (const peer of discovery.getPeersForStore(store.id)) {
        const peerKey = `lan:${peer.ip}:${peer.port}`;
        await syncWithRemote({ peerKey, baseUrl: `http://${peer.ip}:${peer.port}`, storeId: store.id, syncKey: store.sync_key, log });
      }
    }

    if (config.cloudEnabled && config.cloudUrl) {
      await syncWithRemote({ peerKey: 'cloud', baseUrl: config.cloudUrl.replace(/\/$/, ''), storeId: store.id, syncKey: store.sync_key, log });
    }
  }, SYNC_INTERVAL_MS);

  return function stop() {
    clearInterval(interval);
    discovery.stop();
  };
}

module.exports = { startSyncAgent, loadConfig, configPath, syncWithRemote };
