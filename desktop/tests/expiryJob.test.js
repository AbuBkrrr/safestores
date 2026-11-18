const crypto = require('crypto');
const db = require('../server/db');
const { createStore, createProduct } = require('./helpers/factories');
const { runExpirySweep } = require('../server/expiryJob');

function futureDate(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function insertBatch(storeId, productId, expiryDate, qty, batchNumber = 'B1') {
  db.prepare(
    `INSERT INTO batches (id, store_id, product_id, batch_number, expiry_date, quantity_received) VALUES (?,?,?,?,?,?)`
  ).run(crypto.randomUUID(), storeId, productId, batchNumber, expiryDate, qty);
}

describe('expiryJob: runExpirySweep', () => {
  let fetchSpy;
  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ status: 200 });
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('creates a notification for an ambient product expiring within its 30-day window', async () => {
    const store = await createStore();
    const product = await createProduct(store.id, { name: 'Bread', backroomQty: 0, shelfQty: 0 });
    insertBatch(store.id, product.id, futureDate(5), 10);

    runExpirySweep();

    const notif = db.prepare(`SELECT * FROM store_notifications WHERE store_id = ? AND type = 'expiry_alert'`).get(store.id);
    expect(notif).toBeTruthy();
    expect(notif.message).toContain('Bread');
  });

  it('does NOT alert an ambient product 45 days out (outside its 30-day window)', async () => {
    const store = await createStore();
    const product = await createProduct(store.id, { name: 'Canned Beans', backroomQty: 0, shelfQty: 0 });
    insertBatch(store.id, product.id, futureDate(45), 10);

    runExpirySweep();

    const notif = db.prepare(`SELECT * FROM store_notifications WHERE store_id = ? AND type = 'expiry_alert'`).get(store.id);
    expect(notif).toBeUndefined();
  });

  it('a refrigerated product 12 days out is NOT alerted (outside its shorter 10-day window), even though ambient would be', async () => {
    const store = await createStore();
    const product = await createProduct(store.id, { name: 'Yogurt', backroomQty: 0, shelfQty: 0 });
    db.prepare(`UPDATE products SET storage_type = 'refrigerated' WHERE id = ?`).run(product.id);
    insertBatch(store.id, product.id, futureDate(12), 10);

    runExpirySweep();

    const notif = db.prepare(`SELECT * FROM store_notifications WHERE store_id = ?`).get(store.id);
    expect(notif).toBeUndefined();
  });

  it('escalates severity to amber for an urgent (<=2 days) refrigerated/frozen item', async () => {
    const store = await createStore();
    const product = await createProduct(store.id, { name: 'Milk', backroomQty: 0, shelfQty: 0 });
    db.prepare(`UPDATE products SET storage_type = 'refrigerated' WHERE id = ?`).run(product.id);
    insertBatch(store.id, product.id, futureDate(1), 10);

    runExpirySweep();

    const notif = db.prepare(`SELECT * FROM store_notifications WHERE store_id = ?`).get(store.id);
    expect(notif.severity).toBe('amber');
    expect(notif.message).toContain('act today');
  });

  it('a fully-consumed batch (zero remaining) does not trigger an alert', async () => {
    const store = await createStore();
    const product = await createProduct(store.id, { name: 'Sold Out Item', backroomQty: 0, shelfQty: 0 });
    insertBatch(store.id, product.id, futureDate(3), 5);
    // Consume all 5 via a sale movement
    db.prepare(`INSERT INTO stock_movements (id, store_id, product_id, type, quantity) VALUES (?,?,?,'sale',5)`)
      .run(crypto.randomUUID(), store.id, product.id);

    runExpirySweep();

    const notif = db.prepare(`SELECT * FROM store_notifications WHERE store_id = ?`).get(store.id);
    expect(notif).toBeUndefined();
  });

  it('dispatches a batch.expiring webhook when a store has one configured', async () => {
    const store = await createStore();
    const product = await createProduct(store.id, { name: 'Cheese', backroomQty: 0, shelfQty: 0 });
    insertBatch(store.id, product.id, futureDate(2), 10);
    db.prepare(
      `INSERT INTO webhooks (id, store_id, url, secret, events, active) VALUES (?,?,?,?,?,1)`
    ).run(crypto.randomUUID(), store.id, 'https://example.com/hook', 'secret', JSON.stringify(['batch.expiring']));

    runExpirySweep();
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('processes every store independently — one store having no batches does not block another', async () => {
    const storeA = await createStore();
    const storeB = await createStore();
    const productB = await createProduct(storeB.id, { name: 'Urgent Item', backroomQty: 0, shelfQty: 0 });
    insertBatch(storeB.id, productB.id, futureDate(1), 5);

    runExpirySweep();

    const notifA = db.prepare(`SELECT * FROM store_notifications WHERE store_id = ?`).get(storeA.id);
    const notifB = db.prepare(`SELECT * FROM store_notifications WHERE store_id = ?`).get(storeB.id);
    expect(notifA).toBeUndefined();
    expect(notifB).toBeTruthy();
  });
});
