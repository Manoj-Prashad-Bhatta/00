/* ═══════════════════════════════════════════════════════
   MaSu Peer — Service Worker
   Caches app shell for offline loading
═══════════════════════════════════════════════════════ */

const CACHE  = 'masupeer-v1';
const SHELL  = ['/', '/index.html', '/style.css', '/app.js',
                '/manifest.json'];

/* ── Install: pre-cache app shell ─────────────────────── */
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

/* ── Activate: remove old caches ──────────────────────── */
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

/* ── Fetch strategy ───────────────────────────────────── */
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Always fetch Firebase, CDN, and API calls from network
  if (url.hostname.includes('firebase') ||
      url.hostname.includes('googleapis') ||
      url.hostname.includes('gstatic') ||
      url.hostname.includes('unpkg') ||
      url.hostname.includes('metered') ||
      url.protocol === 'chrome-extension:') {
    return; // let browser handle it
  }

  // App shell: cache-first
  if (SHELL.some(s => url.pathname === s || url.pathname === '/')) {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request))
    );
    return;
  }

  // Everything else: network-first with cache fallback
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
