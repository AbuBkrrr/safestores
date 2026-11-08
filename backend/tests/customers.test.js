const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createUser, tokenFor, createProduct } = require('./helpers/factories');

describe('Customer Credit Tracking', () => {
  it('creates a customer and lists them with a zero starting balance', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const created = await request().post(`/api/stores/${store.id}/customers`).set('Authorization', `Bearer ${token}`)
      .send({ name: 'Mama Chidi', phone: '08012345678' });
    expect(created.status).toBe(201);
    expect(Number(created.body.balance)).toBe(0);

    const list = await request().get(`/api/stores/${store.id}/customers`).set('Authorization', `Bearer ${token}`);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].name).toBe('Mama Chidi');
  });

  it('rejects creating a customer with no name', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const res = await request().post(`/api/stores/${store.id}/customers`).set('Authorization', `Bearer ${token}`).send({ phone: '0800' });
    expect(res.status).toBe(400);
  });

  it('a credit sale at checkout increases the customer\'s balance, and payments decrease it', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id, { backroomQty: 0, shelfQty: 10, costPrice: 2, priceMultiplier: 2 }); // unit price 4
    const customer = await request().post(`/api/stores/${store.id}/customers`).set('Authorization', `Bearer ${token}`).send({ name: 'Regular Customer' });

    const order = await request().post(`/api/stores/${store.id}/orders`).set('Authorization', `Bearer ${token}`).send({});
    await request().post(`/api/stores/${store.id}/orders/${order.body.id}/items`).set('Authorization', `Bearer ${token}`)
      .send({ productId: product.id, quantity: 5 }); // total = 20

    const paid = await request().post(`/api/stores/${store.id}/orders/${order.body.id}/pay`).set('Authorization', `Bearer ${token}`)
      .send({ paymentMethod: 'credit', storeCustomerId: customer.body.id });
    expect(paid.status).toBe(200);

    const afterSale = await request().get(`/api/stores/${store.id}/customers/${customer.body.id}`).set('Authorization', `Bearer ${token}`);
    expect(Number(afterSale.body.balance)).toBe(20);
    expect(afterSale.body.ledger).toHaveLength(1);
    expect(afterSale.body.ledger[0].type).toBe('credit_sale');

    const payment = await request().post(`/api/stores/${store.id}/customers/${customer.body.id}/payments`).set('Authorization', `Bearer ${token}`)
      .send({ amount: 15, note: 'Part payment' });
    expect(payment.status).toBe(201);

    const afterPayment = await request().get(`/api/stores/${store.id}/customers/${customer.body.id}`).set('Authorization', `Bearer ${token}`);
    expect(Number(afterPayment.body.balance)).toBe(5);
  });

  it('rejects paying an order as credit with no customer selected', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const order = await request().post(`/api/stores/${store.id}/orders`).set('Authorization', `Bearer ${token}`).send({});
    const res = await request().post(`/api/stores/${store.id}/orders/${order.body.id}/pay`).set('Authorization', `Bearer ${token}`)
      .send({ paymentMethod: 'credit' });
    expect(res.status).toBe(400);
  });

  it('rejects a non-positive payment amount', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const customer = await request().post(`/api/stores/${store.id}/customers`).set('Authorization', `Bearer ${token}`).send({ name: 'X' });
    const res = await request().post(`/api/stores/${store.id}/customers/${customer.body.id}/payments`).set('Authorization', `Bearer ${token}`)
      .send({ amount: -5 });
    expect(res.status).toBe(400);
  });

  it('an adjustment requires a note, and can move balance either direction', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const customer = await request().post(`/api/stores/${store.id}/customers`).set('Authorization', `Bearer ${token}`).send({ name: 'X' });

    const noNote = await request().post(`/api/stores/${store.id}/customers/${customer.body.id}/adjustments`).set('Authorization', `Bearer ${token}`)
      .send({ amount: 10 });
    expect(noNote.status).toBe(400);

    const withNote = await request().post(`/api/stores/${store.id}/customers/${customer.body.id}/adjustments`).set('Authorization', `Bearer ${token}`)
      .send({ amount: -10, note: 'Wrote off a small balance' });
    expect(withNote.status).toBe(201);

    const check = await request().get(`/api/stores/${store.id}/customers/${customer.body.id}`).set('Authorization', `Bearer ${token}`);
    expect(Number(check.body.balance)).toBe(-10);
  });

  it('archiving a customer removes them from the default list but preserves their ledger', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const customer = await request().post(`/api/stores/${store.id}/customers`).set('Authorization', `Bearer ${token}`).send({ name: 'X' });
    await request().post(`/api/stores/${store.id}/customers/${customer.body.id}/adjustments`).set('Authorization', `Bearer ${token}`)
      .send({ amount: 5, note: 'Test' });

    const del = await request().delete(`/api/stores/${store.id}/customers/${customer.body.id}`).set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(204);

    const list = await request().get(`/api/stores/${store.id}/customers`).set('Authorization', `Bearer ${token}`);
    expect(list.body).toHaveLength(0);

    const withArchived = await request().get(`/api/stores/${store.id}/customers?includeArchived=true`).set('Authorization', `Bearer ${token}`);
    expect(withArchived.body).toHaveLength(1);

    const profile = await request().get(`/api/stores/${store.id}/customers/${customer.body.id}`).set('Authorization', `Bearer ${token}`);
    expect(profile.body.ledger).toHaveLength(1);
  });

  it('a cashier cannot archive a customer (admin only)', async () => {
    const { store } = await createActiveStoreWithAdmin();
    const cashier = await createUser(store.id, { role: 'cashier' });
    const admin2 = await createUser(store.id, { role: 'admin' });
    const customer = await request().post(`/api/stores/${store.id}/customers`).set('Authorization', `Bearer ${tokenFor(admin2)}`).send({ name: 'X' });

    const res = await request().delete(`/api/stores/${store.id}/customers/${customer.body.id}`).set('Authorization', `Bearer ${tokenFor(cashier)}`);
    expect(res.status).toBe(403);
  });

  it('searching filters by name or phone', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    await request().post(`/api/stores/${store.id}/customers`).set('Authorization', `Bearer ${token}`).send({ name: 'Aisha Bello', phone: '08011112222' });
    await request().post(`/api/stores/${store.id}/customers`).set('Authorization', `Bearer ${token}`).send({ name: 'Femi Johnson', phone: '08033334444' });

    const res = await request().get(`/api/stores/${store.id}/customers?search=Aisha`).set('Authorization', `Bearer ${token}`);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe('Aisha Bello');
  });

  it('tenant isolation: cannot see another store\'s customers', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const other = await createActiveStoreWithAdmin();
    await request().post(`/api/stores/${other.store.id}/customers`).set('Authorization', `Bearer ${other.token}`).send({ name: 'Theirs' });

    const res = await request().get(`/api/stores/${store.id}/customers`).set('Authorization', `Bearer ${token}`);
    expect(res.body).toHaveLength(0);
  });
});
