// Real shop spreadsheets: their own column names, ₦ prices, no SKUs.
const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin } = require('./helpers/factories');

const A = (token) => ({ Authorization: `Bearer ${token}` });

describe('Product import from a shop’s own sheet', () => {
  it('reads Reference Cost / Selling Price headings and ₦ amounts', async () => {
    const s = await createActiveStoreWithAdmin();
    const url = `/api/stores/${s.store.id}/products/import`;
    const rows = [
      { SKU: 'RCS-03-005', 'Product Name': 'A4Tech Gaming mouse', Category: 'Mouse', 'Brand / Company': 'A4Tech', 'Reference Cost': '₦37,700', 'Selling Price ': '₦47,125', 'Price Basis': 'Provisional', 'Source URL': 'https://x' },
    ];
    const check = await request().post(url).set(A(s.token)).send({ rows, dryRun: true });
    expect(check.status).toBe(200);
    expect(check.body.columns).toMatchObject({ 'Reference Cost': 'costPrice', 'Selling Price ': 'sellingPrice', 'Price Basis': null });
    expect(check.body.preview[0]).toMatchObject({ cost: 37700, price: 47125 });
    expect(check.body.warnings).toEqual([]);
    await request().post(url).set(A(s.token)).send({ rows });
    const list = (await request().get(`/api/stores/${s.store.id}/products`).set(A(s.token))).body;
    const p = list.find((x) => x.sku === 'RCS-03-005');
    expect(Number(p.cost_price)).toBe(37700);
    expect(Number(p.cost_price) * Number(p.price_multiplier)).toBeCloseTo(47125, 2);
  });

  it('needs only Name and Price; uploading again updates the same products', async () => {
    const s = await createActiveStoreWithAdmin();
    const url = `/api/stores/${s.store.id}/products/import`;
    const first = await request().post(url).set(A(s.token)).send({ rows: [{ Name: 'Peak Milk 400g', Price: '1,500', Stock: 24 }] });
    expect(first.body).toMatchObject({ created: 1, updated: 0 });
    const again = await request().post(url).set(A(s.token)).send({ rows: [{ Name: 'Peak Milk 400g', Price: '1,600' }] });
    expect(again.body).toMatchObject({ created: 0, updated: 1 });
  });

  it('warns when the price cells are empty', async () => {
    const s = await createActiveStoreWithAdmin();
    const check = await request().post(`/api/stores/${s.store.id}/products/import`).set(A(s.token)).send({ dryRun: true, rows: [{ Name: 'X', 'Selling Price': '' }] });
    expect(check.body.warnings[0]).toMatch(/empty/);
  });
});

describe('Selling prices that come out 0', () => {
  it('are ignored, and a product stuck at ×0 is repaired on re-import', async () => {
    const s = await createActiveStoreWithAdmin();
    const url = `/api/stores/${s.store.id}/products/import`;
    await request().post(url).set(A(s.token)).send({ rows: [{ SKU: 'Z-1', Name: 'Mouse', 'Reference Cost': 100, 'Selling Price': 0 }] });
    const { pool } = require('../src/config/db');
    let p = (await pool.query("SELECT cost_price, price_multiplier FROM products WHERE sku = 'Z-1' AND store_id = $1", [s.store.id])).rows[0];
    expect(Number(p.cost_price)).toBe(100);
    expect(Number(p.price_multiplier)).toBeGreaterThan(0); // never priced at ₦0
    await pool.query("UPDATE products SET price_multiplier = 0 WHERE sku = 'Z-1' AND store_id = $1", [s.store.id]); // as left by the old import
    const check = await request().post(url).set(A(s.token)).send({ dryRun: true, rows: [{ SKU: 'Z-1', Name: 'Mouse', 'Reference Cost': 100, 'Selling Price': 0 }] });
    expect(check.body.warnings[0]).toMatch(/Selling Price cells came out empty or 0/);
    await request().post(url).set(A(s.token)).send({ rows: [{ SKU: 'Z-1', Name: 'Mouse', 'Reference Cost': 100, 'Selling Price': 0 }] });
    p = (await pool.query("SELECT price_multiplier FROM products WHERE sku = 'Z-1' AND store_id = $1", [s.store.id])).rows[0];
    expect(Number(p.price_multiplier)).toBe(1.3);
  });
});

describe('Who sees what a product costs', () => {
  it('cashiers get the selling price but no cost or markup', async () => {
    const { createProduct, createUser, tokenFor } = require('./helpers/factories');
    const s = await createActiveStoreWithAdmin();
    await createProduct(s.store.id, { sku: 'C-1', costPrice: 100, priceMultiplier: 1.25 });
    const cashier = await createUser(s.store.id, { role: 'cashier' });
    const asCashier = (await request().get(`/api/stores/${s.store.id}/products`).set(A(tokenFor(cashier)))).body[0];
    expect(asCashier.cost_price).toBeUndefined();
    expect(asCashier.price_multiplier).toBeUndefined();
    expect(asCashier.stock_value).toBeUndefined();
    expect(Number(asCashier.selling_price)).toBe(125);
    const scan = (await request().get(`/api/stores/${s.store.id}/barcode-lookup`).query({ code: 'C-1' }).set(A(tokenFor(cashier)))).body;
    expect(scan.cost_price).toBeUndefined();
    expect(Number(scan.selling_price)).toBe(125);
    const asAdmin = (await request().get(`/api/stores/${s.store.id}/products`).set(A(s.token))).body[0];
    expect(Number(asAdmin.cost_price)).toBe(100);
  });
});
