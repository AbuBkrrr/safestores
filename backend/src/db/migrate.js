// Versioned migration runner.
//
// Every file in migrations/ named NNN_description.sql is a migration.
// Applied migrations are recorded in schema_migrations, so running this
// again after adding a new NNN_*.sql file only applies what's new —
// existing deployments never re-run old migrations or lose data. This is
// what lets the system evolve (new features, new tables) without
// interrupting a store that's already live on an older version.
//
// Usage: npm run migrate
const fs = require('fs');
const path = require('path');
const { pool } = require('../config/db');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function migrate() {
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);

    const applied = new Set(
      (await client.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version)
    );

    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort(); // NNN_ prefix makes lexicographic sort == numeric order

    let appliedCount = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      console.log(`Applying ${file} ...`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        appliedCount += 1;
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
    }

    if (appliedCount === 0) {
      console.log('✅ Already up to date — nothing to apply.');
    } else {
      console.log(`✅ Applied ${appliedCount} migration(s) successfully.`);
    }
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
