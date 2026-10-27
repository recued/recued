/** Event triggers — what a restart's `pause_scheduler` step needs from
 *  `dispose(); await drained()`.
 *
 *  The stop used to wait for the whole queued backlog (up to 1,024 keys, 16 at
 *  a time, each a recipe run), kept dispatching queued events after dispose,
 *  and with a sealed vault waited for an unlock that never came — all inside a
 *  5 s drain step. These pin that the stop starts nothing queued, returns
 *  within `STOP_GRACE_MS` while a run never finishes, and that a mail fact's
 *  event — announced once, so nothing would ever deliver it again — is parked
 *  in the store and replayed by the next start, in the order it came. A run
 *  the draining server refused (`draining`) is that same "not run", never a
 *  failure. */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAIL_FACT_EVENT_PLATFORM, RpcError, type EventTrigger } from '@recued/contracts';
import { createWarehouseEventBus, type WarehouseEvent } from '@recued/warehouse-events';

import { createEventTriggerDispatcher, type TriggerDispatchRuntime } from '../triggers/dispatcher.js';
import { createTriggerDispatchQueue, type TriggerQueueEntry } from '../triggers/queue.js';
import { createEventTriggersStore, type EventTriggersStore } from '../triggers/store.js';
import { STOP_GRACE_MS } from '../lifecycle/settle-within.js';

type RunInput = Parameters<TriggerDispatchRuntime['runRecipe']>[0];

const FACT_TRIGGER = {
  trigger_id: 't-fact',
  recipe_id: 'r-fact',
  publisher_id: 'local',
  pattern: 'data.mail_fact.shipment.thing.*',
  enabled: true,
  created_at: 1_000,
} as const;

const MAIL_TRIGGER = {
  trigger_id: 't-mail',
  recipe_id: 'r-mail',
  publisher_id: 'local',
  pattern: 'data.mail.**.created',
  enabled: true,
  created_at: 1_000,
} as const;

/** One email's news about a thing. `at` names the event in assertions. */
const fact = (at: number, thing = 'thing-1'): WarehouseEvent => ({
  platform: MAIL_FACT_EVENT_PLATFORM,
  slug: 'shipment',
  entity_type: 'thing',
  event_kind: 'updated',
  record_id: thing,
  at,
  record: { fact: { email: { record_id: `m-${at}` } }, state: 'in_transit' },
  prev: { state: null },
  // A change of state: a change of the time alone wakes no row (ruling 44).
  changed_fields: ['state'],
});

const mail = (record_id: string, at = 1): WarehouseEvent => ({
  platform: 'mail', slug: 'work', entity_type: 'message', event_kind: 'created', record_id, at,
});

/** The event a run was started for, as its recipe context names it. */
const atOf = (input: RunInput): number =>
  (input.context as { event: { payload: { at: number } } }).event.payload.at;

const ats = (inputs: readonly RunInput[]): number[] => inputs.map(atOf);

const parked = (store: EventTriggersStore) =>
  store.listParkedTriggerEvents!(0, 100).map((row) => [row.trigger_id, row.event.at]);

const defer = <T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const flush = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

const draining = (): RpcError => new RpcError('draining', 'The server is restarting; try again in a moment.', 503);

afterEach(() => {
  vi.useRealTimers();
});

const setup = (
  runRecipe: TriggerDispatchRuntime['runRecipe'],
  extra: Partial<Parameters<typeof createEventTriggerDispatcher>[0]> = {},
) => {
  const db = new Database(':memory:');
  const store = createEventTriggersStore(db);
  store.create(FACT_TRIGGER);
  store.create(MAIL_TRIGGER);
  const bus = createWarehouseEventBus();
  const dispatcher = createEventTriggerDispatcher({ bus, store, runtime: { runRecipe }, ...extra });
  dispatcher.rebuild();
  return { db, store, bus, dispatcher };
};

