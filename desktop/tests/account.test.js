const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createUser, tokenFor, createProduct } = require('./helpers/factories');

describe('Account self-service (desktop)', () => {
  it('changes password, revoking the old token', async () => {
    const { store, admin, token } = await createActiveStoreWithAdmin();
    const bad = await request().post('/api/account/password').set('Authorization', `Bearer ${token}`).send({ currentPassword: 'wrong', newPassword: 'NewPassword77' });
    expect(bad.status).toBe(400);
    const ok = await request().post('/api/account/password').set('Authorization', `Bearer ${token}`).send({ currentPassword: admin.plainPassword, newPassword: 'NewPassword77' });
    expect(ok.status).toBe(200);
    expect((await request().get(`/api/stores/${store.id}/products`).set('Authorization', `Bearer ${token}`)).status).toBe(401);
    expect((await request().get(`/api/stores/${store.id}/products`).set('Authorization', `Bearer ${ok.body.token}`)).status).toBe(200);
  });

  it('admin sets a staff password; staff can then sign in with it', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const staff = await createUser(store.id, { role: 'staff' });
    const res = await request().patch(`/api/stores/${store.id}/users/${staff.id}/password`).set('Authorization', `Bearer ${token}`).send({ password: 'TempPass2024' });
    expect(res.status).toBe(200);
    const login = await request().post('/api/auth/admin/login').send({ email: staff.email, password: 'TempPass2024' });
    expect(login.status).toBe(200);
    const forbidden = await request().patch(`/api/stores/${store.id}/users/${staff.id}/password`).set("Authorization", `Bearer ${login.body.token}`).send({ password: "TempPass2024" });
    expect(forbidden.status).toBe(403);
  });

  it('logs the admin action and exports personal data without the hash', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const staff = await createUser(store.id, { role: 'staff' });
    await request().patch(`/api/stores/${store.id}/users/${staff.id}`).set('Authorization', `Bearer ${token}`).send({ status: 'disabled' });
    const log = await request().get(`/api/stores/${store.id}/activity`).set('Authorization', `Bearer ${token}`);
    expect(log.status).toBe(200);
    expect(log.body.some((a) => a.action === 'user.disabled' && a.actor_name)).toBe(true);
    const exp = await request().get('/api/account/export').set('Authorization', `Bearer ${token}`);
    expect(exp.status).toBe(200);
    expect(exp.body.profile.password_hash).toBeUndefined();
  });
});
