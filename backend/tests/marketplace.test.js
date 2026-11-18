const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createProduct, createUser, tokenFor } = require('./helpers/factories');
const { pool } = require('../src/config/db');

// Review steps a marketplace order goes through before it can be fulfilled.
async function readyOrder(storeId, orderId, auth, method = 'pickup') {
  await request().patch(`/api/stores/${storeId}/marketplace/orders/${orderId}/confirm`).set('Authorization', auth).send({ method });
  await request().patch(`/api/stores/${storeId}/marketplace/orders/${orderId}/dispatch`).set('Authorization', auth).send({});
}

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

    await readyOrder(store.id, placed.body.id, `Bearer ${token}`);
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

    await readyOrder(store.id, placed.body.id, `Bearer ${token}`);
    const res = await request().patch(`/api/stores/${store.id}/marketplace/orders/${placed.body.id}/fulfill`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  it('cannot fulfill an order twice', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id, { shelfQty: 10 });
    const placed = await request().post(`/api/marketplace/${store.id}/orders`).send({
      items: [{ productId: product.id, quantity: 1 }], guestName: 'Guest',
    });
    await readyOrder(store.id, placed.body.id, `Bearer ${token}`);
    await request().patch(`/api/stores/${store.id}/marketplace/orders/${placed.body.id}/fulfill`).set('Authorization', `Bearer ${token}`);

    const res = await request().patch(`/api/stores/${store.id}/marketplace/orders/${placed.body.id}/fulfill`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });
});

describe('Custom shop address (shop_slug)', () => {
  it('a store sets a slug; the storefront and its API answer at /shop/<slug>; bad or taken slugs are refused', async () => {
    const a = await createActiveStoreWithAdmin();
    const b = await createActiveStoreWithAdmin();
    await pool.query('UPDATE stores SET marketplace_enabled = true WHERE id = ANY($1)', [[a.store.id, b.store.id]]);
    const patch = (s, body) => request().patch(`/api/stores/${s.store.id}/marketplace-profile`).set('Authorization', `Bearer ${s.token}`).send(body);

    const ok = await patch(a, { shopSlug: 'Mama Ngozi Lekki', shopTagline: 'Fresh food daily' });
    expect(ok.status).toBe(200);
    expect(ok.body.shop_slug).toBe('mama-ngozi-lekki');

    const info = await request().get('/api/public/stores/mama-ngozi-lekki');
    expect(info.status).toBe(200);
    expect(info.body.id).toBe(a.store.id);
    expect(info.body.shop_tagline).toBe('Fresh food daily');
    expect((await request().get('/api/marketplace/mama-ngozi-lekki/products')).status).toBe(200);
    expect((await request().get(`/api/public/stores/${a.store.id}`)).status).toBe(200); // old link still works

    expect((await patch(b, { shopSlug: 'mama-ngozi-lekki' })).status).toBe(409);
    expect((await patch(b, { shopSlug: 'ab' })).status).toBe(400);
    expect((await patch(b, { shopSlug: 'admin' })).status).toBe(400);
    expect((await request().get('/api/public/stores/no-such-shop')).status).toBe(404);

    const cleared = await patch(a, { shopSlug: '' });
    expect(cleared.body.shop_slug).toBeNull();
  });
});

describe('Custom domains', () => {
  it('a store connects its own domain; TLS ask + by-domain lookup recognise it; CORS allows it; bad/taken/platform domains refused', async () => {
    const a = await createActiveStoreWithAdmin();
    const b = await createActiveStoreWithAdmin();
    await pool.query('UPDATE stores SET marketplace_enabled = true WHERE id = ANY($1)', [[a.store.id, b.store.id]]);
    const patch = (s, body) => request().patch(`/api/stores/${s.store.id}/marketplace-profile`).set('Authorization', `Bearer ${s.token}`).send(body);

    const ok = await patch(a, { customDomain: 'https://Shop.MamaNgozi.com/' });
    expect(ok.status).toBe(200);
    expect(ok.body.custom_domain).toBe('shop.mamangozi.com');

    expect((await request().get('/api/public/domain-check').query({ domain: 'shop.mamangozi.com' })).status).toBe(200);
    expect((await request().get('/api/public/domain-check').query({ domain: 'evil.example.com' })).status).toBe(404);
    const by = await request().get('/api/public/by-domain/shop.mamangozi.com');
    expect(by.body.storeId).toBe(a.store.id);

    const cors = await request().get('/api/public/by-domain/shop.mamangozi.com').set('Origin', 'https://shop.mamangozi.com');
    expect(cors.headers['access-control-allow-origin']).toBe('https://shop.mamangozi.com');

    expect((await patch(b, { customDomain: 'shop.mamangozi.com' })).status).toBe(409);
    expect((await patch(b, { customDomain: 'not a domain' })).status).toBe(400);

    // Unlisted shops don't get certificates.
    await pool.query('UPDATE stores SET marketplace_enabled = false WHERE id = $1', [a.store.id]);
    await patch(a, { customDomain: 'shop.mamangozi.com' }); // clears the lookup cache
    expect((await request().get('/api/public/domain-check').query({ domain: 'shop.mamangozi.com' })).status).toBe(404);
  });
});

