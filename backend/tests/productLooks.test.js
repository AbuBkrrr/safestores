const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createUser, createProduct, tokenFor } = require('./helpers/factories');

const sig = Buffer.alloc(284, 7).toString('base64');

describe('Camera recognition looks', () => {
  it('a cashier teaches a look; the till gets it back; other stores cannot', async () => {
    const { store } = await createActiveStoreWithAdmin();
    const p = await createProduct(store.id, { name: 'Loose tomatoes' });
    const cashier = await createUser(store.id, { role: 'cashier' });
    const auth = { Authorization: `Bearer ${tokenFor(cashier)}` };
    expect((await request().post(`/api/stores/${store.id}/products/${p.id}/looks`).set(auth).send({ sig })).status).toBe(201);
    expect((await request().post(`/api/stores/${store.id}/products/${p.id}/looks`).set(auth).send({ sig: '<script>' })).status).toBe(400);
    const list = await request().get(`/api/stores/${store.id}/product-looks`).set(auth);
    expect(list.body).toEqual([{ product_id: p.id, sig }]);

    const other = await createActiveStoreWithAdmin();
    expect((await request().get(`/api/stores/${store.id}/product-looks`).set('Authorization', `Bearer ${other.token}`)).status).toBe(403);
    expect((await request().post(`/api/stores/${other.store.id}/products/${p.id}/looks`).set('Authorization', `Bearer ${other.token}`).send({ sig })).status).toBe(404);
  });

  it('looks travel with the store backup (sync)', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const p = await createProduct(store.id);
    await request().post(`/api/stores/${store.id}/products/${p.id}/looks`).set('Authorization', `Bearer ${token}`).send({ sig });
    const { pool } = require('../src/config/db');
    const key = (await pool.query('SELECT sync_key FROM stores WHERE id = $1', [store.id])).rows[0].sync_key;
    const out = await request().get(`/api/stores/${store.id}/sync/export`).set('X-Store-Sync-Key', key);
    expect(out.body.productLooks).toHaveLength(1);
  });
});
