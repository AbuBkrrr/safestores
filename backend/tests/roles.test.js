const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createUser, tokenFor } = require('./helpers/factories');

describe('Store roles', () => {
  it("a store's own auditor (role auditor + storeId) is treated as a store user, not an auditor firm", async () => {
    const { store } = await createActiveStoreWithAdmin();
    const aud = await createUser(store.id, { role: 'auditor' });
    const A = `Bearer ${tokenFor(aud)}`;
    expect((await request().get('/api/account/me').set('Authorization', A)).status).toBe(200);
    expect((await request().get(`/api/stores/${store.id}/products`).set('Authorization', A)).status).toBe(200);
    // Not the independent-auditor portal.
    expect((await request().get('/api/auditor/engagements').set('Authorization', A)).status).toBe(403);
  });

  it('online market manager can read the shop profile but not change it', async () => {
    const { store } = await createActiveStoreWithAdmin();
    const mm = await createUser(store.id, { role: 'marketplace_manager' });
    const M = `Bearer ${tokenFor(mm)}`;
    expect((await request().get(`/api/stores/${store.id}/marketplace-profile`).set('Authorization', M)).status).toBe(200);
    expect((await request().patch(`/api/stores/${store.id}/marketplace-profile`).set('Authorization', M).send({ shopTagline: 'x' })).status).toBe(403);
  });
});
