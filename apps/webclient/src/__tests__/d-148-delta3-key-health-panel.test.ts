/** R26.4 Delta 3 (D-148 § A.11) — Key Health panel acceptance.
 *
 *  Drives `mountKeyHealthPanel` through the same fake Document the TLS
 *  renew panel test uses, narrowed to the two rpc seams (`loadHealth` /
 *  `runRotate`) injected as controllable fakes.
 *
 *  Covers:
 *    - construction throws when no document is available.
 *    - loads on mount → idle, renders one card per key class.
 *    - per-availability rendering: server_identity_key (available) shows
 *      Rotate + Mark-compromised; tls / webclient_token (managed) show a
 *      pointer note; master_dek etc (unavailable) show the greyed note +
 *      NO action buttons.
 *    - de-pair flow: rotate server_identity_key → confirm (warning) →
 *      done (re-pair variant, NO Close), for BOTH a resolved {ok:true}
 *      and a transport-family reject.
 *    - {ok:false} → error with the ROTATION_ERROR_COPY remediation.
 *    - NON-de-pair op (a crafted master_dek='available' view): rotate →
 *      confirm (no warning) → done (with Close) → Close re-loads; and a
 *      transport reject on a non-de-pair op → error (not false success).
 *    - compromise_alert banner renders.
 *    - load failure → load_error → Retry → idle.
 *    - cancel from confirm → idle; dispose removes the wrapper. */

import { afterEach, describe, expect, it } from 'vitest';

import {
  KEY_HEALTH_BACK_BTN_ATTR,
  KEY_HEALTH_CANCEL_BTN_ATTR,
  KEY_HEALTH_CARD_ATTR,
  KEY_HEALTH_CLOSE_BTN_ATTR,
  KEY_HEALTH_COMPROMISE_BANNER_ATTR,
  KEY_HEALTH_COMPROMISE_BTN_ATTR,
  KEY_HEALTH_ERROR_CODE_ATTR,
  KEY_HEALTH_PANEL_ATTR,
  KEY_HEALTH_PANEL_STATE_ATTR,
  KEY_HEALTH_RETRY_BTN_ATTR,
  KEY_HEALTH_ROTATE_BTN_ATTR,
  mountKeyHealthPanel,
  type KeyHealthLoader,
  type KeyRotateCaller,
} from '../settings/key-health-panel.js';
import { ROTATION_ERROR_COPY } from '../settings/rotation-center.js';
import type { KeyHealthView, RotationResult } from '@recued/contracts';

// ──────────────────────────────────────────────────────────────────
// Fake DOM (same shape as the TLS renew panel test)
// ──────────────────────────────────────────────────────────────────

interface FakeElement {
  tagName: string;
  textContent: string;
  disabled: boolean;
  className: string;
  type: string;
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
  click(): void;
}

const makeFakeElement = (tagName: string): FakeElement => {
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
    click: () => {
      for (const fn of listeners.get('click') ?? []) fn({ target: el });
    },
  };
  return el;
};

const makeFakeDocument = () => ({ createElement: (tag: string) => makeFakeElement(tag) });

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
  if (root.hasAttribute(attr)) out.push(root);
  for (const c of root.children) out.push(...findAllByAttr(c, attr));
  return out;
};

const textIncludes = (root: FakeElement, needle: string): boolean => {
  if (root.textContent.includes(needle)) return true;
  return root.children.some((c) => textIncludes(c, needle));
};

// ──────────────────────────────────────────────────────────────────
// View builders
// ──────────────────────────────────────────────────────────────────

const selfHostView = (
  overrides: Partial<KeyHealthView['availability']> = {},
  compromised: ReadonlyArray<keyof KeyHealthView['key_health']> = [],
): KeyHealthView => {
  const key_health = {
    master_dek: { status: 'healthy' as const },
    sub_dek: { status: 'healthy' as const },
    server_identity_key: { status: 'healthy' as const },
    publisher_identity_key: { status: 'healthy' as const },
    tls_private_key: { status: 'healthy' as const },
    webclient_token: { status: 'healthy' as const },
    webhook_secret: { status: 'healthy' as const },
  };
  for (const cls of compromised) key_health[cls] = { ...key_health[cls], compromise_alert: true } as never;
  return {
    key_health,
    availability: {
      master_dek: 'unavailable',
      sub_dek: 'unavailable',
      server_identity_key: 'available',
      publisher_identity_key: 'unavailable',
      tls_private_key: 'managed_elsewhere',
      webclient_token: 'managed_elsewhere',
      webhook_secret: 'unavailable',
      ...overrides,
    },
  };
};

const okResult = (op: RotationResult['op']): Extract<RotationResult, { ok: true }> =>
  ({
    ok: true,
    op,
    key_class: 'server_identity_key',
    repair_client_ids: ['dev-1'],
    rotated_at: 1_800_000_000_000,
  }) as Extract<RotationResult, { ok: true }>;

