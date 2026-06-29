// HOC-OES Service Worker — v6.34f
//
// CRITICAL CHANGE in v6.34f:
//   We NO LONGER pre-cache dashboard HTMLs in SHELL. Only the minimal app
//   shell (index, manifest, JS modules) is pre-cached. Dashboard HTMLs are
//   fetched network-first on first visit and stored in cache after that.
//
//   Why: if SHELL pre-caches dashboards, those dashboards live in the cache
//   from the moment the SW installs. Network-first SHOULD always win on
//   re-fetch, but if the tablet ever loses network at the wrong moment,
//   stale content gets served. Removing them from SHELL means there's
//   nothing to stale.
//
// Bump CACHE on every deploy. The activate handler nukes prior caches.
const CACHE = 'hoc-oes-v6.34ay-20260625';

// Minimal shell — JUST what's needed to bootstrap the app. NO dashboard HTML.
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './hoc_events.js',
  './hoc_theme.js',
  './hoc_attainment.js',
  './hoc_capacity_engine.js',
  './hoc_goal_engine.js',
  './hoc_floor.js',
  './reset.html',
];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(c => {
      return Promise.allSettled(SHELL.map(url =>
        c.add(new Request(url, {cache: 'reload'})).catch(() => {})
      ));
    })
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
     .then(() => {
       return self.clients.matchAll({type:'window'}).then(clients => {
         clients.forEach(client => {
           try { client.postMessage({type:'SW_UPDATED', cache: CACHE}); } catch(e){}
         });
       });
     })
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);
  const isHTML = url.pathname.endsWith('.html') ||
                 url.pathname.endsWith('/') ||
                 e.request.mode === 'navigate' ||
                 (e.request.headers.get('accept') || '').includes('text/html');

  // Never cache the reset page or sw.js itself
  if (url.pathname.endsWith('/reset.html') || url.pathname.endsWith('/sw.js')) {
    e.respondWith(fetch(e.request, {cache: 'no-store'}));
    return;
  }

  if (isHTML) {
    e.respondWith(
      fetch(e.request, {cache: 'no-store'}).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return response;
      }).catch(() => caches.match(e.request).then(cached =>
        cached || new Response('Offline — no cached copy of this page', { status: 503 })
      ))
    );
  } else {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return response;
        }).catch(() => new Response('Offline', { status: 503 }));
      })
    );
  }
});

self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
  // v6.34m: respond to GET_CACHE_NAME for the version-mismatch detector.
  // The page sends a MessageChannel port via e.ports[0]; reply with our cache name.
  if (e.data && e.data.type === 'GET_CACHE_NAME' && e.ports && e.ports[0]) {
    try { e.ports[0].postMessage({ cache: CACHE }); } catch (err) {}
  }
});
