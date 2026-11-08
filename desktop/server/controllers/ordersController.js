const crypto = require('crypto');
const db = require('../db');
const { recomputeProductQuantities } = require('../utils/stockMath');
const { dispatchEvent } = require('../utils/webhooks');
const { emitToStore } = require('../realtime');

// See backend/src/controllers/ordersController.js for the full rationale
// (this is the SQLite-flavored twin for the offline desktop edition).

function generateReceiptNumber() {
  return `RCPT-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

// body: { id? } — accepting a client-generated id (like every other write
// endpoint here) matters more for orders than most: when checkout runs
// offline, the frontend's outbox (see api/client.js) optimistically hands
// the page back the id it generated so addItem/pay/cancel calls can keep
// referencing this order in their URL path *before* the create request has
// actually reached the server. Without honoring that id, this used to
// always mint its own — so once the queued create finally replayed, every
// queued addItem/pay/cancel behind it in the outbox was still pointed at
// the old client-side id and would 404 against an order that, from the
// server's point of view, never existed under that id.
function createOrder(req, res) {
  const { storeId } = req.params;
  const id = req.body?.id || crypto.randomUUID();
  const existing = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (existing) return res.status(201).json(existing); // already applied — safe no-op
  db.prepare(`INSERT INTO orders (id, store_id, created_by) VALUES (?,?,?)`).run(id, storeId, req.user.sub);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  res.status(201).json(order);
  emitToStore(storeId, 'order:updated', order);
}

function listOrders(req, res) {
  const { storeId } = req.params;
  const { status } = req.query;
  const rows = status
    ? db.prepare(
        `SELECT o.*, u1.name AS created_by_name, u2.name AS paid_by_name FROM orders o
         LEFT JOIN users u1 ON u1.id = o.created_by LEFT JOIN users u2 ON u2.id = o.paid_by
         WHERE o.store_id = ? AND o.status = ? ORDER BY o.created_at DESC`
      ).all(storeId, status)
    : db.prepare(
        `SELECT o.*, u1.name AS created_by_name, u2.name AS paid_by_name FROM orders o
         LEFT JOIN users u1 ON u1.id = o.created_by LEFT JOIN users u2 ON u2.id = o.paid_by
         WHERE o.store_id = ? ORDER BY o.created_at DESC`
      ).all(storeId);
  res.json(rows);
}

function getOrder(req, res) {
  const { storeId, orderId } = req.params;
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND store_id = ?').get(orderId, storeId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const items = db.prepare(
    `SELECT oi.*, p.name AS product_name, p.sku FROM order_items oi
     JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ? ORDER BY oi.created_at ASC`
  ).all(orderId);
  res.json({ ...order, items });
}

function recalcOrderTotals(orderId) {
  const { subtotal } = db.prepare('SELECT COALESCE(SUM(line_total), 0) AS subtotal FROM order_items WHERE order_id = ?').get(orderId);
  db.prepare('UPDATE orders SET subtotal = ?, total = ? WHERE id = ?').run(subtotal, subtotal, orderId);
}

function addItem(req, res) {
  const { storeId, orderId } = req.params;
  const { id, productId, quantity, addedVia } = req.body;
  if (!productId || !quantity || quantity <= 0) return res.status(400).json({ error: 'productId and a positive quantity are required' });

  if (id) {
    const existing = db.prepare('SELECT * FROM order_items WHERE id = ?').get(id);
    if (existing) {
      return res.status(201).json({ item: existing, order: db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) });
    }
  }

  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND store_id = ?').get(orderId, storeId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'pending_payment') return res.status(400).json({ error: `Order is already ${order.status}` });

  const product = db.prepare('SELECT * FROM products WHERE id = ? AND store_id = ?').get(productId, storeId);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  if (product.shelf_qty < quantity) return res.status(400).json({ error: `Only ${product.shelf_qty} on the shelf — not enough stock for this quantity` });

  const unitPrice = Number(product.cost_price) * Number(product.price_multiplier);
  const lineTotal = Math.round(unitPrice * quantity * 100) / 100;
  const movementId = crypto.randomUUID();
  const itemId = id || crypto.randomUUID();

  db.transaction(() => {
    db.prepare(
      `INSERT INTO stock_movements (id, store_id, product_id, type, quantity, note, performed_by) VALUES (?,?,?,'sale',?, 'POS checkout', ?)`
    ).run(movementId, storeId, productId, quantity, req.user.sub);
    recomputeProductQuantities(db, productId);
    db.prepare(
      `INSERT INTO order_items (id, order_id, product_id, quantity, unit_price, line_total, added_via, movement_id) VALUES (?,?,?,?,?,?,?,?)`
    ).run(itemId, orderId, productId, quantity, unitPrice, lineTotal, addedVia || 'scan', movementId);
    recalcOrderTotals(orderId);
  })();

  res.status(201).json({
    item: db.prepare('SELECT * FROM order_items WHERE id = ?').get(itemId),
    order: db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId),
  });
  emitToStore(storeId, 'order:updated', db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId));
}

function removeItem(req, res) {
  const { storeId, orderId, itemId } = req.params;
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND store_id = ?').get(orderId, storeId);
  if (!order || order.status !== 'pending_payment') return res.status(400).json({ error: 'Order not found or no longer pending' });
  const item = db.prepare('SELECT * FROM order_items WHERE id = ? AND order_id = ?').get(itemId, orderId);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  db.transaction(() => {
    db.prepare(
      `INSERT INTO stock_movements (id, store_id, product_id, type, quantity, note, performed_by) VALUES (?,?,?,'adjustment',?, 'Removed from POS order before payment', ?)`
    ).run(crypto.randomUUID(), storeId, item.product_id, item.quantity, req.user.sub);
    recomputeProductQuantities(db, item.product_id);
    db.prepare('DELETE FROM order_items WHERE id = ?').run(itemId);
    recalcOrderTotals(orderId);
  })();

  const updatedOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  res.json(updatedOrder);
  emitToStore(storeId, 'order:updated', updatedOrder);
  emitToStore(storeId, 'product:updated', db.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id));
}

// See backend/src/controllers/ordersController.js's payOrder for the
// storeCustomerId/credit rationale — mirrored here so a credit sale
// (paymentMethod: 'credit') at desktop checkout actually posts a
// customer_ledger_entries row instead of silently doing nothing, which
// is what happened before customer credit tracking had a desktop
// backend at all (see customersController.js's header).
function payOrder(req, res) {
  const { storeId, orderId } = req.params;
  const { paymentMethod, storeCustomerId } = req.body;

  if (paymentMethod === 'credit' && !storeCustomerId) {
    return res.status(400).json({ error: 'storeCustomerId is required when paymentMethod is credit' });
  }
  if (storeCustomerId) {
    const customer = db.prepare('SELECT id FROM store_customers WHERE id = ? AND store_id = ? AND archived_at IS NULL').get(storeCustomerId, storeId);
    if (!customer) return res.status(400).json({ error: 'storeCustomerId does not refer to an active customer of this store' });
  }

  const receiptNumber = generateReceiptNumber();
  const result = db.transaction(() => {
    const upd = db.prepare(
      `UPDATE orders SET status = 'paid', paid_by = ?, paid_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), payment_method = ?, receipt_number = ?
       WHERE id = ? AND store_id = ? AND status = 'pending_payment'`
    ).run(req.user.sub, paymentMethod || 'cash', receiptNumber, orderId, storeId);
    if (upd.changes === 0) return null;
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (paymentMethod === 'credit' && storeCustomerId) {
      db.prepare(
        `INSERT INTO customer_ledger_entries (id, store_id, store_customer_id, type, amount, order_id, note, recorded_by)
         VALUES (?,?,?,'credit_sale',?,?,?,?)`
      ).run(crypto.randomUUID(), storeId, storeCustomerId, order.total, order.id, `Receipt ${order.receipt_number}`, req.user.sub);
    }
    return order;
  })();

  if (!result) return res.status(400).json({ error: 'Order not found or already resolved' });
  res.json(result);
  emitToStore(storeId, 'order:paid', result);
  if (storeCustomerId) emitToStore(storeId, 'customer:payment', { customerId: storeCustomerId });
  dispatchEvent(storeId, 'order.paid', { orderId, total: result.total, paymentMethod: result.payment_method });
}

function cancelOrder(req, res) {
  const { storeId, orderId } = req.params;
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND store_id = ?').get(orderId, storeId);
  if (!order || order.status !== 'pending_payment') return res.status(400).json({ error: 'Order not found or no longer pending' });

  db.transaction(() => {
    const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
    for (const item of items) {
      db.prepare(
        `INSERT INTO stock_movements (id, store_id, product_id, type, quantity, note, performed_by) VALUES (?,?,?,'adjustment',?, 'POS order cancelled', ?)`
      ).run(crypto.randomUUID(), storeId, item.product_id, item.quantity, req.user.sub);
      recomputeProductQuantities(db, item.product_id);
    }
    db.prepare(`UPDATE orders SET status = 'cancelled', cancelled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(orderId);
  })();

  res.json({ message: 'Order cancelled, stock restored' });
  emitToStore(storeId, 'order:cancelled', db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId));
  for (const item of db.prepare('SELECT DISTINCT product_id FROM order_items WHERE order_id = ?').all(orderId)) {
    emitToStore(storeId, 'product:updated', db.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id));
  }
}

module.exports = { createOrder, listOrders, getOrder, addItem, removeItem, payOrder, cancelOrder };
