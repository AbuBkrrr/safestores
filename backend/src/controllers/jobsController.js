const crypto = require('crypto');
const db = require('../config/db');
const { consume } = require('./productionController');
const { roundQty } = require('../utils/qty');

// Services & job orders (tailor, laundry, repairs): a job ticket with the
// customer's measurements, a deposit, a due date and a status, plus the
// materials used. The balance is paid when the customer collects.
const STATUSES = ['received', 'in_progress', 'fitting', 'ready', 'collected', 'cancelled'];
const METHODS = ['cash', 'card', 'transfer', 'other'];
const money = (v) => Math.round(Number(v || 0) * 100) / 100;
const newRef = () => `J${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
const cleanMeasurements = (m) => Object.fromEntries(Object.entries(m && typeof m === 'object' ? m : {})
  .map(([k, v]) => [String(k).trim().slice(0, 40), String(v ?? '').trim().slice(0, 40)]).filter(([k, v]) => k && v).slice(0, 40));

async function jobRow(id, storeId) {
  const { rows } = await db.query(
    `SELECT j.*, u.name AS assigned_to_name,
            COALESCE((SELECT json_agg(json_build_object('amount', p.amount, 'method', p.method, 'kind', p.kind, 'created_at', p.created_at) ORDER BY p.created_at)
                      FROM job_payments p WHERE p.job_id = j.id), '[]') AS payments,
            COALESCE((SELECT json_agg(json_build_object('name', pr.name, 'unit', pr.unit, 'quantity', m.quantity))
                      FROM job_materials m JOIN products pr ON pr.id = m.product_id WHERE m.job_id = j.id), '[]') AS materials
     FROM job_orders j LEFT JOIN users u ON u.id = j.assigned_to WHERE j.id = $1 AND j.store_id = $2`, [id, storeId]
  );
  return rows[0];
}

// GET /api/stores/:storeId/jobs?status=open|all
async function listJobs(req, res) {
  const open = req.query.status !== 'all';
  const { rows } = await db.query(
    `SELECT j.id, j.ref, j.customer_name, j.customer_phone, j.title, j.total, j.paid, j.due_date, j.status, j.created_at, u.name AS assigned_to_name
     FROM job_orders j LEFT JOIN users u ON u.id = j.assigned_to
     WHERE j.store_id = $1 ${open ? "AND j.status NOT IN ('collected','cancelled')" : ''}
     ORDER BY (j.status IN ('collected','cancelled')), j.due_date NULLS LAST, j.created_at DESC LIMIT 300`, [req.params.storeId]
  );
  res.json(rows);
}

// GET /api/stores/:storeId/jobs/:id
async function getJob(req, res) {
  const job = await jobRow(req.params.id, req.params.storeId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
}

// POST /api/stores/:storeId/jobs
// { storeCustomerId? | customerName + customerPhone, title, items: [{ description, quantity, price }], dueDate?,
//   deposit?, method?, measurements?, saveMeasurements?, notes?, assignedTo? }
async function createJob(req, res) {
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
    customer = (await db.query('SELECT id, name, phone, measurements FROM store_customers WHERE id = $1 AND store_id = $2', [b.storeCustomerId, storeId])).rows[0];
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
  } else if (!String(b.customerName || '').trim()) {
    return res.status(400).json({ error: "Enter the customer's name" });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    if (!customer && b.saveCustomer !== false) {
      customer = (await client.query(
        'INSERT INTO store_customers (store_id, name, phone, measurements) VALUES ($1,$2,$3,$4) RETURNING id, name, phone, measurements',
        [storeId, String(b.customerName).trim().slice(0, 120), b.customerPhone ? String(b.customerPhone).slice(0, 40) : null, JSON.stringify(measurements)]
      )).rows[0];
    } else if (customer && b.saveMeasurements && Object.keys(measurements).length) {
      await client.query('UPDATE store_customers SET measurements = measurements || $1::jsonb WHERE id = $2', [JSON.stringify(measurements), customer.id]);
    }
    let job;
    for (let attempt = 0; attempt < 5 && !job; attempt += 1) {
      try {
        job = (await client.query(
          `INSERT INTO job_orders (store_id, ref, store_customer_id, customer_name, customer_phone, title, items, measurements, total, paid, due_date, notes, assigned_to, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
          [storeId, newRef(), customer?.id || null, customer?.name || String(b.customerName).trim().slice(0, 120),
            customer?.phone || (b.customerPhone ? String(b.customerPhone).slice(0, 40) : null), String(b.title).trim().slice(0, 200),
            JSON.stringify(items), JSON.stringify(Object.keys(measurements).length ? measurements : (customer?.measurements || {})), total, deposit,
            b.dueDate || null, b.notes ? String(b.notes).slice(0, 1000) : null, b.assignedTo || null, req.user.sub || null]
        )).rows[0];
      } catch (e) { if (e.code !== '23505') throw e; } // ref clash: try another
    }
    if (deposit > 0) {
      await client.query(`INSERT INTO job_payments (job_id, amount, method, kind, recorded_by) VALUES ($1,$2,$3,'deposit',$4)`, [job.id, deposit, b.method || 'cash', req.user.sub || null]);
    }
    await client.query('COMMIT');
    res.status(201).json(await jobRow(job.id, storeId));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Could not create the job' });
  } finally {
    client.release();
  }
}

