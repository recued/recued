/** R26.2 Delta 1 — Settings → Server → Exposure grid (`mountExposurePanel`).
 *
 *  Drives the panel through a node fake-Document (no jsdom — same shape
 *  as the TLS-renew / key-health panel tests, extended with input
 *  `value` / `checked` + change-on-click so the radios + checkboxes fire
 *  their `change` handlers).
 *
 *  Covers:
 *    - cold load hydrates from `runGet` (preset rows + the per-path grid,
 *      incl. the /mcp + /reception rows the owner couldn't find).
 *    - `runGet` rejection → load-error banner → Retry refetches.
 *    - preset radio → `exposure.apply_preset` (direct, no gate).
 *    - /reception public cell → `exposure.set_path_resolution` (the
 *      reception on/off — direct, no gate).
 *    - /mcp public cell while unacknowledged → opens the public-MCP
 *      modal (NO rpc yet); phrase + submit → ack rpc THEN the chained
 *      path-set that flips /mcp.public on (DD#4).
 *    - /ws going fully off → opens the /ws lockout modal; phrase +
 *      submit → set_path_resolution carrying the lockout phrase.
 *    - public-MCP card button opens the acknowledge / revoke modal.
 *    - `exposure_changed` broadcast applies live (remaps changed_at).
 *    - no DDNS → the public preset renders disabled (requires_ddns).
 *    - dispose removes the panel + unsubscribes. */

import { afterEach, describe, expect, it } from 'vitest';
import {
  PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE,
  WS_LOCKOUT_DISCONNECT_PHRASE,
  type ExposureState,
  type PathResolution,
  type PathRole,
  type PublicMcpAcknowledgement,
  type RootApexMode,
} from '@recued/contracts';
import {
  EXPOSURE_APEX_ROW_ATTR,
  EXPOSURE_APEX_WARNING_ATTR,
  EXPOSURE_CELL_ATTR,
  EXPOSURE_LOAD_ERROR_ATTR,
  EXPOSURE_MODAL_ATTR,
  EXPOSURE_PANEL_ATTR,
  EXPOSURE_PANEL_STYLES,
  EXPOSURE_PATH_ROW_ATTR,
  EXPOSURE_PRESET_ROW_ATTR,
  EXPOSURE_PUBLIC_MCP_BTN_ATTR,
  mountExposurePanel,
  EXPOSURE_CONNECT_BTN_ATTR,
  EXPOSURE_CONNECT_MODAL_ATTR,
  EXPOSURE_CONNECT_SNIPPET_ATTR,
  type ExposureMutationResponse,
} from '../settings/exposure-panel.js';
import { PUBLIC_MCP_MODAL_COPY } from '../settings/public-mcp-modal.js';

// ──────────────────────────────────────────────────────────────────
// Fake DOM — TLS-renew panel shape + input value/checked + change-on-
// click (browsers fire `change` when a checkbox / radio is clicked).
// ──────────────────────────────────────────────────────────────────

interface FakeElement {
  tagName: string;
  textContent: string;
  disabled: boolean;
  checked: boolean;
  value: string;
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
    checked: false,
    value: '',
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
      // A real click on an input fires both click + change.
      for (const fn of listeners.get('click') ?? []) fn({ target: el });
      for (const fn of listeners.get('change') ?? []) fn({ target: el });
    },
  };
  return el;
};

const makeFakeDocument = () => ({
  createElement: (tag: string) => makeFakeElement(tag),
});

const findByAttr = (
  root: FakeElement,
  attr: string,
  value?: string,
): FakeElement | null => {
  if (root.hasAttribute(attr) && (value === undefined || root.getAttribute(attr) === value)) {
    return root;
  }
  for (const c of root.children) {
    const hit = findByAttr(c, attr, value);
    if (hit) return hit;
  }
  return null;
};

const collectText = (root: FakeElement): string => {
  let out = root.textContent ?? '';
  for (const c of root.children) out += ` ${collectText(c)}`;
  return out;
};

// ──────────────────────────────────────────────────────────────────
// State builders
// ──────────────────────────────────────────────────────────────────

const ackOff = (): PublicMcpAcknowledgement => ({ acknowledged: false });
const ackOn = (): PublicMcpAcknowledgement => ({
  acknowledged: true,
  acknowledged_at: 1000,
  acknowledged_by_client_id: 'cli',
  free_text_confirmation: PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE,
});

