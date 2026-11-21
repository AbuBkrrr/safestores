const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');

// GET /api/setup/status
// needsSetup: the Super Admin edition has no Super Admin yet.
// needsStore: this computer is not connected to any store yet (a store's
// own app, or the general shop-computer app, right after installing).
function status(req, res) {
  const count = db.prepare('SELECT COUNT(*) AS c FROM super_admins').get().c;
  const stores = db.prepare('SELECT COUNT(*) AS c FROM stores').get().c;
  res.json({ needsSetup: count === 0, needsStore: stores === 0 });
}

// POST /api/setup/connect   { email, password, otp?, storeId?, serverUrl? }
// One time, with internet: the owner or a manager signs in with their online
// account. This computer then takes that store's id and sync key, pulls the
// store's staff, products and stock, and from then on works offline, syncing
// with the shop's other devices and the online store whenever it can.
async function connect(req, res) {
  if (db.prepare('SELECT COUNT(*) AS c FROM stores').get().c > 0) {
    return res.status(409).json({ error: 'This computer is already connected to a store.' });
  }
  const { email, password, otp, storeId } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Enter your email and password' });
  const base = String(req.body?.serverUrl || process.env.STORE_CLOUD_URL || 'https://app.safestores.name.ng')
    .trim().replace(/\/+$/, '').replace(/\/api$/, '');
  if (!/^https?:\/\/[^\s/]+/i.test(base)) return res.status(400).json({ error: 'Check the server address' });

  const axios = require('axios');
  let login;
  try {
    login = (await axios.post(`${base}/api/auth/admin/login`, { email, password, otp, storeId }, { timeout: 15000 })).data;
  } catch (err) {
    if (err.response) return res.status(err.response.status).json(err.response.data || { error: 'Sign-in failed' });
    return res.status(502).json({ error: 'No internet connection to your online store. Connect this computer to the internet once to set it up.' });
  }
  const u = login.user || {};
  if (!['admin', 'manager'].includes(u.role)) {
    return res.status(403).json({ error: 'Ask the store owner or a manager to connect this computer.' });
  }
  if (!u.storeId || !u.syncKey) return res.status(502).json({ error: 'The online store did not send its connection details. Try again.' });

  db.prepare(
    `INSERT INTO stores (id, name, store_tier, subscription_status, sync_key, locked) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(u.storeId, u.storeName || 'My store', u.storeTier || 'mini', u.subscriptionStatus || 'active', u.syncKey, u.locked ? 1 : 0);
  try { db.prepare('UPDATE stores SET business_type = ? WHERE id = ?').run(u.businessType || 'general', u.storeId); } catch { /* older schema */ }

  const { saveConfig, syncWithRemote } = require('../syncAgent');
  const problems = [];
  await syncWithRemote({ peerKey: 'cloud', baseUrl: base, storeId: u.storeId, syncKey: u.syncKey, log: (m) => problems.push(m) });
  const here = db.prepare('SELECT id FROM users WHERE store_id = ? AND lower(email) = lower(?)').get(u.storeId, email);
  if (!here) {
    // Nothing usable arrived: undo, so the person can simply try again.
    db.prepare('DELETE FROM stores WHERE id = ?').run(u.storeId);
    return res.status(502).json({ error: 'Could not download your store. Check the internet connection and try again.', details: problems.slice(0, 2) });
  }
  saveConfig({ cloudUrl: base, cloudEnabled: true });
  res.status(201).json({ storeName: u.storeName, email });
}

// POST /api/setup/super-admin   { name, email, password }
// Only allowed once — if a super admin already exists, this refuses.
async function createSuperAdmin(req, res) {
  const count = db.prepare('SELECT COUNT(*) AS c FROM super_admins').get().c;
  if (count > 0) return res.status(409).json({ error: 'Setup has already been completed' });

  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'name, email, and password are required' });
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const passwordHash = await bcrypt.hash(password, 10);
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO super_admins (id, name, email, password_hash) VALUES (?,?,?,?)').run(id, name, email, passwordHash);

  res.status(201).json({ message: 'Super Admin created. You can now log in.' });
}

module.exports = { status, createSuperAdmin, connect };
