/** D-290 — the `#today` route's read ownership.
 *
 *  ⛔ THESE THREE MOVED FROM `d-174-p5-data-route.test.ts`, NOT COPIED. They
 *  pin the invariants the extraction had to carry across — coalescing a burst
 *  of broadcasts into ONE follow-up, holding recovery "unavailable" until the
 *  CURRENT read settles, and refusing to let a superseded read repaint retired
 *  rows. Leaving them behind would have left the Data route testing behaviour
 *  it no longer hosts, and the new route testing nothing.
 */
import type { WorkEntity } from '@recued/contracts';
import { describe, expect, it, vi } from 'vitest';

import { bootstrapTodayRoute } from '../bootstrap-today-route.js';
import type { TodayCallers } from '../today-controller.js';

const NOW = 1_700_000_000_000;

const taskEntity = (
  overrides: Partial<Extract<WorkEntity, { _kind: 'task' }>> = {},
): WorkEntity => ({
  _kind: 'task', id: 'task-1', title: 'Call Sam', done: false,
  source_id: 'recued.task', last_seen_at: 1, sync_state: 'live',
  conflict_policy: 'recued_wins', created_at: 1, updated_at: 2,
  blocks_task_ids: [], ...overrides,
} as WorkEntity);

/** The webclient suite runs without a DOM, so surfaces are driven against
 *  hand-built elements. `querySelector` answering null is faithful to the
 *  shared rig — and it is why the route optional-chains every lookup. */
const makeFakeEl = (tag: string): Record<string, unknown> => {
  const attrs = new Map<string, string>();
  const children: Array<Record<string, unknown>> = [];
  const el: Record<string, unknown> = {
    tagName: tag.toUpperCase(), innerHTML: '', textContent: '', children,
    querySelector: () => null,
    setAttribute: (k: string, v: string) => { attrs.set(k, v); },
    getAttribute: (k: string) => attrs.get(k) ?? null,
    appendChild: (c: Record<string, unknown>) => { children.push(c); return c; },
    listeners: new Map<string, Array<(e: unknown) => void>>(),
    addEventListener(type: string, fn: (e: unknown) => void) {
      const m = el.listeners as Map<string, Array<(e: unknown) => void>>;
      m.set(type, [...(m.get(type) ?? []), fn]);
    },
    removeEventListener: () => undefined,
    remove: () => undefined,
  };
  return el;
};

const makeSubscribe = () => {
  const listeners = new Map<string, () => void>();
  const subscribe = ((kind: string, listener: () => void) => {
    listeners.set(kind, listener);
    return () => listeners.delete(kind);
  }) as never;
  return { subscribe, listeners };
};

const mount = (
  callers: Partial<TodayCallers>,
  subscribe?: ReturnType<typeof makeSubscribe>['subscribe'],
) => {
  const container = makeFakeEl('div');
  /** A hand-driven clock + visibility surface. The route optional-chains all
   *  four, so a document WITHOUT them is also a supported host — which is why
   *  the other tests here still pass one. */
  const ticks = new Map<number, () => void>();
  let nextTimer = 1;
  const docListeners = new Map<string, Array<() => void>>();
  const ownerDocument = {
    head: { querySelector: () => ({}), appendChild: () => undefined },
    createElement: (tag: string) => makeFakeEl(tag),
    activeElement: null,
    visibilityState: 'visible' as string,
    defaultView: {
      setInterval: (fn: () => void) => { ticks.set(nextTimer, fn); return nextTimer++; },
      clearInterval: (id: number) => { ticks.delete(id); },
    },
    addEventListener: (type: string, fn: () => void) => {
      docListeners.set(type, [...(docListeners.get(type) ?? []), fn]);
    },
    removeEventListener: (type: string, fn: () => void) => {
      docListeners.set(type, (docListeners.get(type) ?? []).filter((f) => f !== fn));
    },
  };
  (container as { ownerDocument?: unknown }).ownerDocument = ownerDocument;
  const route = bootstrapTodayRoute({
    container: container as never,
    now: () => NOW,
    callers: {
      collectionListInstancesCaller: async () => ({ instances: [] }),
      // `loadToday` THROWS without this one ("Recued cannot read the source
      // names."), which lands as an issue and holds recovery at
      // 'unavailable' — so omitting it makes every freshness assertion fail
      // for a reason that has nothing to do with the behaviour under test.
      workEntitySourceListCaller: async () => ({
        sources: [{ id: 'recued.task', top_tier_kind: 'task', label: 'Tasks' }],
      }),
      ...callers,
    } as TodayCallers,
    ...(subscribe ? { subscribe } : {}),
  });
  return {
    container, route,
    html: () => String((container.children as Array<{ innerHTML: string }>)[0]?.innerHTML ?? ''),
    /** Advance the minute clock. Runs only timers that are still registered,
     *  so a disposed route's timer genuinely cannot fire. */
    tick: () => { for (const fn of [...ticks.values()]) fn(); },
    setVisibility: (state: string) => { ownerDocument.visibilityState = state; },
    fireVisibility: () => { for (const fn of docListeners.get('visibilitychange') ?? []) fn(); },
    /** What the route still holds on the host. Asserting reads alone cannot
     *  tell a CLEARED timer from a live one whose callback early-returns. */
    timers: () => ticks.size,
    visibilityListeners: () => (docListeners.get('visibilitychange') ?? []).length,
  };
};