const resolution = (
  override: Partial<Record<PathRole, PathResolution>> = {},
): Record<PathRole, PathResolution> => ({
  health: { lan: true, public: false },
  ws: { lan: true, public: false },
  mcp: { lan: true, public: false },
  llm_gateway: { lan: true, public: false },
  webhooks: { lan: false, public: false },
  reception: { lan: false, public: false },
  oauth: { lan: false, public: false },
  ask: { lan: false, public: false },
  webclient: { lan: true, public: false },
  ...override,
});

const buildState = (over: Partial<ExposureState> = {}): ExposureState => ({
  resolution: resolution(),
  derived_preset_label: 'lan_only',
  public_mcp_acknowledgement: ackOff(),
  last_changed_at: 1_000,
  changed_by_client_id: 'cli',
  ...over,
});

const okResponse = (state: ExposureState): ExposureMutationResponse => ({
  state,
  clients_disconnected: 0,
});

// ──────────────────────────────────────────────────────────────────
// Setup
// ──────────────────────────────────────────────────────────────────

interface SetupOpts {
  state?: ExposureState;
  hasDdns?: boolean;
  getRejects?: boolean;
  applyPresetState?: ExposureState;
  setPathState?: ExposureState;
  setAckState?: ExposureState;
  withSubscribe?: boolean;
  apexMode?: RootApexMode;
  /** When set, runSetApex rejects with an error carrying this `code`. */
  setApexRejectCode?: string;
  /** Omit runSetApex entirely (read-only picker). */
  noSetApex?: boolean;
  /** Paired server URL for the "Connection example" button. Absent ⇒ the
   *  button does not render, which is the production fail-quiet. */
  serverUrl?: string;
}

const setup = async (over: SetupOpts = {}) => {
  const host = makeFakeElement('div');
  const doc = makeFakeDocument();
  const initial = over.state ?? buildState();
  const calls = {
    get: 0,
    applyPreset: [] as Array<{ preset: string; lockout_confirmation_phrase?: string }>,
    setPath: [] as Array<{ path: string; resolution: PathResolution; lockout_confirmation_phrase?: string }>,
    setAck: [] as Array<{ acknowledge: boolean; free_text_confirmation?: string }>,
    setApex: [] as Array<{ apex_mode: RootApexMode }>,
    hasDdns: 0,
    unsubscribe: 0,
  };
  let getRejects = over.getRejects ?? false;

  const subscribers: Array<{ kind: string; cb: (evt: unknown) => void }> = [];
  const subscribe = over.withSubscribe === false
    ? undefined
    : (kind: string, cb: (evt: unknown) => void) => {
        subscribers.push({ kind, cb });
        return () => {
          calls.unsubscribe += 1;
        };
      };

  const mount = mountExposurePanel({
    host: host as unknown as HTMLElement,
    document: doc as unknown as Document,
    ...(over.serverUrl !== undefined ? { getServerUrl: () => over.serverUrl } : {}),
    runGet: async () => {
      calls.get += 1;
      if (getRejects) throw new Error('boom');
      return { state: initial, apex_mode: over.apexMode ?? 'redirect' };
    },
    ...(over.noSetApex
      ? {}
      : {
          runSetApex: async (req: { apex_mode: RootApexMode }) => {
            calls.setApex.push(req);
            if (over.setApexRejectCode) {
              throw Object.assign(new Error('rejected'), {
                code: over.setApexRejectCode,
              });
            }
            return { apex_mode: req.apex_mode };
          },
        }),
    runApplyPreset: async (req) => {
      calls.applyPreset.push(req);
      return okResponse(over.applyPresetState ?? buildState({ derived_preset_label: req.preset }));
    },
    runSetPathResolution: async (req) => {
      calls.setPath.push(req);
      return okResponse(
        over.setPathState ??
          buildState({ resolution: resolution({ [req.path]: req.resolution }) }),
      );
    },
    runSetPublicMcpAck: async (req) => {
      calls.setAck.push(req);
      return okResponse(
        over.setAckState ??
          buildState({ public_mcp_acknowledgement: req.acknowledge ? ackOn() : ackOff() }),
      );
    },
    runHasDdns: async () => {
      calls.hasDdns += 1;
      return over.hasDdns ?? true;
    },
    ...(subscribe !== undefined ? { subscribe: subscribe as never } : {}),
  });

  // Deterministic initial load (the constructor also fires it; refresh is
  // idempotent). Reset the read counters so per-test assertions are clean.
  await mount.refresh();
  calls.get = 0;
  calls.hasDdns = 0;

  const fireBroadcast = (evt: unknown): void => {
    for (const s of subscribers) {
      if (s.kind === 'exposure_changed') s.cb(evt);
    }
  };
  const setGetRejects = (v: boolean): void => {
    getRejects = v;
  };

  return { host, doc, mount, calls, fireBroadcast, setGetRejects, subscribers };
};

