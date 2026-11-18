const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createProduct, createUser, tokenFor } = require('./helpers/factories');

describe('Export', () => {
  it('exports products as CSV with a header row', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    await createProduct(store.id, { name: 'Sugar', sku: 'SUG-1' });

    const res = await request().get(`/api/stores/${store.id}/export/csv?type=products`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text.split('\n')[0]).toContain('sku');
    expect(res.text).toContain('Sugar');
  });

  it('a "full" export bundles products/movements/audits into one CSV with section headers', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    await createProduct(store.id);

    const res = await request().get(`/api/stores/${store.id}/export/csv?type=full`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('# PRODUCTS');
    expect(res.text).toContain('# MOVEMENTS');
    expect(res.text).toContain('# AUDITS');
  });

  it('rejects an unknown export type', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const res = await request().get(`/api/stores/${store.id}/export/csv?type=nonsense`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  it('exports a full JSON backup scoped to the store', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    await createProduct(store.id, { name: 'Backup Me' });

    const res = await request().get(`/api/stores/${store.id}/export/json`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.storeId).toBe(store.id);
    expect(res.body.data.products.some((p) => p.name === 'Backup Me')).toBe(true);
  });

  it('manager cannot export (admin only)', async () => {
    const { store } = await createActiveStoreWithAdmin();
    const manager = await createUser(store.id, { role: 'manager' });
    const res = await request().get(`/api/stores/${store.id}/export/csv?type=products`).set('Authorization', `Bearer ${tokenFor(manager)}`);
    expect(res.status).toBe(403);
  });
});
