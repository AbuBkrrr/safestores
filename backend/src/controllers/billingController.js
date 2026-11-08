const db = require('../config/db');
const crypto = require('crypto');
const paystack = require('../utils/paystack');

const VALID_CLAIM_METHODS = ['ussd', 'bank_transfer', 'cash', 'card'];

// GET /api/stores/:storeId/billing/status
// What the store admin sees: current lock state, latest charge, recent history.
async function getBillingStatus(req, res) {
  const { storeId } = req.params;
  const storeRes = await db.query(
    'SELECT billing_model, daily_rate_percent, grace_period_minutes, custom_billing_notes, locked FROM stores WHERE id = $1',
    [storeId]
  );
  if (!storeRes.rows[0]) return res.status(404).json({ error: 'Store not found' });

  const chargesRes = await db.query(
    'SELECT * FROM billing_charges WHERE store_id = $1 ORDER BY charge_date DESC LIMIT 30',
    [storeId]
  );

  res.json({ ...storeRes.rows[0], charges: chargesRes.rows });
}

// POST /api/stores/:storeId/billing/claim-payment  { chargeId, method, reference }
// Store admin says "I've paid" — queues a payment_claim notification for
// the Super Admin to confirm via markPaid; does not unlock by itself.
async function claimPayment(req, res) {
  const { storeId } = req.params;
  const { chargeId, method, reference } = req.body;
  if (!chargeId || !VALID_CLAIM_METHODS.includes(method)) {
    return res.status(400).json({ error: `chargeId and a valid method (${VALID_CLAIM_METHODS.join(', ')}) are required` });
  }

  const chargeRes = await db.query(
    `SELECT * FROM billing_charges WHERE id = $1 AND store_id = $2 AND status IN ('pending','overdue')`,
    [chargeId, storeId]
  );
  const charge = chargeRes.rows[0];
  if (!charge) return res.status(404).json({ error: 'Charge not found or already resolved' });

  await db.query(
    `UPDATE billing_charges SET claim_method = $1, claim_reference = $2, claimed_at = now() WHERE id = $3`,
    [method, reference || null, chargeId]
  );

  const storeRes = await db.query('SELECT name FROM stores WHERE id = $1', [storeId]);
  await db.query(
    `INSERT INTO notifications (type, store_id, billing_charge_id, message) VALUES ('payment_claim', $1, $2, $3)`,
    [storeId, chargeId,
      `${storeRes.rows[0].name} claims payment of ${charge.amount_due} for ${charge.charge_date} via ${method}${reference ? ` (ref: ${reference})` : ''}. Awaiting confirmation.`]
  );

  res.json({ message: 'Payment claim submitted — a Super Admin will confirm and unlock your store shortly.' });
}

// GET /api/settings/payment-instructions — public to any logged-in user
// (see routes/stores.js / server.js), so a locked/pending store can still
// see how to pay.
async function getPaymentSettings(req, res) {
  const { rows } = await db.query('SELECT * FROM payment_settings WHERE id = $1', ['default']);
  if (!rows[0]) return res.status(404).json({ error: 'Payment settings not configured' });
  res.json(rows[0]);
}

// PATCH /api/super/payment-settings  { accountNumber, accountName, bankOrProvider, methods, instructions, gatewayProvider, gatewayEnabled }
// gatewayProvider='paystack' + gatewayEnabled=true is now real — see
// utils/paystack.js and initializeGatewayPayment below — provided
// PAYSTACK_SECRET_KEY is also set in .env; without that key, the "Pay
// Online Now" button on the store side stays hidden regardless of these
// settings. flutterwave/stripe remain selectable here as before but have
// no integration code behind them yet (still just a stored preference).
async function updatePaymentSettings(req, res) {
  const { accountNumber, accountName, bankOrProvider, methods, instructions, gatewayProvider, gatewayEnabled } = req.body;
  if (methods && !Array.isArray(methods)) return res.status(400).json({ error: 'methods must be an array' });
  const VALID_GATEWAYS = ['none', 'paystack', 'flutterwave', 'stripe'];
  if (gatewayProvider && !VALID_GATEWAYS.includes(gatewayProvider)) {
    return res.status(400).json({ error: `gatewayProvider must be one of: ${VALID_GATEWAYS.join(', ')}` });
  }

  const { rows } = await db.query(
    `UPDATE payment_settings SET
       account_number = COALESCE($1, account_number),
       account_name = COALESCE($2, account_name),
       bank_or_provider = COALESCE($3, bank_or_provider),
       methods = COALESCE($4, methods),
       instructions = COALESCE($5, instructions),
       gateway_provider = COALESCE($6, gateway_provider),
       gateway_enabled = COALESCE($7, gateway_enabled),
       updated_at = now()
     WHERE id = 'default' RETURNING *`,
    [
      accountNumber || null, accountName || null, bankOrProvider || null,
      methods ? JSON.stringify(methods) : null, instructions || null,
      gatewayProvider || null, typeof gatewayEnabled === 'boolean' ? gatewayEnabled : null,
    ]
  );
  res.json(rows[0]);
}

