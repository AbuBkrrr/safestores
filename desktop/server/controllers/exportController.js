const db = require('../db');

function toCsv(rows) {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map((h) => escape(row[h])).join(','));
  return lines.join('\n');
}

const QUERIES = {
  products: `SELECT name, sku, category, supplier, unit, cost_price, price_multiplier,
                    backroom_qty, shelf_qty, sold_qty, damaged_qty
             FROM products WHERE store_id = ? ORDER BY name`,
  movements: `SELECT sm.type, sm.quantity, sm.note, sm.created_at, p.name AS product_name, p.sku
              FROM stock_movements sm JOIN products p ON p.id = sm.product_id
              WHERE sm.store_id = ? ORDER BY sm.created_at DESC`,
  audits: `SELECT sa.counted_qty, sa.expected_qty, sa.discrepancy, sa.confidence_source, sa.created_at,
                   p.name AS product_name, p.sku
           FROM shelf_audits sa JOIN products p ON p.id = sa.product_id
           WHERE sa.store_id = ? ORDER BY sa.created_at DESC`,
};

function exportCsv(req, res) {
  const { storeId } = req.params;
  const { type } = req.query;

  if (type === 'full') {
    const csv = [
      '# PRODUCTS', toCsv(db.prepare(QUERIES.products).all(storeId)),
      '', '# MOVEMENTS', toCsv(db.prepare(QUERIES.movements).all(storeId)),
      '', '# AUDITS', toCsv(db.prepare(QUERIES.audits).all(storeId)),
    ].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="safestores-full-export.csv"');
    return res.send(csv);
  }

  const query = QUERIES[type];
  if (!query) return res.status(400).json({ error: 'type must be products, movements, audits, or full' });

  const rows = db.prepare(query).all(storeId);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="safestores-${type}.csv"`);
  res.send(toCsv(rows));
}

function exportJson(req, res) {
  const { storeId } = req.params;
  const tables = ['products', 'stock_arrivals', 'stock_movements', 'shelf_audits', 'receipts', 'invites', 'users'];
  const data = {};
  for (const table of tables) {
    data[table] = db.prepare(`SELECT * FROM ${table} WHERE store_id = ?`).all(storeId);
  }
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="safestores-backup.json"');
  res.json({ exportedAt: new Date().toISOString(), storeId, data });
}

module.exports = { exportCsv, exportJson };
