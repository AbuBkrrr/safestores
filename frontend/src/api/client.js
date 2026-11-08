import axios from 'axios';
import { enqueueAction } from '../offline/outbox.js';
import { dbPut, dbGet } from '../offline/db.js';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api',
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('ss_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Creation endpoints where a client-generated id makes offline queuing +
// later idempotent replay safe (matches the backend's ON CONFLICT DO
// NOTHING / INSERT OR IGNORE handling — see stockMath.js).
//
// `orders` (POS checkout) was missing here despite both backends' routes
// explicitly commenting that checkout is "offline-capable, same as
// everything else here" — every order/item/pay/cancel call was silently
// falling straight through to a network error with nothing queued, so a
// cashier ringing up a sale while offline would just see checkout fail.
// POST creates (arrivals, movements, audits, new products/images, new
// orders, order sub-actions). PUT/DELETE additions below cover the two
// shop-floor actions most likely to happen with no signal: correcting a
// product's shelf/floor location, and removing an item mid-sale. Other
// PATCH/DELETE actions (user management, marketplace fulfillment, auditor
// engagements) stay online-only for now — they're admin actions, rarer
// under time pressure, and some (payment confirmations, fulfillment) are
// safer done with a live connection rather than queued and replayed later.
// `receipts` (POST only — the initial scan/upload) was also missing:
// scanning a receipt in a stockroom with poor signal is exactly the kind
// of capture that must survive a dropped connection. Its sub-actions
// (apply/reject) aren't queued — reviewing OCR results to decide whether
// to apply them inherently needs a live connection to see them first.
// `cycle-counts` (POST only — submitting a count) belongs in this same
// bucket as `audits` for the identical reason: a staff member spot-checking
// a shelf is exactly the kind of shop-floor action that needs to survive a
// dropped connection. Its sub-action (skipping a task) stays online-only —
// lower-stakes and not time-sensitive the way an actual count is.
const QUEUEABLE_WRITE = /\/(arrivals|movements|audits|products|images|receipts|orders(\/[^/]+\/(items|pay|cancel))?|cycle-counts)$/;
const QUEUEABLE_PUT_DELETE = /\/products\/[^/]+$/;
// `images/:id` was missing here — deleting a captured photo while offline
// (a stockroom with poor signal is exactly where this gets used) just
// threw an unhandled network error instead of queuing, since Camera.jsx's
// deleteImage() has no try/catch of its own to fall back on.
const QUEUEABLE_DELETE_ONLY = /\/orders\/[^/]+\/items\/[^/]+$|\/images\/[^/]+$/;

function isQueueableWrite(method, url) {
  const m = method?.toLowerCase();
  if (m === 'post') return QUEUEABLE_WRITE.test(url);
  if (m === 'put') return QUEUEABLE_PUT_DELETE.test(url);
  if (m === 'delete') return QUEUEABLE_PUT_DELETE.test(url) || QUEUEABLE_DELETE_ONLY.test(url);
  return false;
}
// GETs worth caching for offline reading — the core stock-taking screens.
const CACHEABLE_READ = /\/(products|audits|movements|arrivals|receipts|images|orders|cycle-counts\/tasks|cycle-counts\/history)(\?.*)?$/;

function storeIdFromUrl(url) {
  const m = url?.match(/\/stores\/([^/]+)/);
  return m ? m[1] : null;
}

api.interceptors.response.use(
  (res) => {
    // Cache successful reads for offline fallback. Fire-and-forget — never
    // let a caching failure affect the actual response the page is using.
    if (res.config.method?.toLowerCase() === 'get' && CACHEABLE_READ.test(res.config.url || '')) {
      const key = `${res.config.baseURL || ''}${res.config.url}`;
      dbPut('cache', { key, data: res.data, cachedAt: Date.now() }).catch(() => {});
    }
    return res;
  },
  async (err) => {
    const config = err.config || {};
    const isNetworkError = !err.response;

    // A 401 from a sign-in call (wrong password, 2FA code needed) is part
    // of that form's normal flow — only a 401 on an authenticated call
    // means the session itself is gone.
    if (err.response?.status === 401 && !String(config.url || '').startsWith('/auth/')) {
      localStorage.removeItem('ss_token');
      localStorage.removeItem('ss_user');
      if (!window.location.pathname.startsWith('/login')) {
        window.location.href = '/login';
      }
    }
    if (err.response?.status === 403 && err.response.data?.code === 'STORE_NOT_ACTIVE') {
      if (!window.location.pathname.startsWith('/activate-store')) {
        window.location.href = '/activate-store';
      }
    }
    // Keyed off `code`, not the raw HTTP status — desktop returns 423,
    // and the web backend used to return 402 for the same condition. This
    // way the redirect works regardless of which status either edition
    // uses, and won't silently break again if either side's code changes.
    if (err.response?.data?.code === 'STORE_LOCKED') {
      if (!window.location.pathname.startsWith('/billing')) {
        window.location.href = '/billing';
      }
    }

    // Offline write: queue it and hand the page back a synthesized
    // "accepted" response (with a client-generated id) instead of an
    // error, so the UI can proceed optimistically. It'll actually reach
    // the server once flushOutbox runs (see offline/sync.js).
    if (isNetworkError && isQueueableWrite(config.method, (config.url || '').split('?')[0])) {
      const isFormData = typeof FormData !== 'undefined' && config.data instanceof FormData;
      let body = config.data;
      if (isFormData) {
        const obj = {};
        for (const [key, value] of config.data.entries()) obj[key] = value;
        body = obj;
      } else if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch { /* leave as-is */ }
      }
      const storeId = storeIdFromUrl(config.url);
      const entry = await enqueueAction({ method: config.method, url: config.url, storeId, body, isFormData });
      return {
        data: { ...(isFormData ? {} : entry.body), queued: true, queueId: entry.queueId },
        status: 202,
        statusText: 'Queued (offline)',
        headers: {},
        config,
      };
    }

    // Offline read: fall back to the last cached copy of this GET, if any.
    if (isNetworkError && config.method?.toLowerCase() === 'get' && CACHEABLE_READ.test((config.url || '').split('?')[0])) {
      const key = `${config.baseURL || ''}${config.url}`;
      try {
        const cached = await dbGet('cache', key);
        if (cached) {
          return { data: cached.data, status: 200, statusText: 'OK (offline cache)', headers: {}, config, offlineCache: true, cachedAt: cached.cachedAt };
        }
      } catch { /* fall through to the original error */ }
    }

    return Promise.reject(err);
  }
);

export default api;
