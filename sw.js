// Bump CACHE on every release; keep it equal to the version label in the menu.
const CACHE = 'snapdoc-v2';
const ASSETS = ['.', 'index.html', 'vault.js', 'app-core.js', 'app-docs.js', 'app-cam.js', 'app-lock.js', 'app-sync.js', 'app-boot.js', 'imaging.js', 'worker.js', 'config.js', 'manifest.json', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      // only this app's own old caches: other apps on the same web address keep theirs
      .then(keys => Promise.all(keys.filter(k => k.startsWith('snapdoc-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first, cache fallback: updates arrive when online, the app works offline.
// Only same-origin GETs are cached; cloud calls never touch the cache.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
