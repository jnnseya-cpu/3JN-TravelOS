/* 3JN Travel OS — Service Worker
 *
 * Strategy (deliberately update-safe so it never re-serves stale app code):
 *   - Navigations + app.js/styles.css/config: NETWORK-FIRST, fall back to cache
 *     when offline. Online users always get the freshest build.
 *   - Fonts, icons, images: CACHE-FIRST (stale-while-revalidate) — safe to cache
 *     hard because they're effectively immutable.
 *   - /api/* and /shared/*: NETWORK-ONLY. Never cached. On failure we return a
 *     valid JSON body so the frontend's JSON parser never chokes (no "Unexpected
 *     token" errors when offline).
 *
 * Bump CACHE_VERSION to force every client to drop old caches on next load.
 */
const CACHE_VERSION = 'v7';
const STATIC_CACHE = `3jn-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `3jn-runtime-${CACHE_VERSION}`;

// App shell — precached so the app opens instantly and works offline.
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/config.js',
  '/firebase-config.js',
  '/manifest.webmanifest',
  '/logo.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/favicon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) =>
      // Don't let one missing asset abort the whole install.
      Promise.allSettled(PRECACHE_URLS.map((u) => cache.add(u)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== STATIC_CACHE && k !== RUNTIME_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// Let the page tell a waiting SW to take over immediately.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

const isStaticAsset = (url) =>
  /\.(?:png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|otf)$/i.test(url.pathname) ||
  url.hostname.includes('fonts.gstatic.com') ||
  url.hostname.includes('fonts.googleapis.com');

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch { return; }

  // Only handle http(s); ignore chrome-extension:, data:, etc.
  if (!url.protocol.startsWith('http')) return;

  // API + shared data: network-only, JSON fallback when offline.
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/shared')) {
    event.respondWith(
      fetch(request).catch(() =>
        new Response(
          JSON.stringify({ error: 'offline', message: 'You appear to be offline. Reconnect to continue.' }),
          { status: 503, headers: { 'content-type': 'application/json' } }
        )
      )
    );
    return;
  }

  // Immutable static assets (same-origin or fonts CDN): cache-first + refresh.
  if (isStaticAsset(url)) {
    event.respondWith(
      caches.open(RUNTIME_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        const network = fetch(request)
          .then((resp) => {
            if (resp && resp.status === 200) cache.put(request, resp.clone());
            return resp;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  // Navigations + app code (same-origin): network-first, cache fallback offline.
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(request)
        .then((resp) => {
          if (resp && resp.status === 200) {
            const copy = resp.clone();
            caches.open(STATIC_CACHE).then((cache) => cache.put(request, copy));
          }
          return resp;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          if (cached) return cached;
          if (request.mode === 'navigate') {
            const shell = await caches.match('/index.html');
            if (shell) return shell;
          }
          return new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain' } });
        })
    );
  }
});
