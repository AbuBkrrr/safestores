const { request } = require('./helpers/app');
const {
  createStore, createUser, createSuperAdmin, superToken, tokenFor, createActiveStoreWithAdmin,
} = require('./helpers/factories');

describe('Super Admin: Store Management', () => {
  it('lists stores with user/product counts', async () => {
    const admin = await createSuperAdmin();
    await createStore();

    const res = await request().get('/api/super/stores').set('Authorization', `Bearer ${superToken(admin)}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    expect(res.body[0]).toHaveProperty('user_count');
  });

  it('a non-super-admin token is rejected from super routes', async () => {
    const { token } = await createActiveStoreWithAdmin();
    const res = await request().get('/api/super/stores').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('creates a store directly, active immediately, with an admin user', async () => {
    const superAdmin = await createSuperAdmin();
    const res = await request()
      .post('/api/super/stores')
      .set('Authorization', `Bearer ${superToken(superAdmin)}`)
      .send({ storeName: 'Direct Store', adminName: 'Direct Admin', adminEmail: 'direct@store.com', password: 'Password123!' });

    expect(res.status).toBe(201);
    expect(res.body.store.subscription_status).toBe('active');
    expect(res.body.store.store_tier).toBe('mini');
  });

  it('rejects an invalid storeTier', async () => {
    const superAdmin = await createSuperAdmin();
    const res = await request()
      .post('/api/super/stores')
      .set('Authorization', `Bearer ${superToken(superAdmin)}`)
      .send({ storeName: 'X', adminName: 'Y', adminEmail: 'z@x.com', password: 'Password123!', storeTier: 'giant' });

    expect(res.status).toBe(400);
  });

  it('updates store fields via PATCH (locked, store_tier — marketplaceEnabled is not a desktop field, see note)', async () => {
    const superAdmin = await createSuperAdmin();
    const store = await createStore();

    const res = await request()
      .patch(`/api/super/stores/${store.id}`)
      .set('Authorization', `Bearer ${superToken(superAdmin)}`)
      .send({ locked: true, storeTier: 'midi' });

    expect(res.status).toBe(200);
    expect(!!res.body.locked).toBe(true);
    expect(res.body.store_tier).toBe('midi');
  });

  it('activates a pending store, assigning tier and billing model', async () => {
    const superAdmin = await createSuperAdmin();
    const store = await createStore({ subscriptionStatus: 'pending' });

    const res = await request()
      .patch(`/api/super/stores/${store.id}/activate`)
      .set('Authorization', `Bearer ${superToken(superAdmin)}`)
      .send({ storeTier: 'midi', billingModel: 'daily_percentage', dailyRatePercent: 1.5 });

    expect(res.status).toBe(200);
    expect(res.body.subscription_status).toBe('active');
    expect(res.body.store_tier).toBe('midi');
    expect(!!res.body.locked).toBe(false);
  });

  it('suspends a store', async () => {
    const superAdmin = await createSuperAdmin();
    const store = await createStore({ subscriptionStatus: 'active' });

    const res = await request()
      .patch(`/api/super/stores/${store.id}/suspend`)
      .set('Authorization', `Bearer ${superToken(superAdmin)}`);

    expect(res.status).toBe(200);
    expect(res.body.subscription_status).toBe('suspended');
  });

  it('a suspended store\'s admin is blocked from store-scoped routes', async () => {
    const superAdmin = await createSuperAdmin();
    const { store, token } = await createActiveStoreWithAdmin();
    await request().patch(`/api/super/stores/${store.id}/suspend`).set('Authorization', `Bearer ${superToken(superAdmin)}`);

    const res = await request().get(`/api/stores/${store.id}/products`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('deletes a store', async () => {
    const superAdmin = await createSuperAdmin();
    const store = await createStore();

    const res = await request()
      .delete(`/api/super/stores/${store.id}`)
      .set('Authorization', `Bearer ${superToken(superAdmin)}`);
    expect(res.status).toBe(204);

    const list = await request().get('/api/super/stores').set('Authorization', `Bearer ${superToken(superAdmin)}`);
    expect(list.body.find((s) => s.id === store.id)).toBeUndefined();
  });

  it('lists the mini/midi/mega tiers', async () => {
    const superAdmin = await createSuperAdmin();
    const res = await request().get('/api/super/tiers').set('Authorization', `Bearer ${superToken(superAdmin)}`);
    expect(res.status).toBe(200);
    expect(res.body.map((t) => t.tier).sort()).toEqual(['mega', 'midi', 'mini']);
  });
});

describe('Super Admin: Access Codes', () => {
  it('generates a code and a pending store can redeem it to activate', async () => {
    const superAdmin = await createSuperAdmin();
    const store = await createStore({ subscriptionStatus: 'pending' });
    const admin = await createUser(store.id, { role: 'admin' });

    const gen = await request()
      .post('/api/super/access-codes')
      .set('Authorization', `Bearer ${superToken(superAdmin)}`)
      .send({ intendedTier: 'midi' });
    expect(gen.status).toBe(201);

    const redeem = await request()
      .post(`/api/stores/${store.id}/redeem-code`)
      .set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ code: gen.body.code });
    expect(redeem.status).toBe(200);

    const list = await request().get('/api/super/stores').set('Authorization', `Bearer ${superToken(superAdmin)}`);
    const updated = list.body.find((s) => s.id === store.id);
    expect(updated.subscription_status).toBe('active');
    expect(updated.store_tier).toBe('midi');
  });

  it('a used code cannot be redeemed twice', async () => {
    const superAdmin = await createSuperAdmin();
    const store1 = await createStore({ subscriptionStatus: 'pending' });
    const admin1 = await createUser(store1.id, { role: 'admin' });
    const store2 = await createStore({ subscriptionStatus: 'pending' });
    const admin2 = await createUser(store2.id, { role: 'admin' });

    const gen = await request().post('/api/super/access-codes').set('Authorization', `Bearer ${superToken(superAdmin)}`).send({});
    await request().post(`/api/stores/${store1.id}/redeem-code`).set('Authorization', `Bearer ${tokenFor(admin1)}`)
      .send({ code: gen.body.code });

    const res = await request()
      .post(`/api/stores/${store2.id}/redeem-code`)
      .set('Authorization', `Bearer ${tokenFor(admin2)}`)
      .send({ code: gen.body.code });

    expect(res.status).toBe(410);
  });

  it('a revoked code cannot be redeemed', async () => {
    const superAdmin = await createSuperAdmin();
    const store = await createStore({ subscriptionStatus: 'pending' });
    const admin = await createUser(store.id, { role: 'admin' });

    const gen = await request().post('/api/super/access-codes').set('Authorization', `Bearer ${superToken(superAdmin)}`).send({});
    await request().patch(`/api/super/access-codes/${gen.body.id}/revoke`).set('Authorization', `Bearer ${superToken(superAdmin)}`);

    const res = await request().post(`/api/stores/${store.id}/redeem-code`).set('Authorization', `Bearer ${tokenFor(admin)}`)
      .send({ code: gen.body.code });
    expect(res.status).toBe(410);
  });
});

describe('Super Admin: Cross-store user management', () => {
  it('lists all users across stores, filterable by storeId', async () => {
    const superAdmin = await createSuperAdmin();
    const { store, admin } = await createActiveStoreWithAdmin();
    await createActiveStoreWithAdmin(); // a second, unrelated store

    const res = await request()
      .get(`/api/super/users?storeId=${store.id}`)
      .set('Authorization', `Bearer ${superToken(superAdmin)}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(admin.id);
  });

  it('refuses to delete the last admin of a store', async () => {
    const superAdmin = await createSuperAdmin();
    const { admin } = await createActiveStoreWithAdmin();

    const res = await request()
      .delete(`/api/super/users/${admin.id}`)
      .set('Authorization', `Bearer ${superToken(superAdmin)}`);

    expect(res.status).toBe(400);
  });

  it('deletes a non-last-admin user fine', async () => {
    const superAdmin = await createSuperAdmin();
    const { store } = await createActiveStoreWithAdmin();
    const staff = await createUser(store.id, { role: 'staff' });

    const res = await request()
      .delete(`/api/super/users/${staff.id}`)
      .set('Authorization', `Bearer ${superToken(superAdmin)}`);

    expect(res.status).toBe(204);
  });
});
