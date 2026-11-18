const crypto = require('crypto');
const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createProduct } = require('./helpers/factories');
const db = require('../server/db');

function seedTask(storeId, productId) {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO cycle_count_tasks (id, store_id, product_id, risk_tier, due_date, status) VALUES (?,?,?,'medium', datetime('now'), 'pending')`
  ).run(id, storeId, productId);
  return db.prepare('SELECT * FROM cycle_count_tasks WHERE id = ?').get(id);
}

describe('Cycle Counting', () => {
  it('submits a count and computes discrepancy against on-hand total', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id, { backroomQty: 10, shelfQty: 5 }); // on-hand = 15

    const res = await request()
      .post(`/api/stores/${store.id}/cycle-counts`)
      .set('Authorization', `Bearer ${token}`)
      .send({ productId: product.id, countedQty: 12 });

    expect(res.status).toBe(201);
    expect(res.body.expected_qty).toBe(15);
    expect(res.body.discrepancy).toBe(-3);
  });

  it('auto-adjusts the backroom pool (not shelf) when autoAdjust is true and there is a discrepancy', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    // Backroom is the pool a whole-product cycle count discrepancy gets
    // applied to (see cycleCountController.js's header comment) — shelf
    // is what Shelf Audit exists to correct precisely.
    const product = await createProduct(store.id, { backroomQty: 20, shelfQty: 10 });

    const res = await request()
      .post(`/api/stores/${store.id}/cycle-counts`)
      .set('Authorization', `Bearer ${token}`)
      .send({ productId: product.id, countedQty: 28, autoAdjust: true }); // expected 30, discrepancy -2

    expect(res.status).toBe(201);
    expect(res.body.warning).toBeNull();

    const list = await request().get(`/api/stores/${store.id}/products`).set('Authorization', `Bearer ${token}`);
    const updated = list.body.find((p) => p.id === product.id);
    expect(updated.backroom_qty).toBe(18); // 20 - 2
    expect(updated.shelf_qty).toBe(10); // untouched
  });

  it('clamps the adjustment at zero and returns a warning when the discrepancy exceeds recorded backroom stock', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    // This is the exact scenario that used to drive shelf_qty negative:
    // most of the product's real stock sits on the shelf, and the
    // combined-total discrepancy is bigger than backroom alone can absorb.
    const product = await createProduct(store.id, { backroomQty: 0, shelfQty: 10 });

    const res = await request()
      .post(`/api/stores/${store.id}/cycle-counts`)
      .set('Authorization', `Bearer ${token}`)
      .send({ productId: product.id, countedQty: 8, autoAdjust: true }); // expected 10, discrepancy -2

    expect(res.status).toBe(201);
    expect(res.body.warning).toMatch(/exceeds recorded backroom stock/);

    const list = await request().get(`/api/stores/${store.id}/products`).set('Authorization', `Bearer ${token}`);
    const updated = list.body.find((p) => p.id === product.id);
    expect(updated.backroom_qty).toBe(0); // clamped, never went negative
    expect(updated.shelf_qty).toBe(10); // untouched — the old bug applied the -2 here instead
  });

  it('completes the linked task when submitted with a taskId', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id);
    const task = seedTask(store.id, product.id);

    await request()
      .post(`/api/stores/${store.id}/cycle-counts`)
      .set('Authorization', `Bearer ${token}`)
      .send({ productId: product.id, taskId: task.id, countedQty: product.backroom_qty + product.shelf_qty });

    const tasks = await request()
      .get(`/api/stores/${store.id}/cycle-counts/tasks?status=completed`)
      .set('Authorization', `Bearer ${token}`);
    expect(tasks.body.some((t) => t.id === task.id)).toBe(true);
  });

  it('skipping a task removes it from the pending list', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id);
    const task = seedTask(store.id, product.id);

    const res = await request()
      .post(`/api/stores/${store.id}/cycle-counts/tasks/${task.id}/skip`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(204);

    const pending = await request()
      .get(`/api/stores/${store.id}/cycle-counts/tasks`)
      .set('Authorization', `Bearer ${token}`);
    expect(pending.body.some((t) => t.id === task.id)).toBe(false);
  });

  it('reports accuracy rate over recent counts', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id, { backroomQty: 0, shelfQty: 10 });

    await request().post(`/api/stores/${store.id}/cycle-counts`).set('Authorization', `Bearer ${token}`)
      .send({ productId: product.id, countedQty: 10 });

    const res = await request().get(`/api/stores/${store.id}/cycle-counts/accuracy`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.totalCounts).toBeGreaterThanOrEqual(1);
    expect(res.body.accuracyRate).toBe(100);
  });
});
