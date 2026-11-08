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

  const { rows } = await db.query(
    `INSERT INTO orders (id, store_id, created_by) VALUES ($1,$2,$3) RETURNING *`,
    [id, storeId, req.user.sub]
  );
  const order = rows[0];
  res.status(201).json(order);
  try {
    emitToStore(storeId, 'order:updated', order);
  } catch (sideEffectErr) {
    console.error('createOrder: post-response realtime side effect failed:', sideEffectErr);
  }
}

// GET /api/stores/:storeId/orders?status=
async function listOrders(req, res) {
  const { storeId } = req.params;
  const { status } = req.query;
  const { rows } = await db.query(
    `SELECT o.*, u1.name AS created_by_name, u2.name AS paid_by_name FROM orders o
     LEFT JOIN users u1 ON u1.id = o.created_by LEFT JOIN users u2 ON u2.id = o.paid_by
     WHERE o.store_id = $1 ${status ? 'AND o.status = $2' : ''} ORDER BY o.created_at DESC`,
    status ? [storeId, status] : [storeId]
  );
  res.json(rows);
}

// GET /api/stores/:storeId/orders/:orderId
async function getOrder(req, res) {
  const { storeId, orderId } = req.params;
  const { rows: orderRows } = await db.query('SELECT * FROM orders WHERE id = $1 AND store_id = $2', [orderId, storeId]);
  const order = orderRows[0];
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const { rows: items } = await db.query(
    `SELECT oi.*, p.name AS product_name, p.sku FROM order_items oi
     JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1 ORDER BY oi.created_at ASC`,
    [orderId]
  );
  res.json({ ...order, items });
}

async function recalcOrderTotals(client, orderId) {
  const { rows } = await client.query('SELECT COALESCE(SUM(line_total), 0) AS subtotal FROM order_items WHERE order_id = $1', [orderId]);
  const { subtotal } = rows[0];
  await client.query('UPDATE orders SET subtotal = $1, total = $1 WHERE id = $2', [subtotal, orderId]);
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
      `INSERT INTO stock_movements (store_id, product_id, type, quantity, note, performed_by) VALUES ($1,$2,'adjustment',$3,'Removed from POS order before payment',$4)`,
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
async function payOrder(req, res) {
  const { storeId, orderId } = req.params;
  const { paymentMethod, storeCustomerId } = req.body;

  // A credit sale must be tied to a real, known customer — otherwise
  // there's no one to collect from later, which defeats the point.
  if (paymentMethod === 'credit' && !storeCustomerId) {
    return res.status(400).json({ error: 'storeCustomerId is required when paymentMethod is credit' });
  }
  if (storeCustomerId) {
    const { rows: custRows } = await db.query(
      'SELECT id FROM store_customers WHERE id = $1 AND store_id = $2 AND archived_at IS NULL',
      [storeCustomerId, storeId]
    );
    if (!custRows[0]) return res.status(404).json({ error: 'Customer not found' });
  }

  const { rows } = await db.query(
    `UPDATE orders SET status = 'paid', paid_by = $1, paid_at = now(), payment_method = $2, receipt_number = $3
     WHERE id = $4 AND store_id = $5 AND status = 'pending_payment' RETURNING *`,
    [req.user.sub, paymentMethod || 'cash', generateReceiptNumber(), orderId, storeId]
  );
  const order = rows[0];
  if (!order) return res.status(400).json({ error: 'Order not found or already resolved' });

  if (paymentMethod === 'credit' && storeCustomerId) {
    await db.query(
      `INSERT INTO customer_ledger_entries (store_id, store_customer_id, type, amount, order_id, note, recorded_by)
       VALUES ($1,$2,'credit_sale',$3,$4,$5,$6)`,
      [storeId, storeCustomerId, order.total, order.id, `Receipt ${order.receipt_number}`, req.user.sub]
    );
  }

  res.json(order);
  try {
    emitToStore(storeId, 'order:paid', order);
    dispatchEvent(storeId, 'order.paid', { orderId, total: order.total, paymentMethod: order.payment_method });
  } catch (sideEffectErr) {
    console.error('payOrder: post-response side effect failed:', sideEffectErr);
  }
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
        `INSERT INTO stock_movements (store_id, product_id, type, quantity, note, performed_by) VALUES ($1,$2,'adjustment',$3,'POS order cancelled',$4)`,
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

module.exports = { createOrder, listOrders, getOrder, addItem, removeItem, payOrder, cancelOrder };
