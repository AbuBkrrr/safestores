const bcrypt = require('bcryptjs');
const { pool } = require('../../src/config/db');
const { signToken } = require('../../src/utils/jwt');

let seq = 0;
function uniq(prefix) {
  seq += 1;
  return `${prefix}${Date.now()}${seq}`;
}

async function createStore(overrides = {}) {
  const {
    name = uniq('Test Store '),
    planId = 'premium',
    subscriptionStatus = 'active',
    locked = false,
  } = overrides;
  const { rows } = await pool.query(
    `INSERT INTO stores (name, plan_id, subscription_status, locked)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [name, planId, subscriptionStatus, locked]
  );
  return rows[0];
}

async function createUser(storeId, overrides = {}) {
  const {
    name = uniq('User '),
    email = `${uniq('user')}@example.com`,
    password = 'Password123!',
    role = 'admin',
    status = 'active',
  } = overrides;
  const passwordHash = await bcrypt.hash(password, 4); // low cost factor: tests only
  const { rows } = await pool.query(
    `INSERT INTO users (store_id, name, email, password_hash, role, status)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [storeId, name, email, passwordHash, role, status]
  );
  return { ...rows[0], plainPassword: password };
}

async function createSuperAdmin(overrides = {}) {
  const {
    name = uniq('Super '),
    email = `${uniq('super')}@example.com`,
    password = 'SuperPass123!',
  } = overrides;
  const passwordHash = await bcrypt.hash(password, 4);
  const { rows } = await pool.query(
    `INSERT INTO super_admins (name, email, password_hash) VALUES ($1, $2, $3) RETURNING *`,
    [name, email, passwordHash]
  );
  return { ...rows[0], plainPassword: password };
}

// NOTE: products.backroom_qty/shelf_qty are a derived cache — they get
// fully overwritten from a SUM over stock_movements every time ANY
// movement is recorded for the product (see src/utils/stockMath.js). So
// setting the columns directly here isn't enough on its own: we also
// backfill a matching movement history, or the very next arrival/transfer/
// sale in a test would recompute the cache from an empty history and wipe
// these starting values out.
async function createProduct(storeId, overrides = {}) {
  const {
    name = uniq('Product '),
    sku = uniq('SKU-'),
    costPrice = 10,
    priceMultiplier = 1.3,
    reorderLevel = 5,
    backroomQty = 20,
    shelfQty = 0,
  } = overrides;
  const { rows } = await pool.query(
    `INSERT INTO products (store_id, name, sku, cost_price, price_multiplier, reorder_level, backroom_qty, shelf_qty)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [storeId, name, sku, costPrice, priceMultiplier, reorderLevel, backroomQty, shelfQty]
  );
  const product = rows[0];

  // Seed a movement history equivalent to the requested starting quantities
  // so a later recompute (triggered by any other movement) preserves them.
  if (backroomQty + shelfQty > 0) {
    await pool.query(
      `INSERT INTO stock_movements (store_id, product_id, type, quantity, note)
       VALUES ($1, $2, 'arrival', $3, 'test fixture seed')`,
      [storeId, product.id, backroomQty + shelfQty]
    );
  }
  if (shelfQty > 0) {
    await pool.query(
      `INSERT INTO stock_movements (store_id, product_id, type, quantity, note)
       VALUES ($1, $2, 'transfer_to_shelf', $3, 'test fixture seed')`,
      [storeId, product.id, shelfQty]
    );
  }
  return product;
}

async function createAuditor(overrides = {}) {
  const {
    name = uniq('Auditor '),
    email = `${uniq('auditor')}@example.com`,
    password = 'AuditorPass123!',
    status = 'active',
  } = overrides;
  const passwordHash = await bcrypt.hash(password, 4);
  const { rows } = await pool.query(
    `INSERT INTO auditors (name, email, password_hash, status) VALUES ($1,$2,$3,$4) RETURNING *`,
    [name, email, passwordHash, status]
  );
  return { ...rows[0], plainPassword: password };
}

/** Builds an "Authorization: Bearer ..." header value for a given user row. */
function tokenFor(user) {
  return signToken({ sub: user.id, role: user.role, storeId: user.store_id || null });
}

function auditorToken(auditor) {
  return signToken({ sub: auditor.id, role: 'auditor', storeId: null });
}

function superToken(superAdmin) {
  return signToken({ sub: superAdmin.id, role: 'super_admin', storeId: null });
}

/** Convenience: spins up one active store + one admin user + a bearer token. */
async function createActiveStoreWithAdmin(storeOverrides = {}, userOverrides = {}) {
  const store = await createStore({ subscriptionStatus: 'active', ...storeOverrides });
  const admin = await createUser(store.id, { role: 'admin', ...userOverrides });
  return { store, admin, token: tokenFor(admin) };
}

module.exports = {
  createStore,
  createUser,
  createSuperAdmin,
  createProduct,
  createAuditor,
  tokenFor,
  superToken,
  auditorToken,
  createActiveStoreWithAdmin,
  uniq,
};
