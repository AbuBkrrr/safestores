const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');

// GET /api/setup/status
function status(req, res) {
  const count = db.prepare('SELECT COUNT(*) AS c FROM super_admins').get().c;
  res.json({ needsSetup: count === 0 });
}

// POST /api/setup/super-admin   { name, email, password }
// Only allowed once — if a super admin already exists, this refuses.
async function createSuperAdmin(req, res) {
  const count = db.prepare('SELECT COUNT(*) AS c FROM super_admins').get().c;
  if (count > 0) return res.status(409).json({ error: 'Setup has already been completed' });

  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'name, email, and password are required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const passwordHash = await bcrypt.hash(password, 10);
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO super_admins (id, name, email, password_hash) VALUES (?,?,?,?)').run(id, name, email, passwordHash);

  res.status(201).json({ message: 'Super Admin created. You can now log in.' });
}

module.exports = { status, createSuperAdmin };
