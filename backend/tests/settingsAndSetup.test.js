const { request } = require('./helpers/app');
const { createSuperAdmin, superToken } = require('./helpers/factories');

describe('Currency Settings', () => {
  it('returns the default currency publicly, no auth required', async () => {
    const res = await request().get('/api/settings/currency');
    expect(res.status).toBe(200);
    expect(res.body.code).toBe('NGN');
    expect(res.body.symbol).toBe('₦');
  });

  it('a super admin updates the currency', async () => {
    const superAdmin = await createSuperAdmin();
    const res = await request().patch('/api/super/currency').set('Authorization', `Bearer ${superToken(superAdmin)}`)
      .send({ code: 'GHS', symbol: '₵' });

    expect(res.status).toBe(200);
    expect(res.body.code).toBe('GHS');

    const readBack = await request().get('/api/settings/currency');
    expect(readBack.body.code).toBe('GHS');
  });

  it('rejects an unsupported currency code', async () => {
    const superAdmin = await createSuperAdmin();
    const res = await request().patch('/api/super/currency').set('Authorization', `Bearer ${superToken(superAdmin)}`)
      .send({ code: 'XXX', symbol: '?' });
    expect(res.status).toBe(400);
  });
});

describe('Setup: first Super Admin bootstrap', () => {
  it('reports needsSetup=true when no super admin exists yet', async () => {
    const res = await request().get('/api/setup/status');
    expect(res.status).toBe(200);
    expect(res.body.needsSetup).toBe(true);
  });

  it('creates the first super admin', async () => {
    const res = await request().post('/api/setup/super-admin').send({
      name: 'First Super', email: 'first@safestores.com', password: 'SuperSecure1!',
    });
    expect(res.status).toBe(201);

    const status = await request().get('/api/setup/status');
    expect(status.body.needsSetup).toBe(false);

    const login = await request().post('/api/auth/super-admin/login').send({ email: 'first@safestores.com', password: 'SuperSecure1!' });
    expect(login.status).toBe(200);
  });

  it('refuses to create a second super admin via setup once one exists', async () => {
    await request().post('/api/setup/super-admin').send({ name: 'A', email: 'a@safestores.com', password: 'Password1!' });
    const res = await request().post('/api/setup/super-admin').send({ name: 'B', email: 'b@safestores.com', password: 'Password1!' });
    expect(res.status).toBe(409);
  });

  it('rejects a short password', async () => {
    const res = await request().post('/api/setup/super-admin').send({ name: 'A', email: 'a@safestores.com', password: '123' });
    expect(res.status).toBe(400);
  });
});
