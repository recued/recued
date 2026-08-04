/** D-148 § A.4.1 — "Clear this browser" panel (slice 109) acceptance.
 *
 *  Drives `mountClearThisBrowserPanel` through a fake Document so the
 *  test needs no jsdom — same pattern as `d-148-re-pair-overlay.test.ts`
 *  extended with the `firstChild` / `removeChild` plumbing the panel's
 *  render-rebuild relies on.
 *
 *  Covers:
 *   - construction throws when no document is available.
 *   - initial state is `idle` + renders the danger Clear button.
 *   - state machine: idle → confirm → busy → done (success).
 *   - state machine: confirm → idle on Cancel.
 *   - state machine: busy → error → confirm on Retry.
 *   - state machine: error → idle on Cancel.
 *   - done state renders one row per result + sw_unregistered flag.
 *   - clicking Reload fires the supplied `reloader` seam.
 *   - clicking Reload from `done` with no seam falls through to a
 *     global `location.reload` if present.
 *   - `onCleared` is invoked after success.
 *   - `unregisterServiceWorker` failure does NOT roll back the clear
 *     (lands in `done` with sw_unregistered=false).
 *   - dispose removes the panel from its host. */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CLEAR_THIS_BROWSER_CANCEL_BTN_ATTR,
  CLEAR_THIS_BROWSER_CLEAR_BTN_ATTR,
  CLEAR_THIS_BROWSER_CONFIRM_BTN_ATTR,
  CLEAR_THIS_BROWSER_PANEL_ATTR,
  CLEAR_THIS_BROWSER_PANEL_STATE_ATTR,
  CLEAR_THIS_BROWSER_RELOAD_BTN_ATTR,
  CLEAR_THIS_BROWSER_RESULT_ATTR,
  CLEAR_THIS_BROWSER_RETRY_BTN_ATTR,
  CLEAR_THIS_BROWSER_STATUS_ATTR,
  mountClearThisBrowserPanel,
  type MountClearThisBrowserPanelOptions,
} from '../settings/clear-this-browser-panel.js';
import {
  createInMemoryWebclientLocalStore,
  type WebclientLocalStore,
} from '../storage/local-store.js';

// ──────────────────────────────────────────────────────────────────
// Minimal fake DOM — extends the re-pair-overlay test pattern with
// `firstChild` + `removeChild` so the panel's render-rebuild loop
// can clear children between state transitions.
// ──────────────────────────────────────────────────────────────────

interface FakeElement {
  tagName: string;
  textContent: string;
  disabled: boolean;
  className: string;
  children: FakeElement[];
  parent: FakeElement | null;
  attrs: Map<string, string>;
  listeners: Map<string, Array<(ev: unknown) => void>>;
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(el: FakeElement): FakeElement;
  removeChild(el: FakeElement): FakeElement;
  readonly firstChild: FakeElement | null;
  remove(): void;
  addEventListener(name: string, fn: (ev: unknown) => void): void;
  removeEventListener(name: string, fn: (ev: unknown) => void): void;
  focus(): void;
  click(): void;
  type: string;
}

const makeFakeElement = (
  tagName: string,
  onFocus?: (element: FakeElement) => void,
): FakeElement => {
  const listeners = new Map<string, Array<(ev: unknown) => void>>();
  const attrs = new Map<string, string>();
  const children: FakeElement[] = [];
  const el: FakeElement = {
    tagName: tagName.toUpperCase(),
    textContent: '',
    disabled: false,
    className: '',
    type: '',
    children,
    parent: null,
    attrs,
    listeners,
    setAttribute: (k, v) => attrs.set(k, v),
    removeAttribute: (k) => attrs.delete(k),
    getAttribute: (k) => attrs.get(k) ?? null,
    hasAttribute: (k) => attrs.has(k),
    appendChild: (next) => {
      children.push(next);
      next.parent = el;
      return next;
    },
    removeChild: (target) => {
      const idx = children.indexOf(target);
      if (idx < 0) throw new Error('removeChild: not a child');
      children.splice(idx, 1);
      target.parent = null;
      return target;
    },
    get firstChild() {
      return children[0] ?? null;
    },
    remove: () => {
      if (el.parent) el.parent.removeChild(el);
    },
    addEventListener: (name, fn) => {
      const arr = listeners.get(name) ?? [];
      arr.push(fn);
      listeners.set(name, arr);
    },
    removeEventListener: (name, fn) => {
      const arr = listeners.get(name);
      if (!arr) return;
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    },
    focus: () => onFocus?.(el),
    click: () => {
      const arr = listeners.get('click') ?? [];
      for (const fn of arr) fn({ target: el });
    },
  };
  return el;
};

