// Desktop twin of backend/src/utils/autoShelf.js (straight to the shelf on arrival).
const crypto = require('crypto');
const { recomputeProductQuantities } = require('./stockMath');

function shelfDirect(db, storeId) {
  const s = db.prepare('SELECT auto_shelf, store_tier FROM stores WHERE id = ?').get(storeId);
  if (!s) return false;
  return s.auto_shelf === null || s.auto_shelf === undefined ? s.store_tier === 'mini' : !!s.auto_shelf;
}

function autoShelf(db, storeId, productId, qty, userId) {
  if (!(Number(qty) > 0) || !shelfDirect(db, storeId)) return false;
  db.prepare(`INSERT INTO stock_movements (id, store_id, product_id, type, quantity, note, performed_by)
    VALUES (?,?,?,'transfer_to_shelf',?, 'Straight to the shelf on arrival', ?)`).run(crypto.randomUUID(), storeId, productId, qty, userId || null);
  recomputeProductQuantities(db, productId);
  return true;
}

module.exports = { shelfDirect, autoShelf };
