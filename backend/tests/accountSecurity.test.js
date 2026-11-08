// Account security: password reset, email verification, change password,
// session revocation, TOTP two-factor, data export, deletion, activity log.
const sent = [];
jest.mock('../src/utils/mailer', () => ({
  isConfigured: true,
  sendMail: jest.fn(async (msg) => { sent.push(msg); return true; }),
}));

const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createUser, createSuperAdmin, createProduct, tokenFor } = require('./helpers/factories');
const { pool } = require('../src/config/db');
const totp = require('../src/utils/totp');

const linkToken = (msg) => /token=([A-Za-z0-9_-]+)/.exec(msg.text)[1];

beforeEach(() => { sent.length = 0; });

describe('TOTP utility', () => {
  it('matches the RFC 6238 SHA-1 test vector', () => {
    const secret = totp.base32Encode(Buffer.from('12345678901234567890'));
    expect(totp.generateCode(secret, 59 * 1000)).toBe('287082');
    expect(totp.generateCode(secret, 1111111109 * 1000)).toBe('081804');
  });
  it('accepts the adjacent window and rejects junk', () => {
    const secret = totp.generateSecret();
    const now = Date.now();
    expect(totp.verifyCode(secret, totp.generateCode(secret, now - 30000), now)).toBe(true);
    expect(totp.verifyCode(secret, '12ab56', now)).toBe(false);
  });
});

describe('Password reset', () => {
  it('emails a one-time link that sets a new password and revokes old sessions', async () => {
    const { store, admin, token } = await createActiveStoreWithAdmin();
    const res = await request().post('/api/auth/password/forgot').send({ email: admin.email.toUpperCase() });
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    const raw = linkToken(sent[0]);

    const weak = await request().post('/api/auth/password/reset').send({ token: raw, password: 'short' });
    expect(weak.status).toBe(400);

    const ok = await request().post('/api/auth/password/reset').send({ token: raw, password: 'BrandNewPass9' });
    expect(ok.status).toBe(200);

    const reuse = await request().post('/api/auth/password/reset').send({ token: raw, password: 'AnotherPass9' });
    expect(reuse.status).toBe(400);

    const login = await request().post('/api/auth/admin/login').send({ email: admin.email, password: 'BrandNewPass9' });
    expect(login.status).toBe(200);

    const stale = await request().get(`/api/stores/${store.id}/products`).set('Authorization', `Bearer ${token}`);
    expect(stale.status).toBe(401);
    expect(stale.body.code).toBe('SESSION_REVOKED');
  });

  it('answers identically for unknown emails and sends nothing', async () => {
    const res = await request().post('/api/auth/password/forgot').send({ email: 'nobody@nowhere.test' });
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(0);
  });

  it('works for super admins too', async () => {
    const sa = await createSuperAdmin();
    await request().post('/api/auth/password/forgot').send({ email: sa.email });
    const raw = linkToken(sent[0]);
    expect((await request().post('/api/auth/password/reset').send({ token: raw, password: 'SuperSecret99' })).status).toBe(200);
    expect((await request().post('/api/auth/super-admin/login').send({ email: sa.email, password: 'SuperSecret99' })).status).toBe(200);
  });
});

describe('Email verification', () => {
  it('signup sends a verification email and the link confirms the address', async () => {
    const res = await request().post('/api/auth/store/signup').send({
      storeName: 'Verify Shop', adminName: 'Ada', adminEmail: `ada${Date.now()}@example.com`, password: 'GoodPassword1',
    });
    expect(res.status).toBe(201);
    await new Promise((r) => setTimeout(r, 50));
    const msg = sent.find((m) => /Confirm your email/.test(m.subject));
    expect(msg).toBeTruthy();
    const v = await request().post('/api/auth/email/verify').send({ token: linkToken(msg) });
    expect(v.status).toBe(200);
    const { rows } = await pool.query('SELECT email_verified_at FROM users WHERE id = $1', [res.body.admin.id]);
    expect(rows[0].email_verified_at).not.toBeNull();
  });

  it('rejects a weak signup password', async () => {
    const res = await request().post('/api/auth/store/signup').send({ storeName: 'X', adminName: 'Y', adminEmail: 'y@example.com', password: 'password' });
    expect(res.status).toBe(400);
  });
});

