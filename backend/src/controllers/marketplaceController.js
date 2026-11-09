const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { signToken } = require('../utils/jwt');
const { emitToStore } = require('../realtime');
const { sendPushToStore } = require('../utils/push');
const { recomputeProductQuantities } = require('../utils/stockMath');

// ------------------------------------------------------------
// Customer-facing (public / customer-authenticated)
// ------------------------------------------------------------

// GET /api/marketplace/:storeId/products?search=&category=&brand= — public, no auth; only what a shopper needs to see
async function browseProducts(req, res) {
  const { storeId } = req.params;
  const { search, category, brand } = req.query;
  const conditions = ['store_id = $1'];
  const params = [storeId];
  if (search) { params.push(`%${search}%`); conditions.push(`(name ILIKE $${params.length} OR brand ILIKE $${params.length})`); }
  if (category) { params.push(category); conditions.push(`category = $${params.length}`); }
  if (brand) { params.push(brand); conditions.push(`brand = $${params.length}`); }

  const { rows } = await db.query(
    `SELECT id, name, brand, category, unit, location, image_url,
            ROUND(cost_price * price_multiplier, 2) AS price,
            (shelf_qty + backroom_qty) > 0 AS in_stock
     FROM products WHERE ${conditions.join(' AND ')} ORDER BY name ASC`,
    params
  );
  res.json(rows);
}

// GET /api/marketplace/stores?search=&category=&city= — public store directory,
// the entry point for "which store has what I want" rather than requiring
// a customer to already have a specific store's direct link.
async function listStores(req, res) {
  const { search, category, city } = req.query;
  const conditions = [`subscription_status = 'active'`, 'marketplace_enabled = true'];
  const params = [];
  if (search) { params.push(`%${search}%`); conditions.push(`name ILIKE $${params.length}`); }
  if (category) { params.push(category); conditions.push(`category = $${params.length}`); }
  if (city) { params.push(city); conditions.push(`city = $${params.length}`); }

  const { rows } = await db.query(
    `SELECT id, name, category, city, address FROM stores WHERE ${conditions.join(' AND ')} ORDER BY name ASC`,
    params
  );
  res.json(rows);
}

// GET /api/marketplace/search-products?search=&category=&brand=&city=&storeId=
// The unified cross-store search — one query box across every
// participating store's inventory at once, filterable by name/brand/
// category/city/preferred store, with which store carries it attached to
// each result.
async function searchProducts(req, res) {
  const { search, category, brand, city, storeId } = req.query;
  const conditions = [`s.subscription_status = 'active'`, 's.marketplace_enabled = true'];
  const params = [];
  if (search) { params.push(`%${search}%`); conditions.push(`(p.name ILIKE $${params.length} OR p.brand ILIKE $${params.length})`); }
  if (category) { params.push(category); conditions.push(`p.category = $${params.length}`); }
  if (brand) { params.push(brand); conditions.push(`p.brand = $${params.length}`); }
  if (city) { params.push(city); conditions.push(`s.city = $${params.length}`); }
  if (storeId) { params.push(storeId); conditions.push(`s.id = $${params.length}`); }

  const { rows } = await db.query(
    `SELECT p.id, p.name, p.brand, p.category, p.unit, p.location, p.image_url,
            ROUND(p.cost_price * p.price_multiplier, 2) AS price,
            (p.shelf_qty + p.backroom_qty) > 0 AS in_stock,
            s.id AS store_id, s.name AS store_name, s.city AS store_city
     FROM products p JOIN stores s ON s.id = p.store_id
     WHERE ${conditions.join(' AND ')} ORDER BY p.name ASC LIMIT 200`,
    params
  );
  res.json(rows);
}

// POST /api/marketplace/:storeId/signup   { name, email, phone, password }
async function customerSignup(req, res) {
  const { storeId } = req.params;
  const { name, email, phone, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'name, email, and password are required' });
  const passwordHash = await bcrypt.hash(password, 10);
  try {
    const { rows } = await db.query(
      `INSERT INTO customers (store_id, name, email, phone, password_hash) VALUES ($1,$2,$3,$4,$5)
       RETURNING id, name, email`,
      [storeId, name, email, phone || null, passwordHash]
    );
    const token = signToken({ sub: rows[0].id, role: 'customer', storeId });
    res.status(201).json({ token, user: { ...rows[0], role: 'customer', storeId } });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'An account with this email already exists for this store' });
    console.error(err);
    res.status(500).json({ error: 'Signup failed' });
  }
}

