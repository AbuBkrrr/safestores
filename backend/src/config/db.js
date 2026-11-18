const { Pool } = require('pg');
require('dotenv').config();

// Most hosted Postgres providers (Render, Railway, Supabase, Neon, RDS) require
// SSL and present a certificate that isn't in Node's default trust store.
// DATABASE_SSL=require opts into that; leave unset for local Postgres with no SSL.
const useSSL = process.env.DATABASE_SSL === 'require' || process.env.NODE_ENV === 'production';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
  max: parseInt(process.env.DB_POOL_MAX || '10', 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  // A lost idle-client connection shouldn't crash the whole process in
  // production — log it and let the pool recover/reconnect on next query.
  console.error('Unexpected error on idle PostgreSQL client', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
