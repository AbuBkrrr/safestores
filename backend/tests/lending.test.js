const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createSuperAdmin, superToken, createProduct, createUser, tokenFor } = require('./helpers/factories');
const { pool } = require('../src/config/db');

async function createActivePartner(superAdmin, overrides = {}) {
  const created = await request().post('/api/super/lending-partners').set('Authorization', `Bearer ${superToken(superAdmin)}`)
    .send({ name: 'Test Bank', type: 'bank', ...overrides });
  await request().patch(`/api/super/lending-partners/${created.body.id}`).set('Authorization', `Bearer ${superToken(superAdmin)}`)
    .send({ status: 'active' });
  return created.body; // includes the real apiKey
}

describe('Super Admin: Lending Partner Management', () => {
  it('creates a partner and returns the real API key exactly once', async () => {
    const superAdmin = await createSuperAdmin();
    const res = await request().post('/api/super/lending-partners').set('Authorization', `Bearer ${superToken(superAdmin)}`)
      .send({ name: 'Community MFB', type: 'microfinance', contactEmail: 'ops@communitymfb.com' });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
    expect(res.body.apiKey).toEqual(expect.any(String));
    expect(res.body.apiKey.length).toBeGreaterThan(32);
  });

  it('rejects an invalid partner type', async () => {
    const superAdmin = await createSuperAdmin();
    const res = await request().post('/api/super/lending-partners').set('Authorization', `Bearer ${superToken(superAdmin)}`)
      .send({ name: 'X', type: 'crypto_exchange' });
    expect(res.status).toBe(400);
  });

  it('listing partners never exposes the API key hash', async () => {
    const superAdmin = await createSuperAdmin();
    await request().post('/api/super/lending-partners').set('Authorization', `Bearer ${superToken(superAdmin)}`)
      .send({ name: 'X', type: 'bank' });
    const res = await request().get('/api/super/lending-partners').set('Authorization', `Bearer ${superToken(superAdmin)}`);
    expect(res.body[0].api_key_hash).toBeUndefined();
    expect(res.body[0].consenting_store_count).toBe('0');
  });

  it('a non-super-admin cannot manage lending partners', async () => {
    const { token } = await createActiveStoreWithAdmin();
    const res = await request().post('/api/super/lending-partners').set('Authorization', `Bearer ${token}`).send({ name: 'X', type: 'bank' });
    expect(res.status).toBe(403);
  });

  it('activating a pending partner lets its key start working', async () => {
    const superAdmin = await createSuperAdmin();
    const created = await request().post('/api/super/lending-partners').set('Authorization', `Bearer ${superToken(superAdmin)}`)
      .send({ name: 'X', type: 'bank' });

    const beforeActivation = await request().get('/api/lending/stores').set('Authorization', `Bearer ${created.body.apiKey}`);
    expect(beforeActivation.status).toBe(401); // still pending

    await request().patch(`/api/super/lending-partners/${created.body.id}`).set('Authorization', `Bearer ${superToken(superAdmin)}`)
      .send({ status: 'active' });

    const afterActivation = await request().get('/api/lending/stores').set('Authorization', `Bearer ${created.body.apiKey}`);
    expect(afterActivation.status).toBe(200);
  });

  it('suspending a partner immediately breaks their key, even though it\'s technically correct', async () => {
    const superAdmin = await createSuperAdmin();
    const partner = await createActivePartner(superAdmin);

    await request().patch(`/api/super/lending-partners/${partner.id}`).set('Authorization', `Bearer ${superToken(superAdmin)}`)
      .send({ status: 'suspended' });

    const res = await request().get('/api/lending/stores').set('Authorization', `Bearer ${partner.apiKey}`);
    expect(res.status).toBe(401);
  });

  it('regenerating a key invalidates the old one and issues a new working one', async () => {
    const superAdmin = await createSuperAdmin();
    const partner = await createActivePartner(superAdmin);

    const regenerated = await request().post(`/api/super/lending-partners/${partner.id}/regenerate-key`).set('Authorization', `Bearer ${superToken(superAdmin)}`);
    expect(regenerated.status).toBe(200);
    expect(regenerated.body.apiKey).not.toBe(partner.apiKey);

    const withOldKey = await request().get('/api/lending/stores').set('Authorization', `Bearer ${partner.apiKey}`);
    expect(withOldKey.status).toBe(401);

    const withNewKey = await request().get('/api/lending/stores').set('Authorization', `Bearer ${regenerated.body.apiKey}`);
    expect(withNewKey.status).toBe(200);
  });
});

