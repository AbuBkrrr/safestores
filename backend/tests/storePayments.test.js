// Storefront online payments that settle straight to each store's own
// Paystack subaccount. Paystack itself is mocked (no live keys in CI).
const mockPaystack = {
  isConfigured: true,
  SUPPORTED_CURRENCIES: ['NGN'],
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
    expect(info.body.payments).toEqual({ online: true, payOnDelivery: true, cashPausedForBalance: false });

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

describe('Bolt-style settlements', () => {
  const superHeaders = async () => {
    const { createSuperAdmin, superToken } = require('./helpers/factories');
    return A(superToken(await createSuperAdmin()));
  };

  it('cash order: store owes commission; next online order nets it; over the limit pauses pay-on-delivery', async () => {
    const S = await superHeaders();
    await request().patch('/api/super/settlement-settings').set(S).send({ marketplaceCommissionPct: 10, cashDebtLimit: 500, maxRecoveryPct: 50 });
    const { store, token, product } = await connectedStore(); // product sells at 1500

    // Two pay-on-delivery orders of 3000 each, fulfilled → 300 commission each = 600 owed.
    for (let i = 0; i < 2; i += 1) {
      const o = await request().post(`/api/marketplace/${store.id}/orders`).send({ items: [{ productId: product.id, quantity: 2 }], guestName: 'Cash' });
      expect(o.body.payment_method).toBe('on_delivery');
      expect((await request().patch(`/api/stores/${store.id}/marketplace/orders/${o.body.id}/fulfill`).set(A(token))).status).toBe(200);
    }
    let st = await request().get(`/api/stores/${store.id}/settlements`).set(A(token));
    expect(st.body).toMatchObject({ balance: 600, owes: 600, cashBlocked: true });
    expect(st.body.thisMonth).toMatchObject({ cashSales: 6000, commissions: 600 });

    // Over the limit: storefront stops offering pay-on-delivery.
    const info = await request().get(`/api/public/stores/${store.id}`);
    expect(info.body.payments).toMatchObject({ online: true, payOnDelivery: false, cashPausedForBalance: true });
    expect((await request().post(`/api/marketplace/${store.id}/orders`).send({ items: [{ productId: product.id, quantity: 1 }], guestName: 'X' })).status).toBe(400);

    // Online order of 3000: commission 300 + recovery min(600, 50% of 2700 = 1350) = 600 → platform takes 900, store gets 2100.
    const order = await placeOnline(store.id, product.id);
    const pay = await request().post(`/api/marketplace/orders/${order.tracking_token}/pay`).send({});
    expect(mockPaystack.initializeSplitTransaction).toHaveBeenLastCalledWith(expect.objectContaining({ amount: 3000, transactionCharge: 900, subaccount: 'ACCT_store123' }));
    mockPaystack.verifySplitTransaction.mockResolvedValueOnce({ success: true, status: 'success', amount: 3000, currency: 'NGN', subaccountCode: 'ACCT_store123' });
    await request().post(`/api/marketplace/orders/${order.tracking_token}/verify`).send({ reference: pay.body.reference });
    // Verifying twice must not double-count.
    mockPaystack.verifySplitTransaction.mockResolvedValueOnce({ success: true, status: 'success', amount: 3000, currency: 'NGN', subaccountCode: 'ACCT_store123' });
    await request().post(`/api/marketplace/orders/${order.tracking_token}/verify`).send({ reference: pay.body.reference });

    st = await request().get(`/api/stores/${store.id}/settlements`).set(A(token));
    expect(st.body).toMatchObject({ balance: 0, cashBlocked: false });
    expect(st.body.entries.map((e) => e.type).sort()).toEqual(['cash_commission', 'cash_commission', 'debt_recovered', 'online_commission']);
    expect((await request().get(`/api/public/stores/${store.id}`)).body.payments.payOnDelivery).toBe(true);
  });

  it('two online payments in flight never recover the same debt twice', async () => {
    const S = await superHeaders();
    await request().patch('/api/super/settlement-settings').set(S).send({ marketplaceCommissionPct: 0, maxRecoveryPct: 90 });
    const { store, product } = await connectedStore();
    await request().post(`/api/super/settlements/${store.id}/entries`).set(S).send({ type: 'adjustment', amount: 1000, note: 'Opening balance' });
    const a = await placeOnline(store.id, product.id);
    const b = await placeOnline(store.id, product.id);
    await request().post(`/api/marketplace/orders/${a.tracking_token}/pay`).send({});
    await request().post(`/api/marketplace/orders/${b.tracking_token}/pay`).send({});
    const charges = mockPaystack.initializeSplitTransaction.mock.calls.map((c) => c[0].transactionCharge);
    expect(charges).toEqual([1000, 0]);
  });

  it('store pays its balance online; super admin records transfers and per-store commission', async () => {
    const S = await superHeaders();
    const { store, token } = await connectedStore();
    await request().post(`/api/super/settlements/${store.id}/entries`).set(S).send({ type: 'adjustment', amount: 500, note: 'Commission owed' });

    mockPaystack.initializeTransaction.mockResolvedValueOnce({ authorizationUrl: 'https://checkout.paystack.test/x', reference: 'r' });
    const start = await request().post(`/api/stores/${store.id}/settlements/pay`).set(A(token)).send({});
    expect(start.status).toBe(200);
    expect(mockPaystack.initializeTransaction).toHaveBeenCalledWith(expect.objectContaining({ amountNaira: 500 }));
    mockPaystack.verifyTransaction.mockResolvedValue({ success: true, amountNaira: 500, reference: start.body.reference });
    expect((await request().post(`/api/stores/${store.id}/settlements/verify`).set(A(token)).send({ reference: start.body.reference })).body).toEqual({ paid: true });
    expect((await request().post(`/api/stores/${store.id}/settlements/verify`).set(A(token)).send({ reference: start.body.reference })).body).toEqual({ paid: true });
    expect((await request().get(`/api/stores/${store.id}/settlements`).set(A(token))).body.balance).toBe(0);

    await request().post(`/api/super/settlements/${store.id}/entries`).set(S).send({ type: 'adjustment', amount: 200, note: 'x' });
    const transfer = await request().post(`/api/super/settlements/${store.id}/entries`).set(S).send({ type: 'settlement_payment', amount: 200, reference: 'BANK-123' });
    expect(transfer.body.balance).toBe(0);
    expect((await request().post(`/api/super/settlements/${store.id}/entries`).set(S).send({ type: 'settlement_payment', amount: 200, reference: 'BANK-123' })).status).toBe(409);

    const c = await request().patch(`/api/super/stores/${store.id}/commission`).set(S).send({ commissionPct: 5 });
    expect(c.body).toMatchObject({ commissionPct: 5, customCommission: true });
    const list = await request().get('/api/super/settlements').set(S);
    expect(list.body.stores.find((x) => x.id === store.id).commission_pct).toBe(5);
    expect((await request().get('/api/super/settlements').set(A(token))).status).toBe(403);
  });
});
