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

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4500000000049454e44ae426082', 'hex');
function applyAsAuditor(name, email, { docs = true } = {}) {
  let r = request().post('/api/auth/auditor/signup')
    .field('name', name).field('email', email).field('password', 'Password123!')
    .field('phone', '08030000000').field('idType', 'NIN').field('idNumber', '12345678901').field('professionalBody', 'ICAN');
  if (docs) r = r.attach('idDocument', PNG, { filename: 'id.png', contentType: 'image/png' }).attach('certificate', PNG, { filename: 'cert.png', contentType: 'image/png' });
  return r;
}

describe('Auditor accounts', () => {
  it('signs up pending, cannot log in until a super admin activates', async () => {
    const email = 'pending@auditor.com';
    const signup = await applyAsAuditor('Pending Pete', email);
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
    await applyAsAuditor('A', 'dup@auditor.com');
    const res = await applyAsAuditor('B', 'dup@auditor.com');
    expect(res.status).toBe(409);
  });

  it('a suspended auditor is blocked from logging in', async () => {
    const superAdmin = await createSuperAdmin();
    const email = 'susp@auditor.com';
    const signup = await applyAsAuditor('S', email);
    await request().patch(`/api/super/auditors/${signup.body.auditor.id}/activate`).set('Authorization', `Bearer ${superToken(superAdmin)}`);
    await request().patch(`/api/super/auditors/${signup.body.auditor.id}/suspend`).set('Authorization', `Bearer ${superToken(superAdmin)}`);

    const res = await request().post('/api/auth/auditor/login').send({ email, password: 'Password123!' });
    expect(res.status).toBe(403);
  });
});

const SOON = new Date(Date.now() + 86400000).toISOString();
// The Super Admin assigns a booking to an auditor before they can accept it.
async function assignTo(engagementId, auditor) {
  await pool.query('UPDATE audit_engagements SET auditor_id = $1, assigned_at = now() WHERE id = $2', [auditor.id, engagementId]);
}

