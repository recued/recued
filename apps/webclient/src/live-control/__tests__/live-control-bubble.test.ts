// Shell-frame Step 2 — the route-independent live-control bubble (the bell's
// twin). Lifted out of the chat header into shell chrome and MERGED with the
// D-186 session-grant "Active passes" surface. These tests pin: ambient
// visibility (hidden at idle), the combined `◉ N` count (running + grants), the
// DANGER tint when stalled, expand → RUNNING (Kill / Promote+Cancel) above
// GRANTS (Revoke) with control routing + non-terminal verdict notices, the
// debounced bus re-lists (execution `progress` ignored; contract-definition →
// grants), per-section gating on the caller, and clean teardown.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ActiveExecutionEntry,
  ExecutionActiveRequest,
  ExecutionActiveResponse,
  ExecutionSource,
  SessionGrantListResponse,
  SessionGrantView,
} from '@recued/contracts';

import {
  mountLiveControlBubble,
  LIVE_CONTROL_BUBBLE_GRANT_CONTROL_ATTR,
  LIVE_CONTROL_BUBBLE_GRANT_ROW_ATTR,
  LIVE_CONTROL_BUBBLE_HOST_ATTR,
  LIVE_CONTROL_BUBBLE_NOTICE_ATTR,
  LIVE_CONTROL_BUBBLE_PANEL_ATTR,
  LIVE_CONTROL_BUBBLE_RUNNING_ROW_ATTR,
  LIVE_CONTROL_BUBBLE_RUN_CONTROL_ATTR,
  LIVE_CONTROL_BUBBLE_TOGGLE_ATTR,
  type LiveControlActiveCaller,
  type LiveControlCancelCaller,
  type LiveControlGrantsListCaller,
  type LiveControlGrantsRevokeCaller,
  type LiveControlKillCaller,
  type LiveControlPromoteCaller,
} from '../live-control-bubble.js';

const DISC = String.fromCodePoint(0x25c9); // ◉

// ── minimal fake DOM (same shape as the lifted chat-bubble test) ───────────
interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  type: string;
  disabled: boolean;
  attrs: Map<string, string>;
  children: FakeEl[];
  parent: FakeEl | null;
  listeners: Map<string, Array<() => void>>;
  readonly firstChild: FakeEl | null;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  remove(): void;
  addEventListener(type: string, fn: () => void): void;
  click(): void;
}

interface FakeDoc {
  styleElements: FakeEl[];
  head: { querySelector(sel: string): FakeEl | null; appendChild(el: FakeEl): FakeEl };
  createElement(tag: string): FakeEl;
}

const makeFakeEl = (tag: string): FakeEl => {
  const el: FakeEl = {
    tagName: tag.toUpperCase(),
    className: '',
    textContent: '',
    type: '',
    disabled: false,
    attrs: new Map(),
    children: [],
    parent: null,
    listeners: new Map(),
    get firstChild() {
      return el.children[0] ?? null;
    },
    setAttribute(k, v) {
      el.attrs.set(k, v);
    },
    getAttribute(k) {
      return el.attrs.get(k) ?? null;
    },
    appendChild(c) {
      c.parent = el;
      el.children.push(c);
      return c;
    },
    removeChild(c) {
      const idx = el.children.indexOf(c);
      if (idx < 0) throw new Error('removeChild: not a child');
      el.children.splice(idx, 1);
      c.parent = null;
      return c;
    },
    remove() {
      if (el.parent === null) return;
      const idx = el.parent.children.indexOf(el);
      if (idx >= 0) el.parent.children.splice(idx, 1);
      el.parent = null;
    },
    addEventListener(type, fn) {
      const list = el.listeners.get(type) ?? [];
      list.push(fn);
      el.listeners.set(type, list);
    },
    click() {
      if (el.disabled) return;
      for (const fn of el.listeners.get('click') ?? []) fn();
    },
  };
  return el;
};

