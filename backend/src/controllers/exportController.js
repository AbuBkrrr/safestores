// ------------------------------------------------------------
// CSV/JSON data export for the standalone web edition. Postgres-flavored
// twin of desktop/server/controllers/exportController.js.
// ------------------------------------------------------------

const db = require('../config/db');
const { sendMail, isConfigured } = require('../utils/mailer');

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
             FROM products WHERE store_id = $1 ORDER BY name`,
  movements: `SELECT sm.type, sm.quantity, sm.note, sm.created_at, p.name AS product_name, p.sku
              FROM stock_movements sm JOIN products p ON p.id = sm.product_id
              WHERE sm.store_id = $1 ORDER BY sm.created_at DESC`,
  audits: `SELECT sa.counted_qty, sa.expected_qty, sa.discrepancy, sa.confidence_source, sa.created_at,
                   p.name AS product_name, p.sku
           FROM shelf_audits sa JOIN products p ON p.id = sa.product_id
           WHERE sa.store_id = $1 ORDER BY sa.created_at DESC`,
};

async function exportCsv(req, res) {
  const { storeId } = req.params;
  const { type } = req.query;

  if (type === 'full') {
    const [products, movements, audits] = await Promise.all([
      db.query(QUERIES.products, [storeId]),
      db.query(QUERIES.movements, [storeId]),
      db.query(QUERIES.audits, [storeId]),
    ]);
    const csv = [
      '# PRODUCTS', toCsv(products.rows),
      '', '# MOVEMENTS', toCsv(movements.rows),
      '', '# AUDITS', toCsv(audits.rows),
    ].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="safestores-full-export.csv"');
    return res.send(csv);
  }

  const query = QUERIES[type];
  if (!query) return res.status(400).json({ error: 'type must be products, movements, audits, or full' });

  const { rows } = await db.query(query, [storeId]);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="safestores-${type}.csv"`);
  res.send(toCsv(rows));
}

async function exportJson(req, res) {
  const { storeId } = req.params;
  // Table names are a fixed internal list, never user input, so this is
  // safe despite not being parameterizable the way a value would be.
  const tables = ['products', 'stock_arrivals', 'stock_movements', 'shelf_audits', 'receipts', 'invites', 'users'];
  const data = {};
  for (const table of tables) {
    const { rows } = await db.query(`SELECT * FROM ${table} WHERE store_id = $1`, [storeId]);
    data[table] = rows;
  }
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="safestores-backup.json"');
  res.json({ exportedAt: new Date().toISOString(), storeId, data });
}

// Real, server-sent email delivery of the same full-inventory snapshot
// shown on the Reports page — as opposed to the page's own "Email
// Report" button, which just opens the user's own mail client via a
// mailto: link. This actually sends via whatever SMTP provider is
// configured in .env (see utils/mailer.js), same infrastructure already
// used for support-ticket notifications. If SMTP isn't configured yet,
// sendMail() resolves false rather than throwing, and this responds with
// configured:false so the frontend can fall back to the mailto: flow
// instead of claiming a send that didn't happen.
async function emailReport(req, res) {
  const { storeId } = req.params;
  let to = req.body?.to;
  if (!to && req.user?.sub) {
    // req.user only carries { sub, storeId, role } from the JWT — look up
    // the requester's own email as a fallback when the frontend doesn't
    // supply one explicitly.
    const { rows } = await db.query('SELECT email FROM users WHERE id = $1', [req.user.sub]);
    to = rows[0]?.email;
  }
  if (!to) return res.status(400).json({ error: 'No recipient email address available' });

  const [summaryRes, lowStockRes, productsRes, currencyRes] = await Promise.all([
    db.query(
      `SELECT COUNT(*) AS count, COALESCE(SUM((backroom_qty + shelf_qty) * cost_price), 0) AS total_value
       FROM products WHERE store_id = $1`,
      [storeId]
    ),
    db.query(`SELECT COUNT(*) AS count FROM products WHERE store_id = $1 AND shelf_qty <= reorder_level`, [storeId]),
    db.query(QUERIES.products, [storeId]),
    db.query(`SELECT code, symbol FROM currency_settings WHERE id = $1`, ['default']),
  ]);

  const totalProducts = Number(summaryRes.rows[0].count);
  const totalStockValue = Number(summaryRes.rows[0].total_value);
  const lowStockCount = Number(lowStockRes.rows[0].count);
  const currencySymbol = currencyRes.rows[0]?.symbol || '';

  const dateStr = new Date().toISOString().slice(0, 10);
  const csv = toCsv(productsRes.rows);
  const text = [
    `SAFE Stores Report — ${dateStr}`,
    '',
    `Total Products: ${totalProducts}`,
    `Total Stock Value: ${currencySymbol}${totalStockValue.toLocaleString()}`,
    `Low Stock Items: ${lowStockCount}`,
    '',
    'Full inventory snapshot is attached as a CSV file.',
  ].join('\n');

  const sent = await sendMail({
    to,
    subject: `SAFE Stores Report — ${dateStr}`,
    text,
    attachments: [{ filename: `safestores-report-${dateStr}.csv`, content: csv }],
  });

  if (!sent) {
    return res.status(503).json({ error: 'Email is not configured on this server yet.', configured: isConfigured });
  }
  res.json({ sent: true, to });
}

module.exports = { exportCsv, exportJson, emailReport };