// PATCH /api/stores/:storeId/jobs/:id/status  { status }
async function setStatus(req, res) {
  const { status } = req.body || {};
  if (!STATUSES.includes(status) || status === 'collected') return res.status(400).json({ error: 'Use Collect to hand the job over; other statuses: received, in_progress, fitting, ready, cancelled' });
  const { rows } = await db.query(
    `UPDATE job_orders SET status = $1 WHERE id = $2 AND store_id = $3 AND status NOT IN ('collected','cancelled') RETURNING id`, [status, req.params.id, req.params.storeId]
  );
  if (!rows[0]) return res.status(400).json({ error: 'Job not found or already closed' });
  res.json(await jobRow(req.params.id, req.params.storeId));
}

// POST /api/stores/:storeId/jobs/:id/payments  { amount, method }
async function addPayment(req, res) {
  const amount = money(req.body?.amount);
  const method = req.body?.method || 'cash';
  if (!(amount > 0) || !METHODS.includes(method)) return res.status(400).json({ error: 'Enter an amount and a payment method' });
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const j = (await client.query('SELECT * FROM job_orders WHERE id = $1 AND store_id = $2 FOR UPDATE', [req.params.id, req.params.storeId])).rows[0];
    if (!j || ['cancelled'].includes(j.status)) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Job not found' }); }
    if (Number(j.paid) + amount > Number(j.total) + 0.005) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Only ${money(Number(j.total) - Number(j.paid))} is left to pay on this job` });
    }
    await client.query(`INSERT INTO job_payments (job_id, amount, method, kind, recorded_by) VALUES ($1,$2,$3,'payment',$4)`, [j.id, amount, method, req.user.sub || null]);
    await client.query('UPDATE job_orders SET paid = paid + $1 WHERE id = $2', [amount, j.id]);
    await client.query('COMMIT');
    res.status(201).json(await jobRow(j.id, req.params.storeId));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Could not record the payment' });
  } finally {
    client.release();
  }
}

// POST /api/stores/:storeId/jobs/:id/collect  { method? } — pays any balance and hands the job over
async function collect(req, res) {
  const method = req.body?.method || 'cash';
  if (!METHODS.includes(method)) return res.status(400).json({ error: 'Invalid payment method' });
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const j = (await client.query('SELECT * FROM job_orders WHERE id = $1 AND store_id = $2 FOR UPDATE', [req.params.id, req.params.storeId])).rows[0];
    if (!j || ['collected', 'cancelled'].includes(j.status)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Job not found or already closed' }); }
    const balance = money(Number(j.total) - Number(j.paid));
    if (balance > 0) {
      await client.query(`INSERT INTO job_payments (job_id, amount, method, kind, recorded_by) VALUES ($1,$2,$3,'balance',$4)`, [j.id, balance, method, req.user.sub || null]);
    }
    await client.query(`UPDATE job_orders SET paid = total, status = 'collected', collected_at = now() WHERE id = $1`, [j.id]);
    await client.query('COMMIT');
    res.json({ ...(await jobRow(j.id, req.params.storeId)), balancePaid: balance });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Could not complete collection' });
  } finally {
    client.release();
  }
}

// POST /api/stores/:storeId/jobs/:id/materials  { productId, quantity } — fabric, thread, detergent used on this job
async function addMaterial(req, res) {
  const qty = roundQty(req.body?.quantity);
  if (!req.body?.productId || !(qty > 0)) return res.status(400).json({ error: 'Choose the material and how much was used' });
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const j = (await client.query('SELECT id, ref FROM job_orders WHERE id = $1 AND store_id = $2', [req.params.id, req.params.storeId])).rows[0];
    if (!j) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Job not found' }); }
    const r = await consume(client, req.params.storeId, req.body.productId, qty, `Used on job ${j.ref}`, req.user.sub || null);
    if (r.error) { await client.query('ROLLBACK'); return res.status(400).json({ error: r.error }); }
    await client.query('INSERT INTO job_materials (job_id, product_id, quantity, recorded_by) VALUES ($1,$2,$3,$4)', [j.id, req.body.productId, qty, req.user.sub || null]);
    await client.query('COMMIT');
    res.status(201).json(await jobRow(j.id, req.params.storeId));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Could not record the material' });
  } finally {
    client.release();
  }
}

// PATCH /api/stores/:storeId/jobs/customers/:customerId/measurements  { measurements }
async function saveMeasurements(req, res) {
  const m = cleanMeasurements(req.body?.measurements);
  const { rows } = await db.query(
    'UPDATE store_customers SET measurements = $1 WHERE id = $2 AND store_id = $3 RETURNING id, name, phone, measurements',
    [JSON.stringify(m), req.params.customerId, req.params.storeId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Customer not found' });
  res.json(rows[0]);
}

// GET /api/stores/:storeId/jobs/customers?q= — customers with their saved measurements
async function findCustomers(req, res) {
  const q = `%${String(req.query.q || '').trim()}%`;
  const { rows } = await db.query(
    `SELECT id, name, phone, measurements FROM store_customers
     WHERE store_id = $1 AND archived_at IS NULL AND (name ILIKE $2 OR COALESCE(phone,'') ILIKE $2) ORDER BY name LIMIT 20`, [req.params.storeId, q]
  );
  res.json(rows);
}

module.exports = { listJobs, getJob, createJob, setStatus, addPayment, collect, addMaterial, saveMeasurements, findCustomers };
