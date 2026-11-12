const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createProduct } = require('./helpers/factories');
const { pool } = require('../src/config/db');
const { randomUUID: uuidv4 } = require('crypto');

async function getSyncKey(storeId) {
  const { rows } = await pool.query('SELECT sync_key FROM stores WHERE id = $1', [storeId]);
  return rows[0].sync_key;
}

describe('Sync: auth', () => {
  it('rejects export/import with no sync key', async () => {
    const { store } = await createActiveStoreWithAdmin();
    const res = await request().get(`/api/stores/${store.id}/sync/export`);
    expect(res.status).toBe(401);
  });

  it('rejects a wrong sync key', async () => {
    const { store } = await createActiveStoreWithAdmin();
    const res = await request().get(`/api/stores/${store.id}/sync/export`).set('x-store-sync-key', 'not-the-real-key');
    expect(res.status).toBe(401);
  });

  it('a valid store JWT (not the sync key) is NOT accepted here', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const res = await request().get(`/api/stores/${store.id}/sync/export`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });
});

describe('Sync: export', () => {
  it('exports rows created after `since`, excludes older ones', async () => {
    const { store } = await createActiveStoreWithAdmin();
    const syncKey = await getSyncKey(store.id);
    const oldProduct = await createProduct(store.id, { name: 'Old Product' });
    const cutoff = new Date(Date.now() + 1000).toISOString(); // definitely after the old product

    await new Promise((r) => setTimeout(r, 1100));
    const newProduct = await createProduct(store.id, { name: 'New Product' });

    const res = await request().get(`/api/stores/${store.id}/sync/export?since=${cutoff}`).set('x-store-sync-key', syncKey);
    expect(res.status).toBe(200);
    const names = res.body.products.map((p) => p.name);
    expect(names).toContain('New Product');
    expect(names).not.toContain('Old Product');
  });

  it('rejects an invalid `since` value', async () => {
    const { store } = await createActiveStoreWithAdmin();
    const syncKey = await getSyncKey(store.id);
    const res = await request().get(`/api/stores/${store.id}/sync/export?since=not-a-date`).set('x-store-sync-key', syncKey);
    expect(res.status).toBe(400);
  });
});

describe('Sync: import', () => {
  it('imports a brand-new product + movement idempotently — replaying the same batch twice is a no-op', async () => {
    const { store } = await createActiveStoreWithAdmin();
    const syncKey = await getSyncKey(store.id);
    const now = new Date().toISOString();
    const productId = uuidv4();
    const movementId = uuidv4();

    const batch = {
      products: [{
        id: productId, name: 'Synced Product', sku: 'SYNC-1', unit: 'unit', cost_price: 5, price_multiplier: 1.5,
        reorder_level: 5, lead_time_days: 7, min_order_qty: 1, auto_reorder: false,
        created_at: now, updated_at: now,
      }],
      movements: [{ id: movementId, product_id: productId, type: 'arrival', quantity: 20, created_at: now }],
    };

    const first = await request().post(`/api/stores/${store.id}/sync/import`).set('x-store-sync-key', syncKey).send(batch);
    expect(first.status).toBe(200);
    expect(first.body.merged.products).toBe(1);

    const second = await request().post(`/api/stores/${store.id}/sync/import`).set('x-store-sync-key', syncKey).send(batch);
    expect(second.status).toBe(200); // no error, no duplication

    const { rows } = await pool.query('SELECT * FROM products WHERE id = $1', [productId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].backroom_qty).toBe(20); // recomputed from the one movement, not doubled
  });

  it('a purchase order status can only advance, never regress, when synced out of order', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const syncKey = await getSyncKey(store.id);
    const product = await createProduct(store.id);

    const created = await request().post(`/api/stores/${store.id}/replenishment/purchase-orders`).set('Authorization', `Bearer ${token}`)
      .send({ supplier: 'Acme', items: [{ productId: product.id, quantity: 5 }] });
    await request().post(`/api/stores/${store.id}/replenishment/purchase-orders/${created.body.id}/receive`).set('Authorization', `Bearer ${token}`).send({});

    // A stale/out-of-order sync batch claims this PO is still just "sent" —
    // must NOT roll the locally-already-received PO backward.
    const staleImport = await request().post(`/api/stores/${store.id}/sync/import`).set('x-store-sync-key', syncKey).send({
      purchaseOrders: [{
        id: created.body.id, supplier: 'Acme', status: 'sent', total_cost: created.body.total_cost,
        created_at: created.body.created_at,
      }],
    });
    expect(staleImport.status).toBe(200);

    const { rows } = await pool.query('SELECT status FROM purchase_orders WHERE id = $1', [created.body.id]);
    expect(rows[0].status).toBe('received'); // unchanged
  });

  it('an unresolvable performed_by reference is nulled, not fatal to the whole batch', async () => {
    const { store } = await createActiveStoreWithAdmin();
    const syncKey = await getSyncKey(store.id);
    const product = await createProduct(store.id);
    const ghostUserId = uuidv4(); // a user id that doesn't exist on this server at all

    const res = await request().post(`/api/stores/${store.id}/sync/import`).set('x-store-sync-key', syncKey).send({
      movements: [{
        id: uuidv4(), product_id: product.id, type: 'sale', quantity: 1, performed_by: ghostUserId, created_at: new Date().toISOString(),
      }],
    });

    expect(res.status).toBe(200); // did not 500/rollback the whole batch
    expect(res.body.merged.movements).toBe(1);
  });

  it('two devices independently creating a supplier with the same name are merged into one row', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const syncKey = await getSyncKey(store.id);
    const localSupplier = await request().post(`/api/stores/${store.id}/suppliers`).set('Authorization', `Bearer ${token}`).send({ name: 'Shared Name Co' });

    const res = await request().post(`/api/stores/${store.id}/sync/import`).set('x-store-sync-key', syncKey).send({
      suppliers: [{ id: uuidv4(), name: 'Shared Name Co', created_at: new Date().toISOString() }],
    });
    expect(res.status).toBe(200);

    const { rows } = await pool.query('SELECT * FROM suppliers WHERE store_id = $1', [store.id]);
    expect(rows).toHaveLength(1); // deduped by (store_id, name), not two rows
    expect(rows[0].id).toBe(localSupplier.body.id);
  });
});

