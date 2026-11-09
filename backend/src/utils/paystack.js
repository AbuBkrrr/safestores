// ------------------------------------------------------------
// Paystack integration — the first real payment gateway wired in, per
// migration 026's placeholder (gateway_provider/gateway_enabled existed
// with nothing reading them yet). Flutterwave and Stripe remain
// selectable in Super Admin's payment settings but have no code behind
// them yet; this file only covers Paystack.
//
// Mirrors utils/mailer.js's shape on purpose: every function here is a
// safe no-op (or throws a clearly-labeled "not configured" error the
// caller turns into a 503) when PAYSTACK_SECRET_KEY isn't set, so a
// deployment that hasn't set up a gateway yet keeps working exactly as
// it did before this file existed — manual bank transfer + claim/confirm
// is always available regardless of gateway configuration.
// ------------------------------------------------------------

const crypto = require('crypto');

const SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';
const isConfigured = Boolean(SECRET_KEY);
const API_BASE = 'https://api.paystack.co';

async function paystackFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${SECRET_KEY}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.status === false) {
    throw new Error(body.message || `Paystack request failed (HTTP ${res.status})`);
  }
  return body.data;
}

/**
 * @param {{ email: string, amountNaira: number, reference: string, callbackUrl: string, metadata?: object }} opts
 * @returns {Promise<{ authorizationUrl: string, accessCode: string, reference: string }>}
 */
async function initializeTransaction({ email, amountNaira, reference, callbackUrl, metadata }) {
  if (!isConfigured) throw new Error('Paystack is not configured on this server yet.');
  // Paystack amounts are in the currency's smallest unit (kobo for NGN) —
  // this assumes a 2-decimal currency, true for NGN and most others this
  // app supports, but would need adjusting for a zero-decimal currency.
  const amountKobo = Math.round(amountNaira * 100);
  const data = await paystackFetch('/transaction/initialize', {
    method: 'POST',
    body: JSON.stringify({ email, amount: amountKobo, reference, callback_url: callbackUrl, metadata }),
  });
  return { authorizationUrl: data.authorization_url, accessCode: data.access_code, reference: data.reference };
}

/**
 * @param {string} reference
 * @returns {Promise<{ success: boolean, amountNaira: number, reference: string, paidAt: string | null }>}
 */
async function verifyTransaction(reference) {
  if (!isConfigured) throw new Error('Paystack is not configured on this server yet.');
  const data = await paystackFetch(`/transaction/verify/${encodeURIComponent(reference)}`);
  return {
    success: data.status === 'success',
    amountNaira: data.amount / 100,
    reference: data.reference,
    paidAt: data.paid_at || null,
  };
}

/**
 * Verifies the `x-paystack-signature` header per Paystack's webhook docs:
 * HMAC-SHA512 of the raw request body, keyed with the secret key. Needs
 * the exact raw bytes as sent — see app.js's express.json() `verify`
 * callback, which stashes them on req.rawBody specifically for this.
 * @param {Buffer} rawBody
 * @param {string} signatureHeader
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!isConfigured || !signatureHeader || !rawBody) return false;
  const hash = crypto.createHmac('sha512', SECRET_KEY).update(rawBody).digest('hex');
  // Constant-time comparison — signatureHeader is attacker-controlled input.
  const a = Buffer.from(hash, 'utf8');
  const b = Buffer.from(signatureHeader, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ------------------------------------------------------------
// Split payments for storefront orders (Paystack subaccounts).
// A store's bank account is registered once as a subaccount; checkout
// transactions name that subaccount, so Paystack settles the store's
// share straight to the store's bank. The platform account never holds
// shopper funds. See migrations/036_store_payouts.sql.
// ------------------------------------------------------------

// Currencies this platform's Paystack integration can collect. A Paystack
// account is tied to one country (e.g. a Nigerian account collects NGN and
// optionally USD); set PAYSTACK_CURRENCIES to match what yours supports.
const SUPPORTED_CURRENCIES = (process.env.PAYSTACK_CURRENCIES || 'NGN').split(',').map((c) => c.trim().toUpperCase()).filter(Boolean);
const COMMISSION_PCT = Math.min(Math.max(Number(process.env.MARKETPLACE_COMMISSION_PCT) || 0, 0), 50);

/** Banks Paystack can pay out to, for a currency. */
async function listBanks(currency = 'NGN') {
  if (!isConfigured) throw new Error('Paystack is not configured on this server yet.');
  const country = { NGN: 'nigeria', GHS: 'ghana', ZAR: 'south africa', KES: 'kenya' }[currency] || 'nigeria';
  const data = await paystackFetch(`/bank?country=${encodeURIComponent(country)}&currency=${encodeURIComponent(currency)}&perPage=200`);
  return (data || []).filter((b) => b.active !== false && !b.is_deleted).map((b) => ({ name: b.name, code: b.code }));
}

