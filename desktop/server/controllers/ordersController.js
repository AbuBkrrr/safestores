const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { recomputeProductQuantities } = require('../utils/stockMath');
const { dispatchEvent } = require('../utils/webhooks');
const { emitToStore } = require('../realtime');
const { computeTotals, discountPercentOf, refundAmountFor, allocatePayments, r2, PAYMENT_METHODS } = require('../utils/pricing');
const { logActivity } = require('../utils/activityLog');
const { localDate, utcWindowFor } = require('../utils/tz');

// See backend/src/controllers/ordersController.js for the full rationale
// (this is the SQLite-flavored twin for the offline desktop edition).
// Booleans are stored as INTEGER 0/1 here; outputs normalise them.

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

function generateReceiptNumber() {
  return `RCPT-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

function openShiftFor(storeId, userId) {
  return db.prepare(`SELECT id FROM shifts WHERE store_id = ? AND opened_by = ? AND status = 'open'`).get(storeId, userId)?.id || null;
}

function normalize(order) {
  if (!order) return order;
  return { ...order, tax_inclusive: order.tax_inclusive === 1 || order.tax_inclusive === true };
}

// body: { id? } — accepting a client-generated id (like every other write
// endpoint here) matters more for orders than most: when checkout runs
// offline, the frontend's outbox (see api/client.js) optimistically hands
// the page back the id it generated so addItem/pay/cancel calls can keep
// referencing this order in their URL path *before* the create request has
// actually reached the server.
function createOrder(req, res) {
  const { storeId } = req.params;
  const id = req.body?.id || crypto.randomUUID();
  const existing = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (existing) return res.status(201).json(normalize(existing)); // already applied — safe no-op
  const store = db.prepare('SELECT tax_rate_pct, tax_inclusive FROM stores WHERE id = ?').get(storeId) || {};
  db.prepare(
    `INSERT INTO orders (id, store_id, created_by, tax_rate_pct, tax_inclusive, shift_id, parked_label) VALUES (?,?,?,?,?,?,?)`
  ).run(id, storeId, req.user.sub, store.tax_rate_pct || 0, store.tax_inclusive === 0 ? 0 : 1, openShiftFor(storeId, req.user.sub),
    req.body?.label ? String(req.body.label).slice(0, 80) : null);
  const order = normalize(db.prepare('SELECT * FROM orders WHERE id = ?').get(id));
  res.status(201).json(order);
  emitToStore(storeId, 'order:updated', order);
}

// GET ?status=&q=&from=&to=&limit=&offset=  (from/to in the store's time zone)
function listOrders(req, res) {
  const { storeId } = req.params;
  const { status, q, from, to } = req.query;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const where = ['o.store_id = ?']; const params = [storeId];
  if (status) { where.push('o.status = ?'); params.push(status); }
  if (q) { where.push('o.receipt_number LIKE ?'); params.push(`%${String(q).trim().toUpperCase()}%`); }
  if (from) { where.push('COALESCE(o.paid_at, o.created_at) >= ?'); params.push(utcWindowFor(from)[0]); }
  if (to) { where.push('COALESCE(o.paid_at, o.created_at) <= ?'); params.push(utcWindowFor(to)[1]); }
  let rows = db.prepare(
    `SELECT o.*, u1.name AS created_by_name, u2.name AS paid_by_name,
            (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count
     FROM orders o LEFT JOIN users u1 ON u1.id = o.created_by LEFT JOIN users u2 ON u2.id = o.paid_by
     WHERE ${where.join(' AND ')} ORDER BY o.created_at DESC`
  ).all(...params);
  if (from || to) {
    const tz = db.prepare('SELECT timezone FROM stores WHERE id = ?').get(storeId)?.timezone || 'UTC';
    rows = rows.filter((o) => {
      const d = localDate(o.paid_at || o.created_at, tz);
      return (!from || d >= from) && (!to || d <= to);
    });
  }
  res.json(rows.slice(offset, offset + limit).map(normalize));
}

function loadReceipt(order) {
  const items = db.prepare(
    `SELECT oi.*, p.name AS product_name, p.sku,
            COALESCE((SELECT SUM(ri.quantity) FROM refund_items ri WHERE ri.order_item_id = oi.id), 0) AS refunded_qty
     FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ? ORDER BY oi.created_at ASC`
  ).all(order.id);
  const payments = db.prepare('SELECT method, amount, reference, created_at FROM order_payments WHERE order_id = ? ORDER BY created_at').all(order.id);
  const refunds = db.prepare(
    'SELECT r.*, u.name AS created_by_name FROM refunds r LEFT JOIN users u ON u.id = r.created_by WHERE r.order_id = ? ORDER BY r.created_at'
  ).all(order.id);
  const store = db.prepare(
    `SELECT s.name, s.address, s.city, s.phone, s.tax_label, s.tax_number, s.receipt_header, s.receipt_footer, s.timezone,
            COALESCE(s.currency_code, c.code) AS currency_code, COALESCE(s.currency_symbol, c.symbol) AS currency_symbol
     FROM stores s LEFT JOIN currency_settings c ON c.id = 'default' WHERE s.id = ?`
  ).get(order.store_id) || null;
  const cashier = db.prepare('SELECT name FROM users WHERE id = ?').get(order.paid_by || order.created_by);
  return { ...normalize(order), items, payments, refunds, store, cashier_name: cashier?.name || null };
}

function getOrder(req, res) {
  const { storeId, orderId } = req.params;
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND store_id = ?').get(orderId, storeId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json(loadReceipt(order));
}

function recalcOrderTotals(orderId) {
  const { subtotal } = db.prepare('SELECT COALESCE(SUM(line_total), 0) AS subtotal FROM order_items WHERE order_id = ?').get(orderId);
  const o = db.prepare('SELECT discount_type, discount_value, tax_rate_pct, tax_inclusive FROM orders WHERE id = ?').get(orderId);
  const t = computeTotals({
    subtotal, discountType: o.discount_type, discountValue: o.discount_value, taxRatePct: o.tax_rate_pct, taxInclusive: o.tax_inclusive !== 0,
  });
  db.prepare('UPDATE orders SET subtotal = ?, discount_amount = ?, tax_amount = ?, total = ? WHERE id = ?')
    .run(t.subtotal, t.discountAmount, t.taxAmount, t.total, orderId);
}

function addItem(req, res) {
  const { storeId, orderId } = req.params;
  const { id, productId, quantity, addedVia } = req.body;
  if (!productId || !quantity || quantity <= 0) return res.status(400).json({ error: 'productId and a positive quantity are required' });

  if (id) {
    const existing = db.prepare('SELECT * FROM order_items WHERE id = ?').get(id);
    if (existing) {
      return res.status(201).json({ item: existing, order: normalize(db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId)) });
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

  const updated = normalize(db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId));
  res.status(201).json({ item: db.prepare('SELECT * FROM order_items WHERE id = ?').get(itemId), order: updated });
  emitToStore(storeId, 'order:updated', updated);
}

// Removing an item / cancelling uses a 'return' movement (shelf +, sold −)
// so the product's sold count stays truthful.
function removeItem(req, res) {
  const { storeId, orderId, itemId } = req.params;
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND store_id = ?').get(orderId, storeId);
  if (!order || order.status !== 'pending_payment') return res.status(400).json({ error: 'Order not found or no longer pending' });
  const item = db.prepare('SELECT * FROM order_items WHERE id = ? AND order_id = ?').get(itemId, orderId);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  db.transaction(() => {
    db.prepare(
      `INSERT INTO stock_movements (id, store_id, product_id, type, quantity, note, performed_by) VALUES (?,?,?,'return',?, 'Removed from POS order before payment', ?)`
    ).run(crypto.randomUUID(), storeId, item.product_id, item.quantity, req.user.sub);
    recomputeProductQuantities(db, item.product_id);
    db.prepare('DELETE FROM order_items WHERE id = ?').run(itemId);
    recalcOrderTotals(orderId);
  })();

  const updatedOrder = normalize(db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId));
  res.json(updatedOrder);
  emitToStore(storeId, 'order:updated', updatedOrder);
  emitToStore(storeId, 'product:updated', db.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id));
}

// body (new): { payments: [{ method, amount, reference? }], storeCustomerId? }
// body (legacy): { paymentMethod, storeCustomerId? }
function payOrder(req, res) {
  const { storeId, orderId } = req.params;
  const { paymentMethod } = req.body || {};
  const storeCustomerId = req.body?.storeCustomerId || req.body?.payments?.find((p) => p.storeCustomerId)?.storeCustomerId || null;

  const pending = db.prepare('SELECT * FROM orders WHERE id = ? AND store_id = ?').get(orderId, storeId);
  if (!pending || pending.status !== 'pending_payment') return res.status(400).json({ error: 'Order not found or already resolved' });

  const store = db.prepare('SELECT require_shift FROM stores WHERE id = ?').get(storeId) || {};
  const shiftId = openShiftFor(storeId, req.user.sub);
  if (store.require_shift && !shiftId) {
    return res.status(400).json({ error: 'Open a shift before taking payments (Checkout → Open shift).', code: 'SHIFT_REQUIRED' });
  }

  const tenders = Array.isArray(req.body?.payments) && req.body.payments.length
    ? req.body.payments.map((p) => ({ method: p.method, amount: Number(p.amount), reference: p.reference ? String(p.reference).slice(0, 120) : null }))
    : [{ method: paymentMethod || 'cash', amount: Number(pending.total), reference: null }];

  if (tenders.some((t) => t.method === 'credit') && !storeCustomerId) {
    return res.status(400).json({ error: 'storeCustomerId is required when paymentMethod is credit' });
  }
  if (storeCustomerId) {
    const customer = db.prepare('SELECT id FROM store_customers WHERE id = ? AND store_id = ? AND archived_at IS NULL').get(storeCustomerId, storeId);
    if (!customer) return res.status(400).json({ error: 'storeCustomerId does not refer to an active customer of this store' });
  }

  let alloc;
  if (Number(pending.total) === 0 && !req.body?.payments) alloc = { ok: true, applied: [], tendered: 0, change: 0 };
  else {
    alloc = allocatePayments(pending.total, tenders);
    if (!alloc.ok) return res.status(400).json({ error: alloc.error });
  }
  const methodLabel = tenders.length > 1 ? 'split' : tenders[0].method;

  const result = db.transaction(() => {
    const upd = db.prepare(
      `UPDATE orders SET status = 'paid', paid_by = ?, paid_at = ${NOW}, payment_method = ?, receipt_number = ?,
         amount_tendered = ?, change_due = ?, shift_id = COALESCE(?, shift_id), store_customer_id = ?, public_token = ?
       WHERE id = ? AND store_id = ? AND status = 'pending_payment'`
    ).run(req.user.sub, methodLabel, generateReceiptNumber(), alloc.tendered, alloc.change, shiftId, storeCustomerId,
      crypto.randomBytes(12).toString('base64url'), orderId, storeId);
    if (upd.changes === 0) return null;
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    for (const p of alloc.applied) {
      db.prepare('INSERT INTO order_payments (id, order_id, store_id, method, amount, reference, shift_id) VALUES (?,?,?,?,?,?,?)')
        .run(crypto.randomUUID(), orderId, storeId, p.method, p.amount, p.reference, shiftId);
    }
    const credit = r2(alloc.applied.filter((p) => p.method === 'credit').reduce((s, p) => s + p.amount, 0));
    if (credit > 0) {
      db.prepare(
        `INSERT INTO customer_ledger_entries (id, store_id, store_customer_id, type, amount, order_id, note, recorded_by)
         VALUES (?,?,?,'credit_sale',?,?,?,?)`
      ).run(crypto.randomUUID(), storeId, storeCustomerId, credit, order.id, `Receipt ${order.receipt_number}`, req.user.sub);
    }
    return normalize(order);
  })();

  if (!result) return res.status(400).json({ error: 'Order not found or already resolved' });
  res.json({ ...result, payments: alloc.applied });
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
        `INSERT INTO stock_movements (id, store_id, product_id, type, quantity, note, performed_by) VALUES (?,?,?,'return',?, 'POS order cancelled', ?)`
      ).run(crypto.randomUUID(), storeId, item.product_id, item.quantity, req.user.sub);
      recomputeProductQuantities(db, item.product_id);
    }
    db.prepare(`UPDATE orders SET status = 'cancelled', cancelled_at = ${NOW} WHERE id = ?`).run(orderId);
  })();

  res.json({ message: 'Order cancelled, stock restored' });
  emitToStore(storeId, 'order:cancelled', normalize(db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId)));
  for (const item of db.prepare('SELECT DISTINCT product_id FROM order_items WHERE order_id = ?').all(orderId)) {
    emitToStore(storeId, 'product:updated', db.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id));
  }
}

// POST /orders/:orderId/discount { type, value, reason?, approverEmail?, approverPassword? }
async function applyDiscount(req, res) {
  const { storeId, orderId } = req.params;
  const { type = null, reason = null, approverEmail, approverPassword } = req.body || {};
  const value = Number(req.body?.value) || 0;
  if (type !== null && !['percent', 'amount'].includes(type)) return res.status(400).json({ error: 'type must be percent or amount' });
  if (value < 0 || (type === 'percent' && value > 100)) return res.status(400).json({ error: 'Invalid discount value' });
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND store_id = ?').get(orderId, storeId);
  if (!order || order.status !== 'pending_payment') return res.status(400).json({ error: 'Order not found or no longer pending' });

  const clearing = !type || value === 0;
  let approvedBy = null;
  if (!clearing) {
    const pct = discountPercentOf({ subtotal: order.subtotal, discountType: type, discountValue: value });
    const limit = Number(db.prepare('SELECT max_cashier_discount_pct FROM stores WHERE id = ?').get(storeId)?.max_cashier_discount_pct ?? 10);
    const selfApproves = ['admin', 'manager'].includes(req.user.role);
    if (!selfApproves && pct > limit + 1e-9) {
      if (!approverEmail || !approverPassword) {
        return res.status(403).json({ error: `Discounts above ${limit}% need a manager's approval.`, code: 'DISCOUNT_APPROVAL_REQUIRED', limit });
      }
      const approvers = db.prepare(
        `SELECT id, password_hash FROM users WHERE store_id = ? AND lower(email) = lower(?) AND role IN ('admin','manager') AND status = 'active' AND password_hash IS NOT NULL`
      ).all(storeId, approverEmail);
      let approver = null;
      for (const a of approvers) {
        // eslint-disable-next-line no-await-in-loop
        if (await bcrypt.compare(String(approverPassword), a.password_hash)) { approver = a; break; }
      }
      if (!approver) return res.status(403).json({ error: 'Manager approval failed — check the email and password.', code: 'DISCOUNT_APPROVAL_FAILED' });
      approvedBy = approver.id;
    } else if (selfApproves) approvedBy = req.user.sub;
  }

  db.transaction(() => {
    db.prepare('UPDATE orders SET discount_type = ?, discount_value = ?, discount_reason = ?, discount_approved_by = ? WHERE id = ?')
      .run(clearing ? null : type, clearing ? 0 : value, clearing ? null : (reason ? String(reason).slice(0, 200) : null), approvedBy, orderId);
    recalcOrderTotals(orderId);
  })();
  const updated = normalize(db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId));
  res.json(updated);
  logActivity(req, {
    storeId, action: clearing ? 'order.discount_removed' : 'order.discount_applied', entityType: 'order', entityId: orderId,
    details: clearing ? {} : { type, value, amount: updated.discount_amount, reason, approvedBy },
  });
  emitToStore(storeId, 'order:updated', updated);
}

