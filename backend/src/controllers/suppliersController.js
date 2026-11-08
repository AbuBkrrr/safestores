// ------------------------------------------------------------
// Supplier Performance Analytics for the standalone web edition.
// Postgres-flavored twin of desktop/server/controllers/suppliersController.js
// — aggregated in JS rather than SQL, same as the desktop version, so the
// two stay easy to compare line-by-line when one changes.
// ------------------------------------------------------------

const db = require('../config/db');

// GET /api/stores/:storeId/suppliers
async function listSuppliers(req, res) {
  const { storeId } = req.params;
  const { rows: suppliers } = await db.query('SELECT * FROM suppliers WHERE store_id = $1 ORDER BY name ASC', [storeId]);
  const { rows: orders } = await db.query('SELECT * FROM purchase_orders WHERE store_id = $1', [storeId]);

  const ordersBySupplier = new Map();
  for (const o of orders) {
    if (!o.supplier_id) continue;
    if (!ordersBySupplier.has(o.supplier_id)) ordersBySupplier.set(o.supplier_id, []);
    ordersBySupplier.get(o.supplier_id).push(o);
  }

  const result = suppliers.map((s) => {
    const os = ordersBySupplier.get(s.id) || [];
    const totalOrders = os.filter((o) => o.status === 'sent' || o.status === 'received').length;
    const received = os.filter((o) => o.status === 'received');
    const rated = received.filter((o) => o.expected_at);
    const onTime = rated.filter((o) => o.received_at <= o.expected_at);
    const totalSpend = received.reduce((sum, o) => sum + Number(o.total_cost), 0);
    return {
      ...s,
      total_orders: totalOrders,
      received_orders: received.length,
      on_time_orders: onTime.length,
      total_spend: totalSpend,
      on_time_rate: rated.length > 0 ? Math.round((onTime.length / rated.length) * 100) : null,
    };
  });
  res.json(result);
}