const makeFakeDocument = (): FakeDoc => {
  const styleElements: FakeEl[] = [];
  const matchSelector = (sel: string): { tag: string; attr: string } | null => {
    const m = sel.match(/^([\w-]+)\[([\w-]+)\]$/);
    return m === null ? null : { tag: m[1]!.toUpperCase(), attr: m[2]! };
  };
  return {
    styleElements,
    head: {
      querySelector(sel) {
        const parsed = matchSelector(sel);
        if (parsed === null) return null;
        return (
          styleElements.find(
            (s) => s.tagName === parsed.tag && s.attrs.has(parsed.attr),
          ) ?? null
        );
      },
      appendChild(el) {
        styleElements.push(el);
        return el;
      },
    },
    createElement: (tag) => makeFakeEl(tag),
  };
};

const collectByAttr = (root: FakeEl, attr: string, out: FakeEl[] = []): FakeEl[] => {
  if (root.attrs.has(attr)) out.push(root);
  for (const child of root.children) collectByAttr(child, attr, out);
  return out;
};

const tick = async (n = 8): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

// ── fixtures ───────────────────────────────────────────────────────────────
const SOURCE: ExecutionSource = {
  channel: 'user',
  actor: 'user_self',
  user_id: 'owner_1',
  client_token_id: 'tok_1',
};

const runEntry = (
  overrides: Partial<ActiveExecutionEntry> = {},
): ActiveExecutionEntry => ({
  entry_kind: 'run',
  run_id: 'run_1',
  recipe_id: 'docs/normalize',
  step_id: 'extract',
  lane: 'local-heavy',
  state: 'running',
  origin: 'attended',
  source: SOURCE,
  started_at: 1_000,
  slot_acquired_at: 1_000,
  progress: { contract: 'silent', stalled: false },
  kill: { mechanism: 'sigkill', pid: 4242 },
  ...overrides,
});

const queuedEntry = (
  overrides: Partial<ActiveExecutionEntry> = {},
): ActiveExecutionEntry => ({
  entry_kind: 'queued-call',
  queued_call_id: 'qc_1',
  run_id: 'run_2',
  recipe_id: 'media/transcode',
  step_id: 'ffmpeg',
  lane: 'local-heavy',
  state: 'waiting_slot',
  origin: 'attended',
  source: SOURCE,
  started_at: 2_000,
  progress: { contract: 'silent', stalled: false },
  kill: { mechanism: 'abandon_await', run_id: 'run_2' },
  ...overrides,
});

const activeSnapshot = (
  entries: ActiveExecutionEntry[],
): ExecutionActiveResponse => ({ entries, lanes: [] });

const grantView = (
  overrides: Partial<SessionGrantView> = {},
): SessionGrantView => ({
  contract_id: 'sg_1',
  display_name: 'Batched approval — send-email (3 items)',
  grant_mode: 'batch',
  permits: { operation_ids: ['send-email'], connection_names: ['gmail'] },
  expiry_at: 100_000,
  remaining_ttl_ms: 60_000,
  uses_remaining: 2,
  member_count: 3,
  lifecycle_state: 'active',
  ...overrides,
});

const grantsSnapshot = (
  grants: SessionGrantView[],
): SessionGrantListResponse => ({ grants });

interface MountInit {
  active?: ExecutionActiveResponse;
  grants?: SessionGrantListResponse;
  includeActiveCaller?: boolean;
  includeGrantsCaller?: boolean;
  /** Full override of the active caller (for soft-fail / per-call scripting). */
  activeCaller?: LiveControlActiveCaller;
  killCaller?: LiveControlKillCaller;
  cancelCaller?: LiveControlCancelCaller;
  promoteCaller?: LiveControlPromoteCaller;
  revokeCaller?: LiveControlGrantsRevokeCaller;
  now?: () => number;
}

