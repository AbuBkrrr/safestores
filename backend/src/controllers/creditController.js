// Guaranteed customer credit: a store's approved customers buy on credit up
// to a limit, and the named guarantor settles what they owe. See 045.
const db = require('../config/db');

const KINDS = ['bank', 'cooperative', 'pfa', 'employer', 'other'];
const money = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null; };

/** Credit used = unsettled credit orders that aren't cancelled. `q` = db or a transaction client. */
async function creditUsed(q, accountId) {
  const { rows } = await q.query(
    `SELECT COALESCE(SUM(total), 0) AS used FROM marketplace_orders
     WHERE credit_account_id = $1 AND payment_method = 'credit' AND status <> 'cancelled' AND payment_status <> 'paid'`, [accountId]
  );
  return Number(rows[0].used);
}

// ---- Customer (storefront) ----

// GET /api/marketplace/:storeId/credit → the store's guarantors + my account
async function myCredit(req, res) {
  const { storeId } = req.params;
  const { rows: guarantors } = await db.query(
    'SELECT id, name, kind FROM credit_guarantors WHERE store_id = $1 AND active ORDER BY name', [storeId]
  );
  const store = (await db.query('SELECT name, address, city, phone, credit_processing_fee FROM stores WHERE id = $1', [storeId])).rows[0];
  let account = null;
  if (req.user?.role === 'customer') {
    const { rows } = await db.query(
      `SELECT ca.id, ca.status, ca.credit_limit, ca.requested_limit, ca.member_ref, ca.note, ca.created_at,
              ca.letter_uploaded_at, ca.fee_amount, ca.fee_paid_at, ca.verified_at,
              g.name AS guarantor_name, g.kind AS guarantor_kind, c.name AS customer_name, c.phone AS customer_phone
       FROM credit_accounts ca JOIN customers c ON c.id = ca.customer_id JOIN credit_guarantors g ON g.id = ca.guarantor_id WHERE ca.store_id = $1 AND ca.customer_id = $2`,
      [storeId, req.user.sub]
    );
    if (rows[0]) {
      const used = await creditUsed(db, rows[0].id);
      account = { ...rows[0], used, available: Math.max(0, Number(rows[0].credit_limit) - used) };
    }
  }
  res.json({ guarantors, account, processingFee: Number(store?.credit_processing_fee || 0), store: store && { name: store.name, address: [store.address, store.city].filter(Boolean).join(', '), phone: store.phone } });
}

// POST /api/marketplace/:storeId/credit/apply  { guarantorId, memberRef, requestedLimit }
async function applyForCredit(req, res) {
  const { storeId } = req.params;
  const { guarantorId, memberRef } = req.body || {};
  const requested = money(req.body?.requestedLimit);
  if (!guarantorId || !String(memberRef || '').trim() || !requested) {
    return res.status(400).json({ error: 'Choose your guarantor, enter your staff/member number and the amount you need' });
  }
  const g = await db.query('SELECT id FROM credit_guarantors WHERE id = $1 AND store_id = $2 AND active', [guarantorId, storeId]);
  if (!g.rowCount) return res.status(400).json({ error: 'That guarantor is not available at this store' });
  const { rows } = await db.query(
    `INSERT INTO credit_accounts (store_id, customer_id, guarantor_id, member_ref, requested_limit)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (store_id, customer_id) DO UPDATE
       SET guarantor_id = EXCLUDED.guarantor_id, member_ref = EXCLUDED.member_ref, requested_limit = EXCLUDED.requested_limit,
           status = CASE WHEN credit_accounts.status = 'approved' THEN 'approved' ELSE 'pending' END
     RETURNING id, status`,
    [storeId, req.user.sub, guarantorId, String(memberRef).trim().slice(0, 80), requested]
  );
  require('../realtime').emitToStore(storeId, 'credit:applied', { id: rows[0].id });
  res.status(201).json(rows[0]);
}

// ---- Store ----

