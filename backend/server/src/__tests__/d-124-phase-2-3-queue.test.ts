/** D-124 Phase 2.3 — per-(trigger, record_id) coalescing dispatch queue.
 *
 *  Replaces the fire-and-forget `void onEvent(trigger, event)` callsite
 *  in the dispatcher with a serial drain per `${trigger_id}:${record_id}`
 *  key. Within a key, at most TRIGGER_QUEUE_MAX_DEPTH_PER_KEY entries
 *  exist concurrently — one in-flight + one coalesced tail. Rapid edits
 *  to the same record collapse into the tail; the original `prev` anchor
 *  is preserved across collapses so a "what changed" recipe sees the
 *  diff against state-before-any-edits.
 *
 *  Coverage (queue unit tests + dispatcher integration):
 *   1. Single event drains and processEvent fires once.
 *   2. Same key serializes — second event waits for first to complete.
 *   3. Different keys run in parallel — independent drains.
 *   4. Same trigger, different record_id → different keys → parallel.
 *   5. Different triggers, same record_id → different keys → parallel.
 *   6. Coalesce: third+ events at depth-cap collapse into tail.
 *   7. Coalesce preserves the *original* prev across collapses.
 *   8. Coalesce: tail had no prev → adopts the new event's prev.
 *   9. Coalesce: neither has prev → tail stays prevless.
 *  10. Cleanup: queue + drain maps empty after every key drains.
 *  11. processEvent error swallowed; drain continues to the next entry.
 *  12. drained() resolves once every active drain settles.
 *  13. Dispatcher integration — events route through the queue.
 *  14. Dispatcher integration — coalesce visible end-to-end via runRecipe.
 */

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWarehouseEventBus,
  type WarehouseEvent,
} from '@recued/warehouse-events';
import type { EventTrigger } from '@recued/contracts';
import { createEventTriggersStore } from '../triggers/store.js';
import {
  createEventTriggerDispatcher,
  type TriggerDispatchRuntime,
} from '../triggers/dispatcher.js';
import {
  createTriggerDispatchQueue,
  queueKey,
  TRIGGER_QUEUE_MAX_CONCURRENT_KEYS,
  TRIGGER_QUEUE_MAX_DEPTH_PER_KEY,
  TRIGGER_QUEUE_MAX_KEYS,
} from '../triggers/queue.js';

type RunRecipe = TriggerDispatchRuntime['runRecipe'];

const trigger = (overrides: Partial<EventTrigger> = {}): EventTrigger => ({
  trigger_id: 't-1',
  recipe_id: 'r-1',
  publisher_id: 'local',
  pattern: 'data.mail.**.created',
  enabled: true,
  origin: 'user',
  created_at: 1_000,
  last_fired_at: null,
  last_error: null,
  ...overrides,
});

const event = (overrides: Partial<WarehouseEvent> = {}): WarehouseEvent => ({
  platform: 'mail',
  slug: 'work',
  entity_type: 'message',
  event_kind: 'updated',
  record_id: 'r-1',
  at: 9_000,
  ...overrides,
});

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
const defer = <T = void>(): Deferred<T> => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

// ────────────────────────────────────────────────────────────────
// Queue unit tests
// ────────────────────────────────────────────────────────────────

