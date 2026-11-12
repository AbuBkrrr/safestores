const crypto = require('crypto');
const db = require('../db');

// ------------------------------------------------------------
// Store-facing
// ------------------------------------------------------------

// GET /api/stores/:storeId/billing/status
function getBillingStatus(req, res) {
  const { storeId } = req.params;
  const store = db.prepare(
    'SELECT billing_model, daily_rate_percent, grace_period_minutes, custom_billing_notes, locked FROM stores WHERE id = ?'
  ).get(storeId);
  if (!store) return res.status(404).json({ error: 'Store not found' });

  const charges = db.prepare(
    'SELECT * FROM billing_charges WHERE store_id = ? ORDER BY charge_date DESC LIMIT 30'
  ).all(storeId);

  res.json({ ...store, locked: !!store.locked, charges });
}

// POST /api/stores/:storeId/billing/claim-payment  { chargeId, method, reference }
// Store admin says "I've paid" for a specific pending/overdue charge — this
// does NOT unlock the store by itself; it queues a payment_claim
// notification for the Super Admin to confirm via markPaid.
function claimPayment(req, res) {
  const { storeId } = req.params;
  const { chargeId, method, reference } = req.body;
  const validMethods = ['ussd', 'bank_transfer', 'cash', 'card'];
  if (!chargeId || !validMethods.includes(method)) {
    return res.status(400).json({ error: `chargeId and a valid method (${validMethods.join(', ')}) are required` });
  }

  const charge = db.prepare(
    `SELECT * FROM billing_charges WHERE id = ? AND store_id = ? AND status IN ('pending','overdue')`
  ).get(chargeId, storeId);
  if (!charge) return res.status(404).json({ error: 'Charge not found or already resolved' });

  db.prepare(
    `UPDATE billing_charges SET claim_method = ?, claim_reference = ?, claimed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  ).run(method, reference || null, chargeId);

  const store = db.prepare('SELECT name FROM stores WHERE id = ?').get(storeId);
  db.prepare(
    `INSERT INTO notifications (id, type, store_id, billing_charge_id, message) VALUES (?,?,?,?,?)`
  ).run(
    crypto.randomUUID(), 'payment_claim', storeId, chargeId,
    `${store.name} claims payment of ${charge.amount_due} for ${charge.charge_date} via ${method}${reference ? ` (ref: ${reference})` : ''}. Awaiting confirmation.`
  );

  res.json({ message: 'Payment claim submitted — a Super Admin will confirm and unlock your store shortly.' });
}

// GET /api/settings/payment-instructions — public to any logged-in user
// (see app.js), so a locked/pending store can still see how to pay.
function getPaymentSettings(req, res) {
  const settings = db.prepare('SELECT * FROM payment_settings WHERE id = ?').get('default');
  if (!settings) return res.status(404).json({ error: 'Payment settings not configured' });
  res.json({ ...settings, methods: JSON.parse(settings.methods || '[]'), gateway_enabled: !!settings.gateway_enabled });
}

// ------------------------------------------------------------
// Super Admin-facing
// ------------------------------------------------------------

// GET /api/super/billing-charges?status=pending
function listCharges(req, res) {
  const { status } = req.query;
  const rows = status
    ? db.prepare(
        `SELECT bc.*, s.name AS store_name FROM billing_charges bc
         JOIN stores s ON s.id = bc.store_id
         WHERE bc.status = ? ORDER BY bc.charge_date DESC, s.name ASC LIMIT 500`
      ).all(status)
    : db.prepare(
        `SELECT bc.*, s.name AS store_name FROM billing_charges bc
         JOIN stores s ON s.id = bc.store_id
         ORDER BY bc.charge_date DESC, s.name ASC LIMIT 500`
      ).all();
  res.json(rows);
}

// PATCH /api/super/billing-charges/:id/mark-paid
// Manual confirmation for now — hook a real payment gateway's webhook to
// call this same path once one is wired in (see billingJob.js header).
function markPaid(req, res) {
  const { id } = req.params;
  const tx = db.transaction(() => {
    const info = db.prepare(
      `UPDATE billing_charges SET status = 'paid', paid_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), marked_paid_by = ? WHERE id = ?`
    ).run(req.user.sub, id);
    if (info.changes === 0) return null;
    const charge = db.prepare('SELECT * FROM billing_charges WHERE id = ?').get(id);
    db.prepare('UPDATE stores SET locked = 0 WHERE id = ?').run(charge.store_id);
    return charge;
  });
  const charge = tx();
  if (!charge) return res.status(404).json({ error: 'Charge not found' });
  res.json(charge);
}

// PATCH /api/super/billing-charges/:id/waive
// Forgives a charge without payment (goodwill, disputed charge, etc.) and
// unlocks the store the same way markPaid does.
function waiveCharge(req, res) {
  const { id } = req.params;
  const tx = db.transaction(() => {
    const info = db.prepare(
      `UPDATE billing_charges SET status = 'waived', waived_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), waived_by = ? WHERE id = ?`
    ).run(req.user.sub, id);
    if (info.changes === 0) return null;
    const charge = db.prepare('SELECT * FROM billing_charges WHERE id = ?').get(id);
    db.prepare('UPDATE stores SET locked = 0 WHERE id = ?').run(charge.store_id);
    return charge;
  });
  const charge = tx();
  if (!charge) return res.status(404).json({ error: 'Charge not found' });
  res.json(charge);
}

// PATCH /api/super/stores/:id/billing  { billingModel, dailyRatePercent, gracePeriodMinutes, customBillingNotes }
function updateBilling(req, res) {
  const { id } = req.params;
  const { billingModel, dailyRatePercent, gracePeriodMinutes, customBillingNotes } = req.body;
  if (billingModel && !['daily_percentage', 'custom'].includes(billingModel)) {
    return res.status(400).json({ error: 'billingModel must be daily_percentage or custom' });
  }
  const existing = db.prepare('SELECT * FROM stores WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Store not found' });

  db.prepare(
    `UPDATE stores SET
       billing_model = ?, daily_rate_percent = ?, grace_period_minutes = ?, custom_billing_notes = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?`
  ).run(
    billingModel || existing.billing_model,
    dailyRatePercent != null ? dailyRatePercent : existing.daily_rate_percent,
    gracePeriodMinutes != null ? gracePeriodMinutes : existing.grace_period_minutes,
    customBillingNotes != null ? customBillingNotes : existing.custom_billing_notes,
    id
  );
  res.json(db.prepare('SELECT * FROM stores WHERE id = ?').get(id));
}

// PATCH /api/super/payment-settings  { accountNumber, accountName, bankOrProvider, methods, instructions, gatewayProvider, gatewayEnabled }
// gatewayProvider/gatewayEnabled are a placeholder — see this column's
// definition in schema.sqlite.sql for the full rationale. Setting a
// provider does NOT turn on real payment processing; there is none yet.
function updatePaymentSettings(req, res) {
  const { accountNumber, accountName, bankOrProvider, methods, instructions, gatewayProvider, gatewayEnabled } = req.body;
  if (methods && !Array.isArray(methods)) return res.status(400).json({ error: 'methods must be an array' });
  const VALID_GATEWAYS = ['none', 'paystack', 'flutterwave', 'stripe'];
  if (gatewayProvider && !VALID_GATEWAYS.includes(gatewayProvider)) {
    return res.status(400).json({ error: `gatewayProvider must be one of: ${VALID_GATEWAYS.join(', ')}` });
  }

  const existing = db.prepare('SELECT * FROM payment_settings WHERE id = ?').get('default');
  db.prepare(
    `UPDATE payment_settings SET
       account_number = ?, account_name = ?, bank_or_provider = ?, methods = ?, instructions = ?,
       gateway_provider = ?, gateway_enabled = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = 'default'`
  ).run(
    accountNumber != null ? accountNumber : existing.account_number,
    accountName != null ? accountName : existing.account_name,
    bankOrProvider != null ? bankOrProvider : existing.bank_or_provider,
    methods ? JSON.stringify(methods) : existing.methods,
    instructions != null ? instructions : existing.instructions,
    gatewayProvider != null ? gatewayProvider : existing.gateway_provider,
    typeof gatewayEnabled === 'boolean' ? (gatewayEnabled ? 1 : 0) : existing.gateway_enabled
  );
  const settings = db.prepare('SELECT * FROM payment_settings WHERE id = ?').get('default');
  res.json({ ...settings, methods: JSON.parse(settings.methods || '[]'), gateway_enabled: !!settings.gateway_enabled });
}

module.exports = {
  getBillingStatus, claimPayment, getPaymentSettings,
  listCharges, markPaid, waiveCharge, updateBilling, updatePaymentSettings,
};
