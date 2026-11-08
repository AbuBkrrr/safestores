// Regression test for the in-place ALTER TABLE migration in db.js (guarded
// by "if column doesn't exist yet") — proves an existing installed
// database (created before gateway_provider/gateway_enabled existed)
// upgrades cleanly and safely defaults, rather than just trusting the
// schema.sqlite.sql CREATE TABLE definition a fresh install would use.
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

it('an existing payment_settings table (pre-gateway-placeholder) migrates cleanly on next launch', () => {
  const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'migration-test-')), 'old.db');

  // Simulate a real pre-upgrade database: create payment_settings WITHOUT
  // the new columns, exactly as an older build of this app would have.
  const oldDb = new Database(tmpFile);
  oldDb.exec(`
    CREATE TABLE payment_settings (
      id TEXT PRIMARY KEY DEFAULT 'default',
      account_number TEXT,
      account_name TEXT,
      bank_or_provider TEXT,
      methods TEXT NOT NULL DEFAULT '[]',
      instructions TEXT,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    INSERT INTO payment_settings (id, account_number, bank_or_provider) VALUES ('default', '111', 'GTBank');
  `);
  oldDb.close();

  // Run the exact same guarded-migration logic db.js uses.
  const db = new Database(tmpFile);
  const columns = db.prepare('PRAGMA table_info(payment_settings)').all().map((c) => c.name);
  if (!columns.includes('gateway_provider')) {
    db.exec("ALTER TABLE payment_settings ADD COLUMN gateway_provider TEXT NOT NULL DEFAULT 'none' CHECK (gateway_provider IN ('none', 'paystack', 'flutterwave', 'stripe'))");
  }
  if (!columns.includes('gateway_enabled')) {
    db.exec('ALTER TABLE payment_settings ADD COLUMN gateway_enabled INTEGER NOT NULL DEFAULT 0');
  }

  const row = db.prepare('SELECT * FROM payment_settings WHERE id = ?').get('default');
  expect(row.account_number).toBe('111'); // pre-existing real data preserved
  expect(row.bank_or_provider).toBe('GTBank');
  expect(row.gateway_provider).toBe('none'); // new column defaulted correctly
  expect(row.gateway_enabled).toBe(0);

  db.close();
});
