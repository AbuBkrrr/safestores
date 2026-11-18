// Desktop twin of backend/src/controllers/onboardingController.js.
const crypto = require('crypto');
const db = require('../db');
const { recomputeProductQuantities } = require('../utils/stockMath');
const { SAMPLE_PRODUCTS } = require('../utils/sampleProducts');

function status(req, res) {
  const { storeId } = req.params;
  const n = (sql) => db.prepare(sql).get(storeId).n;
  const products = n('SELECT COUNT(*) AS n FROM products WHERE store_id = ? AND archived_at IS NULL');
  const onShelf = n('SELECT COUNT(*) AS n FROM products WHERE store_id = ? AND shelf_qty > 0');
  const staff = n(`SELECT COUNT(*) AS n FROM users WHERE store_id = ? AND role <> 'admin'`);
  const sales = n(`SELECT COUNT(*) AS n FROM orders WHERE store_id = ? AND status = 'paid'`);
  const st = db.prepare('SELECT phone, address, receipt_footer, currency_code FROM stores WHERE id = ?').get(storeId) || {};
  const steps = [
    { key: 'settings', done: !!(st.phone || st.address || st.receipt_footer || st.currency_code), to: '/settings' },
    { key: 'products', done: products > 0, to: '/products/import' },
    { key: 'shelf', done: onShelf > 0, to: '/movements' },
    { key: 'staff', done: staff > 0, to: '/invites' },
    { key: 'sale', done: sales > 0, to: '/checkout' },
  ];
  res.json({ steps, complete: steps.every((x) => x.done), canLoadSamples: products < 3 });
}

function loadSamples(req, res) {
  const { storeId } = req.params;
  if (db.prepare('SELECT COUNT(*) AS n FROM products WHERE store_id = ?').get(storeId).n >= 3) {
    return res.status(400).json({ error: 'Sample products can only be added to a new store.' });
  }
  db.transaction(() => {
    for (const p of SAMPLE_PRODUCTS) {
      if (db.prepare('SELECT 1 FROM products WHERE store_id = ? AND sku = ?').get(storeId, p.sku)) continue;
      const id = crypto.randomUUID();
      db.prepare(`INSERT INTO products (id, store_id, name, sku, category, unit, cost_price, price_multiplier, reorder_level, pack_size) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(id, storeId, p.name, p.sku, p.category, p.unit, p.cost, p.price / p.cost, p.reorder, p.pack || 1);
      db.prepare(`INSERT INTO stock_movements (id, store_id, product_id, type, quantity, note, performed_by) VALUES (?,?,?,'arrival',?,'Sample data',?)`)
        .run(crypto.randomUUID(), storeId, id, p.stock, req.user.sub);
      db.prepare(`INSERT INTO stock_movements (id, store_id, product_id, type, quantity, note, performed_by) VALUES (?,?,?,'transfer_to_shelf',?,'Sample data',?)`)
        .run(crypto.randomUUID(), storeId, id, Math.ceil(p.stock / 2), req.user.sub);
      recomputeProductQuantities(db, id);
    }
  })();
  res.status(201).json({ added: SAMPLE_PRODUCTS.length });
}

module.exports = { status, loadSamples };
