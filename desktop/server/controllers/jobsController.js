const crypto = require('crypto');
const db = require('../db');
const { consume } = require('./productionController');
const { roundQty } = require('../utils/qty');

// Services & job orders offline (tailor, laundry, repairs). Same rules as
// backend/src/controllers/jobsController.js. JSON columns are stored as text.

const STATUSES = ['received', 'in_progress', 'fitting', 'ready', 'collected', 'cancelled'];
const METHODS = ['cash', 'card', 'transfer', 'other'];
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const money = (v) => Math.round(Number(v || 0) * 100) / 100;
const newRef = () => `J${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
const parse = (v, fallback) => { try { return typeof v === 'string' ? JSON.parse(v) : (v ?? fallback); } catch { return fallback; } };
const cleanMeasurements = (m) => Object.fromEntries(Object.entries(m && typeof m === 'object' ? m : {})
  .map(([k, v]) => [String(k).trim().slice(0, 40), String(v ?? '').trim().slice(0, 40)]).filter(([k, v]) => k && v).slice(0, 40));
const fail = (status, error) => Object.assign(new Error(error), { userError: { status, body: { error } } });

/** The open shift of whoever takes the money, so job cash counts in their drawer. */
const openShiftOf = (storeId, userId) => (userId
  ? db.prepare(`SELECT id FROM shifts WHERE store_id = ? AND opened_by = ? AND status = 'open' LIMIT 1`).get(storeId, userId)?.id || null
  : null);

function recordPayment(job, storeId, amount, method, kind, userId) {
  db.prepare('INSERT INTO job_payments (id, job_id, amount, method, kind, recorded_by, shift_id) VALUES (?,?,?,?,?,?,?)')
    .run(crypto.randomUUID(), job.id, amount, method, kind, userId, openShiftOf(storeId, userId));
}

function jobRow(id, storeId) {
  const j = db.prepare(
    'SELECT j.*, u.name AS assigned_to_name FROM job_orders j LEFT JOIN users u ON u.id = j.assigned_to WHERE j.id = ? AND j.store_id = ?'
  ).get(id, storeId);
  if (!j) return null;
  return {
    ...j, items: parse(j.items, []), measurements: parse(j.measurements, {}),
    payments: db.prepare('SELECT amount, method, kind, created_at FROM job_payments WHERE job_id = ? ORDER BY created_at').all(id),
    materials: db.prepare('SELECT pr.name, pr.unit, m.quantity FROM job_materials m JOIN products pr ON pr.id = m.product_id WHERE m.job_id = ?').all(id),
  };
}

// GET /api/stores/:storeId/jobs?status=open|all
function listJobs(req, res) {
  const open = req.query.status !== 'all';
  res.json(db.prepare(
    `SELECT j.id, j.ref, j.customer_name, j.customer_phone, j.title, j.total, j.paid, j.due_date, j.status, j.created_at, u.name AS assigned_to_name
     FROM job_orders j LEFT JOIN users u ON u.id = j.assigned_to
     WHERE j.store_id = ? ${open ? "AND j.status NOT IN ('collected','cancelled')" : ''}
     ORDER BY (j.status IN ('collected','cancelled')), j.due_date IS NULL, j.due_date, j.created_at DESC LIMIT 300`
  ).all(req.params.storeId));
}

// GET /api/stores/:storeId/jobs/:id
function getJob(req, res) {
  const job = jobRow(req.params.id, req.params.storeId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
}

// POST /api/stores/:storeId/jobs
function createJob(req, res) {
  const { storeId } = req.params;
  const b = req.body || {};
  const items = (Array.isArray(b.items) ? b.items : []).map((i) => ({
    description: String(i.description || '').trim().slice(0, 160), quantity: roundQty(i.quantity || 1), price: money(i.price),
  })).filter((i) => i.description && i.quantity > 0 && i.price >= 0);
  if (!String(b.title || '').trim()) return res.status(400).json({ error: 'Describe the job (e.g. 2 kaftans for Sallah)' });
  if (!items.length) return res.status(400).json({ error: 'Add at least one item with its price' });
  const total = money(items.reduce((s, i) => s + i.quantity * i.price, 0));
  const deposit = money(b.deposit);
  if (deposit < 0 || deposit > total) return res.status(400).json({ error: 'The deposit must be between 0 and the job total' });
  if (deposit > 0 && !METHODS.includes(b.method || 'cash')) return res.status(400).json({ error: 'Invalid payment method' });
  const measurements = cleanMeasurements(b.measurements);

  let customer = null;
  if (b.storeCustomerId) {
    customer = db.prepare('SELECT id, name, phone, measurements FROM store_customers WHERE id = ? AND store_id = ?').get(b.storeCustomerId, storeId);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    customer.measurements = parse(customer.measurements, {});
  } else if (!String(b.customerName || '').trim()) {
    return res.status(400).json({ error: "Enter the customer's name" });
  }
  const userId = req.user.sub || null;
  const id = b.id || crypto.randomUUID();
  try {
    db.transaction(() => {
      if (!customer && b.saveCustomer !== false) {
        const cid = crypto.randomUUID();
        db.prepare('INSERT INTO store_customers (id, store_id, name, phone, measurements) VALUES (?,?,?,?,?)')
          .run(cid, storeId, String(b.customerName).trim().slice(0, 120), b.customerPhone ? String(b.customerPhone).slice(0, 40) : null, JSON.stringify(measurements));
        customer = { id: cid, name: String(b.customerName).trim().slice(0, 120), phone: b.customerPhone ? String(b.customerPhone).slice(0, 40) : null, measurements };
      } else if (customer && b.saveMeasurements && Object.keys(measurements).length) {
        db.prepare('UPDATE store_customers SET measurements = ? WHERE id = ?').run(JSON.stringify({ ...customer.measurements, ...measurements }), customer.id);
      }
      let ref;
      for (let i = 0; i < 5 && !ref; i += 1) {
        const r = newRef();
        if (!db.prepare('SELECT 1 FROM job_orders WHERE store_id = ? AND ref = ?').get(storeId, r)) ref = r;
      }
      db.prepare(
        `INSERT INTO job_orders (id, store_id, ref, store_customer_id, customer_name, customer_phone, title, items, measurements, total, paid, due_date, notes, assigned_to, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(id, storeId, ref, customer?.id || null, customer?.name || String(b.customerName).trim().slice(0, 120),
        customer?.phone || (b.customerPhone ? String(b.customerPhone).slice(0, 40) : null), String(b.title).trim().slice(0, 200),
        JSON.stringify(items), JSON.stringify(Object.keys(measurements).length ? measurements : (customer?.measurements || {})), total, deposit,
        b.dueDate || null, b.notes ? String(b.notes).slice(0, 1000) : null, b.assignedTo || null, userId);
      if (deposit > 0) recordPayment({ id }, storeId, deposit, b.method || 'cash', 'deposit', userId);
    })();
    res.status(201).json(jobRow(id, storeId));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not create the job' });
  }
}