function parkOrder(req, res) {
  const { storeId, orderId } = req.params;
  const label = req.body?.label ? String(req.body.label).slice(0, 80) : null;
  const upd = db.prepare(`UPDATE orders SET parked_label = ? WHERE id = ? AND store_id = ? AND status = 'pending_payment'`).run(label, orderId, storeId);
  if (!upd.changes) return res.status(400).json({ error: 'Order not found or no longer pending' });
  const order = normalize(db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId));
  res.json(order);
  emitToStore(storeId, 'order:updated', order);
}

// POST /orders/:orderId/refunds { items: [{ orderItemId, quantity, restock }], method, reason }
function refundOrder(req, res) {
  const { storeId, orderId } = req.params;
  const { items = [], method = 'cash', reason = null } = req.body || {};
  if (!PAYMENT_METHODS.includes(method)) return res.status(400).json({ error: 'Invalid refund method' });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Choose at least one item to refund' });

  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND store_id = ?').get(orderId, storeId);
  if (!order || order.status !== 'paid') return res.status(400).json({ error: 'Only paid sales can be refunded' });
  if (method === 'credit' && !order.store_customer_id) return res.status(400).json({ error: 'Store-credit refunds need a sale linked to a customer' });

  const lines = [];
  let total = 0;
  for (const it of items) {
    const qty = parseInt(it.quantity, 10);
    if (!(qty > 0)) return res.status(400).json({ error: 'Each refund quantity must be at least 1' });
    const line = db.prepare(
      `SELECT oi.*, COALESCE((SELECT SUM(ri.quantity) FROM refund_items ri WHERE ri.order_item_id = oi.id), 0) AS refunded_qty
       FROM order_items oi WHERE oi.id = ? AND oi.order_id = ?`
    ).get(it.orderItemId, orderId);
    if (!line) return res.status(404).json({ error: 'Item not found on this sale' });
    if (qty > line.quantity - line.refunded_qty) return res.status(400).json({ error: `Only ${line.quantity - line.refunded_qty} of that item can still be refunded` });
    const amount = refundAmountFor({ lineTotal: line.line_total, lineQty: line.quantity, qty, orderSubtotal: order.subtotal, orderTotal: order.total });
    total = r2(total + amount);
    lines.push({ line, qty, amount, restock: it.restock !== false });
  }
  if (total > r2(Number(order.total) - Number(order.refunded_total)) + 0.01) return res.status(400).json({ error: 'Refund is more than what is left on this sale' });

  const refundId = crypto.randomUUID();
  const shiftId = openShiftFor(storeId, req.user.sub);
  db.transaction(() => {
    db.prepare('INSERT INTO refunds (id, order_id, store_id, amount, method, reason, created_by, shift_id) VALUES (?,?,?,?,?,?,?,?)')
      .run(refundId, orderId, storeId, total, method, reason ? String(reason).slice(0, 300) : null, req.user.sub, shiftId);
    for (const { line, qty, amount, restock } of lines) {
      db.prepare('INSERT INTO refund_items (id, refund_id, order_item_id, product_id, quantity, amount, restocked) VALUES (?,?,?,?,?,?,?)')
        .run(crypto.randomUUID(), refundId, line.id, line.product_id, qty, amount, restock ? 1 : 0);
      db.prepare(`INSERT INTO stock_movements (id, store_id, product_id, type, quantity, note, performed_by) VALUES (?,?,?,'return',?,?,?)`)
        .run(crypto.randomUUID(), storeId, line.product_id, qty, `Refund on ${order.receipt_number}`, req.user.sub);
      if (!restock) {
        db.prepare(`INSERT INTO stock_movements (id, store_id, product_id, type, quantity, note, performed_by) VALUES (?,?,?,'damage',?,?,?)`)
          .run(crypto.randomUUID(), storeId, line.product_id, qty, `Returned damaged — ${order.receipt_number}`, req.user.sub);
      }
      recomputeProductQuantities(db, line.product_id);
    }
    db.prepare('UPDATE orders SET refunded_total = refunded_total + ? WHERE id = ?').run(total, orderId);
    if (method === 'credit') {
      db.prepare(
        `INSERT INTO customer_ledger_entries (id, store_id, store_customer_id, type, amount, order_id, note, recorded_by)
         VALUES (?,?,?,'adjustment',?,?,?,?)`
      ).run(crypto.randomUUID(), storeId, order.store_customer_id, -total, orderId, `Refund on ${order.receipt_number}`, req.user.sub);
    }
  })();

  const fresh = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  res.status(201).json({ refund: { id: refundId, amount: total, method }, order: loadReceipt(fresh) });
  logActivity(req, { storeId, action: 'order.refunded', entityType: 'order', entityId: orderId, details: { receipt: order.receipt_number, amount: total, method, reason } });
  emitToStore(storeId, 'order:updated', normalize(fresh));
  for (const { line } of lines) emitToStore(storeId, 'product:updated', db.prepare('SELECT * FROM products WHERE id = ?').get(line.product_id));
  dispatchEvent(storeId, 'order.refunded', { orderId, amount: total, method });
}

