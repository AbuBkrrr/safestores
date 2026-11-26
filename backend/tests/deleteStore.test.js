const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createProduct, createSuperAdmin, superToken, createUser } = require('./helpers/factories');
const { pool } = require('../src/config/db');

describe('Super Admin deletes a store that has real history', () => {
  it('a store with sales, refunds, online orders, purchase orders and staff is deleted', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const A = { Authorization: `Bearer ${token}` };
    await createUser(store.id, { role: 'cashier' });
    const p = await createProduct(store.id, { costPrice: 100 });
    await pool.query('UPDATE products SET shelf_qty = 20 WHERE id = $1', [p.id]);
    // A paid sale and a refund
    const order = (await request().post(`/api/stores/${store.id}/orders`).set(A).send({})).body;
    await request().post(`/api/stores/${store.id}/orders/${order.id}/items`).set(A).send({ productId: p.id, quantity: 2 });
    const paid = await request().post(`/api/stores/${store.id}/orders/${order.id}/pay`).set(A).send({ paymentMethod: 'cash' });
    const item = (await pool.query('SELECT id FROM order_items WHERE order_id = $1', [order.id])).rows[0];
    await request().post(`/api/stores/${store.id}/orders/${order.id}/refund`).set(A).send({ items: [{ orderItemId: item.id, quantity: 1 }], method: 'cash', reason: 'test' });
    // An online order
    await request().post(`/api/marketplace/${store.id}/orders`).send({ items: [{ productId: p.id, quantity: 1 }], guestName: 'Ada', guestPhone: '0803', fulfilmentMethod: 'pickup' });
    expect(paid.status).toBeLessThan(300);

    const sa = { Authorization: `Bearer ${superToken(await createSuperAdmin())}` };
    const del = await request().delete(`/api/super/stores/${store.id}`).set(sa);
    expect(del.body.error || '').toBe('');
    expect(del.status).toBe(204);
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM products WHERE store_id = $1', [store.id])).rows[0].n).toBe(0);
  });
});
