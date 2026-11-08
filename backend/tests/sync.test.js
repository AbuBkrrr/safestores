const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createProduct } = require('./helpers/factories');
const { pool } = require('../src/config/db');
const { v4: uuidv4 } = require('uuid');

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
