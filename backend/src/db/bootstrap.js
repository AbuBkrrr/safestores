const bcrypt = require('bcryptjs');
const db = require('../config/db');

// Creates the very first Super Admin from .env values, only if the
// super_admins table is currently empty. Safe to run on every startup.
async function bootstrapSuperAdmin() {
  const { rows } = await db.query('SELECT COUNT(*) FROM super_admins');
  if (Number(rows[0].count) > 0) return;

  const name = process.env.BOOTSTRAP_SUPER_ADMIN_NAME || 'Super Admin';
  const email = process.env.BOOTSTRAP_SUPER_ADMIN_EMAIL;
  const password = process.env.BOOTSTRAP_SUPER_ADMIN_PASSWORD;
  if (!email || !password) {
    console.warn('⚠️  No super admin exists yet and BOOTSTRAP_SUPER_ADMIN_EMAIL/PASSWORD are not set in .env — skipping bootstrap.');
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  await db.query(
    'INSERT INTO super_admins (name, email, password_hash) VALUES ($1, $2, $3)',
    [name, email, passwordHash]
  );
  console.log(`✅ Bootstrapped first Super Admin: ${email}`);
}

module.exports = { bootstrapSuperAdmin };
