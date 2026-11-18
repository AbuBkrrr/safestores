const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createProduct, createUser, tokenFor } = require('./helpers/factories');
const { pool } = require('../src/config/db');

async function storeOfType(type) {
  const { store, token } = await createActiveStoreWithAdmin();
  const A = `Bearer ${token}`;
  const r = await request().patch(`/api/stores/${store.id}/settings`).set('Authorization', A).send({ businessType: type });
  expect(r.status).toBe(200);
  return { store, A };
}
const newProduct = (storeId, A, body) => request().post(`/api/stores/${storeId}/products`).set('Authorization', A).send(body);

describe('Business types', () => {
  it('settings expose the type and its tools; unknown types are refused', async () => {
    const { store, A } = await storeOfType('butchery');
    const s = await request().get(`/api/stores/${store.id}/settings`).set('Authorization', A);
    expect(s.body).toMatchObject({ business_type: 'butchery', tools: ['measure', 'fresh', 'breakdown'] });
    expect((await request().patch(`/api/stores/${store.id}/settings`).set('Authorization', A).send({ businessType: 'casino' })).status).toBe(400);
    const signup = await request().post('/api/auth/store/signup').send({ storeName: 'Mama Tailor', adminName: 'Ada', adminEmail: 'ada@tailor.ng', password: 'Password123!', businessType: 'tailor' });
    expect(signup.status).toBe(201);
    expect((await pool.query('SELECT business_type FROM stores WHERE id = $1', [signup.body.store.id])).rows[0].business_type).toBe('tailor');
  });

  it('butchery: sells 1.35 kg at the price per kg; whole-unit items stay whole; shelf life sets expiry', async () => {
    const { store, A } = await storeOfType('butchery');
    const beef = (await newProduct(store.id, A, { name: 'Beef (boneless)', sku: 'BEEF-1', unit: 'kg', soldBy: 'weight', costPrice: 4000, priceMultiplier: 1.25, shelfLifeDays: 3 })).body;
    const bags = (await newProduct(store.id, A, { name: 'Nylon bag', sku: 'BAG', costPrice: 20, priceMultiplier: 1.5 })).body;
    expect(beef.sold_by).toBe('weight');
    const arr = await request().post(`/api/stores/${store.id}/arrivals`).set('Authorization', A).send({ productId: beef.id, quantity: 25.5 });
    expect(arr.status).toBe(201);
    const exp = (await pool.query('SELECT expiry_date FROM batches WHERE product_id = $1', [beef.id])).rows[0].expiry_date;
    expect(Math.round((new Date(exp) - new Date(new Date().toISOString().slice(0, 10))) / 86400000)).toBe(3);
    await request().post(`/api/stores/${store.id}/arrivals`).set('Authorization', A).send({ productId: bags.id, quantity: 100 });
    expect((await request().post(`/api/stores/${store.id}/arrivals`).set('Authorization', A).send({ productId: bags.id, quantity: 2.5 })).status).toBe(400);
    await pool.query(`INSERT INTO stock_movements (store_id, product_id, type, quantity) VALUES ($1,$2,'transfer_to_shelf',25.5),($1,$3,'transfer_to_shelf',100)`, [store.id, beef.id, bags.id]);
    await pool.query('SELECT 1');
    const { recomputeProductQuantities } = require('../src/utils/stockMath');
    await recomputeProductQuantities(pool, beef.id); await recomputeProductQuantities(pool, bags.id);

    const order = await request().post(`/api/stores/${store.id}/orders`).set('Authorization', A).send({});
    const line = await request().post(`/api/stores/${store.id}/orders/${order.body.id}/items`).set('Authorization', A).send({ productId: beef.id, quantity: 1.35 });
    expect(line.status).toBe(201);
    expect(line.body.item.line_total).toBe(6750); // 1.35 kg × ₦5,000/kg
    expect((await request().post(`/api/stores/${store.id}/orders/${order.body.id}/items`).set('Authorization', A).send({ productId: bags.id, quantity: 1.5 })).body.error).toMatch(/whole units/);
    const p = (await pool.query('SELECT shelf_qty, sold_qty FROM products WHERE id = $1', [beef.id])).rows[0];
    expect(p).toEqual({ shelf_qty: 24.15, sold_qty: 1.35 });
  });

  it('ice-cream: a recipe uses the ingredients and makes the product, costing it from the inputs', async () => {
    const { store, A } = await storeOfType('ice_cream');
    const milk = await createProduct(store.id, { name: 'Milk', costPrice: 1000, backroomQty: 20 });
    const sugar = await createProduct(store.id, { name: 'Sugar', costPrice: 500, backroomQty: 10 });
    const cup = (await newProduct(store.id, A, { name: 'Vanilla cup', sku: 'VAN', costPrice: 0 })).body;
    const r = await request().post(`/api/stores/${store.id}/production/recipes`).set('Authorization', A).send({
      name: 'Vanilla batch', kind: 'recipe',
      lines: [{ productId: milk.id, role: 'input', quantity: 4 }, { productId: sugar.id, role: 'input', quantity: 1 }, { productId: cup.id, role: 'output', quantity: 30 }],
    });
    expect(r.status).toBe(201);
    const run = await request().post(`/api/stores/${store.id}/production/runs`).set('Authorization', A).send({ recipeId: r.body.id, batches: 2 });
    expect(run.status).toBe(201);
    expect(run.body.inputCost).toBe(9000); // (4×1000 + 1×500) × 2
    const q = async (id) => (await pool.query('SELECT backroom_qty, shelf_qty, cost_price FROM products WHERE id = $1', [id])).rows[0];
    expect((await q(milk.id)).backroom_qty).toBe(12);
    expect(await q(cup.id)).toEqual({ backroom_qty: 0, shelf_qty: 60, cost_price: 150 }); // no store-room flow → straight to shelf
    expect((await request().post(`/api/stores/${store.id}/production/runs`).set('Authorization', A).send({ recipeId: r.body.id, batches: 5 })).body.error).toMatch(/Not enough Milk/);
  });

  it('abattoir: breaking down one cow records actual cut weights and the yield', async () => {
    const { store, A } = await storeOfType('abattoir');
    const cow = await createProduct(store.id, { name: 'Live cow', costPrice: 600000, backroomQty: 3 });
    const beef = (await newProduct(store.id, A, { name: 'Beef', sku: 'B', unit: 'kg', soldBy: 'weight' })).body;
    const offal = (await newProduct(store.id, A, { name: 'Offal', sku: 'O', unit: 'kg', soldBy: 'weight' })).body;
    const r = await request().post(`/api/stores/${store.id}/production/recipes`).set('Authorization', A).send({
      name: 'Cow break-down', kind: 'breakdown',
      lines: [{ productId: cow.id, role: 'input', quantity: 1 }, { productId: beef.id, role: 'output', quantity: 180 }, { productId: offal.id, role: 'output', quantity: 20 }],
    });
    const run = await request().post(`/api/stores/${store.id}/production/runs`).set('Authorization', A).send({
      recipeId: r.body.id, batches: 1, outputs: [{ productId: beef.id, quantity: 171.4 }, { productId: offal.id, quantity: 18.6 }],
    });
    expect(run.status).toBe(201);
    expect(run.body.yieldPct).toBe(95); // 190 of 200 kg expected
    const b = (await pool.query('SELECT shelf_qty, cost_price FROM products WHERE id = $1', [beef.id])).rows[0];
    expect(b).toEqual({ shelf_qty: 171.4, cost_price: 3157.89 }); // ₦600,000 ÷ 190 kg
    expect((await pool.query('SELECT backroom_qty FROM products WHERE id = $1', [cow.id])).rows[0].backroom_qty).toBe(2);
    const runs = await request().get(`/api/stores/${store.id}/production/runs`).set('Authorization', A);
    expect(runs.body[0].lines.find((l) => l.name === 'Beef')).toMatchObject({ expected: 180, quantity: 171.4 });
  });

  it('tailor: job with measurements, deposit, fabric used by the yard, status, collection with balance', async () => {
    const { store, A } = await storeOfType('tailor');
    const fabric = (await newProduct(store.id, A, { name: 'Ankara fabric', sku: 'ANK', unit: 'yard', soldBy: 'length', costPrice: 1500 })).body;
    await request().post(`/api/stores/${store.id}/arrivals`).set('Authorization', A).send({ productId: fabric.id, quantity: 30 });
    const job = await request().post(`/api/stores/${store.id}/jobs`).set('Authorization', A).send({
      customerName: 'Bola Ade', customerPhone: '0803', title: '2 kaftans for Sallah', dueDate: '2026-12-20',
      items: [{ description: 'Kaftan (sewing)', quantity: 2, price: 15000 }], deposit: 10000, method: 'transfer',
      measurements: { Chest: '42', Length: '58', Sleeve: '25' },
    });
    expect(job.status).toBe(201);
    expect(job.body).toMatchObject({ total: 30000, paid: 10000, status: 'received' });
    expect(job.body.measurements).toEqual({ Chest: '42', Length: '58', Sleeve: '25' });
    const cust = await request().get(`/api/stores/${store.id}/jobs/customers`).query({ q: 'Bola' }).set('Authorization', A);
    expect(cust.body[0].measurements).toMatchObject({ Chest: '42' }); // saved for next time
    expect((await request().post(`/api/stores/${store.id}/jobs/${job.body.id}/materials`).set('Authorization', A).send({ productId: fabric.id, quantity: 6.5 })).status).toBe(201);
    expect((await pool.query('SELECT backroom_qty FROM products WHERE id = $1', [fabric.id])).rows[0].backroom_qty).toBe(23.5);
    expect((await request().patch(`/api/stores/${store.id}/jobs/${job.body.id}/status`).set('Authorization', A).send({ status: 'ready' })).body.status).toBe('ready');
    const c = await request().post(`/api/stores/${store.id}/jobs/${job.body.id}/collect`).set('Authorization', A).send({ method: 'cash' });
    expect(c.body).toMatchObject({ status: 'collected', paid: 30000, balancePaid: 20000 });
    expect(c.body.payments.map((p) => p.kind)).toEqual(['deposit', 'balance']);
    // A cashier at the front desk can take jobs too; a shelf manager can't.
    const cashier = await createUser(store.id, { role: 'cashier' });
    expect((await request().get(`/api/stores/${store.id}/jobs`).set('Authorization', `Bearer ${tokenFor(cashier)}`)).status).toBe(200);
  });

  it('fresh produce: spoiled stock is written off and shows in the waste log with its cost', async () => {
    const { store, A } = await storeOfType('fresh_produce');
    const tom = (await newProduct(store.id, A, { name: 'Tomatoes', sku: 'TOM', unit: 'kg', soldBy: 'weight', costPrice: 800, shelfLifeDays: 4 })).body;
    await pool.query(`INSERT INTO stock_movements (store_id, product_id, type, quantity) VALUES ($1,$2,'arrival',50),($1,$2,'transfer_to_shelf',50)`, [store.id, tom.id]);
    await require('../src/utils/stockMath').recomputeProductQuantities(pool, tom.id);
    expect((await request().post(`/api/stores/${store.id}/movements`).set('Authorization', A).send({ productId: tom.id, type: 'expiry', quantity: 3.5, note: 'Soft, end of day' })).status).toBe(201);
    const w = await request().get(`/api/stores/${store.id}/waste`).set('Authorization', A);
    expect(w.body.totalValue).toBe(2800);
    expect(w.body.items[0]).toMatchObject({ name: 'Tomatoes', quantity: 3.5 });
    expect(w.body.fresh.some((f) => f.name === 'Tomatoes')).toBe(true);
  });
});
