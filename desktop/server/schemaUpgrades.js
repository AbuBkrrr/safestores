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
  // Last-write-wins merge of customer edits across devices (NULL = never edited; created_at applies).
  ensureColumn(db, 'store_customers', 'updated_at', 'TEXT');
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
  // Per-store access codes (Manage Stores → Connect). Backfill one for every store that has none.
  ensureColumn(db, 'access_codes', 'issued_for_store', 'TEXT REFERENCES stores(id) ON DELETE CASCADE');
  {
    const { generateAccessCode } = require('./utils/codes');
    const missing = db.prepare(`SELECT id, store_tier, subscription_status FROM stores s
      WHERE NOT EXISTS (SELECT 1 FROM access_codes a WHERE a.issued_for_store = s.id OR a.used_by_store = s.id)`).all();
    const ins = db.prepare(`INSERT INTO access_codes (id, code, intended_tier, status, used_by_store, issued_for_store, expires_at)
      VALUES (?,?,?,?,?,?,?)`);
    for (const s of missing) {
      const used = s.subscription_status !== 'pending';
      ins.run(require('crypto').randomUUID(), generateAccessCode(), s.store_tier, used ? 'used' : 'active',
        used ? s.id : null, s.id, new Date(Date.now() + 30 * 86400000).toISOString());
    }
  }

  applyShopFloorUpgrades(db);
}

const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";
const JOB_STATUSES = "'received', 'diagnosing', 'awaiting_approval', 'waiting_parts', 'in_progress', 'fitting', 'ready', 'collected', 'cancelled'";

