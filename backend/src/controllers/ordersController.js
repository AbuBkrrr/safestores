// ------------------------------------------------------------
// POS checkout ('orders') for the standalone web edition. Postgres-flavored
// twin of desktop/server/controllers/ordersController.js — same behavior,
// async/await + $N params instead of better-sqlite3's synchronous API.
//
// 'checkout_mode' on stores (see migrations/004_pos_checkout.sql) lets a
// store choose 'split' (a checkout user builds the order, a separate
// cashier confirms payment) or 'merged' (one role does both). Adding an
// item deducts stock immediately as a normal 'sale' stock_movements row;
// cancelling an unpaid order reverses that with an 'adjustment' movement.
// ------------------------------------------------------------

const crypto = require('crypto');
const db = require('../config/db');
const { recomputeProductQuantities } = require('../utils/stockMath');
const { dispatchEvent } = require('../utils/webhooks');
const { emitToStore } = require('../realtime');
const bcrypt = require('bcryptjs');
const { computeTotals, discountPercentOf, refundAmountFor, allocatePayments, r2, PAYMENT_METHODS } = require('../utils/pricing');
const { logActivity } = require('../utils/activityLog');

async function openShiftFor(client, storeId, userId) {
  const { rows } = await client.query(`SELECT id FROM shifts WHERE store_id = $1 AND opened_by = $2 AND status = 'open'`, [storeId, userId]);
  return rows[0]?.id || null;
}

function generateReceiptNumber() {
  return `RCPT-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

// POST /api/stores/:storeId/orders
// body: { id? } — accepting a client-generated id (like every other write
// endpoint here) matters more for orders than most: when checkout runs
// offline, the frontend's outbox optimistically hands the page back the id
// it generated so addItem/pay/cancel calls can keep referencing this order
// before the create request has actually reached the server.
async function createOrder(req, res) {
  const { storeId } = req.params;
  const id = req.body?.id || crypto.randomUUID();
  const { rows: existing } = await db.query('SELECT * FROM orders WHERE id = $1', [id]);
  if (existing[0]) return res.status(201).json(existing[0]); // already applied — safe no-op

  // Tax settings are snapshotted onto the order at creation, so changing
  // the store's rate later never rewrites the tax on old receipts.
  const { rows: storeRows } = await db.query('SELECT tax_rate_pct, tax_inclusive FROM stores WHERE id = $1', [storeId]);
  const shiftId = await openShiftFor(db, storeId, req.user.sub);
  const { rows } = await db.query(
    `INSERT INTO orders (id, store_id, created_by, tax_rate_pct, tax_inclusive, shift_id, parked_label)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [id, storeId, req.user.sub, storeRows[0]?.tax_rate_pct || 0, storeRows[0]?.tax_inclusive !== false, shiftId, req.body?.label ? String(req.body.label).slice(0, 80) : null]
  );
  const order = rows[0];
  res.status(201).json(order);
  try {
    emitToStore(storeId, 'order:updated', order);
  } catch (sideEffectErr) {
    console.error('createOrder: post-response realtime side effect failed:', sideEffectErr);
  }
}

