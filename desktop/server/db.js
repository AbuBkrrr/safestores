const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { app } = require('electron');

// Store the actual data file in the OS-appropriate per-user app data folder
// (e.g. %APPDATA%/SAFE Stores on Windows, ~/Library/Application Support on Mac),
// NOT inside the installed app folder — that's the correct, permission-safe
// place for a desktop app's user data to live.
const userDataDir = app.getPath('userData');
if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });

const dbPath = path.join(userDataDir, 'safestores.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Apply schema (idempotent — every statement uses IF NOT EXISTS / OR IGNORE)
const schemaPath = path.join(__dirname, 'schema.sqlite.sql');
db.exec(fs.readFileSync(schemaPath, 'utf8'));

// SQLite's `ALTER TABLE ADD COLUMN` has no `IF NOT EXISTS` form, so a column
// added in a later app version (like `location`) can't just live in the
// CREATE TABLE IF NOT EXISTS above — that statement is a no-op once the
// table already exists on someone's machine from an older install. Guard
// each such addition explicitly so upgrading users get it automatically.
const productColumns = db.prepare('PRAGMA table_info(products)').all().map((c) => c.name);
if (!productColumns.includes('location')) {
  db.exec('ALTER TABLE products ADD COLUMN location TEXT');
}
const storeColumns = db.prepare('PRAGMA table_info(stores)').all().map((c) => c.name);
if (!storeColumns.includes('sync_key')) {
  db.exec('ALTER TABLE stores ADD COLUMN sync_key TEXT');
}
if (!storeColumns.includes('referral_contact')) {
  db.exec('ALTER TABLE stores ADD COLUMN referral_contact TEXT');
}
// Smart Replenishment columns — same upgrade-path reasoning as above.
if (!productColumns.includes('lead_time_days')) {
  db.exec('ALTER TABLE products ADD COLUMN lead_time_days INTEGER NOT NULL DEFAULT 7');
}
if (!productColumns.includes('min_order_qty')) {
  db.exec('ALTER TABLE products ADD COLUMN min_order_qty INTEGER NOT NULL DEFAULT 1');
}
if (!productColumns.includes('auto_reorder')) {
  db.exec('ALTER TABLE products ADD COLUMN auto_reorder INTEGER NOT NULL DEFAULT 0');
}
const arrivalColumns = db.prepare('PRAGMA table_info(stock_arrivals)').all().map((c) => c.name);
if (!arrivalColumns.includes('batch_number')) {
  db.exec('ALTER TABLE stock_arrivals ADD COLUMN batch_number TEXT');
}
// Supplier Performance Analytics upgrade path — suppliers table is a plain
// CREATE TABLE IF NOT EXISTS (safe to just run), but the columns on
// existing products/purchase_orders tables need the guarded-ALTER pattern.
db.exec(`CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name TEXT NOT NULL, contact_name TEXT, phone TEXT, email TEXT, notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (store_id, name)
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_suppliers_store ON suppliers(store_id)');
if (!productColumns.includes('supplier_id')) {
  db.exec('ALTER TABLE products ADD COLUMN supplier_id TEXT REFERENCES suppliers(id) ON DELETE SET NULL');
}
if (!productColumns.includes('archived_at')) {
  db.exec('ALTER TABLE products ADD COLUMN archived_at TEXT');
}
if (!productColumns.includes('brand')) {
  db.exec('ALTER TABLE products ADD COLUMN brand TEXT');
}
if (!productColumns.includes('image_url')) {
  db.exec('ALTER TABLE products ADD COLUMN image_url TEXT');
}
if (!productColumns.includes('storage_type')) {
  db.exec("ALTER TABLE products ADD COLUMN storage_type TEXT NOT NULL DEFAULT 'ambient' CHECK (storage_type IN ('ambient', 'refrigerated', 'frozen'))");
}
const poColumns = db.prepare('PRAGMA table_info(purchase_orders)').all().map((c) => c.name);
if (!poColumns.includes('supplier_id')) {
  db.exec('ALTER TABLE purchase_orders ADD COLUMN supplier_id TEXT REFERENCES suppliers(id) ON DELETE SET NULL');
}
if (!poColumns.includes('expected_at')) {
  db.exec('ALTER TABLE purchase_orders ADD COLUMN expected_at TEXT');
}
// Backfill: one supplier row per distinct free-text name already in use,
// then link existing products/purchase_orders to it. Safe to run every
// startup — INSERT OR IGNORE + the UNIQUE(store_id, name) constraint make
// it a no-op once already backfilled.
db.exec(`
  INSERT OR IGNORE INTO suppliers (id, store_id, name)
  SELECT lower(hex(randomblob(16))), store_id, supplier FROM products
  WHERE supplier IS NOT NULL AND trim(supplier) <> ''
`);
db.exec(`
  INSERT OR IGNORE INTO suppliers (id, store_id, name)
  SELECT lower(hex(randomblob(16))), store_id, supplier FROM purchase_orders
  WHERE supplier IS NOT NULL AND trim(supplier) <> ''
`);
db.exec(`
  UPDATE products SET supplier_id = (
    SELECT s.id FROM suppliers s WHERE s.store_id = products.store_id AND s.name = products.supplier
  ) WHERE supplier_id IS NULL AND supplier IS NOT NULL AND trim(supplier) <> ''
`);
db.exec(`
  UPDATE purchase_orders SET supplier_id = (
    SELECT s.id FROM suppliers s WHERE s.store_id = purchase_orders.store_id AND s.name = purchase_orders.supplier
  ) WHERE supplier_id IS NULL AND supplier IS NOT NULL AND trim(supplier) <> ''
`);
db.exec(`CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  url TEXT NOT NULL, secret TEXT NOT NULL, events TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1, last_triggered_at TEXT, last_status_code INTEGER,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_webhooks_store ON webhooks(store_id, active)');
db.exec(`CREATE TABLE IF NOT EXISTS webhook_ticket_markers (ticket_id TEXT PRIMARY KEY, last_reply_id TEXT)`);
const webhookColumns = db.prepare('PRAGMA table_info(webhooks)').all().map((c) => c.name);
if (!webhookColumns.includes('updated_at')) {
  db.exec(`ALTER TABLE webhooks ADD COLUMN updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);
}
if (!webhookColumns.includes('deleted_at')) {
  db.exec('ALTER TABLE webhooks ADD COLUMN deleted_at TEXT');
}
const receiptColumns = db.prepare('PRAGMA table_info(receipts)').all().map((c) => c.name);
if (!receiptColumns.includes('document_date')) {
  db.exec('ALTER TABLE receipts ADD COLUMN document_date TEXT');
}
// Backfill sync_key for any store that doesn't have one yet (upgrade path,
// or the column just having been added above).
const crypto = require('crypto');
for (const row of db.prepare('SELECT id FROM stores WHERE sync_key IS NULL').all()) {
  db.prepare('UPDATE stores SET sync_key = ? WHERE id = ?').run(crypto.randomUUID(), row.id);
}

// ------------------------------------------------------------------
// Store tier / billing migration (superseded the old fixed-price
// subscription_plans model). Guarded the same way as the columns above so
// an existing dev/test database upgrades in place instead of needing a
// manual reset.
// ------------------------------------------------------------------
if (!storeColumns.includes('store_tier')) {
  db.exec("ALTER TABLE stores ADD COLUMN store_tier TEXT NOT NULL DEFAULT 'mini' REFERENCES store_tiers(tier)");
}
if (!storeColumns.includes('billing_model')) {
  db.exec("ALTER TABLE stores ADD COLUMN billing_model TEXT NOT NULL DEFAULT 'daily_percentage'");
}
if (!storeColumns.includes('daily_rate_percent')) {
  db.exec('ALTER TABLE stores ADD COLUMN daily_rate_percent REAL NOT NULL DEFAULT 1.00');
}
if (!storeColumns.includes('grace_period_minutes')) {
  db.exec('ALTER TABLE stores ADD COLUMN grace_period_minutes INTEGER NOT NULL DEFAULT 5');
}
if (!storeColumns.includes('custom_billing_notes')) {
  db.exec('ALTER TABLE stores ADD COLUMN custom_billing_notes TEXT');
}
if (!storeColumns.includes('locked')) {
  db.exec('ALTER TABLE stores ADD COLUMN locked INTEGER NOT NULL DEFAULT 0');
}
// The old plan_id NOT NULL column (if present from a pre-tier-model install)
// blocks inserting new stores now that signup no longer supplies a plan_id.
// SQLite 3.35+ supports DROP COLUMN directly.
if (storeColumns.includes('plan_id')) {
  db.exec('ALTER TABLE stores DROP COLUMN plan_id');
}
const accessCodeColumns = db.prepare('PRAGMA table_info(access_codes)').all().map((c) => c.name);
if (!accessCodeColumns.includes('intended_tier')) {
  db.exec('ALTER TABLE access_codes ADD COLUMN intended_tier TEXT REFERENCES store_tiers(tier)');
}
if (accessCodeColumns.includes('plan_id')) {
  db.exec('ALTER TABLE access_codes DROP COLUMN plan_id');
}

const shelfAuditColumns = db.prepare('PRAGMA table_info(shelf_audits)').all().map((c) => c.name);
if (!shelfAuditColumns.includes('status')) {
  db.exec("ALTER TABLE shelf_audits ADD COLUMN status TEXT NOT NULL DEFAULT 'confirmed'");
}
if (!shelfAuditColumns.includes('conflict_group_id')) {
  db.exec('ALTER TABLE shelf_audits ADD COLUMN conflict_group_id TEXT');
}
if (!shelfAuditColumns.includes('resolved_by')) {
  db.exec('ALTER TABLE shelf_audits ADD COLUMN resolved_by TEXT REFERENCES users(id)');
}
if (!shelfAuditColumns.includes('resolved_at')) {
  db.exec('ALTER TABLE shelf_audits ADD COLUMN resolved_at TEXT');
}

// ------------------------------------------------------------------
// Location-based shelf/backroom/warehouse audit columns (comprehensive
// stock audit rework) — guarded the same way for in-place upgrades.
// ------------------------------------------------------------------
if (!shelfAuditColumns.includes('area')) {
  db.exec("ALTER TABLE shelf_audits ADD COLUMN area TEXT NOT NULL DEFAULT 'shelf'");
}
if (!shelfAuditColumns.includes('floor_number')) {
  db.exec('ALTER TABLE shelf_audits ADD COLUMN floor_number TEXT');
}
if (!shelfAuditColumns.includes('shelf_number')) {
  db.exec('ALTER TABLE shelf_audits ADD COLUMN shelf_number TEXT');
}
if (!shelfAuditColumns.includes('row_number')) {
  db.exec('ALTER TABLE shelf_audits ADD COLUMN row_number TEXT');
}
if (!shelfAuditColumns.includes('zone')) {
  db.exec('ALTER TABLE shelf_audits ADD COLUMN zone TEXT');
}

const stockArrivalColumns = db.prepare('PRAGMA table_info(stock_arrivals)').all().map((c) => c.name);
if (!stockArrivalColumns.includes('receipt_id')) {
  db.exec('ALTER TABLE stock_arrivals ADD COLUMN receipt_id TEXT REFERENCES receipts(id) ON DELETE SET NULL');
}

// Payment gateway placeholder — see this table's CREATE statement above
// for the full rationale. Unlike the marked_paid_by/waived_by fix
// elsewhere in this file, this one IS safe to add via a plain in-place
// ALTER for existing installs: both new columns are nullable/defaulted,
// not foreign keys, so there's no constraint-violation risk on existing
// rows the way there was for that fix.
const paymentSettingsColumns = db.prepare('PRAGMA table_info(payment_settings)').all().map((c) => c.name);
if (!paymentSettingsColumns.includes('gateway_provider')) {
  db.exec("ALTER TABLE payment_settings ADD COLUMN gateway_provider TEXT NOT NULL DEFAULT 'none' CHECK (gateway_provider IN ('none', 'paystack', 'flutterwave', 'stripe'))");
}
if (!paymentSettingsColumns.includes('gateway_enabled')) {
  db.exec('ALTER TABLE payment_settings ADD COLUMN gateway_enabled INTEGER NOT NULL DEFAULT 0');
}

module.exports = db;
module.exports.dbPath = dbPath;
module.exports.uploadsDir = path.join(userDataDir, 'uploads');
if (!fs.existsSync(module.exports.uploadsDir)) fs.mkdirSync(module.exports.uploadsDir, { recursive: true });