describe('Sync: v26 till data', () => {
  it('shifts, split tenders, discounts and refunds round-trip; replay is a no-op', async () => {
    const { store, admin: user } = await createActiveStoreWithAdmin();
    const syncKey = await getSyncKey(store.id);
    const now = new Date().toISOString();
    const [productId, shiftId, orderId, itemId, refundId] = [uuidv4(), uuidv4(), uuidv4(), uuidv4(), uuidv4()];
    const batch = {
      products: [{ id: productId, name: 'Rice', sku: 'R1', unit: 'bag', cost_price: 100, price_multiplier: 1.5, reorder_level: 1, lead_time_days: 1, min_order_qty: 1, auto_reorder: false, barcode: '1234567890128', pack_size: 6, created_at: now, updated_at: now }],
      shifts: [{ id: shiftId, opened_by: user.id, opened_at: now, opening_float: 500, status: 'closed', closed_by: user.id, closed_at: now, expected_cash: 600, counted_cash: 600, notes: null }],
      orders: [{ id: orderId, status: 'paid', subtotal: 300, total: 270, created_by: user.id, paid_by: user.id, payment_method: 'split', receipt_number: 'R-1', created_at: now, paid_at: now,
        discount_type: 'percent', discount_value: 10, discount_amount: 30, tax_rate_pct: 7.5, tax_inclusive: 1, tax_amount: 18.84, change_due: 0, shift_id: shiftId, points_redeemed: 0 }],
      orderItems: [{ id: itemId, order_id: orderId, product_id: productId, quantity: 2, unit_price: 150, line_total: 300, added_via: 'scan', created_at: now }],
      orderPayments: [
        { id: uuidv4(), order_id: orderId, method: 'cash', amount: 100, shift_id: shiftId, created_at: now },
        { id: uuidv4(), order_id: orderId, method: 'card', amount: 170, reference: 'POS-9', shift_id: shiftId, created_at: now },
      ],
      refunds: [{ id: refundId, order_id: orderId, amount: 135, method: 'cash', reason: 'Torn bag', created_by: user.id, shift_id: shiftId, created_at: now }],
      refundItems: [{ id: uuidv4(), refund_id: refundId, order_item_id: itemId, product_id: productId, quantity: 1, amount: 135, restocked: 1 }],
    };
    for (let i = 0; i < 2; i++) {
      const r = await request().post(`/api/stores/${store.id}/sync/import`).set('x-store-sync-key', syncKey).send(batch);
      expect(r.status).toBe(200);
    }
    const { rows: [o] } = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    expect(o).toMatchObject({ discount_type: 'percent', tax_inclusive: true, shift_id: shiftId });
    expect(Number(o.discount_amount)).toBe(30);
    expect(Number(o.refunded_total)).toBe(135);
    const { rows: pays } = await pool.query('SELECT method FROM order_payments WHERE order_id = $1 ORDER BY amount', [orderId]);
    expect(pays.map((p) => p.method)).toEqual(['cash', 'card']);
    const { rows: [p] } = await pool.query('SELECT barcode, pack_size FROM products WHERE id = $1', [productId]);
    expect(p).toEqual({ barcode: '1234567890128', pack_size: 6 });

    const exp = await request().get(`/api/stores/${store.id}/sync/export`).set('x-store-sync-key', syncKey);
    expect(exp.body.shifts).toHaveLength(1);
    expect(exp.body.orderPayments).toHaveLength(2);
    expect(exp.body.refunds).toHaveLength(1);
    expect(exp.body.refundItems).toHaveLength(1);
  });

  it('a sale parked earlier and paid later re-exports', async () => {
    const { store, admin: user } = await createActiveStoreWithAdmin();
    const syncKey = await getSyncKey(store.id);
    const id = uuidv4();
    await pool.query(
      `INSERT INTO orders (id, store_id, status, subtotal, total, created_by, created_at) VALUES ($1,$2,'pending_payment',10,10,$3, now() - interval '2 days')`,
      [id, store.id, user.id]
    );
    const since = new Date(Date.now() - 86400000).toISOString();
    await pool.query(`UPDATE orders SET status = 'paid', paid_at = now() WHERE id = $1`, [id]);
    const exp = await request().get(`/api/stores/${store.id}/sync/export?since=${since}`).set('x-store-sync-key', syncKey);
    expect(exp.body.orders.map((x) => x.id)).toContain(id);
  });
});
