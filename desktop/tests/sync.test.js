const crypto = require('crypto');
const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createProduct } = require('./helpers/factories');
const db = require('../server/db');

function getSyncKey(storeId) {
  return db.prepare('SELECT sync_key FROM stores WHERE id = ?').get(storeId).sync_key;
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
    const syncKey = getSyncKey(store.id);
    await createProduct(store.id, { name: 'Old Product' });
    const cutoff = new Date(Date.now() + 50).toISOString();

    await new Promise((r) => setTimeout(r, 100));
    await createProduct(store.id, { name: 'New Product' });

    const res = await request().get(`/api/stores/${store.id}/sync/export?since=${cutoff}`).set('x-store-sync-key', syncKey);
    expect(res.status).toBe(200);
    const names = res.body.products.map((p) => p.name);
    expect(names).toContain('New Product');
    expect(names).not.toContain('Old Product');
  });
});

describe('Sync: import', () => {
  it('imports a brand-new product + movement idempotently — replaying the same batch twice is a no-op', async () => {
    const { store } = await createActiveStoreWithAdmin();
    const syncKey = getSyncKey(store.id);
    const now = new Date().toISOString();
    const productId = crypto.randomUUID();
    const movementId = crypto.randomUUID();

    const batch = {
      products: [{
        id: productId, name: 'Synced Product', sku: 'SYNC-1', unit: 'unit', cost_price: 5, price_multiplier: 1.5,
        reorder_level: 5, lead_time_days: 7, min_order_qty: 1, auto_reorder: 0,
        created_at: now, updated_at: now,
      }],
      movements: [{ id: movementId, product_id: productId, type: 'arrival', quantity: 20, created_at: now }],
    };

    const first = await request().post(`/api/stores/${store.id}/sync/import`).set('x-store-sync-key', syncKey).send(batch);
    expect(first.status).toBe(200);
    expect(first.body.merged.products).toBe(1);

    const second = await request().post(`/api/stores/${store.id}/sync/import`).set('x-store-sync-key', syncKey).send(batch);
    expect(second.status).toBe(200);

    const row = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    expect(row).toBeTruthy();
    expect(row.backroom_qty).toBe(20);
  });

  it('a purchase order status can only advance, never regress, when synced out of order', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const syncKey = getSyncKey(store.id);
    const product = await createProduct(store.id);

    const created = await request().post(`/api/stores/${store.id}/replenishment/purchase-orders`).set('Authorization', `Bearer ${token}`)
      .send({ supplier: 'Acme', items: [{ productId: product.id, quantity: 5 }] });
    await request().post(`/api/stores/${store.id}/replenishment/purchase-orders/${created.body.id}/receive`).set('Authorization', `Bearer ${token}`).send({});

    const staleImport = await request().post(`/api/stores/${store.id}/sync/import`).set('x-store-sync-key', syncKey).send({
      purchaseOrders: [{
        id: created.body.id, supplier: 'Acme', status: 'sent', total_cost: created.body.total_cost,
        created_at: created.body.created_at,
      }],
    });
    expect(staleImport.status).toBe(200);

    const row = db.prepare('SELECT status FROM purchase_orders WHERE id = ?').get(created.body.id);
    expect(row.status).toBe('received'); // unchanged
  });

  it('an unresolvable performed_by reference is nulled, not fatal to the whole batch', async () => {
    const { store } = await createActiveStoreWithAdmin();
    const syncKey = getSyncKey(store.id);
    const product = await createProduct(store.id);
    const ghostUserId = crypto.randomUUID();

    const res = await request().post(`/api/stores/${store.id}/sync/import`).set('x-store-sync-key', syncKey).send({
      movements: [{
        id: crypto.randomUUID(), product_id: product.id, type: 'sale', quantity: 1, performed_by: ghostUserId, created_at: new Date().toISOString(),
      }],
    });

    expect(res.status).toBe(200);
    expect(res.body.merged.movements).toBe(1);
  });

  it('two devices independently creating a supplier with the same name are merged into one row', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const syncKey = getSyncKey(store.id);
    const localSupplier = await request().post(`/api/stores/${store.id}/suppliers`).set('Authorization', `Bearer ${token}`).send({ name: 'Shared Name Co' });

    const res = await request().post(`/api/stores/${store.id}/sync/import`).set('x-store-sync-key', syncKey).send({
      suppliers: [{ id: crypto.randomUUID(), name: 'Shared Name Co', created_at: new Date().toISOString() }],
    });
    expect(res.status).toBe(200);

    const rows = db.prepare('SELECT * FROM suppliers WHERE store_id = ?').all(store.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(localSupplier.body.id);
  });

  it('a user created on another device syncs in, letting later rows attribute to them correctly', async () => {
    const { store } = await createActiveStoreWithAdmin();
    const syncKey = getSyncKey(store.id);
    const remoteUserId = crypto.randomUUID();
    const product = await createProduct(store.id);

    const res = await request().post(`/api/stores/${store.id}/sync/import`).set('x-store-sync-key', syncKey).send({
      users: [{
        id: remoteUserId, name: 'Remote Cashier', email: `remote${Date.now()}@example.com`,
        password_hash: 'x', role: 'staff', status: 'active', created_at: new Date().toISOString(),
      }],
      movements: [{
        id: crypto.randomUUID(), product_id: product.id, type: 'sale', quantity: 1, performed_by: remoteUserId, created_at: new Date().toISOString(),
      }],
    });

    expect(res.status).toBe(200);
    const movement = db.prepare('SELECT performed_by FROM stock_movements WHERE product_id = ? AND performed_by IS NOT NULL').get(product.id);
    expect(movement.performed_by).toBe(remoteUserId);
  });
});
