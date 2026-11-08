const { pool } = require('../../src/config/db');

// Reference/lookup tables seeded BY the migrations themselves (plan tiers,
// currency defaults, global payment settings). These are fixture data, not
// per-test data — truncating them would break every test that relies on a
// valid store_tier/plan existing, so they're intentionally excluded.
const REFERENCE_TABLES = new Set([
  'store_tiers',
  'subscription_plans',
  'currency_settings',
  'payment_settings',
  'schema_migrations',
]);

let allTables = null;

async function getTenantTables() {
  if (allTables) return allTables;
  const { rows } = await pool.query(`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  `);
  allTables = rows.map((r) => r.tablename).filter((t) => !REFERENCE_TABLES.has(t));
  return allTables;
}

/** Wipes every tenant/transactional table. Call in beforeEach for full test isolation. */
async function resetDb() {
  const tables = await getTenantTables();
  if (!tables.length) return;
  await pool.query(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
  await restoreMutableSingletons();
}

// payment_settings (and similar) live in REFERENCE_TABLES because they're
// seeded by migrations, not per-test fixtures — but unlike store_tiers/
// subscription_plans (truly static lookups no API ever writes to),
// payment_settings IS mutated by a real endpoint under test
// (billingController.updatePaymentSettings). Left alone, a test that
// updates it would permanently leak that change into every later test run
// against this DB. Restore it to its migration-seeded default each time.
async function restoreMutableSingletons() {
  await pool.query(`
    UPDATE payment_settings SET
      account_number = '8032540215',
      account_name = 'SAFE Stores',
      bank_or_provider = 'OPAY',
      methods = '["ussd","bank_transfer","cash","card"]',
      instructions = 'Pay via USSD, bank transfer, cash, or card to the OPAY account above, then click "I''ve Paid" and enter your payment reference.',
      gateway_provider = 'none',
      gateway_enabled = false
    WHERE id = 'default'
  `);
  await pool.query(`UPDATE currency_settings SET code = 'NGN', symbol = '₦' WHERE id = 'default'`);
}

async function closeDb() {
  await pool.end();
}

module.exports = { resetDb, closeDb };
