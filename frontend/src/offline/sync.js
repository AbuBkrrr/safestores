import { listQueued, removeQueued } from './outbox.js';

// Tiny pub/sub so the UI (a sidebar badge, a toast) can react to sync
// activity without this module needing to know about React at all.
const listeners = new Set();
export function onSyncEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function notify(event, data) { listeners.forEach((fn) => fn(event, data)); }

let flushing = false;

function toFormData(obj) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(obj)) fd.append(key, value);
  return fd;
}

/**
 * Replays every queued action for a store, in the order it was queued,
 * against a real API client (the same axios instance the app already
 * uses). Stops at the first network failure (offline again) so ordering
 * is preserved for next time; a request that reaches the server but is
 * rejected (e.g. a genuine validation error) is logged and dropped rather
 * than retried forever, so one bad entry can't block everything behind it.
 */
export async function flushOutbox(apiClient, storeId) {
  if (flushing) return { synced: 0, failed: 0, paused: false };
  flushing = true;
  let synced = 0, failed = 0, paused = false;
  try {
    const queued = await listQueued(storeId);
    for (const entry of queued) {
      try {
        const data = entry.isFormData ? toFormData(entry.body) : entry.body;
        const headers = entry.isFormData ? { 'Content-Type': 'multipart/form-data' } : undefined;
        await apiClient.request({ method: entry.method, url: entry.url, data, headers, params: { _offlineReplay: true } });
        await removeQueued(entry.seq);
        synced += 1;
        notify('synced', entry);
      } catch (err) {
        if (!err.response) {
          // Still offline (or server unreachable) — stop here and preserve
          // order; the rest of the queue will be retried on the next pass.
          paused = true;
          notify('paused', entry);
          break;
        }
        // Server reached but rejected it — not something a retry fixes.
        console.error('Dropping a queued offline action the server rejected:', entry, err.response.data);
        await removeQueued(entry.seq);
        failed += 1;
        notify('failed', { entry, error: err.response.data });
      }
    }
  } finally {
    flushing = false;
  }
  return { synced, failed, paused };
}

/**
 * Starts automatic background syncing: whenever the browser fires an
 * `online` event, and on a regular interval as a safety net (some
 * environments — Electron's LAN relay case especially — don't reliably
 * fire `online`/`offline`). Returns a teardown function.
 */
export function startAutoSync(apiClient, getStoreId, intervalMs = 20000) {
  const trigger = () => { const id = getStoreId(); if (id) flushOutbox(apiClient, id); };
  window.addEventListener('online', trigger);
  const interval = setInterval(trigger, intervalMs);
  trigger();
  return () => { window.removeEventListener('online', trigger); clearInterval(interval); };
}
