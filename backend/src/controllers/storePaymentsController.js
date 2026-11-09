// ------------------------------------------------------------
// Storefront online payments that settle DIRECTLY to each store.
//
//   Store admin:  link a bank account → we create a Paystack subaccount
//                 (only the subaccount code + last 4 digits are stored).
//   Shopper:      chooses "Pay online" → Paystack checkout naming that
//                 subaccount → Paystack settles to the store's bank.
//   Confirmation: by Paystack webhook and by the shopper's return redirect;
//                 both re-verify with Paystack's API and check amount,
//                 currency and that the money went to THIS store.
//
// The platform never receives or holds shopper funds.
// ------------------------------------------------------------
const crypto = require('crypto');
const db = require('../config/db');
const paystack = require('../utils/paystack');
const { logActivity } = require('../utils/activityLog');
const { emitToStore } = require('../realtime');

function frontendBase() {
  return (process.env.FRONTEND_URL || 'http://localhost:5173').split(',')[0].trim().replace(/\/$/, '');
}

async function storeCurrency(storeId) {
  const { rows } = await db.query(
    `SELECT COALESCE(s.currency_code, c.code) AS code FROM stores s LEFT JOIN currency_settings c ON c.id = 'default' WHERE s.id = $1`, [storeId]
  );
  return rows[0]?.code || 'NGN';
}

function gatewayUnavailable(res, currency) {
  if (!paystack.isConfigured) return res.status(503).json({ error: 'Online payments are not set up on this platform yet.', code: 'GATEWAY_NOT_CONFIGURED' });
  if (currency && !paystack.SUPPORTED_CURRENCIES.includes(currency)) {
    return res.status(400).json({ error: `Online payments aren't available for ${currency} yet. Supported: ${paystack.SUPPORTED_CURRENCIES.join(', ')}.`, code: 'CURRENCY_NOT_SUPPORTED' });
  }
  return null;
}

// ---------------- store admin ----------------

// GET /api/stores/:storeId/payouts
async function getPayouts(req, res) {
  const { rows } = await db.query(
    `SELECT payout_provider, payout_subaccount_code IS NOT NULL AS connected, payout_bank_name, payout_account_last4, payout_account_name,
            payout_connected_at, online_payments_enabled, pay_on_delivery_enabled FROM stores WHERE id = $1`,
    [req.params.storeId]
  );
  const currency = await storeCurrency(req.params.storeId);
  res.json({
    ...rows[0],
    currency,
    gatewayConfigured: paystack.isConfigured,
    currencySupported: paystack.SUPPORTED_CURRENCIES.includes(currency),
    commissionPct: paystack.COMMISSION_PCT,
  });
}

// GET /api/stores/:storeId/payouts/banks
async function listBanks(req, res) {
  const currency = await storeCurrency(req.params.storeId);
  if (gatewayUnavailable(res, currency)) return undefined;
  try { return res.json(await paystack.listBanks(currency)); } catch (err) { return res.status(502).json({ error: err.message }); }
}

// POST /api/stores/:storeId/payouts/resolve { bankCode, accountNumber }
async function resolveAccount(req, res) {
  const { bankCode, accountNumber } = req.body || {};
  if (!bankCode || !/^\d{6,20}$/.test(String(accountNumber || ''))) return res.status(400).json({ error: 'Choose a bank and enter a valid account number' });
  if (gatewayUnavailable(res)) return undefined;
  try {
    const r = await paystack.resolveAccount(String(accountNumber), String(bankCode));
    return res.json({ accountName: r.accountName });
  } catch (err) {
    return res.status(400).json({ error: 'We could not find that account. Check the bank and account number.' });
  }
}

