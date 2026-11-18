const crypto = require('crypto');
const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createSuperAdmin, superToken } = require('./helpers/factories');
const db = require('../server/db');

function seedCharge(storeId, overrides = {}) {
  const { amountDue = 50, status = 'pending', chargeDate = new Date().toISOString().slice(0, 10) } = overrides;
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO billing_charges (id, store_id, charge_date, transaction_total, rate_percent, amount_due, status)
     VALUES (?,?,?,1000,1.0,?,?)`
  ).run(id, storeId, chargeDate, amountDue, status);
  return db.prepare('SELECT * FROM billing_charges WHERE id = ?').get(id);
}

describe('Billing: store-facing', () => {
  it('returns billing status with recent charges', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    seedCharge(store.id, { amountDue: 25 });

    const res = await request().get(`/api/stores/${store.id}/billing/status`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.charges).toHaveLength(1);
    expect(Number(res.body.charges[0].amount_due)).toBe(25);
  });

  it('claims payment for a pending charge, notifying super admin', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const charge = seedCharge(store.id);

    const res = await request()
      .post(`/api/stores/${store.id}/billing/claim-payment`)
      .set('Authorization', `Bearer ${token}`)
      .send({ chargeId: charge.id, method: 'bank_transfer', reference: 'TXN123' });

    expect(res.status).toBe(200);

    const row = db.prepare('SELECT * FROM billing_charges WHERE id = ?').get(charge.id);
    expect(row.claim_method).toBe('bank_transfer');
    expect(row.claim_reference).toBe('TXN123');

    const notifs = db.prepare(`SELECT * FROM notifications WHERE type = 'payment_claim' AND store_id = ?`).all(store.id);
    expect(notifs).toHaveLength(1);
  });

  it('rejects an invalid claim method', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const charge = seedCharge(store.id);

    const res = await request()
      .post(`/api/stores/${store.id}/billing/claim-payment`)
      .set('Authorization', `Bearer ${token}`)
      .send({ chargeId: charge.id, method: 'crypto' });

    expect(res.status).toBe(400);
  });

  it('cannot claim payment on an already-paid charge', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const charge = seedCharge(store.id, { status: 'paid' });

    const res = await request()
      .post(`/api/stores/${store.id}/billing/claim-payment`)
      .set('Authorization', `Bearer ${token}`)
      .send({ chargeId: charge.id, method: 'cash' });

    expect(res.status).toBe(404);
  });

  it('any logged-in user (even a pending store) can read the shared payment instructions', async () => {
    const { token } = await createActiveStoreWithAdmin({ subscriptionStatus: 'pending' });

    const res = await request().get('/api/settings/payment-instructions').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.bank_or_provider).toBe('OPAY');
  });
});

describe('Billing: super admin', () => {
  it('lists charges, filterable by status', async () => {
    const superAdmin = await createSuperAdmin();
    const { store } = await createActiveStoreWithAdmin();
    seedCharge(store.id, { status: 'pending' });
    seedCharge(store.id, { status: 'paid', chargeDate: '2024-01-01' });

    const res = await request()
      .get('/api/super/billing-charges?status=pending')
      .set('Authorization', `Bearer ${superToken(superAdmin)}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].status).toBe('pending');
  });

  it('marks a charge paid and unlocks the store', async () => {
    const superAdmin = await createSuperAdmin();
    const { store } = await createActiveStoreWithAdmin({ locked: true });
    const charge = seedCharge(store.id);

    const res = await request()
      .patch(`/api/super/billing-charges/${charge.id}/mark-paid`)
      .set('Authorization', `Bearer ${superToken(superAdmin)}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('paid');

    const row = db.prepare('SELECT locked FROM stores WHERE id = ?').get(store.id);
    expect(!!row.locked).toBe(false);
  });

  it('waives a charge and unlocks the store', async () => {
    const superAdmin = await createSuperAdmin();
    const { store } = await createActiveStoreWithAdmin({ locked: true });
    const charge = seedCharge(store.id);

    const res = await request()
      .patch(`/api/super/billing-charges/${charge.id}/waive`)
      .set('Authorization', `Bearer ${superToken(superAdmin)}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('waived');
  });

  it('updates a store\'s billing model/rate', async () => {
    const superAdmin = await createSuperAdmin();
    const { store } = await createActiveStoreWithAdmin();

    const res = await request()
      .patch(`/api/super/stores/${store.id}/billing`)
      .set('Authorization', `Bearer ${superToken(superAdmin)}`)
      .send({ billingModel: 'custom', customBillingNotes: 'Flat 5000/month' });

    expect(res.status).toBe(200);
    expect(res.body.billing_model).toBe('custom');
    expect(res.body.custom_billing_notes).toBe('Flat 5000/month');
  });

  it('the payment gateway placeholder defaults to none/disabled', async () => {
    const superAdmin = await createSuperAdmin();
    const res = await request().get('/api/settings/payment-instructions').set('Authorization', `Bearer ${superToken(superAdmin)}`);
    expect(res.body.gateway_provider).toBe('none');
    expect(res.body.gateway_enabled).toBe(false);
  });

  it('records an intended future gateway provider without enabling real processing', async () => {
    const superAdmin = await createSuperAdmin();
    const res = await request()
      .patch('/api/super/payment-settings')
      .set('Authorization', `Bearer ${superToken(superAdmin)}`)
      .send({ gatewayProvider: 'flutterwave', gatewayEnabled: false });

    expect(res.status).toBe(200);
    expect(res.body.gateway_provider).toBe('flutterwave');
    expect(res.body.gateway_enabled).toBe(false);
    expect(res.body.bank_or_provider).toBe('OPAY'); // manual-transfer fields untouched
  });

  it('rejects an unrecognized gateway provider', async () => {
    const superAdmin = await createSuperAdmin();
    const res = await request()
      .patch('/api/super/payment-settings')
      .set('Authorization', `Bearer ${superToken(superAdmin)}`)
      .send({ gatewayProvider: 'some-random-thing' });
    expect(res.status).toBe(400);
  });

  it('updates the shared payment instructions (bank details) used for direct transfer', async () => {
    const superAdmin = await createSuperAdmin();
    const res = await request()
      .patch('/api/super/payment-settings')
      .set('Authorization', `Bearer ${superToken(superAdmin)}`)
      .send({ accountNumber: '1234567890', accountName: 'New Biz Name', bankOrProvider: 'GTBank', methods: ['bank_transfer'] });

    expect(res.status).toBe(200);
    expect(res.body.account_number).toBe('1234567890');
    expect(res.body.methods).toEqual(['bank_transfer']);

    const readBack = await request().get('/api/settings/payment-instructions').set('Authorization', `Bearer ${superToken(superAdmin)}`);
    expect(readBack.body.account_name).toBe('New Biz Name');
  });

  it('a store admin cannot mark charges paid (super admin only)', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const charge = seedCharge(store.id);

    const res = await request()
      .patch(`/api/super/billing-charges/${charge.id}/mark-paid`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });
});