afterEach(() => {
  // The panel reads `globalThis.document` only when `opts.document` is
  // omitted; every test injects the fake, so nothing global to restore.
});

// ══════════════════════════════════════════════════════════════════
// Cold load
// ══════════════════════════════════════════════════════════════════

describe('R26.2 Delta 1 — mountExposurePanel: cold load', () => {
  it('throws when no document is available', () => {
    const host = makeFakeElement('div');
    const original = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = undefined;
    try {
      expect(() =>
        mountExposurePanel({
          host: host as unknown as HTMLElement,
          runGet: async () => ({ state: buildState(), apex_mode: 'redirect' as const }),
          runApplyPreset: async () => okResponse(buildState()),
          runSetPathResolution: async () => okResponse(buildState()),
          runSetPublicMcpAck: async () => okResponse(buildState()),
        }),
      ).toThrow(/no document available/);
    } finally {
      (globalThis as { document?: unknown }).document = original;
    }
  });

  it('hydrates the preset rows + the per-path grid from runGet', async () => {
    const { host, mount } = await setup();
    expect(findByAttr(host, EXPOSURE_PANEL_ATTR)).not.toBeNull();
    // Three presets.
    for (const p of ['lan_only', 'public', 'maintenance']) {
      expect(findByAttr(host, EXPOSURE_PRESET_ROW_ATTR, p)).not.toBeNull();
    }
    // Every path role row — incl. the /mcp + /reception rows.
    for (const path of ['health', 'ws', 'mcp', 'webhooks', 'reception', 'oauth', 'ask']) {
      expect(findByAttr(host, EXPOSURE_PATH_ROW_ATTR, path)).not.toBeNull();
    }
    const receptionPublic = findByAttr(host, EXPOSURE_CELL_ATTR, 'reception.public');
    expect(receptionPublic).not.toBeNull();
    expect(receptionPublic?.parent?.tagName).toBe('LABEL');
    expect(receptionPublic?.parent?.className).toContain('exposure-cell-target');
    expect(findByAttr(host, EXPOSURE_CELL_ATTR, 'mcp.public')).not.toBeNull();
    expect(EXPOSURE_PANEL_STYLES).toMatch(
      /\.exposure-cell-target\s*\{[^}]*min-width:\s*36px[^}]*min-height:\s*36px/s,
    );
    expect(mount.getState().state?.derived_preset_label).toBe('lan_only');
  });

  it('surfaces a load-error banner when runGet rejects, then Retry recovers', async () => {
    const { host, mount, setGetRejects } = await setup({ getRejects: true });
    expect(findByAttr(host, EXPOSURE_LOAD_ERROR_ATTR)).not.toBeNull();
    expect(mount.getState().loadError).not.toBeNull();
    // Retry once the read recovers.
    setGetRejects(false);
    await mount.refresh();
    expect(findByAttr(host, EXPOSURE_LOAD_ERROR_ATTR)).toBeNull();
    expect(mount.getState().state).not.toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════
// Direct (ungated) actions
// ══════════════════════════════════════════════════════════════════

describe('R26.2 Delta 1 — direct preset + grid actions', () => {
  it('applies a preset directly (no gate) and reflects the returned state', async () => {
    const { mount, calls } = await setup();
    mount.clickPreset('public');
    await mount.settle();
    expect(calls.applyPreset).toEqual([{ preset: 'public' }]);
    expect(mount.getState().state?.derived_preset_label).toBe('public');
  });

  it('toggles /reception public via set_path_resolution (the reception on/off)', async () => {
    const { mount, calls } = await setup();
    mount.clickCell('reception', 'public');
    await mount.settle();
    expect(calls.setPath).toHaveLength(1);
    expect(calls.setPath[0]).toMatchObject({
      path: 'reception',
      resolution: { lan: false, public: true },
    });
    // No lockout phrase on an ungated path.
    expect(calls.setPath[0]?.lockout_confirmation_phrase).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════
// /mcp.public acknowledgement gate (DD#4)
// ══════════════════════════════════════════════════════════════════

describe('R26.2 Delta 1 — /mcp.public ack gate', () => {
  it('opens the public-MCP modal (no rpc) then acks + chains the path-set', async () => {
    const { host, mount, calls } = await setup();
    mount.clickCell('mcp', 'public');
    // Modal is open; no rpc fired yet.
    expect(findByAttr(host, EXPOSURE_MODAL_ATTR)).not.toBeNull();
    expect(calls.setAck).toHaveLength(0);
    expect(calls.setPath).toHaveLength(0);

    mount.setModalPhrase(PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE);
    await mount.submitModal();

    // Ack first, then the chained set_path_resolution that flips it on.
    expect(calls.setAck).toEqual([
      { acknowledge: true, free_text_confirmation: PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE },
    ]);
    expect(calls.setPath).toHaveLength(1);
    expect(calls.setPath[0]).toMatchObject({
      path: 'mcp',
      resolution: { lan: true, public: true },
    });
    // Modal closed.
    expect(mount.getState().publicMcpModal.kind).toBe('idle');
  });

  it('public-MCP card button opens the acknowledge modal', async () => {
    const { host, mount } = await setup();
    mount.clickManagePublicMcp();
    const modal = findByAttr(host, EXPOSURE_MODAL_ATTR);
    expect(modal).not.toBeNull();
    expect(modal?.getAttribute('role')).toBe('dialog');
    expect(modal?.getAttribute('aria-modal')).toBe('true');
    const titleId = modal?.getAttribute('aria-labelledby');
    const descriptionId = modal?.getAttribute('aria-describedby');
    expect(titleId).toMatch(/^recued-exposure-modal-\d+-title$/);
    expect(descriptionId).toMatch(/^recued-exposure-modal-\d+-description$/);
    expect(findByAttr(host, 'id', titleId ?? '')?.textContent).toBe(
      'Let AI apps in from outside?',
    );
    // ⛔ PIN THE WIRING, NOT THE WORDS. This assertion exists to prove
    // `aria-describedby` resolves to the acknowledge SUBTITLE; it used to
    // hardcode a phrase from that copy, so a consent-copy correction broke a
    // test that was never about the copy. Comparing against the constant keeps
    // the a11y guarantee and lets the words change.
    expect(findByAttr(host, 'id', descriptionId ?? '')?.textContent).toBe(
      PUBLIC_MCP_MODAL_COPY.acknowledge.subtitle,
    );
    expect(mount.getState().publicMcpModal.kind).toBe('open');
  });

  it('preserves the pending enable when the chained path-set fails, so a retry re-enables (Codex fold)', async () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const ackCalls: Array<{ acknowledge: boolean }> = [];
    let setPathCalls = 0;
    const mount = mountExposurePanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      runGet: async () => ({ state: buildState(), apex_mode: 'redirect' as const }),
      runApplyPreset: async () => okResponse(buildState()),
      runSetPathResolution: async (req) => {
        setPathCalls += 1;
        if (setPathCalls === 1) {
          // Ack already landed; the first path-set rejects with a substrate code.
          throw Object.assign(new Error('no ddns'), {
            code: 'preset_unachievable_no_ddns',
          });
        }
        return okResponse(buildState({ resolution: resolution({ [req.path]: req.resolution }) }));
      },
      runSetPublicMcpAck: async (req) => {
        ackCalls.push(req);
        return okResponse(buildState({ public_mcp_acknowledgement: ackOn() }));
      },
      runHasDdns: async () => true,
    });
    await mount.refresh();

    // Open the ack modal + submit — ack ok, first path-set rejects.
    mount.clickCell('mcp', 'public');
    mount.setModalPhrase(PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE);
    await mount.submitModal();
    expect(mount.getState().publicMcpModal.kind).toBe('error');
    expect(setPathCalls).toBe(1);

    // Retry — re-typing transitions error→open; submit re-acks + re-chains.
    mount.setModalPhrase(PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE);
    await mount.submitModal();
    expect(setPathCalls).toBe(2); // the ENABLE was retried, not just the ack
    expect(ackCalls).toHaveLength(2); // re-ack is idempotent server-side
    expect(mount.getState().publicMcpModal.kind).toBe('idle');
    expect(mount.getState().state?.resolution.mcp.public).toBe(true);
  });

  it('public-MCP card shows Revoke when already acknowledged', async () => {
    const { host } = await setup({
      state: buildState({
        public_mcp_acknowledgement: ackOn(),
        resolution: resolution({ mcp: { lan: true, public: true } }),
      }),
    });
    const btn = findByAttr(host, EXPOSURE_PUBLIC_MCP_BTN_ATTR);
    expect(btn?.textContent).toMatch(/Shut AI apps out/);
  });
});

// ══════════════════════════════════════════════════════════════════
// /ws lockout gate
// ══════════════════════════════════════════════════════════════════

describe('R26.2 Delta 1 — /ws lockout gate', () => {
  it('opens the lockout modal when /ws goes fully off, then submits with the phrase', async () => {
    // /ws starts { lan: true, public: false }; toggling lan off → both off.
    const { host, mount, calls } = await setup();
    mount.clickCell('ws', 'lan');
    expect(findByAttr(host, EXPOSURE_MODAL_ATTR)).not.toBeNull();
    expect(calls.setPath).toHaveLength(0);

    mount.setModalPhrase(WS_LOCKOUT_DISCONNECT_PHRASE);
    await mount.submitModal();

    expect(calls.setPath).toHaveLength(1);
    expect(calls.setPath[0]).toMatchObject({
      path: 'ws',
      resolution: { lan: false, public: false },
      lockout_confirmation_phrase: WS_LOCKOUT_DISCONNECT_PHRASE,
    });
    expect(mount.getState().wsLockoutModal.kind).toBe('idle');
  });

  it('cancel closes the modal without firing the rpc', async () => {
    const { mount, calls } = await setup();
    mount.clickCell('ws', 'lan');
    expect(mount.getState().wsLockoutModal.kind).toBe('open');
    mount.cancelModal();
    expect(mount.getState().wsLockoutModal.kind).toBe('idle');
    expect(calls.setPath).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════
// Live broadcast + DDNS gating + dispose
// ══════════════════════════════════════════════════════════════════

describe('R26.2 Delta 1 — broadcast, DDNS gate, dispose', () => {
  it('applies an exposure_changed broadcast live (remaps changed_at)', async () => {
    const { mount, fireBroadcast } = await setup();
    fireBroadcast({
      kind: 'exposure_changed',
      resolution: resolution({ reception: { lan: false, public: true } }),
      derived_preset_label: 'custom',
      public_mcp_acknowledgement: ackOff(),
      changed_at: 9_999,
      changed_by_client_id: 'other-client',
      cursor: 7,
    });
    const s = mount.getState().state;
    expect(s?.resolution.reception.public).toBe(true);
    expect(s?.last_changed_at).toBe(9_999);
    expect(s?.changed_by_client_id).toBe('other-client');
  });

  it('a newer broadcast during the cold-load read window is not clobbered by the stale read (Codex fold)', async () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const subscribers: Array<{ kind: string; cb: (evt: unknown) => void }> = [];
    // A deferred DDNS probe — the read returns its (older) snapshot first, then
    // `refresh` parks on this gate; we fire a newer broadcast before resolving.
    let resolveDdns: (v: boolean) => void = () => {};
    const ddnsGate = new Promise<boolean>((r) => {
      resolveDdns = r;
    });
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    };

    const mount = mountExposurePanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      runGet: async () => ({
        state: buildState({ last_changed_at: 1_000 }),
        apex_mode: 'redirect' as const,
      }),
      runApplyPreset: async () => okResponse(buildState()),
      runSetPathResolution: async () => okResponse(buildState()),
      runSetPublicMcpAck: async () => okResponse(buildState()),
      runHasDdns: () => ddnsGate,
      subscribe: ((kind: string, cb: (evt: unknown) => void) => {
        subscribers.push({ kind, cb });
        return () => {};
      }) as never,
    });

    // Let the constructor's refresh resolve `runGet` + park at `await ddns`.
    await flush();
    // A newer transition broadcasts before the DDNS probe resolves.
    for (const sub of subscribers) {
      if (sub.kind === 'exposure_changed') {
        sub.cb({
          kind: 'exposure_changed',
          resolution: resolution({ mcp: { lan: true, public: true } }),
          derived_preset_label: 'custom',
          public_mcp_acknowledgement: ackOff(),
          changed_at: 5_000,
          changed_by_client_id: 'other-client',
          cursor: 3,
        });
      }
    }
    // Now the read's DDNS probe resolves; `refresh` tries to apply the OLDER
    // (1_000) read snapshot — the monotonic guard must reject it.
    resolveDdns(true);
    await flush();

    expect(mount.getState().state?.last_changed_at).toBe(5_000);
    expect(mount.getState().state?.resolution.mcp.public).toBe(true);
  });

  it('disables the public preset when DDNS is not configured', async () => {
    const { host, mount } = await setup({ hasDdns: false });
    const publicRow = mount.getState().model?.preset_rows.find((r) => r.preset === 'public');
    expect(publicRow?.requires_ddns).toBe(true);
    const rowEl = findByAttr(host, EXPOSURE_PRESET_ROW_ATTR, 'public');
    // The radio (first child) is disabled.
    expect(rowEl?.children[0]?.disabled).toBe(true);
    expect(collectText(rowEl as FakeElement)).toMatch(/Set up a web address first/);
  });

  it('dispose removes the panel from the host + unsubscribes', async () => {
    const { host, mount, calls } = await setup();
    expect(host.children.length).toBe(1);
    mount.dispose();
    expect(host.children.length).toBe(0);
    expect(calls.unsubscribe).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════
// R26.2 Delta 2 — apex (`GET /`) picker
// ══════════════════════════════════════════════════════════════════

const receptionPublicState = (): ExposureState =>
  buildState({ resolution: resolution({ reception: { lan: true, public: true } }) });

const webclientPublicState = (): ExposureState =>
  buildState({ resolution: resolution({ webclient: { lan: true, public: true } }) });

describe('R26.2 Delta 2 — apex picker', () => {
  it('renders all four apex rows + reflects the current mode from runGet', async () => {
    const { host, mount } = await setup({ apexMode: 'not_found' });
    for (const mode of ['redirect', 'serve_reception', 'serve_webclient', 'not_found']) {
      expect(findByAttr(host, EXPOSURE_APEX_ROW_ATTR, mode)).not.toBeNull();
    }
    expect(mount.getState().apexMode).toBe('not_found');
    const current = findByAttr(host, EXPOSURE_APEX_ROW_ATTR, 'not_found');
    expect(current?.getAttribute('data-current')).toBe('true');
  });

  it('disables serve_webclient + serve_reception when their grid bits are private', async () => {
    const { host } = await setup(); // default: webclient + reception not public
    const wc = findByAttr(host, EXPOSURE_APEX_ROW_ATTR, 'serve_webclient');
    expect(wc?.children[0]?.disabled).toBe(true);
    expect(collectText(wc as FakeElement)).toMatch(/Open \/webclient in the list above/);
    const rec = findByAttr(host, EXPOSURE_APEX_ROW_ATTR, 'serve_reception');
    expect(rec?.children[0]?.disabled).toBe(true);
    expect(collectText(rec as FakeElement)).toMatch(/Open \/reception in the list above/);
  });

  it('enables serve_reception once /reception is public + selecting it calls runSetApex', async () => {
    const { host, mount, calls } = await setup({ state: receptionPublicState() });
    const rec = findByAttr(host, EXPOSURE_APEX_ROW_ATTR, 'serve_reception');
    expect(rec?.children[0]?.disabled).toBe(false);
    mount.clickApex('serve_reception');
    await mount.settle();
    expect(calls.setApex).toEqual([{ apex_mode: 'serve_reception' }]);
    expect(mount.getState().apexMode).toBe('serve_reception');
  });

  it('R26.2 Delta 3 — enables serve_webclient once /webclient is public + selecting it calls runSetApex', async () => {
    const { host, mount, calls } = await setup({ state: webclientPublicState() });
    const wc = findByAttr(host, EXPOSURE_APEX_ROW_ATTR, 'serve_webclient');
    expect(wc?.children[0]?.disabled).toBe(false);
    mount.clickApex('serve_webclient');
    await mount.settle();
    expect(calls.setApex).toEqual([{ apex_mode: 'serve_webclient' }]);
    expect(mount.getState().apexMode).toBe('serve_webclient');
  });

  it('R26.2 Delta 3 — a rejected serve_webclient (no bundle) surfaces remediation + leaves the mode unchanged', async () => {
    // /webclient public client-side, but the server rejects because no verified
    // bundle is deployed (apex_webclient_unavailable — the slice-2 setter gate).
    const { mount, calls } = await setup({
      state: webclientPublicState(),
      apexMode: 'redirect',
      setApexRejectCode: 'apex_webclient_unavailable',
    });
    mount.clickApex('serve_webclient');
    await mount.settle();
    expect(calls.setApex).toHaveLength(1);
    expect(mount.getState().apexMode).toBe('redirect'); // unchanged on reject
    expect(mount.getState().actionError).toMatch(/webclient/i);
  });

  it('selecting not_found persists via runSetApex', async () => {
    const { mount, calls } = await setup({ apexMode: 'redirect' });
    mount.clickApex('not_found');
    await mount.settle();
    expect(calls.setApex).toEqual([{ apex_mode: 'not_found' }]);
    expect(mount.getState().apexMode).toBe('not_found');
  });

  it('a rejected set_apex surfaces the remediation copy + leaves the mode unchanged', async () => {
    const { mount, calls } = await setup({
      state: receptionPublicState(),
      apexMode: 'redirect',
      setApexRejectCode: 'apex_reception_not_public',
    });
    mount.clickApex('serve_reception');
    await mount.settle();
    expect(calls.setApex).toHaveLength(1);
    expect(mount.getState().apexMode).toBe('redirect'); // unchanged on reject
    expect(mount.getState().actionError).toMatch(/reception public/i);
  });

  it('shows a drift warning when the current apex is serve_reception but /reception went private', async () => {
    // apex persisted as serve_reception, but the grid has reception private.
    const { host } = await setup({ apexMode: 'serve_reception' });
    expect(findByAttr(host, EXPOSURE_APEX_WARNING_ATTR)).not.toBeNull();
  });

  it('R26.2 Delta 3 — shows a drift warning when the current apex is serve_webclient but /webclient went private', async () => {
    // apex persisted as serve_webclient, but the grid has webclient private.
    const { host } = await setup({ apexMode: 'serve_webclient' });
    expect(findByAttr(host, EXPOSURE_APEX_WARNING_ATTR)).not.toBeNull();
  });

  it('renders the picker read-only when runSetApex is absent', async () => {
    const { host } = await setup({ noSetApex: true, state: receptionPublicState() });
    // Even an otherwise-enabled row is non-interactive without a setter.
    const redirectRow = findByAttr(host, EXPOSURE_APEX_ROW_ATTR, 'redirect');
    expect(redirectRow?.children[0]?.disabled).toBe(true);
  });
});

describe('Connection example — the MCP snippet lives where the endpoint is decided', () => {
  it('renders the button only when a server URL is known', async () => {
    const withUrl = await setup({ serverUrl: 'ws://127.0.0.1:3001/ws' });
    expect(findByAttr(withUrl.host, EXPOSURE_CONNECT_BTN_ATTR)).not.toBeNull();

    // ⛔ ABSENT ⇒ NO BUTTON, not a guessed endpoint. A snippet naming the wrong
    // host sends the owner to debug a connection that was never going to work.
    const withoutUrl = await setup();
    expect(findByAttr(withoutUrl.host, EXPOSURE_CONNECT_BTN_ATTR)).toBeNull();
  });

  it('opens a modal whose snippets carry the REWRITTEN mcp endpoint', async () => {
    const { host } = await setup({ serverUrl: 'ws://127.0.0.1:3001/ws' });
    expect(findByAttr(host, EXPOSURE_CONNECT_MODAL_ATTR)).toBeNull();

    const btn = findByAttr(host, EXPOSURE_CONNECT_BTN_ATTR);
    (btn as unknown as { click: () => void }).click();

    expect(findByAttr(host, EXPOSURE_CONNECT_MODAL_ATTR)).not.toBeNull();

    // 🔑 THE REWRITE IS THE ASSERTION. `ws://…/ws` is the pairing socket; an MCP
    // client needs `http://…/mcp`. A snippet that echoed the raw server URL
    // would render, look right, and never connect. Asserted on the snippet
    // ELEMENT rather than the modal's aggregate text: this suite's fake DOM does
    // not roll `textContent` up through children, so an aggregate read is
    // vacuously '' and would pass any assertion phrased as `.not.toContain`.
    for (const id of ['claude', 'cursor', 'codex', 'custom']) {
      const pre = findByAttr(host, EXPOSURE_CONNECT_SNIPPET_ATTR, id);
      expect(pre, id).not.toBeNull();
      const body = (pre as unknown as { textContent: string }).textContent;
      expect(body, id).toContain('http://127.0.0.1:3001/mcp');
      expect(body, id).not.toContain('ws://');
    }
  });
});

describe('D-272 — the LAN bind posture, moved here from Connect a device', () => {
  const mountWith = async (over: Record<string, unknown>) => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const panel = mountExposurePanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      runGet: async () => ({ state: buildState(), apex_mode: 'redirect' as const }),
      runApplyPreset: async () => ({ state: buildState() }),
      runSetPathResolution: async () => ({ state: buildState() }),
      runSetPublicMcpAck: async () => ({ state: buildState() }),
      ...over,
    } as unknown as Parameters<typeof mountExposurePanel>[0]);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    return { host, panel, text: () => collectText(host) };
  };

  const exposed = {
    lanPort: 7717,
    publiclyRoutable: true,
    publicAddresses: ['203.0.113.7'],
  };

  it('⛔ says the local-only case OUT LOUD rather than leaving it blank', async () => {
    // "Nothing here" and "we did not look" render identically as silence, and
    // this page's whole job is to say what is open — including when the answer
    // is "only your own network".
    const m = await mountWith({
      readLanPosture: async () => ({
        lanPort: 7717, publiclyRoutable: false, publicAddresses: [],
      }),
    });
    expect(m.text()).toContain('only reachable from your own network');
  });

  it('⛔⛔ names the public address the LAN port is also open on', async () => {
    const m = await mountWith({ readLanPosture: async () => exposed });
    expect(m.text()).toContain('203.0.113.7');
    expect(m.text()).toContain('not encrypted');
  });

  it('⛔ escalates when a check from outside actually GOT IN', async () => {
    const m = await mountWith({
      readLanPosture: async () => exposed,
      readLanReachedFromOutside: () => true,
    });
    expect(m.text()).toContain('was reached from the internet');
  });

  it('⚠ softens but does NOT reassure when the check could not get in', async () => {
    // "Did not get in" is not "safe": the listener is still on a public address
    // and a firewall rule is the only thing in front of it.
    const m = await mountWith({
      readLanPosture: async () => exposed,
      readLanReachedFromOutside: () => false,
    });
    expect(m.text()).toContain('something is blocking it');
    expect(m.text()).toContain('a public address');
  });

  it('⛔⛔ renders NOTHING when the server did not report the bind', async () => {
    // Absent is "nobody looked", never "the listener is local". A section
    // claiming the latter on the strength of not having asked is the mistake
    // D-272 spent a decision on.
    const m = await mountWith({});
    expect(m.text()).not.toContain('reachable from your own network');
  });

  it('⚠ offers a check ONLY where it could say something new', async () => {
    // With the listener on no public address there is nothing outside could
    // reach, so a check would spend five seconds confirming what the bind
    // already proved.
    const local = await mountWith({
      readLanPosture: async () => ({
        lanPort: 7717, publiclyRoutable: false, publicAddresses: [],
      }),
      checkLanFromOutside: async () => {},
    });
    expect(findByAttr(local.host, 'data-recued-exposure-lan-check')).toBeNull();

    const open = await mountWith({
      readLanPosture: async () => exposed,
      checkLanFromOutside: async () => {},
    });
    expect(findByAttr(open.host, 'data-recued-exposure-lan-check')).not.toBeNull();
  });

  it('⚠ the check reports the port it was asked about', async () => {
    const asked: number[] = [];
    const m = await mountWith({
      readLanPosture: async () => ({ ...exposed, lanPort: 9100 }),
      checkLanFromOutside: async (port: number) => { asked.push(port); },
    });
    findByAttr(m.host, 'data-recued-exposure-lan-check')!.click();
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(asked).toEqual([9100]);
  });
});