// PATCH /api/stores/:storeId/jobs/:id/status  { status }
function setStatus(req, res) {
  const { status } = req.body || {};
  if (!STATUSES.includes(status) || status === 'collected') return res.status(400).json({ error: 'Use Collect to hand the job over; other statuses: received, in_progress, fitting, ready, cancelled' });
  const r = db.prepare(`UPDATE job_orders SET status = ? WHERE id = ? AND store_id = ? AND status NOT IN ('collected','cancelled')`)
    .run(status, req.params.id, req.params.storeId);
  if (!r.changes) return res.status(400).json({ error: 'Job not found or already closed' });
  res.json(jobRow(req.params.id, req.params.storeId));
}

// POST /api/stores/:storeId/jobs/:id/payments  { amount, method }
function addPayment(req, res) {
  const { storeId, id } = req.params;
  const amount = money(req.body?.amount);
  const method = req.body?.method || 'cash';
  if (!(amount > 0) || !METHODS.includes(method)) return res.status(400).json({ error: 'Enter an amount and a payment method' });
  try {
    db.transaction(() => {
      const j = db.prepare('SELECT * FROM job_orders WHERE id = ? AND store_id = ?').get(id, storeId);
      if (!j || j.status === 'cancelled') throw fail(404, 'Job not found');
      if (Number(j.paid) + amount > Number(j.total) + 0.005) throw fail(400, `Only ${money(Number(j.total) - Number(j.paid))} is left to pay on this job`);
      recordPayment(j, storeId, amount, method, 'payment', req.user.sub || null);
      db.prepare('UPDATE job_orders SET paid = paid + ? WHERE id = ?').run(amount, j.id);
    })();
    res.status(201).json(jobRow(id, storeId));
  } catch (err) {
    if (err.userError) return res.status(err.userError.status).json(err.userError.body);
    console.error(err);
    res.status(500).json({ error: 'Could not record the payment' });
  }
}

