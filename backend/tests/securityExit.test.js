const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createProduct, createUser, tokenFor } = require('./helpers/factories');

async function paidSale(store, cashierToken, product) {
  const C = `Bearer ${cashierToken}`;
  const order = await request().post(`/api/stores/${store.id}/orders`).set('Authorization', C).send({});
  await request().post(`/api/stores/${store.id}/orders/${order.body.id}/items`).set('Authorization', C).send({ productId: product.id, quantity: 2 });
  const paid = await request().post(`/api/stores/${store.id}/orders/${order.body.id}/pay`).set('Authorization', C).send({ paymentMethod: 'cash' });
  return paid.body;
}

describe('Security post: exit check', () => {
  it('security scans a receipt (QR link or number), sees what was paid, marks it once; a reused or unpaid receipt is refused', async () => {
    const { store } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id, { backroomQty: 0, shelfQty: 10 });
    const cashier = await createUser(store.id, { role: 'cashier' });
    const guard = await createUser(store.id, { role: 'security' });
    const G = `Bearer ${tokenFor(guard)}`;
    const receipt = await paidSale(store, tokenFor(cashier), product);
    expect(receipt.public_token).toBeTruthy();

    // By the QR link…
    const byQr = await request().get(`/api/stores/${store.id}/exit-check`).query({ code: `https://app.example.com/r/${receipt.public_token}` }).set('Authorization', G);
    expect(byQr.status).toBe(200);
    expect(byQr.body).toMatchObject({ status: 'paid', receipt_number: receipt.receipt_number, exit_checked_at: null });
    expect(byQr.body.items[0]).toMatchObject({ quantity: 2 });
    // …or by the printed receipt number.
    expect((await request().get(`/api/stores/${store.id}/exit-check`).query({ code: receipt.receipt_number.toLowerCase() }).set('Authorization', G)).status).toBe(200);

    expect((await request().post(`/api/stores/${store.id}/exit-check/${receipt.id}`).set('Authorization', G)).status).toBe(200);
    const again = await request().post(`/api/stores/${store.id}/exit-check/${receipt.id}`).set('Authorization', G);
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already used/);

    // Unpaid order cannot pass.
    const C = `Bearer ${tokenFor(cashier)}`;
    const open = await request().post(`/api/stores/${store.id}/orders`).set('Authorization', C).send({});
    expect((await request().post(`/api/stores/${store.id}/exit-check/${open.body.id}`).set('Authorization', G)).status).toBe(400);
    // Unknown code.
    expect((await request().get(`/api/stores/${store.id}/exit-check`).query({ code: 'NOPE-123' }).set('Authorization', G)).status).toBe(404);
    // Cashier cannot use the exit check; security cannot use the till.
    expect((await request().get(`/api/stores/${store.id}/exit-check`).query({ code: receipt.receipt_number }).set('Authorization', C)).status).toBe(403);
    expect((await request().post(`/api/stores/${store.id}/orders`).set('Authorization', G).send({})).status).toBe(403);

    const dash = await request().get(`/api/stores/${store.id}/my-dashboard`).set('Authorization', G);
    expect(dash.body).toMatchObject({ role: 'security', checkedToday: 1 });
  });
});

describe('Role dashboards do not spill', () => {
  it('cashier sees only their own sales; store-wide stock value and analytics are admin/manager only', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id, { backroomQty: 0, shelfQty: 10 });
    const cashier = await createUser(store.id, { role: 'cashier' });
    const other = await createUser(store.id, { role: 'cashier' });
    await paidSale(store, tokenFor(cashier), product);
    await paidSale(store, tokenFor(other), product);

    const mine = await request().get(`/api/stores/${store.id}/my-dashboard`).set('Authorization', `Bearer ${tokenFor(cashier)}`);
    expect(mine.body.role).toBe('cashier');
    expect(mine.body.salesToday.count).toBe(1);
    expect(mine.body).not.toHaveProperty('totalStockValue');

    for (const role of ['cashier', 'checkout', 'staff', 'stock_taker', 'marketplace_manager', 'security']) {
      const u = await createUser(store.id, { role });
      const r = await request().get(`/api/stores/${store.id}/analytics/summary`).set('Authorization', `Bearer ${tokenFor(u)}`);
      expect([role, r.status]).toEqual([role, 403]);
    }
    expect((await request().get(`/api/stores/${store.id}/analytics/summary`).set('Authorization', `Bearer ${token}`)).status).toBe(200);
  });
});

describe('Security post: tally and returns', () => {
  it('a mismatch needs a note and alerts the managers', async () => {
    const { store } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id, { backroomQty: 0, shelfQty: 10 });
    const cashier = await createUser(store.id, { role: 'cashier' });
    const guard = await createUser(store.id, { role: 'security' });
    const G = `Bearer ${tokenFor(guard)}`;
    const receipt = await paidSale(store, tokenFor(cashier), product);
    expect((await request().post(`/api/stores/${store.id}/exit-check/${receipt.id}`).set('Authorization', G).send({ result: 'mismatch' })).status).toBe(400);
    const r = await request().post(`/api/stores/${store.id}/exit-check/${receipt.id}`).set('Authorization', G).send({ result: 'mismatch', note: '3 bottles going out, receipt shows 2' });
    expect(r.body.exit_status).toBe('mismatch');
    const { pool } = require('../src/config/db');
    const n = await pool.query(`SELECT message FROM store_notifications WHERE store_id = $1 AND type = 'exit_mismatch'`, [store.id]);
    expect(n.rows.length).toBe(2);
    expect(n.rows[0].message).toMatch(/3 bottles/);
  });

  it('with a security post, a refund needs security to confirm the goods came back first', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id, { backroomQty: 0, shelfQty: 10 });
    const cashier = await createUser(store.id, { role: 'cashier' });
    const guard = await createUser(store.id, { role: 'security' });
    const G = `Bearer ${tokenFor(guard)}`;
    const A = `Bearer ${token}`;
    const receipt = await paidSale(store, tokenFor(cashier), product);
    const look = await request().get(`/api/stores/${store.id}/exit-check`).query({ code: receipt.receipt_number }).set('Authorization', G);
    const lineId = look.body.items[0].id;

    const blocked = await request().post(`/api/stores/${store.id}/orders/${receipt.id}/refunds`).set('Authorization', A).send({ items: [{ orderItemId: lineId, quantity: 1 }] });
    expect(blocked.status).toBe(400);
    expect(blocked.body.code).toBe('SECURITY_RETURN_REQUIRED');

    expect((await request().post(`/api/stores/${store.id}/exit-check/${receipt.id}/returns`).set('Authorization', G).send({ items: [{ orderItemId: lineId, quantity: 3 }] })).status).toBe(400); // only 2 sold
    expect((await request().post(`/api/stores/${store.id}/exit-check/${receipt.id}/returns`).set('Authorization', G).send({ items: [{ orderItemId: lineId, quantity: 1 }] })).status).toBe(201);

    expect((await request().post(`/api/stores/${store.id}/orders/${receipt.id}/refunds`).set('Authorization', A).send({ items: [{ orderItemId: lineId, quantity: 1 }] })).status).toBe(201);
    // Only one came back, so a second unit can't be refunded yet.
    expect((await request().post(`/api/stores/${store.id}/orders/${receipt.id}/refunds`).set('Authorization', A).send({ items: [{ orderItemId: lineId, quantity: 1 }] })).body.code).toBe('SECURITY_RETURN_REQUIRED');
  });
});