// GET /api/stores/:storeId/orders?status=&q=&from=&to=&limit=&offset=
// q matches a receipt number (or part of it, as printed); from/to are
// YYYY-MM-DD dates in the STORE's time zone.
async function listOrders(req, res) {
  const { storeId } = req.params;
  const { status, q, from, to } = req.query;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const params = [storeId];
  const where = ['o.store_id = $1'];
  if (status) { params.push(status); where.push(`o.status = $${params.length}`); }
  if (q) { params.push(`%${String(q).trim().toUpperCase()}%`); where.push(`o.receipt_number LIKE $${params.length}`); }
  if (from) { params.push(from); where.push(`(COALESCE(o.paid_at, o.created_at) AT TIME ZONE s.timezone)::date >= $${params.length}::date`); }
  if (to) { params.push(to); where.push(`(COALESCE(o.paid_at, o.created_at) AT TIME ZONE s.timezone)::date <= $${params.length}::date`); }
  params.push(limit, offset);
  const { rows } = await db.query(
    `SELECT o.*, u1.name AS created_by_name, u2.name AS paid_by_name,
            (SELECT COUNT(*)::int FROM order_items oi WHERE oi.order_id = o.id) AS item_count
     FROM orders o JOIN stores s ON s.id = o.store_id
     LEFT JOIN users u1 ON u1.id = o.created_by LEFT JOIN users u2 ON u2.id = o.paid_by
     WHERE ${where.join(' AND ')} ORDER BY o.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  res.json(rows);
}

// GET /api/stores/:storeId/orders/:orderId
async function getOrder(req, res) {
  const { storeId, orderId } = req.params;
  const { rows: orderRows } = await db.query('SELECT * FROM orders WHERE id = $1 AND store_id = $2', [orderId, storeId]);
  const order = orderRows[0];
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json(await loadReceipt(db, order));
}

/** Everything a receipt (screen, print, PDF, public link) needs. */
async function loadReceipt(client, order) {
  const { rows: items } = await client.query(
    `SELECT oi.*, p.name AS product_name, p.sku,
            COALESCE((SELECT SUM(ri.quantity) FROM refund_items ri WHERE ri.order_item_id = oi.id), 0)::int AS refunded_qty
     FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1 ORDER BY oi.created_at ASC`,
    [order.id]
  );
  const { rows: payments } = await client.query('SELECT method, amount, reference, created_at FROM order_payments WHERE order_id = $1 ORDER BY created_at', [order.id]);
  const { rows: refunds } = await client.query(
    `SELECT r.*, u.name AS created_by_name FROM refunds r LEFT JOIN users u ON u.id = r.created_by WHERE r.order_id = $1 ORDER BY r.created_at`,
    [order.id]
  );
  const { rows: storeRows } = await client.query(
    `SELECT s.name, s.address, s.city, s.phone, s.tax_label, s.tax_number, s.receipt_header, s.receipt_footer, s.timezone,
            COALESCE(s.currency_code, c.code) AS currency_code, COALESCE(s.currency_symbol, c.symbol) AS currency_symbol
     FROM stores s LEFT JOIN currency_settings c ON c.id = 'default' WHERE s.id = $1`,
    [order.store_id]
  );
  const { rows: names } = await client.query('SELECT name FROM users WHERE id = $1', [order.paid_by || order.created_by]);
  return { ...order, items, payments, refunds, store: storeRows[0] || null, cashier_name: names[0]?.name || null };
}

async function recalcOrderTotals(client, orderId) {
  const { rows } = await client.query('SELECT COALESCE(SUM(line_total), 0) AS subtotal FROM order_items WHERE order_id = $1', [orderId]);
  const { rows: o } = await client.query('SELECT discount_type, discount_value, tax_rate_pct, tax_inclusive FROM orders WHERE id = $1', [orderId]);
  const t = computeTotals({
    subtotal: rows[0].subtotal, discountType: o[0].discount_type, discountValue: o[0].discount_value,
    taxRatePct: o[0].tax_rate_pct, taxInclusive: o[0].tax_inclusive,
  });
  await client.query(
    'UPDATE orders SET subtotal = $1, discount_amount = $2, tax_amount = $3, total = $4 WHERE id = $5',
    [t.subtotal, t.discountAmount, t.taxAmount, t.total, orderId]
  );
}

// POST /api/stores/:storeId/orders/:orderId/items
async function addItem(req, res) {
  const { storeId, orderId } = req.params;
  const { id, productId, quantity, addedVia } = req.body;
  if (!productId || !quantity || quantity <= 0) return res.status(400).json({ error: 'productId and a positive quantity are required' });

  if (id) {
    const { rows: existing } = await db.query('SELECT * FROM order_items WHERE id = $1', [id]);
    if (existing[0]) {
      const { rows: orderRows } = await db.query('SELECT * FROM orders WHERE id = $1', [orderId]);
      return res.status(201).json({ item: existing[0], order: orderRows[0] });
    }
  }

  const { rows: orderRows } = await db.query('SELECT * FROM orders WHERE id = $1 AND store_id = $2', [orderId, storeId]);
  const order = orderRows[0];
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'pending_payment') return res.status(400).json({ error: `Order is already ${order.status}` });

  const { rows: productRows } = await db.query('SELECT * FROM products WHERE id = $1 AND store_id = $2', [productId, storeId]);
  const product = productRows[0];
  if (!product) return res.status(404).json({ error: 'Product not found' });
  if (product.shelf_qty < quantity) return res.status(400).json({ error: `Only ${product.shelf_qty} on the shelf — not enough stock for this quantity` });

  const unitPrice = Number(product.cost_price) * Number(product.price_multiplier);
  const lineTotal = Math.round(unitPrice * quantity * 100) / 100;
  const movementId = crypto.randomUUID();
  const itemId = id || crypto.randomUUID();

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO stock_movements (id, store_id, product_id, type, quantity, note, performed_by) VALUES ($1,$2,$3,'sale',$4,'POS checkout',$5)`,
      [movementId, storeId, productId, quantity, req.user.sub]
    );
    await recomputeProductQuantities(client, productId);
    const { rows: itemRows } = await client.query(
      `INSERT INTO order_items (id, order_id, product_id, quantity, unit_price, line_total, added_via, movement_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [itemId, orderId, productId, quantity, unitPrice, lineTotal, addedVia || 'scan', movementId]
    );
    await recalcOrderTotals(client, orderId);
    await client.query('COMMIT');

    const { rows: updatedOrder } = await db.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    res.status(201).json({ item: itemRows[0], order: updatedOrder[0] });
    try {
      emitToStore(storeId, 'order:updated', updatedOrder[0]);
    } catch (sideEffectErr) {
      console.error('addItem: post-response realtime side effect failed:', sideEffectErr);
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to add item to order' });
  } finally {
    client.release();
  }
}

// DELETE /api/stores/:storeId/orders/:orderId/items/:itemId
async function removeItem(req, res) {
  const { storeId, orderId, itemId } = req.params;
  const { rows: orderRows } = await db.query('SELECT * FROM orders WHERE id = $1 AND store_id = $2', [orderId, storeId]);
  const order = orderRows[0];
  if (!order || order.status !== 'pending_payment') return res.status(400).json({ error: 'Order not found or no longer pending' });
  const { rows: itemRows } = await db.query('SELECT * FROM order_items WHERE id = $1 AND order_id = $2', [itemId, orderId]);
  const item = itemRows[0];
  if (!item) return res.status(404).json({ error: 'Item not found' });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO stock_movements (store_id, product_id, type, quantity, note, performed_by) VALUES ($1,$2,'return',$3,'Removed from POS order before payment',$4)`,
      [storeId, item.product_id, item.quantity, req.user.sub]
    );
    await recomputeProductQuantities(client, item.product_id);
    await client.query('DELETE FROM order_items WHERE id = $1', [itemId]);
    await recalcOrderTotals(client, orderId);
    await client.query('COMMIT');

    const { rows: updatedOrder } = await db.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    res.json(updatedOrder[0]);
    try {
      emitToStore(storeId, 'order:updated', updatedOrder[0]);
      const { rows: updatedProduct } = await db.query('SELECT * FROM products WHERE id = $1', [item.product_id]);
      emitToStore(storeId, 'product:updated', updatedProduct[0]);
    } catch (sideEffectErr) {
      console.error('removeItem: post-response realtime side effect failed:', sideEffectErr);
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to remove item from order' });
  } finally {
    client.release();
  }
}

