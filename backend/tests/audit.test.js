const { request } = require('./helpers/app');
const {
  createActiveStoreWithAdmin, createSuperAdmin, superToken, createProduct, createAuditor, auditorToken,
} = require('./helpers/factories');
const { pool } = require('../src/config/db');

// NOTE: /api/auth/* is behind authLimiter (20 req/15min/IP — see
// middleware/rateLimit.js), which is correct production behavior but means
// a test suite that repeatedly drives real signup+login HTTP calls for
// SETUP quickly trips it. So only the tests that actually verify the
// signup/login/activation flow itself go through real HTTP; everywhere
// else uses createAuditor() (direct DB insert + directly-signed JWT, same
// pattern as createUser/tokenFor elsewhere in this suite) for setup.
async function createActiveAuditor(overrides = {}) {
  const auditor = await createAuditor({ status: 'active', ...overrides });
  return { ...auditor, token: auditorToken(auditor) };
}

describe('Auditor accounts', () => {
  it('signs up pending, cannot log in until a super admin activates', async () => {
    const email = 'pending@auditor.com';
    const signup = await request().post('/api/auth/auditor/signup').send({ name: 'Pending Pete', email, password: 'Password123!' });
    expect(signup.status).toBe(201);
    expect(signup.body.auditor.status).toBe('pending');

    const loginBeforeActivation = await request().post('/api/auth/auditor/login').send({ email, password: 'Password123!' });
    expect(loginBeforeActivation.status).toBe(403);

    const superAdmin = await createSuperAdmin();
    await request().patch(`/api/super/auditors/${signup.body.auditor.id}/activate`).set('Authorization', `Bearer ${superToken(superAdmin)}`);

    const loginAfter = await request().post('/api/auth/auditor/login').send({ email, password: 'Password123!' });
    expect(loginAfter.status).toBe(200);
    expect(loginAfter.body.user.role).toBe('auditor');
  });

  it('rejects duplicate auditor signup email', async () => {
    await request().post('/api/auth/auditor/signup').send({ name: 'A', email: 'dup@auditor.com', password: 'Password123!' });
    const res = await request().post('/api/auth/auditor/signup').send({ name: 'B', email: 'dup@auditor.com', password: 'Password123!' });
    expect(res.status).toBe(409);
  });

  it('a suspended auditor is blocked from logging in', async () => {
    const superAdmin = await createSuperAdmin();
    const email = 'susp@auditor.com';
    const signup = await request().post('/api/auth/auditor/signup').send({ name: 'S', email, password: 'Password123!' });
    await request().patch(`/api/super/auditors/${signup.body.auditor.id}/activate`).set('Authorization', `Bearer ${superToken(superAdmin)}`);
    await request().patch(`/api/super/auditors/${signup.body.auditor.id}/suspend`).set('Authorization', `Bearer ${superToken(superAdmin)}`);

    const res = await request().post('/api/auth/auditor/login').send({ email, password: 'Password123!' });
    expect(res.status).toBe(403);
  });
});

