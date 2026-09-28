/* Lift Studio service worker — network-first, cache fallback for offline gym use.
   Bump CACHE_VERSION when the precache list changes; stale caches are deleted on activate. */
'use strict';

const CACHE_VERSION = 'lift-studio-v1';
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
// fall back to the cached copy when offline (e.g. basement gym with no signal).
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    // 'no-cache' revalidates with GitHub Pages (ETag) instead of trusting its 10-min max-age.
    // Build a fresh Request from the URL: passing init to a navigate-mode Request throws.
    fetch(new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' }))
      .then(res => {
        // Safari rejects redirected responses for navigations (e.g. /lift-studio -> /lift-studio/).
        if (res.redirected && req.mode === 'navigate') {
          res = new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
        }
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then(cache => cache.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req, { ignoreSearch: true }).then(hit => {
          if (hit) return hit;
          // offline navigation to any in-scope URL -> app shell
          if (req.mode === 'navigate') return caches.match('./index.html');
          return Response.error();
        })
      )
  );
});
