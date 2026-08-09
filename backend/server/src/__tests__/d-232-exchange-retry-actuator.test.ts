/** D-232 § 24 — the sweep, as distinct from the decision.
 *
 *  The planner is pure and tested in contracts. What is NOT covered by that is
 *  everything this file does: skipping an unreachable peer, not stranding a
 *  sweep behind one bad ref, and not re-entering. Each has a failure mode the
 *  planner cannot have.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ConnectionHealth, ExchangeRetryRow } from '@recued/contracts';
import { composeExchangeRetry } from '../composition/bin/wire-exchange-retry.js';

const T = 1_000_000_000;
const classify = () => ({ kind: 'unavailable' as never, reason: 'down' });
const failedCarrier = (at: number): ExchangeRetryRow => ({
  recipe_id: 'run-ingredient', status: 'failed', at,
  errors: [{ code: 'NETWORK_ERROR' }], config: { tool: 'peer-apply' },
});

const harness = (over: Partial<Parameters<typeof composeExchangeRetry>[0]> = {}) => {
  let tick: () => Promise<void> = async () => {};
  const resend = vi.fn(async () => {});
  composeExchangeRetry({
    registry: { registerInterval: (spec) => { tick = spec.tick as typeof tick; return () => {}; } },
    pendingRefs: async () => ['ref-a'],
    rowsForRef: async () => [failedCarrier(T)],
    callbackForRef: () => 'cb',
    healthForRef: () => undefined,
    classify,
    resend,
    now: () => T + 10 * 60_000,
    log: () => {},
    ...over,
  });
  return { runTick: () => tick(), resend };
};

describe('D-232 § 24 — the retry sweep', () => {
  it('re-sends an eligible ref with the args of the attempt that FAILED', async () => {
    const h = harness();
    await h.runTick();
    expect(h.resend).toHaveBeenCalledWith('ref-a', { tool: 'peer-apply' });
  });

  it('⛔ skips a peer still known UNREACHABLE — health is a real answer now', async () => {
    /** § 22 made health live, so this can ask "is the peer back?" instead of
     *  knocking to find out. Without it the sweep re-sends into a connection it
     *  already knows is down, which is the hammering backoff exists to prevent. */
    const health: ConnectionHealth = { status: 'unreachable', last_probed_at: T };
    const h = harness({ healthForRef: () => health });
    await h.runTick();
    expect(h.resend).not.toHaveBeenCalled();
  });

  it('⛔ one ref failing must not strand the rest of the sweep', async () => {
    /** The next ref is a different peer. A dead one must not hold everyone
     *  behind it — the failure mode where one bad correspondent silently stops
     *  every other conversation on the server. */
    const resend = vi.fn(async (ref: string) => {
      if (ref === 'ref-a') throw new Error('boom');
    });
    const h = harness({ pendingRefs: async () => ['ref-a', 'ref-b'], resend });
    await h.runTick();
    expect(resend).toHaveBeenCalledTimes(2);
    expect(resend).toHaveBeenLastCalledWith('ref-b', { tool: 'peer-apply' });
  });

  it('⛔⛔ does not re-enter — a slow tick must not send the same ref twice', async () => {
    /** `runTick` does not serialize. A second pass while the first is mid-resend
     *  would send one ref twice, which is the single outcome retry must never
     *  produce. */
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const resend = vi.fn(async () => { await gate; });
    const h = harness({ resend });
    const first = h.runTick();
    // ⚠ Let the first tick actually REACH `resend` before the second fires.
    // Without this the second lands while the first is still awaiting
    // `pendingRefs()`, and the test passes for the wrong reason — 0 calls looks
    // identical to the guard working.
    await new Promise((r) => setTimeout(r, 0));
    expect(resend).toHaveBeenCalledTimes(1);
    await h.runTick();               // lands while the first is still inside resend
    expect(resend).toHaveBeenCalledTimes(1);
    release();
    await first;
  });
});