// PATCH /api/super/billing-charges/:id/waive
// Forgives a charge without payment and unlocks the store, same as markPaid.
async function waiveCharge(req, res) {
  const { id } = req.params;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE billing_charges SET status = 'waived', waived_at = now(), waived_by = $1 WHERE id = $2 RETURNING *`,
      [req.user.sub, id]
    );
    if (!rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Charge not found' }); }
    await client.query('UPDATE stores SET locked = false WHERE id = $1', [rows[0].store_id]);
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to waive charge' });
  } finally {
    client.release();
  }
}

// GET /api/super/billing-charges?status=pending
async function listCharges(req, res) {
  const { status } = req.query;
  const params = [];
  let where = '';
  if (status) { params.push(status); where = `WHERE bc.status = $${params.length}`; }

  const { rows } = await db.query(
    `SELECT bc.*, s.name AS store_name FROM billing_charges bc
     JOIN stores s ON s.id = bc.store_id
     ${where}
     ORDER BY bc.charge_date DESC, s.name ASC LIMIT 500`,
    params
  );
  res.json(rows);
}

// PATCH /api/super/billing-charges/:id/mark-paid
// The manual path — a Super Admin confirming a claimed bank transfer/cash
// payment by hand. verifyGatewayPayment and the Paystack webhook below
// are the automated equivalent, sharing markChargePaid so both paths stay
// in sync (same store-unlock behavior, same 'already paid' idempotency).
async function markPaid(req, res) {
  const { id } = req.params;
  try {
    const charge = await markChargePaid(id, { markedPaidBy: req.user.sub, paidVia: 'manual' });
    if (!charge) return res.status(404).json({ error: 'Charge not found' });
    res.json(charge);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to mark charge paid' });
  }
}

// Shared by markPaid (manual), verifyGatewayPayment, and the Paystack
// webhook handler — the one place that actually flips a charge to paid
// and unlocks its store, so all three paths behave identically. Safe to
// call on an already-paid charge (returns it unchanged rather than
// erroring), since both the webhook and the "verify on return" frontend
// call can race to confirm the same payment.
async function markChargePaid(chargeId, { markedPaidBy = null, paidVia = 'manual', gatewayReference = null } = {}) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT * FROM billing_charges WHERE id = $1', [chargeId]);
    if (!existing.rows[0]) { await client.query('ROLLBACK'); return null; }
    if (existing.rows[0].status === 'paid') { await client.query('ROLLBACK'); return existing.rows[0]; }

    const { rows } = await client.query(
      `UPDATE billing_charges
       SET status = 'paid', paid_at = now(), marked_paid_by = $1, paid_via = $2, gateway_reference = COALESCE($3, gateway_reference)
       WHERE id = $4 RETURNING *`,
      [markedPaidBy, paidVia, gatewayReference, chargeId]
    );
    await client.query('UPDATE stores SET locked = false WHERE id = $1', [rows[0].store_id]);
    await client.query('COMMIT');
    return rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// POST /api/stores/:storeId/billing/charges/:chargeId/pay/initialize
// Starts a real online payment for one charge via Paystack, if a store
// admin/manager would rather pay immediately than do a manual bank
// transfer. Returns the hosted checkout URL to redirect the browser to;
// nothing is marked paid here — that only happens once Paystack confirms
// the payment actually went through (verifyGatewayPayment below, or the
// webhook).
async function initializeGatewayPayment(req, res) {
  const { storeId, chargeId } = req.params;
  const { callbackUrl } = req.body;
  if (!callbackUrl) return res.status(400).json({ error: 'callbackUrl is required' });

  const settingsRes = await db.query(`SELECT gateway_provider, gateway_enabled FROM payment_settings WHERE id = 'default'`);
  const settings = settingsRes.rows[0];
  if (!settings || settings.gateway_provider !== 'paystack' || !settings.gateway_enabled) {
    return res.status(503).json({ error: 'Online payment is not enabled for this store yet. Please use the bank transfer instructions instead.' });
  }
  if (!paystack.isConfigured) {
    return res.status(503).json({ error: 'Online payment is not configured on this server yet.' });
  }

  const chargeRes = await db.query(
    `SELECT * FROM billing_charges WHERE id = $1 AND store_id = $2 AND status IN ('pending', 'overdue')`,
    [chargeId, storeId]
  );
  const charge = chargeRes.rows[0];
  if (!charge) return res.status(404).json({ error: 'Charge not found or already resolved' });

  const userRes = await db.query('SELECT email FROM users WHERE id = $1', [req.user.sub]);
  const email = userRes.rows[0]?.email;
  if (!email) return res.status(400).json({ error: 'No email on file for this account' });

  // Prefixed + randomized so it's unique across every store/charge even
  // if the same charge is retried after a failed/abandoned attempt, and
  // so the webhook/verify path can look the charge back up without
  // needing Paystack to echo any of our internal IDs.
  const reference = `ss_${chargeId}_${crypto.randomBytes(6).toString('hex')}`;

  try {
    const result = await paystack.initializeTransaction({
      email,
      amountNaira: Number(charge.amount_due),
      reference,
      callbackUrl,
      metadata: { storeId, chargeId },
    });
    await db.query(`UPDATE billing_charges SET gateway_reference = $1 WHERE id = $2`, [reference, chargeId]);
    res.json({ authorizationUrl: result.authorizationUrl, reference });
  } catch (err) {
    console.error('Paystack initialize failed:', err.message);
    res.status(502).json({ error: 'Could not start online payment. Please try again or use bank transfer.' });
  }
}

// POST /api/stores/:storeId/billing/charges/:chargeId/pay/verify  { reference }
// Called by the frontend right after Paystack redirects the browser back
// (its callback_url) — confirms the transaction directly with Paystack's
// API rather than trusting the redirect alone (a redirect happening at
// all doesn't prove payment succeeded). The webhook below covers the
// case where the browser never makes it back here (closed tab, crashed
// connection, etc.) — whichever path reaches Paystack's confirmation
// first wins, via markChargePaid's idempotency.
async function verifyGatewayPayment(req, res) {
  const { storeId, chargeId } = req.params;
  const { reference } = req.body;
  if (!reference) return res.status(400).json({ error: 'reference is required' });

  const chargeRes = await db.query(
    `SELECT * FROM billing_charges WHERE id = $1 AND store_id = $2 AND gateway_reference = $3`,
    [chargeId, storeId, reference]
  );
  if (!chargeRes.rows[0]) return res.status(404).json({ error: 'Charge not found for this reference' });

  try {
    const result = await paystack.verifyTransaction(reference);
    if (!result.success) {
      return res.status(402).json({ error: 'Payment was not successful.', verified: false });
    }
    const charge = await markChargePaid(chargeId, { paidVia: 'gateway', gatewayReference: reference });
    res.json({ verified: true, charge });
  } catch (err) {
    console.error('Paystack verify failed:', err.message);
    res.status(502).json({ error: 'Could not verify payment with Paystack. If you were charged, contact support.' });
  }
}

// PATCH /api/super/stores/:id/billing  { billingModel, dailyRatePercent, gracePeriodMinutes, customBillingNotes }
// Lets the Super Admin change a store's billing arrangement after activation.
async function updateBilling(req, res) {
  const { id } = req.params;
  const { billingModel, dailyRatePercent, gracePeriodMinutes, customBillingNotes } = req.body;
  if (billingModel && !['daily_percentage', 'custom'].includes(billingModel)) {
    return res.status(400).json({ error: 'billingModel must be daily_percentage or custom' });
  }
  const { rows } = await db.query(
    `UPDATE stores SET
       billing_model = COALESCE($1, billing_model),
       daily_rate_percent = COALESCE($2, daily_rate_percent),
       grace_period_minutes = COALESCE($3, grace_period_minutes),
       custom_billing_notes = COALESCE($4, custom_billing_notes),
       updated_at = now()
     WHERE id = $5 RETURNING *`,
    [billingModel || null, dailyRatePercent || null, gracePeriodMinutes || null, customBillingNotes || null, id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Store not found' });
  res.json(rows[0]);
}

module.exports = {
  getBillingStatus, claimPayment, getPaymentSettings, updatePaymentSettings,
  listCharges, markPaid, waiveCharge, updateBilling,
  initializeGatewayPayment, verifyGatewayPayment, markChargePaid,
};