async function listGuarantors(req, res) {
  const { rows } = await db.query(
    `SELECT g.*, (SELECT COALESCE(SUM(mo.total),0) FROM marketplace_orders mo JOIN credit_accounts ca ON ca.id = mo.credit_account_id
                  WHERE ca.guarantor_id = g.id AND mo.payment_method = 'credit' AND mo.status <> 'cancelled' AND mo.payment_status <> 'paid') AS outstanding
     FROM credit_guarantors g WHERE g.store_id = $1 ORDER BY g.name`, [req.params.storeId]
  );
  res.json(rows);
}

async function saveGuarantor(req, res) {
  const { storeId, guarantorId } = req.params;
  const { name, kind, contactName, email, phone, active } = req.body || {};
  if (!guarantorId && !String(name || '').trim()) return res.status(400).json({ error: 'name is required' });
  if (kind && !KINDS.includes(kind)) return res.status(400).json({ error: `kind must be one of: ${KINDS.join(', ')}` });
  const vals = [name?.trim() || null, kind || null, contactName ?? null, email ?? null, phone ?? null, typeof active === 'boolean' ? active : null];
  const { rows } = guarantorId
    ? await db.query(
      `UPDATE credit_guarantors SET name = COALESCE($1, name), kind = COALESCE($2, kind), contact_name = COALESCE($3, contact_name),
              email = COALESCE($4, email), phone = COALESCE($5, phone), active = COALESCE($6, active)
       WHERE id = $7 AND store_id = $8 RETURNING *`, [...vals, guarantorId, storeId])
    : await db.query(
      `INSERT INTO credit_guarantors (name, kind, contact_name, email, phone, active, store_id)
       VALUES ($1, COALESCE($2,'other'), $3, $4, $5, COALESCE($6, true), $7) RETURNING *`, [...vals, storeId]);
  if (!rows[0]) return res.status(404).json({ error: 'Guarantor not found' });
  res.status(guarantorId ? 200 : 201).json(rows[0]);
}

async function listAccounts(req, res) {
  const { rows } = await db.query(
    `SELECT ca.*, c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email, g.name AS guarantor_name, g.kind AS guarantor_kind,
            g.email AS guarantor_email, g.phone AS guarantor_phone, g.contact_name AS guarantor_contact, s.credit_processing_fee AS processing_fee,
            vb.name AS verified_by_name
     FROM credit_accounts ca JOIN customers c ON c.id = ca.customer_id JOIN credit_guarantors g ON g.id = ca.guarantor_id
     JOIN stores s ON s.id = ca.store_id LEFT JOIN users vb ON vb.id = ca.verified_by
     WHERE ca.store_id = $1 ORDER BY (ca.status = 'pending') DESC, ca.created_at DESC`, [req.params.storeId]
  );
  for (const r of rows) { r.used = await creditUsed(db, r.id); r.available = Math.max(0, Number(r.credit_limit) - r.used); }
  res.json(rows);
}

// POST /api/marketplace/:storeId/credit/letter  (multipart "letter") — the signed, sealed declaration
async function uploadLetter(req, res) {
  const { storeId } = req.params;
  if (!req.file) return res.status(400).json({ error: 'Choose the signed and sealed letter (photo or PDF)' });
  const acc = (await db.query('SELECT id, status FROM credit_accounts WHERE store_id = $1 AND customer_id = $2', [storeId, req.user.sub])).rows[0];
  if (!acc) return res.status(404).json({ error: 'Apply for credit first' });
  if (acc.status === 'approved') return res.status(400).json({ error: 'Your credit is already approved' });
  await db.query(
    `INSERT INTO credit_documents (account_id, filename, mime_type, size_bytes, data) VALUES ($1,$2,$3,$4,$5)`,
    [acc.id, String(req.file.originalname).slice(0, 200), req.file.mimetype, req.file.size, req.file.buffer]
  );
  // A new letter needs verifying again.
  await db.query('UPDATE credit_accounts SET letter_uploaded_at = now(), verified_at = NULL, verified_by = NULL WHERE id = $1', [acc.id]);
  require('../realtime').emitToStore(storeId, 'credit:applied', { id: acc.id });
  res.status(201).json({ message: 'Letter received. The store will verify it with your guarantor.' });
}

