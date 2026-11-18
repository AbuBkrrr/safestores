const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../../server/db');
const { signToken } = require('../../server/utils/jwt');

let seq = 0;
function uniq(prefix) {
  seq += 1;
  return `${prefix}${Date.now()}${seq}`;
}

function createStore(overrides = {}) {
  const {
    name = uniq('Test Store '),
    storeTier = 'mini',
    subscriptionStatus = 'active',
    locked = false,
  } = overrides;
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO stores (id, name, store_tier, subscription_status, locked, sync_key) VALUES (?,?,?,?,?,?)`
  ).run(id, name, storeTier, subscriptionStatus, locked ? 1 : 0, crypto.randomUUID());
  return db.prepare('SELECT * FROM stores WHERE id = ?').get(id);
}

function createUser(storeId, overrides = {}) {
  const {
    name = uniq('User '),
    email = `${uniq('user')}@example.com`,
    password = 'Password123!',
    role = 'admin',
    status = 'active',
  } = overrides;
  const id = crypto.randomUUID();
  const passwordHash = bcrypt.hashSync(password, 4); // low cost factor: tests only
  db.prepare(
    `INSERT INTO users (id, store_id, name, email, password_hash, role, status) VALUES (?,?,?,?,?,?,?)`
  ).run(id, storeId, name, email, passwordHash, role, status);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  return { ...user, plainPassword: password };
}

function createSuperAdmin(overrides = {}) {
  const {
    name = uniq('Super '),
    email = `${uniq('super')}@example.com`,
    password = 'SuperPass123!',
  } = overrides;
  const id = crypto.randomUUID();
  const passwordHash = bcrypt.hashSync(password, 4);
  db.prepare('INSERT INTO super_admins (id, name, email, password_hash) VALUES (?,?,?,?)').run(id, name, email, passwordHash);
  const admin = db.prepare('SELECT * FROM super_admins WHERE id = ?').get(id);
  return { ...admin, plainPassword: password };
}

// NOTE: products.backroom_qty/shelf_qty are a derived cache recomputed
// from stock_movements on every write (see server/utils/stockMath.js) —
// same as the cloud backend. Setting the columns directly here isn't
// enough on its own, so a matching movement history is backfilled, or the
// very next arrival/transfer/sale in a test would recompute the cache
// from an empty history and wipe these starting values out.
function createProduct(storeId, overrides = {}) {
  const {
    name = uniq('Product '),
    sku = uniq('SKU-'),
    costPrice = 10,
    priceMultiplier = 1.3,
    reorderLevel = 5,
    backroomQty = 20,
    shelfQty = 0,
  } = overrides;
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO products (id, store_id, name, sku, cost_price, price_multiplier, reorder_level, backroom_qty, shelf_qty)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(id, storeId, name, sku, costPrice, priceMultiplier, reorderLevel, backroomQty, shelfQty);

  if (backroomQty + shelfQty > 0) {
    db.prepare(
      `INSERT INTO stock_movements (id, store_id, product_id, type, quantity, note) VALUES (?,?,?,'arrival',?,'test fixture seed')`
    ).run(crypto.randomUUID(), storeId, id, backroomQty + shelfQty);
  }
  if (shelfQty > 0) {
    db.prepare(
      `INSERT INTO stock_movements (id, store_id, product_id, type, quantity, note) VALUES (?,?,?,'transfer_to_shelf',?,'test fixture seed')`
    ).run(crypto.randomUUID(), storeId, id, shelfQty);
  }
  return db.prepare('SELECT * FROM products WHERE id = ?').get(id);
}

function tokenFor(user) {
  return signToken({ sub: user.id, role: user.role, storeId: user.store_id || null });
}

function superToken(superAdmin) {
  return signToken({ sub: superAdmin.id, role: 'super_admin', storeId: null });
}

function createActiveStoreWithAdmin(storeOverrides = {}, userOverrides = {}) {
  const store = createStore({ subscriptionStatus: 'active', ...storeOverrides });
  const admin = createUser(store.id, { role: 'admin', ...userOverrides });
  return { store, admin, token: tokenFor(admin) };
}

module.exports = {
  createStore, createUser, createSuperAdmin, createProduct,
  tokenFor, superToken, createActiveStoreWithAdmin, uniq,
};
