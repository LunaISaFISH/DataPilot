const CACHE_NAME = 'datapilot-replay-v2';
const DEMO_ASSETS = [
  '/',
  '/demo/clinical-nlp',
  '/demo/report.json',
  '/demo/release-report.json',
  '/demo/release-manifest.json',
  '/demo/cleaned.csv',
  '/demo/events.json',
  '/favicon.svg',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(DEMO_ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
      ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/runs')) return;
  const cacheable =
    DEMO_ASSETS.includes(url.pathname) ||
    request.destination === 'script' ||
    request.destination === 'style' ||
    request.destination === 'font';
  if (!cacheable) return;
  event.respondWith(
    caches.match(request).then((cached) => {
      const refreshed = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || refreshed;
    }),
  );
});
