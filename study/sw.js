/* Study Hub service worker.
 *
 * Lives at the hub root on purpose. A worker's scope cannot exceed its own directory
 * unless the server sends a Service-Worker-Allowed header, and GitHub Pages cannot, so
 * a worker under assets/ could never control m/**.
 *
 * Bump VERSION whenever you change a shell file (index.html, hub.css, hub.js, sync.js).
 * Without a bump, browsers keep serving the cached copy.
 */
const VERSION = 'v1';
const SHELL_CACHE = 'studyhub-' + VERSION;
const FONT_CACHE  = 'studyhub-fonts';          // unversioned: fonts are immutable, keep them across updates
const SCOPE = self.registration.scope;

const SHELL = [
  './', 'index.html',
  'assets/hub.css', 'assets/hub.js', 'assets/sync.js',
  'assets/app.webmanifest', 'assets/icon.svg',
  'materials.json'
].map(p => new URL(p, SCOPE).href);

const MANIFEST_URL = new URL('materials.json', SCOPE).href;
const MATERIALS_PREFIX = new URL('m/', SCOPE).href;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(SHELL);
    // Pre-warm every listed material so one that was never opened still works offline.
    // Entirely best effort — a bad path must not fail the install.
    try {
      const res = await fetch(MANIFEST_URL, { cache: 'no-cache' });
      if (res.ok) {
        const data = await res.json();
        const paths = (data.classes || []).flatMap(c => (c.materials || []).map(m => m.path)).filter(Boolean);
        await Promise.allSettled(paths.map(p => cache.add(new URL(p, SCOPE).href)));
      }
    } catch (e) { /* offline install, or manifest not ready yet */ }
  })());
  // No skipWaiting here: updates are taken deliberately from the hub's Sync panel.
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(k => k.startsWith('studyhub-') && k !== SHELL_CACHE && k !== FONT_CACHE)
      .map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

async function networkFirst(request) {
  try {
    const res = await fetch(request);
    if (res && res.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put(request, res.clone());
    }
    return res;
  } catch (e) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw e;
  }
}

/* Answer from cache at once, refresh in the background. Plain cache-first would pin the
 * first copy of a material forever, since a git push reuses the same URL. */
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request).then(res => {
    if (res && (res.ok || res.type === 'opaque')) cache.put(request, res.clone());
    return res;
  }).catch(() => null);
  return cached || network.then(res => {
    if (res) return res;
    throw new Error('offline and not cached');
  });
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res && (res.ok || res.type === 'opaque')) cache.put(request, res.clone());
  return res;
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  // Google Fonts, so the quiz keeps its typography offline after one online visit.
  // The stylesheet arrives opaque (a plain <link> is a no-cors request); that is fine to
  // store and replay for the identical request. The woff2 files are CORS-clean.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(cacheFirst(req, FONT_CACHE).catch(() => fetch(req)));
    return;
  }

  if (url.origin !== location.origin || !req.url.startsWith(SCOPE)) return;

  // The manifest is the one file that must be fresh, or new materials never appear.
  if (req.url.split('?')[0] === MANIFEST_URL) {
    event.respondWith(networkFirst(req));
    return;
  }

  if (req.url.startsWith(MATERIALS_PREFIX)) {
    event.respondWith(staleWhileRevalidate(req, SHELL_CACHE));
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    try {
      const res = await fetch(req);
      if (res && res.ok) {
        const cache = await caches.open(SHELL_CACHE);
        cache.put(req, res.clone());
      }
      return res;
    } catch (e) {
      // An offline navigation with nothing cached should land on the hub, not a browser error.
      if (req.mode === 'navigate') {
        const shell = await caches.match(new URL('./', SCOPE).href);
        if (shell) return shell;
      }
      throw e;
    }
  })());
});