// PUT /api/stores/:storeId/payouts { bankCode, bankName, accountNumber }
// Creates or updates the store's subaccount. The full account number is
// passed to Paystack and never stored here.
async function connectPayouts(req, res) {
  const { storeId } = req.params;
  const { bankCode, bankName, accountNumber } = req.body || {};
  if (!bankCode || !/^\d{6,20}$/.test(String(accountNumber || ''))) return res.status(400).json({ error: 'Choose a bank and enter a valid account number' });
  const currency = await storeCurrency(storeId);
  if (gatewayUnavailable(res, currency)) return undefined;

  const { rows: s } = await db.query('SELECT name, phone, payout_subaccount_code FROM stores WHERE id = $1', [storeId]);
  const { rows: u } = await db.query('SELECT email FROM users WHERE id = $1', [req.user.sub]);
  let resolved;
  try {
    resolved = await paystack.resolveAccount(String(accountNumber), String(bankCode));
  } catch {
    return res.status(400).json({ error: 'We could not find that account. Check the bank and account number.' });
  }
  let sub;
  try {
    sub = await paystack.upsertSubaccount({
      code: s[0]?.payout_subaccount_code || null, businessName: s[0]?.name || 'Store', bankCode: String(bankCode),
      accountNumber: String(accountNumber), email: u[0]?.email, phone: s[0]?.phone,
    });
  } catch (err) {
    return res.status(502).json({ error: `Paystack could not save the account: ${err.message}` });
  }
  await db.query(
    `UPDATE stores SET payout_provider = 'paystack', payout_subaccount_code = $1, payout_bank_code = $2, payout_bank_name = $3,
       payout_account_last4 = $4, payout_account_name = $5, payout_connected_at = now(), online_payments_enabled = true
     WHERE id = $6`,
    [sub.code, String(bankCode), bankName || sub.bankName || null, String(accountNumber).slice(-4), resolved.accountName, storeId]
  );
  logActivity(req, { storeId, action: 'store.payouts_connected', entityType: 'store', entityId: storeId, details: { bank: bankName, last4: String(accountNumber).slice(-4) } });
  return getPayouts(req, res);
}

// PATCH /api/stores/:storeId/payouts { onlinePaymentsEnabled?, payOnDeliveryEnabled? }
async function updatePaymentOptions(req, res) {
  const { storeId } = req.params;
  const { onlinePaymentsEnabled, payOnDeliveryEnabled } = req.body || {};
  const { rows } = await db.query('SELECT payout_subaccount_code, online_payments_enabled, pay_on_delivery_enabled FROM stores WHERE id = $1', [storeId]);
  const cur = rows[0];
  const online = onlinePaymentsEnabled === undefined ? cur.online_payments_enabled : !!onlinePaymentsEnabled;
  const pod = payOnDeliveryEnabled === undefined ? cur.pay_on_delivery_enabled : !!payOnDeliveryEnabled;
  if (online && !cur.payout_subaccount_code) return res.status(400).json({ error: 'Link a bank account before turning on online payments' });
  if (!online && !pod) return res.status(400).json({ error: 'Keep at least one way for customers to pay' });
  await db.query('UPDATE stores SET online_payments_enabled = $1, pay_on_delivery_enabled = $2 WHERE id = $3', [online, pod, storeId]);
  logActivity(req, { storeId, action: 'store.payment_options_changed', entityType: 'store', entityId: storeId, details: { online, payOnDelivery: pod } });
  return getPayouts(req, res);
}

// ---------------- shopper ----------------

/** What a storefront may offer: used by the public store info endpoint. */
async function paymentOptionsFor(storeId) {
  const { rows } = await db.query(
    'SELECT payout_subaccount_code, online_payments_enabled, pay_on_delivery_enabled FROM stores WHERE id = $1', [storeId]
  );
  const s = rows[0] || {};
  const currency = await storeCurrency(storeId);
  const online = !!(s.online_payments_enabled && s.payout_subaccount_code && paystack.isConfigured && paystack.SUPPORTED_CURRENCIES.includes(currency));
  return { online, payOnDelivery: s.pay_on_delivery_enabled !== false || !online };
}

