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


    const sd = await request().get(`/api/stores/${store.id}/my-dashboard`).set('Authorization', S);
    expect(sd.body.deliveriesToday).toMatchObject({ n: 1, units: 20 });
    const hd = await request().get(`/api/stores/${store.id}/my-dashboard`).set('Authorization', H);
    expect(hd.body.handoversWaiting).toEqual([]);
  });
});

describe('Supplier invoice scan and customer returns', () => {
  it('store manager applies a scanned supplier invoice into the store room', async () => {
    const { store } = await createActiveStoreWithAdmin();
    const sm = await createUser(store.id, { role: 'store_manager' });
    const S = `Bearer ${tokenFor(sm)}`;
    const { rows } = await pool.query(
      `INSERT INTO receipts (store_id, raw_ocr_text, parsed_items, status) VALUES ($1, 'INVOICE', $2, 'pending') RETURNING id`,
      [store.id, JSON.stringify([{ name: 'Golden Penny Semovita 1kg', quantity: 40, unitPrice: 1500 }])]
    );
    expect((await request().post(`/api/stores/${store.id}/receipts/${rows[0].id}/apply`).set('Authorization', S).send({})).body.code).toBe('EXPIRY_REQUIRED');
    const r = await request().post(`/api/stores/${store.id}/receipts/${rows[0].id}/apply`).set('Authorization', S).send({ items: [{ expiryDate: '2027-06-30', batchNumber: 'GP-118' }] });
    expect(r.status).toBe(200);
    const p = (await pool.query(`SELECT backroom_qty, shelf_qty FROM products WHERE store_id = $1 AND name ILIKE 'Golden Penny%'`, [store.id])).rows[0];
    expect(p).toEqual({ backroom_qty: 40, shelf_qty: 0 });
    const b = (await pool.query(`SELECT b.batch_number, to_char(b.expiry_date, 'YYYY-MM-DD') AS exp, b.quantity_received FROM batches b JOIN products p ON p.id = b.product_id WHERE p.store_id = $1`, [store.id])).rows;
    expect(b).toEqual([{ batch_number: 'GP-118', exp: '2027-06-30', quantity_received: 40 }]);
    // Cashiers can't apply invoices.
    const cashier = await createUser(store.id, { role: 'cashier' });
    expect((await request().post(`/api/stores/${store.id}/receipts`).set('Authorization', `Bearer ${tokenFor(cashier)}`)).status).toBe(403);
  });

  it('returned goods go security → store manager → store room as customer returns; damaged units are written off', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id, { backroomQty: 0, shelfQty: 10 });
    const cashier = await createUser(store.id, { role: 'cashier' });
    const guard = await createUser(store.id, { role: 'security' });
    const sm = await createUser(store.id, { role: 'store_manager' });
    const C = `Bearer ${tokenFor(cashier)}`; const G = `Bearer ${tokenFor(guard)}`; const S = `Bearer ${tokenFor(sm)}`;
    const order = await request().post(`/api/stores/${store.id}/orders`).set('Authorization', C).send({});
    await request().post(`/api/stores/${store.id}/orders/${order.body.id}/items`).set('Authorization', C).send({ productId: product.id, quantity: 3 });
    const paid = await request().post(`/api/stores/${store.id}/orders/${order.body.id}/pay`).set('Authorization', C).send({ paymentMethod: 'cash' });
    const look = await request().get(`/api/stores/${store.id}/exit-check`).query({ code: paid.body.receipt_number }).set('Authorization', G);
    const lineId = look.body.items[0].id;
    await request().post(`/api/stores/${store.id}/exit-check/${order.body.id}/returns`).set('Authorization', G).send({ items: [{ orderItemId: lineId, quantity: 2 }] });
    expect((await request().post(`/api/stores/${store.id}/orders/${order.body.id}/refunds`).set('Authorization', `Bearer ${token}`).send({ items: [{ orderItemId: lineId, quantity: 2 }] })).status).toBe(201);

    // Refund does not put the goods back on the shelf: security still holds them.
    let p = (await pool.query('SELECT shelf_qty, backroom_qty, sold_qty, damaged_qty FROM products WHERE id = $1', [product.id])).rows[0];
    expect(p).toEqual({ shelf_qty: 7, backroom_qty: 0, sold_qty: 1, damaged_qty: 0 });

    const list = await request().get(`/api/stores/${store.id}/returns`).set('Authorization', S);
    expect(list.body[0]).toMatchObject({ quantity: 2, received_at: null, receipt_number: paid.body.receipt_number });
    expect((await request().post(`/api/stores/${store.id}/returns/${list.body[0].id}/receive`).set('Authorization', S).send({ resellable: 2, damaged: 1 })).status).toBe(400);
    expect((await request().post(`/api/stores/${store.id}/returns/${list.body[0].id}/receive`).set('Authorization', S).send({ resellable: 1, damaged: 1, note: 'One seal broken' })).status).toBe(200);
    p = (await pool.query('SELECT shelf_qty, backroom_qty, damaged_qty FROM products WHERE id = $1', [product.id])).rows[0];
    expect(p).toEqual({ shelf_qty: 7, backroom_qty: 1, damaged_qty: 1 });
    const mv = await pool.query(`SELECT type, quantity FROM stock_movements WHERE product_id = $1 AND type IN ('customer_return','return_damaged') ORDER BY type`, [product.id]);
    expect(mv.rows).toEqual([{ type: 'customer_return', quantity: 1 }, { type: 'return_damaged', quantity: 1 }]); // not a supplier arrival
    // Already received.
    expect((await request().post(`/api/stores/${store.id}/returns/${list.body[0].id}/receive`).set('Authorization', S).send({ resellable: 1, damaged: 1 })).status).toBe(400);
  });
});

