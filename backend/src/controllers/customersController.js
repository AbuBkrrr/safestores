const db = require('../config/db');
const { emitToStore } = require('../realtime');

// GET /api/stores/:storeId/customers?includeArchived=&search=
// Returns each customer with their CURRENT balance computed as a live
// SUM over the ledger — never a stored/cached number that could drift.
async function listCustomers(req, res) {
  const { storeId } = req.params;
  const { includeArchived, search } = req.query;
  const conditions = ['sc.store_id = $1'];
  const params = [storeId];
  if (!includeArchived) conditions.push('sc.archived_at IS NULL');
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(sc.name ILIKE $${params.length} OR sc.phone ILIKE $${params.length})`);
  }
  const { rows } = await db.query(
    `SELECT sc.*, COALESCE(SUM(cle.amount), 0) AS balance
     FROM store_customers sc
     LEFT JOIN customer_ledger_entries cle ON cle.store_customer_id = sc.id
     WHERE ${conditions.join(' AND ')}
     GROUP BY sc.id
     ORDER BY balance DESC, sc.name ASC`,
    params
  );
  res.json(rows);
}

// POST /api/stores/:storeId/customers  { name, phone?, notes? }
async function createCustomer(req, res) {
  const { storeId } = req.params;
  const { name, phone, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const { rows } = await db.query(
    `INSERT INTO store_customers (store_id, name, phone, notes) VALUES ($1,$2,$3,$4) RETURNING *, 0 AS balance`,
    [storeId, name, phone || null, notes || null]
  );
  res.status(201).json(rows[0]);
}

// GET /api/stores/:storeId/customers/:customerId  — profile + full ledger history
async function getCustomer(req, res) {
  const { storeId, customerId } = req.params;
  const { rows: customerRows } = await db.query(
    'SELECT * FROM store_customers WHERE id = $1 AND store_id = $2',
    [customerId, storeId]
  );
  const customer = customerRows[0];
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  const { rows: ledger } = await db.query(
    `SELECT cle.*, u.name AS recorded_by_name
     FROM customer_ledger_entries cle
     LEFT JOIN users u ON u.id = cle.recorded_by
     WHERE cle.store_customer_id = $1 ORDER BY cle.created_at DESC`,
    [customerId]
  );
  const balance = ledger.reduce((sum, e) => sum + Number(e.amount), 0);
  res.json({ ...customer, balance, ledger });
}

// PATCH /api/stores/:storeId/customers/:customerId  { name?, phone?, notes? }
async function updateCustomer(req, res) {
  const { storeId, customerId } = req.params;
  const { name, phone, notes } = req.body;
  const { rows } = await db.query(
    `UPDATE store_customers SET name = COALESCE($1,name), phone = COALESCE($2,phone), notes = COALESCE($3,notes)
     WHERE id = $4 AND store_id = $5 RETURNING *`,
    [name || null, phone, notes, customerId, storeId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Customer not found' });
  res.json(rows[0]);
}

// DELETE /api/stores/:storeId/customers/:customerId — archive, never a hard delete (the ledger history must survive)
async function archiveCustomer(req, res) {
  const { storeId, customerId } = req.params;
  const { rows } = await db.query(
    `UPDATE store_customers SET archived_at = now() WHERE id = $1 AND store_id = $2 AND archived_at IS NULL RETURNING id`,
    [customerId, storeId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Customer not found or already archived' });
  res.status(204).end();
}

// POST /api/stores/:storeId/customers/:customerId/payments  { amount, note? }
// Records money received against what they owe. amount must be positive
// (it's stored as a negative ledger entry internally, decreasing balance).
async function recordPayment(req, res) {
  const { storeId, customerId } = req.params;
  const { amount, note } = req.body;
  const amt = Number(amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'amount must be a positive number' });

  const { rows: customerRows } = await db.query('SELECT id FROM store_customers WHERE id = $1 AND store_id = $2', [customerId, storeId]);
  if (!customerRows[0]) return res.status(404).json({ error: 'Customer not found' });

  const { rows } = await db.query(
    `INSERT INTO customer_ledger_entries (store_id, store_customer_id, type, amount, note, recorded_by)
     VALUES ($1,$2,'payment',$3,$4,$5) RETURNING *`,
    [storeId, customerId, -amt, note || null, req.user.sub]
  );
  res.status(201).json(rows[0]);
  emitToStore(storeId, 'customer:payment', { customerId, amount: amt });
}

// POST /api/stores/:storeId/customers/:customerId/adjustments  { amount, note }
// A manual correction (e.g. fixing a data-entry mistake) — amount can be
// positive (increases what's owed) or negative (decreases it). Requires
// a note, since an unexplained balance change is exactly the kind of
// thing a store owner would want to be able to trace later.
async function recordAdjustment(req, res) {
  const { storeId, customerId } = req.params;
  const { amount, note } = req.body;
  const amt = Number(amount);
  if (!amt) return res.status(400).json({ error: 'amount must be a non-zero number' });
  if (!note) return res.status(400).json({ error: 'note is required for adjustments' });

  const { rows: customerRows } = await db.query('SELECT id FROM store_customers WHERE id = $1 AND store_id = $2', [customerId, storeId]);
  if (!customerRows[0]) return res.status(404).json({ error: 'Customer not found' });

  const { rows } = await db.query(
    `INSERT INTO customer_ledger_entries (store_id, store_customer_id, type, amount, note, recorded_by)
     VALUES ($1,$2,'adjustment',$3,$4,$5) RETURNING *`,
    [storeId, customerId, amt, note, req.user.sub]
  );
  res.status(201).json(rows[0]);
}

module.exports = { listCustomers, createCustomer, getCustomer, updateCustomer, archiveCustomer, recordPayment, recordAdjustment };
