# Wiring a Live Payment Gateway

Right now, payment collection is **manual confirmation**: a store admin clicks
"I've Paid" on the Billing screen, picks a method, and enters a reference. That
raises a `payment_claim` notification, and a Super Admin clicks "Mark Paid" to
unlock the store. This was a deliberate choice (see `billingJob.js` header) —
it works with zero external dependencies and zero transaction fees on your
side. This doc is for when you're ready to automate it.

**The calculation, notification, and lockout logic doesn't change.** All you're
doing is replacing the *source* of the "mark this charge paid" call: instead
of a human clicking a button, a payment gateway's webhook calls it for you.
Everything below plugs into the same `billingController.markPaid` /
`waiveCharge` code path that already exists.

## 1. Pick a gateway

You mentioned OPAY as your existing collection account, so OPAY's Checkout/
Collection API is the most direct fit — a customer (in this case, a store
admin paying their daily charge) pays into your existing OPAY merchant
account and OPAY notifies your server. Paystack and Flutterwave both work in
Nigeria too and have very similar integration shapes (hosted checkout +
webhook + a "verify transaction" endpoint) if OPAY's merchant API access
turns out to be harder to get than the personal collection account you're
using today. Whichever you pick, confirm the exact field names against that
provider's **current** API docs before wiring the webhook signature check
below — these APIs change their payload shapes periodically, and getting the
signature verification wrong is worse than not verifying at all (see
Security, below).

You will need, from whichever provider you choose:
- A **merchant/business API account** (this is a different, harder-to-get
  thing than the personal OPAY account number already in Payment Settings —
  most personal collection accounts don't expose webhooks or an API at all).
- A **public/secret API key pair**.
- A **webhook signing secret**, separate from the API key, used to verify
  that a webhook request genuinely came from the provider and not an
  attacker who found your webhook URL.

## 2. Environment variables

Add to `desktop/.env` (or wherever the desktop app reads its config) and
`backend/.env`:

```
PAYMENT_GATEWAY_PROVIDER=opay       # or paystack, flutterwave
PAYMENT_GATEWAY_SECRET_KEY=sk_live_xxxxxxxxxxxxxxxx
PAYMENT_GATEWAY_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxxxxx
PAYMENT_GATEWAY_PUBLIC_KEY=pk_live_xxxxxxxxxxxxxxxx
```

Never commit real values — `.env` is already gitignored in this project.
For the desktop edition specifically, these need to be reachable from the
Electron main process (they're read server-side, in `desktop/server/`, not
in the frontend bundle) — do **not** put secret keys in any file under
`frontend/src`, since that code ships to the browser/user's machine.

## 3. Give each billing charge a payment reference

Before a store admin can pay via the gateway instead of claiming a manual
payment, they need something to pay *against* — a hosted checkout link or a
dynamic virtual account tied to that specific charge. Add a
`gateway_reference` column to `billing_charges` (a new migration, following
the pattern of `007_billing_automation.sql` / the desktop schema guard in
`db.js`), and a new controller function that initializes a transaction with
the gateway and returns a checkout URL:

```js
// desktop/server/controllers/billingController.js — new function
async function initGatewayPayment(req, res) {
  const { storeId } = req.params;
  const { chargeId } = req.body;
  const charge = db.prepare(
    `SELECT * FROM billing_charges WHERE id = ? AND store_id = ? AND status IN ('pending','overdue')`
  ).get(chargeId, storeId);
  if (!charge) return res.status(404).json({ error: 'Charge not found or already resolved' });

  // Shape below is illustrative — swap in the real request/response fields
  // for whichever provider you picked in step 1.
  const gatewayRes = await fetch('https://api.<provider>.com/v1/checkout/initialize', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.PAYMENT_GATEWAY_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      amount: Math.round(charge.amount_due * 100), // most gateways want kobo, not naira
      currency: 'NGN',
      reference: `charge_${charge.id}`,             // ties the webhook back to this row
      metadata: { storeId, chargeId: charge.id },
    }),
  });
  const gatewayData = await gatewayRes.json();

  db.prepare('UPDATE billing_charges SET gateway_reference = ? WHERE id = ?')
    .run(gatewayData.data.reference, chargeId);

  res.json({ checkoutUrl: gatewayData.data.authorization_url });
}
```

On the frontend, `BillingStatus.jsx`'s "I've Paid" button becomes (or sits
alongside) a "Pay Now" button that calls this endpoint and redirects the
browser to `checkoutUrl` — same idea as the existing claim flow, just handing
the person off to the gateway's hosted page instead of a text form.

## 4. The webhook — this is what replaces the Super Admin clicking "Mark Paid"