describe('Marketplace order review flow', () => {
  it('new → confirm delivery → out for delivery → fulfilled, visible on tracking; a marketplace manager can run it; fulfil early is refused', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    await enableMarketplace(store.id);
    const product = await createProduct(store.id, { shelfQty: 5 });
    const mm = await createUser(store.id, { role: 'marketplace_manager' });
    const auth = `Bearer ${tokenFor(mm)}`;
    const o = await request().post(`/api/marketplace/${store.id}/orders`).send({ items: [{ productId: product.id, quantity: 1 }], guestName: 'G', deliveryAddress: '1 Road' });
    const base = `/api/stores/${store.id}/marketplace/orders/${o.body.id}`;

    expect((await request().patch(`${base}/fulfill`).set('Authorization', auth)).status).toBe(400);
    expect((await request().patch(`${base}/dispatch`).set('Authorization', auth)).status).toBe(400);
    expect((await request().patch(`${base}/confirm`).set('Authorization', auth).send({ method: 'drone' })).status).toBe(400);

    const c = await request().patch(`${base}/confirm`).set('Authorization', auth).send({ method: 'delivery', note: 'Rider Musa' });
    expect(c.body.status).toBe('confirmed');
    const d = await request().patch(`${base}/dispatch`).set('Authorization', auth).send({});
    expect(d.body.status).toBe('out_for_delivery');

    const track = await request().get(`/api/public/marketplace-orders/${o.body.tracking_token}`);
    expect(track.body).toMatchObject({ status: 'out_for_delivery', fulfilment_method: 'delivery', status_note: 'Rider Musa' });

    expect((await request().patch(`${base}/fulfill`).set('Authorization', auth)).status).toBe(200);
    // Cashiers can't run the marketplace.
    const cashier = await createUser(store.id, { role: 'cashier' });
    expect((await request().get(`/api/stores/${store.id}/marketplace/orders`).set('Authorization', `Bearer ${tokenFor(cashier)}`)).status).toBe(403);
    void token;
  });

  it('pickup goes to ready_for_pickup', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    await enableMarketplace(store.id);
    const product = await createProduct(store.id, { shelfQty: 5 });
    const o = await request().post(`/api/marketplace/${store.id}/orders`).send({ items: [{ productId: product.id, quantity: 1 }], guestName: 'G' });
    const base = `/api/stores/${store.id}/marketplace/orders/${o.body.id}`;
    await request().patch(`${base}/confirm`).set('Authorization', `Bearer ${token}`).send({ method: 'pickup' });
    const d = await request().patch(`${base}/dispatch`).set('Authorization', `Bearer ${token}`).send({ note: 'Front desk' });
    expect(d.body.status).toBe('ready_for_pickup');
  });
});

describe('Checkout: delivery or pickup, pay now or on receipt', () => {
  it('pay on pickup records the choice; delivery needs an address; cash commission recorded at fulfilment', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    await enableMarketplace(store.id);
    const product = await createProduct(store.id, { shelfQty: 5 });
    const items = [{ productId: product.id, quantity: 1 }];
    const pick = await request().post(`/api/marketplace/${store.id}/orders`).send({ items, guestName: 'G', fulfilmentMethod: 'pickup', paymentMethod: 'cash', deliveryAddress: 'ignored' });
    expect(pick.status).toBe(201);
    expect(pick.body).toMatchObject({ payment_method: 'on_pickup', fulfilment_method: 'pickup', delivery_address: null });
    const noAddr = await request().post(`/api/marketplace/${store.id}/orders`).send({ items, guestName: 'G', fulfilmentMethod: 'delivery' });
    expect(noAddr.status).toBe(400);
    await readyOrder(store.id, pick.body.id, `Bearer ${token}`, 'pickup');
    expect((await request().patch(`/api/stores/${store.id}/marketplace/orders/${pick.body.id}/fulfill`).set('Authorization', `Bearer ${token}`)).status).toBe(200);
    const { rows } = await pool.query('SELECT payment_status FROM marketplace_orders WHERE id = $1', [pick.body.id]);
    expect(rows[0].payment_status).toBe('paid');
  });
});
