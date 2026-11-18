const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createProduct } = require('./helpers/factories');
const { pool } = require('../src/config/db');

async function enableLoyalty(storeId, token, everyNthOrder = 3, discountPct = 20) {
  return request().patch(`/api/stores/${storeId}/loyalty-settings`).set('Authorization', `Bearer ${token}`)
    .send({ loyaltyEnabled: true, everyNthOrder, discountPct });
}

async function signupCustomer(storeId, email = `cust${Date.now()}@shop.com`) {
  const res = await request().post(`/api/marketplace/${storeId}/signup`).send({ name: 'Loyal Customer', email, password: 'Password123!' });
  return res.body.token;
}

describe('Loyalty Settings', () => {
  it('defaults to disabled, with sensible defaults once read', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const res = await request().get(`/api/stores/${store.id}/loyalty-settings`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.loyalty_enabled).toBe(false);
  });

  it('rejects an everyNthOrder below 2', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const res = await request().patch(`/api/stores/${store.id}/loyalty-settings`).set('Authorization', `Bearer ${token}`)
      .send({ everyNthOrder: 1 });
    expect(res.status).toBe(400);
  });

  it('rejects a discountPct outside (0, 100]', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const res = await request().patch(`/api/stores/${store.id}/loyalty-settings`).set('Authorization', `Bearer ${token}`)
      .send({ discountPct: 150 });
    expect(res.status).toBe(400);
  });

  it('updates cleanly with valid values', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const res = await enableLoyalty(store.id, token, 4, 15);
    expect(res.status).toBe(200);
    expect(res.body.loyalty_enabled).toBe(true);
    expect(res.body.loyalty_every_nth_order).toBe(4);
    expect(Number(res.body.loyalty_discount_pct)).toBe(15);
  });
});

describe('Loyalty Discount Application', () => {
  it('applies the discount on exactly the Nth order for a logged-in customer', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id, { costPrice: 10, priceMultiplier: 1, backroomQty: 100 }); // unit price 10
    await enableLoyalty(store.id, token, 3, 20); // every 3rd order, 20% off
    const custToken = await signupCustomer(store.id);

    let lastOrder;
    for (let i = 1; i <= 3; i++) {
      const res = await request().post(`/api/marketplace/${store.id}/orders`).set('Authorization', `Bearer ${custToken}`)
        .send({ items: [{ productId: product.id, quantity: 1 }] });
      lastOrder = res.body;
    }

    expect(Number(lastOrder.subtotal)).toBe(10);
    expect(Number(lastOrder.total)).toBe(8); // 20% off the 3rd order
    expect(Number(lastOrder.loyalty_discount_pct)).toBe(20);
  });

  it('does NOT discount orders 1 and 2, only the 3rd', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id, { costPrice: 10, priceMultiplier: 1, backroomQty: 100 });
    await enableLoyalty(store.id, token, 3, 20);
    const custToken = await signupCustomer(store.id);

    const first = await request().post(`/api/marketplace/${store.id}/orders`).set('Authorization', `Bearer ${custToken}`)
      .send({ items: [{ productId: product.id, quantity: 1 }] });
    expect(Number(first.body.total)).toBe(10);
    expect(first.body.loyalty_discount_pct).toBeNull();

    const second = await request().post(`/api/marketplace/${store.id}/orders`).set('Authorization', `Bearer ${custToken}`)
      .send({ items: [{ productId: product.id, quantity: 1 }] });
    expect(Number(second.body.total)).toBe(10);
  });

  it('does not apply any discount when loyalty is disabled', async () => {
    const { store } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id, { costPrice: 10, priceMultiplier: 1, backroomQty: 100 });
    const custToken = await signupCustomer(store.id);

    let lastOrder;
    for (let i = 1; i <= 3; i++) {
      const res = await request().post(`/api/marketplace/${store.id}/orders`).set('Authorization', `Bearer ${custToken}`)
        .send({ items: [{ productId: product.id, quantity: 1 }] });
      lastOrder = res.body;
    }
    expect(Number(lastOrder.total)).toBe(10);
  });

  it('a guest checkout (no account) never gets a loyalty discount, even on what would be their 3rd order', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id, { costPrice: 10, priceMultiplier: 1, backroomQty: 100 });
    await enableLoyalty(store.id, token, 1, 50); // every single order, to make this obvious if it were (wrongly) applied

    const res = await request().post(`/api/marketplace/${store.id}/orders`).send({
      items: [{ productId: product.id, quantity: 1 }], guestName: 'Guest Shopper',
    });
    expect(res.status).toBe(201);
    expect(Number(res.body.total)).toBe(10); // full price — never discounted for a guest
    expect(res.body.loyalty_discount_pct).toBeNull();
  });

  it('cancelled orders do not count toward the loyalty streak', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id, { costPrice: 10, priceMultiplier: 1, backroomQty: 100 });
    await enableLoyalty(store.id, token, 2, 20);
    const custToken = await signupCustomer(store.id);

    const first = await request().post(`/api/marketplace/${store.id}/orders`).set('Authorization', `Bearer ${custToken}`)
      .send({ items: [{ productId: product.id, quantity: 1 }] });
    await pool.query(`UPDATE marketplace_orders SET status = 'cancelled' WHERE id = $1`, [first.body.id]);

    const second = await request().post(`/api/marketplace/${store.id}/orders`).set('Authorization', `Bearer ${custToken}`)
      .send({ items: [{ productId: product.id, quantity: 1 }] });
    // With the first cancelled, this is effectively order #1 again for streak purposes, not #2 -> no discount.
    expect(Number(second.body.total)).toBe(10);
  });
});