// POST /api/stores/:storeId/suppliers
async function createSupplier(req, res) {
  const { storeId } = req.params;
  const { name, contactName, phone, email, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const { rows: existing } = await db.query('SELECT id FROM suppliers WHERE store_id = $1 AND name = $2', [storeId, name]);
  if (existing[0]) return res.status(409).json({ error: 'A supplier with this name already exists' });

  const { rows } = await db.query(
    `INSERT INTO suppliers (store_id, name, contact_name, phone, email, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [storeId, name, contactName || null, phone || null, email || null, notes || null]
  );
  res.status(201).json(rows[0]);
}

// PATCH /api/stores/:storeId/suppliers/:id
async function updateSupplier(req, res) {
  const { storeId, id } = req.params;
  const { rows: existingRows } = await db.query('SELECT * FROM suppliers WHERE id = $1 AND store_id = $2', [id, storeId]);
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: 'Supplier not found' });

  const { name, contactName, phone, email, notes } = req.body;
  const { rows } = await db.query(
    `UPDATE suppliers SET name = $1, contact_name = $2, phone = $3, email = $4, notes = $5 WHERE id = $6 RETURNING *`,
    [name ?? existing.name, contactName ?? existing.contact_name, phone ?? existing.phone,
     email ?? existing.email, notes ?? existing.notes, id]
  );
  res.json(rows[0]);
}

// DELETE /api/stores/:storeId/suppliers/:id
async function deleteSupplier(req, res) {
  const { storeId, id } = req.params;
  // Products/POs referencing this supplier keep their free-text supplier
  // name (unaffected) but lose the normalized link (ON DELETE SET NULL) —
  // deleting a supplier never deletes purchase history.
  const { rowCount } = await db.query('DELETE FROM suppliers WHERE id = $1 AND store_id = $2', [id, storeId]);
  if (rowCount === 0) return res.status(404).json({ error: 'Supplier not found' });
  res.status(204).end();
}

/** Every product this supplier has priced, alongside its cheapest alternative supplier for that product. */
async function betterPricingAlertsFor(storeId, supplierId) {
  const { rows: items } = await db.query(
    `SELECT poi.product_id, poi.unit_cost, po.supplier_id, s.name AS supplier_name, p.name AS product_name
     FROM purchase_order_items poi
     JOIN purchase_orders po ON po.id = poi.purchase_order_id
     JOIN suppliers s ON s.id = po.supplier_id
     JOIN products p ON p.id = poi.product_id
     WHERE po.store_id = $1`,
    [storeId]
  );

  const groups = new Map(); // key: productId|supplierId -> { sum, count, productName, supplierName }
  for (const it of items) {
    const key = `${it.product_id}|${it.supplier_id}`;
    if (!groups.has(key)) groups.set(key, { sum: 0, count: 0, productName: it.product_name, supplierName: it.supplier_name });
    const g = groups.get(key);
    g.sum += Number(it.unit_cost); g.count += 1;
  }

  const byProduct = new Map();
  for (const [key, g] of groups) {
    const [productId, sId] = key.split('|');
    if (!byProduct.has(productId)) byProduct.set(productId, []);
    byProduct.get(productId).push({ supplierId: sId, avgCost: g.sum / g.count, supplierName: g.supplierName, productName: g.productName });
  }

  const alerts = [];
  for (const [, rows] of byProduct) {
    const thisRow = rows.find((r) => r.supplierId === supplierId);
    if (!thisRow) continue;
    const alternatives = rows.filter((r) => r.supplierId !== supplierId).sort((a, b) => a.avgCost - b.avgCost);
    if (alternatives.length === 0) continue;
    const cheapest = alternatives[0];
    if (cheapest.avgCost < thisRow.avgCost) {
      alerts.push({
        productName: thisRow.productName,
        thisSupplierCost: Math.round(thisRow.avgCost * 100) / 100,
        cheaperSupplierName: cheapest.supplierName,
        cheaperCost: Math.round(cheapest.avgCost * 100) / 100,
        savingsPct: Math.round((1 - cheapest.avgCost / thisRow.avgCost) * 1000) / 10,
      });
    }
  }
  return alerts;
}

// GET /api/stores/:storeId/suppliers/:id/performance
async function getSupplierPerformance(req, res) {
  const { storeId, id } = req.params;
  const { rows: supplierRows } = await db.query('SELECT * FROM suppliers WHERE id = $1 AND store_id = $2', [id, storeId]);
  const supplier = supplierRows[0];
  if (!supplier) return res.status(404).json({ error: 'Supplier not found' });

  const { rows: orders } = await db.query(
    `SELECT id, status, sent_at, expected_at, received_at, total_cost, auto_generated
     FROM purchase_orders WHERE store_id = $1 AND supplier_id = $2 ORDER BY created_at DESC`,
    [storeId, id]
  );

  const received = orders.filter((o) => o.status === 'received');
  const withExpectation = received.filter((o) => o.expected_at);
  const onTime = withExpectation.filter((o) => o.received_at <= o.expected_at);
  const late = withExpectation.filter((o) => o.received_at > o.expected_at);
  const avgLateDays = late.length
    ? late.reduce((sum, o) => sum + (new Date(o.received_at) - new Date(o.expected_at)) / 86400000, 0) / late.length
    : 0;

  res.json({
    supplier,
    totalOrders: orders.length,
    receivedOrders: received.length,
    onTimeOrders: onTime.length,
    lateOrders: late.length,
    onTimeRate: withExpectation.length ? Math.round((onTime.length / withExpectation.length) * 100) : null,
    avgLateDays: Math.round(avgLateDays * 10) / 10,
    totalSpend: received.reduce((sum, o) => sum + Number(o.total_cost), 0),
    recentOrders: orders.slice(0, 20),
    betterPricingAlerts: await betterPricingAlertsFor(storeId, id),
  });
}

// GET /api/stores/:storeId/suppliers/pricing-alerts
// Store-wide version — every product with 2+ known suppliers where one is
// cheaper than another.
async function listPricingAlerts(req, res) {
  const { storeId } = req.params;
  const { rows: items } = await db.query(
    `SELECT poi.product_id, poi.unit_cost, po.supplier_id, s.name AS supplier_name, p.name AS product_name
     FROM purchase_order_items poi
     JOIN purchase_orders po ON po.id = poi.purchase_order_id
     JOIN suppliers s ON s.id = po.supplier_id
     JOIN products p ON p.id = poi.product_id
     WHERE po.store_id = $1`,
    [storeId]
  );

  const groups = new Map();
  for (const it of items) {
    const key = `${it.product_id}|${it.supplier_id}`;
    if (!groups.has(key)) groups.set(key, { sum: 0, count: 0, productName: it.product_name, supplierName: it.supplier_name });
    const g = groups.get(key);
    g.sum += Number(it.unit_cost); g.count += 1;
  }

  const byProduct = new Map();
  for (const [key, g] of groups) {
    const [productId] = key.split('|');
    if (!byProduct.has(productId)) byProduct.set(productId, []);
    byProduct.get(productId).push({ avgCost: g.sum / g.count, supplierName: g.supplierName, productName: g.productName });
  }

  const alerts = [];
  for (const [productId, rows] of byProduct) {
    if (rows.length < 2) continue;
    const sorted = [...rows].sort((a, b) => a.avgCost - b.avgCost);
    const cheapest = sorted[0];
    const costliest = sorted[sorted.length - 1];
    if (costliest.avgCost > cheapest.avgCost) {
      alerts.push({
        productId,
        productName: cheapest.productName,
        cheapestSupplierName: cheapest.supplierName,
        cheapestCost: Math.round(cheapest.avgCost * 100) / 100,
        costliestCost: Math.round(costliest.avgCost * 100) / 100,
        savingsPct: Math.round((1 - cheapest.avgCost / costliest.avgCost) * 1000) / 10,
      });
    }
  }
  alerts.sort((a, b) => (b.costliestCost - b.cheapestCost) - (a.costliestCost - a.cheapestCost));
  res.json(alerts);
}

module.exports = {
  listSuppliers, createSupplier, updateSupplier, deleteSupplier,
  getSupplierPerformance, listPricingAlerts,
};
