const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createProduct, createUser, tokenFor } = require('./helpers/factories');
const { pool } = require('../src/config/db');

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

describe('Push Token Registration', () => {
  it('registers a device token', async () => {
    const { token } = await createActiveStoreWithAdmin();
    const res = await request().post('/api/push/register').set('Authorization', `Bearer ${token}`).send({ token: 'device-token-abc', platform: 'ios' });
    expect(res.status).toBe(204);

    const { rows } = await pool.query('SELECT * FROM device_push_tokens WHERE token = $1', ['device-token-abc']);
    expect(rows).toHaveLength(1);
    expect(rows[0].platform).toBe('ios');
  });

  it('re-registering the same token updates it rather than duplicating (ON CONFLICT)', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const otherUser = await createUser(store.id, { role: 'staff' });

    await request().post('/api/push/register').set('Authorization', `Bearer ${token}`).send({ token: 'shared-device', platform: 'android' });
    await request().post('/api/push/register').set('Authorization', `Bearer ${tokenFor(otherUser)}`).send({ token: 'shared-device', platform: 'android' });

    const { rows } = await pool.query('SELECT * FROM device_push_tokens WHERE token = $1', ['shared-device']);
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(otherUser.id); // now owned by whoever registered it most recently
  });

  it('rejects registration with no token', async () => {
    const { token } = await createActiveStoreWithAdmin();
    const res = await request().post('/api/push/register').set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(400);
  });

  it('unregisters a token, scoped to the owning user', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const otherUser = await createUser(store.id, { role: 'staff' });
    await request().post('/api/push/register').set('Authorization', `Bearer ${token}`).send({ token: 'to-remove' });

    // Another user trying to unregister someone else's token should be a no-op, not an error.
    const wrongUser = await request().delete('/api/push/register').set('Authorization', `Bearer ${tokenFor(otherUser)}`).send({ token: 'to-remove' });
    expect(wrongUser.status).toBe(204);
    let check = await pool.query('SELECT * FROM device_push_tokens WHERE token = $1', ['to-remove']);
    expect(check.rows).toHaveLength(1); // still there

    const res = await request().delete('/api/push/register').set('Authorization', `Bearer ${token}`).send({ token: 'to-remove' });
    expect(res.status).toBe(204);
    check = await pool.query('SELECT * FROM device_push_tokens WHERE token = $1', ['to-remove']);
    expect(check.rows).toHaveLength(0);
  });
});