describe('#today capture', () => {
  const clickCreate = (container: Record<string, unknown>): void => {
    // The route listens on its own root; the shell's fake element records
    // listeners, so dispatch is a direct call with a target that answers the
    // route's action attribute.
    const root = (container.children as Array<Record<string, unknown>>)[0]!;
    const control = { getAttribute: (k: string) => k === 'data-recued-today-action' ? 'today-create' : null };
    const target = { closest: (sel: string) => sel === '[data-recued-today-action]' ? control : null };
    for (const fn of ((root.listeners as Map<string, Array<(e: unknown) => void>> | undefined)?.get('click') ?? [])) {
      fn({ target } as never);
    }
  };

  it('⛔ dispatches the capture to the SHARED opener, not a fourth form', async () => {
    const openCreateOverlay = vi.fn();
    const rig = mount({ openCreateOverlay });
    await rig.route.whenLoaded();
    clickCreate(rig.container);
    expect(openCreateOverlay).toHaveBeenCalledTimes(1);
    rig.route.dispose();
  });

  it('stays inert when no host wired an opener', async () => {
    const rig = mount({});
    await rig.route.whenLoaded();
    // The markup carries no button at all; a stray dispatch is a no-op.
    expect(() => clickCreate(rig.container)).not.toThrow();
    rig.route.dispose();
  });
});

describe('#today route read ownership', () => {
  it('paints the current read and coalesces source changes into one follow-up', async () => {
    const { subscribe, listeners } = makeSubscribe();
    const releases: Array<() => void> = [];
    const list = vi.fn(async ({ kind }: { kind: string }) => {
      if (kind !== 'task') return { entities: [], total: 0 };
      await new Promise<void>((resolve) => { releases.push(resolve); });
      return { entities: [taskEntity({ due_at: NOW + 100 })], total: 1 };
    });
    const rig = mount({ workEntityListCaller: list as never }, subscribe);
    const first = rig.route.whenLoaded();
    // Five broadcasts during one read must buy exactly ONE follow-up.
    for (let i = 0; i < 5; i++) listeners.get('warehouse')!();
    expect(releases).toHaveLength(1);
    releases[0]!();
    await first;

    expect(rig.html()).toContain('Call Sam');
    expect(releases).toHaveLength(2);
    expect(rig.route.getRecoveryContextFreshness()).toBe('unavailable');
    releases[1]!();
    await rig.route.whenLoaded();
    expect(releases).toHaveLength(2);
    expect(rig.route.getRecoveryContextFreshness()).toBe('current');
    rig.route.dispose();
  });

  it('keeps recovery pending for the current read and reports partial failures as unavailable', async () => {
    let release!: () => void;
    let mode: 'ready' | 'held' | 'failed' = 'ready';
    const list = async ({ kind }: { kind: string }) => {
      if (kind !== 'task') return { entities: [], total: 0 };
      if (mode === 'failed') throw new Error('Tasks unavailable');
      if (mode === 'held') await new Promise<void>((resolve) => { release = resolve; });
      return { entities: [taskEntity({ due_at: NOW + 100 })], total: 1 };
    };
    const rig = mount({ workEntityListCaller: list as never });
    await rig.route.whenLoaded();
    expect(rig.route.getRecoveryContextFreshness()).toBe('current');

    mode = 'held';
    rig.route.refresh();
    let settled = false;
    const refreshed = rig.route.whenLoaded().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(rig.route.getRecoveryContextFreshness()).toBe('unavailable');
    release();
    await refreshed;
    expect(rig.route.getRecoveryContextFreshness()).toBe('current');

    // A source that fails leaves the other sources' rows on screen, and says so.
    mode = 'failed';
    rig.route.refresh();
    await rig.route.whenLoaded();
    expect(rig.route.getRecoveryContextFreshness()).toBe('unavailable');
    expect(rig.html()).toContain('Results below may be incomplete');
    rig.route.dispose();
  });

  it('does not let a superseded read restore old rows after a newer refresh', async () => {
    let release!: () => void;
    let mode: 'ready' | 'held' | 'empty' = 'ready';
    const list = async ({ kind }: { kind: string }) => {
      if (kind !== 'task' || mode === 'empty') return { entities: [], total: 0 };
      if (mode === 'held') await new Promise<void>((resolve) => { release = resolve; });
      return { entities: [taskEntity({ due_at: NOW + 100 })], total: 1 };
    };
    const rig = mount({ workEntityListCaller: list as never });
    await rig.route.whenLoaded();
    expect(rig.html()).toContain('Call Sam');

    mode = 'held';
    rig.route.refresh();
    const retired = rig.route.whenLoaded();
    mode = 'empty';
    rig.route.refresh();
    await rig.route.whenLoaded();
    release();
    await retired;

    expect(rig.html()).not.toContain('Call Sam');
    expect(rig.route.getRecoveryContextFreshness()).toBe('current');
    rig.route.dispose();
  });
});

