const CACHE_NAME = 'clashes-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/game.css',
  '/game.js',
  '/manifest.json',
  '/C.png',
  '/dash.svg',
  '/fireball.svg',
  '/heal.svg',
  '/impulse.svg',
  '/knockback.svg',
  '/landmine.svg',
  '/reflection.svg',
  '/skin.svg',
  '/snowball.svg',
  '/target.svg',
  '/whiteball.svg',
];

// Install: cache static assets (ignore individual failures)
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.allSettled(STATIC_ASSETS.map((url) => cache.add(url)))
    )
  );
  self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: network-first for HTML, cache-first for static assets
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET and WebSocket requests
  if (event.request.method !== 'GET' || url.protocol === 'ws:' || url.protocol === 'wss:') return;

  // Network-first for HTML (always get fresh game)
  if (event.request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(event.request, clone));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Cache-first for static assets
  event.respondWith(
    caches.match(event.request).then((cached) =>
      cached ||
      fetch(event.request).then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(event.request, clone));
        }
        return res;
      })
    )
  );
});
