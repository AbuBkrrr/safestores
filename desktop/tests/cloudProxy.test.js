// The marketplace/support/audit-engagement admin-side controllers on
// desktop are thin axios proxies to the cloud (see cloudProxyHelpers.js
// and marketplaceController.js's own header comment) — there's no local
// business logic to test here; that's already covered by the cloud
// backend's own test suite. What IS worth verifying on this side:
//   1. the "cloud sync isn't configured" guard (safe, no network involved)
//   2. that a configured proxy actually builds the right request and
//      forwards the cloud's response/error back — with axios mocked, so
//      this never makes a real network call.
jest.mock('axios');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { app: electronApp } = require('electron'); // the mocked module (tests/__mocks__/electron.js)
const { request } = require('./helpers/app');
const { createActiveStoreWithAdmin } = require('./helpers/factories');

function enableCloud(cloudUrl = 'https://cloud.example.com') {
  const configPath = path.join(electronApp.getPath('userData'), 'sync-config.json');
  fs.writeFileSync(configPath, JSON.stringify({ cloudEnabled: true, cloudUrl, lanEnabled: true }));
}

afterEach(() => {
  const configPath = path.join(electronApp.getPath('userData'), 'sync-config.json');
  if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
  axios.get.mockReset?.();
  axios.post?.mockReset?.();
});

describe('Cloud proxy: not configured', () => {
  it('marketplace orders 400s with a clear message when cloud sync is off', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const res = await request().get(`/api/stores/${store.id}/marketplace/orders`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cloud sync/i);
  });

  it('support tickets 400s the same way', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const res = await request().get(`/api/stores/${store.id}/support/tickets`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  it('audit-engagement request 400s the same way', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    const res = await request().post(`/api/stores/${store.id}/audit-engagements`).set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(400);
  });
});

describe('Cloud proxy: configured, forwards correctly', () => {
  it('forwards the store\'s sync key and returns the cloud\'s data verbatim', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    enableCloud();
    axios.get = jest.fn().mockResolvedValue({ data: [{ id: 'order-1', total: 42 }] });

    const res = await request().get(`/api/stores/${store.id}/marketplace/orders`).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'order-1', total: 42 }]);
    expect(axios.get).toHaveBeenCalledTimes(1);
    const [url, opts] = axios.get.mock.calls[0];
    expect(url).toContain('/marketplace/orders');
    expect(opts.headers['X-Store-Sync-Key']).toBe(store.sync_key);
  });

  it('forwards the cloud\'s error status/body when the cloud call fails', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    enableCloud();
    axios.get = jest.fn().mockRejectedValue({ response: { status: 403, data: { error: 'Store suspended' } } });

    const res = await request().get(`/api/stores/${store.id}/marketplace/orders`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Store suspended');
  });

  it('returns 502 when the cloud is unreachable entirely', async () => {
    const { store, token } = await createActiveStoreWithAdmin();
    enableCloud();
    axios.get = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await request().get(`/api/stores/${store.id}/marketplace/orders`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(502);
  });
});
