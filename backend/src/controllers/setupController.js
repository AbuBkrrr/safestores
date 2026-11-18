const bcrypt = require('bcryptjs');
const db = require('../config/db');

// GET /api/setup/status
// Self-locking bootstrap: only reports "needs setup" while zero Super
// Admins exist anywhere in the system. See desktop/server/controllers
// /setupController.js for the SQLite counterpart — same behavior.
async function status(req, res) {
  const { rows } = await db.query('SELECT COUNT(*) FROM super_admins');
  res.json({ needsSetup: Number(rows[0].count) === 0 });
}

// POST /api/setup/super-admin   { name, email, password }
// Only allowed once — if a Super Admin already exists, this refuses. This
// is the ONLY way a web deployment can ever get its first Super Admin
// account (there's no seed script for one), so it must stay reachable
// without auth.
async function createSuperAdmin(req, res) {
  const { rows: countRows } = await db.query('SELECT COUNT(*) FROM super_admins');
  if (Number(countRows[0].count) > 0) {
    return res.status(409).json({ error: 'Setup has already been completed' });
  }

  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'name, email, and password are required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const passwordHash = await bcrypt.hash(password, 10);
  await db.query('INSERT INTO super_admins (name, email, password_hash) VALUES ($1, $2, $3)', [name, email, passwordHash]);

  res.status(201).json({ message: 'Super Admin created. You can now log in.' });
}

module.exports = { status, createSuperAdmin };
