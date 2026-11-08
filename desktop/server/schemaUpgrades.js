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
}

module.exports = { applySchemaUpgrades, ensureColumn };
