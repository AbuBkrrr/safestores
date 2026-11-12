// Tests the gateway payment paths that don't require a live Paystack API
// key — same convention this project already follows for mailer.js
// (never tested against a real SMTP send either): the "not configured"
// and validation behavior is real and worth covering; the actual
// third-party HTTP round-trip isn't, since there's no live key in CI.
const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createSuperAdmin, superToken } = require('./helpers/factories');
const { pool } = require('../src/config/db');
const paystack = require('../src/utils/paystack');

async function seedCharge(storeId, overrides = {}) {
  const { amountDue = 50, status = 'pending', chargeDate = new Date().toISOString().slice(0, 10) } = overrides;
  const { rows } = await pool.query(
    `INSERT INTO billing_charges (store_id, charge_date, transaction_total, rate_percent, amount_due, status)
     VALUES ($1,$2,1000,1.0,$3,$4) RETURNING *`,
    [storeId, chargeDate, amountDue, status]
  );
  return rows[0];
}

describe('Billing: Paystack gateway (not configured in test env)', () => {
  it('confirms the test environment has no Paystack key set, as expected', () => {
    // Sanity check the premise of every test below — if this ever fails,
    // it means a real key leaked into the test env and the 503
    // expectations further down would need rethinking.
    expect(paystack.isConfigured).toBe(false);
  });

  it('refuses to initialize online payment when the gateway is not enabled (default state)', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const charge = await seedCharge(store.id);

    const res = await request()
      .post(`/api/stores/${store.id}/billing/charges/${charge.id}/pay/initialize`)
      .set('Authorization', `Bearer ${token}`)
      .send({ callbackUrl: 'https://example.com/billing' });

    expect(res.status).toBe(503);
  });

  it('still refuses (no server-side key) even after Super Admin enables Paystack in settings', async () => {
    const superT = superToken(await createSuperAdmin());
    await request()
      .patch('/api/super/payment-settings')
      .set('Authorization', `Bearer ${superT}`)
      .send({ gatewayProvider: 'paystack', gatewayEnabled: true });

    const { store, token } = await createActiveStoreWithAdmin();
    const charge = await seedCharge(store.id);

    const res = await request()
      .post(`/api/stores/${store.id}/billing/charges/${charge.id}/pay/initialize`)
      .set('Authorization', `Bearer ${token}`)
      .send({ callbackUrl: 'https://example.com/billing' });

    expect(res.status).toBe(503);

    // Reset for other tests in this file/suite that assume the default.
    await request()
      .patch('/api/super/payment-settings')
      .set('Authorization', `Bearer ${superT}`)
      .send({ gatewayProvider: 'none', gatewayEnabled: false });
  });

  it('requires a callbackUrl', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const charge = await seedCharge(store.id);

    const res = await request()
      .post(`/api/stores/${store.id}/billing/charges/${charge.id}/pay/initialize`)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
  });

  it('a staff/cashier account cannot initialize an online payment (admin/manager only)', async () => {
    const { store } = await createActiveStoreWithAdmin();
    const charge = await seedCharge(store.id);
    const { createUser, tokenFor } = require('./helpers/factories');
    const cashier = await createUser(store.id, { role: 'cashier' });

    const res = await request()
      .post(`/api/stores/${store.id}/billing/charges/${charge.id}/pay/initialize`)
      .set('Authorization', `Bearer ${tokenFor(cashier)}`)
      .send({ callbackUrl: 'https://example.com/billing' });

    expect(res.status).toBe(403);
  });

  it('rejects a verify call with no matching gateway_reference for that charge', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const charge = await seedCharge(store.id);

    const res = await request()
      .post(`/api/stores/${store.id}/billing/charges/${charge.id}/pay/verify`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reference: 'ss_nonexistent_ref' });

    expect(res.status).toBe(404);
  });

  it('requires a reference to verify', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const charge = await seedCharge(store.id);

    const res = await request()
      .post(`/api/stores/${store.id}/billing/charges/${charge.id}/pay/verify`)
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
  });
});

describe('Billing: Paystack webhook', () => {
  it('rejects a webhook call with an invalid/missing signature', async () => {
    const res = await request()
      .post('/api/webhooks/paystack')
      .send({ event: 'charge.success', data: { reference: 'ss_fake' } });

    expect(res.status).toBe(401);
  });
});

describe('markChargePaid (shared helper used by manual, gateway-verify, and webhook paths)', () => {
  it('is idempotent — calling it twice on the same charge does not error and keeps it paid', async () => {
    const { markChargePaid } = require('../src/controllers/billingController');
    const { store } = await createActiveStoreWithAdmin();
    const charge = await seedCharge(store.id);

    const first = await markChargePaid(charge.id, { paidVia: 'gateway', gatewayReference: 'ss_test_ref' });
    expect(first.status).toBe('paid');
    expect(first.paid_via).toBe('gateway');

    const second = await markChargePaid(charge.id, { paidVia: 'gateway', gatewayReference: 'ss_test_ref' });
    expect(second.status).toBe('paid');
    expect(second.id).toBe(charge.id);

    const { rows } = await pool.query('SELECT locked FROM stores WHERE id = $1', [store.id]);
    expect(rows[0].locked).toBe(false);
  });

  it('returns null for a charge that does not exist', async () => {
    const { markChargePaid } = require('../src/controllers/billingController');
    const result = await markChargePaid('00000000-0000-0000-0000-000000000000', {});
    expect(result).toBeNull();
  });
});
