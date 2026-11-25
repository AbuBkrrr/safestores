const { request } = require('./helpers/app');
const { createStore, createUser, createSuperAdmin, tokenFor, superToken } = require('./helpers/factories');

describe('Activation key: request and delivery', () => {
  it('owner asks, Super Admin sends, key shows on the activation screen, store activates', async () => {
    const store = await createStore({ subscriptionStatus: 'pending' });
    const owner = await createUser(store.id, { role: 'admin' });
    const sa = { Authorization: `Bearer ${superToken(await createSuperAdmin())}` };
    const auth = { Authorization: `Bearer ${tokenFor(owner)}` };

    let r = await request().get(`/api/stores/${store.id}/activation`).set(auth);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ request: null, key: null });

    r = await request().post(`/api/stores/${store.id}/activation/request`).set(auth).send({ phone: '+2348011112222' });
    expect(r.status).toBe(201);
    r = await request().post(`/api/stores/${store.id}/activation/request`).set(auth).send({});
    expect(r.body.alreadySent).toBe(true); // no duplicate tickets

    const list = await request().get('/api/super/stores').set(sa);
    expect(list.body.find((s) => s.id === store.id).key_requested_at).toBeTruthy();

    const sent = await request().post(`/api/super/stores/${store.id}/access-code`).set(sa).send({ expiresInDays: 30 });
    expect(sent.status).toBe(201);

    r = await request().get(`/api/stores/${store.id}/activation`).set(auth);
    expect(r.body.key.code).toBe(sent.body.code);
    expect(r.body.request).toBeNull(); // answered

    r = await request().post(`/api/stores/${store.id}/redeem-code`).set(auth).send({ code: sent.body.code });
    expect(r.status).toBe(200);
  });

  it('staff cannot ask or see the key', async () => {
    const store = await createStore({ subscriptionStatus: 'pending' });
    const cashier = await createUser(store.id, { role: 'cashier' });
    const r = await request().get(`/api/stores/${store.id}/activation`).set('Authorization', `Bearer ${tokenFor(cashier)}`);
    expect(r.status).toBe(403);
  });
});
