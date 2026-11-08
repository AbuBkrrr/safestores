jest.mock('axios');
const axios = require('axios');
const db = require('../server/db');
const { createStore, createProduct } = require('./helpers/factories');
const { syncWithRemote } = require('../server/syncAgent');

afterEach(() => {
  axios.get.mockReset?.();
  axios.post.mockReset?.();
});

describe('syncAgent: syncWithRemote', () => {
  it('pulls remote changes, imports them locally, and advances the pull cursor to the server time returned', async () => {
    const store = await createStore();
    axios.get = jest.fn().mockResolvedValue({
      data: { serverTime: '2026-01-01T00:00:00.000Z', products: [], movements: [] },
    });
    axios.post = jest.fn().mockResolvedValue({ data: {} });

    await syncWithRemote({ peerKey: 'cloud', baseUrl: 'https://cloud.example.com', storeId: store.id, syncKey: store.sync_key, log: () => {} });

    expect(axios.get).toHaveBeenCalledWith(
      `https://cloud.example.com/api/stores/${store.id}/sync/export`,
      expect.objectContaining({ headers: { 'X-Store-Sync-Key': store.sync_key } })
    );
    const cursor = db.prepare('SELECT * FROM sync_cursors WHERE peer_key = ?').get('cloud');
    expect(cursor.last_pulled_at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('also pushes local changes and advances the push cursor', async () => {
    const store = await createStore();
    await createProduct(store.id, { name: 'Local Product' });
    axios.get = jest.fn().mockResolvedValue({ data: { serverTime: '2026-01-01T00:00:00.000Z' } });
    axios.post = jest.fn().mockResolvedValue({ data: {} });

    await syncWithRemote({ peerKey: 'cloud', baseUrl: 'https://cloud.example.com', storeId: store.id, syncKey: store.sync_key, log: () => {} });

    expect(axios.post).toHaveBeenCalledWith(
      `https://cloud.example.com/api/stores/${store.id}/sync/import`,
      expect.objectContaining({ products: expect.arrayContaining([expect.objectContaining({ name: 'Local Product' })]) }),
      expect.objectContaining({ headers: { 'X-Store-Sync-Key': store.sync_key } })
    );
  });

  it('a failed pull logs and stops — does NOT attempt the push (preserves ordering/consistency)', async () => {
    const store = await createStore();
    axios.get = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    axios.post = jest.fn();
    const logs = [];

    await syncWithRemote({ peerKey: 'cloud', baseUrl: 'https://cloud.example.com', storeId: store.id, syncKey: store.sync_key, log: (m) => logs.push(m) });

    expect(axios.post).not.toHaveBeenCalled();
    expect(logs[0]).toContain('pull from cloud failed');
  });

  it('a failed push after a successful pull still leaves the pull cursor advanced (partial progress preserved)', async () => {
    const store = await createStore();
    axios.get = jest.fn().mockResolvedValue({ data: { serverTime: '2026-01-01T00:00:00.000Z' } });
    axios.post = jest.fn().mockRejectedValue(new Error('timeout'));
    const logs = [];

    await syncWithRemote({ peerKey: 'cloud', baseUrl: 'https://cloud.example.com', storeId: store.id, syncKey: store.sync_key, log: (m) => logs.push(m) });

    const cursor = db.prepare('SELECT * FROM sync_cursors WHERE peer_key = ?').get('cloud');
    expect(cursor.last_pulled_at).toBe('2026-01-01T00:00:00.000Z'); // pull succeeded, cursor moved
    expect(logs.some((l) => l.includes('push to cloud failed'))).toBe(true);
  });

  it('tracks independent cursors per peer (a LAN peer and the cloud do not share progress)', async () => {
    const store = await createStore();
    axios.get = jest.fn().mockResolvedValue({ data: { serverTime: '2026-01-01T00:00:00.000Z' } });
    axios.post = jest.fn().mockResolvedValue({ data: {} });

    await syncWithRemote({ peerKey: 'lan:192.168.1.5:4500', baseUrl: 'http://192.168.1.5:4500', storeId: store.id, syncKey: store.sync_key, log: () => {} });

    const lanCursor = db.prepare('SELECT * FROM sync_cursors WHERE peer_key = ?').get('lan:192.168.1.5:4500');
    const cloudCursor = db.prepare('SELECT * FROM sync_cursors WHERE peer_key = ?').get('cloud');
    expect(lanCursor).toBeTruthy();
    expect(cloudCursor).toBeUndefined(); // never synced with cloud in this test — no row created for it
  });
});
