const crypto = require('crypto');
const db = require('../server/db');
const { createStore, createProduct } = require('./helpers/factories');
const { runReplenishmentSweep } = require('../server/replenishmentJob');

// Smart Replenishment needs real recent sale velocity to trigger — see
// the equivalent note in the cloud/web backend's replenishment tests.
function seedRecentSales(storeId, productId, qty) {
  db.prepare(
    `INSERT INTO stock_movements (id, store_id, product_id, type, quantity, created_at) VALUES (?,?,?,'sale',?, datetime('now','-1 day'))`
  ).run(crypto.randomUUID(), storeId, productId, qty);
}

describe('replenishmentJob: runReplenishmentSweep', () => {
  let fetchSpy;
  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ status: 200 });
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('auto-reorder product: creates a draft PO with correct cost, and notifies admins to review it', async () => {
    const store = await createStore();
    const product = await createProduct(store.id, { backroomQty: 5, shelfQty: 0, costPrice: 4 });
    db.prepare(`UPDATE products SET auto_reorder = 1, supplier = 'Acme Co' WHERE id = ?`).run(product.id);
    seedRecentSales(store.id, product.id, 300); // ~10/day

    runReplenishmentSweep();

    const po = db.prepare(`SELECT * FROM purchase_orders WHERE store_id = ? AND supplier = 'Acme Co'`).get(store.id);
    expect(po).toBeTruthy();
    expect(po.status).toBe('draft');
    expect(po.auto_generated).toBe(1);
    expect(po.total_cost).toBeGreaterThan(0);

    const notif = db.prepare(`SELECT * FROM store_notifications WHERE store_id = ? AND type = 'po_auto_generated'`).get(store.id);
    expect(notif).toBeTruthy();
  });

  it('manual (non-auto-reorder) product: notifies but does NOT create a purchase order', async () => {
    const store = await createStore();
    const product = await createProduct(store.id, { backroomQty: 5, shelfQty: 0 });
    seedRecentSales(store.id, product.id, 300);
    // auto_reorder defaults to 0/false

    runReplenishmentSweep();

    const po = db.prepare(`SELECT * FROM purchase_orders WHERE store_id = ?`).get(store.id);
    expect(po).toBeUndefined();
    const notif = db.prepare(`SELECT * FROM store_notifications WHERE store_id = ? AND type = 'reorder_needed'`).get(store.id);
    expect(notif).toBeTruthy();
  });

  it('does not create a second auto-draft PO for the same supplier while an unreviewed one already exists', async () => {
    const store = await createStore();
    const product = await createProduct(store.id, { backroomQty: 5, shelfQty: 0, costPrice: 4 });
    db.prepare(`UPDATE products SET auto_reorder = 1, supplier = 'Acme Co' WHERE id = ?`).run(product.id);
    seedRecentSales(store.id, product.id, 300);

    runReplenishmentSweep();
    runReplenishmentSweep(); // simulate the next day's check finding the same still-unreviewed condition

    const pos = db.prepare(`SELECT * FROM purchase_orders WHERE store_id = ?`).all(store.id);
    expect(pos).toHaveLength(1);
  });

  it('groups multiple auto-reorder products from the same supplier into ONE purchase order', async () => {
    const store = await createStore();
    const p1 = await createProduct(store.id, { backroomQty: 5, shelfQty: 0, costPrice: 4 });
    const p2 = await createProduct(store.id, { backroomQty: 5, shelfQty: 0, costPrice: 6 });
    db.prepare(`UPDATE products SET auto_reorder = 1, supplier = 'Shared Supplier' WHERE id IN (?,?)`).run(p1.id, p2.id);
    seedRecentSales(store.id, p1.id, 300);
    seedRecentSales(store.id, p2.id, 300);

    runReplenishmentSweep();

    const pos = db.prepare(`SELECT * FROM purchase_orders WHERE store_id = ?`).all(store.id);
    expect(pos).toHaveLength(1);
    const items = db.prepare(`SELECT * FROM purchase_order_items WHERE purchase_order_id = ?`).all(pos[0].id);
    expect(items).toHaveLength(2);
  });

  it('a well-stocked product with no sales history triggers nothing', async () => {
    const store = await createStore();
    await createProduct(store.id, { backroomQty: 500, shelfQty: 0 });

    runReplenishmentSweep();

    const notif = db.prepare(`SELECT * FROM store_notifications WHERE store_id = ?`).get(store.id);
    expect(notif).toBeUndefined();
  });

  it('dispatches a purchase_order.auto_created webhook when a PO is auto-generated', async () => {
    const store = await createStore();
    const product = await createProduct(store.id, { backroomQty: 5, shelfQty: 0, costPrice: 4 });
    db.prepare(`UPDATE products SET auto_reorder = 1, supplier = 'Acme Co' WHERE id = ?`).run(product.id);
    seedRecentSales(store.id, product.id, 300);
    db.prepare(
      `INSERT INTO webhooks (id, store_id, url, secret, events, active) VALUES (?,?,?,?,?,1)`
    ).run(crypto.randomUUID(), store.id, 'https://example.com/hook', 'secret', JSON.stringify(['purchase_order.auto_created']));

    runReplenishmentSweep();
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