const transportError = (code: string): Error =>
  Object.assign(new Error('socket closed'), { code });

interface SetupOptions {
  loadHealth?: KeyHealthLoader;
  runRotate?: KeyRotateCaller;
}

const setup = (overrides: SetupOptions = {}) => {
  const host = makeFakeElement('div');
  const doc = makeFakeDocument();
  const rotateLog: Array<Parameters<KeyRotateCaller>[0]> = [];
  const loadHealth: KeyHealthLoader = overrides.loadHealth ?? (async () => selfHostView());
  const runRotate: KeyRotateCaller =
    overrides.runRotate ??
    (async (req) => {
      rotateLog.push(req);
      return okResult(req.op as RotationResult['op']);
    });
  const mount = mountKeyHealthPanel({
    host: host as unknown as HTMLElement,
    document: doc as unknown as Document,
    loadHealth,
    runRotate,
  });
  return { host, mount, rotateLog };
};

const stateOf = (host: FakeElement): string | null => {
  const panel = findByAttr(host, KEY_HEALTH_PANEL_ATTR);
  return panel?.getAttribute(KEY_HEALTH_PANEL_STATE_ATTR) ?? null;
};

// ══════════════════════════════════════════════════════════════════

describe('R26.4 Delta 3 — mountKeyHealthPanel: construction', () => {
  const originalDoc = (globalThis as { document?: unknown }).document;
  afterEach(() => {
    (globalThis as { document?: unknown }).document = originalDoc;
  });

  it('throws when no document is available', () => {
    (globalThis as { document?: unknown }).document = undefined;
    expect(() =>
      mountKeyHealthPanel({
        host: makeFakeElement('div') as unknown as HTMLElement,
        loadHealth: async () => selfHostView(),
        runRotate: async () => okResult('server_identity_rotate'),
      }),
    ).toThrow(/no document available/);
  });
});

describe('R26.4 Delta 3 — Key Health panel: load + render', () => {
  it('loads on mount → idle with one card per key class', async () => {
    const { host, mount } = setup();
    await mount.whenReady();
    expect(mount.getState()).toBe('idle');
    expect(findAllByAttr(host, KEY_HEALTH_CARD_ATTR)).toHaveLength(7);
  });

  it('server_identity_key (available) shows Rotate + Mark-compromised', async () => {
    const { host, mount } = setup();
    await mount.whenReady();
    expect(findByAttr(host, KEY_HEALTH_ROTATE_BTN_ATTR)?.getAttribute(KEY_HEALTH_ROTATE_BTN_ATTR)).toBe(
      'server_identity_key',
    );
    expect(
      findByAttr(host, KEY_HEALTH_COMPROMISE_BTN_ATTR)?.getAttribute(KEY_HEALTH_COMPROMISE_BTN_ATTR),
    ).toBe('server_identity_key');
  });

  it('unavailable classes render no action button', async () => {
    // Only server_identity_key is available in the self-host view → exactly
    // one rotate button + one compromise button across the whole list.
    const { host, mount } = setup();
    await mount.whenReady();
    expect(findAllByAttr(host, KEY_HEALTH_ROTATE_BTN_ATTR)).toHaveLength(1);
    expect(findAllByAttr(host, KEY_HEALTH_COMPROMISE_BTN_ATTR)).toHaveLength(1);
  });

  it('renders the compromise banner when a class is alerted', async () => {
    const { host, mount } = setup({ loadHealth: async () => selfHostView({}, ['master_dek']) });
    await mount.whenReady();
    expect(findByAttr(host, KEY_HEALTH_COMPROMISE_BANNER_ATTR)).not.toBeNull();
  });
});

