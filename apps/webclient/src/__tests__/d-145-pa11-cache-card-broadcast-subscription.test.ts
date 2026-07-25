/** D-145 PA11 follow-on - cache-card broadcast subscription tests.
 *
 *  Covers the live `housekeeping_cycle` subscription seam on
 *  `mountLlmResultCacheCard` and the Settings-route forwarding path.
 */

import { describe, expect, it, vi } from 'vitest';

import type {
  BroadcastEventKind,
  ServerEvent,
} from '@recued/contracts';

import { bootstrapSettingsRoute } from '../settings/bootstrap-settings-route.js';
import { mountLlmResultCacheCard } from '../settings/llm-result-cache-card-mount.js';
import {
  type BroadcastListener,
  type BroadcastSubscriber,
} from '../realtime/subscriber.js';
import { createInMemoryWebclientLocalStore } from '../storage/local-store.js';

type HousekeepingCycleEvent = Extract<ServerEvent, { kind: 'housekeeping_cycle' }>;

// ------------------------------------------------------------------
// Minimal fake DOM - mirrors the bootstrap route tests.
// ------------------------------------------------------------------

interface FakeElement {
  tagName: string;
  textContent: string;
  disabled: boolean;
  className: string;
  value: string;
  readOnly: boolean;
  innerHTML: string;
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
    value: '',
    readOnly: false,
    innerHTML: '',
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
    type: '',
  };
  return el;
};

interface FakeDocument {
  createElement(tag: string): FakeElement;
  head: {
    appendChild(el: FakeElement): FakeElement;
    querySelector(selector: string): FakeElement | null;
  };
  styleTags: FakeElement[];
}

const makeFakeDocument = (): FakeDocument => {
  const styleTags: FakeElement[] = [];
  const parseSelector = (sel: string): { tag: string; attr: string } | null => {
    const m = sel.match(/^([\w-]+)\[([\w-]+)\]$/);
    return m === null ? null : { tag: m[1]!.toUpperCase(), attr: m[2]! };
  };
  return {
    createElement: (tag) => makeFakeElement(tag),
    head: {
      appendChild: (next) => {
        styleTags.push(next);
        return next;
      },
      querySelector: (selector) => {
        const parsed = parseSelector(selector);
        if (parsed === null) return null;
        return (
          styleTags.find(
            (s) => s.tagName === parsed.tag && s.attrs.has(parsed.attr),
          ) ?? null
        );
      },
    },
    styleTags,
  };
};

// ------------------------------------------------------------------
// Broadcast fake.
// ------------------------------------------------------------------

interface FakeSubscribeCall {
  kind: BroadcastEventKind;
  listener: (event: ServerEvent) => void;
  unsubscribeCalls: number;
  unsubscribed: boolean;
  unsubscribe: () => void;
}

const makeFakeSubscribe = () => {
  const calls: FakeSubscribeCall[] = [];
  const subscribe = (<K extends BroadcastEventKind>(
    kind: K,
    listener: BroadcastListener<K>,
  ): (() => void) => {
    const call: FakeSubscribeCall = {
      kind,
      listener: listener as unknown as (event: ServerEvent) => void,
      unsubscribeCalls: 0,
      unsubscribed: false,
      unsubscribe: () => undefined,
    };
    call.unsubscribe = () => {
      call.unsubscribeCalls += 1;
      call.unsubscribed = true;
    };
    calls.push(call);
    return call.unsubscribe;
  }) as BroadcastSubscriber['on'];

  const dispatchHousekeeping = (event: HousekeepingCycleEvent): void => {
    for (const call of calls) {
      if (call.kind === 'housekeeping_cycle' && !call.unsubscribed) {
        call.listener(event);
      }
    }
  };

  return { subscribe, calls, dispatchHousekeeping };
};

const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

const FIXED_NOW = 2_000_000_000_000;

const populatedStats = () => ({
  total_entries: 12,
  total_hits: 36,
  per_topic: [
    { topic: 'summary', entry_count: 8, hit_count: 24 },
    { topic: 'embedding', entry_count: 4, hit_count: 12 },
  ],
  last_gc_at: FIXED_NOW - 3 * 60 * 60 * 1000,
});

// ------------------------------------------------------------------
// mountLlmResultCacheCard subscription behavior
// ------------------------------------------------------------------