interface FakeDocument {
  activeElement: FakeElement | null;
  createElement(tag: string): FakeElement;
}

const makeFakeDocument = (): FakeDocument => {
  const doc: FakeDocument = {
    activeElement: null,
    createElement: (tag) => makeFakeElement(tag, (element) => {
      doc.activeElement = element;
    }),
  };
  return doc;
};

const findByAttr = (root: FakeElement, attr: string): FakeElement | null => {
  if (root.hasAttribute(attr)) return root;
  for (const c of root.children) {
    const hit = findByAttr(c, attr);
    if (hit) return hit;
  }
  return null;
};

const findAllByAttr = (root: FakeElement, attr: string): FakeElement[] => {
  const out: FakeElement[] = [];
  const walk = (node: FakeElement): void => {
    if (node.hasAttribute(attr)) out.push(node);
    for (const c of node.children) walk(c);
  };
  walk(root);
  return out;
};

// ──────────────────────────────────────────────────────────────────
// SW environment fakes
// ──────────────────────────────────────────────────────────────────

interface SwState {
  registrations: Array<{
    scope: string;
    update: () => Promise<void>;
    unregister: () => Promise<boolean>;
  }>;
  failUnregister?: boolean;
}

const makeSwEnvironment = (
  state: SwState,
): {
  container: {
    register: () => Promise<never>;
    getRegistration: () => Promise<undefined>;
    getRegistrations: () => Promise<SwState['registrations']>;
  };
  caches: {
    keys: () => Promise<string[]>;
    delete: (name: string) => Promise<boolean>;
  };
  unregistered: { count: number };
} => {
  const unregistered = { count: 0 };
  // patch each registration's unregister so the count is observable
  state.registrations = state.registrations.map((reg) => ({
    ...reg,
    unregister: async (): Promise<boolean> => {
      unregistered.count += 1;
      if (state.failUnregister) throw new Error('unregister failed');
      return true;
    },
  }));
  return {
    container: {
      register: async () => {
        throw new Error('not used by clear path');
      },
      getRegistration: async () => undefined,
      getRegistrations: async () => state.registrations,
    },
    caches: {
      keys: async () => [],
      delete: async () => false,
    },
    unregistered,
  };
};

// ──────────────────────────────────────────────────────────────────
// Setup helper
// ──────────────────────────────────────────────────────────────────

interface SetupOptions {
  withCryptoWiper?: boolean;
  reloader?: () => void;
  onCleared?: MountClearThisBrowserPanelOptions['onCleared'];
  failUnregister?: boolean;
  swRegistrations?: SwState['registrations'];
  injectClearThrow?: boolean;
}

interface SetupResult {
  host: FakeElement;
  doc: FakeDocument;
  localStore: WebclientLocalStore;
  cryptoWiped: { count: number };
  unregistered: { count: number };
  mount: ReturnType<typeof mountClearThisBrowserPanel>;
}

const setupMount = (overrides: SetupOptions = {}): SetupResult => {
  const host = makeFakeElement('div');
  const doc = makeFakeDocument();
  const localStore = overrides.injectClearThrow
    ? ({
        get: async () => null,
        set: async () => undefined,
        remove: async () => undefined,
        clear: async () => {
          throw new Error('idb clear blocked');
        },
        inspect: async () => ({
          server_url: null,
          webclient_token: null,
          server_public_key: null,
          pair_metadata: null,
          cert_pin_state: null,
        }),
      } as unknown as WebclientLocalStore)
    : createInMemoryWebclientLocalStore({
        server_url: 'wss://x',
        server_public_key: 'pk',
      });
  const cryptoWiped = { count: 0 };
  const sw = makeSwEnvironment({
    registrations:
      overrides.swRegistrations ??
      [
        {
          scope: './',
          update: async (): Promise<void> => undefined,
          unregister: async () => true,
        },
      ],
    failUnregister: overrides.failUnregister ?? false,
  });

  const mountOpts: MountClearThisBrowserPanelOptions = {
    host: host as unknown as HTMLElement,
    document: doc as unknown as Document,
    localStore,
    sw_environment: { navigator: { serviceWorker: sw.container }, caches: sw.caches },
    ...(overrides.reloader ? { reloader: overrides.reloader } : {}),
    ...(overrides.onCleared ? { onCleared: overrides.onCleared } : {}),
    ...(overrides.withCryptoWiper
      ? {
          crypto_keys_wiper: async () => {
            cryptoWiped.count += 1;
          },
        }
      : {}),
  };

  const mount = mountClearThisBrowserPanel(mountOpts);
  return {
    host,
    doc,
    localStore,
    cryptoWiped,
    unregistered: sw.unregistered,
    mount,
  };
};