```js
// desktop/server/routes/webhooks.js — new file, registered in app.js
// BEFORE the JSON body parser, or with express.raw() for this route
// specifically — most providers sign the *raw* request body, and
// re-serializing JSON before verifying breaks the signature.
const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const db = require('../db');
const billingCtrl = require('../controllers/billingController');

router.post('/payment-gateway', express.raw({ type: 'application/json' }), (req, res) => {
  const signature = req.headers['x-gateway-signature']; // exact header name is provider-specific
  const expected = crypto
    .createHmac('sha512', process.env.PAYMENT_GATEWAY_WEBHOOK_SECRET)
    .update(req.body) // raw Buffer, not parsed JSON — see note above
    .digest('hex');

  // Constant-time comparison — a plain === leaks timing information an
  // attacker can use to guess the correct signature byte by byte.
  const sigBuffer = Buffer.from(signature || '', 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  if (sigBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const event = JSON.parse(req.body.toString('utf8'));
  if (event.event !== 'charge.success') return res.status(200).json({ received: true }); // ack anything we don't care about

  const reference = event.data.reference; // "charge_<billing_charge_id>"
  const chargeId = reference.replace('charge_', '');
  const charge = db.prepare('SELECT * FROM billing_charges WHERE id = ?').get(chargeId);
  if (!charge || charge.status === 'paid') return res.status(200).json({ received: true }); // already handled, or unknown — ack either way so the provider stops retrying

  // IMPORTANT: don't trust the webhook payload's amount blindly — re-fetch
  // the transaction from the gateway's own "verify" API using `reference`
  // and confirm gatewayVerifyRes.amount / 100 === charge.amount_due before
  // marking paid. A forged or replayed webhook with a doctored amount is
  // exactly what signature verification + server-side re-verification
  // together are meant to catch — signature alone only proves the *sender*
  // was the gateway, not that this specific payload wasn't tampered with
  // upstream of signing, or that it's not a legitimate-but-wrong-amount event.

  db.transaction(() => {
    db.prepare(
      `UPDATE billing_charges SET status = 'paid', paid_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
    ).run(chargeId);
    db.prepare('UPDATE stores SET locked = 0 WHERE id = ?').run(charge.store_id);
  })();

  res.status(200).json({ received: true });
});

module.exports = router;
```

Register it in `app.js` **before** `express.json()` runs on this specific
path (the raw-body requirement above), and expose the URL to the gateway's
dashboard as `https://<your-domain>/api/webhooks/payment-gateway`. For the
**desktop edition specifically**: a webhook needs a publicly reachable URL,
which a desktop app behind a home/shop router normally doesn't have. Two
realistic options:
1. Point the gateway's webhook at your **web backend** instead (which is
   always publicly reachable), have the web backend mark the charge paid in
   its own database, and let the existing sync mechanism propagate that
   `locked = false` state down to the desktop instance on its next sync pass.
2. Skip automated webhooks for desktop-only stores entirely and keep the
   manual claim flow for them — it's a reasonable permanent choice, not just
   a stopgap, for stores that don't want a cloud dependency at all.

Given this project already has both editions, **option 1** is almost
certainly the right call: webhooks terminate at the cloud backend, and the
desktop LAN sync agent (`desktop/server/syncAgent.js`) carries the resulting
`locked`/`billing_charges` state down from there, the same way it already
carries everything else.

## 5. Testing

- Every provider mentioned here has a **test/sandbox mode** with its own key
  pair and test card numbers — use it. Don't test against the live key.
- Use the provider's CLI or a tunnel (e.g. `ngrok http 3000`) to get a public
  HTTPS URL pointing at your local dev server, and register *that* as the
  webhook URL in the sandbox dashboard so you can trigger real webhook
  deliveries while developing.
- Deliberately send a webhook with a **wrong signature** and confirm you get
  a 401, not a silently-accepted charge.
- Deliberately send the **same valid webhook twice** and confirm the second
  one is a no-op (the `charge.status === 'paid'` check above handles this) —
  providers retry webhooks on anything other than a fast 2xx response, so
  this will happen for real, not just in testing.

## 6. Security checklist before going live

- [ ] Signature verification uses the raw request body, not re-serialized JSON.
- [ ] Signature comparison is constant-time (`crypto.timingSafeEqual`), not `===`.
- [ ] The webhook re-verifies the amount against `billing_charges.amount_due`
      via the gateway's own "verify transaction" API — never trust the
      webhook payload's amount as the sole source of truth.
- [ ] The webhook is idempotent — replaying the same event twice must not
      double-process anything (checked above via `status === 'paid'`).
- [ ] Secret keys live in `.env` / environment variables only, never in
      frontend code, never committed to git.
- [ ] The webhook endpoint responds `200` quickly (before any slow work) so
      the provider doesn't mark it as failing and disable it — do slow work
      (e.g. sending a confirmation email) after acknowledging, not before.
