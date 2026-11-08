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

module.exports = { isConfigured, initializeTransaction, verifyTransaction, verifyWebhookSignature };
