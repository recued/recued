/** D-181 slice 6a — the side-panel active-executions section + its approval
 *  gate.
 *
 *  `mount.render()` passes `onControl` to the active-executions section ONLY
 *  when `state.bridge_mode.approval` is true; otherwise it withholds it so the
 *  section renders a read-only mirror (no kill / cancel / promote buttons —
 *  §8: a non-approval bridge VIEWS the list but cannot mutate the queue). The
 *  mode defaults both-off (fail-closed) and flips live on `applyBridgeMode`.
 *
 *  Also covers the pure renderer: lane occupancy line, queued-call vs running
 *  controls, the empty state, the transient notice, and that a control button
 *  routes `onControl(action, id)` with the right id. The store-freeze section
 *  pins the active frame's deep-freeze invariant.
 *
 *  Uses an interactive fake document (the views' own FakeElement has no
 *  addEventListener) — the same shape as the approval-mode-gate test. */

import { describe, expect, it, vi } from 'vitest';

import type { ActiveExecutionEntry, LaneStatus } from '@recued/contracts';

import { mountSidePanel } from '../mount.js';
import {
  createSidePanelStore,
  DEFAULT_BRIDGE_MODE,
  type SidePanelActiveFrame,
} from '../store/local-store.js';
import {
  SIDE_PANEL_ACTIVE_CONTROL_ATTR,
  SIDE_PANEL_ACTIVE_LANE_ATTR,
  SIDE_PANEL_ACTIVE_NOTICE_ATTR,
  SIDE_PANEL_ACTIVE_ROW_ATTR,
} from '../views.js';

interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  type: string;
  disabled: boolean;
  hidden: boolean;
  attrs: Map<string, string>;
  children: FakeEl[];
  parent: FakeEl | null;
  listeners: Map<string, Array<() => void>>;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  addEventListener(type: string, fn: () => void): void;
  click(): void;
  readonly firstChild: FakeEl | null;
}

