const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createProduct } = require('./helpers/factories');
const { pool } = require('../src/config/db');

const tokenOf = (link) => new URL(link).searchParams.get('token');

describe('Partner portal', () => {
  it('courier: invite → accept → assigned job → picked up → delivered (stock out, cash recorded)', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    await pool.query('UPDATE stores SET marketplace_enabled = true, city = $2 WHERE id = $1', [store.id, 'Kano']);
    const product = await createProduct(store.id, { shelfQty: 10 });
    const S = `Bearer ${token}`;

    const inv = await request().post(`/api/stores/${store.id}/partner-invites`).set('Authorization', S).send({ kind: 'courier', email: 'Rider@Fast.ng' });
    expect(inv.status).toBe(201);
    const raw = tokenOf(inv.body.link);
    expect((await request().get(`/api/partner/invite/${raw}`)).body).toMatchObject({ kind: 'courier', email: 'rider@fast.ng', hasAccount: false });
    const acc = await request().post('/api/partner/accept').send({ token: raw, name: 'Fast Riders', password: 'Password123!' });
    expect(acc.status).toBe(200);
    expect((await request().post('/api/partner/accept').send({ token: raw, password: 'Password123!' })).status).toBe(400); // single use
    const login = await request().post('/api/auth/partner/login').send({ email: 'rider@fast.ng', password: 'Password123!' });
    const R = `Bearer ${login.body.token}`;
    expect(login.body.user.role).toBe('courier');

    const couriers = await request().get(`/api/stores/${store.id}/couriers`).set('Authorization', S);
    const courierId = couriers.body[0].partner_id;

    const order = await request().post(`/api/marketplace/${store.id}/orders`).send({
      items: [{ productId: product.id, quantity: 2 }], fulfilmentMethod: 'delivery', deliveryAddress: '1 Road', guestName: 'Bola', paymentMethod: 'on_delivery',
    });
    expect(order.status).toBe(201);
    // Not confirmed yet → can't assign.
    expect((await request().patch(`/api/stores/${store.id}/marketplace/orders/${order.body.id}/courier`).set('Authorization', S).send({ courierId })).status).toBe(400);
    await request().patch(`/api/stores/${store.id}/marketplace/orders/${order.body.id}/confirm`).set('Authorization', S).send({ method: 'delivery' });
    expect((await request().patch(`/api/stores/${store.id}/marketplace/orders/${order.body.id}/courier`).set('Authorization', S).send({ courierId })).status).toBe(200);

    const jobs = await request().get('/api/partner/courier').set('Authorization', R);
    expect(jobs.body).toHaveLength(1);
    expect(jobs.body[0]).toMatchObject({ customer_name: 'Bola', delivery_address: '1 Road' });
    expect((await request().patch(`/api/partner/courier/jobs/${order.body.id}/delivered`).set('Authorization', R)).status).toBe(400);
    expect((await request().patch(`/api/partner/courier/jobs/${order.body.id}/picked-up`).set('Authorization', R)).status).toBe(200);
    expect((await request().patch(`/api/partner/courier/jobs/${order.body.id}/delivered`).set('Authorization', R)).status).toBe(200);
    const done = (await pool.query('SELECT status, payment_status FROM marketplace_orders WHERE id = $1', [order.body.id])).rows[0];
    expect(done).toEqual({ status: 'fulfilled', payment_status: 'paid' });
    expect((await pool.query('SELECT shelf_qty FROM products WHERE id = $1', [product.id])).rows[0].shelf_qty).toBe(8);

    // A store user's token can't use the courier portal, and vice versa.
    expect((await request().get('/api/partner/courier').set('Authorization', S)).status).toBe(403);
    expect((await request().get(`/api/stores/${store.id}/couriers`).set('Authorization', R)).status).toBe(403);
  });

  it('guarantor: invite linked to a guarantor → sees members → verifies → reports payment', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const S = `Bearer ${token}`;
    const g = await request().post(`/api/stores/${store.id}/credit/guarantors`).set('Authorization', S).send({ name: 'Unity Coop', kind: 'cooperative' });
    expect((await request().post(`/api/stores/${store.id}/partner-invites`).set('Authorization', S).send({ kind: 'guarantor', email: 'a@coop.ng' })).status).toBe(400);
    const inv = await request().post(`/api/stores/${store.id}/partner-invites`).set('Authorization', S).send({ kind: 'guarantor', email: 'a@coop.ng', guarantorId: g.body.id });
    const acc = await request().post('/api/partner/accept').send({ token: tokenOf(inv.body.link), name: 'Unity Coop desk', password: 'Password123!' });
    const G = `Bearer ${acc.body.token}`;

    const signup = await request().post(`/api/marketplace/${store.id}/signup`).send({ name: 'Ada', email: 'ada@c.com', password: 'Password123!' });
    const apply = await request().post(`/api/marketplace/${store.id}/credit/apply`).set('Authorization', `Bearer ${signup.body.token}`).send({ guarantorId: g.body.id, memberRef: 'M-1', requestedLimit: 1000 });

    const view = await request().get('/api/partner/guarantor').set('Authorization', G);
    expect(view.body.accounts[0]).toMatchObject({ customer_name: 'Ada', member_ref: 'M-1', status: 'pending' });
    expect((await request().patch(`/api/partner/guarantor/accounts/${apply.body.id}/verify`).set('Authorization', G).send({ verified: true })).body.member_verified).toBe(true);
    const accts = await request().get(`/api/stores/${store.id}/credit/accounts`).set('Authorization', S);
    expect(accts.body[0].member_verified).toBe(true);

    // Another guarantor can't touch this account.
    const other = await createActiveStoreWithAdmin();
    const g2 = await request().post(`/api/stores/${other.store.id}/credit/guarantors`).set('Authorization', `Bearer ${other.token}`).send({ name: 'Bank', kind: 'bank' });
    const inv2 = await request().post(`/api/stores/${other.store.id}/partner-invites`).set('Authorization', `Bearer ${other.token}`).send({ kind: 'guarantor', email: 'b@bank.ng', guarantorId: g2.body.id });
    const acc2 = await request().post('/api/partner/accept').send({ token: tokenOf(inv2.body.link), name: 'Bank', password: 'Password123!' });
    expect((await request().patch(`/api/partner/guarantor/accounts/${apply.body.id}/verify`).set('Authorization', `Bearer ${acc2.body.token}`).send({ verified: false })).status).toBe(404);
  });
});