describe('Signed-in account management', () => {
  it('changes password (needs the current one) and returns a fresh token', async () => {
    const { store, admin, token } = await createActiveStoreWithAdmin();
    const bad = await request().post('/api/account/password').set('Authorization', `Bearer ${token}`).send({ currentPassword: 'nope', newPassword: 'NewPassword77' });
    expect(bad.status).toBe(400);
    const ok = await request().post('/api/account/password').set('Authorization', `Bearer ${token}`).send({ currentPassword: admin.plainPassword, newPassword: 'NewPassword77' });
    expect(ok.status).toBe(200);
    expect((await request().get(`/api/stores/${store.id}/products`).set('Authorization', `Bearer ${token}`)).status).toBe(401);
    expect((await request().get(`/api/stores/${store.id}/products`).set('Authorization', `Bearer ${ok.body.token}`)).status).toBe(200);
  });

  it('logout-all revokes existing tokens', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const res = await request().post('/api/account/logout-all').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect((await request().get(`/api/stores/${store.id}/products`).set('Authorization', `Bearer ${token}`)).status).toBe(401);
  });

  it('two-factor: setup → enable → login requires a code → disable', async () => {
    const { admin, token } = await createActiveStoreWithAdmin();
    const auth = { Authorization: `Bearer ${token}` };
    const setup = await request().post('/api/account/2fa/setup').set(auth);
    expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    expect((await request().post('/api/account/2fa/enable').set(auth).send({ code: '000000' })).status).toBe(400);
    expect((await request().post('/api/account/2fa/enable').set(auth).send({ code: totp.generateCode(setup.body.secret) })).status).toBe(200);

    const noCode = await request().post('/api/auth/admin/login').send({ email: admin.email, password: admin.plainPassword });
    expect(noCode.status).toBe(401);
    expect(noCode.body.code).toBe('TOTP_REQUIRED');
    const withCode = await request().post('/api/auth/admin/login').send({ email: admin.email, password: admin.plainPassword, otp: totp.generateCode(setup.body.secret) });
    expect(withCode.status).toBe(200);
    expect(withCode.body.user.twoFactorEnabled).toBe(true);

    const off = await request().post('/api/account/2fa/disable').set(auth).send({ password: admin.plainPassword, code: totp.generateCode(setup.body.secret) });
    expect(off.status).toBe(200);
    expect((await request().post('/api/auth/admin/login').send({ email: admin.email, password: admin.plainPassword })).status).toBe(200);
  });

  it('asks which store when one email + password matches two stores', async () => {
    const a = await createActiveStoreWithAdmin({}, { email: 'owner2@example.com' });
    const b = await createActiveStoreWithAdmin({}, { email: 'owner2@example.com' });
    const res = await request().post('/api/auth/admin/login').send({ email: 'owner2@example.com', password: a.admin.plainPassword });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CHOOSE_STORE');
    const pick = await request().post('/api/auth/admin/login').send({ email: 'owner2@example.com', password: a.admin.plainPassword, storeId: b.store.id });
    expect(pick.status).toBe(200);
    expect(pick.body.user.storeId).toBe(b.store.id);
  });

  it('exports personal data without secrets', async () => {
    const { token } = await createActiveStoreWithAdmin();
    const res = await request().get('/api/account/export').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.profile.email).toBeTruthy();
    expect(res.body.profile.password_hash).toBeUndefined();
    expect(res.body.profile.totp_secret).toBeUndefined();
  });

  it('a staff member can delete (anonymise) their own account; the last admin cannot', async () => {
    const { store, admin, token } = await createActiveStoreWithAdmin();
    expect((await request().delete('/api/account').set('Authorization', `Bearer ${token}`).send({ password: admin.plainPassword })).status).toBe(400);
    const staff = await createUser(store.id, { role: 'staff' });
    const res = await request().delete('/api/account').set('Authorization', `Bearer ${tokenFor(staff)}`).send({ password: staff.plainPassword });
    expect(res.status).toBe(200);
    const { rows } = await pool.query('SELECT name, status FROM users WHERE id = $1', [staff.id]);
    expect(rows[0]).toEqual({ name: 'Deleted user', status: 'disabled' });
  });
});

