// ------------------------------------------------------------
// Supplier Performance Analytics — desktop/SQLite counterpart of
// backend/src/controllers/suppliersController.js. Same metrics, same
// definitions (see that file's header for the reasoning), but aggregated
// in JS rather than SQL FILTER/window-function clauses — this app's other
// SQLite controllers all follow that pattern already (see
// replenishmentController.js, batchesController.js), so this stays
// consistent with them rather than betting on newer SQLite features.
// ------------------------------------------------------------

const crypto = require('crypto');
const db = require('../db');

// GET /api/stores/:storeId/suppliers
function listSuppliers(req, res) {
  const { storeId } = req.params;
  const suppliers = db.prepare('SELECT * FROM suppliers WHERE store_id = ? ORDER BY name ASC').all(storeId);
  const orders = db.prepare('SELECT * FROM purchase_orders WHERE store_id = ?').all(storeId);

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
function createSupplier(req, res) {
  const { storeId } = req.params;
  const { name, contactName, phone, email, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const existing = db.prepare('SELECT id FROM suppliers WHERE store_id = ? AND name = ?').get(storeId, name);
  if (existing) return res.status(409).json({ error: 'A supplier with this name already exists' });

  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO suppliers (id, store_id, name, contact_name, phone, email, notes)
     VALUES (?,?,?,?,?,?,?)`
  ).run(id, storeId, name, contactName || null, phone || null, email || null, notes || null);
  res.status(201).json(db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id));
}

// PATCH /api/stores/:storeId/suppliers/:id
function updateSupplier(req, res) {
  const { storeId, id } = req.params;
  const existing = db.prepare('SELECT * FROM suppliers WHERE id = ? AND store_id = ?').get(id, storeId);
  if (!existing) return res.status(404).json({ error: 'Supplier not found' });

  const { name, contactName, phone, email, notes } = req.body;
  db.prepare(
    `UPDATE suppliers SET name = ?, contact_name = ?, phone = ?, email = ?, notes = ? WHERE id = ?`
  ).run(
    name ?? existing.name, contactName ?? existing.contact_name, phone ?? existing.phone,
    email ?? existing.email, notes ?? existing.notes, id
  );
  res.json(db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id));
}

// DELETE /api/stores/:storeId/suppliers/:id
function deleteSupplier(req, res) {
  const { storeId, id } = req.params;
  // Products/POs referencing this supplier keep their free-text supplier
  // name (unaffected) but lose the normalized link (ON DELETE SET NULL) —
  // deleting a supplier never deletes purchase history.
  const result = db.prepare('DELETE FROM suppliers WHERE id = ? AND store_id = ?').run(id, storeId);
  if (result.changes === 0) return res.status(404).json({ error: 'Supplier not found' });
  res.status(204).end();
}

/** Every product this supplier has priced, alongside its cheapest alternative supplier for that product. */
function betterPricingAlertsFor(storeId, supplierId) {
  const items = db.prepare(
    `SELECT poi.product_id, poi.unit_cost, po.supplier_id, s.name AS supplier_name, p.name AS product_name
     FROM purchase_order_items poi
     JOIN purchase_orders po ON po.id = poi.purchase_order_id
     JOIN suppliers s ON s.id = po.supplier_id
     JOIN products p ON p.id = poi.product_id
     WHERE po.store_id = ?`
  ).all(storeId);

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
function getSupplierPerformance(req, res) {
  const { storeId, id } = req.params;
  const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ? AND store_id = ?').get(id, storeId);
  if (!supplier) return res.status(404).json({ error: 'Supplier not found' });

  const orders = db.prepare(
    `SELECT id, status, sent_at, expected_at, received_at, total_cost, auto_generated
     FROM purchase_orders WHERE store_id = ? AND supplier_id = ? ORDER BY created_at DESC`
  ).all(storeId, id);

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
    betterPricingAlerts: betterPricingAlertsFor(storeId, id),
  });
}

// GET /api/stores/:storeId/suppliers/pricing-alerts
// Store-wide version — every product with 2+ known suppliers where one is
// cheaper than another.
function listPricingAlerts(req, res) {
  const { storeId } = req.params;
  const items = db.prepare(
    `SELECT poi.product_id, poi.unit_cost, po.supplier_id, s.name AS supplier_name, p.name AS product_name
     FROM purchase_order_items poi
     JOIN purchase_orders po ON po.id = poi.purchase_order_id
     JOIN suppliers s ON s.id = po.supplier_id
     JOIN products p ON p.id = poi.product_id
     WHERE po.store_id = ?`
  ).all(storeId);

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