describe('D-124 Phase 2.3 — TriggerDispatchQueue', () => {
  it('drains a single event through processEvent', async () => {
    const processEvent = vi.fn().mockResolvedValue(undefined);
    const queue = createTriggerDispatchQueue({ processEvent });
    queue.enqueue(trigger(), event());
    await queue.drained();
    expect(processEvent).toHaveBeenCalledOnce();
    expect(queue.activeKeys()).toBe(0);
  });

  it('serializes same-key events — second waits for first', async () => {
    const a = defer();
    const b = defer();
    let inFlight = 0;
    let maxConcurrent = 0;
    const processEvent = vi.fn(async (_t: EventTrigger, e: WarehouseEvent) => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      try {
        // Both share record_id='rA' (same queue key); we differentiate
        // on `at` to gate each call independently.
        await (e.at === 1 ? a.promise : b.promise);
      } finally { inFlight -= 1; }
    });

    const queue = createTriggerDispatchQueue({ processEvent });
    queue.enqueue(trigger(), event({ record_id: 'rA', at: 1 }));
    queue.enqueue(trigger(), event({ record_id: 'rA', at: 2 }));
    await flush();

    // Only the first is in-flight; second sits in the queue tail.
    expect(processEvent).toHaveBeenCalledOnce();
    expect(queue.size(queueKey('t-1', 'rA'))).toBe(2);

    a.resolve();
    await flush();
    // Now the second is in-flight; tail empty.
    expect(processEvent).toHaveBeenCalledTimes(2);
    expect(queue.size(queueKey('t-1', 'rA'))).toBe(1);

    b.resolve();
    await queue.drained();
    expect(maxConcurrent).toBe(1);
  });

  it('runs different keys in parallel', async () => {
    const a = defer();
    const b = defer();
    const inFlight: string[] = [];
    const processEvent = vi.fn(async (_t: EventTrigger, e: WarehouseEvent) => {
      inFlight.push(e.record_id);
      await (e.record_id === 'rA' ? a.promise : b.promise);
    });

    const queue = createTriggerDispatchQueue({ processEvent });
    queue.enqueue(trigger(), event({ record_id: 'rA' }));
    queue.enqueue(trigger(), event({ record_id: 'rB' }));
    await flush();

    // Both in-flight simultaneously — different keys.
    expect(inFlight).toEqual(['rA', 'rB']);
    expect(queue.activeKeys()).toBe(2);

    a.resolve();
    b.resolve();
    await queue.drained();
  });

  it('bounds distinct-key execution and admits waiting keys in order', async () => {
    const gates = [defer(), defer(), defer(), defer()];
    const started: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const queue = createTriggerDispatchQueue({
      maxConcurrentKeys: 2,
      maxKeys: 4,
      processEvent: async (_trigger, e) => {
        const index = Number(e.record_id.slice(1));
        started.push(e.record_id);
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await gates[index].promise;
        concurrent -= 1;
      },
    });

    for (let index = 0; index < gates.length; index += 1) {
      expect(queue.enqueue(trigger(), event({ record_id: `r${index}` }))).toBe(true);
    }
    await flush();
    expect(started).toEqual(['r0', 'r1']);
    expect(queue.activeKeys()).toBe(4);

    gates[0].resolve();
    await flush();
    expect(started).toEqual(['r0', 'r1', 'r2']);
    gates[1].resolve();
    await flush();
    expect(started).toEqual(['r0', 'r1', 'r2', 'r3']);

    gates[2].resolve();
    gates[3].resolve();
    await queue.drained();
    expect(maxConcurrent).toBe(2);
    expect(queue.activeKeys()).toBe(0);
  });

  it('refuses a new key at the retention ceiling but still coalesces a retained key', async () => {
    const first = defer();
    const seen: Array<{ id: string; at: number }> = [];
    const overflows: number[] = [];
    const queue = createTriggerDispatchQueue({
      maxConcurrentKeys: 1,
      maxKeys: 2,
      onOverflow: ({ dropped_events }) => { overflows.push(dropped_events); },
      processEvent: async (_trigger, e) => {
        seen.push({ id: e.record_id, at: e.at });
        if (e.record_id === 'active') await first.promise;
      },
    });

    expect(queue.enqueue(trigger(), event({ record_id: 'active', at: 1 }))).toBe(true);
    expect(queue.enqueue(trigger(), event({ record_id: 'waiting', at: 2 }))).toBe(true);
    expect(queue.enqueue(trigger(), event({ record_id: 'overflow', at: 3 }))).toBe(false);
    expect(queue.enqueue(trigger(), event({ record_id: 'waiting', at: 4 }))).toBe(true);
    expect(queue.enqueue(trigger(), event({ record_id: 'waiting', at: 5 }))).toBe(true);
    expect(queue.activeKeys()).toBe(2);
    expect(queue.droppedEvents()).toBe(1);
    expect(overflows).toEqual([1]);

    first.resolve();
    await queue.drained();
    expect(seen).toEqual([
      { id: 'active', at: 1 },
      { id: 'waiting', at: 2 },
      { id: 'waiting', at: 5 },
    ]);
    expect(seen.some(({ id }) => id === 'overflow')).toBe(false);
  });

  it('different triggers share a record_id but get separate keys', async () => {
    const a = defer();
    const b = defer();
    const inFlight: string[] = [];
    const processEvent = vi.fn(async (t: EventTrigger) => {
      inFlight.push(t.trigger_id);
      await (t.trigger_id === 't-1' ? a.promise : b.promise);
    });

    const queue = createTriggerDispatchQueue({ processEvent });
    queue.enqueue(trigger({ trigger_id: 't-1' }), event({ record_id: 'shared' }));
    queue.enqueue(trigger({ trigger_id: 't-2' }), event({ record_id: 'shared' }));
    await flush();

    expect(inFlight).toEqual(['t-1', 't-2']);
    expect(queue.activeKeys()).toBe(2);
    a.resolve(); b.resolve();
    await queue.drained();
  });

  it('coalesces tail when third event arrives at depth cap', async () => {
    const inFlight = defer();
    const seen: WarehouseEvent[] = [];
    const processEvent = vi.fn(async (_t: EventTrigger, e: WarehouseEvent) => {
      seen.push(e);
      if (e.at === 1) await inFlight.promise; // hold the first
    });

    const queue = createTriggerDispatchQueue({ processEvent });
    queue.enqueue(trigger(), event({ record_id: 'r', at: 1 }));
    queue.enqueue(trigger(), event({ record_id: 'r', at: 2 }));
    queue.enqueue(trigger(), event({ record_id: 'r', at: 3 }));
    queue.enqueue(trigger(), event({ record_id: 'r', at: 4 }));
    await flush();

    // Depth cap=2. e@1 in flight, e@4 sits at the tail (collapsing 2/3/4).
    expect(queue.size(queueKey('t-1', 'r'))).toBe(TRIGGER_QUEUE_MAX_DEPTH_PER_KEY);
    expect(seen).toEqual([expect.objectContaining({ at: 1 })]);

    inFlight.resolve();
    await queue.drained();
    // Two callsites: the in-flight one (at=1) and the coalesced tail (at=4).
    expect(seen.map((e) => e.at)).toEqual([1, 4]);
  });

  it('coalesce preserves the *original* prev anchor across collapses', async () => {
    const inFlight = defer();
    const seen: WarehouseEvent[] = [];
    const processEvent = vi.fn(async (_t: EventTrigger, e: WarehouseEvent) => {
      seen.push(e);
      if (e.at === 1) await inFlight.promise;
    });

    const queue = createTriggerDispatchQueue({ processEvent });
    // First fires immediately. Subsequent edits go through the tail —
    // the prev anchor on the *first* tail (at=2) is the prev a recipe
    // wants to diff against (state before any edits started).
    queue.enqueue(trigger(), event({ record_id: 'r', at: 1, prev: { start_at: 100 } }));
    queue.enqueue(trigger(), event({ record_id: 'r', at: 2, prev: { start_at: 200 } }));
    queue.enqueue(trigger(), event({ record_id: 'r', at: 3, prev: { start_at: 300 } }));
    queue.enqueue(trigger(), event({ record_id: 'r', at: 4, prev: { start_at: 400 } }));
    await flush();

    inFlight.resolve();
    await queue.drained();

    expect(seen).toHaveLength(2);
    // In-flight: untouched.
    expect(seen[0]).toMatchObject({ at: 1, prev: { start_at: 100 } });
    // Coalesced tail: latest current shape (at=4) but prev preserved
    // from the first tail (at=2).
    expect(seen[1]).toMatchObject({ at: 4, prev: { start_at: 200 } });
  });

  it('coalesce keeps changed_fields consistent with the preserved prev anchor (G6 fold: union; mixed presence drops)', async () => {
    const inFlight = defer();
    const seen: WarehouseEvent[] = [];
    const processEvent = vi.fn(async (_t: EventTrigger, e: WarehouseEvent) => {
      seen.push(e);
      if (e.at === 1) await inFlight.promise;
    });

    const queue = createTriggerDispatchQueue({ processEvent });
    queue.enqueue(trigger(), event({ record_id: 'r', at: 1 }));
    // Tail B->C changed `stage`; collapse C->D changed `amount`. The
    // delivered tail carries prev=B, record=D -- the field list must be
    // the UNION, else a recipe gating on `contains stage` skips a real
    // stage change.
    queue.enqueue(
      trigger(),
      event({
        record_id: 'r',
        at: 2,
        prev: { stage: 'b' },
        record: { stage: 'c', amount: 1 },
        changed_fields: ['stage'],
      }),
    );
    queue.enqueue(
      trigger(),
      event({
        record_id: 'r',
        at: 3,
        prev: { stage: 'c', amount: 1 },
        record: { stage: 'c', amount: 2 },
        changed_fields: ['amount'],
      }),
    );
    await flush();
    inFlight.resolve();
    await queue.drained();

    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({
      at: 3,
      prev: { stage: 'b' },
      record: { stage: 'c', amount: 2 },
      changed_fields: ['amount', 'stage'],
    });

    // Mixed presence (one collapsed event lacks the list -- a non-poll
    // source) -> the tail ships NO list rather than a half-true one.
    const inFlight2 = defer();
    const seen2: WarehouseEvent[] = [];
    const queue2 = createTriggerDispatchQueue({
      processEvent: vi.fn(async (_t: EventTrigger, e: WarehouseEvent) => {
        seen2.push(e);
        if (e.at === 1) await inFlight2.promise;
      }),
    });
    queue2.enqueue(trigger(), event({ record_id: 'r', at: 1 }));
    queue2.enqueue(
      trigger(),
      event({ record_id: 'r', at: 2, prev: { stage: 'b' }, changed_fields: ['stage'] }),
    );
    queue2.enqueue(trigger(), event({ record_id: 'r', at: 3, prev: { stage: 'c' } }));
    await flush();
    inFlight2.resolve();
    await queue2.drained();
    expect(seen2).toHaveLength(2);
    expect(seen2[1]!.changed_fields).toBeUndefined();
  });

  it('coalesce: tail had no prev → adopts the incoming prev', async () => {
    const inFlight = defer();
    const seen: WarehouseEvent[] = [];
    const processEvent = vi.fn(async (_t: EventTrigger, e: WarehouseEvent) => {
      seen.push(e);
      if (e.at === 1) await inFlight.promise;
    });

    const queue = createTriggerDispatchQueue({ processEvent });
    queue.enqueue(trigger(), event({ record_id: 'r', at: 1 }));
    // Tail is a `created`/`synced`-shape event with no prev.
    queue.enqueue(trigger(), event({ record_id: 'r', at: 2, event_kind: 'created' }));
    // Coalescer: tail has no prev, so the incoming `prev` rides through.
    queue.enqueue(trigger(), event({ record_id: 'r', at: 3, prev: { x: 1 } }));
    await flush();
    inFlight.resolve();
    await queue.drained();

    expect(seen[1]).toMatchObject({ at: 3, prev: { x: 1 } });
  });

  it('coalesce: neither has prev → tail stays prevless', async () => {
    const inFlight = defer();
    const seen: WarehouseEvent[] = [];
    const processEvent = vi.fn(async (_t: EventTrigger, e: WarehouseEvent) => {
      seen.push(e);
      if (e.at === 1) await inFlight.promise;
    });

    const queue = createTriggerDispatchQueue({ processEvent });
    queue.enqueue(trigger(), event({ record_id: 'r', at: 1 }));
    queue.enqueue(trigger(), event({ record_id: 'r', at: 2, event_kind: 'created' }));
    queue.enqueue(trigger(), event({ record_id: 'r', at: 3, event_kind: 'created' }));
    await flush();
    inFlight.resolve();
    await queue.drained();

    expect(seen[1]).toMatchObject({ at: 3 });
    expect(seen[1].prev).toBeUndefined();
    expect('prev' in seen[1]).toBe(false);
  });

  it('cleans up queue + drain maps after every key drains', async () => {
    const processEvent = vi.fn().mockResolvedValue(undefined);
    const queue = createTriggerDispatchQueue({ processEvent });
    queue.enqueue(trigger({ trigger_id: 't-a' }), event({ record_id: 'r-1' }));
    queue.enqueue(trigger({ trigger_id: 't-b' }), event({ record_id: 'r-2' }));
    await queue.drained();
    expect(queue.activeKeys()).toBe(0);
    expect(queue.size(queueKey('t-a', 'r-1'))).toBe(0);
    expect(queue.size(queueKey('t-b', 'r-2'))).toBe(0);
  });

  it('⛔ K=4 — the key ceiling bounds LIVE keys, not lifetime keys', async () => {
    // ⚠ THE HORIZON QUESTION THE SINGLE-CYCLE CLEANUP TEST ABOVE CANNOT ANSWER.
    // That one drains two keys and asserts the maps are empty, which proves
    // cleanup happens ONCE. It does not distinguish "cleans up" from "cleans up
    // the first time" — and if it did not, `TRIGGER_QUEUE_MAX_KEYS` would be a
    // LIFETIME budget: every reactive trigger on a mail server would stop firing
    // forever after 1,024 distinct messages, with only a rate-limited daemon
    // warning to say so. On a live server that is a subsystem that works for a
    // week and then silently never fires again.
    //
    // Driven at 4x the ceiling: accepted 4,096/4,096, refused 0, dropped 0,
    // activeKeys back to 0 after every cycle.
    const queue = createTriggerDispatchQueue({ processEvent: async () => {} });
    let accepted = 0;
    const afterEachCycle: number[] = [];
    for (let cycle = 1; cycle <= 4; cycle++) {
      for (let i = 0; i < TRIGGER_QUEUE_MAX_KEYS; i++) {
        if (queue.enqueue(trigger({ trigger_id: `t-${cycle}` }),
          event({ record_id: `rec-${cycle}-${i}` }))) accepted += 1;
      }
      await queue.drained();
      afterEachCycle.push(queue.activeKeys());
    }
    expect(accepted, 'every key across all four cycles was accepted')
      .toBe(TRIGGER_QUEUE_MAX_KEYS * 4);
    expect(afterEachCycle, 'no key survives its own drain, on any cycle')
      .toEqual([0, 0, 0, 0]);
    expect(queue.droppedEvents(), 'nothing was refused at any point').toBe(0);
  });

  it('swallows processEvent errors — drain continues', async () => {
    const seen: number[] = [];
    const processEvent = vi.fn(async (_t: EventTrigger, e: WarehouseEvent) => {
      seen.push(e.at);
      if (e.at === 1) throw new Error('boom');
    });
    const queue = createTriggerDispatchQueue({ processEvent });
    queue.enqueue(trigger(), event({ record_id: 'r', at: 1 }));
    queue.enqueue(trigger(), event({ record_id: 'r', at: 2 }));
    await queue.drained();
    expect(seen).toEqual([1, 2]);
  });

  it('depth cap is fixed at 2 — in-flight + one tail', () => {
    expect(TRIGGER_QUEUE_MAX_DEPTH_PER_KEY).toBe(2);
    expect(TRIGGER_QUEUE_MAX_CONCURRENT_KEYS).toBe(16);
    expect(TRIGGER_QUEUE_MAX_KEYS).toBe(1_024);
  });

  it('drained() resolves once every active drain settles', async () => {
    const a = defer();
    const b = defer();
    const processEvent = vi.fn(async (_t: EventTrigger, e: WarehouseEvent) => {
      await (e.record_id === 'rA' ? a.promise : b.promise);
    });
    const queue = createTriggerDispatchQueue({ processEvent });
    queue.enqueue(trigger(), event({ record_id: 'rA' }));
    queue.enqueue(trigger(), event({ record_id: 'rB' }));
    let settled = false;
    const drainedP = queue.drained().then(() => { settled = true; });
    await flush();
    expect(settled).toBe(false);
    a.resolve();
    await flush();
    expect(settled).toBe(false);
    b.resolve();
    await drainedP;
    expect(settled).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// Dispatcher integration
// ────────────────────────────────────────────────────────────────

describe('D-124 Phase 2.3 — dispatcher routes through queue', () => {
  let db: Database.Database;
  let bus: ReturnType<typeof createWarehouseEventBus>;
  let store: ReturnType<typeof createEventTriggersStore>;

  beforeEach(() => {
    db = new Database(':memory:');
    bus = createWarehouseEventBus();
    store = createEventTriggersStore(db);
  });

  it('exposes activeQueueKeys() + drained() and routes events through enqueue', async () => {
    const inFlight = defer();
    const runRecipe = vi.fn<RunRecipe>().mockImplementation(async () => {
      await inFlight.promise;
    });
    store.create({
      trigger_id: 't-mail',
      recipe_id: 'r-mail',
      publisher_id: 'local',
      pattern: 'data.mail.**.created',
      enabled: true,
      created_at: 1_000,
    });
    const dispatcher = createEventTriggerDispatcher({
      bus,
      store,
      runtime: { runRecipe },
      now: () => 10_000,
    });
    dispatcher.rebuild();

    bus.emit({
      platform: 'mail',
      slug: 'work',
      entity_type: 'message',
      event_kind: 'created',
      record_id: 'msg-1',
      at: 9_000,
    });
    await flush();

    expect(runRecipe).toHaveBeenCalledOnce();
    expect(dispatcher.activeQueueKeys()).toBe(1);

    inFlight.resolve();
    await dispatcher.drained();
    expect(dispatcher.activeQueueKeys()).toBe(0);
  });

  it('coalesces rapid edits to the same record across the dispatcher', async () => {
    const inFlight = defer();
    const seen: Array<Record<string, unknown>> = [];
    const runRecipe = vi.fn<RunRecipe>().mockImplementation(async (input) => {
      const evt = (input.context.event as { payload: Record<string, unknown> }).payload;
      seen.push(evt);
      if (evt.at === 1) await inFlight.promise;
    });
    store.create({
      trigger_id: 't-cal',
      recipe_id: 'r-cal',
      publisher_id: 'local',
      pattern: 'data.calendar.**.updated',
      enabled: true,
      created_at: 1_000,
    });
    const dispatcher = createEventTriggerDispatcher({
      bus,
      store,
      runtime: { runRecipe },
      now: () => 10_000,
    });
    dispatcher.rebuild();

    // Four updates to the same calendar event.
    for (let i = 1; i <= 4; i += 1) {
      bus.emit({
        platform: 'calendar',
        slug: 'personal',
        entity_type: 'event',
        event_kind: 'updated',
        record_id: 'evt-1',
        at: i,
        prev: { start_at: i * 100 },
      });
    }
    await flush();
    inFlight.resolve();
    await dispatcher.drained();

    // 4 emits collapse to 2 runRecipe calls (in-flight @1 + coalesced tail @4
    // with prev preserved from @2).
    expect(runRecipe).toHaveBeenCalledTimes(2);
    expect(seen[0]).toMatchObject({ at: 1, prev: { start_at: 100 } });
    expect(seen[1]).toMatchObject({ at: 4, prev: { start_at: 200 } });
  });
});