const makeFakeDocument = (): {
  doc: { createElement(t: string): FakeEl; getElementById(id: string): FakeEl | null };
  root: FakeEl;
} => {
  const byId = new Map<string, FakeEl>();
  const make = (tagName: string): FakeEl => {
    const el: FakeEl = {
      tagName: tagName.toUpperCase(),
      className: '',
      textContent: '',
      type: '',
      disabled: false,
      hidden: false,
      attrs: new Map(),
      children: [],
      parent: null,
      listeners: new Map(),
      setAttribute(k, v) {
        el.attrs.set(k, v);
        if (k === 'id') byId.set(v, el);
      },
      getAttribute(k) {
        return el.attrs.get(k) ?? null;
      },
      hasAttribute(k) {
        return el.attrs.has(k);
      },
      appendChild(c) {
        el.children.push(c);
        c.parent = el;
        return c;
      },
      removeChild(c) {
        const idx = el.children.indexOf(c);
        if (idx < 0) throw new Error('removeChild: not a child');
        el.children.splice(idx, 1);
        c.parent = null;
        return c;
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
      get firstChild() {
        return el.children[0] ?? null;
      },
    };
    return el;
  };
  const root = make('main');
  root.setAttribute('id', 'root');
  return {
    root,
    doc: { createElement: make, getElementById: (id) => byId.get(id) ?? null },
  };
};

const collectByAttr = (root: FakeEl, attr: string, out: FakeEl[] = []): FakeEl[] => {
  if (root.attrs.has(attr)) out.push(root);
  for (const c of root.children) collectByAttr(c, attr, out);
  return out;
};
const allText = (root: FakeEl, acc: string[] = []): string[] => {
  if (root.textContent) acc.push(root.textContent);
  for (const c of root.children) allText(c, acc);
  return acc;
};

const NOW = 1_800_000_000_000;

const SOURCE = {
  channel: 'user' as const,
  actor: 'user_self' as const,
  user_id: 'u1',
  client_token_id: 'c1',
};

const runEntry = (over: Partial<ActiveExecutionEntry> = {}): ActiveExecutionEntry => ({
  entry_kind: 'run',
  run_id: 'run-1',
  recipe_id: 'normalize-document-to-markdown',
  step_id: 'parse',
  lane: 'local-heavy',
  state: 'running',
  origin: 'attended',
  source: SOURCE,
  started_at: NOW - 30_000,
  slot_acquired_at: NOW - 30_000,
  progress: { contract: 'file-growth', stalled: false },
  kill: { mechanism: 'sigkill', pid: 4242 },
  ...over,
});

const queuedEntry = (over: Partial<ActiveExecutionEntry> = {}): ActiveExecutionEntry => ({
  entry_kind: 'queued-call',
  queued_call_id: 'qc-7',
  run_id: 'run-2',
  recipe_id: 'overdue-invoice-chase',
  lane: 'local-heavy',
  state: 'waiting_slot',
  origin: 'attended',
  source: SOURCE,
  started_at: NOW - 5_000,
  progress: { contract: 'silent', stalled: false },
  kill: { mechanism: 'abandon_await', run_id: 'run-2' },
  ...over,
});

const lane = (over: Partial<LaneStatus> = {}): LaneStatus => ({
  lane: 'local-heavy',
  capacity: 2,
  in_use: 2,
  queued: 1,
  oldest_wait_ms: 720_000,
  ...over,
});

const activeFrame = (over: Partial<SidePanelActiveFrame> = {}): SidePanelActiveFrame => ({
  entries: [],
  lanes: [],
  fetched_at: NOW,
  error: null,
  notice: '',
  ...over,
});

const storeWith = (
  active: SidePanelActiveFrame,
  bridge_mode = DEFAULT_BRIDGE_MODE,
) =>
  createSidePanelStore({
    pair: { paired: true, server_url: 'https://local.recued.test', server_display_name: 'Local' },
    active,
    bridge_mode,
  });

const controlsIn = (root: FakeEl) =>
  collectByAttr(root, SIDE_PANEL_ACTIVE_CONTROL_ATTR);

describe('D-181 slice 6a — active-executions approval gate', () => {
  it('renders READ-ONLY (no control buttons) when approval mode is OFF, even with onControl wired', () => {
    const { doc, root } = makeFakeDocument();
    const onControl = vi.fn();
    mountSidePanel({
      document: doc as unknown as Document,
      store: storeWith(activeFrame({ entries: [runEntry()] }), {
        notification: true,
        approval: false,
      }),
      now: () => NOW,
      onControl,
    });

    expect(controlsIn(root)).toHaveLength(0);
    // The row itself still renders — view-only mirror, not hidden.
    expect(collectByAttr(root, SIDE_PANEL_ACTIVE_ROW_ATTR)).toHaveLength(1);
    expect(allText(root).join(' ')).toContain('normalize-document-to-markdown');
  });

  it('renders control buttons when approval mode is ON', () => {
    const { doc, root } = makeFakeDocument();
    mountSidePanel({
      document: doc as unknown as Document,
      store: storeWith(activeFrame({ entries: [runEntry()] }), {
        notification: false,
        approval: true,
      }),
      now: () => NOW,
      onControl: vi.fn(),
    });

    const controls = controlsIn(root);
    expect(controls).toHaveLength(1);
    expect(controls[0].getAttribute(SIDE_PANEL_ACTIVE_CONTROL_ATTR)).toBe('kill');
  });

  it('is fail-closed by default: a fresh store (both modes off) renders read-only', () => {
    const { doc, root } = makeFakeDocument();
    const store = createSidePanelStore({
      pair: { paired: true, server_url: 'https://x', server_display_name: 'X' },
      active: activeFrame({ entries: [runEntry()] }),
      // bridge_mode omitted -> DEFAULT_BRIDGE_MODE (both off).
    });
    expect(store.getState().bridge_mode).toEqual(DEFAULT_BRIDGE_MODE);

    mountSidePanel({
      document: doc as unknown as Document,
      store,
      now: () => NOW,
      onControl: vi.fn(),
    });
    expect(controlsIn(root)).toHaveLength(0);
  });

  it('flips live between read-only and interactive when applyBridgeMode toggles approval', () => {
    const { doc, root } = makeFakeDocument();
    const store = storeWith(activeFrame({ entries: [runEntry()] }), {
      notification: false,
      approval: false,
    });
    mountSidePanel({
      document: doc as unknown as Document,
      store,
      now: () => NOW,
      onControl: vi.fn(),
    });

    expect(controlsIn(root)).toHaveLength(0);
    store.applyBridgeMode({ notification: false, approval: true });
    expect(controlsIn(root)).toHaveLength(1);
    store.applyBridgeMode({ notification: false, approval: false });
    expect(controlsIn(root)).toHaveLength(0);
  });
});

describe('D-181 slice 6a — active-executions rendering', () => {
  it('renders a queued-call with Promote + Cancel and a run with Kill', () => {
    const { doc, root } = makeFakeDocument();
    mountSidePanel({
      document: doc as unknown as Document,
      store: storeWith(activeFrame({ entries: [runEntry(), queuedEntry()] }), {
        notification: false,
        approval: true,
      }),
      now: () => NOW,
      onControl: vi.fn(),
    });

    const actions = controlsIn(root).map((b) =>
      b.getAttribute(SIDE_PANEL_ACTIVE_CONTROL_ATTR),
    );
    expect(actions).toEqual(['kill', 'promote', 'cancel']);
  });

  it('routes onControl(action, id) with the right id on click', () => {
    const { doc, root } = makeFakeDocument();
    const onControl = vi.fn();
    mountSidePanel({
      document: doc as unknown as Document,
      store: storeWith(activeFrame({ entries: [runEntry(), queuedEntry()] }), {
        notification: false,
        approval: true,
      }),
      now: () => NOW,
      onControl,
    });

    const byAction = (action: string): FakeEl =>
      controlsIn(root).find(
        (b) => b.getAttribute(SIDE_PANEL_ACTIVE_CONTROL_ATTR) === action,
      )!;

    byAction('kill').click();
    expect(onControl).toHaveBeenLastCalledWith('kill', 'run-1');
    byAction('promote').click();
    expect(onControl).toHaveBeenLastCalledWith('promote', 'qc-7');
    byAction('cancel').click();
    expect(onControl).toHaveBeenLastCalledWith('cancel', 'qc-7');
  });

  it('renders the per-lane occupancy line for busy lanes only', () => {
    const { doc, root } = makeFakeDocument();
    mountSidePanel({
      document: doc as unknown as Document,
      store: storeWith(
        activeFrame({
          entries: [runEntry()],
          lanes: [lane(), lane({ lane: 'external-io', in_use: 0, queued: 0, oldest_wait_ms: 0 })],
        }),
      ),
      now: () => NOW,
    });

    const laneRows = collectByAttr(root, SIDE_PANEL_ACTIVE_LANE_ATTR);
    expect(laneRows.map((r) => r.getAttribute(SIDE_PANEL_ACTIVE_LANE_ATTR))).toEqual([
      'local-heavy',
    ]);
    // "2/2 · 1 queued, oldest 12m" — formatSeconds(720000/1000=720s) → 12m.
    expect(allText(root).join(' ')).toContain('2/2 · 1 queued, oldest 12m');
  });

  it('renders the empty state when nothing is running', () => {
    const { doc, root } = makeFakeDocument();
    mountSidePanel({
      document: doc as unknown as Document,
      store: storeWith(activeFrame()),
      now: () => NOW,
    });
    expect(allText(root).join(' ')).toContain('Nothing running');
    expect(collectByAttr(root, SIDE_PANEL_ACTIVE_ROW_ATTR)).toHaveLength(0);
  });

  it('renders loading rather than a false empty state before the first fetch', () => {
    const { doc, root } = makeFakeDocument();
    mountSidePanel({
      document: doc as unknown as Document,
      store: storeWith(activeFrame({ fetched_at: null })),
      now: () => NOW,
    });
    expect(allText(root).join(' ')).toContain('Loading active executions');
    expect(allText(root).join(' ')).not.toContain('Nothing running');
  });

  it('renders a transient control notice above the list', () => {
    const { doc, root } = makeFakeDocument();
    mountSidePanel({
      document: doc as unknown as Document,
      store: storeWith(
        activeFrame({ entries: [runEntry()], notice: 'That run already finished.' }),
      ),
      now: () => NOW,
    });
    const notice = collectByAttr(root, SIDE_PANEL_ACTIVE_NOTICE_ATTR);
    expect(notice).toHaveLength(1);
    expect(notice[0].textContent).toBe('That run already finished.');
  });
});

describe('D-181 slice 6a — store active frame', () => {
  it('defaults empty and applyActiveFrame patches + deep-freezes entries', () => {
    const store = createSidePanelStore();
    expect(store.getState().active).toEqual({
      entries: [],
      lanes: [],
      fetched_at: null,
      error: null,
      notice: '',
    });

    store.applyActiveFrame(activeFrame({ entries: [runEntry()], lanes: [lane()] }));
    expect(store.getState().active.entries).toHaveLength(1);
    expect(store.getState().active.lanes).toHaveLength(1);

    // The frame + the entries array are frozen — a consumer cannot mutate the
    // live snapshot through getState().
    expect(() => {
      (store.getState().active as { notice: string }).notice = 'x';
    }).toThrow();
    expect(() => {
      (store.getState().active.entries as ActiveExecutionEntry[]).push(runEntry());
    }).toThrow();
    // ...and one level into each entry's nested objects.
    expect(() => {
      (store.getState().active.entries[0].progress as { stalled: boolean }).stalled = true;
    }).toThrow();
  });
});
