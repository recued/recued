/** First-publish warm-up: an empty target list at boot means NOT-STARTED-YET,
 *  not NOTHING-TO-DO.
 *
 *  ⛔ MEASURED on a fresh Pro server left untouched after boot (2026-08-05):
 *  the reserve landed ~26s in and the first publish at +315s — one entire
 *  `DDNS_UPDATE_INTERVAL_MS` later. The poller and the sibling provisioning
 *  timer both `fireImmediate` milliseconds apart in the same boot path, so the
 *  poller's one immediate fire is spent while the provisioner's reserve is
 *  still an in-flight HTTP call. Nothing re-triggered it when the handle landed
 *  a second later. Self-healing, but a new Pro user's hostname did not resolve
 *  for five minutes after setup.
 *
 *  The warm-up must not cost anything on a server that will never have a
 *  handle, which is why the tick returns before `fetchPublicIpv4` — the assertions
 *  below pin that, since a warm-up that hit the network every 2s would be a
 *  worse bug than the one it fixes.
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

// Matches the canonical fixture in `ddns-update-poller.test.ts` — the field is
// `handle_history`, and `last_synced_at` is required; an incomplete shape makes
// the tick throw rather than skip, which reads exactly like a warm-up failure.
const HANDLE_STATE: HandleState = {
  publisher_id: 'pub_test_01',
  current_handle: 'alice',
  handle_history: [],
  subscription_state: 'active',
  last_synced_at: 1_700_000_000_000,
};

const build = (opts: { handleStateStore: HandleStateStore; statefulIpStore?: boolean }) => {
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
  const fetchPublicIpv4 = vi.fn<() => Promise<string | null>>(async () => '203.0.113.10');
  const update = vi.fn<DdnsUpdateClient['update']>(async () => ({
    ok: true as const,
    data: { ddns_record_updated_at: 1, ttl: 300, warnings: [] },
  }));
  // A real store round-trips what the poller saves, so a second tick takes the
  // dedup path. The default null-loading stub can never exercise it.
  let saved: ReturnType<DdnsIpStateStore['load']> = null;
  const ipStateStore: DdnsIpStateStore = opts.statefulIpStore === true
    ? { load: () => saved, save: (s) => { saved = s; } }
    : { load: vi.fn(() => null), save: vi.fn() };

  composeDdnsUpdatePoller({
    registry,
    handleStateStore: opts.handleStateStore,
    fetchPublicIpv4,
    updateClient: { update },
    ipStateStore,
  });
  if (!spec) throw new Error('not registered');
  return { spec: spec as IntervalServiceSpec, fetchPublicIpv4, update };
};

/** A handle store that is EMPTY until `land()` — the sibling provisioner's
 *  reserve completing mid-boot, which is the real-world sequence. */
const lateHandleStore = (): HandleStateStore & { land: () => void } => {
  let state: HandleState | null = null;
  // No whole-object `as` cast: it silenced the fact that `save` returned the
  // state while `HandleStateStore.save` is `Promise<void>`. The literal now
  // conforms structurally, so a future signature change reddens here instead
  // of being absorbed by the cast.
  return {
    load: async () => state,
    save: async (s: HandleState) => {
      state = s;
    },
    land: () => {
      state = HANDLE_STATE;
    },
  };
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('DDNS first-publish warm-up', () => {
  it('publishes SECONDS after the handle lands, not a cadence later', async () => {
    const store = lateHandleStore();
    const { spec, update } = build({ handleStateStore: store });

    // The immediate fire, while the reserve is still in flight.
    await spec.tick();
    expect(update).not.toHaveBeenCalled();

    // The reserve lands a moment later — nothing tells the poller.
    store.land();

    // Warm-up re-tick, NOT the 5-minute cadence.
    await vi.advanceTimersByTimeAsync(2_500);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('costs NO network while warming — the expensive call stays behind the gate', async () => {
    const store = lateHandleStore();
    const { spec, fetchPublicIpv4 } = build({ handleStateStore: store });

    await spec.tick();
    await vi.advanceTimersByTimeAsync(20_000); // several warm-up rounds

    // A warm-up that resolved the public IP every 2s would be worse than the
    // lag it fixes.
    expect(fetchPublicIpv4).not.toHaveBeenCalled();
  });

  it('gives up warming after the window, so a handle-less server settles', async () => {
    const store = lateHandleStore(); // never lands
    const { spec, update } = build({ handleStateStore: store });

    await spec.tick();
    await vi.advanceTimersByTimeAsync(120_000); // past the 90s window

    store.land();
    await vi.advanceTimersByTimeAsync(10_000);
    // No warm-up left; the normal cadence owns it now.
    expect(update).not.toHaveBeenCalled();
  });

  it('stops warming once targets appear — no stray timers afterwards', async () => {
    const store = lateHandleStore();
    const { spec, update } = build({ handleStateStore: store });

    await spec.tick();
    store.land();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(update).toHaveBeenCalledTimes(1);

    // Warm-up must be done; further idle time triggers no extra publishes.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('onStop cancels a pending warm-up — it must not fire into closed stores', async () => {
    const store = lateHandleStore();
    const { spec, update } = build({ handleStateStore: store });

    await spec.tick();       // schedules a warm-up
    spec.onStop?.();         // shutdown before it fires
    store.land();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(update).not.toHaveBeenCalled();
  });

  it('a server that already has its handle at boot is unaffected', async () => {
    const { spec, update } = build({
      handleStateStore: createInMemoryHandleStateStore(HANDLE_STATE),
    });

    await spec.tick();
    expect(update).toHaveBeenCalledTimes(1); // immediate, no warm-up needed
  });
});

/** A SUCCESSFUL publish was the one outcome that logged nothing, which made a
 *  working server and a silently-gated one look identical from outside: the
 *  dedup `continue`, the `ddnsEnabled` pause, an empty target list and a healthy
 *  no-op all produced an empty log. The live drive
 *  (`dev/pro-ddns-server-live-drive.ts` stage 5) now asserts the D-176 pause
 *  gate through this line, because the zone cannot answer the question — it is
 *  shared with the cloud, which dedups a repeat publish into a no-op. So the
 *  string is a CONTRACT, not decoration; these pin both halves of it. */
describe('publish observability', () => {
  it('logs a line on a successful publish', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const { spec } = build({ handleStateStore: createInMemoryHandleStateStore(HANDLE_STATE) });
      await spec.tick();
      const lines = info.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes('[ddns-update-poll] published'))).toBe(true);
      expect(lines.some((l) => l.includes('alice'))).toBe(true);
    } finally {
      info.mockRestore();
    }
  });

  it('stays SILENT once deduped — steady state is zero lines, not one per tick', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const { spec, update } = build({
        handleStateStore: createInMemoryHandleStateStore(HANDLE_STATE),
        statefulIpStore: true,
      });

      await spec.tick();
      const afterFirst = info.mock.calls.length;
      expect(afterFirst).toBeGreaterThan(0);

      // Same IP, nothing changed: the poller must take the dedup `continue`
      // BEFORE the log, or an idle Pro server writes a line every 5 minutes
      // forever — a worse problem than the silence this replaced.
      await spec.tick();
      expect(update).toHaveBeenCalledTimes(1);
      expect(info.mock.calls.length).toBe(afterFirst);
    } finally {
      info.mockRestore();
    }
  });
});