// POST /api/stores/:storeId/jobs/:id/collect  { method? } — pays any balance and hands the job over
function collect(req, res) {
  const { storeId, id } = req.params;
  const method = req.body?.method || 'cash';
  if (!METHODS.includes(method)) return res.status(400).json({ error: 'Invalid payment method' });
  try {
    const balance = db.transaction(() => {
      const j = db.prepare('SELECT * FROM job_orders WHERE id = ? AND store_id = ?').get(id, storeId);
      if (!j || ['collected', 'cancelled'].includes(j.status)) throw fail(400, 'Job not found or already closed');
      const bal = money(Number(j.total) - Number(j.paid));
      if (bal > 0) recordPayment(j, storeId, bal, method, 'balance', req.user.sub || null);
      db.prepare(`UPDATE job_orders SET paid = total, status = 'collected', collected_at = ${NOW} WHERE id = ?`).run(j.id);
      return bal;
    })();
    res.json({ ...jobRow(id, storeId), balancePaid: balance });
  } catch (err) {
    if (err.userError) return res.status(err.userError.status).json(err.userError.body);
    console.error(err);
    res.status(500).json({ error: 'Could not complete collection' });
  }
}

// POST /api/stores/:storeId/jobs/:id/materials  { productId, quantity }
function addMaterial(req, res) {
  const { storeId, id } = req.params;
  const qty = roundQty(req.body?.quantity);
  if (!req.body?.productId || !(qty > 0)) return res.status(400).json({ error: 'Choose the material and how much was used' });
  try {
    db.transaction(() => {
      const j = db.prepare('SELECT id, ref FROM job_orders WHERE id = ? AND store_id = ?').get(id, storeId);
      if (!j) throw fail(404, 'Job not found');
      const r = consume(storeId, req.body.productId, qty, `Used on job ${j.ref}`, req.user.sub || null);
      if (r.error) throw fail(400, r.error);
      db.prepare('INSERT INTO job_materials (id, job_id, product_id, quantity, recorded_by) VALUES (?,?,?,?,?)')
        .run(crypto.randomUUID(), j.id, req.body.productId, qty, req.user.sub || null);
    })();
    res.status(201).json(jobRow(id, storeId));
  } catch (err) {
    if (err.userError) return res.status(err.userError.status).json(err.userError.body);
    console.error(err);
    res.status(500).json({ error: 'Could not record the material' });
  }
}

// PATCH /api/stores/:storeId/jobs/customers/:customerId/measurements  { measurements }
function saveMeasurements(req, res) {
  const m = cleanMeasurements(req.body?.measurements);
  const r = db.prepare('UPDATE store_customers SET measurements = ? WHERE id = ? AND store_id = ?').run(JSON.stringify(m), req.params.customerId, req.params.storeId);
  if (!r.changes) return res.status(404).json({ error: 'Customer not found' });
  const row = db.prepare('SELECT id, name, phone, measurements FROM store_customers WHERE id = ?').get(req.params.customerId);
  res.json({ ...row, measurements: parse(row.measurements, {}) });
}

// GET /api/stores/:storeId/jobs/customers?q=
function findCustomers(req, res) {
  const q = `%${String(req.query.q || '').trim().toLowerCase()}%`;
  const rows = db.prepare(
    `SELECT id, name, phone, measurements FROM store_customers
     WHERE store_id = ? AND archived_at IS NULL AND (lower(name) LIKE ? OR lower(COALESCE(phone,'')) LIKE ?) ORDER BY name LIMIT 20`
  ).all(req.params.storeId, q, q);
  res.json(rows.map((r) => ({ ...r, measurements: parse(r.measurements, {}) })));
}

module.exports = { listJobs, getJob, createJob, setStatus, addPayment, collect, addMaterial, saveMeasurements, findCustomers };
