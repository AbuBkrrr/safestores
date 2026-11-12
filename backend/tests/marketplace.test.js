const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createProduct } = require('./helpers/factories');
const { pool } = require('../src/config/db');

async function enableMarketplace(storeId, city = 'Lagos', category = 'grocery') {
  await pool.query('UPDATE stores SET marketplace_enabled = true, city = $2, category = $3 WHERE id = $1', [storeId, city, category]);
}

describe('Marketplace: public browsing', () => {
  it('only lists marketplace-enabled, active stores in the directory', async () => {
    const { store } = await createActiveStoreWithAdmin();
    await enableMarketplace(store.id);
    const notEnabled = await createActiveStoreWithAdmin();
    await pool.query('UPDATE stores SET marketplace_enabled = false WHERE id = $1', [notEnabled.store.id]);

    const res = await request().get('/api/marketplace/stores');
    expect(res.status).toBe(200);
    const ids = res.body.map((s) => s.id);
    expect(ids).toContain(store.id);
    expect(ids).not.toContain(notEnabled.store.id);
  });

  it('browses a store\'s products with computed price and in_stock', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    await createProduct(store.id, { name: 'Rice 5kg', costPrice: 10, priceMultiplier: 1.5, backroomQty: 5 });

    const res = await request().get(`/api/marketplace/${store.id}/products`);
    expect(res.status).toBe(200);
    expect(res.body[0].price).toBe('15.00');
    expect(res.body[0].in_stock).toBe(true);
  });

  it('cross-store search-products only returns marketplace-enabled stores', async () => {
    const { store } = await createActiveStoreWithAdmin();
    await enableMarketplace(store.id);
    await createProduct(store.id, { name: 'Unique Widget' });
    const hidden = await createActiveStoreWithAdmin();
    await pool.query('UPDATE stores SET marketplace_enabled = false WHERE id = $1', [hidden.store.id]);
    await createProduct(hidden.store.id, { name: 'Unique Widget' });

    const res = await request().get('/api/marketplace/search-products?search=Unique');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].store_id).toBe(store.id);
  });
});

describe('Marketplace: customer accounts & checkout', () => {
  it('signs up a customer and lets them log in', async () => {
    const { store } = await createActiveStoreWithAdmin();
    const signup = await request().post(`/api/marketplace/${store.id}/signup`)
      .send({ name: 'Jane Shopper', email: 'jane@shop.com', password: 'Password123!' });
    expect(signup.status).toBe(201);
    expect(signup.body.token).toEqual(expect.any(String));

    const login = await request().post(`/api/marketplace/${store.id}/login`).send({ email: 'jane@shop.com', password: 'Password123!' });
    expect(login.status).toBe(200);
  });

  it('rejects duplicate customer signup within the same store', async () => {
    const { store } = await createActiveStoreWithAdmin();
    await request().post(`/api/marketplace/${store.id}/signup`).send({ name: 'A', email: 'dup@shop.com', password: 'Password123!' });
    const res = await request().post(`/api/marketplace/${store.id}/signup`).send({ name: 'B', email: 'dup@shop.com', password: 'Password123!' });
    expect(res.status).toBe(409);
  });

  it('a guest can place an order without an account', async () => {
    const { store } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id, { costPrice: 5, priceMultiplier: 2, backroomQty: 10 });

    const res = await request().post(`/api/marketplace/${store.id}/orders`).send({
      items: [{ productId: product.id, quantity: 2 }],
      guestName: 'Walk-in Guest',
      guestPhone: '0800000000',
    });

    expect(res.status).toBe(201);
    expect(Number(res.body.total)).toBe(20);
    expect(res.body.status).toBe('placed');
  });

  it('rejects a guest checkout with no guestName and no account', async () => {
    const { store } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id);

    const res = await request().post(`/api/marketplace/${store.id}/orders`).send({ items: [{ productId: product.id, quantity: 1 }] });
    expect(res.status).toBe(400);
  });

  it('a logged-in customer can place an order and see it in their history', async () => {
    const { store } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id, { backroomQty: 10 });
    const signup = await request().post(`/api/marketplace/${store.id}/signup`).send({ name: 'C', email: 'c@shop.com', password: 'Password123!' });

    await request().post(`/api/marketplace/${store.id}/orders`).set('Authorization', `Bearer ${signup.body.token}`)
      .send({ items: [{ productId: product.id, quantity: 1 }] });

    const res = await request().get(`/api/marketplace/${store.id}/my-orders`).set('Authorization', `Bearer ${signup.body.token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('a store-admin token cannot access customer-only my-orders', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const res = await request().get(`/api/marketplace/${store.id}/my-orders`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});

describe('Marketplace: admin order management', () => {
  it('lists and fulfills a marketplace order, deducting stock (shelf first, then backroom)', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id, { shelfQty: 3, backroomQty: 10 }); // 13 on hand
    const placed = await request().post(`/api/marketplace/${store.id}/orders`).send({
      items: [{ productId: product.id, quantity: 8 }], guestName: 'Guest',
    });

    const list = await request().get(`/api/stores/${store.id}/marketplace/orders`).set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].is_guest).toBe(true);

    const fulfill = await request()
      .patch(`/api/stores/${store.id}/marketplace/orders/${placed.body.id}/fulfill`)
      .set('Authorization', `Bearer ${token}`);
    expect(fulfill.status).toBe(200);

    const products = await request().get(`/api/stores/${store.id}/products`).set('Authorization', `Bearer ${token}`);
    const p = products.body.find((x) => x.id === product.id);
    expect(p.shelf_qty).toBe(0); // 3 taken from shelf
    expect(p.backroom_qty).toBe(5); // remaining 5 taken from backroom (10 - 5)
  });

  it('rejects fulfilling an order with insufficient combined stock', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id, { shelfQty: 1, backroomQty: 1 }); // 2 on hand
    const placed = await request().post(`/api/marketplace/${store.id}/orders`).send({
      items: [{ productId: product.id, quantity: 5 }], guestName: 'Guest',
    });

    const res = await request().patch(`/api/stores/${store.id}/marketplace/orders/${placed.body.id}/fulfill`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  it('cannot fulfill an order twice', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id, { shelfQty: 10 });
    const placed = await request().post(`/api/marketplace/${store.id}/orders`).send({
      items: [{ productId: product.id, quantity: 1 }], guestName: 'Guest',
    });
    await request().patch(`/api/stores/${store.id}/marketplace/orders/${placed.body.id}/fulfill`).set('Authorization', `Bearer ${token}`);

    const res = await request().patch(`/api/stores/${store.id}/marketplace/orders/${placed.body.id}/fulfill`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });
});