describe('Store Admin: Opting In/Out', () => {
  it('lists active partners with a consented flag, starting false', async () => {
    const superAdmin = await createSuperAdmin();
    await createActivePartner(superAdmin);
    const { store, token } = await createActiveStoreWithAdmin();

    const res = await request().get(`/api/stores/${store.id}/lending-partners`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].consented).toBe(false);
  });

  it('does not list a pending (not yet activated) partner at all', async () => {
    const superAdmin = await createSuperAdmin();
    await request().post('/api/super/lending-partners').set('Authorization', `Bearer ${superToken(superAdmin)}`).send({ name: 'X', type: 'bank' });
    const { store, token } = await createActiveStoreWithAdmin();

    const res = await request().get(`/api/stores/${store.id}/lending-partners`).set('Authorization', `Bearer ${token}`);
    expect(res.body).toHaveLength(0);
  });

  it('granting then revoking consent flips the flag correctly both ways', async () => {
    const superAdmin = await createSuperAdmin();
    const partner = await createActivePartner(superAdmin);
    const { store, token } = await createActiveStoreWithAdmin();

    await request().post(`/api/stores/${store.id}/lending-partners/${partner.id}/consent`).set('Authorization', `Bearer ${token}`);
    const afterGrant = await request().get(`/api/stores/${store.id}/lending-partners`).set('Authorization', `Bearer ${token}`);
    expect(afterGrant.body[0].consented).toBe(true);

    await request().delete(`/api/stores/${store.id}/lending-partners/${partner.id}/consent`).set('Authorization', `Bearer ${token}`);
    const afterRevoke = await request().get(`/api/stores/${store.id}/lending-partners`).set('Authorization', `Bearer ${token}`);
    expect(afterRevoke.body[0].consented).toBe(false);
  });

  it('a manager cannot grant lending consent (admin only)', async () => {
    const superAdmin = await createSuperAdmin();
    const partner = await createActivePartner(superAdmin);
    const { store } = await createActiveStoreWithAdmin();
    const manager = await createUser(store.id, { role: 'manager' });

    const res = await request().post(`/api/stores/${store.id}/lending-partners/${partner.id}/consent`).set('Authorization', `Bearer ${tokenFor(manager)}`);
    expect(res.status).toBe(403);
  });

  it('re-granting consent after a revoke works (the ON CONFLICT path)', async () => {
    const superAdmin = await createSuperAdmin();
    const partner = await createActivePartner(superAdmin);
    const { store, token } = await createActiveStoreWithAdmin();

    await request().post(`/api/stores/${store.id}/lending-partners/${partner.id}/consent`).set('Authorization', `Bearer ${token}`);
    await request().delete(`/api/stores/${store.id}/lending-partners/${partner.id}/consent`).set('Authorization', `Bearer ${token}`);
    const regrant = await request().post(`/api/stores/${store.id}/lending-partners/${partner.id}/consent`).set('Authorization', `Bearer ${token}`);
    expect(regrant.status).toBe(204);

    const check = await request().get(`/api/stores/${store.id}/lending-partners`).set('Authorization', `Bearer ${token}`);
    expect(check.body[0].consented).toBe(true);
  });
});

