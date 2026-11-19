const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { signToken } = require('../utils/jwt');
const { generateInviteCode } = require('../utils/codes');

// ------------------------------------------------------------
// Auditor accounts (Super Admin side)
// ------------------------------------------------------------

// POST /api/auth/auditor/signup — public; lands as 'pending' until activated
async function auditorSignup(req, res) {
  const b = req.body || {};
  const { name, email, password } = b;
  if (!name || !email || !password) return res.status(400).json({ error: 'name, email, and password are required' });
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const files = req.files || {};
  if (!files.idDocument?.[0] || !files.certificate?.[0]) {
    return res.status(400).json({ error: 'Upload a government ID and your professional certificate' });
  }
  if (!b.phone || !b.idType || !b.idNumber) return res.status(400).json({ error: 'Phone, ID type and ID number are required' });
  const passwordHash = await bcrypt.hash(password, 10);
  const clip = (v, n) => (v == null || v === '' ? null : String(v).trim().slice(0, n));
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO auditors (name, email, password_hash, phone, company, address, id_type, id_number, professional_body, membership_number, years_experience)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, name, email, status`,
      [clip(name, 120), String(email).trim().toLowerCase(), passwordHash, clip(b.phone, 40), clip(b.company, 160), clip(b.address, 1000),
        clip(b.idType, 40), clip(b.idNumber, 60), clip(b.professionalBody, 120), clip(b.membershipNumber, 60),
        Number.isFinite(Number(b.yearsExperience)) && b.yearsExperience !== '' ? Math.max(0, Math.min(80, parseInt(b.yearsExperience, 10))) : null]
    );
    const docs = [['idDocument', 'id_document'], ['certificate', 'certificate'], ['businessReg', 'business_reg'], ['other', 'other']];
    for (const [field, type] of docs) {
      for (const f of files[field] || []) {
        await client.query(
          `INSERT INTO auditor_documents (auditor_id, doc_type, filename, mime_type, size_bytes, data) VALUES ($1,$2,$3,$4,$5,$6)`,
          [rows[0].id, type, String(f.originalname).slice(0, 200), f.mimetype, f.size, f.buffer]
        );
      }
    }
    await client.query('COMMIT');
    res.status(201).json({ message: 'Application received — we will review your documents and activate your account.', auditor: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'An auditor account with this email already exists' });
    console.error(err);
    res.status(500).json({ error: 'Signup failed' });
  } finally {
    client.release();
  }
}

// GET /api/super/auditors/:id — full KYC details + document list
async function getAuditorSuper(req, res) {
  const { rows } = await db.query(
    `SELECT id, name, email, status, phone, company, address, id_type, id_number, professional_body, membership_number,
            years_experience, review_note, reviewed_at, created_at FROM auditors WHERE id = $1`, [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Auditor not found' });
  const docs = await db.query(
    'SELECT id, doc_type, filename, mime_type, size_bytes, created_at FROM auditor_documents WHERE auditor_id = $1 ORDER BY created_at', [req.params.id]
  );
  res.json({ ...rows[0], documents: docs.rows });
}

// GET /api/super/auditors/:id/documents/:docId — streams the file (Super Admin only)
async function getAuditorDocumentSuper(req, res) {
  const { rows } = await db.query(
    'SELECT filename, mime_type, data FROM auditor_documents WHERE id = $1 AND auditor_id = $2', [req.params.docId, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Document not found' });
  res.set('Content-Type', rows[0].mime_type);
  res.set('Content-Disposition', `inline; filename="${rows[0].filename.replace(/[^\w.\- ]/g, '_')}"`);
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.send(rows[0].data);
}

// PATCH /api/super/auditors/:id/reject  { note }
async function rejectAuditor(req, res) {
  const note = String(req.body?.note || '').trim().slice(0, 500) || null;
  const { rows } = await db.query(
    `UPDATE auditors SET status = 'rejected', review_note = $1, reviewed_at = now() WHERE id = $2 AND status = 'pending' RETURNING id, name, email, status`,
    [note, req.params.id]
  );
  if (!rows[0]) return res.status(400).json({ error: 'Only a pending application can be rejected' });
  res.json(rows[0]);
}

// POST /api/auth/auditor/login
async function auditorLogin(req, res) {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const { rows } = await db.query('SELECT * FROM auditors WHERE email = $1', [email]);
  const auditor = rows[0];
  if (!auditor || !(await bcrypt.compare(password, auditor.password_hash))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  if (auditor.status !== 'active') {
    return res.status(403).json({ error: auditor.status === 'pending'
      ? 'Your application is still under review.'
      : auditor.status === 'rejected'
        ? `Your application was not approved${auditor.review_note ? `: ${auditor.review_note}` : '.'}`
        : `Your auditor account is ${auditor.status}. Contact the platform.` });
  }
  const token = signToken({ sub: auditor.id, role: 'auditor', storeId: null });
  res.json({ token, user: { id: auditor.id, name: auditor.name, email: auditor.email, role: 'auditor' } });
}

// GET /api/super/auditors
async function listAuditors(req, res) {
  const { rows } = await db.query(`SELECT a.id, a.name, a.email, a.status, a.company, a.phone, a.created_at, (SELECT COUNT(*)::int FROM auditor_documents d WHERE d.auditor_id = a.id) AS doc_count FROM auditors a ORDER BY (a.status = 'pending') DESC, a.created_at DESC`);
  res.json(rows);
}

// PATCH /api/super/auditors/:id/activate
async function activateAuditor(req, res) {
  const { id } = req.params;
  const { rows } = await db.query(
    `UPDATE auditors SET status = 'active', activated_by = $1, reviewed_at = now(), review_note = NULL WHERE id = $2 RETURNING id, name, email, status`,
    [req.user.sub, id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Auditor not found' });
  res.json(rows[0]);
}

// PATCH /api/super/auditors/:id/suspend
async function suspendAuditor(req, res) {
  const { id } = req.params;
  const { rows } = await db.query(
    `UPDATE auditors SET status = 'suspended' WHERE id = $1 RETURNING id, name, email, status`,
    [id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Auditor not found' });
  res.json(rows[0]);
}

// ------------------------------------------------------------
// Engagements (store admin requests, auditor accepts/invites)
// ------------------------------------------------------------

// POST /api/stores/:storeId/audit-engagements   { notes?, requestedByName? }
// Reachable via a real per-user JWT (web) or the store sync key (desktop
// proxy) — see the route registration's comment in routes/stores.js.
// Only the JWT path has a per-user identity to look up server-side; the
// sync-key path (req.user.sub === null) has no such thing, so it falls
// back to trusting the name the desktop app supplied.
async function requestEngagement(req, res) {
  const { storeId } = req.params;
  const { notes, requestedByName, scheduledFor } = req.body;
  // Web bookings must name a future date/time; the desktop sync path may omit it.
  const when = scheduledFor ? new Date(scheduledFor) : null;
  if (scheduledFor && Number.isNaN(when.getTime())) return res.status(400).json({ error: 'Invalid date/time' });
  if (req.user.sub && (!when || when < new Date())) return res.status(400).json({ error: 'Pick a future date and time for the audit' });

  let resolvedName = requestedByName || null;
  if (req.user.sub) {
    const { rows: userRows } = await db.query('SELECT name FROM users WHERE id = $1', [req.user.sub]);
    resolvedName = userRows[0]?.name || resolvedName;
  }

  const { rows } = await db.query(
    `INSERT INTO audit_engagements (store_id, notes, requested_by_name, scheduled_for) VALUES ($1,$2,$3,$4) RETURNING *`,
    [storeId, notes || null, resolvedName, when]
  );
  res.status(201).json(rows[0]);
}

// GET /api/stores/:storeId/audit-engagements
async function listStoreEngagements(req, res) {
  const { storeId } = req.params;
  const { rows } = await db.query(
    `SELECT ae.*, a.name AS auditor_name, a.email AS auditor_email
     FROM audit_engagements ae LEFT JOIN auditors a ON a.id = ae.auditor_id
     WHERE ae.store_id = $1 ORDER BY ae.requested_at DESC`,
    [storeId]
  );
  res.json(rows);
}

// GET /api/auditor/engagements?status=requested — open requests + this auditor's own
async function listAuditorEngagements(req, res) {
  const { status } = req.query;
  const params = [req.user.sub];
  let where = 'ae.auditor_id = $1'; // only bookings the Super Admin assigned to this auditor
  if (status) { params.push(status); where += ` AND ae.status = $${params.length}`; }
  const { rows } = await db.query(
    `SELECT ae.*, s.name AS store_name FROM audit_engagements ae
     JOIN stores s ON s.id = ae.store_id
     WHERE ${where} ORDER BY ae.requested_at DESC`,
    params
  );
  res.json(rows);
}

// PATCH /api/auditor/engagements/:id/accept
async function acceptEngagement(req, res) {
  const { id } = req.params;
  const { rows } = await db.query(
    `UPDATE audit_engagements SET status = 'accepted', accepted_at = now()
     WHERE auditor_id = $1 AND id = $2 AND status = 'requested' RETURNING *`,
    [req.user.sub, id]
  );
  if (!rows[0]) return res.status(400).json({ error: 'Engagement not found or already accepted' });
  res.json(rows[0]);
}

// PATCH /api/auditor/engagements/:id/decline — hands the booking back to the Super Admin
async function declineEngagement(req, res) {
  const { rows } = await db.query(
    `UPDATE audit_engagements SET auditor_id = NULL, assigned_at = NULL, assigned_by = NULL
     WHERE auditor_id = $1 AND id = $2 AND status = 'requested' RETURNING id`, [req.user.sub, req.params.id]
  );
  if (!rows[0]) return res.status(400).json({ error: 'Engagement not found or already accepted' });
  res.json({ message: 'Declined' });
}

// GET /api/super/audit-engagements — every store's bookings, unassigned first
async function listAllEngagementsSuper(req, res) {
  const { rows } = await db.query(
    `SELECT ae.*, s.name AS store_name, s.address AS store_address, s.city AS store_city, s.phone AS store_phone, a.name AS auditor_name
     FROM audit_engagements ae JOIN stores s ON s.id = ae.store_id LEFT JOIN auditors a ON a.id = ae.auditor_id
     ORDER BY (ae.status = 'requested' AND ae.auditor_id IS NULL) DESC, (ae.status IN ('completed','cancelled')), ae.scheduled_for NULLS LAST, ae.requested_at DESC
     LIMIT 300`
  );
  res.json(rows);
}

// PATCH /api/super/audit-engagements/:id/assign  { auditorId }
async function assignEngagementSuper(req, res) {
  const a = await db.query(`SELECT id FROM auditors WHERE id = $1 AND status = 'active'`, [req.body?.auditorId]);
  if (!a.rows[0]) return res.status(400).json({ error: 'Pick an active auditor' });
  const { rows } = await db.query(
    `UPDATE audit_engagements SET auditor_id = $1, status = 'requested', accepted_at = NULL, assigned_by = $2, assigned_at = now()
     WHERE id = $3 AND status IN ('requested','accepted') RETURNING *`, [a.rows[0].id, req.user.sub, req.params.id]
  );
  if (!rows[0]) return res.status(400).json({ error: 'Booking not found or already under way' });
  res.json(rows[0]);
}

// PATCH /api/super/audit-engagements/:id/cancel
async function cancelEngagementSuper(req, res) {
  const { rows } = await db.query(
    `UPDATE audit_engagements SET status = 'cancelled' WHERE id = $1 AND status IN ('requested','accepted') RETURNING id`, [req.params.id]
  );
  if (!rows[0]) return res.status(400).json({ error: 'Booking not found or already under way' });
  res.json({ message: 'Cancelled' });
}

// PATCH /api/auditor/engagements/:id/complete
async function completeEngagement(req, res) {
  const { id } = req.params;
  const { rows } = await db.query(
    `UPDATE audit_engagements SET status = 'completed', completed_at = now()
     WHERE id = $1 AND auditor_id = $2 RETURNING *`,
    [id, req.user.sub]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Engagement not found' });
  res.json(rows[0]);
}

// POST /api/auditor/engagements/:id/invites   { name, email }
// The auditor invites their own stock-takers, scoped to this engagement —
// they get a normal store-scoped user account (role: stock_taker) whose
// shelf-audit access is gated to while this engagement is active (see
// requireActiveEngagement in middleware/auth.js).
async function inviteStockTaker(req, res) {
  const { id } = req.params;
  const { name, email } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'name and email are required' });

  const engagement = (await db.query(
    `SELECT * FROM audit_engagements WHERE id = $1 AND auditor_id = $2 AND status IN ('accepted','in_progress')`,
    [id, req.user.sub]
  )).rows[0];
  if (!engagement) return res.status(404).json({ error: 'Engagement not found or not active for you' });

  const code = generateInviteCode();
  const { rows } = await db.query(
    `INSERT INTO invites (store_id, code, name, email, role, audit_engagement_id)
     VALUES ($1,$2,$3,$4,'stock_taker',$5) RETURNING *`,
    [engagement.store_id, code, name, email, id]
  );
  res.status(201).json(rows[0]);
}

module.exports = {
  getAuditorSuper, getAuditorDocumentSuper, rejectAuditor,
  declineEngagement, listAllEngagementsSuper, assignEngagementSuper, cancelEngagementSuper,
  auditorSignup, auditorLogin, listAuditors, activateAuditor, suspendAuditor,
  requestEngagement, listStoreEngagements, listAuditorEngagements,
  acceptEngagement, completeEngagement, inviteStockTaker,
};