const mountBubble = (init: MountInit = {}) => {
  const doc = makeFakeDocument();
  const host = doc.createElement('div');
  const listeners = new Map<string, Array<(e: { kind: string; [k: string]: unknown }) => void>>();

  let activeCurrent: ExecutionActiveResponse = init.active ?? activeSnapshot([]);
  let grantsCurrent: SessionGrantListResponse = init.grants ?? grantsSnapshot([]);

  const activeCaller: LiveControlActiveCaller =
    init.activeCaller ??
    vi.fn(async (_req: ExecutionActiveRequest) => activeCurrent);
  const grantsListCaller: LiveControlGrantsListCaller = vi.fn(
    async () => grantsCurrent,
  );
  const killCaller =
    init.killCaller ??
    (vi.fn(async () => ({ status: 'killed' as const })) as LiveControlKillCaller);
  const cancelCaller =
    init.cancelCaller ??
    (vi.fn(
      async () => ({ status: 'cancelled_before_dispatch' as const }),
    ) as LiveControlCancelCaller);
  const promoteCaller =
    init.promoteCaller ??
    (vi.fn(
      async () => ({ status: 'promoted' as const }),
    ) as LiveControlPromoteCaller);
  const revokeCaller =
    init.revokeCaller ?? (vi.fn(async () => grantView()) as LiveControlGrantsRevokeCaller);

  const mount = mountLiveControlBubble({
    host: host as unknown as HTMLElement,
    document: doc as unknown as Document,
    subscribe: ((kind: string, listener: (e: { kind: string }) => void) => {
      const list = listeners.get(kind) ?? [];
      list.push(listener);
      listeners.set(kind, list);
      return () => {
        const cur = listeners.get(kind) ?? [];
        listeners.set(kind, cur.filter((fn) => fn !== listener));
      };
    }) as never,
    ...(init.includeActiveCaller === false ? {} : { activeCaller }),
    ...(init.includeGrantsCaller === false ? {} : { grantsListCaller }),
    killCaller,
    cancelCaller,
    promoteCaller,
    grantsRevokeCaller: revokeCaller,
    activeRefreshDebounceMs: 0,
    ...(init.now !== undefined ? { now: init.now } : {}),
  });

  return {
    host,
    mount,
    callers: { activeCaller, grantsListCaller, killCaller, cancelCaller, promoteCaller, revokeCaller },
    setActive: (entries: ActiveExecutionEntry[]) => {
      activeCurrent = activeSnapshot(entries);
    },
    setGrants: (grants: SessionGrantView[]) => {
      grantsCurrent = grantsSnapshot(grants);
    },
    fire: (kind: string, event: Record<string, unknown> = {}) => {
      for (const fn of listeners.get(kind) ?? []) fn({ kind, ...event });
    },
    listenerCount: (kind: string) => (listeners.get(kind) ?? []).length,
    toggle: (): FakeEl | null =>
      collectByAttr(host, LIVE_CONTROL_BUBBLE_TOGGLE_ATTR)[0] ?? null,
  };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('live-control bubble — ambient visibility + count', () => {
  it('renders nothing while idle (no running, no grants)', async () => {
    const h = mountBubble();
    await tick();
    expect(collectByAttr(h.host, LIVE_CONTROL_BUBBLE_TOGGLE_ATTR)).toHaveLength(0);
    expect(collectByAttr(h.host, LIVE_CONTROL_BUBBLE_HOST_ATTR)).toHaveLength(1);
    h.mount.dispose();
  });

  it('shows the combined ◉ N counter (running + grants) once loaded', async () => {
    const h = mountBubble({
      active: activeSnapshot([runEntry(), queuedEntry()]),
      grants: grantsSnapshot([grantView()]),
    });
    await tick();
    const toggle = h.toggle();
    expect(toggle).not.toBeNull();
    expect(toggle!.textContent).toBe([DISC, '3'].join(' '));
    expect(toggle!.getAttribute('aria-expanded')).toBe('false');
    h.mount.dispose();
  });

  it('tints the collapsed counter to DANGER when an entry is stalled', async () => {
    const h = mountBubble({
      active: activeSnapshot([
        runEntry({ progress: { contract: 'silent', stalled: true } }),
      ]),
    });
    await tick();
    expect(h.toggle()!.getAttribute('data-stalled')).toBe('true');
    h.mount.dispose();
  });
});

describe('live-control bubble — RUNNING section', () => {
  it('expands to per-entry rows with the right controls and routes Kill', async () => {
    const h = mountBubble({ active: activeSnapshot([runEntry(), queuedEntry()]) });
    await tick();
    h.toggle()!.click();
    await tick();
    expect(collectByAttr(h.host, LIVE_CONTROL_BUBBLE_PANEL_ATTR)).toHaveLength(1);
    const rows = collectByAttr(h.host, LIVE_CONTROL_BUBBLE_RUNNING_ROW_ATTR);
    expect(rows).toHaveLength(2);
    const controls = collectByAttr(h.host, LIVE_CONTROL_BUBBLE_RUN_CONTROL_ATTR);
    const actions = controls.map((c) => c.getAttribute(LIVE_CONTROL_BUBBLE_RUN_CONTROL_ATTR));
    // a run → Kill; a queued call → Promote + Cancel
    expect(actions).toEqual(['kill', 'promote', 'cancel']);

    const kill = controls.find((c) => c.getAttribute(LIVE_CONTROL_BUBBLE_RUN_CONTROL_ATTR) === 'kill');
    kill!.click();
    await tick();
    expect(h.callers.killCaller).toHaveBeenCalledWith({ run_id: 'run_1' });
  });

  it('routes Promote and Cancel to the queued-call id', async () => {
    const h = mountBubble({ active: activeSnapshot([queuedEntry()]) });
    await tick();
    h.toggle()!.click();
    await tick();
    const controls = collectByAttr(h.host, LIVE_CONTROL_BUBBLE_RUN_CONTROL_ATTR);
    controls.find((c) => c.getAttribute(LIVE_CONTROL_BUBBLE_RUN_CONTROL_ATTR) === 'promote')!.click();
    await tick();
    expect(h.callers.promoteCaller).toHaveBeenCalledWith({ queued_call_id: 'qc_1' });
    controls.find((c) => c.getAttribute(LIVE_CONTROL_BUBBLE_RUN_CONTROL_ATTR) === 'cancel')!.click();
    await tick();
    expect(h.callers.cancelCaller).toHaveBeenCalledWith({ queued_call_id: 'qc_1' });
  });

  it('surfaces a non-terminal verdict as a notice', async () => {
    const h = mountBubble({
      active: activeSnapshot([runEntry()]),
      killCaller: vi.fn(
        async () => ({ status: 'already_terminal' as const }),
      ) as LiveControlKillCaller,
    });
    await tick();
    h.toggle()!.click();
    await tick();
    collectByAttr(h.host, LIVE_CONTROL_BUBBLE_RUN_CONTROL_ATTR)[0]!.click();
    await tick();
    const notices = collectByAttr(h.host, LIVE_CONTROL_BUBBLE_NOTICE_ATTR);
    expect(notices.some((n) => n.textContent.includes('already finished'))).toBe(true);
  });

  it('clears a drained RUNNING notice even while GRANTS stays populated', async () => {
    const h = mountBubble({
      active: activeSnapshot([runEntry()]),
      grants: grantsSnapshot([grantView()]),
      killCaller: vi.fn(
        async () => ({ status: 'already_terminal' as const }),
      ) as LiveControlKillCaller,
    });
    await tick();
    h.toggle()!.click();
    await tick();
    const runningNotice = (): boolean =>
      collectByAttr(h.host, LIVE_CONTROL_BUBBLE_NOTICE_ATTR).some(
        (n) => n.getAttribute(LIVE_CONTROL_BUBBLE_NOTICE_ATTR) === 'running',
      );
    // Kill → a stale RUNNING verdict notice.
    collectByAttr(h.host, LIVE_CONTROL_BUBBLE_RUN_CONTROL_ATTR)[0]!.click();
    await tick();
    expect(runningNotice()).toBe(true);
    // RUNNING drains while GRANTS persists — the bubble stays visible (a grant
    // remains) but the stale running notice must be gone (per-section clear)…
    h.setActive([]);
    h.fire('execution', { op: 'retired' });
    await tick();
    expect(h.toggle()).not.toBeNull();
    expect(runningNotice()).toBe(false);
    // …and a NEW running entry shows no leftover notice.
    h.setActive([runEntry({ run_id: 'run_9' })]);
    h.fire('execution', { op: 'start' });
    await tick();
    expect(runningNotice()).toBe(false);
    h.mount.dispose();
  });

  it('re-enables the control after the post-action re-list soft-fails', async () => {
    let calls = 0;
    const h = mountBubble({
      // boot returns one entry; the post-kill re-list throws (soft-fail).
      activeCaller: vi.fn(async () => {
        calls += 1;
        if (calls >= 2) throw new Error('relist failed');
        return activeSnapshot([runEntry()]);
      }) as LiveControlActiveCaller,
      includeGrantsCaller: false,
    });
    await tick();
    h.toggle()!.click();
    await tick();
    const kill = collectByAttr(h.host, LIVE_CONTROL_BUBBLE_RUN_CONTROL_ATTR)[0]!;
    kill.click();
    await tick();
    // The soft-failed re-list kept the prior list, so the row + button persist;
    // the button must be re-enabled (not stuck disabled) once the action settles.
    const after = collectByAttr(h.host, LIVE_CONTROL_BUBBLE_RUN_CONTROL_ATTR);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((b) => b.disabled === false)).toBe(true);
    h.mount.dispose();
  });
});

