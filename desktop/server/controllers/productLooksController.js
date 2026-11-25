// Product "looks" for camera recognition — same rules as the cloud edition.
const crypto = require('crypto');
const db = require('../db');
const validSig = (s) => typeof s === 'string' && s.length >= 200 && s.length <= 800 && /^[A-Za-z0-9+/=]+$/.test(s);
const KEEP = 20; // looks kept per product (newest)

function listLooks(req, res) {
  res.json(db.prepare(
    `SELECT l.product_id, l.sig FROM product_looks l JOIN products p ON p.id = l.product_id
     WHERE l.store_id = ? AND p.archived_at IS NULL ORDER BY l.created_at DESC LIMIT 20000`).all(req.params.storeId));
}

function addLook(req, res) {
  const { storeId, productId } = req.params;
  const { sig } = req.body || {};
  if (!validSig(sig)) return res.status(400).json({ error: 'Invalid picture fingerprint' });
  const p = db.prepare('SELECT id FROM products WHERE id = ? AND store_id = ?').get(productId, storeId);
  if (!p) return res.status(404).json({ error: 'Product not found' });
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO product_looks (id, store_id, product_id, sig, created_by) VALUES (?,?,?,?,?)').run(id, storeId, p.id, sig, req.user.sub || null);
  db.prepare(`DELETE FROM product_looks WHERE product_id = ? AND id NOT IN
    (SELECT id FROM product_looks WHERE product_id = ? ORDER BY created_at DESC LIMIT ${KEEP})`).run(p.id, p.id);
  res.status(201).json({ id, product_id: p.id, sig });
}

function clearLooks(req, res) {
  const r = db.prepare('DELETE FROM product_looks WHERE store_id = ? AND product_id = ?').run(req.params.storeId, req.params.productId);
  res.json({ removed: r.changes });
}

module.exports = { listLooks, addLook, clearLooks };
