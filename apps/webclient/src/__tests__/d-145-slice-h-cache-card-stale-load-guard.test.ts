/** D-145 PA11 follow-on Slice H - cache-card stale-load guard. */

import { describe, expect, it } from 'vitest';

import {
  LLM_RESULT_CACHE_GC_TASK_ID,
  type BroadcastEventKind,
  type ServerEvent,
} from '@recued/contracts';

import {
  mountLlmResultCacheCard,
  type LlmResultCacheClearCaller,
  type LlmResultCacheStatsCaller,
} from '../settings/llm-result-cache-card-mount.js';
import {
  type BroadcastListener,
  type BroadcastSubscriber,
} from '../realtime/subscriber.js';

// ════════════════════════════════════════════════════════════════
// Fake host (mirror of d-156-phase-5-devices-page-mount.test.ts)
// ════════════════════════════════════════════════════════════════

const makeFakeHost = () => {
  let html = '';
  const attrs = new Map<string, string>();
  const listeners: Record<string, Set<(event: Event) => void>> = {};
  const host = {
    get innerHTML() {
      return html;
    },
    set innerHTML(value: string) {
      html = value;
    },
    setAttribute: (k: string, v: string): void => {
      attrs.set(k, v);
    },
    removeAttribute: (k: string): void => {
      attrs.delete(k);
    },
    getAttribute: (k: string): string | null => attrs.get(k) ?? null,
    hasAttribute: (k: string): boolean => attrs.has(k),
    addEventListener: (evt: string, fn: (event: Event) => void): void => {
      (listeners[evt] ??= new Set()).add(fn);
    },
    removeEventListener: (evt: string, fn: (event: Event) => void): void => {
      listeners[evt]?.delete(fn);
    },
  } as unknown as HTMLElement;
  const fire = (evt: string, target: unknown): void => {
    for (const fn of [...(listeners[evt] ?? [])]) {
      fn({ target, type: evt, preventDefault: () => {} } as unknown as Event);
    }
  };
  return {
    host,
    getHtml: () => html,
    getAttr: (k: string) => attrs.get(k) ?? null,
    listenerCount: () =>
      Object.values(listeners).reduce((n, s) => n + s.size, 0),
    clickAction: (action: string): void => {
      const actionEl = {
        getAttribute: (name: string) => (name === 'data-action' ? action : null),
      };
      const target = {
        closest: (selector: string) =>
          selector === '[data-action]' ? actionEl : null,
      };
      fire('click', target);
    },
  };
};

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const FIXED_NOW = 2_000_000_000_000;

type CacheStats = Awaited<ReturnType<LlmResultCacheStatsCaller>>;
type HousekeepingCycleEvent = Extract<ServerEvent, { kind: 'housekeeping_cycle' }>;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const statsFor = (
  topic: string,
  totalEntries: number,
): CacheStats => ({
  total_entries: totalEntries,
  total_hits: totalEntries * 3,
  per_topic: [
    {
      topic,
      entry_count: totalEntries,
      hit_count: totalEntries * 3,
    },
  ],
  last_gc_at: FIXED_NOW - 60 * 60 * 1000,
});

const makeQueuedRunStats = () => {
  const steps: Array<() => Promise<CacheStats>> = [];
  const calls: number[] = [];
  const runStats: LlmResultCacheStatsCaller = () => {
    calls.push(calls.length + 1);
    const step = steps.shift();
    if (step === undefined) {
      return Promise.reject(new Error(`unexpected cache stats call ${calls.length}`));
    }
    return step();
  };
  return {
    runStats,
    calls,
    push: (step: () => Promise<CacheStats>) => {
      steps.push(step);
    },
    pushValue: (stats: CacheStats) => {
      steps.push(() => Promise.resolve(stats));
    },
    pushError: (message: string) => {
      steps.push(() => Promise.reject(new Error(message)));
    },
    pushDeferred: (next: Deferred<CacheStats>) => {
      steps.push(() => next.promise);
    },
  };
};

