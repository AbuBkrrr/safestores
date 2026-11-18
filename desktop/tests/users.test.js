const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createUser, tokenFor } = require('./helpers/factories');

describe('Store Users', () => {
  it('lists users for the store', async () => {
    const { store, token, admin } = await createActiveStoreWithAdmin();
    const staff = await createUser(store.id, { role: 'staff' });

    const res = await request().get(`/api/stores/${store.id}/users`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body.map((u) => u.id)).toEqual(expect.arrayContaining([admin.id, staff.id]));
  });

  it('admin disables a user', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const staff = await createUser(store.id, { role: 'staff' });

    const res = await request()
      .patch(`/api/stores/${store.id}/users/${staff.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'disabled' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('disabled');
  });

  it('rejects an invalid status value', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const staff = await createUser(store.id, { role: 'staff' });

    const res = await request()
      .patch(`/api/stores/${store.id}/users/${staff.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'super_banned' });

    expect(res.status).toBe(400);
  });

  it('manager cannot remove a user (admin only)', async () => {
    const { store } = await createActiveStoreWithAdmin();
    const manager = await createUser(store.id, { role: 'manager' });
    const staff = await createUser(store.id, { role: 'staff' });

    const res = await request()
      .delete(`/api/stores/${store.id}/users/${staff.id}`)
      .set('Authorization', `Bearer ${tokenFor(manager)}`);

    expect(res.status).toBe(403);
  });

  it('admin removes a user', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const staff = await createUser(store.id, { role: 'staff' });

    const res = await request()
      .delete(`/api/stores/${store.id}/users/${staff.id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(204);
  });
});

describe('Invites', () => {
  it('manager creates an invite', async () => {
    const { store } = await createActiveStoreWithAdmin();
    const manager = await createUser(store.id, { role: 'manager' });

    const res = await request()
      .post(`/api/stores/${store.id}/invites`)
      .set('Authorization', `Bearer ${tokenFor(manager)}`)
      .send({ name: 'New Cashier', role: 'staff' });

    expect(res.status).toBe(201);
    expect(res.body.code).toEqual(expect.any(String));
    expect(res.body.status).toBe('pending');
  });

  it('staff cannot create an invite', async () => {
    const { store } = await createActiveStoreWithAdmin();
    const staff = await createUser(store.id, { role: 'staff' });

    const res = await request()
      .post(`/api/stores/${store.id}/invites`)
      .set('Authorization', `Bearer ${tokenFor(staff)}`)
      .send({ name: 'X', role: 'staff' });

    expect(res.status).toBe(403);
  });

  it('bulk-creates invites from a comma-separated name list, assigning unique emails on collision', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    await createUser(store.id, { role: 'staff', email: 'john@shop.com' });

    const res = await request()
      .post(`/api/stores/${store.id}/invites/bulk`)
      .set('Authorization', `Bearer ${token}`)
      .send({ names: 'John, Mary, Sam', emailDomain: 'shop.com', role: 'staff' });

    expect(res.status).toBe(201);
    expect(res.body).toHaveLength(3);
    const john = res.body.find((i) => i.name === 'John');
    expect(john.email).toBe('john2@shop.com'); // john@shop.com already taken by an existing user
  });

  it('a pending invite code can be claimed via /api/auth/invite/login, creating the user', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const created = await request()
      .post(`/api/stores/${store.id}/invites`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Claimable', role: 'staff' });

    const res = await request().post('/api/auth/invite/login').send({ code: created.body.code });
    expect(res.status).toBe(200);
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.user.role).toBe('staff');

    const users = await request().get(`/api/stores/${store.id}/users`).set('Authorization', `Bearer ${token}`);
    expect(users.body.some((u) => u.name === 'Claimable')).toBe(true);
  });

  it('a revoked invite cannot be claimed', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const created = await request()
      .post(`/api/stores/${store.id}/invites`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Revoked Guy', role: 'staff' });
    await request()
      .patch(`/api/stores/${store.id}/invites/${created.body.id}/revoke`)
      .set('Authorization', `Bearer ${token}`);

    const res = await request().post('/api/auth/invite/login').send({ code: created.body.code });
    expect(res.status).toBe(410);
  });

  it('an already-claimed invite cannot be revoked', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const created = await request()
      .post(`/api/stores/${store.id}/invites`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Will Claim', role: 'staff' });
    await request().post('/api/auth/invite/login').send({ code: created.body.code });

    const res = await request()
      .patch(`/api/stores/${store.id}/invites/${created.body.id}/revoke`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  it('an unknown invite code returns 404', async () => {
    const res = await request().post('/api/auth/invite/login').send({ code: 'NOPE-NOPE' });
    expect(res.status).toBe(404);
  });
});
