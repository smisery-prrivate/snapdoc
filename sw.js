// Bump CACHE on every release; keep it equal to VERSION in app-core.js.
// One release = one complete set of files. They are fetched past the browser's HTTP cache in one
// go at install time and served only from this set, so the page never runs a mix of two versions
// and starts at once without waiting for the network. A new release arrives as a new worker
// (the browser checks sw.js on every start); the page restarts itself when that worker takes over.
const CACHE = 'snapdoc-v13';
const ASSETS = ['.', 'index.html', 'vault.js', 'app-core.js', 'app-docs.js', 'app-cam.js', 'app-lock.js', 'app-sync.js', 'app-drive.js', 'app-boot.js', 'imaging.js', 'worker.js', 'config.js', 'manifest.json', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  // if any file fails, the install fails and the previous worker and its complete set stay in charge.
  // The new worker then WAITS: the page running the old release keeps its complete set until it asks
  // for the switch at a quiet moment (right before it restarts), so it never loads a file of the new release.
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' })))));
});
self.addEventListener('message', e => { if (e.data && e.data.t === 'skip') self.skipWaiting(); });

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      // only this app's own old caches: other apps on the same web address keep theirs
      .then(keys => Promise.all(keys.filter(k => k.startsWith('snapdoc-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Same-origin GETs only; cloud calls never pass through here. Nothing is written to the cache at
// run time, so no error page, no half-loaded file and no address with sign-in tokens can end up in it.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || !url.pathname.startsWith(new URL(self.registration.scope).pathname)) return;
  e.respondWith(
    caches.open(CACHE)
      .then(c => c.match(url.origin + url.pathname, { ignoreSearch: true }))
      .then(hit => hit || fetch(e.request))
  );
});