const setupLoadedQueuedMount = async (
  initialStats: CacheStats = statsFor('seed-topic', 1),
) => {
  const fakeHost = makeFakeHost();
  const queue = makeQueuedRunStats();
  queue.pushValue(initialStats);
  const mount = mountLlmResultCacheCard({
    host: fakeHost.host,
    runStats: queue.runStats,
    now: () => FIXED_NOW,
  });
  await mount.whenLoaded();
  expect(mount.getState().loading).toBe(false);
  expect(mount.getState().stats?.per_topic[0]?.topic).toBe(
    initialStats.per_topic[0]?.topic,
  );
  return { fakeHost, mount, queue };
};

interface FakeSubscribeCall {
  kind: BroadcastEventKind;
  listener: (event: ServerEvent) => void;
  unsubscribed: boolean;
  unsubscribeCalls: number;
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
      unsubscribed: false,
      unsubscribeCalls: 0,
    };
    calls.push(call);
    return () => {
      call.unsubscribeCalls += 1;
      call.unsubscribed = true;
    };
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

const housekeepingCycleEvent = (cursor = 1): HousekeepingCycleEvent => ({
  kind: 'housekeeping_cycle',
  at: FIXED_NOW,
  duration_ms: 5,
  tasks_complete: 1,
  tasks_yielded: 0,
  tasks_errored: 0,
  per_task: [
    {
      task_id: LLM_RESULT_CACHE_GC_TASK_ID,
      status: 'complete',
      duration_ms: 5,
    },
  ],
  cursor,
});

const expectCacheStats = (
  mount: ReturnType<typeof mountLlmResultCacheCard>,
  fakeHost: ReturnType<typeof makeFakeHost>,
  topic: string,
  totalEntries: number,
): void => {
  const state = mount.getState();
  expect(state.loading).toBe(false);
  expect(state.loadError).toBeNull();
  expect(state.stats?.total_entries).toBe(totalEntries);
  expect(state.stats?.per_topic.map((t) => t.topic)).toEqual([topic]);
  expect(fakeHost.getHtml()).toContain(`<dd>${totalEntries}</dd>`);
  expect(fakeHost.getHtml()).toContain(`<code>${topic}</code>`);
};

const expectLoadingWithoutTopic = (
  mount: ReturnType<typeof mountLlmResultCacheCard>,
  fakeHost: ReturnType<typeof makeFakeHost>,
  topic: string,
): void => {
  expect(mount.getState().loading).toBe(true);
  expect(mount.getState().loadError).toBeNull();
  expect(mount.getState().stats?.per_topic.map((t) => t.topic)).toEqual([
    'seed-topic',
  ]);
  expect(fakeHost.getHtml()).toContain('<code>seed-topic</code>');
  expect(fakeHost.getHtml()).not.toContain(`<code>${topic}</code>`);
};

// ==================================================================
// Group 1 - Two-kick race, newer resolves first
// ==================================================================

