const { request } = require('./helpers/app');
const { createStore, createUser, createSuperAdmin } = require('./helpers/factories');

describe('POST /api/auth/super-admin/login', () => {
  it('logs in a valid super admin and returns a token', async () => {
    const superAdmin = await createSuperAdmin();
    const res = await request()
      .post('/api/auth/super-admin/login')
      .send({ email: superAdmin.email, password: superAdmin.plainPassword });

    expect(res.status).toBe(200);
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.user.role).toBe('super_admin');
  });

  it('rejects a wrong password', async () => {
    const superAdmin = await createSuperAdmin();
    const res = await request()
      .post('/api/auth/super-admin/login')
      .send({ email: superAdmin.email, password: 'wrong-password' });

    expect(res.status).toBe(401);
  });

  it('rejects an unknown email', async () => {
    const res = await request()
      .post('/api/auth/super-admin/login')
      .send({ email: 'nobody@nowhere.com', password: 'whatever123' });

    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/admin/login', () => {
  it('logs in an active store admin', async () => {
    const store = await createStore({ subscriptionStatus: 'active' });
    const admin = await createUser(store.id, { role: 'admin' });

    const res = await request()
      .post('/api/auth/admin/login')
      .send({ email: admin.email, password: admin.plainPassword });

    expect(res.status).toBe(200);
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.user.storeId).toBe(store.id);
  });

  it('allows a pending store admin to log in (so they can activate)', async () => {
    const store = await createStore({ subscriptionStatus: 'pending' });
    const admin = await createUser(store.id, { role: 'admin' });

    const res = await request()
      .post('/api/auth/admin/login')
      .send({ email: admin.email, password: admin.plainPassword });

    expect(res.status).toBe(200);
  });

  it('rejects a disabled user', async () => {
    const store = await createStore({ subscriptionStatus: 'active' });
    const admin = await createUser(store.id, { role: 'admin', status: 'disabled' });

    const res = await request()
      .post('/api/auth/admin/login')
      .send({ email: admin.email, password: admin.plainPassword });

    expect(res.status).toBe(403);
  });

  it('rejects wrong credentials', async () => {
    const store = await createStore();
    const admin = await createUser(store.id, { role: 'admin' });

    const res = await request()
      .post('/api/auth/admin/login')
      .send({ email: admin.email, password: 'nope' });

    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/store/signup', () => {
  it('registers a new store (pending, default mini tier) + admin user', async () => {
    const res = await request()
      .post('/api/auth/store/signup')
      .send({
        storeName: 'Brand New Store',
        adminName: 'New Admin',
        adminEmail: 'newadmin@example.com',
        password: 'Password123!',
      });

    expect(res.status).toBe(201);
    expect(res.body.store.subscription_status).toBe('pending');
    expect(res.body.admin.email).toBe('newadmin@example.com');
  });

  it('rejects a missing required field', async () => {
    const res = await request()
      .post('/api/auth/store/signup')
      .send({ storeName: 'Missing Fields Store' });

    expect(res.status).toBe(400);
  });

  it('the freshly registered admin can log in immediately', async () => {
    await request()
      .post('/api/auth/store/signup')
      .send({
        storeName: 'Login After Signup',
        adminName: 'A Admin',
        adminEmail: 'loginafter@example.com',
        password: 'Password123!',
      });

    const res = await request()
      .post('/api/auth/admin/login')
      .send({ email: 'loginafter@example.com', password: 'Password123!' });

    expect(res.status).toBe(200);
    expect(res.body.user.subscriptionStatus).toBe('pending');
  });
});
