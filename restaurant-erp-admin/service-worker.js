// Plain, manual Service Worker for admin_panel.html -- there's no bundler
// here (single static HTML file, unlike apps/pos-web's Vite + vite-plugin-pwa
// setup), so this is written and registered by hand instead of generated.
// Only caches the app SHELL (this HTML page + its vendored dexie.min.js,
// both same-origin) -- never API responses, which already have their own,
// smarter cache in IndexedDB via offlineDb (see admin_panel.html's api())
// that can expire/merge/replace per-endpoint instead of a single opaque
// blob per URL.
const CACHE_NAME = 'restaurant-erp-admin-shell-v1';
const SHELL_URLS = ['./admin_panel.html', './dexie.min.js'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(
        SHELL_URLS.map((url) =>
          fetch(url)
            .then((res) => cache.put(url, res))
            .catch(() => {}) // best-effort -- a shell asset failing to precache shouldn't block install
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
  );
  self.clients.claim();
});

// Network-first for the shell itself (so a normal online reload always
// picks up a newer deployed version), falling back to the cached copy the
// instant the network is unreachable -- this is what lets the page even
// be OPENED while fully offline, not just survive a mid-session
// disconnect. Every other request (the real API) is left completely
// alone -- this worker never intercepts apiBase() calls.
self.addEventListener('fetch', (event) => {
  const url = event.request.url;
  const isShellRequest = SHELL_URLS.some((u) => url.endsWith(u.replace('./', '')) || url === u);
  if (!isShellRequest) return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
