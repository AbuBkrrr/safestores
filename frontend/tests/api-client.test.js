import { describe, it, expect, vi, beforeEach } from 'vitest';

// enqueueAction/dbPut/dbGet are mocked so these tests exercise ONLY
// client.js's own decision logic (which requests get queued/cached, and
// what shape of response the page gets back) — not the real IndexedDB
// persistence layer, which offline/db.test.js covers separately.
vi.mock('../src/offline/outbox.js', () => ({ enqueueAction: vi.fn() }));
vi.mock('../src/offline/db.js', () => ({ dbPut: vi.fn(), dbGet: vi.fn() }));

const { enqueueAction } = await import('../src/offline/outbox.js');
const { dbPut, dbGet } = await import('../src/offline/db.js');
const { default: api } = await import('../src/api/client.js');

function networkError(config) {
  const err = new Error('Network Error');
  err.config = config;
  err.response = undefined; // no response at all == a real offline/network failure
  return err;
}

// Real axios adapter signature is (config) => Promise. Using the actual
// config it's called with (rather than a hardcoded one) is what lets each
// test just call api.post/get with a real URL and have the interceptor
// see that real URL/method/data — closer to how it behaves for real.
function alwaysNetworkError() {
  return (config) => Promise.reject(networkError(config));
}

describe('api client: offline write queueing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    // Force every request through the adapter below instead of a real
    // network call, then simulate that call failing as if offline.
    api.defaults.adapter = alwaysNetworkError();
  });

  it('queues a POST to a queueable endpoint and returns a synthesized 202 instead of throwing', async () => {
    enqueueAction.mockResolvedValue({ queueId: 'q1', body: { id: 'gen-id', total: 10 } });

    const res = await api.post('/stores/s1/orders', { total: 10 });

    expect(res.status).toBe(202);
    expect(res.data.queued).toBe(true);
    expect(res.data.queueId).toBe('q1');
    expect(enqueueAction).toHaveBeenCalledWith(expect.objectContaining({ method: 'post', url: '/stores/s1/orders', storeId: 's1' }));
  });

  it('extracts storeId from the URL for the queued entry', async () => {
    enqueueAction.mockResolvedValue({ queueId: 'q2', body: {} });
    await api.post('/stores/abc-123/products', { name: 'X' });
    expect(enqueueAction).toHaveBeenCalledWith(expect.objectContaining({ storeId: 'abc-123' }));
  });

  it('does NOT queue a non-queueable POST endpoint — it rejects like a normal network error', async () => {
    api.defaults.adapter = alwaysNetworkError();
    await expect(api.post('/stores/s1/users/u1/invites/bulk', {})).rejects.toThrow();
    expect(enqueueAction).not.toHaveBeenCalled();
  });

  it('queues order sub-actions (items/pay/cancel), not just the base orders endpoint', async () => {
    enqueueAction.mockResolvedValue({ queueId: 'q3', body: {} });
    api.defaults.adapter = alwaysNetworkError();
    const res = await api.post('/stores/s1/orders/o1/pay', {});
    expect(res.status).toBe(202);
  });

  it('queues DELETE on a captured image (the previously-missing case)', async () => {
    enqueueAction.mockResolvedValue({ queueId: 'q4', body: {} });
    api.defaults.adapter = alwaysNetworkError();
    const res = await api.delete('/stores/s1/images/img1');
    expect(res.status).toBe(202);
  });

  it('a real server error response (not a network failure) is never queued — only genuine offline failures are', async () => {
    const err = new Error('Bad Request');
    err.response = { status: 400, data: { error: 'Invalid quantity' } };
    err.config = { method: 'post', url: '/stores/s1/orders' };
    api.defaults.adapter = () => Promise.reject(err);

    await expect(api.post('/stores/s1/orders', {})).rejects.toBe(err);
    expect(enqueueAction).not.toHaveBeenCalled();
  });
});

describe('api client: offline read caching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('caches a successful GET on a cacheable endpoint', async () => {
    dbPut.mockResolvedValue();
    api.defaults.adapter = () => Promise.resolve({ data: [{ id: 'p1' }], status: 200, statusText: 'OK', headers: {}, config: { method: 'get', url: '/stores/s1/products' } });

    await api.get('/stores/s1/products');
    await new Promise((r) => setTimeout(r, 0)); // dbPut is fire-and-forget

    expect(dbPut).toHaveBeenCalledWith('cache', expect.objectContaining({ data: [{ id: 'p1' }] }));
  });

  it('falls back to the cached copy when a cacheable GET fails offline', async () => {
    dbGet.mockResolvedValue({ data: [{ id: 'cached-product' }], cachedAt: 12345 });
    api.defaults.adapter = alwaysNetworkError();

    const res = await api.get('/stores/s1/products');
    expect(res.status).toBe(200);
    expect(res.offlineCache).toBe(true);
    expect(res.data).toEqual([{ id: 'cached-product' }]);
  });

  it('rejects normally when offline with no cached copy available', async () => {
    dbGet.mockResolvedValue(undefined);
    api.defaults.adapter = alwaysNetworkError();

    await expect(api.get('/stores/s1/products')).rejects.toThrow();
  });

  it('does not attempt to cache a non-cacheable GET', async () => {
    api.defaults.adapter = () => Promise.resolve({ data: {}, status: 200, statusText: 'OK', headers: {}, config: { method: 'get', url: '/stores/s1/analytics/summary' } });
    await api.get('/stores/s1/analytics/summary');
    await new Promise((r) => setTimeout(r, 0));
    expect(dbPut).not.toHaveBeenCalled();
  });
});

describe('api client: auth/redirect side effects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.setItem('ss_token', 'sometoken');
    localStorage.setItem('ss_user', JSON.stringify({ role: 'admin' }));
    delete window.location;
    window.location = { pathname: '/dashboard', href: '' };
  });

  it('a 401 clears stored auth and redirects to /login', async () => {
    const err = new Error('Unauthorized');
    err.response = { status: 401, data: {} };
    err.config = { method: 'get', url: '/stores/s1/products' };
    api.defaults.adapter = () => Promise.reject(err);

    await expect(api.get('/stores/s1/products')).rejects.toBe(err);
    expect(localStorage.getItem('ss_token')).toBeNull();
    expect(window.location.href).toBe('/login');
  });

  it('a STORE_LOCKED code redirects to /billing regardless of the HTTP status used', async () => {
    const err = new Error('Locked');
    err.response = { status: 423, data: { code: 'STORE_LOCKED' } };
    err.config = { method: 'get', url: '/stores/s1/products' };
    api.defaults.adapter = () => Promise.reject(err);

    await expect(api.get('/stores/s1/products')).rejects.toBe(err);
    expect(window.location.href).toBe('/billing');
  });

  it('a STORE_NOT_ACTIVE code redirects to /activate-store', async () => {
    const err = new Error('Not active');
    err.response = { status: 403, data: { code: 'STORE_NOT_ACTIVE' } };
    err.config = { method: 'get', url: '/stores/s1/products' };
    api.defaults.adapter = () => Promise.reject(err);

    await expect(api.get('/stores/s1/products')).rejects.toBe(err);
    expect(window.location.href).toBe('/activate-store');
  });
});
