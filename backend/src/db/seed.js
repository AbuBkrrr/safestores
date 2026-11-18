// Optional: creates one demo store (pre-activated, Mega tier), one admin
// user, and a few sample products (with real backing stock_movements rows,
// consistent with the event-sourced quantity model — see stockMath.js) so
// you can explore the UI immediately without going through the full
// signup+activation flow.
//
// Usage: npm run seed
const bcrypt = require('bcryptjs');
const { pool } = require('../config/db');
const { recomputeProductQuantities } = require('../utils/stockMath');

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const storeRes = await client.query(
      `INSERT INTO stores (name, subscription_status, store_tier, billing_model)
       VALUES ($1, 'active', 'mega', 'custom') RETURNING id`,
      ['Demo Supermarket']
    );
    const storeId = storeRes.rows[0].id;

    const passwordHash = await bcrypt.hash('Demo123!', 10);
    const adminRes = await client.query(
      `INSERT INTO users (store_id, name, email, password_hash, role) VALUES ($1,$2,$3,$4,'admin') RETURNING id`,
      [storeId, 'Demo Admin', 'admin@demo.com', passwordHash]
    );
    const adminId = adminRes.rows[0].id;

    const products = [
      ['Basmati Rice 5kg', 'SKU-RICE-5KG', 'Grains', 'Golden Fields Ltd', 'bag', 8.5, 1.4, 10, 40],
      ['Whole Milk 1L', 'SKU-MILK-1L', 'Dairy', 'Dairy Fresh Co', 'carton', 1.2, 1.5, 20, 60],
      ['Vegetable Oil 2L', 'SKU-OIL-2L', 'Cooking Essentials', 'Pure Oils Inc', 'bottle', 4.0, 1.35, 15, 25],
      ['White Bread', 'SKU-BREAD-W', 'Bakery', 'City Bakers', 'loaf', 0.8, 1.6, 10, 5],
    ];
    for (const [name, sku, category, supplier, unit, costPrice, priceMultiplier, reorderLevel, initialQty] of products) {
      const prodRes = await client.query(
        `INSERT INTO products (store_id, name, sku, category, supplier, unit, cost_price, price_multiplier, reorder_level)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [storeId, name, sku, category, supplier, unit, costPrice, priceMultiplier, reorderLevel]
      );
      const productId = prodRes.rows[0].id;
      if (initialQty > 0) {
        await client.query(
          `INSERT INTO stock_movements (store_id, product_id, type, quantity, note, performed_by)
           VALUES ($1,$2,'arrival',$3,'Seed data',$4)`,
          [storeId, productId, initialQty, adminId]
        );
        await recomputeProductQuantities(client, productId);
      }
    }

    await client.query('COMMIT');
    console.log('✅ Seed complete.');
    console.log(`   Store: Demo Supermarket (${storeId})`);
    console.log('   Admin login: admin@demo.com / Demo123!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Seed failed:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