// POST /api/marketplace/:storeId/login   { email, password }
async function customerLogin(req, res) {
  const { storeId } = req.params;
  const { email, password } = req.body;
  const { rows } = await db.query('SELECT * FROM customers WHERE store_id = $1 AND email = $2', [storeId, email]);
  const customer = rows[0];
  if (!customer || !(await bcrypt.compare(password, customer.password_hash))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = signToken({ sub: customer.id, role: 'customer', storeId });
  res.json({ token, user: { id: customer.id, name: customer.name, email: customer.email, role: 'customer', storeId } });
}

// POST /api/marketplace/:storeId/orders   { items: [{productId, quantity}], deliveryAddress, customerNote }
// Customer-authenticated. Does NOT deduct stock yet — that happens when
// the admin fulfills it (see fulfillOrder), since "placed" just means the
// customer wants it, not that it's been physically picked and packed.
async function placeOrder(req, res) {
  const { storeId } = req.params;
  const { items, deliveryAddress, customerNote, guestName, guestEmail, guestPhone } = req.body;
  const paymentMethod = req.body.paymentMethod === 'online' ? 'online' : 'on_delivery';
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'At least one item is required' });
  if (items.some((i) => !Number.isInteger(Number(i.quantity)) || Number(i.quantity) < 1 || Number(i.quantity) > 1000)) {
    return res.status(400).json({ error: 'Each quantity must be a whole number from 1 to 1000' });
  }
  const options = await require('./storePaymentsController').paymentOptionsFor(storeId);
  if (paymentMethod === 'online' && !options.online) return res.status(400).json({ error: 'This store does not take online payments' });
  if (!options.online && !options.payOnDelivery) return res.status(400).json({ error: 'This store is not taking online orders right now' });
  if (paymentMethod === 'on_delivery' && !options.payOnDelivery) return res.status(400).json({ error: 'This store only takes online payment right now' });

  const customerId = req.user?.sub || null;
  if (!customerId && !guestName) {
    return res.status(400).json({ error: 'guestName is required for checkout without an account' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const orderRes = await client.query(
      `INSERT INTO marketplace_orders (store_id, customer_id, guest_name, guest_email, guest_phone, delivery_address, customer_note, tracking_token, payment_method)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [storeId, customerId, customerId ? null : guestName, customerId ? null : (guestEmail || null), customerId ? null : (guestPhone || null),
        deliveryAddress || null, customerNote || null, require('crypto').randomBytes(16).toString('hex'), paymentMethod]
    );
    const order = orderRes.rows[0];
    let subtotal = 0;

    for (const { productId, quantity } of items) {
      const prod = (await client.query('SELECT * FROM products WHERE id = $1 AND store_id = $2', [productId, storeId])).rows[0];
      if (!prod) { await client.query('ROLLBACK'); return res.status(404).json({ error: `Product ${productId} not found` }); }
      const unitPrice = Number(prod.cost_price) * Number(prod.price_multiplier);
      const lineTotal = Math.round(unitPrice * quantity * 100) / 100;
      subtotal += lineTotal;
      await client.query(
        `INSERT INTO marketplace_order_items (marketplace_order_id, product_id, quantity, unit_price, line_total)
         VALUES ($1,$2,$3,$4,$5)`,
        [order.id, productId, quantity, unitPrice, lineTotal]
      );
    }

    await client.query('UPDATE marketplace_orders SET subtotal = $1, total = $1 WHERE id = $2', [subtotal, order.id]);

    // Loyalty only applies to a logged-in customer (customerId set) — a
    // guest checkout has no persistent identity to count repeat orders
    // against, so there's nothing honest to reward here.
    if (customerId) {
      const { rows: storeRows } = await client.query(
        'SELECT loyalty_enabled, loyalty_every_nth_order, loyalty_discount_pct FROM stores WHERE id = $1', [storeId]
      );
      const storeSettings = storeRows[0];
      if (storeSettings?.loyalty_enabled) {
        const { rows: countRows } = await client.query(
          `SELECT COUNT(*) AS c FROM marketplace_orders WHERE store_id = $1 AND customer_id = $2 AND status != 'cancelled'`,
          [storeId, customerId]
        );
        const orderNumber = Number(countRows[0].c); // includes the order just inserted above
        if (orderNumber > 0 && orderNumber % storeSettings.loyalty_every_nth_order === 0) {
          const discountPct = Number(storeSettings.loyalty_discount_pct);
          const discountedTotal = Math.round(subtotal * (1 - discountPct / 100) * 100) / 100;
          await client.query(
            'UPDATE marketplace_orders SET total = $1, loyalty_discount_pct = $2 WHERE id = $3',
            [discountedTotal, discountPct, order.id]
          );
        }
      }
    }

    await client.query('COMMIT');

    const finalOrder = (await db.query('SELECT * FROM marketplace_orders WHERE id = $1', [order.id])).rows[0];
    emitToStore(storeId, 'marketplace:order_placed', finalOrder);
    sendPushToStore(storeId, {
      title: 'New Marketplace order',
      body: `An order for ${Number(finalOrder.total).toFixed(2)} just came in — tap to view and fulfill it.`,
      data: { type: 'marketplace.order_placed', orderId: order.id },
    });
    res.status(201).json(finalOrder);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to place order' });
  } finally {
    client.release();
  }
}

// GET /api/marketplace/:storeId/my-orders — customer-authenticated
async function listMyOrders(req, res) {
  const { storeId } = req.params;
  const { rows } = await db.query(
    'SELECT * FROM marketplace_orders WHERE store_id = $1 AND customer_id = $2 ORDER BY created_at DESC',
    [storeId, req.user.sub]
  );
  res.json(rows);
}

// ------------------------------------------------------------
// Admin-side (mounted in routes/stores.js, normal admin auth)
// ------------------------------------------------------------

// GET /api/stores/:storeId/marketplace/orders
async function listStoreOrders(req, res) {
  const { storeId } = req.params;
  const { rows } = await db.query(
    `SELECT mo.*, COALESCE(c.name, mo.guest_name) AS customer_name,
            COALESCE(c.phone, mo.guest_phone) AS customer_phone,
            (mo.customer_id IS NULL) AS is_guest
     FROM marketplace_orders mo LEFT JOIN customers c ON c.id = mo.customer_id
     WHERE mo.store_id = $1 ORDER BY mo.created_at DESC LIMIT 300`,
    [storeId]
  );
  res.json(rows);
}

// GET /api/stores/:storeId/marketplace/orders/:orderId
async function getStoreOrder(req, res) {
  const { storeId, orderId } = req.params;
  const orderRes = await db.query(
    `SELECT mo.*, COALESCE(c.name, mo.guest_name) AS customer_name,
            COALESCE(c.phone, mo.guest_phone) AS customer_phone,
            COALESCE(c.email, mo.guest_email) AS customer_email,
            (mo.customer_id IS NULL) AS is_guest
     FROM marketplace_orders mo LEFT JOIN customers c ON c.id = mo.customer_id
     WHERE mo.id = $1 AND mo.store_id = $2`,
    [orderId, storeId]
  );
  if (!orderRes.rows[0]) return res.status(404).json({ error: 'Order not found' });
  const items = await db.query(
    `SELECT moi.*, p.name AS product_name FROM marketplace_order_items moi
     JOIN products p ON p.id = moi.product_id WHERE moi.marketplace_order_id = $1`,
    [orderId]
  );
  res.json({ ...orderRes.rows[0], items: items.rows });
}

// PATCH /api/stores/:storeId/marketplace/orders/:orderId/fulfill
// Deducts stock now (a real 'sale' movement per line), same as a POS checkout.
async function fulfillOrder(req, res) {
  const { storeId, orderId } = req.params;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const orderRes = await client.query(
      `SELECT * FROM marketplace_orders WHERE id = $1 AND store_id = $2 FOR UPDATE`, [orderId, storeId]
    );
    const order = orderRes.rows[0];
    if (!order || order.status !== 'placed') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Order not found or already resolved' });
    }
    const items = await client.query('SELECT * FROM marketplace_order_items WHERE marketplace_order_id = $1', [orderId]);
    for (const item of items.rows) {
      const prod = (await client.query('SELECT shelf_qty, backroom_qty FROM products WHERE id = $1 FOR UPDATE', [item.product_id])).rows[0];
      const available = (prod?.shelf_qty || 0) + (prod?.backroom_qty || 0);
      if (available < item.quantity) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Not enough stock to fulfill (product ${item.product_id})` });
      }
      // Pull from shelf first, then backroom, for the deduction.
      const fromShelf = Math.min(prod.shelf_qty, item.quantity);
      const fromBackroom = item.quantity - fromShelf;
      if (fromShelf > 0) {
        await client.query(
          `INSERT INTO stock_movements (store_id, product_id, type, quantity, note, performed_by)
           VALUES ($1,$2,'sale',$3,'Marketplace order fulfilled',$4)`,
          [storeId, item.product_id, fromShelf, req.user.sub]
        );
      }
      if (fromBackroom > 0) {
        // No direct "backroom sale" movement type — model as transfer-then-sale
        // so the event log stays internally consistent with how stock moves.
        await client.query(
          `INSERT INTO stock_movements (store_id, product_id, type, quantity, note, performed_by)
           VALUES ($1,$2,'transfer_to_shelf',$3,'Marketplace fulfillment (from backroom)',$4)`,
          [storeId, item.product_id, fromBackroom, req.user.sub]
        );
        await client.query(
          `INSERT INTO stock_movements (store_id, product_id, type, quantity, note, performed_by)
           VALUES ($1,$2,'sale',$3,'Marketplace order fulfilled',$4)`,
          [storeId, item.product_id, fromBackroom, req.user.sub]
        );
      }
      await recomputeProductQuantities(client, item.product_id);
    }

    await client.query(`UPDATE marketplace_orders SET status = 'fulfilled', fulfilled_at = now() WHERE id = $1`, [orderId]);
    // Pay-on-delivery: the store collected the money, so the commission goes on its balance.
    await require('./settlementsController').recordCashCompleted(client, order, req.user.sub);
    await client.query('COMMIT');
    emitToStore(storeId, 'marketplace:order_fulfilled', { id: orderId });
    res.json({ message: 'Order fulfilled, stock updated' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to fulfill order' });
  } finally {
    client.release();
  }
}

module.exports = {
  browseProducts, listStores, searchProducts, customerSignup, customerLogin, placeOrder, listMyOrders,
  listStoreOrders, getStoreOrder, fulfillOrder,
};
