const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createUser, createProduct, tokenFor } = require('./helpers/factories');
const { pool } = require('../src/config/db');

const price = async (id) => {
  const { rows } = await pool.query('SELECT cost_price, price_multiplier FROM products WHERE id = $1', [id]);
  return Math.round(Number(rows[0].cost_price) * Number(rows[0].price_multiplier) * 100) / 100;
};

describe('Profit % on products', () => {
  it('sets it for all products, one category, or ticked products', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const auth = { Authorization: `Bearer ${token}` };
    const make = async (costPrice, category) => {
      const p = await createProduct(store.id, { costPrice });
      await pool.query('UPDATE products SET category = $1 WHERE id = $2', [category, p.id]);
      return p;
    };
    const tap = await make(1000, 'Plumbing');
    const door = await make(20000, 'Doors');
    const paint = await make(5000, 'Paint');

    let r = await request().post(`/api/stores/${store.id}/products/markup`).set(auth).send({ scope: 'all', percent: 20 });
    expect(r.body.updated).toBe(3);
    expect(await price(tap.id)).toBe(1200);

    r = await request().post(`/api/stores/${store.id}/products/markup`).set(auth).send({ scope: 'category', category: 'Doors', percent: 35 });
    expect(r.body.updated).toBe(1);
    expect(await price(door.id)).toBe(27000);
    expect(await price(paint.id)).toBe(6000);

    r = await request().post(`/api/stores/${store.id}/products/markup`).set(auth).send({ scope: 'products', productIds: [paint.id], percent: 50 });
    expect(r.body.updated).toBe(1);
    expect(await price(paint.id)).toBe(7500);
  });

  it('rejects bad input and staff without pricing rights', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const auth = { Authorization: `Bearer ${token}` };
    expect((await request().post(`/api/stores/${store.id}/products/markup`).set(auth).send({ scope: 'all', percent: -5 })).status).toBe(400);
    expect((await request().post(`/api/stores/${store.id}/products/markup`).set(auth).send({ scope: 'category', percent: 10 })).status).toBe(400);
    const cashier = await createUser(store.id, { role: 'cashier' });
    const res = await request().post(`/api/stores/${store.id}/products/markup`).set('Authorization', `Bearer ${tokenFor(cashier)}`).send({ scope: 'all', percent: 10 });
    expect(res.status).toBe(403);
  });

  it('prices items from an invoice: whole-invoice %, a line of its own, existing items only when asked', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const existing = await createProduct(store.id, { name: 'Cement 50kg', costPrice: 9000 });
    const before = await price(existing.id);
    const { rows } = await pool.query(
      `INSERT INTO receipts (store_id, raw_ocr_text, parsed_items, status) VALUES ($1, 'x', $2, 'pending') RETURNING id`,
      [store.id, JSON.stringify([
        { name: 'Cement 50kg', quantity: 10, price: 9500 },
        { name: 'Wash basin', quantity: 2, price: 30000 },
        { name: 'Toilet seat', quantity: 3, price: 15000 },
      ])]
    );
    const res = await request().post(`/api/stores/${store.id}/receipts/${rows[0].id}/apply`).set('Authorization', `Bearer ${token}`)
      .send({ markupPercent: 25, items: [{ noExpiry: true }, { noExpiry: true }, { noExpiry: true, markupPercent: 40 }] });
    expect(res.status).toBe(200);
    const byName = async (n) => (await pool.query('SELECT id FROM products WHERE store_id = $1 AND name = $2', [store.id, n])).rows[0].id;
    expect(await price(await byName('Wash basin'))).toBe(37500); // invoice 25%
    expect(await price(await byName('Toilet seat'))).toBe(21000); // its own 40%
    expect(await price(existing.id)).toBe(before); // existing item untouched (not ticked)
  });
});
