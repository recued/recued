/** D-148 § A.4 — service-worker registration helper.
 *
 *  Asserts the contract `registerServiceWorker` exposes:
 *
 *   - Idempotent registration; returns a typed handle.
 *   - Tolerant of environments without `navigator.serviceWorker` —
 *     returns a no-op handle whose methods all return `false`.
 *   - `update()` / `unregister()` / `clearCaches()` delegate correctly.
 *   - `clearServiceWorkerCaches` survives a missing `caches` global.
 *   - `unregisterServiceWorker` tears down every registration via
 *     `getRegistrations` when available, falls back to `getRegistration`.
 */

import { describe, expect, it } from 'vitest';

import {
  WEBCLIENT_SERVICE_WORKER_SCOPE,
  WEBCLIENT_SERVICE_WORKER_URL,
  clearServiceWorkerCaches,
  registerServiceWorker,
  unregisterServiceWorker,
  type CacheStorageShape,
  type ServiceWorkerContainerShape,
  type ServiceWorkerRegistrationShape,
} from '../runtime/service-worker.js';

interface FakeRegistrationControls {
  readonly reg: ServiceWorkerRegistrationShape;
  updateCount(): number;
  unregisterCount(): number;
  failUpdateOnce(err: Error): void;
  setUnregisterResult(result: boolean): void;
}

const buildFakeRegistration = (scope: string = WEBCLIENT_SERVICE_WORKER_SCOPE): FakeRegistrationControls => {
  let updates = 0;
  let unregs = 0;
  let unregResult = true;
  let updateErr: Error | null = null;
  return {
    reg: {
      scope,
      async update() {
        updates += 1;
        if (updateErr) {
          const err = updateErr;
          updateErr = null;
          throw err;
        }
      },
      async unregister() {
        unregs += 1;
        return unregResult;
      },
    },
    updateCount: () => updates,
    unregisterCount: () => unregs,
    failUpdateOnce(err) {
      updateErr = err;
    },
    setUnregisterResult(r) {
      unregResult = r;
    },
  };
};

interface FakeContainerControls {
  readonly container: ServiceWorkerContainerShape;
  registerCount(): number;
  lastRegisterArgs(): { url: string; scope?: string } | null;
  failRegisterOnce(err: Error): void;
  setRegistrations(regs: ReadonlyArray<ServiceWorkerRegistrationShape>): void;
  /** Disable `getRegistrations` to exercise the singular fallback. */
  disableGetRegistrations(): void;
}

const buildFakeContainer = (
  initial?: { reg?: ServiceWorkerRegistrationShape; regs?: ReadonlyArray<ServiceWorkerRegistrationShape> },
): FakeContainerControls => {
  let registers = 0;
  let lastArgs: { url: string; scope?: string } | null = null;
  let registerErr: Error | null = null;
  let regs: ServiceWorkerRegistrationShape[] = initial?.regs ? [...initial.regs] : [];
  let getRegistrationsEnabled = true;
  const reg = initial?.reg ?? buildFakeRegistration().reg;
  const container: ServiceWorkerContainerShape & {
    getRegistrations?: () => Promise<ReadonlyArray<ServiceWorkerRegistrationShape>>;
  } = {
    async register(url, options) {
      registers += 1;
      lastArgs = { url, scope: options?.scope };
      if (registerErr) {
        const err = registerErr;
        registerErr = null;
        throw err;
      }
      return reg;
    },
    async getRegistration() {
      return regs[0];
    },
  };
  // Conditionally expose `getRegistrations` so we can test both paths.
  Object.defineProperty(container, 'getRegistrations', {
    configurable: true,
    enumerable: true,
    get() {
      if (!getRegistrationsEnabled) return undefined;
      return async () => regs;
    },
  });
  return {
    container,
    registerCount: () => registers,
    lastRegisterArgs: () => lastArgs,
    failRegisterOnce(err) {
      registerErr = err;
    },
    setRegistrations(next) {
      regs = [...next];
    },
    disableGetRegistrations() {
      getRegistrationsEnabled = false;
    },
  };
};

const buildFakeCaches = (initial: ReadonlyArray<string> = []): {
  caches: CacheStorageShape;
  deleted: () => string[];
  setKeys: (keys: ReadonlyArray<string>) => void;
  setDeleteResult: (name: string, result: boolean) => void;
} => {
  let keys = [...initial];
  const deleted: string[] = [];
  const deleteResults = new Map<string, boolean>();
  return {
    caches: {
      async keys() {
        return [...keys];
      },
      async delete(name) {
        deleted.push(name);
        keys = keys.filter((k) => k !== name);
        return deleteResults.get(name) ?? true;
      },
    },
    deleted: () => [...deleted],
    setKeys(next) {
      keys = [...next];
    },
    setDeleteResult(name, result) {
      deleteResults.set(name, result);
    },
  };
};