describe('Partner-Facing API: privacy boundaries', () => {
  it('a partner only sees stores that consented to THEM, not other stores', async () => {
    const superAdmin = await createSuperAdmin();
    const partnerA = await createActivePartner(superAdmin, { name: 'Bank A' });
    const partnerB = await createActivePartner(superAdmin, { name: 'Bank B' });
    const { store, token } = await createActiveStoreWithAdmin();

    await request().post(`/api/stores/${store.id}/lending-partners/${partnerA.id}/consent`).set('Authorization', `Bearer ${token}`);

    const asA = await request().get('/api/lending/stores').set('Authorization', `Bearer ${partnerA.apiKey}`);
    expect(asA.body).toHaveLength(1);

    const asB = await request().get('/api/lending/stores').set('Authorization', `Bearer ${partnerB.apiKey}`);
    expect(asB.body).toHaveLength(0);
  });

  it('a partner CANNOT pull a summary for a store that never consented', async () => {
    const superAdmin = await createSuperAdmin();
    const partner = await createActivePartner(superAdmin);
    const { store } = await createActiveStoreWithAdmin(); // never grants consent

    const res = await request().get(`/api/lending/stores/${store.id}/summary`).set('Authorization', `Bearer ${partner.apiKey}`);
    expect(res.status).toBe(403);
  });

  it('revoking consent immediately cuts off a partner\'s access to that store\'s summary', async () => {
    const superAdmin = await createSuperAdmin();
    const partner = await createActivePartner(superAdmin);
    const { store, token } = await createActiveStoreWithAdmin();
    await request().post(`/api/stores/${store.id}/lending-partners/${partner.id}/consent`).set('Authorization', `Bearer ${token}`);

    const before = await request().get(`/api/lending/stores/${store.id}/summary`).set('Authorization', `Bearer ${partner.apiKey}`);
    expect(before.status).toBe(200);

    await request().delete(`/api/stores/${store.id}/lending-partners/${partner.id}/consent`).set('Authorization', `Bearer ${token}`);

    const after = await request().get(`/api/lending/stores/${store.id}/summary`).set('Authorization', `Bearer ${partner.apiKey}`);
    expect(after.status).toBe(403);
  });

  it('a garbage/invalid API key is rejected', async () => {
    const res = await request().get('/api/lending/stores').set('Authorization', 'Bearer not-a-real-key');
    expect(res.status).toBe(401);
  });

  it('a store JWT (not a partner key) cannot use the partner-facing endpoints', async () => {
    const { token } = await createActiveStoreWithAdmin();
    const res = await request().get('/api/lending/stores').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it('the summary is a real aggregate computed from real paid orders, and contains no per-transaction detail', async () => {
    const superAdmin = await createSuperAdmin();
    const partner = await createActivePartner(superAdmin);
    const { store, token } = await createActiveStoreWithAdmin();
    await request().post(`/api/stores/${store.id}/lending-partners/${partner.id}/consent`).set('Authorization', `Bearer ${token}`);

    const product = await createProduct(store.id, { backroomQty: 0, shelfQty: 10, costPrice: 5, priceMultiplier: 2 }); // unit price 10
    const order = await request().post(`/api/stores/${store.id}/orders`).set('Authorization', `Bearer ${token}`).send({});
    await request().post(`/api/stores/${store.id}/orders/${order.body.id}/items`).set('Authorization', `Bearer ${token}`)
      .send({ productId: product.id, quantity: 3 });
    await request().post(`/api/stores/${store.id}/orders/${order.body.id}/pay`).set('Authorization', `Bearer ${token}`).send({});

    const res = await request().get(`/api/lending/stores/${store.id}/summary`).set('Authorization', `Bearer ${partner.apiKey}`);
    expect(res.status).toBe(200);
    expect(res.body.last12MonthsRevenue).toBe(30);
    expect(res.body.monthlyBreakdown[0]).not.toHaveProperty('items');
    expect(JSON.stringify(res.body)).not.toContain('product');
  });
});