describe('Store closure with grace period', () => {
  it('schedules deletion, can be cancelled, and the sweep purges only due stores', async () => {
    const { store, admin, token } = await createActiveStoreWithAdmin();
    const auth = { Authorization: `Bearer ${token}` };
    expect((await request().post(`/api/stores/${store.id}/deletion`).set(auth).send({ password: admin.plainPassword, confirmName: 'wrong' })).status).toBe(400);
    const req1 = await request().post(`/api/stores/${store.id}/deletion`).set(auth).send({ password: admin.plainPassword, confirmName: store.name });
    expect(req1.status).toBe(200);
    expect((await request().delete(`/api/stores/${store.id}/deletion`).set(auth)).status).toBe(200);

    await request().post(`/api/stores/${store.id}/deletion`).set(auth).send({ password: admin.plainPassword, confirmName: store.name });
    const { purgeDueStoreDeletions } = require('../src/controllers/accountController');
    expect(await purgeDueStoreDeletions()).toBe(0);
    await pool.query(`UPDATE stores SET deletion_scheduled_for = now() - interval '1 minute' WHERE id = $1`, [store.id]);
    expect(await purgeDueStoreDeletions()).toBe(1);
    expect((await pool.query('SELECT 1 FROM stores WHERE id = $1', [store.id])).rowCount).toBe(0);
  });
});

describe('Activity log', () => {
  it('records price changes and is readable by admins only', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id);
    await request().put(`/api/stores/${store.id}/products/${product.id}`).set('Authorization', `Bearer ${token}`).send({ costPrice: 999 });
    await new Promise((r) => setTimeout(r, 50));
    const res = await request().get(`/api/stores/${store.id}/activity`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const entry = res.body.find((a) => a.action === 'product.price_changed');
    expect(entry).toBeTruthy();
    expect(entry.actor_name).toBeTruthy();

    const cashier = await createUser(store.id, { role: 'cashier' });
    expect((await request().get(`/api/stores/${store.id}/activity`).set('Authorization', `Bearer ${tokenFor(cashier)}`)).status).toBe(403);
  });
});

describe('Admin sets a staff password', () => {
  it('works for admins only and revokes the staff member\'s sessions', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const staff = await createUser(store.id, { role: 'staff' });
    const staffToken = tokenFor(staff);
    expect((await request().patch(`/api/stores/${store.id}/users/${staff.id}/password`).set('Authorization', `Bearer ${staffToken}`).send({ password: 'TempPass2024' })).status).toBe(403);
    const res = await request().patch(`/api/stores/${store.id}/users/${staff.id}/password`).set('Authorization', `Bearer ${token}`).send({ password: 'TempPass2024' });
    expect(res.status).toBe(200);
    expect((await request().get(`/api/stores/${store.id}/products`).set('Authorization', `Bearer ${staffToken}`)).status).toBe(401);
    expect((await request().post('/api/auth/admin/login').send({ email: staff.email, password: 'TempPass2024' })).status).toBe(200);
  });
});

describe('End-of-day summary email', () => {
  it('sends once per local day to verified admins, at 21:00 store time', async () => {
    const { store, admin } = await createActiveStoreWithAdmin();
    await pool.query('UPDATE users SET email_verified_at = now() WHERE id = $1', [admin.id]);
    // Pick a time zone where it is 21:xx right now.
    const tz = Intl.supportedValuesOf('timeZone').find((z) => new Intl.DateTimeFormat('en-US', { timeZone: z, hour: '2-digit', hourCycle: 'h23' }).format(new Date()) === '21');
    if (!tz) return; // no zone at 21h this instant (only happens with half-hour edge cases)
    await pool.query('UPDATE stores SET timezone = $1 WHERE id = $2', [tz, store.id]);
    const { runDailySummarySweep } = require('../src/jobs/dailySummaryJob');
    sent.length = 0;
    await runDailySummarySweep();
    const mine = sent.filter((m) => m.to === admin.email);
    expect(mine).toHaveLength(1);
    expect(mine[0].text).toContain('Sales:');
    await runDailySummarySweep();
    expect(sent.filter((m) => m.to === admin.email)).toHaveLength(1);
  });
});
