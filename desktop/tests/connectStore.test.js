jest.mock('axios');
const axios = require('axios');
const bcrypt = require('bcryptjs');
const { request } = require('./helpers/app');
const db = require('../server/db');

// A freshly installed shop-computer app has no store: the owner connects it
// once (online), then everyone signs in offline with their usual password.
describe('Connecting a new shop computer to its store', () => {
  it('asks to connect first, downloads the store, then signs in with no internet', async () => {
    expect((await request().get('/api/setup/status')).body.needsStore).toBe(true);

    const storeId = '11111111-2222-4333-8444-555555555555';
    const hash = await bcrypt.hash('Owner!pass1', 10);
    axios.post.mockImplementation(async (url) => {
      if (url.endsWith('/api/auth/admin/login')) {
        return { data: { token: 't', user: { role: 'admin', storeId, storeName: 'Cyber Cafe', storeTier: 'mini', syncKey: 'sk-1', subscriptionStatus: 'active' } } };
      }
      return { data: { ok: true } }; // push to the online store
    });
    axios.get.mockResolvedValue({ data: {
      serverTime: new Date().toISOString(),
      users: [{ id: 'u-owner', store_id: storeId, name: 'Owner', email: 'owner@cafe.test', password_hash: hash, role: 'admin', status: 'active', created_at: new Date().toISOString() }],
    } });

    const res = await request().post('/api/setup/connect').send({ email: 'owner@cafe.test', password: 'Owner!pass1' });
    expect(res.status).toBe(201);
    expect(res.body.storeName).toBe('Cyber Cafe');
    expect(db.prepare('SELECT name, sync_key FROM stores WHERE id = ?').get(storeId)).toEqual({ name: 'Cyber Cafe', sync_key: 'sk-1' });
    expect((await request().get('/api/setup/status')).body.needsStore).toBe(false);

    // Offline from here: the sign-in is checked on this computer.
    axios.post.mockRejectedValue(new Error('offline'));
    const login = await request().post('/api/auth/admin/login').send({ email: 'owner@cafe.test', password: 'Owner!pass1' });
    expect(login.status).toBe(200);
    expect(login.body.user.storeName).toBe('Cyber Cafe');

    // A second connect is refused.
    expect((await request().post('/api/setup/connect').send({ email: 'x@y.z', password: 'p' })).status).toBe(409);
  });

  it('only lets the owner or a manager connect, and explains a missing connection', async () => {
    db.prepare('DELETE FROM users').run();
    db.prepare('DELETE FROM stores').run();
    axios.post.mockResolvedValueOnce({ data: { user: { role: 'cashier', storeId: 's', syncKey: 'k' } } });
    expect((await request().post('/api/setup/connect').send({ email: 'c@c.c', password: 'p' })).status).toBe(403);
    axios.post.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND'));
    const r = await request().post('/api/setup/connect').send({ email: 'c@c.c', password: 'p' });
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/internet/i);
  });
});
