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
 *    3. Cache-first for same-origin static assets. ⚠ The bundle
 *       filename is NOT cache-busted (`webclient-main.js` is fixed), so
 *       nothing invalidates on its own — `CACHE_NAME` is the ONLY lever.
 *       See DD#1.
 *    4. On install, pre-caches the closed-list shell so the next launch
 *       works offline without first hitting the assets via the page.
 *    5. On activate, sweeps caches whose names don't match the current
 *       `CACHE_NAME` — ensures a SW upgrade can't leave stale shells
 *       behind that paint old code with new data.
 *
 *  ── Key design decisions ───────────────────────────────────────────
 *
 *  DD#1 — Cache name carries a version suffix. A bundle deploy that
 *  changes shell contents MUST bump the suffix by hand, in this file,
 *  as part of that deploy.
 *
 *  ⚠ NOTHING AUTOMATES THIS. No buildscript stamps it (an earlier version
 *  of this comment claimed one did — it never existed). Two mechanisms have
 *  to fire and both key off these bytes:
 *    · the browser only re-runs `install`/`activate` when `sw.js` ITSELF
 *      differs byte-wise, and the suffix is the only thing that changes;
 *    · `activate` only evicts a cache whose name ≠ `CACHE_NAME`.
 *  Ship an unchanged `sw.js` and returning users keep serving the OLD
 *  bundle from the surviving cache for a full session (stale-while-
 *  revalidate repairs it only on the launch AFTER). That is a live
 *  old-client-vs-new-server skew window — it broke pack installs during
 *  the `recipe_refs` catalog drop (2026-07-23), which is why this is
 *  spelled out.
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

// v6 (2026-07-23) — the `recipe_refs` catalog drop. The new bundle tops pack
// membership up from `/packs/<slug>.json`; the v5 bundle still expects it in
// the meta catalog, so a client left on v5 fails every bundled-recipe install
// once the marketplace stops emitting it. Bumping evicts v5 on activate.
//
// v7 (2026-07-23) — Discover consumes server-side search (stage 2). The new
// bundle pages the catalogue from `/catalog/search` + `/catalog/versions`
// instead of downloading + reducing over the whole corpus; a client left on v6
// keeps downloading it. Bumping evicts v6 so the shell replaces itself (fixed
// filename behind a cache-first SW → the cache name is the only lever). ⚠ MUST
// match `WEBCLIENT_SHELL_CACHE_NAME` in `src/runtime/service-worker.ts` — a
// parity test enforces it.
// v8 (2026-08-03) — a live drive spent a full session one reload behind. The
// shell is cache-first with a FIXED bundle filename, so every reload serves the
// cached bundle and only refetches for the NEXT launch; across a day of
// client-side fixes the browser was never running the code being tested, and a
// press reported as dead could not be told apart from a press against last
// week's bundle. A real-browser Playwright click proved the press itself works
// (`e2e/pack-use-click.spec.ts`), which leaves the served bytes as the variable.
// Bumping evicts v7 on activate — the cache name is the only lever a fixed
// filename leaves. ⚠ MUST match `WEBCLIENT_SHELL_CACHE_NAME`; a parity test
// enforces it.
// v9 (2026-08-08) — `boot-shell.js` joins the shell. index.html's inline
// scripts moved into it because `script-src 'self'` was blocking all of them,
// including the fallback that reports a failed bundle load; a client left on v8
// caches an index.html that references a file its shell has never held. Bumping
// evicts v8 on activate.
// v10 (2026-08-12) — the WS bearer moved off the URL into
// `Sec-WebSocket-Protocol`. This one is not cosmetic: a client left on v9 sends
// `?token=` and a client on v10 sends the subprotocol, and the SERVER decides
// which it accepts. Until a server release carries the `extractRealm` change,
// a v10 client cannot connect to it at all — so the shell must replace itself
// promptly rather than linger a session behind, or a user upgrading their
// server would still be running the client that predates the change. Bumping
// evicts v9 on activate.
// v11 (2026-08-12) — v10 reached STAGING ONLY and was superseded before it ever
// shipped to production: a pre-deploy grep of the minified bundle showed the
// bearer was still being written into a URL by the four DATA sockets (upload /
// download / archive-upload), which v10's rpc-socket fix had not touched. v10's
// shell is therefore live on the staging origin with a bundle nobody should keep;
// bumping evicts it there and gives production a name that has never served
// anything else.
/** Every cache this app owns starts with this — the shell cache below and any
 *  future sibling. It is what distinguishes ours from everyone else's on the
 *  same origin, which is what makes the sweeps safe to run on a self-host
 *  origin the owner may share with another app.
 *
 *  ⚠ Deliberately `webclient-`, not `webclient-shell-`: the wipe's job is "our
 *  caches", not "our shell cache". Narrowing it to the shell would strand a
 *  sibling cache forever, which is the same class of silent leftover the
 *  version suffix exists to prevent. */
const CACHE_PREFIX = 'webclient-';
// ⚠ A BARE STRING LITERAL ON PURPOSE. `service-worker-cache-name-parity.test.ts`
// matches `/^const CACHE_NAME = '([^']+)';$/m` and fails loudly on a computed
// binding — deliberately, so the name it checks is provably the name the SW
// opens. Writing this as `` `${CACHE_PREFIX}v9` `` reddens that test rather than
// drifting silently, which is the behaviour you want; it just means the prefix
// relationship is asserted separately instead of expressed here.
const CACHE_NAME = 'webclient-shell-v27';

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
  // The pre-bundle shell script (theme-before-paint, splash reveal, SW
  // registration, bundle-failure fallback). External rather than inline so
  // `script-src 'self'` does not block it — see boot-shell.js's header. An
  // offline launch that misses it boots unthemed AND loses the fallback that
  // explains a missing bundle, so it belongs in the shell, not the runtime.
  './boot-shell.js',
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
          // ⚠ SCOPED SWEEP. This used to delete EVERY cache whose name wasn't
          // ours — on `app.recued.com` that is harmless (dedicated origin), but
          // a self-hosted server can share its origin with anything else the
          // owner runs, and "upgrade the webclient" is not consent to wipe a
          // neighbouring app's offline data. The prefix is what makes the
          // sweep OURS; a cache we did not create is not ours to evict.
          if (key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME) {
            return caches.delete(key);
          }
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
        // Scoped to OUR caches — see the activate sweep. "Clear this
        // browser" is a Recued control; on a shared self-host origin it must
        // not take a neighbouring app's offline data with it.
        const keys = await caches.keys();
        await Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX))
            .map((key) => caches.delete(key)),
        );
      })(),
    );
  }
});
