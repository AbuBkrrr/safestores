// Storefront online payments that settle straight to each store's own
// Paystack subaccount. Paystack itself is mocked (no live keys in CI).
const mockPaystack = {
  isConfigured: true,
  SUPPORTED_CURRENCIES: ['NGN'],
  COMMISSION_PCT: 0,
  listBanks: jest.fn(async () => [{ name: 'Test Bank', code: '058' }]),
  resolveAccount: jest.fn(async (acct) => {
    if (acct === '0000000000') throw new Error('Could not resolve');
    return { accountName: 'MAMA PUT STORES LTD', accountNumber: acct };
  }),
  upsertSubaccount: jest.fn(async ({ code }) => ({ code: code || 'ACCT_store123', bankName: 'Test Bank' })),
  initializeSplitTransaction: jest.fn(async ({ reference }) => ({ authorizationUrl: `https://checkout.paystack.test/${reference}`, reference })),
  verifySplitTransaction: jest.fn(),
  verifyWebhookSignature: jest.fn(() => true),
  verifyTransaction: jest.fn(),
  initializeTransaction: jest.fn(),
};
jest.mock('../src/utils/paystack', () => mockPaystack);

const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createUser, createProduct, tokenFor } = require('./helpers/factories');
const { pool } = require('../src/config/db');

const A = (token) => ({ Authorization: `Bearer ${token}` });

async function connectedStore() {
  const s = await createActiveStoreWithAdmin();
  await pool.query('UPDATE stores SET marketplace_enabled = true WHERE id = $1', [s.store.id]);
  const res = await request().put(`/api/stores/${s.store.id}/payouts`).set(A(s.token)).send({ bankCode: '058', bankName: 'Test Bank', accountNumber: '0123456789' });
  expect(res.status).toBe(200);
  const product = await createProduct(s.store.id, { costPrice: 1000, priceMultiplier: 1.5, shelfQty: 10 }); // 1500 each
  return { ...s, product };
}

async function placeOnline(storeId, productId) {
  const r = await request().post(`/api/marketplace/${storeId}/orders`).send({
    items: [{ productId, quantity: 2 }], guestName: 'Ada', guestEmail: 'ada@example.com', paymentMethod: 'online',
  });
  expect(r.status).toBe(201);
  return r.body;
}

beforeEach(() => { jest.clearAllMocks(); });

describe('Linking a store bank account', () => {
  it('admin links an account: subaccount created, only last 4 digits stored, online payments on', async () => {
    const { store } = await connectedStore();
    const { rows } = await pool.query('SELECT * FROM stores WHERE id = $1', [store.id]);
    expect(rows[0]).toMatchObject({ payout_subaccount_code: 'ACCT_store123', payout_account_last4: '6789', payout_account_name: 'MAMA PUT STORES LTD', online_payments_enabled: true });
    expect(JSON.stringify(rows[0])).not.toContain('0123456789');
    expect(mockPaystack.upsertSubaccount).toHaveBeenCalledWith(expect.objectContaining({ code: null, bankCode: '058', accountNumber: '0123456789' }));
  });

  it('rejects an account Paystack cannot resolve, and non-admins', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    expect((await request().put(`/api/stores/${store.id}/payouts`).set(A(token)).send({ bankCode: '058', accountNumber: '0000000000' })).status).toBe(400);
    const manager = await createUser(store.id, { role: 'manager' });
    expect((await request().put(`/api/stores/${store.id}/payouts`).set(A(tokenFor(manager))).send({ bankCode: '058', accountNumber: '0123456789' })).status).toBe(403);
  });

  it('cannot turn on online payments without a linked account, or turn off every payment option', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    expect((await request().patch(`/api/stores/${store.id}/payouts`).set(A(token)).send({ onlinePaymentsEnabled: true })).status).toBe(400);
    const c = await connectedStore();
    expect((await request().patch(`/api/stores/${c.store.id}/payouts`).set(A(c.token)).send({ onlinePaymentsEnabled: false, payOnDeliveryEnabled: false })).status).toBe(400);
  });
});

