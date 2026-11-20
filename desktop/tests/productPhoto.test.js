const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createUser, createProduct, tokenFor } = require('./helpers/factories');

// 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

describe('Item photos', () => {
  it('lets the store manager add, then remove, a photo of an item', async () => {
    const { store } = await createActiveStoreWithAdmin();
    const sm = await createUser(store.id, { role: 'store_manager' });
    const product = await createProduct(store.id);
    const auth = { Authorization: `Bearer ${tokenFor(sm)}` };

    const up = await request().post(`/api/stores/${store.id}/products/${product.id}/photo`).set(auth).attach('photo', PNG, 'fan.png');
    expect(up.status).toBe(200);
    expect(up.body.image_url).toMatch(/\.png$/);

    const del = await request().delete(`/api/stores/${store.id}/products/${product.id}/photo`).set(auth);
    expect(del.status).toBe(200);
    expect(del.body.image_url).toBeNull();
  });

  it('does not let a cashier change item photos', async () => {
    const { store } = await createActiveStoreWithAdmin();
    const cashier = await createUser(store.id, { role: 'cashier' });
    const product = await createProduct(store.id);
    const res = await request().post(`/api/stores/${store.id}/products/${product.id}/photo`)
      .set('Authorization', `Bearer ${tokenFor(cashier)}`).attach('photo', PNG, 'x.png');
    expect(res.status).toBe(403);
  });

  it('asks for a photo when none is sent', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id);
    const res = await request().post(`/api/stores/${store.id}/products/${product.id}/photo`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });
});
