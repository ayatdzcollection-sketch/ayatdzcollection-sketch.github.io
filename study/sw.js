/* Study Hub service worker.
 *
 * Lives at the hub root on purpose. A worker's scope cannot exceed its own directory
 * unless the server sends a Service-Worker-Allowed header, and GitHub Pages cannot, so
 * a worker under assets/ could never control view.html or m/**.
 *
 * Bump VERSION whenever you change a shell file (index.html, view.html, hub.css, hub.js,
 * sync.js, auth.js). Devices check for a new version on every load and whenever they
 * regain a connection, so a bump reaches them without anyone having to think about it.
 */
const VERSION = 'v9';
const SHELL_CACHE = 'studyhub-' + VERSION;
const FONT_CACHE  = 'studyhub-fonts';          // unversioned: fonts are immutable
const MAT_CACHE   = 'studyhub-materials';      // ciphertext; survives shell updates
const SCOPE = self.registration.scope;

const SHELL = [
  './', 'index.html', 'view.html',
  'assets/hub.css', 'assets/hub.js', 'assets/sync.js', 'assets/auth.js',
  'assets/app.webmanifest', 'assets/icon.svg'
].map(p => new URL(p, SCOPE).href);

const MATERIALS_PREFIX = new URL('m/', SCOPE).href;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    /* cache: 'reload' skips the browser's HTTP cache. GitHub Pages serves every file with a
       ten minute max-age, and a plain addAll was answered from that cache, so a bumped
       worker could install the previous build's hub.js under the new version and then
       serve it, cache-first, until the next bump. */
    await cache.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })));
  })());
  // No skipWaiting here: the page decides when to swap, so it never happens mid-keystroke.
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(k => k.startsWith('studyhub-') && k !== SHELL_CACHE && k !== FONT_CACHE && k !== MAT_CACHE)
      .map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

/* Answer from cache at once, refresh in the background. Plain cache-first would pin the
   first copy of a file forever, since a republish reuses the same URL. */
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  /* 'no-cache' revalidates with the server instead of the HTTP cache: a conditional GET
     that costs a 304 when nothing changed, and brings a republished material in on the
     next open rather than up to ten minutes later. */
  const network = fetch(new Request(request, { cache: 'no-cache' })).then(res => {
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

  // Google Fonts, so materials keep their typography offline after one online visit.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(cacheFirst(req, FONT_CACHE).catch(() => fetch(req)));
    return;
  }

  // Never cache Supabase. Sessions, keys and sync must always be a live decision.
  if (url.hostname.endsWith('.supabase.co')) return;

  if (url.origin !== location.origin || !req.url.startsWith(SCOPE)) return;

  // Encrypted materials. Safe to cache: without a key they are noise.
  if (req.url.startsWith(MATERIALS_PREFIX)) {
    event.respondWith(staleWhileRevalidate(req, MAT_CACHE));
    return;
  }

  event.respondWith((async () => {
    /* A material opens as view.html?m=<id>. The query is for the page's script, not the
       server, so it must match the precached view.html; without ignoreSearch it never did,
       and an offline open of a material fell through to the hub shell instead. */
    const cached = await caches.match(req, { ignoreSearch: req.mode === 'navigate' });
    if (cached) return cached;
    try {
      const res = await fetch(req);
      if (res && res.ok) {
        const cache = await caches.open(SHELL_CACHE);
        cache.put(req, res.clone());
      }
      return res;
    } catch (e) {
      if (req.mode === 'navigate') {
        const shell = await caches.match(new URL('./', SCOPE).href);
        if (shell) return shell;
      }
      throw e;
    }
  })());
});
