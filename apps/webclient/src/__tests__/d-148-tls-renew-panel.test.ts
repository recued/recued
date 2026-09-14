/** D-148 § A.6.5 — TLS renew panel (slice 111) acceptance.
 *
 *  Drives `mountTlsRenewPanel` through a fake Document — same pattern
 *  as `d-148-clear-this-browser-panel.test.ts`, narrowed to the panel's
 *  rpc seam (`runRenew`) which the test injects as a controllable fake.
 *
 *  Covers:
 *    - construction throws when no document is available.
 *    - initial state is `idle` + renders the Renew button.
 *    - state machine: idle → confirm → busy → done (success).
 *    - state machine: idle → confirm → busy → error (rpc returned
 *      `{ ok: false, error: 'acme_helper_unavailable' }`).
 *    - state machine: idle → confirm → busy → error (rpc threw).
 *    - state machine: confirm → idle on Cancel.
 *    - state machine: error → confirm on Retry.
 *    - state machine: error → idle on Cancel.
 *    - state machine: done → idle on Close.
 *    - done state renders the new fingerprint + the scheduled flip time.
 *    - error state surfaces the ROTATION_ERROR_COPY remediation hint
 *      when the rpc returned a closed-list code.
 *    - error state surfaces the thrown error message when the rpc threw.
 *    - busy state disables both Cancel + Confirm buttons.
 *    - `onRenewed` is invoked with the success result.
 *    - `defaultReason` is forwarded to the rpc caller.
 *    - dispose removes the panel from its host. */

import { describe, expect, it, vi } from 'vitest';

import {
  TLS_RENEW_CANCEL_BTN_ATTR,
  TLS_RENEW_CLOSE_BTN_ATTR,
  TLS_RENEW_CONFIRM_BTN_ATTR,
  TLS_RENEW_ERROR_CODE_ATTR,
  TLS_RENEW_FINGERPRINT_ATTR,
  TLS_RENEW_PANEL_ATTR,
  TLS_RENEW_PANEL_STATE_ATTR,
  TLS_RENEW_RENEW_BTN_ATTR,
  TLS_RENEW_RETRY_BTN_ATTR,
  TLS_RENEW_ROTATED_AT_ATTR,
  TLS_RENEW_STATUS_ATTR,
  mountTlsRenewPanel,
  type MountTlsRenewPanelOptions,
  type TlsRenewCaller,
} from '../settings/tls-renew-panel.js';
import { ROTATION_ERROR_COPY } from '../settings/rotation-center.js';
import type { RotationResult } from '@recued/contracts';

// ──────────────────────────────────────────────────────────────────
// Fake DOM — same shape as the Privacy panel's test fake. The panel
// reads `children` for its `findBtn` walk; renders rebuild on every
// transition via `firstChild` + `removeChild`.
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
  click(): void;
  type: string;
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
      const arr = listeners.get('click') ?? [];
      for (const fn of arr) fn({ target: el });
    },
  };
  return el;
};

interface FakeDocument {
  createElement(tag: string): FakeElement;
}

const makeFakeDocument = (): FakeDocument => ({
  createElement: (tag) => makeFakeElement(tag),
});

const findByAttr = (root: FakeElement, attr: string): FakeElement | null => {
  if (root.hasAttribute(attr)) return root;
  for (const c of root.children) {
    const hit = findByAttr(c, attr);
    if (hit) return hit;
  }
  return null;
};

// ──────────────────────────────────────────────────────────────────
// Result builders
// ──────────────────────────────────────────────────────────────────

const SUCCESS_RESULT: Extract<RotationResult, { ok: true }> = {
  ok: true,
  op: 'tls_renew',
  key_class: 'tls_private_key',
  new_fingerprint: 'sha256:DEADBEEF',
  rotated_at: 1_800_000_000_000,
};

const FAILURE_RESULT = (
  error:
    | 'acme_helper_unavailable'
    | 'subscription_required'
    | 'rotation_in_progress'
    | 'storage_io_error',
  message?: string,
): Extract<RotationResult, { ok: false }> => ({
  ok: false,
  op: 'tls_renew',
  error,
  ...(message !== undefined ? { message } : {}),
});

// ──────────────────────────────────────────────────────────────────
// Setup helper
// ──────────────────────────────────────────────────────────────────

