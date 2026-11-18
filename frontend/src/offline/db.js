// Minimal promisified IndexedDB wrapper. No external dependency — every
// modern browser (and every shell we're wrapping this app in: Electron,
// Capacitor's WebView) has IndexedDB built in.

const DB_NAME = 'safe-stores-offline';
const DB_VERSION = 1;
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // `seq` is an auto-incrementing integer IndexedDB assigns itself —
      // guaranteed strictly increasing and unique, unlike a millisecond
      // timestamp (two actions queued in the same millisecond would tie)
      // or the queueId (a random UUID, unrelated to insertion order).
      // This is what makes replay order exact.
      if (!db.objectStoreNames.contains('outbox')) {
        db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
      }
      // Last-known-good GET responses, so a page can render something real
      // instead of a blank/broken screen with zero connectivity.
      if (!db.objectStoreNames.contains('cache')) {
        db.createObjectStore('cache', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(storeName, mode, fn) {
  const db = await openDb();
  const tx = db.transaction(storeName, mode);
  const store = tx.objectStore(storeName);
  const result = await fn(store);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const dbPut = (storeName, value) => withStore(storeName, 'readwrite', (store) => reqToPromise(store.put(value)));
export const dbGet = (storeName, key) => withStore(storeName, 'readonly', (store) => reqToPromise(store.get(key)));
export const dbGetAll = (storeName) => withStore(storeName, 'readonly', (store) => reqToPromise(store.getAll()));
export const dbDelete = (storeName, key) => withStore(storeName, 'readwrite', (store) => reqToPromise(store.delete(key)));
