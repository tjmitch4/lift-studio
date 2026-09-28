/* Lift Studio service worker — network-first, cache fallback for offline gym use.
   Bump CACHE_VERSION when the precache list changes; stale caches are deleted on activate. */
'use strict';

const CACHE_VERSION = 'lift-studio-v2';
const PRECACHE = [
  './',
  './index.html',
  './styles.css',
  './program.js',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(PRECACHE.map(u => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first: always try the network so pushes to GitHub show up immediately when online;
// fall back to the cached copy when offline (e.g. basement gym with no signal). A weak signal
// can leave fetch() hanging for tens of seconds without failing, so if the network hasn't
// answered within NETWORK_TIMEOUT_MS we serve the cached copy and let the fetch finish in
// the background to refresh the cache for next time.
const NETWORK_TIMEOUT_MS = 3000;

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const fromCache = () => caches.match(req, { ignoreSearch: true }).then(hit => {
    if (hit) return hit;
    // offline navigation to any in-scope URL -> app shell
    if (req.mode === 'navigate') return caches.match('./index.html');
    return undefined;
  });

  let cachePut = Promise.resolve();
  // 'no-cache' revalidates with GitHub Pages (ETag) instead of trusting its 10-min max-age.
  // Build a fresh Request from the URL: passing init to a navigate-mode Request throws.
  const network = fetch(new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' }))
    .then(res => {
      // Safari rejects redirected responses for navigations (e.g. /lift-studio -> /lift-studio/).
      if (res.redirected && req.mode === 'navigate') {
        res = new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
      }
      if (res.ok) {
        const copy = res.clone();
        cachePut = caches.open(CACHE_VERSION).then(cache => cache.put(req, copy));
      }
      return res;
    });
  // keep the worker alive until the background fetch + cache write finish (iOS kills idle SWs)
  event.waitUntil(network.then(() => cachePut, () => {}).catch(() => {}));

  event.respondWith(new Promise(resolve => {
    let settled = false;
    const finish = res => { if (!settled && res) { settled = true; resolve(res); } };
    const timer = setTimeout(() => fromCache().then(finish), NETWORK_TIMEOUT_MS);
    network.then(
      res => { clearTimeout(timer); finish(res); },
      () => { clearTimeout(timer); fromCache().then(hit => finish(hit || Response.error())); }
    );
  }));
});
