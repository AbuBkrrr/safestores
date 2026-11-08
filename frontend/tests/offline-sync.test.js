import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { enqueueAction } from '../src/offline/outbox.js';
import { flushOutbox } from '../src/offline/sync.js';
import { dbGetAll, dbDelete } from '../src/offline/db.js';

async function clearOutbox() {
  const all = await dbGetAll('outbox');
  for (const entry of all) await dbDelete('outbox', entry.seq);
}

beforeEach(async () => {
  await clearOutbox();
});

function fakeApi(handler) {
  return { request: vi.fn(handler) };
}

describe('offline/sync.js: flushOutbox', () => {
  it('replays queued actions in the order they were queued, removing each on success', async () => {
    await enqueueAction({ method: 'post', url: '/stores/s1/orders', storeId: 's1', body: { id: 'o1' } });
    await enqueueAction({ method: 'post', url: '/stores/s1/orders/o1/pay', storeId: 's1', body: {} });

    const calledUrls = [];
    const api = fakeApi(async (config) => { calledUrls.push(config.url); return { data: {} }; });

    const result = await flushOutbox(api, 's1');

    expect(calledUrls).toEqual(['/stores/s1/orders', '/stores/s1/orders/o1/pay']);
    expect(result).toEqual({ synced: 2, failed: 0, paused: false });
  });

  it('stops at the first network failure, preserving remaining queue order for next time', async () => {
    await enqueueAction({ method: 'post', url: '/stores/s1/a', storeId: 's1', body: {} });
    await enqueueAction({ method: 'post', url: '/stores/s1/b', storeId: 's1', body: {} });
    await enqueueAction({ method: 'post', url: '/stores/s1/c', storeId: 's1', body: {} });

    let call = 0;
    const api = fakeApi(async (config) => {
      call += 1;
      if (config.url === '/stores/s1/b') {
        const err = new Error('offline again'); // no .response == network failure
        throw err;
      }
      return { data: {} };
    });

    const result = await flushOutbox(api, 's1');

    expect(result.synced).toBe(1); // only 'a' made it
    expect(result.paused).toBe(true);
    expect(call).toBe(2); // 'a' succeeded, 'b' failed and stopped it — 'c' never attempted
  });

  it('drops (does not retry forever) an entry the server actively rejects, and continues past it', async () => {
    await enqueueAction({ method: 'post', url: '/stores/s1/bad', storeId: 's1', body: {} });
    await enqueueAction({ method: 'post', url: '/stores/s1/good', storeId: 's1', body: {} });

    const api = fakeApi(async (config) => {
      if (config.url === '/stores/s1/bad') {
        const err = new Error('validation failed');
        err.response = { status: 400, data: { error: 'Invalid' } }; // reached the server, rejected
        throw err;
      }
      return { data: {} };
    });

    const result = await flushOutbox(api, 's1');

    expect(result.synced).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.paused).toBe(false);
  });

  it('only replays actions queued for the given storeId', async () => {
    await enqueueAction({ method: 'post', url: '/stores/s1/x', storeId: 's1', body: {} });
    await enqueueAction({ method: 'post', url: '/stores/s2/y', storeId: 's2', body: {} });

    const calledUrls = [];
    const api = fakeApi(async (config) => { calledUrls.push(config.url); return { data: {} }; });

    await flushOutbox(api, 's1');

    expect(calledUrls).toEqual(['/stores/s1/x']);
  });

  it('a concurrent call while already flushing is a safe no-op, not a double-replay', async () => {
    await enqueueAction({ method: 'post', url: '/stores/s1/slow', storeId: 's1', body: {} });

    let resolveFirst;
    let markCalled;
    const calledPromise = new Promise((r) => { markCalled = r; });
    const api = fakeApi(() => {
      markCalled();
      return new Promise((resolve) => { resolveFirst = resolve; });
    });

    const firstCall = flushOutbox(api, 's1');
    const secondCall = flushOutbox(api, 's1'); // fires while the first is still mid-flight (its IndexedDB read hasn't even resolved yet)

    await calledPromise; // wait until the first call has actually reached its (mocked) network request
    resolveFirst({ data: {} });
    const [first, second] = await Promise.all([firstCall, secondCall]);

    expect(second).toEqual({ synced: 0, failed: 0, paused: false }); // bailed out immediately
    expect(first.synced).toBe(1);
  });
});