describe('D-145 Slice H cache card - newer refresh wins', () => {
  it('drops stale success after a newer successful refresh paints', async () => {
    const { fakeHost, mount, queue } = await setupLoadedQueuedMount();
    const stale = deferred<CacheStats>();
    queue.pushDeferred(stale);
    const staleRefresh = mount.refresh();
    expect(mount.getState().loading).toBe(true);

    queue.pushValue(statsFor('fresh-topic', 12));
    await mount.refresh();
    expectCacheStats(mount, fakeHost, 'fresh-topic', 12);

    stale.resolve(statsFor('stale-topic', 3));
    await staleRefresh;
    expectCacheStats(mount, fakeHost, 'fresh-topic', 12);
    expect(fakeHost.getHtml()).not.toContain('stale-topic');
  });

  it('drops stale throw after a newer successful refresh paints', async () => {
    const { fakeHost, mount, queue } = await setupLoadedQueuedMount();
    const stale = deferred<CacheStats>();
    queue.pushDeferred(stale);
    const staleRefresh = mount.refresh();

    queue.pushValue(statsFor('fresh-topic', 12));
    await mount.refresh();
    expectCacheStats(mount, fakeHost, 'fresh-topic', 12);

    stale.reject(new Error('stale cache failure'));
    await staleRefresh;
    expect(mount.getState().loadError).toBeNull();
    expectCacheStats(mount, fakeHost, 'fresh-topic', 12);
  });

  it('stays loading until the freshest in-flight refresh resolves', async () => {
    const { fakeHost, mount, queue } = await setupLoadedQueuedMount();
    const stale = deferred<CacheStats>();
    const fresh = deferred<CacheStats>();
    queue.pushDeferred(stale);
    const staleRefresh = mount.refresh();
    queue.pushDeferred(fresh);
    const freshRefresh = mount.refresh();

    expectLoadingWithoutTopic(mount, fakeHost, 'fresh-topic');
    fresh.resolve(statsFor('fresh-topic', 12));
    await freshRefresh;
    expectCacheStats(mount, fakeHost, 'fresh-topic', 12);

    stale.resolve(statsFor('stale-topic', 3));
    await staleRefresh;
    expectCacheStats(mount, fakeHost, 'fresh-topic', 12);
  });
});

// ==================================================================
// Group 2 - Two-kick race, older resolves first
// ==================================================================

describe('D-145 Slice H cache card - older result cannot leak', () => {
  it('drops an immediately resolved older refresh when a newer kick starts before its microtask', async () => {
    const { fakeHost, mount, queue } = await setupLoadedQueuedMount();
    const fresh = deferred<CacheStats>();

    queue.pushValue(statsFor('old-topic', 4));
    const oldRefresh = mount.refresh();
    queue.pushDeferred(fresh);
    const freshRefresh = mount.refresh();

    await flush();
    await oldRefresh;
    expectLoadingWithoutTopic(mount, fakeHost, 'old-topic');

    fresh.resolve(statsFor('fresh-topic', 12));
    await freshRefresh;
    expectCacheStats(mount, fakeHost, 'fresh-topic', 12);
  });

  it('drops a controlled older refresh that resolves before the newer one', async () => {
    const { fakeHost, mount, queue } = await setupLoadedQueuedMount();
    const old = deferred<CacheStats>();
    const fresh = deferred<CacheStats>();

    queue.pushDeferred(old);
    const oldRefresh = mount.refresh();
    queue.pushDeferred(fresh);
    const freshRefresh = mount.refresh();

    old.resolve(statsFor('old-topic', 4));
    await oldRefresh;
    expectLoadingWithoutTopic(mount, fakeHost, 'old-topic');

    fresh.resolve(statsFor('fresh-topic', 12));
    await freshRefresh;
    expectCacheStats(mount, fakeHost, 'fresh-topic', 12);
  });
});

// ==================================================================
// Group 3 - Three+ kicks
// ==================================================================

describe('D-145 Slice H cache card - three refreshes', () => {
  it('keeps C data when A and B resolve after C', async () => {
    const { fakeHost, mount, queue } = await setupLoadedQueuedMount();
    const a = deferred<CacheStats>();
    const b = deferred<CacheStats>();
    queue.pushDeferred(a);
    const aRefresh = mount.refresh();
    queue.pushDeferred(b);
    const bRefresh = mount.refresh();
    queue.pushValue(statsFor('fresh-c', 30));
    await mount.refresh();

    expectCacheStats(mount, fakeHost, 'fresh-c', 30);
    a.resolve(statsFor('stale-a', 1));
    b.resolve(statsFor('stale-b', 2));
    await Promise.all([aRefresh, bRefresh]);
    expectCacheStats(mount, fakeHost, 'fresh-c', 30);
  });
});

