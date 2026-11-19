// The app queues shop-floor actions when the connection drops and sends them
// again later, possibly twice. With the app's own id, the second send is a no-op.
const crypto = require('crypto');
const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createProduct } = require('./helpers/factories');
const { pool } = require('../src/config/db');

describe('Replaying queued shop-floor actions', () => {
  it('a handover, a job and a production run sent twice are recorded once', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const A = { Authorization: `Bearer ${token}` };
    const post = (p, b) => request().post(`/api/stores/${store.id}${p}`).set(A).send(b);
    const p = await createProduct(store.id, { backroomQty: 10 });

    const hid = crypto.randomUUID();
    const h1 = await post('/handovers', { id: hid, items: [{ productId: p.id, quantity: 3 }] });
    const h2 = await post('/handovers', { id: hid, items: [{ productId: p.id, quantity: 3 }] });
    expect([h1.status, h2.status]).toEqual([201, 201]);
    expect(h2.body.id).toBe(hid);
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM stock_handovers WHERE store_id = $1', [store.id])).rows[0].n).toBe(1);

    const jid = crypto.randomUUID();
    const job = { id: jid, customerName: 'Ada', title: 'Hem', items: [{ description: 'Hem', quantity: 1, price: 2000 }], deposit: 1000, method: 'cash' };
    expect((await post('/jobs', job)).status).toBe(201);
    expect((await post('/jobs', job)).body.id).toBe(jid);
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM job_payments WHERE job_id = $1', [jid])).rows[0].n).toBe(1);

    const out = (await post('/products', { name: 'Loaf', sku: 'LOAF', costPrice: 0 })).body;
    const r = await post('/production/recipes', { name: 'Bread', lines: [{ productId: p.id, role: 'input', quantity: 1 }, { productId: out.id, role: 'output', quantity: 10 }] });
    const rid = crypto.randomUUID();
    expect((await post('/production/runs', { id: rid, recipeId: r.body.id })).status).toBe(201);
    expect((await post('/production/runs', { id: rid, recipeId: r.body.id })).body.alreadyRecorded).toBe(true);
    expect((await pool.query('SELECT backroom_qty + shelf_qty AS n FROM products WHERE id = $1', [out.id])).rows[0].n).toBe(10);
  });
});
