const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createUser, createProduct } = require('./helpers/factories');
const { pool } = require('../src/config/db');

describe('Mini store: one person can do everything, up to 5 people', () => {
  it('received stock goes straight onto the shelf (Mini), store room otherwise', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    await pool.query("UPDATE stores SET store_tier = 'mini', auto_shelf = NULL WHERE id = $1", [store.id]);
    const p = await createProduct(store.id, { costPrice: 100 });
    const r = await request().post(`/api/stores/${store.id}/arrivals`).set('Authorization', `Bearer ${token}`).send({ productId: p.id, quantity: 12 });
    expect(r.status).toBe(201);
    let q = (await pool.query('SELECT shelf_qty, backroom_qty FROM products WHERE id = $1', [p.id])).rows[0];
    expect(Number(q.shelf_qty)).toBe(12);
    expect(Number(q.backroom_qty)).toBe(20); // the factory's opening store-room stock is untouched

    await pool.query("UPDATE stores SET store_tier = 'midi' WHERE id = $1", [store.id]);
    await request().post(`/api/stores/${store.id}/arrivals`).set('Authorization', `Bearer ${token}`).send({ productId: p.id, quantity: 5 });
    q = (await pool.query('SELECT shelf_qty, backroom_qty FROM products WHERE id = $1', [p.id])).rows[0];
    expect(Number(q.backroom_qty)).toBe(25); // Midi keeps the store-room step (20 + 5)
  });

  it('a Mini store can have 5 people (owner + 4)', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    await pool.query("UPDATE stores SET store_tier = 'mini' WHERE id = $1", [store.id]);
    for (let i = 0; i < 3; i += 1) await createUser(store.id, { role: 'cashier' });
    const ok = await request().post(`/api/stores/${store.id}/invites`).set('Authorization', `Bearer ${token}`).send({ name: 'Helper 4', role: 'staff' });
    expect(ok.body.error || '').toBe(''); expect(ok.status).toBe(201); // 5th person
    const no = await request().post(`/api/stores/${store.id}/invites`).set('Authorization', `Bearer ${token}`).send({ name: 'Helper 5', role: 'staff' });
    expect(no.status).toBeGreaterThanOrEqual(400);
  });
});

describe('Straight to shelf: setting and one-tap move', () => {
  it('the owner switches it on in settings; one tap moves store-room stock onto the shelf', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const auth = { Authorization: `Bearer ${token}` };
    await pool.query("UPDATE stores SET store_tier = 'midi', auto_shelf = NULL WHERE id = $1", [store.id]);
    expect((await request().get(`/api/stores/${store.id}/settings`).set(auth)).body.auto_shelf).toBe(false);
    const s = await request().patch(`/api/stores/${store.id}/settings`).set(auth).send({ autoShelf: true });
    expect(s.body.auto_shelf).toBe(true);

    const a = await createProduct(store.id); // 20 in the store room
    const b = await createProduct(store.id);
    const one = await request().post(`/api/stores/${store.id}/products/to-shelf`).set(auth).send({ productIds: [a.id] });
    expect(one.body).toMatchObject({ moved: 1, quantity: 20 });
    const all = await request().post(`/api/stores/${store.id}/products/to-shelf`).set(auth).send({});
    expect(all.body.moved).toBe(1); // only b was left
    const q = (await pool.query('SELECT shelf_qty, backroom_qty FROM products WHERE id = $1', [b.id])).rows[0];
    expect([Number(q.shelf_qty), Number(q.backroom_qty)]).toEqual([20, 0]);
  });
});
