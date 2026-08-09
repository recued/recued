/** Pre-bundle shell behaviour: theme, splash reveal, service-worker
 *  registration, and the bundle-failure fallback.
 *
 *  ⛔ THIS FILE EXISTS BECAUSE OF CSP. All four behaviours below used to be
 *  INLINE in `index.html` — three `<script>` blocks plus an `onerror=` attribute
 *  on the module tag. Both surfaces that serve this shell send
 *  `script-src 'self'`:
 *
 *    · the self-host LAN handler (`backend/server/src/webclient-handler.ts`,
 *      whose CSP comment says, verbatim, "no inline scripts"), and
 *    · `app.recued.com` (`public/_headers`).
 *
 *  So every one of them was BLOCKED. Chromium recorded three CSP violations on
 *  a normal self-hosted load. The worst of them is the last: when
 *  `webclient-main.js` fails to load, the `onerror` fallback that upgrades the
 *  splash to an actionable message is itself blocked, so the user sits on
 *  "Loading…" forever — the precise outcome that fallback was written to
 *  prevent. A guard that cannot run is worse than no guard, because the comment
 *  above it says the case is handled.
 *
 *  ⚠ THE FIX IS AN EXTERNAL FILE, NOT A CSP HASH. `'sha256-…'` per block would
 *  work until the first edit, and then it fails silently and identically to
 *  today — the hash goes stale, the script is blocked, and nothing reddens. An
 *  external file is covered by `'self'` forever and needs nothing recomputed.
 *  The `onerror` ATTRIBUTE could not be hashed at all without `unsafe-hashes`;
 *  it is a capture-phase listener here instead.
 *
 *  ⚠ Load order matters and is why this is a plain (non-`defer`, non-`module`)
 *  script in `<head>`: it must run BEFORE first paint so the theme attribute
 *  lands without a flash, and before the module tag is parsed so the error
 *  listener is already attached when the bundle's load failure fires.
 *
 *  ⚠ Keep this dependency-free ES5-ish. It is the one script that has to run
 *  in a browser too old to parse the bundle — that is when its error message
 *  matters most.
 *
 *  ⚠ A new asset here needs an entry in `sw.js`'s `SHELL_URLS` and a
 *  `CACHE_NAME` bump, or an offline launch fetches it from a cache that has
 *  never held it.
 */

(function () {
  'use strict';

  // ── Theme, before first paint ────────────────────────────────────
  // 'system' (or no stored value) leaves no `data-theme`, so tokens.css's
  // prefers-color-scheme query governs. `shell/theme-controller.ts` keeps this
  // in sync once the bundle lands and owns the toggle.
  try {
    var t = localStorage.getItem('recued.theme');
    if (t === 'light' || t === 'dark') {
      document.documentElement.setAttribute('data-theme', t);
    }
  } catch (e) {
    /* storage blocked (private mode) — fall back to System. */
  }

  // ── Bundle-failure fallback ──────────────────────────────────────
  // Capture phase on `window`: resource `error` events do not bubble, and this
  // script runs before the module tag is parsed, so there is no element to
  // attach to yet. Filtering on the target's id keeps it to OUR script — an
  // image or stylesheet failing elsewhere must not paint a boot error.
  window.addEventListener(
    'error',
    function (event) {
      var target = event && event.target;
      if (!target || target.id !== 'webclient-main-script') return;
      var el = document.getElementById('webclient-boot-splash-message');
      if (el) {
        el.textContent =
          'Webclient bundle not loaded. Reload the page; if this persists the '
          + 'server is serving an incomplete bundle.';
      }
      var splash = document.getElementById('webclient-boot-splash');
      if (splash) splash.removeAttribute('data-recued-boot-pending');
    },
    true,
  );

  // ── Splash reveal ────────────────────────────────────────────────
  // A fast paired refresh should move into the shell without a one-frame
  // Loading flash; the CSS animation is the no-script fallback so slow/error
  // boots stay visible.
  setTimeout(function () {
    var splash = document.getElementById('webclient-boot-splash');
    if (splash) splash.removeAttribute('data-recued-boot-pending');
  }, 160);

  // ── Service worker ───────────────────────────────────────────────
  // Registered here rather than from the bundle so it starts as soon as the
  // HTML parses, independent of the (much larger) ESM bundle landing. The
  // bundle re-imports `registerServiceWorker` from `@recued/webclient` for the
  // programmatic API (Settings → Privacy "Clear this browser").
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(function () {
        /* non-fatal — the PWA still runs without offline caching. */
      });
    });
  }
})();
