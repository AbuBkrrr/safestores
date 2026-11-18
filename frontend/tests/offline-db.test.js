import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { dbPut, dbGet, dbGetAll, dbDelete } from '../src/offline/db.js';

describe('offline/db.js: IndexedDB wrapper', () => {
  it('put then get round-trips a value', async () => {
    await dbPut('cache', { key: 'k1', data: { hello: 'world' } });
    const result = await dbGet('cache', 'k1');
    expect(result.data).toEqual({ hello: 'world' });
  });

  it('outbox auto-increments seq for each put, in insertion order', async () => {
    const first = await dbPut('outbox', { method: 'post', url: '/a' });
    const second = await dbPut('outbox', { method: 'post', url: '/b' });
    expect(second).toBeGreaterThan(first);

    const all = await dbGetAll('outbox');
    const urls = all.filter((e) => e.url === '/a' || e.url === '/b').map((e) => e.url);
    expect(urls).toEqual(['/a', '/b']);
  });

  it('delete removes the entry', async () => {
    const seq = await dbPut('outbox', { method: 'post', url: '/to-delete' });
    await dbDelete('outbox', seq);
    const result = await dbGet('outbox', seq);
    expect(result).toBeUndefined();
  });

  it('getAll on an empty-of-matching-data store returns an array, not undefined', async () => {
    const all = await dbGetAll('cache');
    expect(Array.isArray(all)).toBe(true);
  });
});