describe('live-control bubble — GRANTS section', () => {
  it('expands to grant rows (Active passes above? RUNNING first) and routes Revoke', async () => {
    const h = mountBubble({
      active: activeSnapshot([runEntry()]),
      grants: grantsSnapshot([grantView(), grantView({ contract_id: 'sg_2', display_name: 'Open pass' })]),
    });
    await tick();
    h.toggle()!.click();
    await tick();
    // RUNNING renders above GRANTS — the running row precedes the grant rows.
    const panel = collectByAttr(h.host, LIVE_CONTROL_BUBBLE_PANEL_ATTR)[0]!;
    const runningRows = collectByAttr(panel, LIVE_CONTROL_BUBBLE_RUNNING_ROW_ATTR);
    const grantRows = collectByAttr(panel, LIVE_CONTROL_BUBBLE_GRANT_ROW_ATTR);
    expect(runningRows).toHaveLength(1);
    expect(grantRows).toHaveLength(2);

    const revoke = collectByAttr(h.host, LIVE_CONTROL_BUBBLE_GRANT_CONTROL_ATTR)[0]!;
    revoke.click();
    await tick();
    expect(h.callers.revokeCaller).toHaveBeenCalledWith({ contract_id: 'sg_1' });
  });

  it('surfaces a revoke failure as a grants notice', async () => {
    const h = mountBubble({
      grants: grantsSnapshot([grantView()]),
      revokeCaller: vi.fn(async () => {
        throw new Error('pass not found');
      }) as LiveControlGrantsRevokeCaller,
    });
    await tick();
    h.toggle()!.click();
    await tick();
    collectByAttr(h.host, LIVE_CONTROL_BUBBLE_GRANT_CONTROL_ATTR)[0]!.click();
    await tick();
    const notices = collectByAttr(h.host, LIVE_CONTROL_BUBBLE_NOTICE_ATTR);
    expect(notices.some((n) => n.textContent.includes('pass not found'))).toBe(true);
  });
});

