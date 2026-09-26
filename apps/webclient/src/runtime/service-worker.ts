/** D-148 § A.4 — service-worker registration helper.
 *
 *  The webclient's `public/sw.js` ships the actual cache logic; this
 *  module is the programmatic API the bundle uses to register +
 *  introspect + tear it down. The HTML's inline registration covers
 *  the boot-time case; the helper covers everything after:
 *
 *    - `registerServiceWorker(opts)` — re-register from the bundle so
 *      the returned handle (`update()`, `unregister()`,
 *      `clearCaches()`) is reachable from Settings → Privacy.
 *    - `unregisterServiceWorker()` — the "Clear this browser" leg that
 *      tears the SW down. Pairs with the storage-side
 *      `clearThisBrowser()` (see `auth/clear-this-browser.ts`).
 *    - `clearServiceWorkerCaches()` — wipe the SW's cache storage
 *      without unregistering the worker itself. Same surface, finer
 *      grain — the Settings → Privacy "Reset cache" affordance.
 *
 *  ── Key design decisions ───────────────────────────────────────────
 *
 *  DD#1 — The helper is environment-tolerant. `navigator.serviceWorker`
 *  is missing on:
 *    - HTTP origins (SW requires secure context),
 *    - older browsers,
 *    - the vitest jsdom env (tests inject `navigatorOverride`).
 *  Each public surface returns a no-op handle (or `false`) rather than
 *  throwing — the PWA still runs, just without offline caching.
 *
 *  DD#2 — Registration is idempotent. The HTML's inline registration
 *  fires on `window.load`; the bundle's `registerServiceWorker` call
 *  may fire later. We let `navigator.serviceWorker.register` dedupe
 *  via the URL match — it returns the same registration in that case.
 *
 *  DD#3 — `clearServiceWorkerCaches` uses the page-side `caches` API
 *  (when present), not a SW `postMessage`. The SW's `'clear-cache'`
 *  message handler exists for cases where the page wants the SW to
 *  also re-emit lifecycle events; the page-side wipe is sufficient
 *  on its own for the "Reset cache" UX and survives a SW that has
 *  unregistered itself.
 *
 *  Spec: D-148 § A.4 + `apps/webclient/public/sw.js`. */

/** Default service-worker script URL — sibling of `index.html` so the
 *  scope covers the whole webclient PWA. */
export const WEBCLIENT_SERVICE_WORKER_URL = './sw.js' as const;

/** Default scope — `./` resolves to the directory containing the
 *  registration call, which is the webclient root. */
export const WEBCLIENT_SERVICE_WORKER_SCOPE = './' as const;

/** Name of the cache `public/sw.js` opens for the shell assets. Exported
 *  here so the Settings → Privacy "Clear this browser" panel +
 *  `clearThisBrowser` default can target the *actual* shell cache. The SW
 *  file owns the upgrade semantics (bump the version suffix to invalidate
 *  prior shells); this constant has to follow it in the same commit.
 *
 *  ⚠ THIS IS A SECOND COPY, AND IT HAS ROTTED BEFORE — TWICE. `public/sw.js`
 *  is a static file served verbatim, so it cannot import this constant and
 *  nothing makes them agree. Pre-fold the default named a cache no SW had
 *  ever opened; it then drifted again (this said `v4` while the SW opened
 *  `v5`), and in both states the wipe deleted a non-existent cache and
 *  reported success — a privacy control that silently does nothing.
 *
 *  `service-worker-cache-name-parity.test.ts` now reads `public/sw.js` and
 *  fails if the two disagree. Bump BOTH or that test goes red. */
export const WEBCLIENT_SHELL_CACHE_NAME = 'webclient-shell-v30' as const;

/** The prefix every cache this app owns carries. Mirrors `CACHE_PREFIX` in
 *  `public/sw.js` — same second-copy hazard as the name above, same reason it
 *  cannot be imported. It is what makes the wipes below OURS: on
 *  `app.recued.com` the origin is dedicated and the distinction is academic,
 *  but a self-hosted server can share its origin with anything else the owner
 *  runs, and pressing a Recued privacy control is not consent to delete a
 *  neighbouring app's offline data. */
export const WEBCLIENT_CACHE_PREFIX = 'webclient-' as const;

