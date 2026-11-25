// Product "looks" for camera recognition — see frontend/src/utils/visualMatch.js.
const db = require('../config/db');
const validSig = (s) => typeof s === 'string' && s.length >= 200 && s.length <= 800 && /^[A-Za-z0-9+/=]+$/.test(s);
const KEEP = 20; // looks kept per product (newest)

// GET /api/stores/:storeId/product-looks
async function listLooks(req, res) {
  const { rows } = await db.query(
    `SELECT l.product_id, l.sig FROM product_looks l JOIN products p ON p.id = l.product_id
     WHERE l.store_id = $1 AND p.archived_at IS NULL ORDER BY l.created_at DESC LIMIT 20000`, [req.params.storeId]);
  res.json(rows);
}

// POST /api/stores/:storeId/products/:productId/looks  body: { sig }
async function addLook(req, res) {
  const { storeId, productId } = req.params;
  const { sig } = req.body || {};
  if (!validSig(sig)) return res.status(400).json({ error: 'Invalid picture fingerprint' });
  const p = (await db.query('SELECT id FROM products WHERE id::text = $1 AND store_id = $2', [productId, storeId])).rows[0];
  if (!p) return res.status(404).json({ error: 'Product not found' });
  const { rows } = await db.query('INSERT INTO product_looks (store_id, product_id, sig, created_by) VALUES ($1,$2,$3,$4) RETURNING id, product_id, sig',
    [storeId, p.id, sig, req.user.sub || null]);
  await db.query(`DELETE FROM product_looks WHERE product_id = $1 AND id NOT IN
    (SELECT id FROM product_looks WHERE product_id = $1 ORDER BY created_at DESC LIMIT ${KEEP})`, [p.id]);
  res.status(201).json(rows[0]);
}

// DELETE /api/stores/:storeId/products/:productId/looks — forget what this item looks like.
async function clearLooks(req, res) {
  const r = await db.query('DELETE FROM product_looks WHERE store_id = $1 AND product_id::text = $2', [req.params.storeId, req.params.productId]);
  res.json({ removed: r.rowCount });
}

module.exports = { listLooks, addLook, clearLooks };