// ==================================================================
// Group 4 - Error path guard
// ==================================================================

describe('D-145 Slice H cache card - error path guard', () => {
  it('drops an older error when a newer success is already in flight', async () => {
    const { fakeHost, mount, queue } = await setupLoadedQueuedMount();
    const fresh = deferred<CacheStats>();

    queue.pushError('older cache failure');
    const oldRefresh = mount.refresh();
    queue.pushDeferred(fresh);
    const freshRefresh = mount.refresh();

    await oldRefresh;
    expectLoadingWithoutTopic(mount, fakeHost, 'old-topic');
    fresh.resolve(statsFor('fresh-topic', 12));
    await freshRefresh;
    expectCacheStats(mount, fakeHost, 'fresh-topic', 12);
  });

  it('lets the newest error win over an older pending success', async () => {
    const { fakeHost, mount, queue } = await setupLoadedQueuedMount();
    const oldSuccess = deferred<CacheStats>();

    queue.pushDeferred(oldSuccess);
    const oldRefresh = mount.refresh();
    queue.pushError('newest cache failure');
    await mount.refresh();

    expect(mount.getState().loading).toBe(false);
    expect(mount.getState().loadError).toBe('newest cache failure');
    expect(fakeHost.getHtml()).toContain('newest cache failure');

    oldSuccess.resolve(statsFor('old-success', 5));
    await oldRefresh;
    expect(mount.getState().loadError).toBe('newest cache failure');
    expect(fakeHost.getHtml()).not.toContain('old-success');
  });
});

// ==================================================================
// Group 5 - Counter scope
// ==================================================================

describe('D-145 Slice H cache card - mount-local counter scope', () => {
  it('does not let card 2 invalidate card 1 initial load', async () => {
    const card1Host = makeFakeHost();
    const card1Queue = makeQueuedRunStats();
    const card1Load = deferred<CacheStats>();
    card1Queue.pushDeferred(card1Load);
    const card1 = mountLlmResultCacheCard({
      host: card1Host.host,
      runStats: card1Queue.runStats,
      now: () => FIXED_NOW,
    });

    const card2Host = makeFakeHost();
    const card2Queue = makeQueuedRunStats();
    card2Queue.pushValue(statsFor('card-2-topic', 2));
    const card2 = mountLlmResultCacheCard({
      host: card2Host.host,
      runStats: card2Queue.runStats,
      now: () => FIXED_NOW,
    });
    await card2.whenLoaded();
    expectCacheStats(card2, card2Host, 'card-2-topic', 2);

    card1Load.resolve(statsFor('card-1-topic', 1));
    await card1.whenLoaded();
    expectCacheStats(card1, card1Host, 'card-1-topic', 1);
  });
});

// ==================================================================
// Group 6 - Dispose interaction
// ==================================================================

describe('D-145 Slice H cache card - dispose interaction', () => {
  it('does not write state when a hung refresh resolves after dispose', async () => {
    const fakeHost = makeFakeHost();
    const queue = makeQueuedRunStats();
    const hung = deferred<CacheStats>();
    queue.pushDeferred(hung);
    const mount = mountLlmResultCacheCard({
      host: fakeHost.host,
      runStats: queue.runStats,
      now: () => FIXED_NOW,
    });

    mount.dispose();
    hung.resolve(statsFor('post-dispose', 9));
    await mount.whenLoaded();
    expect(fakeHost.getHtml()).toBe('');
    expect(mount.getState().loading).toBe(true);
    expect(mount.getState().stats).toBeNull();
  });

  it('does not write state when multiple hung refreshes resolve after dispose', async () => {
    const { fakeHost, mount, queue } = await setupLoadedQueuedMount();
    const a = deferred<CacheStats>();
    const b = deferred<CacheStats>();
    queue.pushDeferred(a);
    const aRefresh = mount.refresh();
    queue.pushDeferred(b);
    const bRefresh = mount.refresh();

    mount.dispose();
    a.resolve(statsFor('post-dispose-a', 8));
    b.resolve(statsFor('post-dispose-b', 9));
    await Promise.all([aRefresh, bRefresh]);
    expect(fakeHost.getHtml()).toBe('');
    expect(mount.getState().loading).toBe(true);
    expect(mount.getState().stats?.per_topic[0]?.topic).toBe('seed-topic');
  });
});

