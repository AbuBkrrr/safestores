const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createProduct, createUser, tokenFor } = require('./helpers/factories');
const { pool } = require('../src/config/db');

describe('Store room → shelf chain of custody', () => {
  it('store manager receives supply, hands over; shelf manager confirms; stock moves only on confirmation; shortfall alerts managers', async () => {
    const { store } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id, { backroomQty: 0, shelfQty: 0 });
    const sm = await createUser(store.id, { role: 'store_manager' });
    const shm = await createUser(store.id, { role: 'shelf_manager' });
    const S = `Bearer ${tokenFor(sm)}`;
    const H = `Bearer ${tokenFor(shm)}`;

    // Supplier delivery into the store room.
    expect((await request().post(`/api/stores/${store.id}/arrivals`).set('Authorization', S).send({ productId: product.id, quantity: 20, invoiceNumber: 'INV-9' })).status).toBe(201);
    // Shelf manager cannot record deliveries or issue handovers.
    expect((await request().post(`/api/stores/${store.id}/arrivals`).set('Authorization', H).send({ productId: product.id, quantity: 1 })).status).toBe(403);
    expect((await request().post(`/api/stores/${store.id}/handovers`).set('Authorization', H).send({ items: [{ productId: product.id, quantity: 1 }] })).status).toBe(403);

    expect((await request().post(`/api/stores/${store.id}/handovers`).set('Authorization', S).send({ items: [{ productId: product.id, quantity: 25 }] })).status).toBe(400);
    const h = await request().post(`/api/stores/${store.id}/handovers`).set('Authorization', S).send({ items: [{ productId: product.id, quantity: 12 }], note: 'Morning restock' });
    expect(h.status).toBe(201);
    // Promised stock is reserved: only 8 left to hand over.
    expect((await request().post(`/api/stores/${store.id}/handovers`).set('Authorization', S).send({ items: [{ productId: product.id, quantity: 9 }] })).status).toBe(400);

    let p = (await pool.query('SELECT shelf_qty, backroom_qty FROM products WHERE id = $1', [product.id])).rows[0];
    expect(p).toEqual({ shelf_qty: 0, backroom_qty: 20 }); // nothing moved yet

    // Store manager can't confirm their own handover.
    const list = await request().get(`/api/stores/${store.id}/handovers`).set('Authorization', H);
    const itemId = list.body[0].items[0].id;
    expect((await request().post(`/api/stores/${store.id}/handovers/${h.body.id}/receive`).set('Authorization', S).send({ items: [{ itemId, qtyReceived: 12 }] })).status).toBe(403);

    const r = await request().post(`/api/stores/${store.id}/handovers/${h.body.id}/receive`).set('Authorization', H).send({ items: [{ itemId, qtyReceived: 10 }], note: '2 cartons missing' });
    expect(r.body).toMatchObject({ status: 'short' });
    p = (await pool.query('SELECT shelf_qty, backroom_qty FROM products WHERE id = $1', [product.id])).rows[0];
    expect(p).toEqual({ shelf_qty: 10, backroom_qty: 10 });
    const n = await pool.query(`SELECT message FROM store_notifications WHERE store_id = $1 AND type = 'handover_short'`, [store.id]);
    expect(n.rows.length).toBe(2);
    expect(n.rows[0].message).toMatch(/sent 12, received 10/);

    // Each confirms their own area with a count.
    expect((await request().post(`/api/stores/${store.id}/audits`).set('Authorization', S).send({ productId: product.id, countedQty: 10, area: 'backroom', zone: 'Bay A' })).status).toBe(201);
    expect((await request().post(`/api/stores/${store.id}/audits`).set('Authorization', H).send({ productId: product.id, countedQty: 10, area: 'shelf', shelfNumber: '3' })).status).toBe(201);

    const sd = await request().get(`/api/stores/${store.id}/my-dashboard`).set('Authorization', S);
    expect(sd.body.deliveriesToday).toMatchObject({ n: 1, units: 20 });
    const hd = await request().get(`/api/stores/${store.id}/my-dashboard`).set('Authorization', H);
    expect(hd.body.handoversWaiting).toEqual([]);
  });
});
