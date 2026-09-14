/** D-148 P6 § A.6 — webhook idempotency-ledger / replay window.
 *
 *  Each inbound webhook delivery is dedup'd on a per-vendor +
 *  per-event-id basis with a 24-hour replay window per spec
 *  § P6 acceptance line 2152. The ledger is in-memory + bounded;
 *  the existing per-vendor `engagement_inbound_event_ledger` table
 *  (D-128 / D-139) handles the durable shape, while this port-level
 *  ledger is the cheap front-line filter that rejects obvious
 *  replays before they reach the funnel.
 *
 *  Bucketing strategy: we keep entries indexed by their seen-at
 *  timestamp + a Set of `<vendor>:<event_id>` keys per bucket. A
 *  single sweep on each `record(...)` call evicts every bucket
 *  older than the window — O(buckets-since-sweep) amortized.
 *  Steady-state with 24h window + 1 bucket/min = 1440 buckets so
 *  the sweep cost is bounded.
 *
 *  Memory ceiling: the per-minute bucket COUNT is bounded by the
 *  window, but the KEY count inside the buckets is not — an
 *  authenticated sender (valid signing secret) emitting a flood of
 *  uniquely-keyed deliveries would grow the ledger unbounded across
 *  the 24h window. `WEBHOOK_LEDGER_MAX_ENTRIES` caps the total tracked
 *  keys with oldest-first (FIFO) eviction — whole stale buckets first,
 *  falling back to oldest individual keys within the current bucket so
 *  the bound holds even under a sub-minute flood — mirroring the
 *  funnel's `WEBHOOK_DEDUP_RING_MAX_ENTRIES`. Eviction under abnormal
 *  volume trades some replay-window coverage for a hard memory bound;
 *  the durable per-vendor ledger remains the load-bearing defense.
 *
 *  Time source is injectable so tests run deterministically. */

export const WEBHOOK_REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;
const BUCKET_SIZE_MS = 60 * 1000;

/** Soft cap on total tracked keys. 50k keys × ~100 B/entry ≈ 5 MB —
 *  a generous ceiling that never trips under legitimate per-server
 *  webhook volume but bounds memory under a unique-delivery flood. */
export const WEBHOOK_LEDGER_MAX_ENTRIES = 50_000;

export interface IdempotencyLedgerOptions {
  /** Window length in ms. Defaults to the spec-mandated 24h. */
  window_ms?: number;
  /** Time source. Defaults to `Date.now`. */
  now?: () => number;
  /** Max total tracked keys before FIFO bucket eviction. Defaults to
   *  `WEBHOOK_LEDGER_MAX_ENTRIES`. Tests pass small values to drive
   *  overflow deterministically. */
  max_entries?: number;
}

export interface IdempotencyLedger {
  /** Record the (vendor, event_id) tuple at the current time and
   *  report whether this is a fresh delivery. Returns `fresh: false`
   *  when the same key has been seen inside the replay window. */
  record(vendor: string, event_id: string): { fresh: boolean };
  /** Read-only replay check — does NOT record.
   *
   *  HTTP webhooks and local ingress record only after durable dispatch.
   *  The HTTP handler separately coalesces in-flight attempts, so a failed
   *  admission stays retryable without starting concurrent work. */
  seen(vendor: string, event_id: string): boolean;
  /** Snapshot count of currently-tracked keys — for diagnostics. */
  size(): number;
  /** Drop every entry. */
  clear(): void;
}

interface Bucket {
  start_ms: number;
  keys: Set<string>;
}

export const createIdempotencyLedger = (
  options: IdempotencyLedgerOptions = {},
): IdempotencyLedger => {
  const window_ms = options.window_ms ?? WEBHOOK_REPLAY_WINDOW_MS;
  const now = options.now ?? (() => Date.now());
  const max_entries = options.max_entries ?? WEBHOOK_LEDGER_MAX_ENTRIES;
  const buckets: Bucket[] = [];
  // Pointer into `buckets` for O(1) bucket lookup at the head.
  const indexByStart = new Map<number, Bucket>();
  // Running total of keys across all live buckets — kept exact (every
  // `keys.add` is a fresh key per the pre-add dup scan) so the cap
  // check below is O(1).
  let totalKeys = 0;

  const dropOldestBucket = (): void => {
    const evicted = buckets.shift();
    if (!evicted) return;
    indexByStart.delete(evicted.start_ms);
    totalKeys -= evicted.keys.size;
  };

  const sweep = (t: number): void => {
    const cutoff = t - window_ms;
    while (buckets.length > 0 && buckets[0]!.start_ms <= cutoff) {
      dropOldestBucket();
    }
  };

  const bucketStart = (t: number): number => Math.floor(t / BUCKET_SIZE_MS) * BUCKET_SIZE_MS;

  // O(buckets) scan for an existing key — bounded by 1440 in the steady
  // state. Faster paths exist (per-key map with TTL) at the cost of an
  // extra index; the spec-line cap is 24h replay, not perf-critical.
  const hasKey = (key: string): boolean => {
    for (const bucket of buckets) {
      if (bucket.keys.has(key)) return true;
    }
    return false;
  };

  return {
    record: (vendor, event_id) => {
      const t = now();
      sweep(t);
      const key = `${vendor}:${event_id}`;
      if (hasKey(key)) return { fresh: false };
      const start = bucketStart(t);
      let bucket = indexByStart.get(start);
      if (!bucket) {
        bucket = { start_ms: start, keys: new Set() };
        buckets.push(bucket);
        indexByStart.set(start, bucket);
      }
      bucket.keys.add(key);
      totalKeys += 1;
      // FIFO eviction once the soft cap trips. Prefer dropping whole
      // stale buckets (oldest first). When the overflow is concentrated
      // in the single current bucket (a sub-minute flood that never
      // rolls a second bucket), drop its oldest individual keys instead
      // — `Set` iteration is insertion-ordered, so the just-added key
      // (newest) survives while the bound still holds.
      while (totalKeys > max_entries) {
        if (buckets.length > 1) {
          dropOldestBucket();
          continue;
        }
        const only = buckets[0];
        const oldestKey = only?.keys.values().next().value;
        if (only === undefined || oldestKey === undefined) break;
        only.keys.delete(oldestKey);
        totalKeys -= 1;
      }
      return { fresh: true };
    },
    seen: (vendor, event_id) => {
      sweep(now());
      return hasKey(`${vendor}:${event_id}`);
    },
    size: () => {
      let count = 0;
      for (const bucket of buckets) count += bucket.keys.size;
      return count;
    },
    clear: () => {
      buckets.length = 0;
      indexByStart.clear();
      totalKeys = 0;
    },
  };
};
