/** Watch poll manager — what a restart's `pause_scheduler` step needs from
 *  `stop()`.
 *
 *  The stop used to wait for every vendor poll in flight, whose result it then
 *  threw away — so a slow vendor could run the 5 s drain step out. These pin
 *  that `stop()` resolves while a poll never finishes, and that the poll's
 *  late result or late failure changes nothing: no snapshot commit, no event,
 *  no error toward the cap. The snapshot is the source of truth, so the next
 *  poll after the restart re-detects whatever this one would have. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EventTrigger } from '@recued/contracts';
import type { WarehouseEvent, WarehouseEventBus } from '@recued/warehouse-events';

import { createWatchPollManager, type WatchPollSource } from '../watch/poll-manager.js';
import { createWatchStore, type WatchStore } from '../watch/snapshot-store.js';
import type { CanonicalPollOutcome } from '../watch/canonical-poll.js';

const KEY = 'test-vendor/deal/main';

const trigger: EventTrigger = {
  trigger_id: 't-1',
  recipe_id: 'r-1',
  publisher_id: 'local',
  pattern: 'data.connection.api.test-vendor.deal.**',
  enabled: true,
  created_at: 1_000,
  last_fired_at: null,
  last_error: null,
  origin: 'user',
};

const flush = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

describe('watch stop() during a restart drain', () => {
  let db: Database.Database;
  let store: WatchStore;
  let emitted: WarehouseEvent[];
  let timers: Array<() => void>;
  let poll: { resolve: (outcome: CanonicalPollOutcome) => void; reject: (error: unknown) => void } | undefined;

  beforeEach(() => {
    db = new Database(':memory:');
    store = createWatchStore(db);
    emitted = [];
    timers = [];
    poll = undefined;
  });

  afterEach(() => {
    db.close();
  });

  const source: WatchPollSource = {
    source_id: 'test',
    deriveDemands: () => [{
      watch_key: KEY,
      vendor: 'test-vendor',
      entity: 'deal',
      connection_name: 'main',
      recipe_ids: ['r-1'],
      interval_ms: 60_000,
      deferred_to: null,
      event_scope: { platform: 'test', slug: 'main', entity_type: 'deal' },
    }],
    // A vendor poll that answers only when the test says so.
    poll: () => new Promise<CanonicalPollOutcome>((resolve, reject) => { poll = { resolve, reject }; }),
  };

  const manager = () => createWatchPollManager({
    store,
    triggersStore: { listEnabled: () => [trigger] },
    sources: [source],
    bus: { emit: (event) => { emitted.push(event); }, subscribe: () => () => {}, dispose: () => {} } as WarehouseEventBus,
    setTimer: (handler) => { timers.push(handler); return timers.length; },
    clearTimer: () => {},
    initialPollDelayMs: 0,
  });

  /** Arm, baseline once (the first poll persists without firing), then start
   *  a second poll and leave it in flight. */
  const pollInFlight = async () => {
    const handle = manager();
    handle.recompute();
    timers.shift()!();
    await flush();
    poll!.resolve({ ok: true, records: new Map([['d1', { id: 'd1', stage: 'a' }]]), truncated: false, complete: true, skipped_no_id: 0 });
    await flush();
    expect(store.getState(KEY)?.baselined).toBe(true);
    timers.shift()!();
    await flush();
    expect(handle.inFlight()).toBe(true);
    return handle;
  };

  it('resolves while a poll never finishes, and the late result commits and emits nothing', async () => {
    const handle = await pollInFlight();
    const before = store.getState(KEY)!;

    let stopped = false;
    void handle.stop().then(() => { stopped = true; });
    await flush();
    expect(stopped).toBe(true);

    // The vendor answers after the stop, with a change that would have fired.
    poll!.resolve({ ok: true, records: new Map([['d1', { id: 'd1', stage: 'b' }]]), truncated: false, complete: true, skipped_no_id: 0 });
    await flush();
    expect(emitted).toEqual([]);
    expect(store.loadSnapshot(KEY).get('d1')!.record).toEqual({ id: 'd1', stage: 'a' });
    expect(store.getState(KEY)!.last_poll_at).toBe(before.last_poll_at);
    expect(timers).toHaveLength(0);
  });

  it('a poll that fails after the stop counts toward no error cap', async () => {
    const handle = await pollInFlight();
    await handle.stop();
    poll!.reject(new Error('socket hang up'));
    await flush();
    expect(store.getState(KEY)!.consecutive_failures).toBe(0);
    expect(store.getState(KEY)!.last_error).toBeNull();
  });
});