interface SetupOptions {
  caller?: TlsRenewCaller;
  defaultReason?: string;
  onRenewed?: MountTlsRenewPanelOptions['onRenewed'];
  now?: () => number;
}

interface SetupResult {
  host: FakeElement;
  doc: FakeDocument;
  mount: ReturnType<typeof mountTlsRenewPanel>;
  callerLog: Array<{ reason?: string }>;
}

const setupMount = (overrides: SetupOptions = {}): SetupResult => {
  const host = makeFakeElement('div');
  const doc = makeFakeDocument();
  const callerLog: Array<{ reason?: string }> = [];

  const defaultCaller: TlsRenewCaller = async (input) => {
    callerLog.push(input);
    return SUCCESS_RESULT;
  };

  const mount = mountTlsRenewPanel({
    host: host as unknown as HTMLElement,
    document: doc as unknown as Document,
    runRenew: overrides.caller ?? defaultCaller,
    ...(overrides.defaultReason !== undefined
      ? { defaultReason: overrides.defaultReason }
      : {}),
    ...(overrides.onRenewed !== undefined
      ? { onRenewed: overrides.onRenewed }
      : {}),
    ...(overrides.now !== undefined ? { now: overrides.now } : {}),
  });

  return { host, doc, mount, callerLog };
};

// ══════════════════════════════════════════════════════════════════
// Construction
// ══════════════════════════════════════════════════════════════════

describe('D-148 § A.6.5 — mountTlsRenewPanel: construction', () => {
  const originalDoc = (globalThis as { document?: unknown }).document;
  afterEach(() => {
    (globalThis as { document?: unknown }).document = originalDoc;
  });

  it('throws when no document is available', () => {
    const host = makeFakeElement('div');
    (globalThis as { document?: unknown }).document = undefined;
    expect(() =>
      mountTlsRenewPanel({
        host: host as unknown as HTMLElement,
        runRenew: async () => SUCCESS_RESULT,
      }),
    ).toThrow(/no document available/);
  });

  it('appends a single wrapper to the host with state="idle"', () => {
    const { host, mount } = setupMount();
    expect(host.children.length).toBe(1);
    const panel = findByAttr(host, TLS_RENEW_PANEL_ATTR);
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute(TLS_RENEW_PANEL_STATE_ATTR)).toBe('idle');
    expect(mount.getState()).toBe('idle');
  });

  it('idle state renders the primary Renew button + body copy', () => {
    const { host } = setupMount();
    const btn = findByAttr(host, TLS_RENEW_RENEW_BTN_ATTR);
    expect(btn).not.toBeNull();
    expect(btn?.textContent).toBe('Renew now');
    expect(btn?.disabled).toBe(false);
    expect(findByAttr(host, TLS_RENEW_CONFIRM_BTN_ATTR)).toBeNull();
    expect(findByAttr(host, TLS_RENEW_CANCEL_BTN_ATTR)).toBeNull();
  });
});

// vi shadow — vitest's `afterEach` import is hoisted at the top, but the
// construction block uses it. Re-import here so the describe scope sees
// the named hook even when the construction block runs alone.
import { afterEach } from 'vitest';

// ══════════════════════════════════════════════════════════════════
// State machine
// ══════════════════════════════════════════════════════════════════

