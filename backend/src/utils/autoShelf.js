// When a store receives stock with "straight to the shelf" on (the default
// for Mini stores, where one person does everything), the received quantity
// is moved onto the shelf at once so it can be sold without a separate
// store-room-to-shelf step.
const { recomputeProductQuantities } = require('./stockMath');

async function shelfDirect(client, storeId) {
  const s = (await client.query('SELECT auto_shelf, store_tier FROM stores WHERE id = $1', [storeId])).rows[0];
  return s ? (s.auto_shelf ?? s.store_tier === 'mini') : false;
}

async function autoShelf(client, storeId, productId, qty, userId) {
  if (!(Number(qty) > 0) || !(await shelfDirect(client, storeId))) return false;
  await client.query(
    `INSERT INTO stock_movements (store_id, product_id, type, quantity, note, performed_by)
     VALUES ($1, $2, 'transfer_to_shelf', $3, 'Straight to the shelf on arrival', $4)`,
    [storeId, productId, qty, userId || null]
  );
  await recomputeProductQuantities(client, productId);
  return true;
}

module.exports = { shelfDirect, autoShelf };