// Mirrors cloud migrations 035–061 that the shop floor needs with no
// internet: exit check + returns, store room → shelf handovers, business
// types (weighing, shelf life, production, jobs), order cancel reasons.
// Quantity columns need no change: SQLite keeps 1.35 in an INTEGER column.
function applyShopFloorUpgrades(db) {
  // 063 — when the store's settings themselves last changed (for sync)
  ensureColumn(db, 'stores', 'settings_updated_at', 'TEXT');
  // 056 — a Mini store is the owner plus up to 2 helpers
  db.exec("UPDATE store_tiers SET max_users = 3 WHERE tier = 'mini' AND (max_users IS NULL OR max_users = 5)");
  // 035, 038, 041
  ensureColumn(db, 'stores', 'daily_summary_enabled', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'stores', 'last_summary_on', 'TEXT');
  ensureColumn(db, 'orders', 'cancel_reason', 'TEXT');
  ensureColumn(db, 'stores', 'shop_slug', 'TEXT');
  ensureColumn(db, 'stores', 'shop_tagline', 'TEXT');

  // 051, 052, 055 — receipt check at the exit, and goods customers bring back
  ensureColumn(db, 'orders', 'exit_checked_at', 'TEXT');
  ensureColumn(db, 'orders', 'exit_checked_by', 'TEXT');
  ensureColumn(db, 'orders', 'exit_status', 'TEXT');
  ensureColumn(db, 'orders', 'exit_note', 'TEXT');
  db.exec(`CREATE TABLE IF NOT EXISTS security_returns (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    order_item_id TEXT NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
    quantity REAL NOT NULL CHECK (quantity > 0),
    note TEXT,
    checked_by TEXT,
    received_by TEXT,
    received_at TEXT,
    qty_resellable REAL,
    qty_damaged REAL,
    receive_note TEXT,
    created_at TEXT NOT NULL DEFAULT ${NOW},
    updated_at TEXT NOT NULL DEFAULT ${NOW}
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_security_returns_item ON security_returns(order_item_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_security_returns_store ON security_returns(store_id, created_at)');

  // 053 — store room → shelf handovers
  db.exec(`CREATE TABLE IF NOT EXISTS stock_handovers (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'received', 'short', 'cancelled')),
    note TEXT,
    issued_by TEXT,
    issued_at TEXT NOT NULL DEFAULT ${NOW},
    received_by TEXT,
    received_at TEXT,
    receive_note TEXT,
    updated_at TEXT NOT NULL DEFAULT ${NOW}
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS stock_handover_items (
    id TEXT PRIMARY KEY,
    handover_id TEXT NOT NULL REFERENCES stock_handovers(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    qty_issued REAL NOT NULL CHECK (qty_issued > 0),
    qty_received REAL CHECK (qty_received >= 0)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_stock_handovers_store ON stock_handovers(store_id, status, issued_at)');

  // 058 — business types
  ensureColumn(db, 'stores', 'business_type', "TEXT NOT NULL DEFAULT 'general'");
  ensureColumn(db, 'products', 'sold_by', "TEXT NOT NULL DEFAULT 'unit'");
  ensureColumn(db, 'products', 'shelf_life_days', 'INTEGER');
  ensureColumn(db, 'store_customers', 'measurements', "TEXT NOT NULL DEFAULT '{}'");
  db.exec(`CREATE TABLE IF NOT EXISTS production_recipes (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'recipe' CHECK (kind IN ('recipe', 'breakdown')),
    notes TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT ${NOW},
    updated_at TEXT NOT NULL DEFAULT ${NOW}
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS production_recipe_lines (
    id TEXT PRIMARY KEY,
    recipe_id TEXT NOT NULL REFERENCES production_recipes(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('input', 'output')),
    quantity REAL NOT NULL CHECK (quantity > 0)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS production_runs (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    recipe_id TEXT REFERENCES production_recipes(id) ON DELETE SET NULL,
    kind TEXT NOT NULL,
    batches REAL NOT NULL DEFAULT 1,
    note TEXT,
    input_cost REAL NOT NULL DEFAULT 0,
    performed_by TEXT,
    created_at TEXT NOT NULL DEFAULT ${NOW}
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS production_run_lines (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES production_runs(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    expected_qty REAL NOT NULL DEFAULT 0,
    quantity REAL NOT NULL DEFAULT 0
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS job_orders (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    ref TEXT NOT NULL,
    store_customer_id TEXT REFERENCES store_customers(id) ON DELETE SET NULL,
    customer_name TEXT NOT NULL,
    customer_phone TEXT,
    title TEXT NOT NULL,
    items TEXT NOT NULL DEFAULT '[]',
    measurements TEXT NOT NULL DEFAULT '{}',
    total REAL NOT NULL DEFAULT 0,
    paid REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'received' CHECK (status IN (${JOB_STATUSES})),
    due_date TEXT,
    notes TEXT,
    assigned_to TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT ${NOW},
    updated_at TEXT NOT NULL DEFAULT ${NOW},
    collected_at TEXT,
    UNIQUE (store_id, ref)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_job_orders_store ON job_orders(store_id, status, due_date)');
  db.exec(`CREATE TABLE IF NOT EXISTS job_payments (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES job_orders(id) ON DELETE CASCADE,
    amount REAL NOT NULL CHECK (amount > 0),
    method TEXT NOT NULL DEFAULT 'cash',
    kind TEXT NOT NULL DEFAULT 'deposit' CHECK (kind IN ('deposit', 'balance', 'payment')),
    recorded_by TEXT,
    shift_id TEXT,
    created_at TEXT NOT NULL DEFAULT ${NOW}
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_job_payments_shift ON job_payments(shift_id)');
  db.exec(`CREATE TABLE IF NOT EXISTS job_materials (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES job_orders(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    quantity REAL NOT NULL CHECK (quantity > 0),
    recorded_by TEXT,
    created_at TEXT NOT NULL DEFAULT ${NOW}
  )`);

  // 064 — repair shops: the item left with the shop, its QR tag, and a notes log
  {
    // SQLite can't change a CHECK in place: rebuild job_orders once if it
    // still has the old status list, keeping every row.
    const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'job_orders'").get()?.sql || '';
    if (ddl && !ddl.includes('awaiting_approval')) {
      db.exec('PRAGMA foreign_keys = OFF');
      db.transaction(() => {
        db.exec('ALTER TABLE job_orders RENAME TO job_orders_old');
        db.exec(ddl.replace(/CREATE TABLE "?job_orders_old"?|CREATE TABLE "?job_orders"?/, 'CREATE TABLE job_orders')
          .replace(/CHECK \(status IN \([^)]*\)\)/, `CHECK (status IN (${JOB_STATUSES}))`));
        const cols = db.prepare('PRAGMA table_info(job_orders_old)').all().map((c) => c.name).join(', ');
        db.exec(`INSERT INTO job_orders (${cols}) SELECT ${cols} FROM job_orders_old`);
        db.exec('DROP TABLE job_orders_old');
        db.exec('CREATE INDEX IF NOT EXISTS idx_job_orders_store ON job_orders(store_id, status, due_date)');
      })();
      db.exec('PRAGMA foreign_keys = ON');
      db.exec('DROP TRIGGER IF EXISTS job_orders_touch');
    }
  }
  ensureColumn(db, 'job_orders', 'item_details', "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, 'job_orders', 'fault', 'TEXT');
  ensureColumn(db, 'job_orders', 'condition_notes', 'TEXT');
  ensureColumn(db, 'job_orders', 'accessories', 'TEXT');
  ensureColumn(db, 'job_orders', 'diagnosis', 'TEXT');
  ensureColumn(db, 'job_orders', 'tag_code', 'TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uniq_job_orders_tag ON job_orders(store_id, tag_code) WHERE tag_code IS NOT NULL');
  db.exec(`CREATE TABLE IF NOT EXISTS job_notes (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES job_orders(id) ON DELETE CASCADE,
    note TEXT NOT NULL,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT ${NOW}
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_job_notes_job ON job_notes(job_id, created_at)');

  // 062 — records that change after creation carry updated_at so devices
  // and the cloud can sync the change, latest wins. The trigger stamps it on
  // every update unless the update sets it itself (a sync import does).
  ensureColumn(db, 'orders', 'updated_at', 'TEXT');
  db.exec("UPDATE orders SET updated_at = COALESCE(cancelled_at, paid_at, created_at) WHERE updated_at IS NULL");
  for (const t of ['stock_handovers', 'security_returns', 'job_orders', 'production_recipes', 'orders', 'store_customers']) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${t}_touch AFTER UPDATE ON ${t} FOR EACH ROW
      WHEN NEW.updated_at IS OLD.updated_at
      BEGIN UPDATE ${t} SET updated_at = ${NOW} WHERE id = NEW.id; END`);
  }
}

module.exports = { applySchemaUpgrades, ensureColumn };