// POST /api/marketplace/orders/:token/pay  { email? } → { authorizationUrl }
async function startOrderPayment(req, res) {
  const { rows } = await db.query(
    `SELECT mo.*, s.payout_subaccount_code, s.online_payments_enabled, s.name AS store_name
     FROM marketplace_orders mo JOIN stores s ON s.id = mo.store_id WHERE mo.tracking_token = $1`,
    [req.params.token]
  );
  const order = rows[0];
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.payment_status === 'paid') return res.status(400).json({ error: 'This order is already paid' });
  if (order.status === 'cancelled') return res.status(400).json({ error: 'This order was cancelled' });
  if (!order.online_payments_enabled || !order.payout_subaccount_code) return res.status(400).json({ error: 'This store does not take online payments' });
  const currency = await storeCurrency(order.store_id);
  if (gatewayUnavailable(res, currency)) return undefined;

  let email = req.body?.email || order.guest_email;
  if (!email && order.customer_id) {
    const { rows: c } = await db.query('SELECT email FROM customers WHERE id = $1', [order.customer_id]).catch(() => ({ rows: [] }));
    email = c[0]?.email;
  }
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'An email address is needed for the payment receipt', code: 'EMAIL_REQUIRED' });

  const reference = `SS-${order.id.slice(0, 8)}-${crypto.randomBytes(5).toString('hex')}`.toUpperCase();
  let init;
  try {
    init = await paystack.initializeSplitTransaction({
      email, amount: Number(order.total), currency, reference,
      callbackUrl: `${frontendBase()}/track/${order.tracking_token}`,
      subaccount: order.payout_subaccount_code,
      metadata: { kind: 'marketplace_order', order_id: order.id, store_id: order.store_id },
    });
  } catch (err) {
    return res.status(502).json({ error: `Could not start the payment: ${err.message}` });
  }
  await db.query(
    `UPDATE marketplace_orders SET payment_method = 'online', payment_status = 'pending', payment_reference = $1, currency = $2,
       guest_email = COALESCE(guest_email, $3) WHERE id = $4`,
    [reference, currency, order.customer_id ? null : email, order.id]
  );
  return res.json({ authorizationUrl: init.authorizationUrl, reference });
}

/** Verifies a reference with Paystack and, if it really paid THIS order to THIS store, marks it paid. Idempotent. */
async function confirmOrderPayment(reference) {
  const { rows } = await db.query(
    `SELECT mo.*, s.payout_subaccount_code FROM marketplace_orders mo JOIN stores s ON s.id = mo.store_id WHERE mo.payment_reference = $1`,
    [reference]
  );
  const order = rows[0];
  if (!order) return { ok: false, reason: 'unknown_reference' };
  if (order.payment_status === 'paid') return { ok: true, order };
  const v = await paystack.verifySplitTransaction(reference);
  if (!v.success) {
    if (['failed', 'abandoned', 'reversed'].includes(v.status)) {
      await db.query(`UPDATE marketplace_orders SET payment_status = 'failed' WHERE id = $1 AND payment_status <> 'paid'`, [order.id]);
    }
    return { ok: false, reason: v.status || 'not_successful' };
  }
  const expected = Math.round(Number(order.total) * 100);
  if (Math.round(v.amount * 100) !== expected || (order.currency && v.currency !== order.currency)) return { ok: false, reason: 'amount_mismatch' };
  if (v.subaccountCode && v.subaccountCode !== order.payout_subaccount_code) return { ok: false, reason: 'wrong_destination' };
  const { rows: upd } = await db.query(
    `UPDATE marketplace_orders SET payment_status = 'paid', paid_at = COALESCE($1::timestamptz, now()), amount_paid = $2, currency = $3
     WHERE id = $4 AND payment_status <> 'paid' RETURNING *`,
    [v.paidAt, v.amount, v.currency, order.id]
  );
  const paid = upd[0] || order;
  try { emitToStore(order.store_id, 'marketplace:order_paid', { id: order.id }); } catch { /* best-effort */ }
  return { ok: true, order: paid };
}

// POST /api/marketplace/orders/:token/verify { reference } — called by the tracking page after Paystack redirects back.
async function verifyOrderPayment(req, res) {
  const { rows } = await db.query('SELECT payment_reference FROM marketplace_orders WHERE tracking_token = $1', [req.params.token]);
  if (!rows[0]?.payment_reference) return res.status(404).json({ error: 'No payment started for this order' });
  const reference = req.body?.reference || rows[0].payment_reference;
  if (reference !== rows[0].payment_reference) return res.status(400).json({ error: 'Payment reference does not match this order' });
  try {
    const r = await confirmOrderPayment(reference);
    return res.json({ paid: r.ok, reason: r.ok ? undefined : r.reason });
  } catch (err) {
    return res.status(502).json({ error: 'Could not reach the payment provider. Please refresh in a moment.' });
  }
}

module.exports = {
  getPayouts, listBanks, resolveAccount, connectPayouts, updatePaymentOptions,
  paymentOptionsFor, startOrderPayment, confirmOrderPayment, verifyOrderPayment,
};
