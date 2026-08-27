// Minimal app-shell service worker. Deliberately NETWORK-FIRST, not
// cache-first: an online user must always get whatever index.html/assets
// are actually live right now — this file only adds a fallback for when
// there is genuinely no network, so the app shell can still boot offline
// and hand off to its own localStorage data-cache (see cmoreira_cache_v1 in
// index.html), rather than showing nothing at all. It must never be the
// thing that makes a real deploy look like it didn't happen.
const CACHE_NAME = 'cmoreira-shell-v1';
const SHELL_URL = './index.html';

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll([SHELL_URL]).catch(() => {}))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch the Apps Script backend or any other origin
  if (url.pathname.endsWith('version.json')) return; // must always hit the network — see checkForUpdate() in index.html

  // Navigations (including a cache-busted "?_r=..." reload from
  // forceAppReload()) always resolve to the ONE shell cache entry — without
  // this, every distinct "?_r=" URL would pile up as its own cache entry.
  const isNavigation = req.mode === 'navigate';
  const cacheKey = isNavigation ? SHELL_URL : req;

  event.respondWith(
    fetch(req)
      .then((resp) => {
        if (resp && resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(cacheKey, copy)).catch(() => {});
        }
        return resp;
      })
      .catch(() => caches.match(cacheKey).then((cached) => cached || (isNavigation ? caches.match(SHELL_URL) : undefined)))
  );
});