describe('Audit Engagements', () => {
  it('a store admin requests an engagement; it shows up as open for any auditor', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const auditor = await createActiveAuditor();

    const created = await request().post(`/api/stores/${store.id}/audit-engagements`).set('Authorization', `Bearer ${token}`)
      .send({ notes: 'Annual stock check' });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('requested');

    const open = await request().get('/api/auditor/engagements?status=requested').set('Authorization', `Bearer ${auditor.token}`);
    expect(open.status).toBe(200);
    expect(open.body.some((e) => e.id === created.body.id)).toBe(true);
  });

  it('an auditor accepts an engagement; a second acceptance attempt fails', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const auditor = await createActiveAuditor();
    const created = await request().post(`/api/stores/${store.id}/audit-engagements`).set('Authorization', `Bearer ${token}`).send({});

    const accept = await request().patch(`/api/auditor/engagements/${created.body.id}/accept`).set('Authorization', `Bearer ${auditor.token}`);
    expect(accept.status).toBe(200);
    expect(accept.body.status).toBe('accepted');

    const otherAuditor = await createActiveAuditor();
    const secondAccept = await request().patch(`/api/auditor/engagements/${created.body.id}/accept`).set('Authorization', `Bearer ${otherAuditor.token}`);
    expect(secondAccept.status).toBe(400);
  });

  it('the store sees the assigned auditor\'s name once accepted', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const auditor = await createActiveAuditor({ name: 'Assigned Ada' });
    const created = await request().post(`/api/stores/${store.id}/audit-engagements`).set('Authorization', `Bearer ${token}`).send({});
    await request().patch(`/api/auditor/engagements/${created.body.id}/accept`).set('Authorization', `Bearer ${auditor.token}`);

    const list = await request().get(`/api/stores/${store.id}/audit-engagements`).set('Authorization', `Bearer ${token}`);
    expect(list.body[0].auditor_name).toBe('Assigned Ada');
  });

  it('the auditor completes an engagement they own; cannot complete one they don\'t', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const auditor = await createActiveAuditor();
    const created = await request().post(`/api/stores/${store.id}/audit-engagements`).set('Authorization', `Bearer ${token}`).send({});
    await request().patch(`/api/auditor/engagements/${created.body.id}/accept`).set('Authorization', `Bearer ${auditor.token}`);

    const otherAuditor = await createActiveAuditor();
    const wrongComplete = await request().patch(`/api/auditor/engagements/${created.body.id}/complete`).set('Authorization', `Bearer ${otherAuditor.token}`);
    expect(wrongComplete.status).toBe(404);

    const res = await request().patch(`/api/auditor/engagements/${created.body.id}/complete`).set('Authorization', `Bearer ${auditor.token}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
  });

  it('an auditor invites a stock-taker for their active engagement', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const auditor = await createActiveAuditor();
    const created = await request().post(`/api/stores/${store.id}/audit-engagements`).set('Authorization', `Bearer ${token}`).send({});
    await request().patch(`/api/auditor/engagements/${created.body.id}/accept`).set('Authorization', `Bearer ${auditor.token}`);

    const res = await request().post(`/api/auditor/engagements/${created.body.id}/invites`).set('Authorization', `Bearer ${auditor.token}`)
      .send({ name: 'Temp Counter', email: 'counter@example.com' });
    expect(res.status).toBe(201);
    expect(res.body.role).toBe('stock_taker');

    const { rows } = await pool.query('SELECT * FROM invites WHERE code = $1', [res.body.code]);
    expect(rows[0].store_id).toBe(store.id);
  });

  it('cannot invite a stock-taker for an engagement that is not yet accepted', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const auditor = await createActiveAuditor();
    const created = await request().post(`/api/stores/${store.id}/audit-engagements`).set('Authorization', `Bearer ${token}`).send({});
    // never accepted

    const res = await request().post(`/api/auditor/engagements/${created.body.id}/invites`).set('Authorization', `Bearer ${auditor.token}`)
      .send({ name: 'X', email: 'y@z.com' });
    expect(res.status).toBe(404);
  });
});

describe('stock_taker shelf-audit access is time-boxed to an active engagement', () => {
  async function setup() {
    const { store, token } = await createActiveStoreWithAdmin();
    const auditor = await createActiveAuditor();
    const engagement = await request().post(`/api/stores/${store.id}/audit-engagements`).set('Authorization', `Bearer ${token}`).send({});
    await request().patch(`/api/auditor/engagements/${engagement.body.id}/accept`).set('Authorization', `Bearer ${auditor.token}`);
    const invite = await request().post(`/api/auditor/engagements/${engagement.body.id}/invites`).set('Authorization', `Bearer ${auditor.token}`)
      .send({ name: 'Temp Counter', email: `counter${Date.now()}@example.com` });
    const claimed = await request().post('/api/auth/invite/login').send({ code: invite.body.code });
    const product = await createProduct(store.id);
    return { store, token, engagement, claimed, product };
  }

  it('a claimed stock_taker can create a shelf audit while the engagement is active', async () => {
    const { store, claimed, product } = await setup();
    expect(claimed.body.user.role).toBe('stock_taker');
    const res = await request().post(`/api/stores/${store.id}/audits`).set('Authorization', `Bearer ${claimed.body.token}`)
      .send({ productId: product.id, countedQty: 1, area: 'shelf' });
    expect(res.status).toBe(201);
  });

  it('a stock_taker is blocked once no engagement is active', async () => {
    const { store, engagement, claimed, product } = await setup();
    await pool.query(`UPDATE audit_engagements SET status = 'completed' WHERE id = $1`, [engagement.body.id]);
    const res = await request().post(`/api/stores/${store.id}/audits`).set('Authorization', `Bearer ${claimed.body.token}`)
      .send({ productId: product.id, countedQty: 1, area: 'shelf' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NO_ACTIVE_ENGAGEMENT');
  });

  it("a store's own admin can always audit, with no engagement at all", async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id);
    const res = await request().post(`/api/stores/${store.id}/audits`).set('Authorization', `Bearer ${token}`)
      .send({ productId: product.id, countedQty: 1, area: 'shelf' });
    expect(res.status).toBe(201);
  });
});
