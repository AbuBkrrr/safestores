const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createProduct, tokenFor, createUser } = require('./helpers/factories');

describe('Products API', () => {
  it('lists products for the caller\'s store only', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const otherStore = await createActiveStoreWithAdmin();
    await createProduct(store.id, { name: 'Mine' });
    await createProduct(otherStore.store.id, { name: 'Not mine' });

    const res = await request()
      .get(`/api/stores/${store.id}/products`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe('Mine');
  });

  it('excludes archived products by default, includes with includeArchived=true', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const p = await createProduct(store.id);
    await request().delete(`/api/stores/${store.id}/products/${p.id}`).set('Authorization', `Bearer ${token}`);

    const hidden = await request().get(`/api/stores/${store.id}/products`).set('Authorization', `Bearer ${token}`);
    expect(hidden.body).toHaveLength(0);

    const shown = await request()
      .get(`/api/stores/${store.id}/products?includeArchived=true`)
      .set('Authorization', `Bearer ${token}`);
    expect(shown.body).toHaveLength(1);
  });

  it('creates a product with required fields', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const res = await request()
      .post(`/api/stores/${store.id}/products`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Sugar 1kg', sku: 'SKU-SUGAR-1', costPrice: 2, priceMultiplier: 1.5, initialBackroomQty: 10 });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Sugar 1kg');
    expect(res.body.backroom_qty).toBe(10);
  });

  it('rejects creating a product without name/sku', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const res = await request()
      .post(`/api/stores/${store.id}/products`)
      .set('Authorization', `Bearer ${token}`)
      .send({ costPrice: 2 });

    expect(res.status).toBe(400);
  });

  it('rejects a duplicate SKU within the same store', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    await createProduct(store.id, { sku: 'DUP-SKU' });

    const res = await request()
      .post(`/api/stores/${store.id}/products`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Another', sku: 'DUP-SKU' });

    expect(res.status).toBe(409);
  });

  it('staff role cannot create a product (admin/manager only)', async () => {
    const { store } = await createActiveStoreWithAdmin();
    const staff = await createUser(store.id, { role: 'staff' });

    const res = await request()
      .post(`/api/stores/${store.id}/products`)
      .set('Authorization', `Bearer ${tokenFor(staff)}`)
      .send({ name: 'X', sku: 'X-1' });

    expect(res.status).toBe(403);
  });

  it('updates a product', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const p = await createProduct(store.id);

    const res = await request()
      .put(`/api/stores/${store.id}/products/${p.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Renamed', costPrice: 99 });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Renamed');
    expect(Number(res.body.cost_price)).toBe(99);
  });

  it('404s updating a product that belongs to a different store', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const other = await createActiveStoreWithAdmin();
    const p = await createProduct(other.store.id);

    const res = await request()
      .put(`/api/stores/${store.id}/products/${p.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Hijacked' });

    expect(res.status).toBe(404);
  });

  it('archives (soft-deletes) then restores a product', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const p = await createProduct(store.id);

    const del = await request().delete(`/api/stores/${store.id}/products/${p.id}`).set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(204);

    const restore = await request()
      .patch(`/api/stores/${store.id}/products/${p.id}/restore`)
      .set('Authorization', `Bearer ${token}`);
    expect(restore.status).toBe(200);
    expect(restore.body.archived_at).toBeNull();
  });

  it('staff cannot delete a product (admin only)', async () => {
    const { store } = await createActiveStoreWithAdmin();
    const staff = await createUser(store.id, { role: 'staff' });
    const p = await createProduct(store.id);

    const res = await request()
      .delete(`/api/stores/${store.id}/products/${p.id}`)
      .set('Authorization', `Bearer ${tokenFor(staff)}`);

    expect(res.status).toBe(403);
  });

  it('enforces the store tier\'s max_products limit', async () => {
    const db = require('../server/db');
    const crypto = require('crypto');
    const { store, token } = await createActiveStoreWithAdmin(); // defaults to 'mini' tier, max_products=200
    const insert = db.prepare(`INSERT INTO products (id, store_id, name, sku, cost_price) VALUES (?,?,?,?,1)`);
    for (let g = 1; g <= 200; g++) insert.run(crypto.randomUUID(), store.id, `Bulk ${g}`, `BULK-SKU-${g}`);

    const res = await request()
      .post(`/api/stores/${store.id}/products`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'One too many', sku: 'OVER-LIMIT' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/plan limit/i);
  });
});