/** D-290 follow-on — Today re-reads because TIME MOVED.
 *
 *  ⛔ THIS IS NOT A REFRESH CONVENIENCE, IT IS THE SURFACE'S CORRECTNESS. Today
 *  classifies rows by deadline, so the same warehouse data means something
 *  different a minute later and NOTHING BROADCASTS THAT. A page left open
 *  without this keeps yesterday's answer while looking perfectly current.
 *
 *  ⚠ The Data tab had both of these (`todayClock` / `onTodayVisible`); the
 *  D-290 extraction left them behind and this route shipped without them. The
 *  regression was found by deleting the Data route's dead copy and asking
 *  whether the live route had what was being deleted — no test caught it,
 *  because every test here drives reads explicitly.
 */
describe('#today re-reads when the clock moves', () => {
  /** kind === 'task' is requested exactly once per read, so counting it counts
   *  READS — not caller calls, of which one read makes several. */
  const rigWithReadCounter = () => {
    let reads = 0;
    const releases: Array<() => void> = [];
    let hold = false;
    const list = async ({ kind }: { kind: string }) => {
      if (kind !== 'task') return { entities: [], total: 0 };
      reads += 1;
      if (hold) await new Promise<void>((resolve) => { releases.push(resolve); });
      return { entities: [taskEntity({ due_at: NOW + 100 })], total: 1 };
    };
    const rig = mount({ workEntityListCaller: list as never });
    return { ...rig, reads: () => reads, releases, setHold: (v: boolean) => { hold = v; } };
  };

  it('reads again on each tick', async () => {
    const rig = rigWithReadCounter();
    await rig.route.whenLoaded();
    expect(rig.reads()).toBe(1);

    rig.tick();
    await rig.route.whenLoaded();
    expect(rig.reads()).toBe(2);
    rig.route.dispose();
  });

  it('does not start a second read on top of one in flight', async () => {
    const rig = rigWithReadCounter();
    await rig.route.whenLoaded();
    rig.setHold(true);
    rig.route.refresh();
    expect(rig.reads()).toBe(2);

    rig.tick();
    rig.tick();
    // Still 2: the guard is `controller.refreshing()`, and a clock tick is
    // never a reason to interleave two reads of the same thing.
    expect(rig.reads()).toBe(2);
    rig.releases[0]!();
    await rig.route.whenLoaded();
    rig.route.dispose();
  });

  it('stays quiet while the tab is hidden, and reads once on return', async () => {
    const rig = rigWithReadCounter();
    await rig.route.whenLoaded();

    rig.setVisibility('hidden');
    rig.tick();
    expect(rig.reads()).toBe(1);

    // ⚠ Both halves matter: an interval is throttled or skipped outright in a
    // backgrounded tab, so coming back must read rather than wait out the
    // remainder of the minute.
    rig.setVisibility('visible');
    rig.fireVisibility();
    await rig.route.whenLoaded();
    expect(rig.reads()).toBe(2);
    rig.route.dispose();
  });

  /** ⛔ ASSERTS THE DEREGISTRATION, NOT JUST THE SILENCE. `onTick` also checks
   *  `disposed`, so a route that leaked its interval would still read zero
   *  times and pass a reads-only assertion — while firing every minute for the
   *  life of the tab. In a PWA that is a route mounted and dropped a hundred
   *  times over a session. The host-side counts are the only way to see it. */
  it('releases the clock and the listener on dispose', async () => {
    const rig = rigWithReadCounter();
    await rig.route.whenLoaded();
    expect(rig.timers()).toBe(1);
    expect(rig.visibilityListeners()).toBe(1);

    rig.route.dispose();
    expect(rig.timers()).toBe(0);
    expect(rig.visibilityListeners()).toBe(0);

    rig.tick();
    rig.fireVisibility();
    expect(rig.reads()).toBe(1);
  });
});
