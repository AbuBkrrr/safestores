// A store saves its own bank-transfer details even when online card payments
// are not switched on for the platform (no Paystack keys).
const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin } = require('./helpers/factories');

const A = (token) => ({ Authorization: `Bearer ${token}` });

describe('Bank transfer details', () => {
  it('save and switch on without online payments', async () => {
    const s = await createActiveStoreWithAdmin();
    const base = `/api/stores/${s.store.id}/payouts`;
    const before = await request().get(base).set(A(s.token));
    expect(before.status).toBe(200);
    const saved = await request().patch(base).set(A(s.token)).send({ transfer: { bankName: 'Opay', accountNumber: '8136138832', accountName: 'Bilyaminu Kabiru', note: '' } });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ transfer_bank_name: 'Opay', transfer_account_number: '8136138832', transfer_account_name: 'Bilyaminu Kabiru' });
    const on = await request().patch(base).set(A(s.token)).send({ transfer: {}, transferEnabled: true });
    expect(on.status).toBe(200);
    expect(on.body.transfer_enabled).toBe(true);
  });
});
