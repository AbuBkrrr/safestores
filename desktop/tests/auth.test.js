const { request } = require('./helpers/app');
const { createStore, createUser, createSuperAdmin } = require('./helpers/factories');

describe('POST /api/auth/super-admin/login', () => {
  it('logs in a valid super admin', async () => {
    const superAdmin = createSuperAdmin();
    const res = await request().post('/api/auth/super-admin/login').send({ email: superAdmin.email, password: superAdmin.plainPassword });
    expect(res.status).toBe(200);
    expect(res.body.token).toEqual(expect.any(String));
  });

  it('rejects a wrong password', async () => {
    const superAdmin = createSuperAdmin();
    const res = await request().post('/api/auth/super-admin/login').send({ email: superAdmin.email, password: 'wrong' });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/admin/login', () => {
  it('logs in an active store admin', async () => {
    const store = createStore({ subscriptionStatus: 'active' });
    const admin = createUser(store.id, { role: 'admin' });
    const res = await request().post('/api/auth/admin/login').send({ email: admin.email, password: admin.plainPassword });
    expect(res.status).toBe(200);
    expect(res.body.user.storeId).toBe(store.id);
  });

  it('rejects a disabled user with 403', async () => {
    const store = createStore({ subscriptionStatus: 'active' });
    const admin = createUser(store.id, { role: 'admin', status: 'disabled' });
    const res = await request().post('/api/auth/admin/login').send({ email: admin.email, password: admin.plainPassword });
    expect(res.status).toBe(403);
  });
});

describe('DB isolation sanity check', () => {
  it('starts each test with a clean products table', async () => {
    const count = require('../server/db').prepare('SELECT COUNT(*) as c FROM products').get().c;
    expect(count).toBe(0);
  });
});
