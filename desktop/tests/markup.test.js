const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createProduct } = require('./helpers/factories');
const db = require('../server/db');

const price = (id) => {
  const r = db.prepare('SELECT cost_price, price_multiplier FROM products WHERE id = ?').get(id);
  return Math.round(r.cost_price * r.price_multiplier * 100) / 100;
};

describe('Profit % on products (desktop)', () => {
  it('sets it for all products, one category, or ticked products', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const auth = { Authorization: `Bearer ${token}` };
    const make = (costPrice, category) => {
      const p = createProduct(store.id, { costPrice });
      db.prepare('UPDATE products SET category = ? WHERE id = ?').run(category, p.id);
      return p;
    };
    const tap = make(1000, 'Plumbing');
    const door = make(20000, 'Doors');
    let r = await request().post(`/api/stores/${store.id}/products/markup`).set(auth).send({ scope: 'all', percent: 20 });
    expect(r.body.updated).toBe(2);
    expect(price(tap.id)).toBe(1200);
    r = await request().post(`/api/stores/${store.id}/products/markup`).set(auth).send({ scope: 'category', category: 'Doors', percent: 35 });
    expect(price(door.id)).toBe(27000);
    r = await request().post(`/api/stores/${store.id}/products/markup`).set(auth).send({ scope: 'products', productIds: [tap.id], percent: 50 });
    expect(price(tap.id)).toBe(1500);
  });
});
