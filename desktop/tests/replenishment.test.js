const crypto = require('crypto');
const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createProduct } = require('./helpers/factories');
const db = require('../server/db');

// Smart Replenishment is driven entirely by actual sale velocity (see
// server/utils/replenishment.js) — reorder_level on the product row is NOT
// consulted here (that field only feeds the simpler Analytics low-stock
// count). So "needs reorder" tests must seed real recent sale history,
// not just set a low on-hand quantity.
function seedRecentSales(storeId, productId, totalQty) {
  db.prepare(
    `INSERT INTO stock_movements (id, store_id, product_id, type, quantity, created_at)
     VALUES (?, ?, ?, 'sale', ?, datetime('now', '-1 day'))`
  ).run(crypto.randomUUID(), storeId, productId, totalQty);
}

describe('Replenishment Suggestions', () => {
  it('suggests reorder for a fast-selling product that is low on hand', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id, { backroomQty: 5, shelfQty: 0 });
    await seedRecentSales(store.id, product.id, 300); // ~10/day velocity, default 7-day lead time

    const res = await request()
      .get(`/api/stores/${store.id}/replenishment/suggestions`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const suggestion = res.body.find((s) => s.productId === product.id);
    expect(suggestion).toBeTruthy();
    expect(suggestion.needsReorder).toBe(true);
    expect(suggestion.suggestedQty).toBeGreaterThan(0);
  });

  it('does not suggest reorder for a product with no sales history and positive stock', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    await createProduct(store.id, { backroomQty: 500, shelfQty: 0, reorderLevel: 5 });

    const res = await request()
      .get(`/api/stores/${store.id}/replenishment/suggestions`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.body).toHaveLength(0);
  });
});

describe('Purchase Orders', () => {
  it('creates a draft purchase order with computed total cost', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id, { costPrice: 5 });

    const res = await request()
      .post(`/api/stores/${store.id}/replenishment/purchase-orders`)
      .set('Authorization', `Bearer ${token}`)
      .send({ supplier: 'Acme Supplies', items: [{ productId: product.id, quantity: 20 }] });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('draft');
    expect(Number(res.body.total_cost)).toBe(100);
  });

  it('rejects a purchase order with no items', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const res = await request()
      .post(`/api/stores/${store.id}/replenishment/purchase-orders`)
      .set('Authorization', `Bearer ${token}`)
      .send({ supplier: 'Acme', items: [] });

    expect(res.status).toBe(400);
  });

  it('sends a draft PO, setting an expected delivery date', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id, { costPrice: 5 });
    const created = await request()
      .post(`/api/stores/${store.id}/replenishment/purchase-orders`)
      .set('Authorization', `Bearer ${token}`)
      .send({ supplier: 'Acme', items: [{ productId: product.id, quantity: 10 }] });

    const res = await request()
      .patch(`/api/stores/${store.id}/replenishment/purchase-orders/${created.body.id}/send`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('sent');
    expect(res.body.expected_at).toBeTruthy();
  });

  it('receiving a PO applies arrivals and updates stock', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id, { backroomQty: 0, costPrice: 5 });
    const created = await request()
      .post(`/api/stores/${store.id}/replenishment/purchase-orders`)
      .set('Authorization', `Bearer ${token}`)
      .send({ supplier: 'Acme', items: [{ productId: product.id, quantity: 30 }] });
    await request().patch(`/api/stores/${store.id}/replenishment/purchase-orders/${created.body.id}/send`)
      .set('Authorization', `Bearer ${token}`);

    const res = await request()
      .post(`/api/stores/${store.id}/replenishment/purchase-orders/${created.body.id}/receive`)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('received');

    const list = await request().get(`/api/stores/${store.id}/products`).set('Authorization', `Bearer ${token}`);
    expect(list.body.find((p) => p.id === product.id).backroom_qty).toBe(30);
  });

  it('cannot receive an already-received PO twice', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id, { costPrice: 5 });
    const created = await request()
      .post(`/api/stores/${store.id}/replenishment/purchase-orders`)
      .set('Authorization', `Bearer ${token}`)
      .send({ supplier: 'Acme', items: [{ productId: product.id, quantity: 5 }] });
    await request().post(`/api/stores/${store.id}/replenishment/purchase-orders/${created.body.id}/receive`)
      .set('Authorization', `Bearer ${token}`).send({});

    const res = await request()
      .post(`/api/stores/${store.id}/replenishment/purchase-orders/${created.body.id}/receive`)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(409);
  });

  it('cancels a draft PO', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id);
    const created = await request()
      .post(`/api/stores/${store.id}/replenishment/purchase-orders`)
      .set('Authorization', `Bearer ${token}`)
      .send({ supplier: 'Acme', items: [{ productId: product.id, quantity: 5 }] });

    const res = await request()
      .patch(`/api/stores/${store.id}/replenishment/purchase-orders/${created.body.id}/cancel`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
  });
});