/** Confirms an account number belongs to a real account and returns its registered name. */
async function resolveAccount(accountNumber, bankCode) {
  if (!isConfigured) throw new Error('Paystack is not configured on this server yet.');
  const data = await paystackFetch(`/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`);
  return { accountName: data.account_name, accountNumber: data.account_number };
}

/** Creates (or, with `code`, updates) the store's subaccount. */
async function upsertSubaccount({ code, businessName, bankCode, accountNumber, email, phone }) {
  if (!isConfigured) throw new Error('Paystack is not configured on this server yet.');
  const body = {
    business_name: businessName,
    settlement_bank: bankCode,
    account_number: accountNumber,
    percentage_charge: COMMISSION_PCT, // the platform's share; 0 = the store keeps everything
    primary_contact_email: email || undefined,
    primary_contact_phone: phone || undefined,
  };
  const data = code
    ? await paystackFetch(`/subaccount/${encodeURIComponent(code)}`, { method: 'PUT', body: JSON.stringify(body) })
    : await paystackFetch('/subaccount', { method: 'POST', body: JSON.stringify(body) });
  return { code: data.subaccount_code || code, bankName: data.settlement_bank || null, accountName: data.account_name || null };
}

/**
 * Starts a checkout whose proceeds settle to `subaccount`. bearer:
 * 'subaccount' means Paystack's own fee comes out of the store's share
 * (the store is the seller), so the platform is never out of pocket.
 */
async function initializeSplitTransaction({ email, amount, currency, reference, callbackUrl, subaccount, metadata }) {
  if (!isConfigured) throw new Error('Paystack is not configured on this server yet.');
  const data = await paystackFetch('/transaction/initialize', {
    method: 'POST',
    body: JSON.stringify({
      email, amount: Math.round(Number(amount) * 100), currency, reference, callback_url: callbackUrl,
      subaccount, bearer: 'subaccount', metadata,
      channels: ['card', 'bank', 'ussd', 'bank_transfer', 'mobile_money', 'qr'],
    }),
  });
  return { authorizationUrl: data.authorization_url, reference: data.reference };
}

/** Full verification for a split payment: status, amount, currency and destination. */
async function verifySplitTransaction(reference) {
  if (!isConfigured) throw new Error('Paystack is not configured on this server yet.');
  const data = await paystackFetch(`/transaction/verify/${encodeURIComponent(reference)}`);
  return {
    success: data.status === 'success',
    status: data.status,
    amount: Number(data.amount) / 100,
    currency: data.currency,
    reference: data.reference,
    paidAt: data.paid_at || null,
    subaccountCode: data.subaccount?.subaccount_code || data.split?.subaccounts?.[0]?.subaccount_code || null,
    metadata: data.metadata || {},
  };
}

module.exports = {
  isConfigured, initializeTransaction, verifyTransaction, verifyWebhookSignature,
  listBanks, resolveAccount, upsertSubaccount, initializeSplitTransaction, verifySplitTransaction,
  SUPPORTED_CURRENCIES, COMMISSION_PCT,
};