describe('R26.4 Delta 3 — de-pair rotation flow', () => {
  it('rotate server_identity_key → confirm (warning) → done (re-pair, no Close) on {ok:true}', async () => {
    const { host, mount, rotateLog } = setup();
    await mount.whenReady();
    mount.clickRotate('server_identity_key');
    expect(mount.getState()).toBe('confirm');
    // The de-pair warning names the consequence ("signed out" is unique to
    // the depair_warning copy, not the base confirm body).
    const panel = findByAttr(host, KEY_HEALTH_PANEL_ATTR)!;
    expect(textIncludes(panel, 'signed out')).toBe(true);
    await mount.clickConfirm();
    expect(mount.getState()).toBe('done');
    expect(rotateLog).toEqual([{ op: 'server_identity_rotate' }]);
    // De-pair done is terminal — no Close button (the WS is gone).
    expect(findByAttr(host, KEY_HEALTH_CLOSE_BTN_ATTR)).toBeNull();
  });

  it('a transport-family reject on the de-pairing op is treated as committed (done)', async () => {
    const { mount } = setup({
      runRotate: async () => {
        throw transportError('transport_disposed');
      },
    });
    await mount.whenReady();
    mount.clickRotate('server_identity_key');
    await mount.clickConfirm();
    expect(mount.getState()).toBe('done');
  });

  it('mark_compromised(server_identity_key) dispatches the compromise op + de-pairs', async () => {
    const { mount, rotateLog } = setup();
    await mount.whenReady();
    mount.clickCompromise('server_identity_key');
    expect(mount.getState()).toBe('confirm');
    await mount.clickConfirm();
    expect(rotateLog).toEqual([{ op: 'mark_compromised', key_class: 'server_identity_key' }]);
    expect(mount.getState()).toBe('done');
  });

  it('{ok:false} → error with the remediation copy', async () => {
    const { host, mount } = setup({
      runRotate: async () => ({ ok: false, op: 'server_identity_rotate', error: 'rotation_in_progress' }),
    });
    await mount.whenReady();
    mount.clickRotate('server_identity_key');
    await mount.clickConfirm();
    expect(mount.getState()).toBe('error');
    expect(findByAttr(host, KEY_HEALTH_ERROR_CODE_ATTR)?.getAttribute(KEY_HEALTH_ERROR_CODE_ATTR)).toBe(
      'rotation_in_progress',
    );
    const panel = findByAttr(host, KEY_HEALTH_PANEL_ATTR)!;
    expect(textIncludes(panel, ROTATION_ERROR_COPY.rotation_in_progress)).toBe(true);
  });
});

describe('R26.4 Delta 3 — non-de-pair rotation flow (crafted master_dek=available)', () => {
  it('rotate → confirm (no de-pair warning) → done (with Close) → Close re-loads', async () => {
    let loads = 0;
    const calls: Array<Parameters<KeyRotateCaller>[0]> = [];
    const { host, mount } = setup({
      loadHealth: async () => {
        loads += 1;
        return selfHostView({ master_dek: 'available' });
      },
      runRotate: async (req) => {
        calls.push(req);
        return {
          ok: true,
          op: 'master_dek_rotate',
          key_class: 'master_dek',
          reencrypted_blob_count: 9,
          rotated_at: 1_800_000_000_000,
        };
      },
    });
    await mount.whenReady();
    expect(loads).toBe(1);
    mount.clickRotate('master_dek');
    expect(mount.getState()).toBe('confirm');
    // master_dek rotation does NOT de-pair → no "signed out" warning.
    const panel = findByAttr(host, KEY_HEALTH_PANEL_ATTR)!;
    expect(textIncludes(panel, 'signed out')).toBe(false);
    await mount.clickConfirm();
    expect(mount.getState()).toBe('done');
    expect(calls).toEqual([{ op: 'master_dek_rotate' }]);
    // Non-de-pair done HAS a Close that re-loads the view.
    expect(findByAttr(host, KEY_HEALTH_CLOSE_BTN_ATTR)).not.toBeNull();
    await mount.clickClose();
    expect(loads).toBe(2);
    expect(mount.getState()).toBe('idle');
  });

  it('a transport reject on a NON-de-pair op is a real error (not a false success)', async () => {
    const { mount } = setup({
      loadHealth: async () => selfHostView({ master_dek: 'available' }),
      runRotate: async () => {
        throw transportError('transport');
      },
    });
    await mount.whenReady();
    mount.clickRotate('master_dek');
    await mount.clickConfirm();
    expect(mount.getState()).toBe('error');
  });
});

describe('R26.4 Delta 3 — load error + navigation', () => {
  it('load failure → load_error → Retry → idle', async () => {
    let first = true;
    const { mount } = setup({
      loadHealth: async () => {
        if (first) {
          first = false;
          throw new Error('ws down');
        }
        return selfHostView();
      },
    });
    await mount.whenReady();
    expect(mount.getState()).toBe('load_error');
    await mount.clickRetry();
    expect(mount.getState()).toBe('idle');
  });

  it('cancel from confirm → idle', async () => {
    const { mount } = setup();
    await mount.whenReady();
    mount.clickRotate('server_identity_key');
    expect(mount.getState()).toBe('confirm');
    mount.clickCancel();
    expect(mount.getState()).toBe('idle');
  });

  it('error → Back → idle', async () => {
    const { host, mount } = setup({
      loadHealth: async () => selfHostView({ master_dek: 'available' }),
      runRotate: async () => ({ ok: false, op: 'master_dek_rotate', error: 'key_not_loaded' }),
    });
    await mount.whenReady();
    mount.clickRotate('master_dek');
    await mount.clickConfirm();
    expect(mount.getState()).toBe('error');
    findByAttr(host, KEY_HEALTH_BACK_BTN_ATTR)!.click();
    expect(mount.getState()).toBe('idle');
  });

  it('dispose removes the wrapper from the host', async () => {
    const { host, mount } = setup();
    await mount.whenReady();
    expect(host.children.length).toBe(1);
    mount.dispose();
    expect(host.children.length).toBe(0);
  });
});
