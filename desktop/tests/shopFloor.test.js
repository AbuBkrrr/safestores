// The shop-floor features that must keep working with no internet: store
// room → shelf handovers, the receipt check at the exit and returns, the
// refund rule for stores with a security post, weighed goods, production,
// tailoring/laundry jobs (and their cash in the till), and staff home screens.
const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createProduct, createUser, tokenFor } = require('./helpers/factories');
const db = require('../server/db');

const product = (id) => db.prepare('SELECT * FROM products WHERE id = ?').get(id);
const as = (storeId, user) => {
  const A = { Authorization: `Bearer ${typeof user === 'string' ? user : tokenFor(user)}` };
  const base = `/api/stores/${storeId}`;
  return {
    get: (p) => request().get(base + p).set(A),
    post: (p, b = {}) => request().post(base + p).set(A).send(b),
    patch: (p, b = {}) => request().patch(base + p).set(A).send(b),
  };
};
const megaStore = () => {
  const s = createActiveStoreWithAdmin();
  db.prepare("UPDATE stores SET store_tier = 'mega' WHERE id = ?").run(s.store.id);
  return s;
};

describe('Store room → shelf handovers (offline)', () => {
  it('moves stock only when the shelf manager confirms, flags a short delivery, and keeps sender and receiver apart', async () => {
    const { store } = megaStore();
    const sm = createUser(store.id, { role: 'store_manager' });
    const shelf = createUser(store.id, { role: 'shelf_manager' });
    const p = createProduct(store.id, { backroomQty: 10, shelfQty: 0 });

    const h = await as(store.id, sm).post('/handovers', { items: [{ productId: p.id, quantity: 6 }] });
    expect(h.status).toBe(201);
    expect((await as(store.id, sm).post('/handovers', { items: [{ productId: p.id, quantity: 5 }] })).body.error).toMatch(/Only 4 .* free/);
    expect(product(p.id)).toMatchObject({ backroom_qty: 10, shelf_qty: 0 }); // nothing moves until confirmed

    const list = await as(store.id, shelf).get('/handovers');
    const itemId = list.body[0].items[0].id;
    expect((await as(store.id, sm).post(`/handovers/${h.body.id}/receive`, { items: [{ itemId, qtyReceived: 6 }] })).status).toBe(403);
    const rcv = await as(store.id, shelf).post(`/handovers/${h.body.id}/receive`, { items: [{ itemId, qtyReceived: 5 }] });
    expect(rcv.body).toMatchObject({ status: 'short' });
    expect(product(p.id)).toMatchObject({ backroom_qty: 5, shelf_qty: 5 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM store_notifications WHERE store_id = ? AND type = 'handover_short'`).get(store.id).n).toBe(2);

    const dash = await as(store.id, shelf).get('/my-dashboard');
    expect(dash.body).toMatchObject({ role: 'shelf_manager', handoversWaiting: [] });
  });
});

describe('Exit check, returns and refunds (offline)', () => {
  it('security checks the receipt once; a refund needs the goods back at security first; the store manager takes them back in', async () => {
    const { store, token } = megaStore();
    const cashier = createUser(store.id, { role: 'cashier' });
    const guard = createUser(store.id, { role: 'security' });
    const sm = createUser(store.id, { role: 'store_manager' });
    const p = createProduct(store.id, { backroomQty: 0, shelfQty: 10, costPrice: 100, priceMultiplier: 1.5 });

    const order = await as(store.id, cashier).post('/orders');
    const line = await as(store.id, cashier).post(`/orders/${order.body.id}/items`, { productId: p.id, quantity: 2 });
    const paid = await as(store.id, cashier).post(`/orders/${order.body.id}/pay`, { paymentMethod: 'cash' });
    expect(paid.status).toBe(200);
    const o = db.prepare('SELECT public_token, receipt_number FROM orders WHERE id = ?').get(order.body.id);

    const look = await as(store.id, guard).get(`/exit-check?code=${encodeURIComponent(`https://shop/r/${o.public_token}`)}`);
    expect(look.body.items).toEqual([expect.objectContaining({ quantity: 2, refunded_qty: 0, returned_qty: 0 })]);
    expect((await as(store.id, guard).post(`/exit-check/${order.body.id}`, { result: 'passed' })).status).toBe(200);
    expect((await as(store.id, guard).post(`/exit-check/${order.body.id}`, { result: 'passed' })).status).toBe(409);
    expect((await as(store.id, cashier).get(`/exit-check?code=${o.receipt_number}`)).status).toBe(403);

    const refund = (q) => as(store.id, token).post(`/orders/${order.body.id}/refunds`, { items: [{ orderItemId: line.body.item.id, quantity: q }], method: 'cash' });
    expect((await refund(1)).body.code).toBe('SECURITY_RETURN_REQUIRED');
    expect((await as(store.id, guard).post(`/exit-check/${order.body.id}/returns`, { items: [{ orderItemId: line.body.item.id, quantity: 1 }] })).status).toBe(201);
    expect((await refund(1)).status).toBe(201);
    expect(product(p.id)).toMatchObject({ shelf_qty: 8, backroom_qty: 0 }); // held by security until received

    const ret = (await as(store.id, sm).get('/returns')).body[0];
    expect((await as(store.id, sm).post(`/returns/${ret.id}/receive`, { resellable: 1, damaged: 0 })).status).toBe(200);
    expect(product(p.id)).toMatchObject({ shelf_qty: 8, backroom_qty: 1 });
    expect((await as(store.id, guard).get('/my-dashboard')).body).toMatchObject({ role: 'security', checkedToday: 1 });
  });
});

describe('Business types (offline)', () => {
  it('sells and refunds weighed goods to the gram, and sets fresh-food expiry from shelf life', async () => {
    const { store, token } = createActiveStoreWithAdmin();
    const A = as(store.id, token);
    expect((await A.patch('/settings', { businessType: 'butchery' })).status).toBe(200);
    expect((await A.get('/settings')).body.tools).toEqual(expect.arrayContaining(['measure', 'fresh']));
    const beef = (await A.post('/products', { name: 'Beef', sku: 'BEEF', unit: 'kg', soldBy: 'weight', costPrice: 4000, priceMultiplier: 1.25, shelfLifeDays: 3 })).body;
    const bag = (await A.post('/products', { name: 'Bag', sku: 'BAG', costPrice: 20 })).body;
    expect((await A.post('/arrivals', { productId: beef.id, quantity: 25.5 })).status).toBe(201);
    expect(db.prepare('SELECT expiry_date FROM batches WHERE product_id = ?').get(beef.id).expiry_date)
      .toBe(new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10));
    expect((await A.post('/arrivals', { productId: bag.id, quantity: 2.5 })).body.error).toMatch(/whole units/);
    await A.post('/movements', { productId: beef.id, type: 'transfer_to_shelf', quantity: 25.5 });

    const order = await A.post('/orders');
    const line = await A.post(`/orders/${order.body.id}/items`, { productId: beef.id, quantity: 1.35 });
    expect(line.body.item.line_total).toBe(6750);
    await A.post(`/orders/${order.body.id}/pay`, { paymentMethod: 'cash' });
    const refund = (q) => A.post(`/orders/${order.body.id}/refunds`, { items: [{ orderItemId: line.body.item.id, quantity: q }], method: 'cash' });
    expect((await refund(0.5)).status).toBe(201);
    expect((await refund(0.85)).status).toBe(201);
    expect((await refund(0.01)).body.error).toMatch(/Only 0 of that item/);
  });

  it('breaks down an animal into cuts with the yield, costing each cut by what it sells for', async () => {
    const { store, token } = createActiveStoreWithAdmin();
    const A = as(store.id, token);
    const cow = createProduct(store.id, { name: 'Cow', costPrice: 600000, backroomQty: 1 });
    const beef = (await A.post('/products', { name: 'Beef', sku: 'B', unit: 'kg', soldBy: 'weight', costPrice: 3000, priceMultiplier: 1.5 })).body;
    const offal = (await A.post('/products', { name: 'Offal', sku: 'O', unit: 'kg', soldBy: 'weight', costPrice: 1000, priceMultiplier: 1.5 })).body;
    const r = await A.post('/production/recipes', { name: 'Cow', kind: 'breakdown', lines: [
      { productId: cow.id, role: 'input', quantity: 1 }, { productId: beef.id, role: 'output', quantity: 180 }, { productId: offal.id, role: 'output', quantity: 20 }] });
    const run = await A.post('/production/runs', { recipeId: r.body.id, outputs: [{ productId: beef.id, quantity: 171.4 }, { productId: offal.id, quantity: 18.6 }] });
    expect(run.status).toBe(201);
    expect(run.body.yieldPct).toBe(95);
    expect(product(cow.id).backroom_qty).toBe(0);
    const b = product(beef.id).cost_price, o = product(offal.id).cost_price;
    expect(b / o).toBeCloseTo(3, 2);
    expect(b * 171.4 + o * 18.6).toBeCloseTo(600000, -1);
    expect((await A.get('/production/runs')).body[0].lines).toHaveLength(3);
  });

  it('takes a tailoring job with a deposit and collects the balance; the cash counts in the till and the daily report', async () => {
    const { store, token } = createActiveStoreWithAdmin();
    const A = as(store.id, token);
    expect((await A.post('/shifts', { openingFloat: 1000 })).status).toBe(201);
    const job = await A.post('/jobs', {
      customerName: 'Bola Ade', customerPhone: '0803', title: 'Agbada', items: [{ description: 'Sewing', quantity: 1, price: 20000 }],
      deposit: 8000, method: 'cash', measurements: { Chest: '42' },
    });
    expect(job.status).toBe(201);
    expect(job.body).toMatchObject({ total: 20000, paid: 8000, measurements: { Chest: '42' } });
    expect((await A.get('/jobs/customers?q=bola')).body[0].measurements).toEqual({ Chest: '42' });
    await A.patch(`/jobs/${job.body.id}/status`, { status: 'ready' });
    const c = await A.post(`/jobs/${job.body.id}/collect`, { method: 'transfer' });
    expect(c.body).toMatchObject({ status: 'collected', balancePaid: 12000 });

    expect((await A.get('/shifts/current')).body.expected_cash_now).toBe(9000);
    const day = await A.get('/reports/daily');
    expect(day.body.jobPayments).toMatchObject({ total: 20000, count: 2 });
    expect(day.body.net).toBe(20000);
  });
});

describe('Online-only screens on the shop computer', () => {
  it('say clearly when the shop computer is not connected, and still check the role first', async () => {
    const { store, token } = createActiveStoreWithAdmin();
    const staff = createUser(store.id, { role: 'staff' });
    expect((await as(store.id, staff).get('/credit/accounts')).status).toBe(403);
    const res = await as(store.id, token).get('/credit/accounts');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CLOUD_NOT_CONNECTED');
  });
});