describe('D-145 PA11 follow-on - mountLlmResultCacheCard broadcast subscription', () => {
  it('Subscribe wiring - registers exactly one housekeeping_cycle handler on construction', async () => {
    const host = makeFakeElement('div');
    const fakeSubscribe = makeFakeSubscribe();
    const runStats = vi.fn(async () => populatedStats());

    const mount = mountLlmResultCacheCard({
      host: host as unknown as HTMLElement,
      runStats,
      subscribe: fakeSubscribe.subscribe,
      now: () => FIXED_NOW,
    });
    await mount.whenLoaded();

    expect(fakeSubscribe.calls).toHaveLength(1);
    expect(fakeSubscribe.calls[0]?.kind).toBe('housekeeping_cycle');
    mount.dispose();
  });

  it('Refresh fires on matching per_task', async () => {
    const host = makeFakeElement('div');
    const fakeSubscribe = makeFakeSubscribe();
    const runStats = vi.fn(async () => populatedStats());

    const mount = mountLlmResultCacheCard({
      host: host as unknown as HTMLElement,
      runStats,
      subscribe: fakeSubscribe.subscribe,
      now: () => FIXED_NOW,
    });
    await mount.whenLoaded();
    expect(runStats).toHaveBeenCalledTimes(1);

    const event = {
      kind: 'housekeeping_cycle',
      at: FIXED_NOW,
      duration_ms: 5,
      tasks_complete: 1,
      tasks_yielded: 0,
      tasks_errored: 0,
      per_task: [
        {
          task_id: 'llm-result-cache-gc',
          status: 'complete',
          duration_ms: 5,
        },
      ],
      cursor: 1,
    } satisfies HousekeepingCycleEvent;
    fakeSubscribe.dispatchHousekeeping(event);
    await mount.whenLoaded();

    expect(runStats).toHaveBeenCalledTimes(2);
    mount.dispose();
  });

  it('Refresh fires on yield + error statuses', async () => {
    const host = makeFakeElement('div');
    const fakeSubscribe = makeFakeSubscribe();
    const runStats = vi.fn(async () => populatedStats());

    const mount = mountLlmResultCacheCard({
      host: host as unknown as HTMLElement,
      runStats,
      subscribe: fakeSubscribe.subscribe,
      now: () => FIXED_NOW,
    });
    await mount.whenLoaded();
    expect(runStats).toHaveBeenCalledTimes(1);

    const yieldEvent = {
      kind: 'housekeeping_cycle',
      at: FIXED_NOW,
      duration_ms: 5,
      tasks_complete: 0,
      tasks_yielded: 1,
      tasks_errored: 0,
      per_task: [
        {
          task_id: 'llm-result-cache-gc',
          status: 'yield',
          duration_ms: 5,
          yield_reason: 'budget_exhausted',
        },
      ],
      cursor: 2,
    } satisfies HousekeepingCycleEvent;
    fakeSubscribe.dispatchHousekeeping(yieldEvent);
    await mount.whenLoaded();
    expect(runStats).toHaveBeenCalledTimes(2);

    const errorEvent = {
      kind: 'housekeeping_cycle',
      at: FIXED_NOW,
      duration_ms: 5,
      tasks_complete: 0,
      tasks_yielded: 0,
      tasks_errored: 1,
      per_task: [
        {
          task_id: 'llm-result-cache-gc',
          status: 'error',
          duration_ms: 5,
        },
      ],
      cursor: 3,
    } satisfies HousekeepingCycleEvent;
    fakeSubscribe.dispatchHousekeeping(errorEvent);
    await mount.whenLoaded();

    expect(runStats).toHaveBeenCalledTimes(3);
    mount.dispose();
  });

  it('No refresh when per_task lacks the GC task', async () => {
    const host = makeFakeElement('div');
    const fakeSubscribe = makeFakeSubscribe();
    const runStats = vi.fn(async () => populatedStats());

    const mount = mountLlmResultCacheCard({
      host: host as unknown as HTMLElement,
      runStats,
      subscribe: fakeSubscribe.subscribe,
      now: () => FIXED_NOW,
    });
    await mount.whenLoaded();

    const event = {
      kind: 'housekeeping_cycle',
      at: FIXED_NOW,
      duration_ms: 5,
      tasks_complete: 1,
      tasks_yielded: 0,
      tasks_errored: 0,
      per_task: [
        {
          task_id: 'contact-merge-candidate-scan',
          status: 'complete',
          duration_ms: 5,
        },
      ],
      cursor: 4,
    } satisfies HousekeepingCycleEvent;
    fakeSubscribe.dispatchHousekeeping(event);

    expect(runStats).toHaveBeenCalledTimes(1);
    mount.dispose();
  });

  it('No refresh when per_task is empty', async () => {
    const host = makeFakeElement('div');
    const fakeSubscribe = makeFakeSubscribe();
    const runStats = vi.fn(async () => populatedStats());

    const mount = mountLlmResultCacheCard({
      host: host as unknown as HTMLElement,
      runStats,
      subscribe: fakeSubscribe.subscribe,
      now: () => FIXED_NOW,
    });
    await mount.whenLoaded();

    const event = {
      kind: 'housekeeping_cycle',
      at: FIXED_NOW,
      duration_ms: 0,
      tasks_complete: 0,
      tasks_yielded: 0,
      tasks_errored: 0,
      per_task: [],
      cursor: 5,
    } satisfies HousekeepingCycleEvent;
    fakeSubscribe.dispatchHousekeeping(event);

    expect(runStats).toHaveBeenCalledTimes(1);
    mount.dispose();
  });

  it('Multiple events compound', async () => {
    const host = makeFakeElement('div');
    const fakeSubscribe = makeFakeSubscribe();
    const runStats = vi.fn(async () => populatedStats());

    const mount = mountLlmResultCacheCard({
      host: host as unknown as HTMLElement,
      runStats,
      subscribe: fakeSubscribe.subscribe,
      now: () => FIXED_NOW,
    });
    await mount.whenLoaded();

    const event = {
      kind: 'housekeeping_cycle',
      at: FIXED_NOW,
      duration_ms: 5,
      tasks_complete: 1,
      tasks_yielded: 0,
      tasks_errored: 0,
      per_task: [
        {
          task_id: 'llm-result-cache-gc',
          status: 'complete',
          duration_ms: 5,
        },
      ],
      cursor: 6,
    } satisfies HousekeepingCycleEvent;
    fakeSubscribe.dispatchHousekeeping(event);
    fakeSubscribe.dispatchHousekeeping(event);
    await mount.whenLoaded();

    expect(runStats).toHaveBeenCalledTimes(3);
    mount.dispose();
  });

  it('Dispose unsubscribes', async () => {
    const host = makeFakeElement('div');
    const fakeSubscribe = makeFakeSubscribe();
    const runStats = vi.fn(async () => populatedStats());

    const mount = mountLlmResultCacheCard({
      host: host as unknown as HTMLElement,
      runStats,
      subscribe: fakeSubscribe.subscribe,
      now: () => FIXED_NOW,
    });
    await mount.whenLoaded();

    mount.dispose();
    expect(fakeSubscribe.calls[0]?.unsubscribeCalls).toBe(1);

    const event = {
      kind: 'housekeeping_cycle',
      at: FIXED_NOW,
      duration_ms: 5,
      tasks_complete: 1,
      tasks_yielded: 0,
      tasks_errored: 0,
      per_task: [
        {
          task_id: 'llm-result-cache-gc',
          status: 'complete',
          duration_ms: 5,
        },
      ],
      cursor: 7,
    } satisfies HousekeepingCycleEvent;
    fakeSubscribe.dispatchHousekeeping(event);
    await flush();

    expect(runStats).toHaveBeenCalledTimes(1);
  });

  it('No subscribe -> no subscription', async () => {
    const host = makeFakeElement('div');
    const fakeSubscribe = makeFakeSubscribe();
    const runStats = vi.fn(async () => populatedStats());

    const mount = mountLlmResultCacheCard({
      host: host as unknown as HTMLElement,
      runStats,
      now: () => FIXED_NOW,
    });
    await mount.whenLoaded();

    expect(fakeSubscribe.calls).toHaveLength(0);
    mount.dispose();
  });

  it('Disposed-mid-refresh guard', async () => {
    const host = makeFakeElement('div');
    const fakeSubscribe = makeFakeSubscribe();
    let statsCallCount = 0;
    let rejectRefresh!: (err: Error) => void;
    const runStats = vi.fn(() => {
      statsCallCount += 1;
      if (statsCallCount === 1) return Promise.resolve(populatedStats());
      return new Promise<ReturnType<typeof populatedStats>>((_resolve, reject) => {
        rejectRefresh = reject;
      });
    });

    const mount = mountLlmResultCacheCard({
      host: host as unknown as HTMLElement,
      runStats,
      subscribe: fakeSubscribe.subscribe,
      now: () => FIXED_NOW,
    });
    await mount.whenLoaded();

    const event = {
      kind: 'housekeeping_cycle',
      at: FIXED_NOW,
      duration_ms: 5,
      tasks_complete: 1,
      tasks_yielded: 0,
      tasks_errored: 0,
      per_task: [
        {
          task_id: 'llm-result-cache-gc',
          status: 'complete',
          duration_ms: 5,
        },
      ],
      cursor: 8,
    } satisfies HousekeepingCycleEvent;
    fakeSubscribe.dispatchHousekeeping(event);
    expect(runStats).toHaveBeenCalledTimes(2);

    mount.dispose();
    rejectRefresh(new Error('post-dispose refresh failed'));
    await flush();

    expect(mount.getState().loadError).toBeNull();
  });

  it('Refresh failure does not propagate', async () => {
    const host = makeFakeElement('div');
    const fakeSubscribe = makeFakeSubscribe();
    let statsCallCount = 0;
    const runStats = vi.fn(async () => {
      statsCallCount += 1;
      if (statsCallCount === 1) return populatedStats();
      throw new Error('post-event refresh failed');
    });

    const mount = mountLlmResultCacheCard({
      host: host as unknown as HTMLElement,
      runStats,
      subscribe: fakeSubscribe.subscribe,
      now: () => FIXED_NOW,
    });
    await mount.whenLoaded();

    const event = {
      kind: 'housekeeping_cycle',
      at: FIXED_NOW,
      duration_ms: 5,
      tasks_complete: 1,
      tasks_yielded: 0,
      tasks_errored: 0,
      per_task: [
        {
          task_id: 'llm-result-cache-gc',
          status: 'complete',
          duration_ms: 5,
        },
      ],
      cursor: 9,
    } satisfies HousekeepingCycleEvent;
    try {
      fakeSubscribe.dispatchHousekeeping(event);
    } catch (err) {
      expect.fail(`subscribe handler propagated: ${String(err)}`);
    }
    await mount.whenLoaded();

    expect(runStats).toHaveBeenCalledTimes(2);
    expect(mount.getState().loadError).toContain('post-event refresh failed');
    mount.dispose();
  });
});

