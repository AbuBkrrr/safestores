// Desktop parity for Phase 3 (branch transfers + storefront are cloud-only):
// Phase 3: product import, barcodes/variants, branch transfers, insights,
// loyalty points + birthdays, storefront tracking/share/sitemap.
const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createUser, createProduct, tokenFor } = require('./helpers/factories');
const sqlite = require('../server/db');
const pool = {
  query: async (sql, params = []) => {
    const q = sql.replace(/\$\d+/g, '?').replace(/now\(\) - interval '(\d+) days'/g, "strftime('%Y-%m-%dT%H:%M:%fZ','now','-$1 days')");
    const stmt = sqlite.prepare(q);
    return stmt.reader ? { rows: stmt.all(...params) } : (stmt.run(...params), { rows: [] });
  },
};
const insights = require('../server/utils/insights');
const { normalizeRow } = require('../server/utils/productImport');
const loyalty = require('../server/utils/loyalty');

const A = (token) => ({ Authorization: `Bearer ${token}` });

describe('pure helpers', () => {
  it('normalises spreadsheet rows with common header names', () => {
    const r = normalizeRow({ 'Product Name': 'Peak Milk 400g', Code: 'PK400', 'Cost Price': '1,200', 'Selling Price': '1500', Qty: '24', 'Units per carton': '12' });
    expect(r.ok).toBe(true);
    expect(r.value).toMatchObject({ name: 'Peak Milk 400g', sku: 'PK400', costPrice: 1200, priceMultiplier: 1.25, openingStock: 24, packSize: 12 });
    expect(normalizeRow({ Name: 'X' }).ok).toBe(false);
    expect(normalizeRow({ Name: 'X', SKU: 'x', Price: 'abc' }).ok).toBe(false);
  });

  it('ABC classes and loyalty FIFO expiry', () => {
    const products = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }];
    const lines = [{ product_id: 'a', quantity: 1, line_total: 85 }, { product_id: 'b', quantity: 1, line_total: 10 }, { product_id: 'c', quantity: 1, line_total: 5 }];
    expect(insights.abc({ products, lines }).products.map((p) => p.class)).toEqual(['A', 'B', 'C']);

    const now = new Date('2026-06-01T00:00:00Z');
    const b = loyalty.balance([
      { points: 100, created_at: '2025-01-01', expires_at: '2026-01-01' },  // expired
      { points: 50, created_at: '2026-03-01', expires_at: '2026-06-20' },  // expiring soon
      { points: -30, created_at: '2025-06-01' },                           // redeemed from the oldest
    ], now);
    expect(b).toMatchObject({ available: 50, expired: 70, redeemed: 30, expiringSoon: 50 });
    expect(loyalty.pointsEarned(2550, 2)).toBe(51);
  });
});

describe('Product import', () => {
  it('dry-runs, then creates new SKUs with opening stock and updates existing ones', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const existing = await createProduct(store.id, { sku: 'EXIST-1', costPrice: 10 });
    const rows = [
      { Name: 'New Thing', SKU: 'NEW-1', Barcode: '6151234567890', Cost: '100', Price: '150', Stock: '20', Category: 'Snacks' },
      { Name: 'Renamed', SKU: 'EXIST-1', Cost: '12' },
      { Name: 'Broken row' },
    ];
    const dry = await request().post(`/api/stores/${store.id}/products/import`).set(A(token)).send({ rows, dryRun: true });
    expect(dry.body).toMatchObject({ dryRun: true, create: 1, update: 1 });
    expect(dry.body.errors).toEqual([{ row: 4, error: 'Needs a SKU or a barcode' }]);

    const res = await request().post(`/api/stores/${store.id}/products/import`).set(A(token)).send({ rows });
    expect(res.body).toMatchObject({ created: 1, updated: 1 });
    const { rows: p } = await pool.query('SELECT * FROM products WHERE store_id = $1 ORDER BY sku', [store.id]);
    const created = p.find((x) => x.sku === 'NEW-1');
    expect(created.backroom_qty).toBe(20);
    expect(Number(created.price_multiplier)).toBe(1.5);
    expect(created.barcode).toBe('6151234567890');
    expect(p.find((x) => x.id === existing.id).name).toBe('Renamed');

    const scan = await request().get(`/api/stores/${store.id}/barcode-lookup`).query({ code: '6151234567890' }).set(A(token));
    expect(scan.body.id).toBe(created.id);
  });

  it('keeps typed selling prices exact to the cent', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    await request().post(`/api/stores/${store.id}/products/import`).set(A(token)).send({ rows: [{ Name: 'Spaghetti', SKU: 'GPS500', Cost: '700', Price: '850' }] });
    const list = await request().get(`/api/stores/${store.id}/products`).set(A(token));
    expect(Number(list.body.find((p) => p.sku === 'GPS500').selling_price).toFixed(2)).toBe('850.00');
  });

  it('cashiers cannot import', async () => {
    const { store } = await createActiveStoreWithAdmin();
    const cashier = await createUser(store.id, { role: 'cashier' });
    expect((await request().post(`/api/stores/${store.id}/products/import`).set(A(tokenFor(cashier))).send({ rows: [{ Name: 'x', SKU: 'x' }] })).status).toBe(403);
  });
});

