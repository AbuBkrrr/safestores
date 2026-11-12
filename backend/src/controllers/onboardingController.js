// ------------------------------------------------------------
// First-run onboarding: a "getting started" checklist computed from real
// data, and optional sample products so a new owner can try the till
// straight away. Desktop has a twin (desktop/server/controllers/onboardingController.js).
// ------------------------------------------------------------
const crypto = require('crypto');
const db = require('../config/db');
const { recomputeProductQuantities } = require('../utils/stockMath');
const { SAMPLE_PRODUCTS } = require('../utils/sampleProducts');

// GET /api/stores/:storeId/onboarding
async function status(req, res) {
  const { storeId } = req.params;
  const q = async (sql) => Number((await db.query(sql, [storeId])).rows[0].n);
  const [products, onShelf, staff, sales] = await Promise.all([
    q('SELECT COUNT(*) AS n FROM products WHERE store_id = $1 AND archived_at IS NULL'),
    q('SELECT COUNT(*) AS n FROM products WHERE store_id = $1 AND shelf_qty > 0'),
    q(`SELECT COUNT(*) AS n FROM users WHERE store_id = $1 AND role <> 'admin'`),
    q(`SELECT COUNT(*) AS n FROM orders WHERE store_id = $1 AND status = 'paid'`),
  ]);
  const { rows: s } = await db.query('SELECT phone, address, receipt_footer, currency_code, updated_at, created_at FROM stores WHERE id = $1', [storeId]);
  const st = s[0] || {};
  const steps = [
    { key: 'settings', done: !!(st.phone || st.address || st.receipt_footer || st.currency_code), to: '/settings' },
    { key: 'products', done: products > 0, to: '/products/import' },
    { key: 'shelf', done: onShelf > 0, to: '/movements' },
    { key: 'staff', done: staff > 0, to: '/invites' },
    { key: 'sale', done: sales > 0, to: '/checkout' },
  ];
  res.json({ steps, complete: steps.every((x) => x.done), canLoadSamples: products < 3 });
}

// POST /api/stores/:storeId/onboarding/sample-data — only for an (almost) empty store.
async function loadSamples(req, res) {
  const { storeId } = req.params;
  const { rows } = await db.query('SELECT COUNT(*) AS n FROM products WHERE store_id = $1', [storeId]);
  if (Number(rows[0].n) >= 3) return res.status(400).json({ error: 'Sample products can only be added to a new store.' });
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    for (const p of SAMPLE_PRODUCTS) {
      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO products (id, store_id, name, sku, category, unit, cost_price, price_multiplier, reorder_level, pack_size)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
        [id, storeId, p.name, p.sku, p.category, p.unit, p.cost, p.price / p.cost, p.reorder, p.pack || 1]
      );
      await client.query(`INSERT INTO stock_movements (store_id, product_id, type, quantity, note, performed_by) VALUES ($1,$2,'arrival',$3,'Sample data',$4)`, [storeId, id, p.stock, req.user.sub]);
      await client.query(`INSERT INTO stock_movements (store_id, product_id, type, quantity, note, performed_by) VALUES ($1,$2,'transfer_to_shelf',$3,'Sample data',$4)`, [storeId, id, Math.ceil(p.stock / 2), req.user.sub]);
      await recomputeProductQuantities(client, id);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    return res.status(500).json({ error: 'Could not add sample products' });
  } finally {
    client.release();
  }
  res.status(201).json({ added: SAMPLE_PRODUCTS.length });
}

module.exports = { status, loadSamples };
