const CACHE_VERSION = 'audiobook-player-v2';

const APP_SHELL_ASSETS = [
  '../',
  '../index.html',
  '../oauth-callback.html',
  '../src/styles/theme.css',
  './manifest.json',
  './icon.svg',
  '../src/ui/app.js',
  '../src/ui/icons.js',
  '../src/player/audio-engine.js',
  '../src/player/media-session-bridge.js',
  '../src/services/offline-queue.js',
  '../src/services/supabase-sync.js',
  '../src/services/self-updater.js',
  '../src/services/library-scanner.js',
  '../src/services/metadata-enrichment.js',
  '../src/services/cover-search.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(async (cache) => {
      await Promise.allSettled(
        APP_SHELL_ASSETS.map((url) => cache.add(new Request(url, { cache: 'reload' })))
      );
      await self.skipWaiting();
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(async (keys) => {
      await Promise.all(
        keys
          .filter((key) => key !== CACHE_VERSION)
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

function shouldBypassCache(request) {
  if (request.method !== 'GET') return true;
  if (request.headers.has('range')) return true;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return true;
  if (url.pathname.startsWith('/rest/v1/') || url.pathname.startsWith('/auth/')) return true;

  return false;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (shouldBypassCache(request)) {
    return;
  }

  // Network-first for navigation and app module code; cache fallback when offline.
  if (
    request.mode === 'navigate' ||
    request.destination === 'document' ||
    request.destination === 'script' ||
    request.destination === 'style'
  ) {
    event.respondWith(
      fetch(request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.ok) {
            const copy = networkResponse.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
          }
          return networkResponse;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          if (cached) return cached;
          if (request.mode === 'navigate') {
            return caches.match('../index.html');
          }
          return new Response('', { status: 503, statusText: 'Offline' });
        })
    );
    return;
  }

  // Cache-first for static assets with background refresh.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        fetch(request)
          .then((fresh) => {
            if (fresh && fresh.ok) {
              caches.open(CACHE_VERSION).then((cache) => cache.put(request, fresh));
            }
          })
          .catch(() => {});
        return cached;
      }

      return fetch(request).then((networkResponse) => {
        if (networkResponse && networkResponse.ok) {
          const copy = networkResponse.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
        }
        return networkResponse;
      });
    })
  );
});