// POST /api/stores/:storeId/orders/:orderId/pay
// body (new):    { payments: [{ method, amount, reference?, storeCustomerId? }], storeCustomerId? }
// body (legacy): { paymentMethod, storeCustomerId? } — pays the full total in one method
// Only cash may exceed the amount due; the excess is returned as change.
async function payOrder(req, res) {
  const { storeId, orderId } = req.params;
  const { paymentMethod } = req.body || {};
  let storeCustomerId = req.body?.storeCustomerId || null;

  const { rows: orderRows } = await db.query('SELECT * FROM orders WHERE id = $1 AND store_id = $2', [orderId, storeId]);
  const pending = orderRows[0];
  if (!pending || pending.status !== 'pending_payment') return res.status(400).json({ error: 'Order not found or already resolved' });

  const { rows: storeRows } = await db.query('SELECT require_shift FROM stores WHERE id = $1', [storeId]);
  const shiftId = await openShiftFor(db, storeId, req.user.sub);
  if (storeRows[0]?.require_shift && !shiftId) {
    return res.status(400).json({ error: 'Open a shift before taking payments (Checkout → Open shift).', code: 'SHIFT_REQUIRED' });
  }

  const tenders = Array.isArray(req.body?.payments) && req.body.payments.length
    ? req.body.payments.map((p) => ({ method: p.method, amount: Number(p.amount), reference: p.reference ? String(p.reference).slice(0, 120) : null }))
    : [{ method: paymentMethod || 'cash', amount: Number(pending.total), reference: null }];
  if (!storeCustomerId) storeCustomerId = req.body?.payments?.find((p) => p.storeCustomerId)?.storeCustomerId || null;

  // A credit sale must be tied to a real, known customer — otherwise
  // there's no one to collect from later, which defeats the point.
  const hasCredit = tenders.some((t) => t.method === 'credit');
  if (hasCredit && !storeCustomerId) {
    return res.status(400).json({ error: 'storeCustomerId is required when paymentMethod is credit' });
  }
  if (storeCustomerId) {
    const { rows: custRows } = await db.query(
      'SELECT id FROM store_customers WHERE id = $1 AND store_id = $2 AND archived_at IS NULL',
      [storeCustomerId, storeId]
    );
    if (!custRows[0]) return res.status(404).json({ error: 'Customer not found' });
  }

  // An empty order (total 0) can still be "paid" in one method for the
  // legacy path — keep that behavior; the allocator needs a positive amount.
  let alloc;
  if (Number(pending.total) === 0 && !req.body?.payments) {
    alloc = { ok: true, applied: [], tendered: 0, change: 0 };
  } else {
    alloc = allocatePayments(pending.total, tenders);
    if (!alloc.ok) return res.status(400).json({ error: alloc.error });
  }

  const methodLabel = tenders.length > 1 ? 'split' : tenders[0].method;
  const client = await db.pool.connect();
  let order;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE orders SET status = 'paid', paid_by = $1, paid_at = now(), payment_method = $2, receipt_number = $3,
         amount_tendered = $4, change_due = $5, shift_id = COALESCE($6, shift_id), store_customer_id = $7, public_token = $8
       WHERE id = $9 AND store_id = $10 AND status = 'pending_payment' RETURNING *`,
      [req.user.sub, methodLabel, generateReceiptNumber(), alloc.tendered, alloc.change, shiftId, storeCustomerId,
        crypto.randomBytes(12).toString('base64url'), orderId, storeId]
    );
    order = rows[0];
    if (!order) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Order not found or already resolved' }); }

    for (const p of alloc.applied) {
      await client.query(
        `INSERT INTO order_payments (order_id, store_id, method, amount, reference, shift_id) VALUES ($1,$2,$3,$4,$5,$6)`,
        [order.id, storeId, p.method, p.amount, p.reference, shiftId]
      );
    }
    const creditAmount = r2(alloc.applied.filter((p) => p.method === 'credit').reduce((s, p) => s + p.amount, 0));
    if (creditAmount > 0) {
      await client.query(
        `INSERT INTO customer_ledger_entries (store_id, store_customer_id, type, amount, order_id, note, recorded_by)
         VALUES ($1,$2,'credit_sale',$3,$4,$5,$6)`,
        [storeId, storeCustomerId, creditAmount, order.id, `Receipt ${order.receipt_number}`, req.user.sub]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    return res.status(500).json({ error: 'Failed to record payment' });
  } finally {
    client.release();
  }

  res.json({ ...order, payments: alloc.applied });
  try {
    emitToStore(storeId, 'order:paid', order);
    dispatchEvent(storeId, 'order.paid', { orderId, total: order.total, paymentMethod: order.payment_method });
  } catch (sideEffectErr) {
    console.error('payOrder: post-response side effect failed:', sideEffectErr);
  }
}

// POST /api/stores/:storeId/orders/:orderId/discount
// body: { type: 'percent'|'amount'|null, value, reason?, approverEmail?, approverPassword? }
// Cashiers/checkout staff can discount up to the store's limit on their
// own; above it, a manager or admin enters their credentials to approve.
async function applyDiscount(req, res) {
  const { storeId, orderId } = req.params;
  const { type = null, reason = null, approverEmail, approverPassword } = req.body || {};
  const value = Number(req.body?.value) || 0;
  if (type !== null && !['percent', 'amount'].includes(type)) return res.status(400).json({ error: 'type must be percent or amount' });
  if (value < 0 || (type === 'percent' && value > 100)) return res.status(400).json({ error: 'Invalid discount value' });

  const { rows: orderRows } = await db.query('SELECT * FROM orders WHERE id = $1 AND store_id = $2', [orderId, storeId]);
  const order = orderRows[0];
  if (!order || order.status !== 'pending_payment') return res.status(400).json({ error: 'Order not found or no longer pending' });

  const clearing = !type || value === 0;
  let approvedBy = null;
  if (!clearing) {
    const pct = discountPercentOf({ subtotal: order.subtotal, discountType: type, discountValue: value });
    const { rows: storeRows } = await db.query('SELECT max_cashier_discount_pct FROM stores WHERE id = $1', [storeId]);
    const limit = Number(storeRows[0]?.max_cashier_discount_pct ?? 10);
    const selfApproves = ['admin', 'manager'].includes(req.user.role);
    if (!selfApproves && pct > limit + 1e-9) {
      if (!approverEmail || !approverPassword) {
        return res.status(403).json({ error: `Discounts above ${limit}% need a manager's approval.`, code: 'DISCOUNT_APPROVAL_REQUIRED', limit });
      }
      const { rows: approvers } = await db.query(
        `SELECT id, password_hash FROM users WHERE store_id = $1 AND lower(email) = lower($2) AND role IN ('admin','manager') AND status = 'active' AND password_hash IS NOT NULL`,
        [storeId, approverEmail]
      );
      let approver = null;
      for (const a of approvers) {
        // eslint-disable-next-line no-await-in-loop
        if (await bcrypt.compare(String(approverPassword), a.password_hash)) { approver = a; break; }
      }
      if (!approver) return res.status(403).json({ error: 'Manager approval failed — check the email and password.', code: 'DISCOUNT_APPROVAL_FAILED' });
      approvedBy = approver.id;
    } else if (selfApproves) {
      approvedBy = req.user.sub;
    }
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE orders SET discount_type = $1, discount_value = $2, discount_reason = $3, discount_approved_by = $4 WHERE id = $5`,
      [clearing ? null : type, clearing ? 0 : value, clearing ? null : (reason ? String(reason).slice(0, 200) : null), approvedBy, orderId]
    );
    await recalcOrderTotals(client, orderId);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    return res.status(500).json({ error: 'Failed to apply discount' });
  } finally {
    client.release();
  }
  const { rows: updated } = await db.query('SELECT * FROM orders WHERE id = $1', [orderId]);
  res.json(updated[0]);
  logActivity(req, {
    storeId, action: clearing ? 'order.discount_removed' : 'order.discount_applied', entityType: 'order', entityId: orderId,
    details: clearing ? {} : { type, value, amount: updated[0].discount_amount, reason, approvedBy },
  });
  try { emitToStore(storeId, 'order:updated', updated[0]); } catch (e) { /* realtime is best-effort */ }
}

// PATCH /api/stores/:storeId/orders/:orderId/park  { label }
// "Park" a sale (customer stepped away): give the pending order a label
// so any till can find and resume it from the pending list.
async function parkOrder(req, res) {
  const { storeId, orderId } = req.params;
  const label = req.body?.label ? String(req.body.label).slice(0, 80) : null;
  const { rows } = await db.query(
    `UPDATE orders SET parked_label = $1 WHERE id = $2 AND store_id = $3 AND status = 'pending_payment' RETURNING *`,
    [label, orderId, storeId]
  );
  if (!rows[0]) return res.status(400).json({ error: 'Order not found or no longer pending' });
  res.json(rows[0]);
  try { emitToStore(storeId, 'order:updated', rows[0]); } catch (e) { /* best-effort */ }
}

// POST /api/stores/:storeId/orders/:orderId/refunds
// body: { items: [{ orderItemId, quantity, restock = true }], method, reason }
// Refund value per unit is that line's share of what was actually paid
// (order discount and any added tax spread pro rata). Restocked units go
// back on the shelf as a 'return' movement; damaged ones are returned and
// immediately written off as 'damage', so sold/damaged counts stay true.
async function refundOrder(req, res) {
  const { storeId, orderId } = req.params;
  const { items = [], method = 'cash', reason = null } = req.body || {};
  if (!PAYMENT_METHODS.includes(method)) return res.status(400).json({ error: 'Invalid refund method' });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Choose at least one item to refund' });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: orderRows } = await client.query('SELECT * FROM orders WHERE id = $1 AND store_id = $2 FOR UPDATE', [orderId, storeId]);
    const order = orderRows[0];
    if (!order || order.status !== 'paid') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Only paid sales can be refunded' }); }
    if (method === 'credit' && !order.store_customer_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Store-credit refunds need a sale linked to a customer' });
    }

    const shiftId = await openShiftFor(client, storeId, req.user.sub);
    const refundId = crypto.randomUUID();
    let total = 0;
    const lines = [];
    for (const it of items) {
      const qty = parseInt(it.quantity, 10);
      if (!(qty > 0)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Each refund quantity must be at least 1' }); }
      const { rows: lineRows } = await client.query(
        `SELECT oi.*, COALESCE((SELECT SUM(ri.quantity) FROM refund_items ri WHERE ri.order_item_id = oi.id), 0)::int AS refunded_qty
         FROM order_items oi WHERE oi.id = $1 AND oi.order_id = $2`,
        [it.orderItemId, orderId]
      );
      const line = lineRows[0];
      if (!line) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Item not found on this sale' }); }
      if (qty > line.quantity - line.refunded_qty) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Only ${line.quantity - line.refunded_qty} of that item can still be refunded` });
      }
      const amount = refundAmountFor({ lineTotal: line.line_total, lineQty: line.quantity, qty, orderSubtotal: order.subtotal, orderTotal: order.total });
      total = r2(total + amount);
      lines.push({ line, qty, amount, restock: it.restock !== false });
    }
    if (total > r2(Number(order.total) - Number(order.refunded_total)) + 0.01) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Refund is more than what is left on this sale' });
    }

    await client.query(
      `INSERT INTO refunds (id, order_id, store_id, amount, method, reason, created_by, shift_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [refundId, orderId, storeId, total, method, reason ? String(reason).slice(0, 300) : null, req.user.sub, shiftId]
    );
    for (const { line, qty, amount, restock } of lines) {
      await client.query(
        `INSERT INTO refund_items (refund_id, order_item_id, product_id, quantity, amount, restocked) VALUES ($1,$2,$3,$4,$5,$6)`,
        [refundId, line.id, line.product_id, qty, amount, restock]
      );
      await client.query(
        `INSERT INTO stock_movements (store_id, product_id, type, quantity, note, performed_by) VALUES ($1,$2,'return',$3,$4,$5)`,
        [storeId, line.product_id, qty, `Refund on ${order.receipt_number}`, req.user.sub]
      );
      if (!restock) {
        await client.query(
          `INSERT INTO stock_movements (store_id, product_id, type, quantity, note, performed_by) VALUES ($1,$2,'damage',$3,$4,$5)`,
          [storeId, line.product_id, qty, `Returned damaged — ${order.receipt_number}`, req.user.sub]
        );
      }
      await recomputeProductQuantities(client, line.product_id);
    }
    await client.query('UPDATE orders SET refunded_total = refunded_total + $1 WHERE id = $2', [total, orderId]);
    if (method === 'credit') {
      await client.query(
        `INSERT INTO customer_ledger_entries (store_id, store_customer_id, type, amount, order_id, note, recorded_by)
         VALUES ($1,$2,'adjustment',$3,$4,$5,$6)`,
        [storeId, order.store_customer_id, -total, orderId, `Refund on ${order.receipt_number}`, req.user.sub]
      );
    }
    await client.query('COMMIT');

    const { rows: fresh } = await db.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    res.status(201).json({ refund: { id: refundId, amount: total, method }, order: await loadReceipt(db, fresh[0]) });
    logActivity(req, { storeId, action: 'order.refunded', entityType: 'order', entityId: orderId, details: { receipt: order.receipt_number, amount: total, method, reason } });
    try {
      emitToStore(storeId, 'order:updated', fresh[0]);
      for (const { line } of lines) {
        const { rows: p } = await db.query('SELECT * FROM products WHERE id = $1', [line.product_id]);
        emitToStore(storeId, 'product:updated', p[0]);
      }
      dispatchEvent(storeId, 'order.refunded', { orderId, amount: total, method });
    } catch (e) { /* best-effort */ }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to record refund' });
  } finally {
    client.release();
  }
}

// GET /api/public/receipts/:token — no login: the link/QR printed on a
// receipt, so a customer can view or keep a digital copy.
async function publicReceipt(req, res) {
  const { rows } = await db.query(`SELECT * FROM orders WHERE public_token = $1 AND status = 'paid'`, [req.params.token]);
  if (!rows[0]) return res.status(404).json({ error: 'Receipt not found' });
  const r = await loadReceipt(db, rows[0]);
  res.json({
    receipt_number: r.receipt_number, paid_at: r.paid_at, payment_method: r.payment_method,
    subtotal: r.subtotal, discount_amount: r.discount_amount, tax_amount: r.tax_amount, tax_rate_pct: r.tax_rate_pct,
    tax_inclusive: r.tax_inclusive, total: r.total, amount_tendered: r.amount_tendered, change_due: r.change_due,
    refunded_total: r.refunded_total, cashier_name: r.cashier_name, store: r.store,
    items: r.items.map((i) => ({ product_name: i.product_name, quantity: i.quantity, unit_price: i.unit_price, line_total: i.line_total, refunded_qty: i.refunded_qty })),
    payments: r.payments.map((p) => ({ method: p.method, amount: p.amount })),
  });
}

// PATCH /api/stores/:storeId/orders/:orderId/cancel
async function cancelOrder(req, res) {
  const { storeId, orderId } = req.params;
  const { rows: orderRows } = await db.query('SELECT * FROM orders WHERE id = $1 AND store_id = $2', [orderId, storeId]);
  const order = orderRows[0];
  if (!order || order.status !== 'pending_payment') return res.status(400).json({ error: 'Order not found or no longer pending' });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: items } = await client.query('SELECT * FROM order_items WHERE order_id = $1', [orderId]);
    for (const item of items) {
      await client.query(
        `INSERT INTO stock_movements (store_id, product_id, type, quantity, note, performed_by) VALUES ($1,$2,'return',$3,'POS order cancelled',$4)`,
        [storeId, item.product_id, item.quantity, req.user.sub]
      );
      await recomputeProductQuantities(client, item.product_id);
    }
    await client.query(`UPDATE orders SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [orderId]);
    await client.query('COMMIT');

    res.json({ message: 'Order cancelled, stock restored' });
    try {
      const { rows: cancelledOrder } = await db.query('SELECT * FROM orders WHERE id = $1', [orderId]);
      emitToStore(storeId, 'order:cancelled', cancelledOrder[0]);
      const distinctProductIds = [...new Set(items.map((i) => i.product_id))];
      for (const productId of distinctProductIds) {
        const { rows: updatedProduct } = await db.query('SELECT * FROM products WHERE id = $1', [productId]);
        emitToStore(storeId, 'product:updated', updatedProduct[0]);
      }
    } catch (sideEffectErr) {
      console.error('cancelOrder: post-response realtime side effect failed:', sideEffectErr);
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to cancel order' });
  } finally {
    client.release();
  }
}

module.exports = {
  createOrder, listOrders, getOrder, addItem, removeItem, payOrder, cancelOrder,
  applyDiscount, parkOrder, refundOrder, publicReceipt, loadReceipt, openShiftFor,
};