describe('live-control bubble — bus liveness', () => {
  it('re-lists running off a non-progress execution delta; ignores progress', async () => {
    const h = mountBubble({ active: activeSnapshot([]) });
    await tick();
    expect(h.toggle()).toBeNull(); // idle
    const callsBefore = (h.callers.activeCaller as ReturnType<typeof vi.fn>).mock.calls.length;

    // A progress tick must NOT trigger a re-list.
    h.fire('execution', { op: 'progress' });
    await tick();
    expect((h.callers.activeCaller as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);

    // A membership change does — and the bubble appears.
    h.setActive([runEntry()]);
    h.fire('execution', { op: 'start' });
    await tick();
    expect((h.callers.activeCaller as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(callsBefore);
    expect(h.toggle()).not.toBeNull();
  });

  it('re-lists grants off a contract.contract_definition_changed delta', async () => {
    const h = mountBubble({ grants: grantsSnapshot([]) });
    await tick();
    expect(h.toggle()).toBeNull();
    h.setGrants([grantView()]);
    h.fire('contract.contract_definition_changed', {});
    await tick();
    expect(h.toggle()!.textContent).toBe([DISC, '1'].join(' '));
    h.mount.dispose();
  });

  it('disappears + collapses once everything drains', async () => {
    const h = mountBubble({ active: activeSnapshot([runEntry()]) });
    await tick();
    h.toggle()!.click(); // expand
    await tick();
    expect(h.mount.isOpen()).toBe(true);
    h.setActive([]);
    h.fire('execution', { op: 'retired' });
    await tick();
    expect(h.toggle()).toBeNull();
    expect(h.mount.isOpen()).toBe(false);
    h.mount.dispose();
  });
});

describe('live-control bubble — section gating + teardown', () => {
  it('renders only RUNNING when no grants caller is wired', async () => {
    const h = mountBubble({
      includeGrantsCaller: false,
      active: activeSnapshot([runEntry()]),
    });
    await tick();
    h.toggle()!.click();
    await tick();
    expect(collectByAttr(h.host, LIVE_CONTROL_BUBBLE_RUNNING_ROW_ATTR)).toHaveLength(1);
    expect(collectByAttr(h.host, LIVE_CONTROL_BUBBLE_GRANT_ROW_ATTR)).toHaveLength(0);
    expect(h.listenerCount('contract.contract_definition_changed')).toBe(0);
    h.mount.dispose();
  });

  it('renders only GRANTS when no active caller is wired', async () => {
    const h = mountBubble({
      includeActiveCaller: false,
      grants: grantsSnapshot([grantView()]),
    });
    await tick();
    h.toggle()!.click();
    await tick();
    expect(collectByAttr(h.host, LIVE_CONTROL_BUBBLE_GRANT_ROW_ATTR)).toHaveLength(1);
    expect(collectByAttr(h.host, LIVE_CONTROL_BUBBLE_RUNNING_ROW_ATTR)).toHaveLength(0);
    expect(h.listenerCount('execution')).toBe(0);
    h.mount.dispose();
  });

  it('dispose removes the bubble host and stops re-listing on bus deltas', async () => {
    const h = mountBubble({ active: activeSnapshot([runEntry()]) });
    await tick();
    expect(collectByAttr(h.host, LIVE_CONTROL_BUBBLE_HOST_ATTR)).toHaveLength(1);
    h.mount.dispose();
    expect(collectByAttr(h.host, LIVE_CONTROL_BUBBLE_HOST_ATTR)).toHaveLength(0);
    const callsAfterDispose = (h.callers.activeCaller as ReturnType<typeof vi.fn>).mock.calls.length;
    h.fire('execution', { op: 'start' });
    await tick();
    expect((h.callers.activeCaller as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterDispose);
  });
});
