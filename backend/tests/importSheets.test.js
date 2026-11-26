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
