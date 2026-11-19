// Store settings (business type, tax, receipt text...) edited on one device
// reach the others; the latest edit wins, and an older one never overwrites it.
const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin } = require('./helpers/factories');
const db = require('../server/db');

describe('Store settings sync (offline edition)', () => {
  it('sends its own settings edits, takes a newer edit from elsewhere, and ignores an older one', async () => {
    const { store, token } = createActiveStoreWithAdmin();
    const key = db.prepare('SELECT sync_key FROM stores WHERE id = ?').get(store.id).sync_key;
    const sync = (path) => request()[path === 'export' ? 'get' : 'post'](`/api/stores/${store.id}/sync/${path}`).set('x-store-sync-key', key);

    await request().patch(`/api/stores/${store.id}/settings`).set('Authorization', `Bearer ${token}`).send({ businessType: 'tailor', taxRatePct: 7.5 });
    const out = await sync('export');
    expect(out.body.storeSettings).toMatchObject({ business_type: 'tailor', tax_rate_pct: 7.5, tax_inclusive: true });

    const later = new Date(Date.now() + 60000).toISOString();
    const res = await sync('import').send({ storeSettings: { ...out.body.storeSettings, business_type: 'bakery', receipt_footer: 'Thank you!', settings_updated_at: later } });
    expect(res.status).toBe(200);
    expect(db.prepare('SELECT business_type, receipt_footer FROM stores WHERE id = ?').get(store.id)).toEqual({ business_type: 'bakery', receipt_footer: 'Thank you!' });

    await sync('import').send({ storeSettings: { ...out.body.storeSettings, business_type: 'laundry', settings_updated_at: '2020-01-01T00:00:00.000Z' } });
    expect(db.prepare('SELECT business_type FROM stores WHERE id = ?').get(store.id).business_type).toBe('bakery');
  });
});
