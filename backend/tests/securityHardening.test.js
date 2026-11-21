const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createUser } = require('./helpers/factories');

describe('Security hardening', () => {
  it('only the owner/manager receive the store device key at sign-in', async () => {
    const { store } = await createActiveStoreWithAdmin();
    const cashier = await createUser(store.id, { role: 'cashier' });
    const manager = await createUser(store.id, { role: 'manager' });
    const asCashier = await request().post('/api/auth/admin/login').send({ email: cashier.email, password: 'Password123!' });
    expect(asCashier.status).toBe(200);
    expect(asCashier.body.user.syncKey).toBeUndefined();
    const asManager = await request().post('/api/auth/admin/login').send({ email: manager.email, password: 'Password123!' });
    expect(asManager.body.user.syncKey).toBeTruthy();
  });

  it('a cashier cannot pull the whole store with a guessed key', async () => {
    const { store } = await createActiveStoreWithAdmin();
    const r = await request().get(`/api/stores/${store.id}/sync/export`).set('X-Store-Sync-Key', 'not-the-key');
    expect(r.status).toBe(401);
  });

  it('refuses SVG and saves photos with a safe extension', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const svg = await request().post(`/api/stores/${store.id}/branding/logo`).set('Authorization', `Bearer ${token}`)
      .attach('image', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), { filename: 'x.svg', contentType: 'image/svg+xml' });
    expect(svg.status).toBeGreaterThanOrEqual(400);
    const html = await request().post(`/api/stores/${store.id}/branding/logo`).set('Authorization', `Bearer ${token}`)
      .attach('image', Buffer.from('<script>alert(1)</script>'), { filename: 'evil.html', contentType: 'image/png' });
    expect(html.status).toBe(200);
    const url = html.body.shop_logo_url || html.body.url || JSON.stringify(html.body);
    expect(url).not.toMatch(/\.html/);
  });
});