describe('Insights', () => {
  it('profit, ABC, dead stock, forecast and heatmap from real sales', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const fast = await createProduct(store.id, { name: 'Fast', costPrice: 10, priceMultiplier: 1.5, shelfQty: 20 });
    const idle = await createProduct(store.id, { name: 'Idle', costPrice: 4, backroomQty: 25 });
    await pool.query(`UPDATE products SET created_at = now() - interval '120 days' WHERE id = $1`, [idle.id]);
    const o = await request().post(`/api/stores/${store.id}/orders`).set(A(token)).send({});
    await request().post(`/api/stores/${store.id}/orders/${o.body.id}/items`).set(A(token)).send({ productId: fast.id, quantity: 4 });
    await request().post(`/api/stores/${store.id}/orders/${o.body.id}/pay`).set(A(token)).send({ paymentMethod: 'cash' });

    const p = await request().get(`/api/stores/${store.id}/insights/profit`).set(A(token));
    expect(p.body).toMatchObject({ revenue: 60, cost: 40, profit: 20 });
    expect(p.body.products[0]).toMatchObject({ name: 'Fast', marginPct: 33.33 });

    const abc = await request().get(`/api/stores/${store.id}/insights/abc`).set(A(token));
    expect(abc.body.products.find((x) => x.name === 'Fast').class).toBe('A');

    const dead = await request().get(`/api/stores/${store.id}/insights/dead-stock`).query({ days: 60 }).set(A(token));
    expect(dead.body.products.map((x) => x.name)).toEqual(['Idle']);
    expect(dead.body.totalValue).toBe(100);

    const fc = await request().get(`/api/stores/${store.id}/insights/forecast`).query({ days: 30 }).set(A(token));
    expect(fc.body.products.find((x) => x.name === 'Fast').avgDaily).toBeCloseTo(0.13, 2);

    const hm = await request().get(`/api/stores/${store.id}/insights/heatmap`).set(A(token));
    expect(hm.body.grid.flat().reduce((s, v) => s + v, 0)).toBe(60);

    const cashier = await createUser(store.id, { role: 'cashier' });
    expect((await request().get(`/api/stores/${store.id}/insights/profit`).set(A(tokenFor(cashier)))).status).toBe(403);
  });
});

describe('Loyalty points & birthdays', () => {
  it('earns on paid sales linked to a customer and redeems as a discount', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    await request().patch(`/api/stores/${store.id}/settings`).set(A(token)).send({ pointsPer100: 10, pointValue: 0.5, pointsExpiryMonths: 12 });
    const cust = await request().post(`/api/stores/${store.id}/customers`).set(A(token)).send({ name: 'Ada', phone: '+2348000000000', birthday: '1990-01-15' });
    const product = await createProduct(store.id, { costPrice: 100, priceMultiplier: 2, shelfQty: 20 }); // 200 each

    const o1 = await request().post(`/api/stores/${store.id}/orders`).set(A(token)).send({});
    await request().post(`/api/stores/${store.id}/orders/${o1.body.id}/items`).set(A(token)).send({ productId: product.id, quantity: 5 }); // 1000
    await request().post(`/api/stores/${store.id}/orders/${o1.body.id}/customer`).set(A(token)).send({ storeCustomerId: cust.body.id });
    await request().post(`/api/stores/${store.id}/orders/${o1.body.id}/pay`).set(A(token)).send({ paymentMethod: 'card' });
    let pts = await request().get(`/api/stores/${store.id}/customers/${cust.body.id}/points`).set(A(token));
    expect(pts.body).toMatchObject({ available: 100, value: 50 });

    const o2 = await request().post(`/api/stores/${store.id}/orders`).set(A(token)).send({});
    await request().post(`/api/stores/${store.id}/orders/${o2.body.id}/items`).set(A(token)).send({ productId: product.id, quantity: 1 }); // 200
    expect((await request().post(`/api/stores/${store.id}/orders/${o2.body.id}/redeem-points`).set(A(token)).send({ storeCustomerId: cust.body.id, points: 500 })).status).toBe(400);
    const red = await request().post(`/api/stores/${store.id}/orders/${o2.body.id}/redeem-points`).set(A(token)).send({ storeCustomerId: cust.body.id, points: 60 });
    expect(Number(red.body.total)).toBe(170);
    await request().post(`/api/stores/${store.id}/orders/${o2.body.id}/pay`).set(A(token)).send({ paymentMethod: 'cash' });
    pts = await request().get(`/api/stores/${store.id}/customers/${cust.body.id}/points`).set(A(token));
    expect(pts.body.available).toBe(100 - 60 + 17);
  });

  it('lists upcoming birthdays', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const soon = new Date(Date.now() + 3 * 86400000);
    const iso = `1995-${String(soon.getMonth() + 1).padStart(2, '0')}-${String(soon.getDate()).padStart(2, '0')}`;
    await request().post(`/api/stores/${store.id}/customers`).set(A(token)).send({ name: 'Soon', birthday: iso });
    await request().post(`/api/stores/${store.id}/customers`).set(A(token)).send({ name: 'NoBday' });
    const res = await request().get(`/api/stores/${store.id}/customers/birthdays`).query({ days: 7 }).set(A(token));
    expect(res.body.map((c) => c.name)).toEqual(['Soon']);
  });
});

