const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createProduct, createUser, tokenFor, createAuditStockTaker } = require('./helpers/factories');
const { pool } = require('../src/config/db');

// Every feature works the same in mini, midi and mega stores; size only sets limits.
describe.each(['midi', 'mega'])('%s store: all features', (tier) => {
  it('roles, invoice to store room, handover, sale, exit check, returns, credit KYC, audits', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    await pool.query('UPDATE stores SET store_tier = $1, marketplace_enabled = true WHERE id = $2', [tier, store.id]);
    const A = `Bearer ${token}`;
    const T = async (role) => `Bearer ${tokenFor(await createUser(store.id, { role }))}`;

    // Every store role can be invited.
    for (const role of ['manager', 'cashier', 'checkout', 'staff', 'store_manager', 'shelf_manager', 'marketplace_manager', 'security']) {
      expect([role, (await request().post(`/api/stores/${store.id}/invites`).set('Authorization', A).send({ name: role, role })).status]).toEqual([role, 201]);
    }
    const SM = await T('store_manager'); const SH = await T('shelf_manager'); const C = await T('cashier'); const G = await T('security');

    // Scanned supplier invoice → store room, with expiry.
    const rec = (await pool.query(`INSERT INTO receipts (store_id, raw_ocr_text, parsed_items, status) VALUES ($1,'INV',$2,'pending') RETURNING id`,
      [store.id, JSON.stringify([{ name: `Milk ${tier}`, quantity: 10, price: 100 }])])).rows[0];
    expect((await request().post(`/api/stores/${store.id}/receipts/${rec.id}/apply`).set('Authorization', SM).send({ items: [{ expiryDate: '2027-01-31' }] })).status).toBe(200);
    const milk = (await pool.query('SELECT id, backroom_qty FROM products WHERE store_id = $1 AND name = $2', [store.id, `Milk ${tier}`])).rows[0];
    expect(milk.backroom_qty).toBe(10);

    // Handover store room → shelf, confirmed by the shelf manager.
    const h = await request().post(`/api/stores/${store.id}/handovers`).set('Authorization', SM).send({ items: [{ productId: milk.id, quantity: 6 }] });
    const item = (await request().get(`/api/stores/${store.id}/handovers`).set('Authorization', SH)).body[0].items[0];
    expect((await request().post(`/api/stores/${store.id}/handovers/${h.body.id}/receive`).set('Authorization', SH).send({ items: [{ itemId: item.id, qtyReceived: 6 }] })).body.status).toBe('received');

    // Sale at the till, exit check by security.
    const order = await request().post(`/api/stores/${store.id}/orders`).set('Authorization', C).send({});
    await request().post(`/api/stores/${store.id}/orders/${order.body.id}/items`).set('Authorization', C).send({ productId: milk.id, quantity: 2 });
    const paid = await request().post(`/api/stores/${store.id}/orders/${order.body.id}/pay`).set('Authorization', C).send({ paymentMethod: 'cash' });
    const look = await request().get(`/api/stores/${store.id}/exit-check`).query({ code: `https://x/r/${paid.body.public_token}` }).set('Authorization', G);
    expect(look.body.status).toBe('paid');
    expect((await request().post(`/api/stores/${store.id}/exit-check/${order.body.id}`).set('Authorization', G).send({ result: 'passed' })).status).toBe(200);

    // Return: security → refund → store manager receives into the store room.
    const lineId = look.body.items[0].id;
    await request().post(`/api/stores/${store.id}/exit-check/${order.body.id}/returns`).set('Authorization', G).send({ items: [{ orderItemId: lineId, quantity: 1 }] });
    expect((await request().post(`/api/stores/${store.id}/orders/${order.body.id}/refunds`).set('Authorization', A).send({ items: [{ orderItemId: lineId, quantity: 1 }] })).status).toBe(201);
    const ret = (await request().get(`/api/stores/${store.id}/returns`).set('Authorization', SM)).body[0];
    expect((await request().post(`/api/stores/${store.id}/returns/${ret.id}/receive`).set('Authorization', SM).send({ resellable: 1, damaged: 0 })).status).toBe(200);
    const p = (await pool.query('SELECT backroom_qty, shelf_qty FROM products WHERE id = $1', [milk.id])).rows[0];
    expect(p).toEqual({ backroom_qty: 5, shelf_qty: 4 });

    // Credit KYC gate.
    const g = await request().post(`/api/stores/${store.id}/credit/guarantors`).set('Authorization', A).send({ name: 'Coop', kind: 'cooperative' });
    const cu = await request().post(`/api/marketplace/${store.id}/signup`).send({ name: 'Ada', email: `ada-${tier}@c.com`, password: 'Password123!' });
    const app = await request().post(`/api/marketplace/${store.id}/credit/apply`).set('Authorization', `Bearer ${cu.body.token}`).send({ guarantorId: g.body.id, memberRef: 'M1', requestedLimit: 5000 });
    expect((await request().patch(`/api/stores/${store.id}/credit/accounts/${app.body.id}`).set('Authorization', A).send({ status: 'approved', creditLimit: 5000 })).body.code).toBe('KYC_INCOMPLETE');

    // Role dashboards and audits.
    expect((await request().get(`/api/stores/${store.id}/my-dashboard`).set('Authorization', C)).body.salesToday.count).toBe(1);
    expect((await request().get(`/api/stores/${store.id}/analytics/summary`).set('Authorization', C)).status).toBe(403);
    expect((await request().post(`/api/stores/${store.id}/audits`).set('Authorization', A).send({ productId: milk.id, countedQty: 4, area: 'shelf' })).status).toBe(403);
    const st = await createAuditStockTaker(store.id);
    expect((await request().post(`/api/stores/${store.id}/audits`).set('Authorization', `Bearer ${st.token}`).send({ productId: milk.id, countedQty: 4, area: 'shelf' })).status).toBe(201);
  });
});

