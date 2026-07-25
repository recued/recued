/** D-184 — the shared per-`(connection, vendor)` rate gate for EVERY vendor
 *  reconciler (record AND engagement). It unifies, in one place, the two cost
 *  controls that previously lived ONLY on the now-retired engagement runonce
 *  handler — so that with engagement reconcilers riding the housekeeping
 *  harness like the record reconcilers, the controls cover *all reconcilers
 *  added together*, not just the engagement half.
 *
 *  Two purposes:
 *
 *   1. **Daily call budget** — the per-`(connection, vendor)` daily API-call
 *      counter (`EngagementRateControlStore`, keyed `(connection_id, vendor)`,
 *      shared across every entity). When the budget is `suspended` the gate
 *      DENIES the pull (the caller yields without fetching); a successful pull
 *      records its `api_calls` + per-entity `pages` so the running total —
 *      summed across deal / contact / company / email / meeting / note / call /
 *      task — respects the vendor's daily quota.
 *
 *   2. **Concurrency skip-if-busy** — a per-`(connection, vendor)` in-flight
 *      flag. If a reconciler pull is already running for that key, `acquire`
 *      returns `'busy'` and the caller YIELDS (it does not queue/wait). This is
 *      deliberately a skip, not a mutex: the housekeeping scheduler is already
 *      serial within a cycle (`scheduler.ts` `for..of await` + the `inFlight`
 *      guard), so the only real overlap is CROSS-PATH — a manual "Run Now"
 *      (`runOnce` does NOT check the scheduler `inFlight`) firing while an idle
 *      cycle is mid-pull on the same connection, or an association-rescan. In
 *      every such case the in-flight pull is ALREADY fetching that connection's
 *      delta, so the redundant second pull buys nothing: skipping it (rather
 *      than queueing) avoids a duplicate burst against the vendor's short-window
 *      rate limit, and loses nothing — every path advances the SAME time cursor,
 *      so whoever pulls next reads everything updated since it. (Webhooks are
 *      not a factor: the webhook funnel ingests the parsed payload and makes no
 *      outbound vendor API call.)
 *
 *  Synchronous — the budget read is a sync store call and the concurrency check
 *  is an in-memory `Set` lookup, so there is no async mutex / promise queue.
 *  Single-process (the server is the sole orchestrator); the in-flight set is
 *  bounded by the number of enrolled connections.
 *
 *  NB: the backing store is still named `EngagementRateControlStore` for
 *  historical reasons (it predates this generalization); its budget has always
 *  been keyed `(connection_id, vendor)`, so it already models the shared total.
 *  A rename to drop the `Engagement` prefix is a mechanical follow-up. */

import type { EngagementVendor } from '@recued/contracts';

import type { EngagementRateControlStore } from '../../storage/engagement-rate-control-store.js';

/** A held gate lease — the caller pulls, reports what it consumed, then clears
 *  the in-flight flag. */
export interface RateGateLease {
  /** Record the API calls + per-entity pages a successful pull consumed. Bumps
   *  the shared `(connection, vendor)` daily call counter by `api_calls` and the
   *  per-`(connection, vendor, entity)` pages counter by `pages`. No-op for a
   *  zero count. */
  record(input: { api_calls: number; entity: string; pages: number; now: number }): void;
  /** Clear the in-flight flag for this `(connection, vendor)` so the next pull
   *  may proceed. Idempotent. */
  release(): void;
}

/** The verdict of `acquire`:
 *   - a `RateGateLease` — clear to pull; the in-flight flag is HELD. Pull, call
 *     `lease.record(...)`, then `lease.release()` (use try/finally).
 *   - `'busy'` — another pull is already in flight for this `(connection,
 *     vendor)`; the caller YIELDS without pulling (the in-flight pull covers it).
 *   - `'suspended'` — the daily budget is exhausted; the caller YIELDS without
 *     pulling. */
export type RateGateVerdict = RateGateLease | 'busy' | 'suspended';

export interface VendorRateGate {
  /** Try to claim the `(connection, vendor)` pull slot + check the daily budget.
   *  See `RateGateVerdict`. Synchronous. */
  acquire(input: {
    connection_id: string;
    vendor: EngagementVendor;
    now: number;
  }): RateGateVerdict;
}

/** Build the shared gate over a rate-control store. */
export const createVendorRateGate = (
  rateControl: EngagementRateControlStore,
): VendorRateGate => {
  // Per-`(connection, vendor)` in-flight keys. Membership = "a pull is running".
  const inFlight = new Set<string>();
  const keyOf = (connection_id: string, vendor: EngagementVendor): string =>
    `${vendor}::${connection_id}`;

  return {
    acquire({ connection_id, vendor, now }) {
      const key = keyOf(connection_id, vendor);
      // Concurrency: a pull is already running for this connection — skip.
      if (inFlight.has(key)) return 'busy';
      // Daily budget: deny when the shared per-(connection, vendor) quota is spent.
      const usage = rateControl.readUsage({ connection_id, vendor, now });
      if (usage.rate_control_state === 'suspended') return 'suspended';

      inFlight.add(key);
      let released = false;
      return {
        record({ api_calls, entity, pages, now: at }) {
          if (api_calls > 0) {
            rateControl.recordUsage({ connection_id, vendor, n: api_calls, now: at });
          }
          if (pages > 0) {
            rateControl.recordPages({ connection_id, vendor, entity, n: pages, now: at });
          }
        },
        release() {
          if (released) return;
          released = true;
          inFlight.delete(key);
        },
      };
    },
  };
};
