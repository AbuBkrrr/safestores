jest.mock('axios');
const axios = require('axios');
const { request } = require('./helpers/app');
const { createSuperAdmin, superToken } = require('./helpers/factories');
const { loadConfig, saveConfig } = require('../server/syncAgent');

// Pairing a shop computer to the store already registered online. This used
// to crash after creating the store (saveConfig was never exported), so the
// device was left with cloud backup switched off.
describe('Linking a desktop install to its online store', () => {
  it('creates the store with the online id and sync key, and switches on cloud backup without losing LAN sync', async () => {
    saveConfig({ lanEnabled: true });
    axios.get.mockResolvedValueOnce({ data: { id: 'online-store-1' } });
    const superAdmin = await createSuperAdmin();
    const res = await request()
      .post('/api/super/stores')
      .set('Authorization', `Bearer ${superToken(superAdmin)}`)
      .send({ storeName: 'Linked Mart', adminName: 'Till One', adminEmail: 'till1@linked.test', password: 'Password123!',
        linkedStoreId: '11111111-2222-4333-8444-555555555555', linkedSyncKey: 'key-abc', cloudUrl: 'https://cloud.example/' });

    expect(res.status).toBe(201);
    expect(res.body.linkedToCloud).toBe(true);
    expect(res.body.store.id).toBe('11111111-2222-4333-8444-555555555555');
    expect(loadConfig()).toEqual({ lanEnabled: true, cloudUrl: 'https://cloud.example', cloudEnabled: true });
  });
});