/** Test-only seam — both the `navigator.serviceWorker` access path
 *  and the `caches` access path are overridable so the helper can be
 *  exercised in jsdom (which has neither). Production calls resolve
 *  these from `globalThis`. */
export interface ServiceWorkerEnvironment {
  navigator?: { serviceWorker?: ServiceWorkerContainerShape };
  caches?: CacheStorageShape;
  /** Absolute URL the registration scope resolves against. Production reads
   *  `globalThis.location.href`; tests pass one because jsdom's differs from
   *  the app's. Used to tell OUR service-worker registration from a
   *  neighbouring app's on a shared self-host origin. */
  baseUrl?: string;
}

/** Minimal subset of `ServiceWorkerContainer` the helper uses. */
export interface ServiceWorkerContainerShape {
  register(
    url: string,
    options?: { scope?: string },
  ): Promise<ServiceWorkerRegistrationShape>;
  getRegistration(scope?: string): Promise<ServiceWorkerRegistrationShape | undefined>;
  getRegistrations?(): Promise<ReadonlyArray<ServiceWorkerRegistrationShape>>;
}

/** Minimal subset of `ServiceWorkerRegistration` the helper uses. */
export interface ServiceWorkerRegistrationShape {
  scope: string;
  update(): Promise<void>;
  unregister(): Promise<boolean>;
}

/** Minimal subset of `CacheStorage` the helper uses. */
export interface CacheStorageShape {
  keys(): Promise<ReadonlyArray<string>>;
  delete(name: string): Promise<boolean>;
}

export interface RegisterServiceWorkerOptions {
  /** Override the SW script URL (defaults to `./sw.js`). */
  url?: string;
  /** Override the registration scope (defaults to `./`). */
  scope?: string;
  /** Test seam — production reads `globalThis.navigator.serviceWorker`
   *  + `globalThis.caches`. */
  environment?: ServiceWorkerEnvironment;
}

/** Handle returned by `registerServiceWorker` — exposes the operations
 *  the Settings → Privacy surface needs. A null-handle (`isRegistered:
 *  false`) is returned when the environment lacks SW support; all
 *  methods stay safe to call (they no-op + return `false`). */
export interface ServiceWorkerHandle {
  /** True iff registration succeeded. False covers both "browser has
   *  no SW support" and "registration rejected". */
  readonly isRegistered: boolean;
  /** Force a registration update — checks the SW URL for a new
   *  version. No-op when `isRegistered === false`. */
  update(): Promise<void>;
  /** Tear the SW down. Returns true iff the registration was actually
   *  unregistered (matches the platform `unregister()` semantics). */
  unregister(): Promise<boolean>;
  /** Wipe every cache the SW manages. Returns true iff at least one
   *  cache was deleted. Survives a SW that has already unregistered
   *  itself. */
  clearCaches(): Promise<boolean>;
}

const NULL_HANDLE: ServiceWorkerHandle = Object.freeze({
  isRegistered: false,
  async update() {
    /* no-op */
  },
  async unregister() {
    return false;
  },
  async clearCaches() {
    return false;
  },
});

const resolveContainer = (
  environment: ServiceWorkerEnvironment | undefined,
): ServiceWorkerContainerShape | null => {
  const navigatorOverride = environment?.navigator;
  if (navigatorOverride !== undefined) {
    return navigatorOverride?.serviceWorker ?? null;
  }
  // The platform `ServiceWorkerContainer` is a superset of our shape;
  // cast through unknown so the structural compare doesn't trip on
  // platform-only return types we don't surface (e.g.
  // `register(...): Promise<ServiceWorkerRegistration>`).
  const g = globalThis as unknown as {
    navigator?: { serviceWorker?: ServiceWorkerContainerShape };
  };
  return g.navigator?.serviceWorker ?? null;
};

const resolveCaches = (
  environment: ServiceWorkerEnvironment | undefined,
): CacheStorageShape | null => {
  if (environment && 'caches' in environment) {
    return environment.caches ?? null;
  }
  const g = globalThis as unknown as { caches?: CacheStorageShape };
  return g.caches ?? null;
};

