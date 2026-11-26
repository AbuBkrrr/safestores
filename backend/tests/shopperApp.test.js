const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createProduct } = require('./helpers/factories');
const { pool } = require('../src/config/db');

describe('Shopper app', () => {
  it('sale price everywhere, deals, cheapest store, ask a shop and get a reply', async () => {
    const a = await createActiveStoreWithAdmin();
    const b = await createActiveStoreWithAdmin();
    const name = `Golden Penny Spaghetti ${Date.now()}`;
    const pa = await createProduct(a.store.id, { name, costPrice: 800 }); // 1040 regular
    const pb = await createProduct(b.store.id, { name, costPrice: 700 }); // 910 regular
    const A = { Authorization: `Bearer ${a.token}` };

    // Store A puts it on sale below store B.
    const promo = await request().put(`/api/stores/${a.store.id}/products/${pa.id}/promo`).set(A).send({ promoPrice: 850, promoLabel: 'Weekend deal' });
    expect(promo.status).toBe(200);

    const d = await request().get('/api/marketplace/discover');
    const deal = d.body.deals.find((x) => x.id === pa.id);
    expect(deal).toMatchObject({ on_sale: true, promo_label: 'Weekend deal' });
    expect(Number(deal.price)).toBe(850);
    expect(Number(deal.regular_price)).toBe(1040);

    const c = await request().get('/api/marketplace/compare').query({ q: name });
    expect(c.body[0].stores).toBe(2);
    expect(c.body[0].cheapest.store_id).toBe(a.store.id); // the sale makes A cheapest

    // Till charges the sale price too.
    const order = (await request().post(`/api/stores/${a.store.id}/orders`).set(A).send({})).body;
    await pool.query('UPDATE products SET shelf_qty = 10 WHERE id = $1', [pa.id]);
    const item = await request().post(`/api/stores/${a.store.id}/orders/${order.id}/items`).set(A).send({ productId: pa.id, quantity: 1 });
    const line = (await pool.query('SELECT unit_price FROM order_items WHERE order_id = $1', [order.id])).rows[0];
    expect(Number(line.unit_price)).toBe(850);

    // Shopper asks; shop replies; shopper sees it.
    const q = await request().post(`/api/marketplace/${b.store.id}/inquiries`).send({ productId: pb.id, name: 'Aisha', phone: '0803', message: 'Do you have the 1kg pack?' });
    expect(q.status).toBe(201);
    const list = await request().get(`/api/stores/${b.store.id}/inquiries`).set('Authorization', `Bearer ${b.token}`);
    expect(list.body[0]).toMatchObject({ name: 'Aisha', product_name: name, status: 'open' });
    await request().post(`/api/stores/${b.store.id}/inquiries/${list.body[0].id}/reply`).set('Authorization', `Bearer ${b.token}`).send({ message: 'Yes, ₦1,900' });
    const thread = await request().get(`/api/marketplace/inquiries/${q.body.token}`);
    expect(thread.body.status).toBe('answered');
    expect(thread.body.messages.map((m) => m.from_store)).toEqual([false, true]);
    // A shop cannot read another shop's messages.
    expect((await request().get(`/api/stores/${b.store.id}/inquiries`).set(A)).status).toBe(403);
  });
});
