const db = require('../../server/db');

// Same reasoning as the cloud backend's tests/helpers/db.js: store_tiers is
// a true static lookup (nothing ever writes to it via the API) so it's
// left alone entirely; payment_settings/currency_settings ARE mutated by
// real endpoints under test, so they get reset to their schema-seeded
// defaults rather than just left alone (or a test that updates one would
// leak that change into every later test in the same file).
const REFERENCE_TABLES = new Set(['store_tiers', 'sqlite_sequence']);

let allTables = null;
function getTenantTables() {
  if (allTables) return allTables;
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  allTables = rows.map((r) => r.name).filter((t) => !REFERENCE_TABLES.has(t));
  return allTables;
}

function resetDb() {
  const tables = getTenantTables();
  db.pragma('foreign_keys = OFF');
  const txn = db.transaction(() => {
    for (const t of tables) db.exec(`DELETE FROM "${t}"`);
  });
  txn();
  db.pragma('foreign_keys = ON');
  restoreMutableSingletons();
}

function restoreMutableSingletons() {
  db.prepare(
    `INSERT INTO payment_settings (id, account_number, account_name, bank_or_provider, methods, instructions)
     VALUES ('default', '8032540215', 'SAFE Stores', 'OPAY', '["ussd","bank_transfer","cash","card"]',
             'Pay via USSD, bank transfer, cash, or card to the OPAY account above, then click "I''ve Paid" and enter your payment reference.')`
  ).run();
  db.prepare(`INSERT INTO currency_settings (id, code, symbol) VALUES ('default', 'NGN', '₦')`).run();
}

module.exports = { resetDb };