// ------------------------------------------------------------------
// bootstrapSettingsRoute subscription forwarding
// ------------------------------------------------------------------

describe('D-145 PA11 follow-on - bootstrapSettingsRoute broadcast subscription', () => {
  it('subscribe option forwarded', async () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const fakeSubscribe = makeFakeSubscribe();
    const runStats = vi.fn(async () => populatedStats());

    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
      housekeepingCacheStatsCaller: runStats,
      subscribe: fakeSubscribe.subscribe,
      now: () => FIXED_NOW,
    });
    await route.llmResultCacheCard()!.whenLoaded();

    expect(fakeSubscribe.calls).toHaveLength(1);
    expect(fakeSubscribe.calls[0]?.kind).toBe('housekeeping_cycle');

    const event = {
      kind: 'housekeeping_cycle',
      at: FIXED_NOW,
      duration_ms: 5,
      tasks_complete: 1,
      tasks_yielded: 0,
      tasks_errored: 0,
      per_task: [
        {
          task_id: 'llm-result-cache-gc',
          status: 'complete',
          duration_ms: 5,
        },
      ],
      cursor: 10,
    } satisfies HousekeepingCycleEvent;
    fakeSubscribe.dispatchHousekeeping(event);
    await route.llmResultCacheCard()!.whenLoaded();

    expect(runStats).toHaveBeenCalledTimes(2);
    route.dispose();
  });

  it('subscribe omitted -> no listener', async () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const fakeSubscribe = makeFakeSubscribe();
    const runStats = vi.fn(async () => populatedStats());

    const route = bootstrapSettingsRoute({
      root: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      localStore: createInMemoryWebclientLocalStore(),
      housekeepingCacheStatsCaller: runStats,
      now: () => FIXED_NOW,
    });
    await route.llmResultCacheCard()!.whenLoaded();

    expect(fakeSubscribe.calls).toHaveLength(0);
    route.dispose();
  });
});