describe('Mini store: the owner with up to 2 helpers', () => {
  it('only helper roles, at most 3 people, stock goes straight to the shelf, returns straight back', async () => {
    const { store, token } = await createActiveStoreWithAdmin(); // new stores are Mini
    const A = `Bearer ${token}`;
    for (const role of ['store_manager', 'shelf_manager', 'security', 'marketplace_manager', 'checkout']) {
      const r = await request().post(`/api/stores/${store.id}/invites`).set('Authorization', A).send({ name: role, role });
      expect([role, r.status, r.body.code]).toEqual([role, 400, 'TEAM_LIMIT']);
    }
    expect((await request().post(`/api/stores/${store.id}/invites`).set('Authorization', A).send({ name: 'Shop boy', role: 'staff' })).status).toBe(201);
    expect((await request().post(`/api/stores/${store.id}/invites`).set('Authorization', A).send({ name: 'Sister', role: 'cashier' })).status).toBe(201);
    const third = await request().post(`/api/stores/${store.id}/invites`).set('Authorization', A).send({ name: 'One more', role: 'cashier' });
    expect(third.status).toBe(400);
    expect(third.body.error).toMatch(/allows 3 people/);
    expect((await request().post(`/api/stores/${store.id}/invites/bulk`).set('Authorization', A).send({ names: 'X, Y', role: 'staff' })).status).toBe(400);

    // Owner scans an invoice: stock is sellable straight away.
    const rec = (await pool.query(`INSERT INTO receipts (store_id, raw_ocr_text, parsed_items, status) VALUES ($1,'INV',$2,'pending') RETURNING id`,
      [store.id, JSON.stringify([{ name: 'Indomie', quantity: 40, price: 250 }])])).rows[0];
    expect((await request().post(`/api/stores/${store.id}/receipts/${rec.id}/apply`).set('Authorization', A).send({ items: [{ expiryDate: '2027-02-28' }] })).status).toBe(200);
    const p = (await pool.query(`SELECT id, shelf_qty, backroom_qty FROM products WHERE store_id = $1 AND name = 'Indomie'`, [store.id])).rows[0];
    expect([p.shelf_qty, p.backroom_qty]).toEqual([40, 0]);

    // Owner sells and refunds: no security post, so the item goes straight back on the shelf.
    const order = await request().post(`/api/stores/${store.id}/orders`).set('Authorization', A).send({});
    const line = await request().post(`/api/stores/${store.id}/orders/${order.body.id}/items`).set('Authorization', A).send({ productId: p.id, quantity: 2 });
    await request().post(`/api/stores/${store.id}/orders/${order.body.id}/pay`).set('Authorization', A).send({ paymentMethod: 'cash' });
    expect((await request().post(`/api/stores/${store.id}/orders/${order.body.id}/refunds`).set('Authorization', A).send({ items: [{ orderItemId: line.body.item.id, quantity: 1 }] })).status).toBe(201);
    expect((await pool.query('SELECT shelf_qty FROM products WHERE id = $1', [p.id])).rows[0].shelf_qty).toBe(39);

    // Owner's dashboard knows it's a Mini store and shows today's takings.
    const d = await request().get(`/api/stores/${store.id}/my-dashboard`).set('Authorization', A);
    expect(d.body).toMatchObject({ storeTier: 'mini', storeSalesToday: { count: 1 } });
  });
});