describe('D-148 § A.4 — service-worker registration helper', () => {
  it('exports the documented constants', () => {
    expect(WEBCLIENT_SERVICE_WORKER_URL).toBe('./sw.js');
    expect(WEBCLIENT_SERVICE_WORKER_SCOPE).toBe('./');
  });

  it('returns a null-handle when navigator.serviceWorker is absent', async () => {
    const handle = await registerServiceWorker({ environment: { navigator: {} } });
    expect(handle.isRegistered).toBe(false);
    await expect(handle.update()).resolves.toBeUndefined();
    await expect(handle.unregister()).resolves.toBe(false);
    await expect(handle.clearCaches()).resolves.toBe(false);
  });

  it('registers + returns a typed handle when SW is supported', async () => {
    const reg = buildFakeRegistration();
    const ctl = buildFakeContainer({ reg: reg.reg });
    const handle = await registerServiceWorker({
      environment: { navigator: { serviceWorker: ctl.container } },
    });
    expect(handle.isRegistered).toBe(true);
    expect(ctl.registerCount()).toBe(1);
    expect(ctl.lastRegisterArgs()).toEqual({ url: './sw.js', scope: './' });
  });

  it('forwards a custom url + scope', async () => {
    const reg = buildFakeRegistration();
    const ctl = buildFakeContainer({ reg: reg.reg });
    await registerServiceWorker({
      url: '/custom/sw.js',
      scope: '/custom/',
      environment: { navigator: { serviceWorker: ctl.container } },
    });
    expect(ctl.lastRegisterArgs()).toEqual({ url: '/custom/sw.js', scope: '/custom/' });
  });

  it('returns a null-handle when registration throws', async () => {
    const ctl = buildFakeContainer();
    ctl.failRegisterOnce(new Error('insecure-context'));
    const handle = await registerServiceWorker({
      environment: { navigator: { serviceWorker: ctl.container } },
    });
    expect(handle.isRegistered).toBe(false);
    await expect(handle.unregister()).resolves.toBe(false);
  });

  it('update() forwards to the registration + swallows errors', async () => {
    const reg = buildFakeRegistration();
    const ctl = buildFakeContainer({ reg: reg.reg });
    const handle = await registerServiceWorker({
      environment: { navigator: { serviceWorker: ctl.container } },
    });
    await handle.update();
    expect(reg.updateCount()).toBe(1);

    reg.failUpdateOnce(new Error('network'));
    await expect(handle.update()).resolves.toBeUndefined();
    expect(reg.updateCount()).toBe(2);
  });

  it('unregister() forwards to the registration', async () => {
    const reg = buildFakeRegistration();
    const ctl = buildFakeContainer({ reg: reg.reg });
    const handle = await registerServiceWorker({
      environment: { navigator: { serviceWorker: ctl.container } },
    });
    reg.setUnregisterResult(true);
    await expect(handle.unregister()).resolves.toBe(true);
    expect(reg.unregisterCount()).toBe(1);
  });

  it('clearCaches() wipes every cache key', async () => {
    const reg = buildFakeRegistration();
    const ctl = buildFakeContainer({ reg: reg.reg });
    const fakeCaches = buildFakeCaches(['webclient-shell-v1', 'webclient-tmp']);
    const handle = await registerServiceWorker({
      environment: { navigator: { serviceWorker: ctl.container }, caches: fakeCaches.caches },
    });
    await expect(handle.clearCaches()).resolves.toBe(true);
    expect(fakeCaches.deleted()).toEqual(['webclient-shell-v1', 'webclient-tmp']);
  });

  it('clearServiceWorkerCaches returns false when there are no caches', async () => {
    const fakeCaches = buildFakeCaches([]);
    await expect(
      clearServiceWorkerCaches({ caches: fakeCaches.caches }),
    ).resolves.toBe(false);
  });

  it('clearServiceWorkerCaches returns false when caches global is missing', async () => {
    await expect(clearServiceWorkerCaches({ caches: undefined })).resolves.toBe(false);
  });

  // `getRegistrations()` returns EVERY registration on the ORIGIN, not just
  // ours, so ownership is decided by scope. These now carry resolvable scope
  // URLs (they were the bare strings 'a' / 'b') and the environment supplies the
  // `baseUrl` they resolve against — which is what the browser does for free and
  // what a node test has to say out loud.
  const BASE = 'https://app.recued.com/';

  it('unregisterServiceWorker uses getRegistrations when available', async () => {
    const r1 = buildFakeRegistration(BASE);
    const r2 = buildFakeRegistration(`${BASE}deeper/`);
    const ctl = buildFakeContainer({ regs: [r1.reg, r2.reg] });
    r1.setUnregisterResult(true);
    r2.setUnregisterResult(true);
    await expect(
      unregisterServiceWorker({ navigator: { serviceWorker: ctl.container }, baseUrl: BASE }),
    ).resolves.toBe(true);
    expect(r1.unregisterCount()).toBe(1);
    expect(r2.unregisterCount()).toBe(1);
  });

  it('unregisterServiceWorker leaves a FOREIGN-scope registration alone', async () => {
    // ⛔ THE DEFECT THIS PINS. The loop used to unregister every registration
    // `getRegistrations()` returned, while its doc comment claimed "every
    // webclient-owned SW registration". On `app.recued.com` nothing else is
    // registered, so it never showed; on a self-host origin shared with another
    // app, Settings → Privacy "Clear this browser" tore down that app's service
    // worker too. Use the input that would DO THE THING if the filter were gone.
    const ours = buildFakeRegistration(`${BASE}webclient/`);
    const theirs = buildFakeRegistration(`${BASE}someone-elses-app/`);
    const ctl = buildFakeContainer({ regs: [ours.reg, theirs.reg] });
    ours.setUnregisterResult(true);
    theirs.setUnregisterResult(true);
    await expect(
      unregisterServiceWorker({
        navigator: { serviceWorker: ctl.container },
        baseUrl: `${BASE}webclient/`,
      }),
    ).resolves.toBe(true);
    expect(ours.unregisterCount()).toBe(1);
    expect(theirs.unregisterCount(), 'a neighbouring app is not ours to unregister').toBe(0);
  });

  it('unregisterServiceWorker narrows to getRegistration when ownership is unprovable', async () => {
    // No `baseUrl` and no `globalThis.location` ⇒ scope cannot be resolved ⇒ we
    // cannot tell ours from theirs. That falls back to `getRegistration()`,
    // which asks the platform for the registration controlling THIS page and so
    // cannot over-reach. "Cannot prove ownership" narrows; it never widens.
    const r1 = buildFakeRegistration(BASE);
    const r2 = buildFakeRegistration(`${BASE}deeper/`);
    const ctl = buildFakeContainer({ regs: [r1.reg, r2.reg], reg: r1.reg });
    r1.setUnregisterResult(true);
    r2.setUnregisterResult(true);
    await expect(
      unregisterServiceWorker({ navigator: { serviceWorker: ctl.container } }),
    ).resolves.toBe(true);
    expect(r2.unregisterCount()).toBe(0);
  });

  it('unregisterServiceWorker reports false when nothing was unregistered', async () => {
    const r1 = buildFakeRegistration('a');
    const ctl = buildFakeContainer({ regs: [r1.reg] });
    r1.setUnregisterResult(false);
    await expect(
      unregisterServiceWorker({ navigator: { serviceWorker: ctl.container } }),
    ).resolves.toBe(false);
  });

  it('unregisterServiceWorker falls back to getRegistration when getRegistrations missing', async () => {
    const r1 = buildFakeRegistration('a');
    const ctl = buildFakeContainer({ regs: [r1.reg] });
    ctl.disableGetRegistrations();
    r1.setUnregisterResult(true);
    await expect(
      unregisterServiceWorker({ navigator: { serviceWorker: ctl.container } }),
    ).resolves.toBe(true);
  });

  it('unregisterServiceWorker is safe when no SW is registered', async () => {
    const ctl = buildFakeContainer({ regs: [] });
    ctl.disableGetRegistrations();
    await expect(
      unregisterServiceWorker({ navigator: { serviceWorker: ctl.container } }),
    ).resolves.toBe(false);
  });

  it('unregisterServiceWorker is safe when navigator lacks SW support', async () => {
    await expect(unregisterServiceWorker({ navigator: {} })).resolves.toBe(false);
  });

  it('unregisterServiceWorker swallows per-registration unregister failures', async () => {
    const r1 = buildFakeRegistration(BASE);
    const r2 = buildFakeRegistration(`${BASE}deeper/`);
    const ctl = buildFakeContainer({ regs: [r1.reg, r2.reg] });
    // r1 throws; r2 succeeds — the helper should still report true.
    r1.reg.unregister = async () => {
      throw new Error('boom');
    };
    r2.setUnregisterResult(true);
    await expect(
      unregisterServiceWorker({ navigator: { serviceWorker: ctl.container }, baseUrl: BASE }),
    ).resolves.toBe(true);
  });
});
