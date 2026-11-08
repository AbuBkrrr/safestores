// ------------------------------------------------------------
// v26+ schema additions for the desktop (SQLite) edition, kept in one
// place. Every statement is idempotent: tables use IF NOT EXISTS and
// columns go through ensureColumn (SQLite has no ADD COLUMN IF NOT
// EXISTS), so upgrading installs pick these up automatically on launch.
// Mirrors backend/migrations/031+ for the cloud edition.
// ------------------------------------------------------------

function ensureColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

function applySchemaUpgrades(db) {
  // 031 — account security & accountability
  ensureColumn(db, 'users', 'token_version', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'super_admins', 'token_version', 'INTEGER NOT NULL DEFAULT 0');
  db.exec(`CREATE TABLE IF NOT EXISTS activity_log (
    id TEXT PRIMARY KEY,
    store_id TEXT REFERENCES stores(id) ON DELETE CASCADE,
    actor_id TEXT, actor_role TEXT, actor_name TEXT,
    action TEXT NOT NULL, entity_type TEXT, entity_id TEXT,
    details TEXT NOT NULL DEFAULT '{}', ip TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_activity_store ON activity_log(store_id, created_at)');

  // 032 — till upgrades (per-store currency/time zone/tax, discounts,
  // split payments, refunds, shifts, parked sales, digital receipts)
  ensureColumn(db, 'stores', 'currency_code', 'TEXT');
  ensureColumn(db, 'stores', 'currency_symbol', 'TEXT');
  ensureColumn(db, 'stores', 'timezone', "TEXT NOT NULL DEFAULT 'Africa/Lagos'");
  ensureColumn(db, 'stores', 'tax_rate_pct', 'REAL NOT NULL DEFAULT 0');
  ensureColumn(db, 'stores', 'tax_inclusive', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'stores', 'tax_label', "TEXT NOT NULL DEFAULT 'VAT'");
  ensureColumn(db, 'stores', 'tax_number', 'TEXT');
  ensureColumn(db, 'stores', 'phone', 'TEXT');
  ensureColumn(db, 'stores', 'address', 'TEXT');
  ensureColumn(db, 'stores', 'city', 'TEXT');
  ensureColumn(db, 'stores', 'receipt_header', 'TEXT');
  ensureColumn(db, 'stores', 'receipt_footer', 'TEXT');
  ensureColumn(db, 'stores', 'max_cashier_discount_pct', 'REAL NOT NULL DEFAULT 10');
  ensureColumn(db, 'stores', 'require_shift', 'INTEGER NOT NULL DEFAULT 0');

  db.exec(`CREATE TABLE IF NOT EXISTS shifts (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    opened_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    opened_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    opening_float REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    closed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    closed_at TEXT, expected_cash REAL, counted_cash REAL, notes TEXT
  )`);
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS uniq_open_shift_per_user ON shifts(opened_by) WHERE status = 'open'");

  for (const [col, ddl] of [
    ['discount_type', 'TEXT'], ['discount_value', 'REAL NOT NULL DEFAULT 0'], ['discount_amount', 'REAL NOT NULL DEFAULT 0'],
    ['discount_reason', 'TEXT'], ['discount_approved_by', 'TEXT'], ['tax_rate_pct', 'REAL NOT NULL DEFAULT 0'],
    ['tax_inclusive', 'INTEGER NOT NULL DEFAULT 1'], ['tax_amount', 'REAL NOT NULL DEFAULT 0'], ['amount_tendered', 'REAL'],
    ['change_due', 'REAL NOT NULL DEFAULT 0'], ['refunded_total', 'REAL NOT NULL DEFAULT 0'], ['parked_label', 'TEXT'],
    ['shift_id', 'TEXT'], ['store_customer_id', 'TEXT'], ['public_token', 'TEXT'],
  ]) ensureColumn(db, 'orders', col, ddl);

  db.exec(`CREATE TABLE IF NOT EXISTS order_payments (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    method TEXT NOT NULL, amount REAL NOT NULL, reference TEXT, shift_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_order_payments_order ON order_payments(order_id)');
  db.exec(`CREATE TABLE IF NOT EXISTS refunds (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    amount REAL NOT NULL, method TEXT NOT NULL, reason TEXT, created_by TEXT, shift_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS refund_items (
    id TEXT PRIMARY KEY,
    refund_id TEXT NOT NULL REFERENCES refunds(id) ON DELETE CASCADE,
    order_item_id TEXT NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL REFERENCES products(id),
    quantity INTEGER NOT NULL, amount REAL NOT NULL, restocked INTEGER NOT NULL DEFAULT 1
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_refund_items_item ON refund_items(order_item_id)');

  // 033 — stock, customers (barcodes, packs, variants, loyalty points)
  ensureColumn(db, 'products', 'barcode', 'TEXT');
  ensureColumn(db, 'products', 'pack_size', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'products', 'pack_unit', 'TEXT');
  ensureColumn(db, 'products', 'variant_of', 'TEXT');
  ensureColumn(db, 'products', 'variant_label', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(store_id, barcode)');
  ensureColumn(db, 'store_customers', 'email', 'TEXT');
  ensureColumn(db, 'store_customers', 'birthday', 'TEXT');
  ensureColumn(db, 'stores', 'points_per_100', 'REAL NOT NULL DEFAULT 0');
  ensureColumn(db, 'stores', 'point_value', 'REAL NOT NULL DEFAULT 1');
  ensureColumn(db, 'stores', 'points_expiry_months', 'INTEGER NOT NULL DEFAULT 12');
  ensureColumn(db, 'orders', 'points_redeemed', 'INTEGER NOT NULL DEFAULT 0');
  db.exec(`CREATE TABLE IF NOT EXISTS loyalty_points (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    store_customer_id TEXT NOT NULL REFERENCES store_customers(id) ON DELETE CASCADE,
    points INTEGER NOT NULL, order_id TEXT, reason TEXT NOT NULL DEFAULT 'sale', expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_loyalty_points_customer ON loyalty_points(store_customer_id, created_at)');
}

module.exports = { applySchemaUpgrades, ensureColumn };
