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
  let account = null;
  if (req.user?.role === 'customer') {
    const { rows } = await db.query(
      `SELECT ca.id, ca.status, ca.credit_limit, ca.requested_limit, ca.member_ref, ca.note, g.name AS guarantor_name
       FROM credit_accounts ca JOIN credit_guarantors g ON g.id = ca.guarantor_id WHERE ca.store_id = $1 AND ca.customer_id = $2`,
      [storeId, req.user.sub]
    );
    if (rows[0]) {
      const used = await creditUsed(db, rows[0].id);
      account = { ...rows[0], used, available: Math.max(0, Number(rows[0].credit_limit) - used) };
    }
  }
  res.json({ guarantors, account });
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
    `SELECT ca.*, c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email, g.name AS guarantor_name, g.kind AS guarantor_kind
     FROM credit_accounts ca JOIN customers c ON c.id = ca.customer_id JOIN credit_guarantors g ON g.id = ca.guarantor_id
     WHERE ca.store_id = $1 ORDER BY (ca.status = 'pending') DESC, ca.created_at DESC`, [req.params.storeId]
  );
  for (const r of rows) { r.used = await creditUsed(db, r.id); r.available = Math.max(0, Number(r.credit_limit) - r.used); }
  res.json(rows);
}

// PATCH /api/stores/:storeId/credit/accounts/:accountId  { status, creditLimit?, note? }
async function reviewAccount(req, res) {
  const { storeId, accountId } = req.params;
  const { status, note } = req.body || {};
  if (!['approved', 'rejected', 'suspended'].includes(status)) return res.status(400).json({ error: 'status must be approved, rejected or suspended' });
  const limit = req.body.creditLimit === undefined ? undefined : money(req.body.creditLimit);
  if (status === 'approved' && !limit) return res.status(400).json({ error: 'Set a credit limit above zero to approve' });
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
    `SELECT mo.id, mo.total, mo.status, mo.created_at, mo.fulfilled_at, c.name AS customer_name, ca.member_ref, g.id AS guarantor_id, g.name AS guarantor_name
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

module.exports = { creditUsed, myCredit, applyForCredit, listGuarantors, saveGuarantor, listAccounts, reviewAccount, statement, markCreditSettled };