// ==================================================================
// Group 7 - Existing call-site compat
// ==================================================================

describe('D-145 Slice H cache card - refresh promise compatibility', () => {
  it('refresh promise resolves after state write on the newest success', async () => {
    const { fakeHost, mount, queue } = await setupLoadedQueuedMount();
    queue.pushValue(statsFor('fresh-topic', 12));

    await mount.refresh();
    expectCacheStats(mount, fakeHost, 'fresh-topic', 12);
  });

  it('stale refresh promise resolves after its stale drop completes', async () => {
    const { fakeHost, mount, queue } = await setupLoadedQueuedMount();
    const stale = deferred<CacheStats>();
    let staleSettled = false;
    queue.pushDeferred(stale);
    const staleRefresh = mount.refresh().then(() => {
      staleSettled = true;
    });

    queue.pushValue(statsFor('fresh-topic', 12));
    await mount.refresh();
    expect(staleSettled).toBe(false);
    expectCacheStats(mount, fakeHost, 'fresh-topic', 12);

    stale.resolve(statsFor('stale-topic', 3));
    await staleRefresh;
    expect(staleSettled).toBe(true);
    expectCacheStats(mount, fakeHost, 'fresh-topic', 12);
  });
});

// ==================================================================
// Group 8 - Cache card-specific post-clear refresh interaction
// ==================================================================

describe('D-145 Slice H cache card - post-clear refresh interaction', () => {
  it('keeps the newer post-clear refresh over a broadcast refresh fired between clear and chain', async () => {
    const fakeHost = makeFakeHost();
    const fakeSubscribe = makeFakeSubscribe();
    const queue = makeQueuedRunStats();
    const clear = deferred<Awaited<ReturnType<LlmResultCacheClearCaller>>>();
    const broadcastRefresh = deferred<CacheStats>();
    const chainedRefresh = deferred<CacheStats>();
    const runClear: LlmResultCacheClearCaller = () => clear.promise;
    queue.pushValue(statsFor('initial-topic', 20));

    const mount = mountLlmResultCacheCard({
      host: fakeHost.host,
      runStats: queue.runStats,
      runClear,
      subscribe: fakeSubscribe.subscribe,
      now: () => FIXED_NOW,
    });
    await mount.whenLoaded();
    expectCacheStats(mount, fakeHost, 'initial-topic', 20);

    fakeHost.clickAction('housekeeping-cache-clear');
    fakeHost.clickAction('housekeeping-cache-clear-confirm');
    expect(mount.getState().clearing).toBe(true);
    expect(mount.hasInFlightWork()).toBe(true);

    queue.pushDeferred(broadcastRefresh);
    queue.pushDeferred(chainedRefresh);
    clear.resolve({ ok: true, rows_deleted: 20 });
    fakeSubscribe.dispatchHousekeeping(housekeepingCycleEvent(100));
    expect(queue.calls).toHaveLength(2);

    await flush();
    expect(queue.calls).toHaveLength(3);
    expect(mount.hasInFlightWork()).toBe(false);
    chainedRefresh.resolve(statsFor('post-clear-topic', 1));
    await mount.whenClearSettled();
    expectCacheStats(mount, fakeHost, 'post-clear-topic', 1);

    broadcastRefresh.resolve(statsFor('broadcast-stale-topic', 9));
    await mount.whenLoaded();
    expectCacheStats(mount, fakeHost, 'post-clear-topic', 1);
    expect(fakeHost.getHtml()).not.toContain('broadcast-stale-topic');
  });
});
