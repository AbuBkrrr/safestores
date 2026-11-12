const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createProduct } = require('./helpers/factories');

// A minimal valid 1x1 PNG, so multer's `fileFilter` (image/* only) passes.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

describe('Images', () => {
  it('uploads an image and lists it', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const res = await request()
      .post(`/api/stores/${store.id}/images`)
      .set('Authorization', `Bearer ${token}`)
      .field('label', 'Shelf 3 aisle 2')
      .attach('photo', TINY_PNG, 'shelf.png');

    expect(res.status).toBe(201);
    expect(res.body.label).toBe('Shelf 3 aisle 2');
    expect(res.body.url).toMatch(/^\/uploads\//);

    const list = await request().get(`/api/stores/${store.id}/images`).set('Authorization', `Bearer ${token}`);
    expect(list.body).toHaveLength(1);
  });

  it('rejects an upload with no file (field name must be "photo")', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const res = await request().post(`/api/stores/${store.id}/images`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  it('rejects a non-image file', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const res = await request()
      .post(`/api/stores/${store.id}/images`)
      .set('Authorization', `Bearer ${token}`)
      .attach('photo', Buffer.from('not an image'), { filename: 'notes.txt', contentType: 'text/plain' });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('deletes an image', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const uploaded = await request().post(`/api/stores/${store.id}/images`).set('Authorization', `Bearer ${token}`).attach('photo', TINY_PNG, 'x.png');

    const del = await request().delete(`/api/stores/${store.id}/images/${uploaded.body.id}`).set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(204);

    const list = await request().get(`/api/stores/${store.id}/images`).set('Authorization', `Bearer ${token}`);
    expect(list.body).toHaveLength(0);
  });
});

describe('Barcode Lookup', () => {
  it('finds a product by its SKU as a barcode', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id, { sku: '6009123456789' });

    const res = await request().get(`/api/stores/${store.id}/barcode-lookup?code=6009123456789`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(product.id);
  });

  it('404s for an unknown code', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const res = await request().get(`/api/stores/${store.id}/barcode-lookup?code=0000000000000`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it('requires a code query param', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const res = await request().get(`/api/stores/${store.id}/barcode-lookup`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });
});