describe('D-148 § A.6.5 — mountTlsRenewPanel: state machine', () => {
  it('transitions idle → confirm when Renew is clicked', () => {
    const { host, mount } = setupMount();
    mount.clickRenew();
    expect(mount.getState()).toBe('confirm');
    const panel = findByAttr(host, TLS_RENEW_PANEL_ATTR);
    expect(panel?.getAttribute(TLS_RENEW_PANEL_STATE_ATTR)).toBe('confirm');
    expect(findByAttr(host, TLS_RENEW_CONFIRM_BTN_ATTR)).not.toBeNull();
    expect(findByAttr(host, TLS_RENEW_CANCEL_BTN_ATTR)).not.toBeNull();
  });

  it('confirm state surfaces the confirm-body status with role=alert', () => {
    const { host, mount } = setupMount();
    mount.clickRenew();
    const status = findByAttr(host, TLS_RENEW_STATUS_ATTR);
    expect(status).not.toBeNull();
    expect(status?.getAttribute('role')).toBe('alert');
    // Body copy aligns with rotation-center's ROTATION_COPY.tls_renew.
    expect(status?.textContent).toContain('Recued gets one for you');
  });

  it('transitions confirm → idle on Cancel', () => {
    const { mount } = setupMount();
    mount.clickRenew();
    expect(mount.getState()).toBe('confirm');
    mount.clickCancel();
    expect(mount.getState()).toBe('idle');
  });

  it('transitions confirm → busy → done on Confirm (success path)', async () => {
    const { mount, callerLog } = setupMount();
    mount.clickRenew();
    await mount.clickConfirm();
    expect(mount.getState()).toBe('done');
    // Caller invoked exactly once with no reason (default omits reason).
    expect(callerLog).toHaveLength(1);
    expect(callerLog[0]).toEqual({});
  });

  it('done state renders the new fingerprint + scheduled flip time', async () => {
    const fixedNow = 1_799_396_000_000; // ~7d earlier than the result
    const { host, mount } = setupMount({ now: () => fixedNow });
    mount.clickRenew();
    await mount.clickConfirm();
    const fingerprint = findByAttr(host, TLS_RENEW_FINGERPRINT_ATTR);
    expect(fingerprint).not.toBeNull();
    expect(fingerprint?.textContent).toBe('sha256:DEADBEEF');
    const rotatedAt = findByAttr(host, TLS_RENEW_ROTATED_AT_ATTR);
    expect(rotatedAt).not.toBeNull();
    // Format includes the ISO timestamp + a ~Nd hint.
    expect(rotatedAt?.textContent).toContain('2027');
    expect(rotatedAt?.textContent).toContain('in ~');
    expect(rotatedAt?.textContent).toContain('d');
  });

  it('done state transitions back to idle on Close (DD#3 — not terminal)', async () => {
    const { mount } = setupMount();
    mount.clickRenew();
    await mount.clickConfirm();
    expect(mount.getState()).toBe('done');
    mount.clickClose();
    expect(mount.getState()).toBe('idle');
  });

  it('transitions confirm → busy → error when rpc returns { ok: false }', async () => {
    const { host, mount } = setupMount({
      caller: async () => FAILURE_RESULT('acme_helper_unavailable'),
    });
    mount.clickRenew();
    await mount.clickConfirm();
    expect(mount.getState()).toBe('error');
    // Remediation hint paragraph (the `tls-renew-help` class) carries the
    // ROTATION_ERROR_COPY copy verbatim. Walk for the hint paragraph
    // rather than checking the panel's flattened textContent (the fake
    // DOM doesn't aggregate child text).
    let hintText: string | null = null;
    const walk = (n: FakeElement): void => {
      if (
        n.className.includes('tls-renew-help') &&
        n.textContent.includes('ACME helper')
      ) {
        hintText = n.textContent;
      }
      for (const c of n.children) walk(c);
    };
    walk(host);
    expect(hintText).toBe(ROTATION_ERROR_COPY.acme_helper_unavailable);
    // Error box carries the closed-list code.
    const errBox = findByAttr(host, TLS_RENEW_STATUS_ATTR);
    expect(errBox?.getAttribute(TLS_RENEW_ERROR_CODE_ATTR)).toBe(
      'acme_helper_unavailable',
    );
  });

  it('error state surfaces error.message alongside the code when provided', async () => {
    const { host, mount } = setupMount({
      caller: async () =>
        FAILURE_RESULT('storage_io_error', 'ENOSPC: no disk space'),
    });
    mount.clickRenew();
    await mount.clickConfirm();
    const errBox = findByAttr(host, TLS_RENEW_STATUS_ATTR);
    expect(errBox?.textContent).toBe('storage_io_error: ENOSPC: no disk space');
  });

  it('transitions confirm → busy → error when rpc throws', async () => {
    const { host, mount } = setupMount({
      caller: async () => {
        throw new Error('ws connection lost');
      },
    });
    mount.clickRenew();
    await mount.clickConfirm();
    expect(mount.getState()).toBe('error');
    const errBox = findByAttr(host, TLS_RENEW_STATUS_ATTR);
    // Thrown errors have no closed-list code; the error box surfaces
    // the thrown message directly + the hint paragraph falls back to
    // the same message.
    expect(errBox?.hasAttribute(TLS_RENEW_ERROR_CODE_ATTR)).toBe(false);
    expect(errBox?.textContent).toBe('ws connection lost');
    // Hint paragraph (className 'tls-renew-help') falls back to the
    // thrown error message when no closed-list code is present.
    let hintText: string | null = null;
    const walk = (n: FakeElement): void => {
      if (
        n.className.includes('tls-renew-help') &&
        !n.hasAttribute(TLS_RENEW_STATUS_ATTR)
      ) {
        hintText = n.textContent;
      }
      for (const c of n.children) walk(c);
    };
    walk(host);
    expect(hintText).toBe('ws connection lost');
  });

  it('error state offers Retry → confirm', async () => {
    const { mount } = setupMount({
      caller: async () => FAILURE_RESULT('rotation_in_progress'),
    });
    mount.clickRenew();
    await mount.clickConfirm();
    expect(mount.getState()).toBe('error');
    mount.clickRetry();
    expect(mount.getState()).toBe('confirm');
  });

  it('error state offers Cancel → idle', async () => {
    const { mount } = setupMount({
      caller: async () => FAILURE_RESULT('rotation_in_progress'),
    });
    mount.clickRenew();
    await mount.clickConfirm();
    expect(mount.getState()).toBe('error');
    mount.clickCancel();
    expect(mount.getState()).toBe('idle');
  });

  it('busy state disables both Cancel + Confirm buttons', async () => {
    // Hold the rpc in a pending state so we can observe the busy state mid-flight.
    let resolveCaller!: (r: RotationResult) => void;
    const slow: TlsRenewCaller = () =>
      new Promise((res) => {
        resolveCaller = res;
      });
    const { host, mount } = setupMount({ caller: slow });
    mount.clickRenew();
    // Don't await yet — fire and inspect mid-flight.
    const inflight = mount.clickConfirm();
    expect(mount.getState()).toBe('busy');
    const cancelBtn = findByAttr(host, TLS_RENEW_CANCEL_BTN_ATTR);
    const confirmBtn = findByAttr(host, TLS_RENEW_CONFIRM_BTN_ATTR);
    expect(cancelBtn?.disabled).toBe(true);
    expect(confirmBtn?.disabled).toBe(true);
    // Release the in-flight rpc + await the resulting transition.
    resolveCaller(SUCCESS_RESULT);
    await inflight;
    expect(mount.getState()).toBe('done');
  });

  it('onRenewed is invoked with the success result after done', async () => {
    const onRenewed = vi.fn();
    const { mount } = setupMount({ onRenewed });
    mount.clickRenew();
    await mount.clickConfirm();
    expect(onRenewed).toHaveBeenCalledTimes(1);
    expect(onRenewed).toHaveBeenCalledWith(SUCCESS_RESULT);
  });

  it('onRenewed throw does not leak out of the panel', async () => {
    const onRenewed = vi.fn(() => {
      throw new Error('telemetry sink threw');
    });
    const { mount } = setupMount({ onRenewed });
    mount.clickRenew();
    await mount.clickConfirm();
    // Panel still lands in done; telemetry throw is swallowed.
    expect(mount.getState()).toBe('done');
  });

  it('defaultReason is forwarded to the rpc caller', async () => {
    const { mount, callerLog } = setupMount({ defaultReason: 'cron drift' });
    mount.clickRenew();
    await mount.clickConfirm();
    expect(callerLog).toEqual([{ reason: 'cron drift' }]);
  });
});

// ══════════════════════════════════════════════════════════════════
// Lifecycle
// ══════════════════════════════════════════════════════════════════

describe('D-148 § A.6.5 — mountTlsRenewPanel: lifecycle', () => {
  it('dispose removes the panel from its host', () => {
    const { host, mount } = setupMount();
    expect(host.children.length).toBe(1);
    mount.dispose();
    expect(host.children.length).toBe(0);
  });

  it('dispose is idempotent', () => {
    const { host, mount } = setupMount();
    mount.dispose();
    mount.dispose();
    expect(host.children.length).toBe(0);
  });

  it('dispose mid-rpc does not transition past busy', async () => {
    let resolveCaller!: (r: RotationResult) => void;
    const slow: TlsRenewCaller = () =>
      new Promise((res) => {
        resolveCaller = res;
      });
    const { mount } = setupMount({ caller: slow });
    mount.clickRenew();
    const inflight = mount.clickConfirm();
    expect(mount.getState()).toBe('busy');
    mount.dispose();
    // Resolve after dispose — state must NOT advance.
    resolveCaller(SUCCESS_RESULT);
    await inflight;
    expect(mount.getState()).toBe('busy');
  });
});
