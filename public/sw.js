// Stockinator service worker: makes the site installable as an app.
// It caches ONLY the app icons. The app's own files (/src/*.js, styles.css) keep the same names when they change, so
// caching them could leave the installed app running old code after a deploy; pages and data (/api/*) also always come
// fresh from the network, so nothing private or stale is ever served from this cache.
const CACHE = 'stockinator-icons-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith('/icons/')) return; // everything else: normal network
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(request);
      if (hit) return hit;
      const response = await fetch(request);
      if (response.ok) cache.put(request, response.clone());
      return response;
    }),
  );
});
