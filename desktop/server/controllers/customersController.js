// ------------------------------------------------------------
// Customer credit tracking ("owing book") — desktop/SQLite counterpart of
// backend/src/controllers/customersController.js. Same behavior, ported
// to better-sqlite3's synchronous API (no async/await, no $-placeholders,
// balance summed in SQL the same way). See schema.sqlite.sql's comment
// above store_customers for why this table exists but the marketplace
// customer accounts / lending-partner tables from the same cloud
// migration do not.
// ------------------------------------------------------------

const crypto = require('crypto');
const db = require('../db');
const { emitToStore } = require('../realtime');

// GET /api/stores/:storeId/customers?includeArchived=&search=
function listCustomers(req, res) {
  const { storeId } = req.params;
  const { includeArchived, search } = req.query;
  const conditions = ['sc.store_id = ?'];
  const params = [storeId];
  if (!includeArchived) conditions.push('sc.archived_at IS NULL');
  if (search) {
    conditions.push('(sc.name LIKE ? OR sc.phone LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }
  const rows = db.prepare(
    `SELECT sc.*, COALESCE(SUM(cle.amount), 0) AS balance
     FROM store_customers sc
     LEFT JOIN customer_ledger_entries cle ON cle.store_customer_id = sc.id
     WHERE ${conditions.join(' AND ')}
     GROUP BY sc.id
     ORDER BY balance DESC, sc.name ASC`
  ).all(...params);
  res.json(rows);
}

// POST /api/stores/:storeId/customers  { name, phone?, notes? }
function createCustomer(req, res) {
  const { storeId } = req.params;
  const { name, phone, notes, email, birthday } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (birthday && Number.isNaN(Date.parse(birthday))) return res.status(400).json({ error: 'Invalid birthday' });
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO store_customers (id, store_id, name, phone, notes, email, birthday) VALUES (?,?,?,?,?,?,?)')
    .run(id, storeId, name, phone || null, notes || null, email || null, birthday ? String(birthday).slice(0, 10) : null);
  const customer = db.prepare('SELECT *, 0 AS balance FROM store_customers WHERE id = ?').get(id);
  res.status(201).json(customer);
}

// GET /api/stores/:storeId/customers/:customerId — profile + full ledger history
function getCustomer(req, res) {
  const { storeId, customerId } = req.params;
  const customer = db.prepare('SELECT * FROM store_customers WHERE id = ? AND store_id = ?').get(customerId, storeId);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  const ledger = db.prepare(
    `SELECT cle.*, u.name AS recorded_by_name
     FROM customer_ledger_entries cle
     LEFT JOIN users u ON u.id = cle.recorded_by
     WHERE cle.store_customer_id = ? ORDER BY cle.created_at DESC`
  ).all(customerId);
  const balance = ledger.reduce((sum, e) => sum + Number(e.amount), 0);
  res.json({ ...customer, balance, ledger });
}

// PATCH /api/stores/:storeId/customers/:customerId  { name?, phone?, notes? }
function updateCustomer(req, res) {
  const { storeId, customerId } = req.params;
  const existing = db.prepare('SELECT * FROM store_customers WHERE id = ? AND store_id = ?').get(customerId, storeId);
  if (!existing) return res.status(404).json({ error: 'Customer not found' });
  const { name, phone, notes, email, birthday } = req.body;
  if (birthday && Number.isNaN(Date.parse(birthday))) return res.status(400).json({ error: 'Invalid birthday' });
  db.prepare("UPDATE store_customers SET name = ?, phone = ?, notes = ?, email = ?, birthday = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(
    name || existing.name,
    phone !== undefined ? phone : existing.phone,
    notes !== undefined ? notes : existing.notes,
    email !== undefined ? (email || null) : existing.email,
    birthday !== undefined ? (birthday ? String(birthday).slice(0, 10) : null) : existing.birthday,
    customerId
  );
  res.json(db.prepare('SELECT * FROM store_customers WHERE id = ?').get(customerId));
}

// DELETE /api/stores/:storeId/customers/:customerId — archive, never a hard delete (ledger history must survive)
function archiveCustomer(req, res) {
  const { storeId, customerId } = req.params;
  const result = db.prepare(
    `UPDATE store_customers SET archived_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ? AND store_id = ? AND archived_at IS NULL`
  ).run(customerId, storeId);
  if (result.changes === 0) return res.status(404).json({ error: 'Customer not found or already archived' });
  res.status(204).end();
}

// POST /api/stores/:storeId/customers/:customerId/payments  { amount, note? }
function recordPayment(req, res) {
  const { storeId, customerId } = req.params;
  const { amount, note } = req.body;
  const amt = Number(amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'amount must be a positive number' });

  const customer = db.prepare('SELECT id FROM store_customers WHERE id = ? AND store_id = ?').get(customerId, storeId);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO customer_ledger_entries (id, store_id, store_customer_id, type, amount, note, recorded_by)
     VALUES (?,?,?,'payment',?,?,?)`
  ).run(id, storeId, customerId, -amt, note || null, req.user.sub);
  const entry = db.prepare('SELECT * FROM customer_ledger_entries WHERE id = ?').get(id);
  res.status(201).json(entry);
  emitToStore(storeId, 'customer:payment', { customerId, amount: amt });
}

// POST /api/stores/:storeId/customers/:customerId/adjustments  { amount, note }
function recordAdjustment(req, res) {
  const { storeId, customerId } = req.params;
  const { amount, note } = req.body;
  const amt = Number(amount);
  if (!amt) return res.status(400).json({ error: 'amount must be a non-zero number' });
  if (!note) return res.status(400).json({ error: 'note is required for adjustments' });

  const customer = db.prepare('SELECT id FROM store_customers WHERE id = ? AND store_id = ?').get(customerId, storeId);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO customer_ledger_entries (id, store_id, store_customer_id, type, amount, note, recorded_by)
     VALUES (?,?,?,'adjustment',?,?,?)`
  ).run(id, storeId, customerId, amt, note, req.user.sub);
  res.status(201).json(db.prepare('SELECT * FROM customer_ledger_entries WHERE id = ?').get(id));
}

module.exports = { listCustomers, createCustomer, getCustomer, updateCustomer, archiveCustomer, recordPayment, recordAdjustment };
