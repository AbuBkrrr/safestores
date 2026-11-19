// Auditors are an outside service: the store books one through SAFE Stores
// (cloud), and the auditor works through the online auditor portal. They are
// not a staff role invited on the shop computer, and their findings go to
// SAFE Stores rather than the shop.
const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin } = require('./helpers/factories');

describe('Auditors (offline)', () => {
  it('cannot be invited as shop staff on the shop computer', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const invite = await request().post(`/api/stores/${store.id}/invites`).set('Authorization', `Bearer ${token}`)
      .send({ name: 'External Auditor', role: 'auditor' });
    expect(invite.status).toBe(400);
  });
});
