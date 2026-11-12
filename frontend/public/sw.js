/* SAFE Stores service worker — lets the web app START with no internet.
 *
 * The app already queues writes offline and caches API reads in IndexedDB
 * (src/offline/). What it couldn't do was load at all without a network:
 * this worker keeps the app shell (HTML + hashed JS/CSS + icons) cached.
 *   • Page loads: network first, fall back to the cached shell.
 *   • /assets/*  (content-hashed by Vite): cache first — they never change.
 *   • API, realtime and uploads are never cached here.
 * Bump VERSION to force old caches out.
 */
const VERSION = 'v26-1';
const SHELL = `ss-shell-${VERSION}`;
const ASSETS = `ss-assets-${VERSION}`;
const PRECACHE = ['/', '/index.html', '/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => ![SHELL, ASSETS].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (/^\/(api|socket\.io|uploads|share)\b/.test(url.pathname)) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put('/index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('/index.html').then((r) => r || caches.match('/')))
    );
    return;
  }

  if (url.pathname.startsWith('/assets/') || PRECACHE.includes(url.pathname)) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(ASSETS).then((c) => c.put(req, copy)).catch(() => {}); }
        return res;
      }))
    );
  }
});