// GET /api/public/receipts/:token
function publicReceipt(req, res) {
  const order = db.prepare(`SELECT * FROM orders WHERE public_token = ? AND status = 'paid'`).get(req.params.token);
  if (!order) return res.status(404).json({ error: 'Receipt not found' });
  const r = loadReceipt(order);
  res.json({
    receipt_number: r.receipt_number, paid_at: r.paid_at, payment_method: r.payment_method,
    subtotal: r.subtotal, discount_amount: r.discount_amount, tax_amount: r.tax_amount, tax_rate_pct: r.tax_rate_pct,
    tax_inclusive: r.tax_inclusive, total: r.total, amount_tendered: r.amount_tendered, change_due: r.change_due,
    refunded_total: r.refunded_total, cashier_name: r.cashier_name, store: r.store,
    items: r.items.map((i) => ({ product_name: i.product_name, quantity: i.quantity, unit_price: i.unit_price, line_total: i.line_total, refunded_qty: i.refunded_qty })),
    payments: r.payments.map((p) => ({ method: p.method, amount: p.amount })),
  });
}

module.exports = {
  createOrder, listOrders, getOrder, addItem, removeItem, payOrder, cancelOrder,
  applyDiscount, parkOrder, refundOrder, publicReceipt, loadReceipt,
};
