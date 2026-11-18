// Inbound webhook FROM Paystack confirming a payment — distinct from
// controllers/webhooksController.js, which manages this store's own
// OUTBOUND webhooks (Integrations.jsx) firing on internal events. This
// one has no per-store auth at all (Paystack doesn't know our JWTs); the
// signature check below is the only thing standing between this
// endpoint and anyone POSTing a fake "payment succeeded" event, so it is
// not optional.
const db = require('../config/db');
const paystack = require('../utils/paystack');
const { markChargePaid } = require('./billingController');

async function handlePaystackWebhook(req, res) {
  const signature = req.get('x-paystack-signature');
  // req.rawBody is populated by app.js's express.json({ verify }) hook —
  // req.body here is already the parsed object, which is NOT what the
  // signature was computed over.
  if (!paystack.verifyWebhookSignature(req.rawBody, signature)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const event = req.body;
  // Acknowledge immediately for anything we don't act on — Paystack
  // retries on non-2xx, and there's no reason to retry an event type
  // this app doesn't use.
  if (event?.event !== 'charge.success') return res.status(200).json({ received: true });

  const reference = event.data?.reference;
  if (!reference) return res.status(200).json({ received: true });

  try {
    // A store paying its settlement balance to the platform.
    const { rows: sp } = await db.query('SELECT reference FROM store_settlement_payments WHERE reference = $1', [reference]);
    if (sp[0]) {
      await require('./settlementsController').confirmSettlementPayment(reference);
      return res.status(200).json({ received: true });
    }

    // Storefront order paid online (settles to the store's own subaccount).
    const { rows: mo } = await db.query('SELECT id FROM marketplace_orders WHERE payment_reference = $1', [reference]);
    if (mo[0]) {
      await require('./storePaymentsController').confirmOrderPayment(reference);
      return res.status(200).json({ received: true });
    }

    const { rows } = await db.query('SELECT id FROM billing_charges WHERE gateway_reference = $1', [reference]);
    const charge = rows[0];
    if (!charge) return res.status(200).json({ received: true }); // not one of ours, or already cleaned up

    // Trust our own DB lookup for which charge this is, but still verify
    // the transaction with Paystack's API rather than trusting the
    // webhook payload's own amount/status fields — the signature proves
    // Paystack sent this event, not that the embedded data wasn't for a
    // different, since-modified charge.
    const result = await paystack.verifyTransaction(reference);
    if (result.success) {
      await markChargePaid(charge.id, { paidVia: 'gateway', gatewayReference: reference });
    }
    res.status(200).json({ received: true });
  } catch (err) {
    console.error('Paystack webhook processing failed:', err.message);
    // Still 200 — Paystack will retry on failure, but a transient DB
    // hiccup here shouldn't cause it to hammer this endpoint; the
    // "verify on return" frontend path is the backstop for this charge.
    res.status(200).json({ received: true });
  }
}

module.exports = { handlePaystackWebhook };
