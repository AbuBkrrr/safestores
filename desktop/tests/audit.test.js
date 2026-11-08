// Desktop's auditor model is deliberately simpler than the cloud edition's
// (see auditController.js's header comment): matching with an external
// auditor is a cloud/marketplace concern (proxied — covered by
// cloudProxy.test.js), but once matched, the store admin invites them
// locally as an ordinary 'auditor'-role user via the normal invite flow
// (usersController.js) — no separate stock_taker role or engagement-gated
// middleware. This test confirms that flow actually works end-to-end,
// which also confirms desktop does NOT have the stock_taker permission
// gap found in the cloud backend (see backend/tests/audit.test.js) —
// there's no separate role here that could fall through the cracks.
const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createProduct } = require('./helpers/factories');

describe('Auditor access (local invite flow)', () => {
  it('an invited auditor-role user can perform shelf audits once they claim the invite', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const product = await createProduct(store.id);

    const invite = await request().post(`/api/stores/${store.id}/invites`).set('Authorization', `Bearer ${token}`)
      .send({ name: 'External Auditor', role: 'auditor' });
    expect(invite.status).toBe(201);

    const claimed = await request().post('/api/auth/invite/login').send({ code: invite.body.code });
    expect(claimed.status).toBe(200);
    expect(claimed.body.user.role).toBe('auditor');

    const res = await request().post(`/api/stores/${store.id}/audits`).set('Authorization', `Bearer ${claimed.body.token}`)
      .send({ productId: product.id, countedQty: 1, area: 'shelf' });
    expect(res.status).toBe(201);
  });
});
