const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createProduct, createUser, tokenFor } = require('./helpers/factories');
const { pool } = require('../src/config/db');

const A = (token) => ({ Authorization: `Bearer ${token}` });

describe('Deleting products', () => {
  it('deletes unused products for good and archives ones with sales', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const unused = await createProduct(store.id, { sku: 'DEL-1' });
    const unused2 = await createProduct(store.id, { sku: 'DEL-2' });
    const sold = await createProduct(store.id, { sku: 'SOLD-1', shelfQty: 5 });
    const order = await request().post(`/api/stores/${store.id}/orders`).set(A(token)).send({});
    const line = await request().post(`/api/stores/${store.id}/orders/${order.body.id}/items`).set(A(token)).send({ productId: sold.id, quantity: 1 });
    expect(line.status).toBe(201);

    const other = await createActiveStoreWithAdmin();
    const foreign = await createProduct(other.store.id, { sku: 'NOT-MINE' });

    const r = await request().post(`/api/stores/${store.id}/products/delete`).set(A(token))
      .send({ productIds: [unused.id, unused2.id, sold.id, foreign.id] });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ deleted: 2, archived: 1, notFound: 1 });

    const { rows } = await pool.query('SELECT id, archived_at FROM products WHERE id = ANY($1::uuid[])', [[unused.id, unused2.id, sold.id, foreign.id]]);
    const byId = Object.fromEntries(rows.map((x) => [x.id, x]));
    expect(byId[unused.id]).toBeUndefined();
    expect(byId[sold.id].archived_at).not.toBeNull();
    expect(byId[foreign.id].archived_at).toBeNull(); // another store's product is untouched
  });

  it('a wrongly imported list (with opening stock) can be deleted in one go', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    await request().post(`/api/stores/${store.id}/products/import`).set(A(token))
      .send({ rows: [{ Name: 'Mouse A', Price: '100', Stock: 5 }, { Name: 'Mouse B', Price: '200', Stock: 3 }] });
    const { rows: ps } = await pool.query('SELECT id FROM products WHERE store_id = $1', [store.id]);
    const r = await request().post(`/api/stores/${store.id}/products/delete`).set(A(token)).send({ productIds: ps.map((p) => p.id) });
    expect(r.body).toMatchObject({ deleted: 2, archived: 0 });
    expect((await pool.query('SELECT count(*)::int AS n FROM products WHERE store_id = $1', [store.id])).rows[0].n).toBe(0);
  });

  it('only admins and managers can delete', async () => {
    const { store } = await createActiveStoreWithAdmin();
    const p = await createProduct(store.id, { sku: 'C-1' });
    const cashier = await createUser(store.id, { role: 'cashier' });
    const r = await request().post(`/api/stores/${store.id}/products/delete`).set(A(tokenFor(cashier))).send({ productIds: [p.id] });
    expect(r.status).toBe(403);
  });
});