// GET /api/stores/:storeId/credit/accounts/:accountId/letter — latest letter (store staff only)
async function getLetter(req, res) {
  const { rows } = await db.query(
    `SELECT d.filename, d.mime_type, d.data FROM credit_documents d JOIN credit_accounts ca ON ca.id = d.account_id
     WHERE ca.id = $1 AND ca.store_id = $2 ORDER BY d.created_at DESC LIMIT 1`, [req.params.accountId, req.params.storeId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'No letter uploaded yet' });
  res.set('Content-Type', rows[0].mime_type);
  res.set('Content-Disposition', `inline; filename="${rows[0].filename.replace(/[^\w.\- ]/g, '_')}"`);
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.send(rows[0].data);
}

// PATCH /api/stores/:storeId/credit/accounts/:accountId/fee  { amount, reference }
async function recordFee(req, res) {
  const amount = money(req.body?.amount);
  const reference = String(req.body?.reference || '').trim().slice(0, 120);
  if (amount === null || !reference) return res.status(400).json({ error: 'Enter the amount paid and the payment reference' });
  const { rows } = await db.query(
    `UPDATE credit_accounts SET fee_amount = $1, fee_reference = $2, fee_paid_at = now(), fee_recorded_by = $3
     WHERE id = $4 AND store_id = $5 RETURNING id, fee_amount, fee_paid_at`, [amount, reference, req.user.sub || null, req.params.accountId, req.params.storeId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Credit account not found' });
  res.json(rows[0]);
}

// PATCH /api/stores/:storeId/credit/accounts/:accountId/verify  { method, contact, note }
async function verifyWithGuarantor(req, res) {
  const method = req.body?.method;
  if (!['in_person', 'email', 'phone'].includes(method)) return res.status(400).json({ error: 'Choose how you verified: in person, email or phone' });
  const contact = String(req.body?.contact || '').trim().slice(0, 160);
  if (!contact) return res.status(400).json({ error: 'Enter who confirmed it at the guarantor (name, email or phone)' });
  const acc = (await db.query('SELECT letter_uploaded_at FROM credit_accounts WHERE id = $1 AND store_id = $2', [req.params.accountId, req.params.storeId])).rows[0];
  if (!acc) return res.status(404).json({ error: 'Credit account not found' });
  if (!acc.letter_uploaded_at) return res.status(400).json({ error: 'The customer has not uploaded the guarantor letter yet' });
  const { rows } = await db.query(
    `UPDATE credit_accounts SET verified_at = now(), verified_by = $1, verify_method = $2, verify_contact = $3, verify_note = $4
     WHERE id = $5 RETURNING id, verified_at, verify_method`,
    [req.user.sub || null, method, contact, String(req.body?.note || '').trim().slice(0, 500) || null, req.params.accountId]
  );
  res.json(rows[0]);
}

// PATCH /api/stores/:storeId/credit/settings  { processingFee }
async function updateCreditSettings(req, res) {
  const fee = money(req.body?.processingFee);
  if (fee === null) return res.status(400).json({ error: 'Enter a processing fee of zero or more' });
  await db.query('UPDATE stores SET credit_processing_fee = $1 WHERE id = $2', [fee, req.params.storeId]);
  res.json({ processingFee: fee });
}

// What still blocks approval (empty = ready).
function kycMissing(acc, fee) {
  const missing = [];
  if (!acc.letter_uploaded_at) missing.push('the signed and sealed guarantor letter');
  if (Number(fee) > 0 && !acc.fee_paid_at) missing.push('the documentation fee');
  if (!acc.verified_at && acc.member_verified !== true) missing.push('verification with the guarantor');
  return missing;
}

// PATCH /api/stores/:storeId/credit/accounts/:accountId  { status, creditLimit?, note? }
async function reviewAccount(req, res) {
  const { storeId, accountId } = req.params;
  const { status, note } = req.body || {};
  if (!['approved', 'rejected', 'suspended'].includes(status)) return res.status(400).json({ error: 'status must be approved, rejected or suspended' });
  const limit = req.body.creditLimit === undefined ? undefined : money(req.body.creditLimit);
  if (status === 'approved' && !limit) return res.status(400).json({ error: 'Set a credit limit above zero to approve' });
  if (status === 'approved') {
    const acc = (await db.query(
      `SELECT ca.letter_uploaded_at, ca.fee_paid_at, ca.verified_at, ca.member_verified, s.credit_processing_fee
       FROM credit_accounts ca JOIN stores s ON s.id = ca.store_id WHERE ca.id = $1 AND ca.store_id = $2`, [accountId, storeId]
    )).rows[0];
    if (!acc) return res.status(404).json({ error: 'Credit account not found' });
    const missing = kycMissing(acc, acc.credit_processing_fee);
    if (missing.length) return res.status(400).json({ error: `Cannot approve yet. Still needed: ${missing.join(', ')}.`, code: 'KYC_INCOMPLETE', missing });
  }
  const { rows } = await db.query(
    `UPDATE credit_accounts SET status = $1, credit_limit = COALESCE($2, credit_limit), note = COALESCE($3, note),
            reviewed_by = $4, reviewed_at = now()
     WHERE id = $5 AND store_id = $6 RETURNING *`,
    [status, limit ?? null, note ? String(note).slice(0, 300) : null, req.user.sub || null, accountId, storeId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Credit account not found' });
  res.json(rows[0]);
}

// GET /api/stores/:storeId/credit/statement?guarantorId= — what the guarantor owes, order by order
async function statement(req, res) {
  const { storeId } = req.params;
  const params = [storeId];
  let where = '';
  if (req.query.guarantorId) { params.push(req.query.guarantorId); where = 'AND g.id = $2'; }
  const { rows } = await db.query(
    `SELECT mo.id, mo.total, mo.status, mo.created_at, mo.fulfilled_at, mo.guarantor_paid_ref, mo.guarantor_paid_reported_at, c.name AS customer_name, ca.member_ref, g.id AS guarantor_id, g.name AS guarantor_name
     FROM marketplace_orders mo JOIN credit_accounts ca ON ca.id = mo.credit_account_id
     JOIN credit_guarantors g ON g.id = ca.guarantor_id JOIN customers c ON c.id = ca.customer_id
     WHERE mo.store_id = $1 AND mo.payment_method = 'credit' AND mo.status = 'fulfilled' AND mo.payment_status <> 'paid' ${where}
     ORDER BY g.name, mo.fulfilled_at`, params
  );
  res.json(rows);
}

// PATCH /api/stores/:storeId/marketplace/orders/:orderId/credit-settled — the guarantor paid this order
async function markCreditSettled(req, res) {
  const { storeId, orderId } = req.params;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM marketplace_orders WHERE id = $1 AND store_id = $2 AND payment_method = 'credit' FOR UPDATE`, [orderId, storeId]
    );
    const order = rows[0];
    if (!order || order.status !== 'fulfilled' || order.payment_status === 'paid') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Only a fulfilled, unsettled credit order can be marked settled' });
    }
    // The store has now collected the money: commission works as for cash orders.
    await require('./settlementsController').recordCashCompleted(client, order, req.user.sub, { includeCredit: true });
    await client.query('COMMIT');
    res.json({ message: 'Marked as settled by the guarantor' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to mark settled' });
  } finally { client.release(); }
}

module.exports = {
  uploadLetter, getLetter, recordFee, verifyWithGuarantor, updateCreditSettings, creditUsed, myCredit, applyForCredit, listGuarantors, saveGuarantor, listAccounts, reviewAccount, statement, markCreditSettled };