describe('trigger queue stop()', () => {
  const trigger = { ...FACT_TRIGGER, origin: 'user', last_fired_at: null, last_error: null } as EventTrigger;

  it('starts nothing queued; a running key hands its events over after the one running, in order', async () => {
    const running = defer();
    const processed: number[] = [];
    const handed: number[] = [];
    const queue = createTriggerDispatchQueue({
      maxConcurrentKeys: 1,
      processEvent: async (_trigger, event) => {
        processed.push(event.at);
        if (event.at === 1) await running.promise;
      },
      onUnstarted: (entries: readonly TriggerQueueEntry[]) => { handed.push(...entries.map((e) => e.event.at)); },
    });
    queue.enqueue(trigger, fact(1, 'a'));
    queue.enqueue(trigger, fact(2, 'a'));
    queue.enqueue(trigger, fact(3, 'a'));
    queue.enqueue(trigger, fact(10, 'b')); // waits: one key at a time
    await flush();

    queue.stop();
    // The waiting key is handed over at once; the running key's tail waits for
    // its running event, so the key's events stay in order.
    expect(handed).toEqual([10]);
    running.resolve();
    await queue.idle();
    expect(handed).toEqual([10, 2, 3]);
    expect(processed).toEqual([1]);
    // Stopped, a new event goes straight to the hand-over.
    expect(queue.enqueue(trigger, fact(4, 'a'))).toBe(false);
    expect(handed).toEqual([10, 2, 3, 4]);
  });

  it("an event answered 'not_run' is handed over ahead of what its key set aside", async () => {
    const refused = defer<'not_run'>();
    const handed: number[] = [];
    const queue = createTriggerDispatchQueue({
      processEvent: async (_trigger, event) => (event.at === 1 ? refused.promise : undefined),
      onUnstarted: (entries) => { handed.push(...entries.map((e) => e.event.at)); },
    });
    queue.enqueue(trigger, fact(1));
    queue.enqueue(trigger, fact(2));
    await flush();
    queue.stop();
    refused.resolve('not_run');
    await queue.idle();
    expect(handed).toEqual([1, 2]);
  });

  it('resume() before the running event ends queues the set-aside events behind it again', async () => {
    const running = defer();
    const processed: number[] = [];
    const handed: number[] = [];
    const queue = createTriggerDispatchQueue({
      processEvent: async (_trigger, event) => {
        processed.push(event.at);
        if (event.at === 1) await running.promise;
      },
      onUnstarted: (entries) => { handed.push(...entries.map((e) => e.event.at)); },
    });
    queue.enqueue(trigger, fact(1));
    queue.enqueue(trigger, fact(2));
    await flush();
    queue.stop();
    queue.resume();
    running.resolve();
    await queue.drained();
    expect(processed).toEqual([1, 2]);
    expect(handed).toEqual([]);
  });
});