describe('Audit Engagements', () => {
  it('store books a date/time; Super Admin assigns an auditor; only that auditor sees it and can accept or decline', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const auditor = await createActiveAuditor();
    const other = await createActiveAuditor();
    const S = `Bearer ${superToken(await createSuperAdmin())}`;

    expect((await request().post(`/api/stores/${store.id}/audit-engagements`).set('Authorization', `Bearer ${token}`).send({ notes: 'x' })).status).toBe(400);
    const created = await request().post(`/api/stores/${store.id}/audit-engagements`).set('Authorization', `Bearer ${token}`)
      .send({ notes: 'Annual stock check', scheduledFor: SOON });
    expect(created.status).toBe(201);
    expect(created.body.scheduled_for).toBeTruthy();
    expect((await request().get('/api/auditor/engagements').set('Authorization', `Bearer ${auditor.token}`)).body).toHaveLength(0);

    const all = await request().get('/api/super/audit-engagements').set('Authorization', S);
    expect(all.body.some((e) => e.id === created.body.id && e.store_name)).toBe(true);
    expect((await request().patch(`/api/super/audit-engagements/${created.body.id}/assign`).set('Authorization', S).send({ auditorId: auditor.id })).status).toBe(200);

    const mine = await request().get('/api/auditor/engagements').set('Authorization', `Bearer ${auditor.token}`);
    expect(mine.body.map((e) => e.id)).toEqual([created.body.id]);
    expect((await request().patch(`/api/auditor/engagements/${created.body.id}/accept`).set('Authorization', `Bearer ${other.token}`)).status).toBe(400);
    expect((await request().patch(`/api/auditor/engagements/${created.body.id}/decline`).set('Authorization', `Bearer ${auditor.token}`)).status).toBe(200);
    expect((await request().get('/api/auditor/engagements').set('Authorization', `Bearer ${auditor.token}`)).body).toHaveLength(0);

    await request().patch(`/api/super/audit-engagements/${created.body.id}/assign`).set('Authorization', S).send({ auditorId: other.id });
    const ok = await request().patch(`/api/auditor/engagements/${created.body.id}/accept`).set('Authorization', `Bearer ${other.token}`);
    expect(ok.body.status).toBe('accepted');
  });

  it('an auditor accepts an engagement; a second acceptance attempt fails', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const auditor = await createActiveAuditor();
    const created = await request().post(`/api/stores/${store.id}/audit-engagements`).set('Authorization', `Bearer ${token}`).send({ scheduledFor: SOON });

    await assignTo(created.body.id, auditor);

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
    const created = await request().post(`/api/stores/${store.id}/audit-engagements`).set('Authorization', `Bearer ${token}`).send({ scheduledFor: SOON });
    await assignTo(created.body.id, auditor);
    await request().patch(`/api/auditor/engagements/${created.body.id}/accept`).set('Authorization', `Bearer ${auditor.token}`);

    const list = await request().get(`/api/stores/${store.id}/audit-engagements`).set('Authorization', `Bearer ${token}`);
    expect(list.body[0].auditor_name).toBe('Assigned Ada');
  });

  it('the auditor completes an engagement they own; cannot complete one they don\'t', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const auditor = await createActiveAuditor();
    const created = await request().post(`/api/stores/${store.id}/audit-engagements`).set('Authorization', `Bearer ${token}`).send({ scheduledFor: SOON });
    await assignTo(created.body.id, auditor);
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
    const created = await request().post(`/api/stores/${store.id}/audit-engagements`).set('Authorization', `Bearer ${token}`).send({ scheduledFor: SOON });
    await assignTo(created.body.id, auditor);
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
    const created = await request().post(`/api/stores/${store.id}/audit-engagements`).set('Authorization', `Bearer ${token}`).send({ scheduledFor: SOON });
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
    const engagement = await request().post(`/api/stores/${store.id}/audit-engagements`).set('Authorization', `Bearer ${token}`).send({ scheduledFor: SOON });
    await assignTo(engagement.body.id, auditor);
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

  it("a store's own admin cannot record shelf audits: only the requested auditor's stock takers can", async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id);
    const res = await request().post(`/api/stores/${store.id}/audits`).set('Authorization', `Bearer ${token}`)
      .send({ productId: product.id, countedQty: 1, area: 'shelf' });
    expect(res.status).toBe(403);
  });
});

describe('Auditor KYC', () => {
  it('requires documents; Super Admin reviews details + documents privately, then rejects or activates', async () => {
    expect((await applyAsAuditor('NoDocs', 'nodocs@a.com', { docs: false })).status).toBe(400);
    const app = await applyAsAuditor('Jamal', 'jamal@a.com');
    expect(app.status).toBe(201);
    const id = app.body.auditor.id;
    const S = `Bearer ${superToken(await createSuperAdmin())}`;

    const detail = await request().get(`/api/super/auditors/${id}`).set('Authorization', S);
    expect(detail.body).toMatchObject({ id_type: 'NIN', id_number: '12345678901', professional_body: 'ICAN' });
    expect(detail.body.documents.map((d) => d.doc_type).sort()).toEqual(['certificate', 'id_document']);
    const doc = await request().get(`/api/super/auditors/${id}/documents/${detail.body.documents[0].id}`).set('Authorization', S);
    expect(doc.status).toBe(200);
    expect(doc.headers['content-type']).toMatch(/image\/png/);
    // Not public: no token, or an auditor's own token, is refused.
    expect((await request().get(`/api/super/auditors/${id}/documents/${detail.body.documents[0].id}`)).status).toBe(401);

    expect((await request().patch(`/api/super/auditors/${id}/reject`).set('Authorization', S).send({ note: 'Certificate unreadable' })).status).toBe(200);
    const login = await request().post('/api/auth/auditor/login').send({ email: 'jamal@a.com', password: 'Password123!' });
    expect(login.status).toBe(403);
    expect(login.body.error).toMatch(/Certificate unreadable/);
    expect((await request().patch(`/api/super/auditors/${id}/activate`).set('Authorization', S)).status).toBe(200);
    expect((await request().post('/api/auth/auditor/login').send({ email: 'jamal@a.com', password: 'Password123!' })).status).toBe(200);
  });
});