// ══════════════════════════════════════════════════════════════════
// Construction
// ══════════════════════════════════════════════════════════════════

describe('D-148 § A.4.1 — mountClearThisBrowserPanel: construction', () => {
  const originalDoc = (globalThis as { document?: unknown }).document;
  afterEach(() => {
    (globalThis as { document?: unknown }).document = originalDoc;
  });

  it('throws when no document is available', () => {
    const host = makeFakeElement('div');
    (globalThis as { document?: unknown }).document = undefined;
    const localStore = createInMemoryWebclientLocalStore();
    expect(() =>
      mountClearThisBrowserPanel({
        host: host as unknown as HTMLElement,
        localStore,
      }),
    ).toThrow(/no document available/);
  });

  it('appends a single wrapper to the host with state="idle"', () => {
    const { host, mount } = setupMount();
    expect(host.children.length).toBe(1);
    const panel = findByAttr(host, CLEAR_THIS_BROWSER_PANEL_ATTR);
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute(CLEAR_THIS_BROWSER_PANEL_STATE_ATTR)).toBe('idle');
    expect(mount.getState()).toBe('idle');
  });

  it('idle state renders the danger Clear button + warning copy', () => {
    const { host } = setupMount();
    const btn = findByAttr(host, CLEAR_THIS_BROWSER_CLEAR_BTN_ATTR);
    expect(btn).not.toBeNull();
    expect(btn?.textContent).toBe('Clear this browser');
    expect(btn?.disabled).toBe(false);
    // No Confirm / Cancel buttons in idle.
    expect(findByAttr(host, CLEAR_THIS_BROWSER_CONFIRM_BTN_ATTR)).toBeNull();
    expect(findByAttr(host, CLEAR_THIS_BROWSER_CANCEL_BTN_ATTR)).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════
// State machine
// ══════════════════════════════════════════════════════════════════

describe('D-148 § A.4.1 — mountClearThisBrowserPanel: state machine', () => {
  it('transitions idle → confirm when Clear is clicked', () => {
    const { host, mount } = setupMount();
    mount.clickClear();
    expect(mount.getState()).toBe('confirm');
    const panel = findByAttr(host, CLEAR_THIS_BROWSER_PANEL_ATTR);
    expect(panel?.getAttribute(CLEAR_THIS_BROWSER_PANEL_STATE_ATTR)).toBe('confirm');
    expect(findByAttr(host, CLEAR_THIS_BROWSER_CONFIRM_BTN_ATTR)).not.toBeNull();
    expect(findByAttr(host, CLEAR_THIS_BROWSER_CANCEL_BTN_ATTR)).not.toBeNull();
  });

  it('keeps the keyboard safety loop on Cancel, then returns to Clear', () => {
    const { host, doc } = setupMount();
    const clear = findByAttr(host, CLEAR_THIS_BROWSER_CLEAR_BTN_ATTR)!;
    clear.focus();
    clear.click();

    const cancel = findByAttr(host, CLEAR_THIS_BROWSER_CANCEL_BTN_ATTR)!;
    expect(doc.activeElement).toBe(cancel);
    cancel.click();
    expect(doc.activeElement).toBe(
      findByAttr(host, CLEAR_THIS_BROWSER_CLEAR_BTN_ATTR),
    );
  });

  it('confirm state surfaces the confirm-question status with role=alert', () => {
    const { host, mount } = setupMount();
    mount.clickClear();
    const status = findByAttr(host, CLEAR_THIS_BROWSER_STATUS_ATTR);
    expect(status).not.toBeNull();
    expect(status?.getAttribute('role')).toBe('alert');
    expect(status?.textContent).toContain('Are you sure?');
  });

  it('transitions confirm → idle on Cancel', () => {
    const { mount } = setupMount();
    mount.clickClear();
    expect(mount.getState()).toBe('confirm');
    mount.clickCancel();
    expect(mount.getState()).toBe('idle');
  });

  it('transitions confirm → busy → done on Confirm (success path)', async () => {
    const { mount, localStore, unregistered } = setupMount({ withCryptoWiper: true });
    mount.clickClear();
    await mount.clickConfirm();
    expect(mount.getState()).toBe('done');
    // local store cleared:
    const after = await localStore.inspect();
    expect(after.server_url).toBeNull();
    expect(after.server_public_key).toBeNull();
    // sw unregistered:
    expect(unregistered.count).toBe(1);
  });

  it('done state renders one row per result + sw_unregistered=true', async () => {
    const { host, mount } = setupMount({ withCryptoWiper: true });
    mount.clickClear();
    await mount.clickConfirm();
    const list = findByAttr(host, CLEAR_THIS_BROWSER_RESULT_ATTR);
    expect(list).not.toBeNull();
    const rows = findAllByAttr(host, 'data-recued-clear-this-browser-row');
    expect(rows).toHaveLength(5);
    const byKey = new Map(rows.map((r) => [r.getAttribute('data-recued-clear-this-browser-row')!, r] as const));
    expect(byKey.get('cleared_local_store')?.getAttribute('data-cleared')).toBe('true');
    expect(byKey.get('cleared_session_storage')?.getAttribute('data-cleared')).toBe('true');
    expect(byKey.get('cleared_sw_caches')?.getAttribute('data-cleared')).toBe('true');
    expect(byKey.get('cleared_crypto_keys')?.getAttribute('data-cleared')).toBe('true');
    expect(byKey.get('sw_unregistered')?.getAttribute('data-cleared')).toBe('true');
  });

  it('done state reports cleared_crypto_keys=false when no wiper is supplied', async () => {
    const { host, mount } = setupMount({ withCryptoWiper: false });
    mount.clickClear();
    await mount.clickConfirm();
    const rows = findAllByAttr(host, 'data-recued-clear-this-browser-row');
    const byKey = new Map(rows.map((r) => [r.getAttribute('data-recued-clear-this-browser-row')!, r] as const));
    expect(byKey.get('cleared_crypto_keys')?.getAttribute('data-cleared')).toBe('false');
    expect(byKey.get('cleared_local_store')?.getAttribute('data-cleared')).toBe('true');
  });

  it('done state surfaces sw_unregistered=false when unregister throws', async () => {
    const { host, mount, unregistered } = setupMount({
      withCryptoWiper: true,
      failUnregister: true,
    });
    mount.clickClear();
    await mount.clickConfirm();
    expect(mount.getState()).toBe('done');
    expect(unregistered.count).toBe(1);
    const rows = findAllByAttr(host, 'data-recued-clear-this-browser-row');
    const byKey = new Map(rows.map((r) => [r.getAttribute('data-recued-clear-this-browser-row')!, r] as const));
    expect(byKey.get('sw_unregistered')?.getAttribute('data-cleared')).toBe('false');
    // The other clears still succeeded — invariant: SW unregister failure
    // does not roll back the local-store wipe.
    expect(byKey.get('cleared_local_store')?.getAttribute('data-cleared')).toBe('true');
  });

  it('transitions confirm → busy → error when clearThisBrowser throws', async () => {
    const { host, mount } = setupMount({ injectClearThrow: true });
    mount.clickClear();
    await mount.clickConfirm();
    expect(mount.getState()).toBe('error');
    const status = findByAttr(host, CLEAR_THIS_BROWSER_STATUS_ATTR);
    expect(status).not.toBeNull();
    expect(status?.getAttribute('role')).toBe('alert');
    expect(status?.textContent).toContain('idb clear blocked');
  });

  it('error state offers Retry → confirm', async () => {
    const { host, doc, mount } = setupMount({ injectClearThrow: true });
    mount.clickClear();
    await mount.clickConfirm();
    expect(mount.getState()).toBe('error');
    const retry = findByAttr(host, CLEAR_THIS_BROWSER_RETRY_BTN_ATTR)!;
    retry.focus();
    retry.click();
    expect(mount.getState()).toBe('confirm');
    expect(doc.activeElement).toBe(
      findByAttr(host, CLEAR_THIS_BROWSER_CANCEL_BTN_ATTR),
    );
  });

  it('error state offers Cancel → idle', async () => {
    const { host, doc, mount } = setupMount({ injectClearThrow: true });
    mount.clickClear();
    await mount.clickConfirm();
    expect(mount.getState()).toBe('error');
    const cancel = findByAttr(host, CLEAR_THIS_BROWSER_CANCEL_BTN_ATTR)!;
    cancel.focus();
    cancel.click();
    expect(mount.getState()).toBe('idle');
    expect(doc.activeElement).toBe(
      findByAttr(host, CLEAR_THIS_BROWSER_CLEAR_BTN_ATTR),
    );
  });

  it('Codex slice-109 P2 fold — error copy does not claim atomic rollback', async () => {
    // The pre-fold copy said "No state was changed", which was false for
    // any failure after `local_store.clear()` succeeded. The honest copy
    // acknowledges partial wipe + points the user at re-pair.
    const { host, mount } = setupMount({ injectClearThrow: true });
    mount.clickClear();
    await mount.clickConfirm();
    expect(mount.getState()).toBe('error');
    // Find the subtitle paragraph (sibling of the error status box) and
    // assert the new copy. The error subtitle is rendered as the second
    // paragraph in the error state (after the heading). Locate by class.
    const walk = (
      node: typeof host,
      visit: (n: typeof host) => void,
    ): void => {
      visit(node);
      for (const c of node.children) walk(c, visit);
    };
    let foundSubtitle = false;
    let foundOldCopy = false;
    walk(host, (n) => {
      if (n.className.includes('clear-this-browser-help')) {
        if (n.textContent.includes('may have been wiped before the error')) {
          foundSubtitle = true;
        }
        if (n.textContent.includes('No state was changed')) {
          foundOldCopy = true;
        }
      }
    });
    expect(foundSubtitle).toBe(true);
    expect(foundOldCopy).toBe(false);
  });

  it('busy state disables both Cancel + Confirm buttons', async () => {
    // Hold the localStore.clear() in a pending state so we can observe
    // the busy state mid-flight. We resolve manually.
    let resolveClear!: () => void;
    const slowStore = {
      get: async () => null,
      set: async () => undefined,
      remove: async () => undefined,
      clear: () =>
        new Promise<void>((r) => {
          resolveClear = r;
        }),
      inspect: async () => ({
        server_url: null,
        webclient_token: null,
        server_public_key: null,
        pair_metadata: null,
        cert_pin_state: null,
      }),
    } as unknown as WebclientLocalStore;

    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const sw = makeSwEnvironment({
      registrations: [
        {
          scope: './',
          update: async (): Promise<void> => undefined,
          unregister: async () => true,
        },
      ],
    });
    const mount = mountClearThisBrowserPanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: slowStore,
      sw_environment: { navigator: { serviceWorker: sw.container }, caches: sw.caches },
    });

    mount.clickClear();
    expect(mount.getState()).toBe('confirm');
    findByAttr(host, CLEAR_THIS_BROWSER_CONFIRM_BTN_ATTR)!.focus();
    const confirmPromise = mount.clickConfirm(); // do NOT await — keep clear() pending
    // After the click handler runs (sync) the state transitions to busy.
    expect(mount.getState()).toBe('busy');
    let status = findByAttr(host, CLEAR_THIS_BROWSER_STATUS_ATTR)!;
    expect(status.getAttribute('tabindex')).toBe('-1');
    expect(doc.activeElement).toBe(status);
    const confirmBtn = findByAttr(host, CLEAR_THIS_BROWSER_CONFIRM_BTN_ATTR);
    const cancelBtn = findByAttr(host, CLEAR_THIS_BROWSER_CANCEL_BTN_ATTR);
    expect(confirmBtn?.disabled).toBe(true);
    expect(cancelBtn?.disabled).toBe(true);
    // Resolve and let the panel finalize.
    resolveClear();
    await confirmPromise;
    expect(mount.getState()).toBe('done');
    status = findByAttr(host, CLEAR_THIS_BROWSER_STATUS_ATTR)!;
    expect(status.getAttribute('role')).toBe('status');
    expect(doc.activeElement).toBe(status);
  });
});

// ══════════════════════════════════════════════════════════════════
// Reload
// ══════════════════════════════════════════════════════════════════

describe('D-148 § A.4.1 — mountClearThisBrowserPanel: reload', () => {
  it('clicking Reload fires the supplied reloader seam', async () => {
    const reloader = vi.fn();
    const { host, mount } = setupMount({ withCryptoWiper: true, reloader });
    mount.clickClear();
    await mount.clickConfirm();
    expect(mount.getState()).toBe('done');
    const reloadBtn = findByAttr(host, CLEAR_THIS_BROWSER_RELOAD_BTN_ATTR);
    expect(reloadBtn).not.toBeNull();
    expect(reloader).not.toHaveBeenCalled();
    mount.clickReload();
    expect(reloader).toHaveBeenCalledTimes(1);
  });

  it('falls through to globalThis.location.reload when no reloader is supplied', async () => {
    const originalLoc = (globalThis as { location?: unknown }).location;
    let reloaded = 0;
    (globalThis as { location?: unknown }).location = {
      reload: () => {
        reloaded += 1;
      },
    };
    try {
      const { mount } = setupMount({ withCryptoWiper: true });
      mount.clickClear();
      await mount.clickConfirm();
      mount.clickReload();
      expect(reloaded).toBe(1);
    } finally {
      (globalThis as { location?: unknown }).location = originalLoc;
    }
  });

  it('reload no-ops gracefully when neither reloader nor location.reload exists', async () => {
    const originalLoc = (globalThis as { location?: unknown }).location;
    (globalThis as { location?: unknown }).location = undefined;
    try {
      const { mount } = setupMount({ withCryptoWiper: true });
      mount.clickClear();
      await mount.clickConfirm();
      expect(() => mount.clickReload()).not.toThrow();
      expect(mount.getState()).toBe('done');
    } finally {
      (globalThis as { location?: unknown }).location = originalLoc;
    }
  });
});

// ══════════════════════════════════════════════════════════════════
// onCleared callback
// ══════════════════════════════════════════════════════════════════

describe('D-148 § A.4.1 — mountClearThisBrowserPanel: onCleared', () => {
  it('invokes onCleared with the result + sw_unregistered flag', async () => {
    const onCleared = vi.fn();
    const { mount } = setupMount({ withCryptoWiper: true, onCleared });
    mount.clickClear();
    await mount.clickConfirm();
    expect(onCleared).toHaveBeenCalledTimes(1);
    const [result, sw_unregistered] = onCleared.mock.calls[0]!;
    expect(result.cleared_local_store).toBe(true);
    expect(result.cleared_crypto_keys).toBe(true);
    expect(sw_unregistered).toBe(true);
  });

  it('onCleared throw does not re-enter the panel + state stays done', async () => {
    const onCleared = vi.fn(() => {
      throw new Error('telemetry sink blew up');
    });
    const { mount } = setupMount({ withCryptoWiper: true, onCleared });
    mount.clickClear();
    await mount.clickConfirm();
    expect(mount.getState()).toBe('done');
  });

  it('onCleared is NOT invoked when the clear fails', async () => {
    const onCleared = vi.fn();
    const { mount } = setupMount({ injectClearThrow: true, onCleared });
    mount.clickClear();
    await mount.clickConfirm();
    expect(mount.getState()).toBe('error');
    expect(onCleared).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════
// Dispose
// ══════════════════════════════════════════════════════════════════

describe('D-148 § A.4.1 — mountClearThisBrowserPanel: dispose', () => {
  it('removes the wrapper from the host', () => {
    const { host, mount } = setupMount();
    expect(host.children.length).toBe(1);
    mount.dispose();
    expect(host.children.length).toBe(0);
  });

  it('dispose is idempotent', () => {
    const { mount } = setupMount();
    mount.dispose();
    expect(() => mount.dispose()).not.toThrow();
  });

  it('dispose mid-busy prevents further state updates', async () => {
    let resolveClear!: () => void;
    const slowStore = {
      get: async () => null,
      set: async () => undefined,
      remove: async () => undefined,
      clear: () =>
        new Promise<void>((r) => {
          resolveClear = r;
        }),
      inspect: async () => ({
        server_url: null,
        webclient_token: null,
        server_public_key: null,
        pair_metadata: null,
        cert_pin_state: null,
      }),
    } as unknown as WebclientLocalStore;

    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const sw = makeSwEnvironment({
      registrations: [
        {
          scope: './',
          update: async (): Promise<void> => undefined,
          unregister: async () => true,
        },
      ],
    });
    const mount = mountClearThisBrowserPanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: slowStore,
      sw_environment: { navigator: { serviceWorker: sw.container }, caches: sw.caches },
    });
    mount.clickClear();
    const pending = mount.clickConfirm();
    expect(mount.getState()).toBe('busy');
    mount.dispose();
    // Resolving after dispose must not throw / re-render.
    resolveClear();
    await pending;
    // Host still empty.
    expect(host.children.length).toBe(0);
  });
});