describe('trigger dispatcher dispose() during a restart drain', () => {
  it('returns within the grace while a run never finishes; starts nothing queued; parks the mail fact, lets the rest go', async () => {
    vi.useFakeTimers();
    const hang = defer<void>();
    const runs: RunInput[] = [];
    const { db, store, bus, dispatcher } = setup(async (input) => {
      runs.push(input);
      await hang.promise;
    });
    try {
      bus.emit(fact(1));
      bus.emit(fact(2)); // same thing: queued behind the running one
      bus.emit(mail('mail:1', 1));
      bus.emit(mail('mail:1', 2)); // same record: queued behind
      await vi.advanceTimersByTimeAsync(0);
      expect(runs).toHaveLength(2);

      dispatcher.dispose();
      let stopped = false;
      const stopping = dispatcher.drained().then(() => { stopped = true; });
      await vi.advanceTimersByTimeAsync(STOP_GRACE_MS - 1);
      expect(stopped).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await stopping;
      expect(stopped).toBe(true);

      // The queued mail fact is kept; the queued ordinary event is let go, as
      // an event a stopped dispatcher never heard always was.
      expect(parked(store)).toEqual([['t-fact', 2]]);
      hang.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(runs).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it('a mail fact the draining server refused, and the ones behind it, are parked in order and replayed by the next start', async () => {
    const head = defer<void>();
    const { db, store, bus, dispatcher } = setup(async (input) => {
      if (atOf(input) === 1) await head.promise;
    }, {
      auditLog: { logActivity: vi.fn(async () => {}) } as never,
    });
    try {
      bus.emit(fact(1));
      bus.emit(fact(2));
      bus.emit(fact(3));
      await flush();
      dispatcher.dispose();
      // Came while stopped: no trigger hears it, and its fact will not announce again.
      bus.emit(fact(4));
      // The run that was in flight is refused by the draining server.
      head.reject(draining());
      await dispatcher.drained();

      expect(parked(store)).toEqual([['t-fact', 1], ['t-fact', 2], ['t-fact', 3], ['t-fact', 4]]);
      // Not run is not failed: nothing on the row, nothing counted.
      expect(store.get('t-fact')!.last_error).toBeNull();
      expect(store.get('t-fact')!.last_fired_at).toBeNull();

      // The next start, on the same database: every event is delivered, oldest first.
      const replayed: RunInput[] = [];
      const next = createEventTriggerDispatcher({
        bus: createWarehouseEventBus(),
        store,
        runtime: { runRecipe: async (input) => { replayed.push(input); } },
      });
      next.rebuild();
      await next.replayParked();
      await next.drained();
      expect(ats(replayed)).toEqual([1, 2, 3, 4]);
      expect(parked(store)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('a refused ordinary event is let go without a failure; only a mail fact is parked', async () => {
    const onAutomationFailure = vi.fn();
    const { db, store, bus, dispatcher } = setup(async () => { throw draining(); }, { onAutomationFailure });
    try {
      bus.emit(mail('mail:1'));
      bus.emit(fact(7));
      await dispatcher.drained();
      expect(parked(store)).toEqual([['t-fact', 7]]);
      expect(store.get('t-mail')!.last_error).toBeNull();
      expect(store.get('t-fact')!.last_error).toBeNull();
      expect(onAutomationFailure).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it('while the server drains, a queued event starts no run; a mail fact is parked', async () => {
    const runRecipe = vi.fn(async () => {});
    let isDraining = true;
    const { db, store, bus, dispatcher } = setup(runRecipe, { isDraining: () => isDraining });
    try {
      bus.emit(fact(5));
      bus.emit(mail('mail:5'));
      await dispatcher.drained();
      expect(runRecipe).not.toHaveBeenCalled();
      expect(parked(store)).toEqual([['t-fact', 5]]);

      // The permitting case: once not draining, the same dispatcher runs events.
      isDraining = false;
      bus.emit(mail('mail:6'));
      await dispatcher.drained();
      expect(runRecipe).toHaveBeenCalledOnce();
    } finally {
      db.close();
    }
  });

  it('does not wait for a sealed vault: the mail fact waiting on it is parked at once', async () => {
    const runRecipe = vi.fn(async () => {});
    const { db, store, bus, dispatcher } = setup(runRecipe, {
      isVaultUnlocked: () => false,
      // Far longer than the grace: a stop that waited on the poll would show.
      vaultPollMs: 60_000,
    });
    try {
      bus.emit(fact(8));
      await flush();
      const started = Date.now();
      dispatcher.dispose();
      await dispatcher.drained();
      expect(Date.now() - started).toBeLessThan(STOP_GRACE_MS);
      expect(runRecipe).not.toHaveBeenCalled();
      expect(parked(store)).toEqual([['t-fact', 8]]);
    } finally {
      db.close();
    }
  });

  it('with pre-approval, mail facts held for a sealed vault are parked after what the queue held', async () => {
    const head = defer<void>();
    let sealedVault = false;
    const runRecipe = vi.fn(async (input: RunInput) => {
      if (atOf(input) === 1) await head.promise;
    });
    const { db, store, bus, dispatcher } = setup(runRecipe, {
      isVaultUnlocked: () => !sealedVault,
      vaultPollMs: 60_000,
      getPreapprovalDriver: () => ({ captureTrigger: () => ({}) }) as never,
    });
    try {
      bus.emit(fact(1));
      bus.emit(fact(2)); // queued behind 1
      await flush();
      sealedVault = true;
      bus.emit(fact(3)); // held for the vault
      dispatcher.dispose();
      head.reject(draining());
      await dispatcher.drained();
      expect(parked(store)).toEqual([['t-fact', 1], ['t-fact', 2], ['t-fact', 3]]);
    } finally {
      db.close();
    }
  });

  it('a rebuild that ends a pause replays what the stop parked', async () => {
    const runs: RunInput[] = [];
    let isDraining = true;
    const { db, store, bus, dispatcher } = setup(async (input) => { runs.push(input); }, {
      isDraining: () => isDraining,
    });
    try {
      bus.emit(fact(9));
      await dispatcher.drained();
      dispatcher.dispose();
      await dispatcher.drained();
      expect(parked(store)).toEqual([['t-fact', 9]]);

      isDraining = false;
      dispatcher.rebuild();
      await vi.waitFor(() => expect(ats(runs)).toEqual([9]));
      expect(parked(store)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('a run the restart killed counts toward no cap and sends no notice; an ordinary kill still does', async () => {
    const run = async (drainBegins: boolean) => {
      let isDraining = false;
      const onAutomationFailure = vi.fn();
      const { db, store, bus, dispatcher } = setup(async () => {
        if (drainBegins) isDraining = true;
        throw Object.assign(new Error('The run was stopped before this step finished.'), {
          code: 'run_killed', run_id: 'run-1',
        });
      }, { onAutomationFailure, isDraining: () => isDraining });
      try {
        bus.emit(fact(11));
        await dispatcher.drained();
        return {
          notices: onAutomationFailure.mock.calls.length,
          last_error: store.get('t-fact')!.last_error,
          parked: parked(store),
        };
      } finally {
        db.close();
      }
    };

    // The run started, so it is never replayed — and it is not the trigger failing.
    expect(await run(true)).toEqual({ notices: 0, last_error: null, parked: [] });
    // Mutate only the drain: outside a restart the kill is booked as before.
    const ordinary = await run(false);
    expect(ordinary.notices).toBe(1);
    expect(ordinary.last_error).not.toBeNull();
  });

  it("a situation revision the server refused is not handled, so its checkpoint stays", async () => {
    const db = new Database(':memory:');
    try {
      const store = createEventTriggersStore(db);
      store.create({ ...FACT_TRIGGER, trigger_id: 't-sit', pattern: 'data.situation.**' });
      let refuse = true;
      const dispatcher = createEventTriggerDispatcher({
        bus: createWarehouseEventBus(),
        store,
        runtime: { runRecipe: async () => { if (refuse) throw draining(); } },
      });
      dispatcher.rebuild();
      const revision: WarehouseEvent = {
        platform: 'situation', slug: 'home', entity_type: 'state', event_kind: 'updated', record_id: 's-1', at: 2_000,
      };
      expect(await dispatcher.deliverSituation!('t-sit', revision)).toBe(false);
      // The permitting case: the same revision is handled once it can run.
      refuse = false;
      expect(await dispatcher.deliverSituation!('t-sit', revision)).toBe(true);
    } finally {
      db.close();
    }
  });
});
