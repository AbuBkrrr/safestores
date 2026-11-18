const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createProduct } = require('./helpers/factories');

describe('POS Orders', () => {
  it('creates an order, then a duplicate create with the same id is a safe no-op', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const orderId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    const first = await request().post(`/api/stores/${store.id}/orders`).set('Authorization', `Bearer ${token}`).send({ id: orderId });
    expect(first.status).toBe(201);
    expect(first.body.status).toBe('pending_payment');

    const second = await request().post(`/api/stores/${store.id}/orders`).set('Authorization', `Bearer ${token}`).send({ id: orderId });
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(orderId);

    const list = await request().get(`/api/stores/${store.id}/orders`).set('Authorization', `Bearer ${token}`);
    expect(list.body).toHaveLength(1);
  });

  it('adding an item deducts shelf stock and updates the order total', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id, { backroomQty: 0, shelfQty: 10, costPrice: 2, priceMultiplier: 2 }); // unit price = 4
    const order = await request().post(`/api/stores/${store.id}/orders`).set('Authorization', `Bearer ${token}`).send({});

    const res = await request()
      .post(`/api/stores/${store.id}/orders/${order.body.id}/items`)
      .set('Authorization', `Bearer ${token}`)
      .send({ productId: product.id, quantity: 3 });

    expect(res.status).toBe(201);
    expect(Number(res.body.item.line_total)).toBe(12);
    expect(Number(res.body.order.total)).toBe(12);

    const list = await request().get(`/api/stores/${store.id}/products`).set('Authorization', `Bearer ${token}`);
    expect(list.body.find((p) => p.id === product.id).shelf_qty).toBe(7);
  });

  it('rejects adding more than what is on the shelf', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id, { backroomQty: 0, shelfQty: 2 });
    const order = await request().post(`/api/stores/${store.id}/orders`).set('Authorization', `Bearer ${token}`).send({});

    const res = await request()
      .post(`/api/stores/${store.id}/orders/${order.body.id}/items`)
      .set('Authorization', `Bearer ${token}`)
      .send({ productId: product.id, quantity: 5 });

    expect(res.status).toBe(400);
  });

  it('removing an item restores shelf stock and recalculates the total', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id, { backroomQty: 0, shelfQty: 10, costPrice: 1, priceMultiplier: 1 });
    const order = await request().post(`/api/stores/${store.id}/orders`).set('Authorization', `Bearer ${token}`).send({});
    const added = await request().post(`/api/stores/${store.id}/orders/${order.body.id}/items`).set('Authorization', `Bearer ${token}`)
      .send({ productId: product.id, quantity: 4 });

    const res = await request()
      .delete(`/api/stores/${store.id}/orders/${order.body.id}/items/${added.body.item.id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Number(res.body.total)).toBe(0);

    const list = await request().get(`/api/stores/${store.id}/products`).set('Authorization', `Bearer ${token}`);
    expect(list.body.find((p) => p.id === product.id).shelf_qty).toBe(10);
  });

  it('pays a pending order, generating a receipt number', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id, { backroomQty: 0, shelfQty: 10 });
    const order = await request().post(`/api/stores/${store.id}/orders`).set('Authorization', `Bearer ${token}`).send({});
    await request().post(`/api/stores/${store.id}/orders/${order.body.id}/items`).set('Authorization', `Bearer ${token}`)
      .send({ productId: product.id, quantity: 1 });

    const res = await request()
      .post(`/api/stores/${store.id}/orders/${order.body.id}/pay`)
      .set('Authorization', `Bearer ${token}`)
      .send({ paymentMethod: 'card' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('paid');
    expect(res.body.receipt_number).toMatch(/^RCPT-/);
  });

  it('cannot pay an order twice', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const order = await request().post(`/api/stores/${store.id}/orders`).set('Authorization', `Bearer ${token}`).send({});
    await request().post(`/api/stores/${store.id}/orders/${order.body.id}/pay`).set('Authorization', `Bearer ${token}`).send({});

    const res = await request().post(`/api/stores/${store.id}/orders/${order.body.id}/pay`).set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(400);
  });

  it('cancelling an order restores stock for all its items', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id, { backroomQty: 0, shelfQty: 10 });
    const order = await request().post(`/api/stores/${store.id}/orders`).set('Authorization', `Bearer ${token}`).send({});
    await request().post(`/api/stores/${store.id}/orders/${order.body.id}/items`).set('Authorization', `Bearer ${token}`)
      .send({ productId: product.id, quantity: 6 });

    const res = await request().post(`/api/stores/${store.id}/orders/${order.body.id}/cancel`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);

    const list = await request().get(`/api/stores/${store.id}/products`).set('Authorization', `Bearer ${token}`);
    expect(list.body.find((p) => p.id === product.id).shelf_qty).toBe(10);

    const orderCheck = await request().get(`/api/stores/${store.id}/orders/${order.body.id}`).set('Authorization', `Bearer ${token}`);
    expect(orderCheck.body.status).toBe('cancelled');
  });

  it('a paid order cannot be cancelled', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const order = await request().post(`/api/stores/${store.id}/orders`).set('Authorization', `Bearer ${token}`).send({});
    await request().post(`/api/stores/${store.id}/orders/${order.body.id}/pay`).set('Authorization', `Bearer ${token}`).send({});

    const res = await request().post(`/api/stores/${store.id}/orders/${order.body.id}/cancel`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });
});
