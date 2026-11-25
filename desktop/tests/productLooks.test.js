const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createProduct } = require('./helpers/factories');

const sig = Buffer.alloc(284, 9).toString('base64');

describe('Camera recognition looks (shop computer)', () => {
  it('saves a look, lists it, and sends it with sync', async () => {
    const { store, token } = createActiveStoreWithAdmin();
    const p = createProduct(store.id);
    const auth = { Authorization: `Bearer ${token}` };
    expect((await request().post(`/api/stores/${store.id}/products/${p.id}/looks`).set(auth).send({ sig })).status).toBe(201);
    const list = await request().get(`/api/stores/${store.id}/product-looks`).set(auth);
    expect(list.body).toEqual([{ product_id: p.id, sig }]);
    const out = await request().get(`/api/stores/${store.id}/sync/export`).set('X-Store-Sync-Key', store.sync_key);
    expect(out.body.productLooks).toHaveLength(1);
  });
});
