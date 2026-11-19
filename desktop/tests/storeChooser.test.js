// One person owning two shops with the same email and password must be asked
// which shop to open, and land in the one they chose — never silently in the
// first shop (which made "Cyber Cafe" show "Rogo" on its banner).
const { request } = require('./helpers/app');
const { createStore, createUser } = require('./helpers/factories');

describe('Signing in when one email owns several shops (offline)', () => {
  it('asks which shop, then opens the chosen one', async () => {
    const rogo = createStore({ name: 'Rogo', subscriptionStatus: 'active' });
    const cafe = createStore({ name: 'Cyber Cafe', subscriptionStatus: 'active' });
    createUser(rogo.id, { role: 'admin', email: 'bayo@shop.test', password: 'Same2026!' });
    createUser(cafe.id, { role: 'admin', email: 'bayo@shop.test', password: 'Same2026!' });

    const first = await request().post('/api/auth/admin/login').send({ email: 'BAYO@shop.test', password: 'Same2026!' });
    expect(first.status).toBe(409);
    expect(first.body.code).toBe('CHOOSE_STORE');
    expect(first.body.stores.map((s) => s.name).sort()).toEqual(['Cyber Cafe', 'Rogo']);

    const chosen = await request().post('/api/auth/admin/login').send({ email: 'bayo@shop.test', password: 'Same2026!', storeId: cafe.id });
    expect(chosen.status).toBe(200);
    expect(chosen.body.user).toMatchObject({ storeId: cafe.id, storeName: 'Cyber Cafe' });

    expect((await request().post('/api/auth/admin/login').send({ email: 'bayo@shop.test', password: 'wrong' })).status).toBe(401);
  });
});
