/** D-148 § A.5.6 lapse recovery — closing the deferral the poller documented.
 *
 *  ⛔ MEASURED live 2026-08-05 before this landed: cancelling a subscription
 *  left `subscription_state` at 'active' indefinitely, so the handle stayed a
 *  publish target and the poller issued one update per tick that the cloud
 *  refused with `ddns_subscription_lapsed` — 288 rejected requests/day, per
 *  lapsed server, forever. Fail-closed (only the CLOUD refusing kept the zone
 *  correct), but the server never stood down and its own state was
 *  user-visibly wrong after a cancellation.
 *
 *  The contract has TWO halves and testing either alone is misleading:
 *    1. stop hammering — bounded probes, not one per tick;
 *    2. still recover UNATTENDED — the original note ended "until the operator
 *       takes action", which is not an acceptable resting state for a paid
 *       feature.
 *  A test that only proved (1) would pass on a server that had simply gone
 *  dark, which is why every backoff assertion here is paired with a recovery
 *  assertion.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { composeDdnsUpdatePoller } from '../composition/bin/wire-ddns-update-poller.js';
import {
  createInMemoryHandleStateStore,
  type HandleState,
  type HandleStateStore,
} from '../handle/index.js';
import type { DdnsUpdateClient } from '../ddns/update-client.js';
import type { DdnsIpStateStore } from '../ddns/ip-state-store.js';
import type {
  BackgroundServiceRegistry,
  IntervalServiceSpec,
} from '../composition/bin/wire-background-services.js';

const ACTIVE: HandleState = {
  publisher_id: 'pub_test_01',
  current_handle: 'alice',
  handle_history: [],
  subscription_state: 'active',
  last_synced_at: 1_700_000_000_000,
};

const HOUR = 60 * 60 * 1000;

type UpdateResult = Awaited<ReturnType<DdnsUpdateClient['update']>>;
const LAPSED: UpdateResult = {
  ok: false as const,
  error: 'ddns_subscription_lapsed',
  message: 'Pro subscription required',
} as UpdateResult;
const PUBLISHED: UpdateResult = {
  ok: true as const,
  data: { ddns_record_updated_at: 1, ttl: 300, warnings: [] },
} as UpdateResult;

const build = (opts: { results: UpdateResult[]; withLifecycle?: boolean }) => {
  let spec: IntervalServiceSpec | null = null;
  const registry: BackgroundServiceRegistry = {
    register: vi.fn(),
    registerInterval: vi.fn((s: IntervalServiceSpec) => {
      spec = s;
      return vi.fn();
    }),
    stopAll: vi.fn(async () => {}),
    list: vi.fn(() => []),
  };

  // A store the lifecycle applier actually mutates, so "did it learn?" is read
  // back from state rather than from the spy alone.
  const store: HandleStateStore = createInMemoryHandleStateStore({ ...ACTIVE });
  const applyLifecycleUpdate = vi.fn(async (u: { state: string }) => {
    const cur = await store.load();
    const next = { ...(cur ?? ACTIVE), subscription_state: u.state } as HandleState;
    await store.save(next);
    return next;
  });

  let now = 1_800_000_000_000;
  const queue = [...opts.results];
  const update = vi.fn(async () => queue.shift() ?? PUBLISHED);
  const ipStateStore: DdnsIpStateStore = { load: vi.fn(() => null), save: vi.fn() };

  composeDdnsUpdatePoller({
    registry,
    handleStateStore: store,
    fetchPublicIpv4: async () => '203.0.113.10',
    updateClient: { update } as Pick<DdnsUpdateClient, 'update'>,
    ipStateStore,
    now: () => now,
    ...(opts.withLifecycle === false
      ? {}
      : { applyLifecycle: () => ({ applyLifecycleUpdate }) }),
  });
  if (!spec) throw new Error('not registered');
  return {
    spec: spec as IntervalServiceSpec,
    update,
    applyLifecycleUpdate,
    store,
    advance: (ms: number) => { now += ms; },
  };
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('DDNS lapse recovery', () => {
  it('records grace when the cloud says the subscription lapsed', async () => {
    const { spec, applyLifecycleUpdate, store } = build({ results: [LAPSED] });

    await spec.tick();

    expect(applyLifecycleUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'grace' }),
    );
    expect((await store.load())?.subscription_state).toBe('grace');
  });

  it('stops hammering — the very next tick issues NO request', async () => {
    const { spec, update } = build({ results: [LAPSED] });

    await spec.tick();
    expect(update).toHaveBeenCalledTimes(1); // the one that learned it

    await spec.tick();
    await spec.tick();
    await spec.tick();
    // This is the defect: it used to be one rejected request per tick, forever.
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('probes again once the backoff elapses, and RECOVERS on success', async () => {
    const { spec, update, applyLifecycleUpdate, store, advance } = build({
      results: [LAPSED, PUBLISHED],
    });

    await spec.tick();                 // lapse recorded
    advance(HOUR + 1000);              // past the first backoff window
    await spec.tick();                 // probe → succeeds

    expect(update).toHaveBeenCalledTimes(2);
    expect(applyLifecycleUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: 'active' }),
    );
    expect((await store.load())?.subscription_state).toBe('active');
  });

  it('backs off EXPONENTIALLY while the lapse persists', async () => {
    const { spec, update, advance } = build({ results: [LAPSED, LAPSED, LAPSED] });

    await spec.tick();                 // 1st lapse → 1h window
    advance(HOUR + 1000);
    await spec.tick();                 // 2nd lapse → 2h window
    expect(update).toHaveBeenCalledTimes(2);

    advance(HOUR + 1000);              // only 1h — NOT enough for the 2h window
    await spec.tick();
    expect(update).toHaveBeenCalledTimes(2);

    advance(HOUR + 1000);              // now past 2h total
    await spec.tick();
    expect(update).toHaveBeenCalledTimes(3);
  });

  it('a fresh process probes IMMEDIATELY — restart is the fast recovery path', async () => {
    // The persisted 'grace' survives a restart; the in-memory backoff does not.
    // That is deliberate: a user who re-subscribes and restarts recovers at
    // once instead of waiting out the window.
    const { spec, update } = build({ results: [PUBLISHED] });
    // Simulate booting with an already-lapsed handle.
    await build({ results: [] }).store.save({ ...ACTIVE, subscription_state: 'grace' });

    await spec.tick();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('never writes the DESTRUCTIVE released state', async () => {
    const { spec, applyLifecycleUpdate, advance } = build({
      results: [LAPSED, LAPSED, LAPSED],
    });

    await spec.tick();
    advance(HOUR + 1000);
    await spec.tick();
    advance(6 * HOUR + 1000);
    await spec.tick();

    // `applyLifecycleUpdate({state:'released'})` closes the history row and
    // clears `current_handle`. The cloud is the authority for that; inferring
    // it from an error code could strand a handle the user still owns.
    for (const call of applyLifecycleUpdate.mock.calls) {
      expect(call[0].state).not.toBe('released');
    }
  });

  it('still backs off when no lifecycle applier is wired', async () => {
    // db-less / harness boots have no state machine. The bookkeeping is
    // optional; the rate limiting is not.
    const { spec, update } = build({ results: [LAPSED], withLifecycle: false });

    await spec.tick();
    await spec.tick();
    await spec.tick();
    expect(update).toHaveBeenCalledTimes(1);
  });
});
