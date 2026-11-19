// Store settings edited on a shop computer reach the cloud and vice versa;
// the latest edit wins, and a billing/lock change never counts as an edit.
const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin } = require('./helpers/factories');
const { pool } = require('../src/config/db');

describe('Store settings sync (cloud)', () => {
  it('sends its own settings edits, takes a newer edit from a device, and ignores an older one', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const key = (await pool.query('SELECT sync_key FROM stores WHERE id = $1', [store.id])).rows[0].sync_key;
    const sync = (path) => request()[path === 'export' ? 'get' : 'post'](`/api/stores/${store.id}/sync/${path}`).set('x-store-sync-key', key);

    await request().patch(`/api/stores/${store.id}/settings`).set('Authorization', `Bearer ${token}`).send({ businessType: 'tailor', taxRatePct: 7.5 });
    const out = await sync('export');
    expect(out.body.storeSettings).toMatchObject({ business_type: 'tailor', tax_rate_pct: 7.5 });

    // A billing lock elsewhere is not a settings edit.
    await pool.query('UPDATE stores SET locked = true, updated_at = now() WHERE id = $1', [store.id]);
    // (+1 ms: Postgres keeps microseconds, JSON carries milliseconds)
    const after = new Date(Date.parse(out.body.storeSettings.settings_updated_at) + 1).toISOString();
    expect((await sync('export').query({ since: after })).body.storeSettings).toBeNull();
    await pool.query('UPDATE stores SET locked = false WHERE id = $1', [store.id]);

    const later = new Date(Date.now() + 60000).toISOString();
    expect((await sync('import').send({ storeSettings: { ...out.body.storeSettings, business_type: 'bakery', tax_inclusive: 0, settings_updated_at: later } })).status).toBe(200);
    expect((await pool.query('SELECT business_type, tax_inclusive FROM stores WHERE id = $1', [store.id])).rows[0]).toEqual({ business_type: 'bakery', tax_inclusive: false });

    await sync('import').send({ storeSettings: { ...out.body.storeSettings, business_type: 'laundry', settings_updated_at: '2020-01-01T00:00:00.000Z' } });
    expect((await pool.query('SELECT business_type FROM stores WHERE id = $1', [store.id])).rows[0].business_type).toBe('bakery');
  });
});