describe('Shopper pays online', () => {
  it('checkout names the store subaccount; verify marks the order paid', async () => {
    const { store, product } = await connectedStore();
    const info = await request().get(`/api/public/stores/${store.id}`);
    expect(info.body.payments).toEqual({ online: true, payOnDelivery: true });

    const order = await placeOnline(store.id, product.id);
    expect(order.payment_method).toBe('online');
    const pay = await request().post(`/api/marketplace/orders/${order.tracking_token}/pay`).send({});
    expect(pay.status).toBe(200);
    expect(pay.body.authorizationUrl).toMatch(/^https:\/\/checkout\.paystack\.test\//);
    expect(mockPaystack.initializeSplitTransaction).toHaveBeenCalledWith(expect.objectContaining({
      amount: 3000, currency: 'NGN', subaccount: 'ACCT_store123', email: 'ada@example.com',
    }));

    mockPaystack.verifySplitTransaction.mockResolvedValueOnce({ success: true, status: 'success', amount: 3000, currency: 'NGN', reference: pay.body.reference, paidAt: new Date().toISOString(), subaccountCode: 'ACCT_store123' });
    const v = await request().post(`/api/marketplace/orders/${order.tracking_token}/verify`).send({ reference: pay.body.reference });
    expect(v.body).toEqual({ paid: true });
    const track = await request().get(`/api/public/marketplace-orders/${order.tracking_token}`);
    expect(track.body).toMatchObject({ payment_status: 'paid', payment_method: 'online' });
  });

  it('refuses a payment whose amount or destination does not match', async () => {
    const { store, product } = await connectedStore();
    const order = await placeOnline(store.id, product.id);
    const pay = await request().post(`/api/marketplace/orders/${order.tracking_token}/pay`).send({});

    mockPaystack.verifySplitTransaction.mockResolvedValueOnce({ success: true, status: 'success', amount: 30, currency: 'NGN', subaccountCode: 'ACCT_store123' });
    expect((await request().post(`/api/marketplace/orders/${order.tracking_token}/verify`).send({})).body).toEqual({ paid: false, reason: 'amount_mismatch' });

    mockPaystack.verifySplitTransaction.mockResolvedValueOnce({ success: true, status: 'success', amount: 3000, currency: 'NGN', subaccountCode: 'ACCT_someone_else' });
    expect((await request().post(`/api/marketplace/orders/${order.tracking_token}/verify`).send({})).body).toEqual({ paid: false, reason: 'wrong_destination' });

    const { rows } = await pool.query('SELECT payment_status FROM marketplace_orders WHERE payment_reference = $1', [pay.body.reference]);
    expect(rows[0].payment_status).toBe('pending');
  });

  it('the Paystack webhook confirms a storefront payment too', async () => {
    const { store, product } = await connectedStore();
    const order = await placeOnline(store.id, product.id);
    const pay = await request().post(`/api/marketplace/orders/${order.tracking_token}/pay`).send({});
    mockPaystack.verifySplitTransaction.mockResolvedValueOnce({ success: true, status: 'success', amount: 3000, currency: 'NGN', subaccountCode: 'ACCT_store123' });
    const hook = await request().post('/api/webhooks/paystack').set('x-paystack-signature', 'sig').send({ event: 'charge.success', data: { reference: pay.body.reference } });
    expect(hook.status).toBe(200);
    const { rows } = await pool.query('SELECT payment_status, amount_paid FROM marketplace_orders WHERE id = $1', [order.id]);
    expect(rows[0]).toMatchObject({ payment_status: 'paid' });
    expect(Number(rows[0].amount_paid)).toBe(3000);
  });

  it('online checkout is refused for a store without a linked account; bad quantities are rejected', async () => {
    const { store } = await createActiveStoreWithAdmin();
    await pool.query('UPDATE stores SET marketplace_enabled = true WHERE id = $1', [store.id]);
    const product = await createProduct(store.id, { shelfQty: 5 });
    const online = await request().post(`/api/marketplace/${store.id}/orders`).send({ items: [{ productId: product.id, quantity: 1 }], guestName: 'X', paymentMethod: 'online' });
    expect(online.status).toBe(400);
    const neg = await request().post(`/api/marketplace/${store.id}/orders`).send({ items: [{ productId: product.id, quantity: -3 }], guestName: 'X' });
    expect(neg.status).toBe(400);
    const ok = await request().post(`/api/marketplace/${store.id}/orders`).send({ items: [{ productId: product.id, quantity: 1 }], guestName: 'X' });
    expect(ok.body).toMatchObject({ payment_method: 'on_delivery', payment_status: 'unpaid' });
  });
});
