/** D-148 § A.4 — webclient service worker.
 *
 *  The webclient is a thin display + HID PWA over the user's paired
 *  recued-server. The service worker:
 *
 *    1. Caches the app shell (HTML + ESM bundle + manifest + static
 *       assets) so a cold load after the network drops still boots into
 *       the "Server unreachable" view rather than a blank page.
 *    2. Network-only for `*://*\/v1\/*`, `*://*\/ws*`, anything in
 *       `sessionStorage` (never reached here), or anything not under
 *       the SW's scope.
 *    3. Cache-first for same-origin static assets — the bundle's
 *       cache-busting filename invalidates old entries on deploy.
 *    4. On install, pre-caches the closed-list shell so the next launch
 *       works offline without first hitting the assets via the page.
 *    5. On activate, sweeps caches whose names don't match the current
 *       `CACHE_NAME` — ensures a SW upgrade can't leave stale shells
 *       behind that paint old code with new data.
 *
 *  ── Key design decisions ───────────────────────────────────────────
 *
 *  DD#1 — Cache name carries a version suffix. A bundle deploy that
 *  changes shell contents must bump the suffix so the activate sweep
 *  evicts the old shell. The buildscript stamps this in production;
 *  the source default is `webclient-shell-v1`.
 *
 *  DD#2 — `/v1/*` + `/ws*` are never cached. The webclient stores ZERO
 *  durable application state per spec § A.4.1 — caching the rpc /
 *  broadcast surfaces would create exactly the durable state the spec
 *  forbids. Network failures on those routes are user-visible (the
 *  ws-client surfaces them via state) and that's correct.
 *
 *  DD#3 — The SW does not intercept cross-origin requests. The
 *  webclient is hosted at `app.recued.com` and connects to user-paired
 *  servers at arbitrary hostnames; intercepting cross-origin would
 *  break the CORS preflight + give the SW visibility into bearer-
 *  carrying traffic it has no reason to touch.
 *
 *  DD#4 — Cache-first with stale-while-revalidate. A returning user
 *  gets an immediate cache hit; the background refetch updates the
 *  cache for the next launch. This trades freshness for offline-
 *  resilience, which matches the PWA install promise. */

const CACHE_NAME = 'webclient-shell-v5';

/** Pre-cache list — the app shell. Network-only for everything else.
 *  Adding a new shell asset requires an entry here + a `CACHE_NAME`
 *  bump so installs evict the old shell. */
const SHELL_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',
  // D-174 — the shell now <link>s the shared design tokens (render-blocking);
  // precache them so an offline launch isn't unstyled.
  './tokens.css',
  './webclient-main.js',
];

/** Hostnames + paths the SW must NEVER cache. Bearer-carrying or
 *  durable-state-bearing surfaces. `/oauth-callback` is in the list
 *  per Codex P2 fold — the D-148 § A.14 static-JS callback ferries
 *  one-shot `code` + `state` params that the callback flow already
 *  strips from history / logs; caching the request URL in
 *  `CacheStorage` would re-durably-persist the very tokens the
 *  callback was scrubbing.
 *
 *  `/webclient/oauth-callback` (R26.2 Option B) is the SELF-SERVE relay
 *  page this server's own bundle hosts for a loopback PWA — it carries the
 *  SAME one-shot `code` + `state` in its query, so it needs the SAME
 *  no-cache treatment (the `/oauth-callback` entry above does NOT cover it —
 *  this path starts with `/webclient/`). The prefix also covers the relay's
 *  `-relay.js` so the page + its script never skew across a bundle update;
 *  both are only ever loaded during an online OAuth flow, so not caching
 *  them costs nothing. */
const NEVER_CACHE_PATHS = ['/ws', '/v1/', '/oauth-callback', '/webclient/oauth-callback'];

const shouldNeverCache = (url) => {
  for (const path of NEVER_CACHE_PATHS) {
    if (url.pathname.startsWith(path)) return true;
  }
  return false;
};

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // Best-effort pre-cache — a missing shell asset (e.g. icon not
      // yet shipped) MUST NOT block the SW install. Each `add` is
      // independently tolerant.
      await Promise.all(
        SHELL_URLS.map(async (url) => {
          try {
            await cache.add(url);
          } catch {
            /* missing asset — fall through; runtime fetch will retry */
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) return caches.delete(key);
          return Promise.resolve(true);
        }),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // DD#3 — same-origin only.
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // DD#2 — never cache bearer/rpc/ws surfaces.
  if (shouldNeverCache(url)) return;
  // Only GETs are cacheable.
  if (req.method !== 'GET') return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req);
      // DD#4 — stale-while-revalidate.
      const fetchPromise = fetch(req)
        .then((res) => {
          // Only cache successful, basic-type responses to avoid
          // polluting the shell with opaque cross-origin or error
          // payloads.
          if (res && res.ok && res.type === 'basic') {
            cache.put(req, res.clone()).catch(() => {
              /* quota or write failure — runtime fall-through */
            });
          }
          return res;
        })
        .catch(() => null);
      if (cached) return cached;
      const fresh = await fetchPromise;
      if (fresh) return fresh;
      // Last resort — generic offline response so the page doesn't
      // get a TypeError on `.json()` etc.
      return new Response('', { status: 504, statusText: 'Offline' });
    })(),
  );
});

self.addEventListener('message', (event) => {
  // Allow the page to trigger a SW unregister via `postMessage` — the
  // Settings → Privacy "Clear this browser" flow already wipes IDB +
  // sessionStorage; this is the SW-cache leg.
  const data = event.data;
  if (data && data.type === 'clear-cache') {
    event.waitUntil(
      (async () => {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
      })(),
    );
  }
});