/** Wipe the caches THIS APP owns, via the page-side `CacheStorage` API.
 *  Exported separately so the Settings → Privacy "Reset cache" surface
 *  can call it directly without going through `registerServiceWorker`.
 *
 *  ⚠ Scoped to `WEBCLIENT_CACHE_PREFIX`. This used to be
 *  `keys.map((key) => caches.delete(key))` over EVERY cache on the origin. */
export const clearServiceWorkerCaches = async (
  environment?: ServiceWorkerEnvironment,
): Promise<boolean> => {
  const caches = resolveCaches(environment);
  if (!caches) return false;
  const keys = (await caches.keys()).filter((key) => key.startsWith(WEBCLIENT_CACHE_PREFIX));
  if (keys.length === 0) return false;
  const results = await Promise.all(keys.map((key) => caches.delete(key)));
  return results.some((deleted) => deleted);
};

/** Resolve the absolute scope URL this app's service worker claims, or `null`
 *  when there is no base URL to resolve against (a non-browser environment, or
 *  a test that did not supply one). `null` means "cannot prove ownership", and
 *  every caller treats that as a reason to narrow, never to widen. */
const resolveOwnScope = (environment?: ServiceWorkerEnvironment): string | null => {
  const base = environment?.baseUrl
    ?? (globalThis as { location?: { href?: string } }).location?.href;
  if (!base) return null;
  try {
    return new URL(WEBCLIENT_SERVICE_WORKER_SCOPE, base).href;
  } catch {
    return null;
  }
};

/** Unregister every webclient-owned SW registration. Exported
 *  separately so the Settings → Privacy "Clear this browser" surface
 *  can call it without first re-registering. Returns true iff at least
 *  one registration was actually torn down. */
export const unregisterServiceWorker = async (
  environment?: ServiceWorkerEnvironment,
): Promise<boolean> => {
  const container = resolveContainer(environment);
  if (!container) return false;
  let any = false;
  // Prefer `getRegistrations` when available — covers the (rare) case
  // where multiple registrations coexist (e.g. a stale legacy SW
  // alongside the current one).
  //
  // ⚠ FILTERED BY SCOPE. `getRegistrations()` returns EVERY registration on the
  // origin, and this loop used to unregister all of them — the doc comment above
  // says "every webclient-owned SW registration", which was simply not what the
  // code did. On `app.recued.com` nothing else is registered so it never showed;
  // on a self-host origin shared with another app, "Clear this browser" tore
  // down that app's service worker too. A registration outside our scope is not
  // ours, and an unknown base URL means we cannot prove ownership — so that
  // case falls through to `getRegistration()`, which asks the platform for the
  // registration controlling THIS page and cannot over-reach.
  const ourScope = resolveOwnScope(environment);
  if (ourScope !== null && typeof container.getRegistrations === 'function') {
    const regs = await container.getRegistrations();
    for (const reg of regs) {
      if (!reg.scope.startsWith(ourScope)) continue;
      try {
        const result = await reg.unregister();
        if (result) any = true;
      } catch {
        /* swallow — other regs still need a chance */
      }
    }
    return any;
  }
  const reg = await container.getRegistration();
  if (!reg) return false;
  return reg.unregister();
};

/** Register the webclient service worker + return the operational
 *  handle. Idempotent — the platform dedupes by URL. Tolerant of
 *  environments without SW support (returns a null-handle whose
 *  methods all no-op). */
export const registerServiceWorker = async (
  options: RegisterServiceWorkerOptions = {},
): Promise<ServiceWorkerHandle> => {
  const container = resolveContainer(options.environment);
  if (!container) return NULL_HANDLE;
  const url = options.url ?? WEBCLIENT_SERVICE_WORKER_URL;
  const scope = options.scope ?? WEBCLIENT_SERVICE_WORKER_SCOPE;
  let registration: ServiceWorkerRegistrationShape;
  try {
    registration = await container.register(url, { scope });
  } catch {
    // DD#1 — SW registration failures are non-fatal.
    return NULL_HANDLE;
  }
  return {
    isRegistered: true,
    async update() {
      try {
        await registration.update();
      } catch {
        /* swallow — the next reload retries */
      }
    },
    async unregister() {
      try {
        return await registration.unregister();
      } catch {
        return false;
      }
    },
    async clearCaches() {
      return clearServiceWorkerCaches(options.environment);
    },
  };
};
