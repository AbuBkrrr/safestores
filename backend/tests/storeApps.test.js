const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin, createSuperAdmin, superToken, uniq } = require('./helpers/factories');

const realFetch = global.fetch;
beforeEach(() => { delete process.env.GITHUB_TOKEN; });
afterEach(() => { global.fetch = realFetch; delete process.env.GITHUB_TOKEN; });

function signup(name) {
  return request().post('/api/auth/store/signup').send({
    storeName: name, adminName: 'Owner', adminEmail: `${uniq()}@shop.test`, password: 'Str0ng!pass99', storeTier: 'midi',
  });
}

describe("Store's own apps", () => {
  it('signs up even when app building is not set up, and says so', async () => {
    const res = await signup('Mama Nkechi Mart');
    expect(res.status).toBe(201);
    expect(res.body.apps.status).toBe('not_configured');
    const st = await request().get(`/api/store-apps/${res.body.apps.token}`);
    expect(st.status).toBe(200);
    expect(st.body).toMatchObject({ status: 'not_configured', name: 'Mama Nkechi Mart', downloads: null });
  });

  it('starts a build on sign-up, then offers downloads under the store name once the files exist', async () => {
    process.env.GITHUB_TOKEN = 'test-token';
    const calls = [];
    global.fetch = jest.fn(async (url, opts = {}) => {
      calls.push([String(url), opts.method || 'GET', opts.body]);
      if (String(url).endsWith('/dispatches')) return new Response(null, { status: 204 });
      if (String(url).includes('/releases/tags/store-')) {
        const later = new Date(Date.now() + 60000).toISOString();
        return Response.json({ assets: [
          { name: 'store-windows.exe', updated_at: later, browser_download_url: 'https://files.test/w.exe' },
          { name: 'store-android.apk', updated_at: later, browser_download_url: 'https://files.test/a.apk' },
        ] });
      }
      if (String(url) === 'https://files.test/a.apk') return new Response('APKDATA', { status: 200, headers: { 'content-length': '7' } });
      return new Response(null, { status: 404 });
    });

    const res = await signup('Mama Nkechi Mart');
    expect(res.body.apps.status).toBe('building');
    const dispatch = calls.find(([u]) => u.endsWith('/actions/workflows/store-app.yml/dispatches'));
    const inputs = JSON.parse(dispatch[2]).inputs;
    expect(inputs).toMatchObject({ store_id: res.body.store.id, store_name: 'Mama Nkechi Mart', store_tier: 'midi' });

    const st = await request().get(`/api/store-apps/${res.body.apps.token}`);
    expect(st.body.status).toBe('ready');
    expect(st.body.downloads.windows.file).toBe('Mama Nkechi Mart Setup.exe');
    expect(st.body.downloads.android.file).toBe('Mama Nkechi Mart.apk');

    const dl = await request().get(st.body.downloads.android.url).buffer(true).parse((r, cb) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => cb(null, d)); });
    expect(dl.status).toBe(200);
    expect(dl.headers['content-disposition']).toContain('Mama Nkechi Mart.apk');
    expect(dl.body).toBe('APKDATA');
  });

  it('keeps downloads behind the secret link and the store login', async () => {
    expect((await request().get('/api/store-apps/not-a-token')).status).toBe(404);
    expect((await request().get(`/api/store-apps/${'a'.repeat(48)}/windows`)).status).toBe(404);
    const { store, token } = await createActiveStoreWithAdmin();
    const mine = await request().get(`/api/stores/${store.id}/apps`).set('Authorization', `Bearer ${token}`);
    expect(mine.status).toBe(200);
    expect(mine.body.status).toBe('none');
  });

  it('lets the Super Admin rebuild a store\'s apps', async () => {
    const { store } = await createActiveStoreWithAdmin();
    const sa = await createSuperAdmin();
    const res = await request().post(`/api/super/stores/${store.id}/apps`).set('Authorization', `Bearer ${superToken(sa)}`);
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('not_configured');
  });
});
