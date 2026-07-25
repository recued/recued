/** D-148 § A.6 — per-token rate limit primitive.
 *
 *  Token-bucket per (port-role, bearer-token) tuple. The bucket
 *  refills at a constant rate; over-budget consumers get 429. Used
 *  by the WS port (100 rpc/sec per token) + the MCP port
 *  (60 rpc/min per token).
 *
 *  In-memory only. The substrate is single-process — D-148 does NOT
 *  share rate-limit state across replicas (the user's server is
 *  one node). Replay counters live in their own KV-backed surface
 *  (`webhook/idempotency-ledger.ts`); rate limiting is the cheap
 *  single-process path.
 *
 *  Time source is injectable so tests run deterministically. */

export interface RateLimitOptions {
  /** Bucket capacity (max burst). Reused as the steady-state ceiling. */
  capacity: number;
  /** Window the capacity refills across, in milliseconds. */
  refill_window_ms: number;
  /** Time source. Defaults to `Date.now`. */
  now?: () => number;
  /** Soft cap on the number of distinct keys held in memory. When a NEW
   *  key would push the Map past this, the oldest-inserted bucket is
   *  evicted FIFO. Bounds memory for limiters keyed on attacker-chosen,
   *  unbounded-cardinality keys — e.g. a PRE-AUTH per-source-IP limiter,
   *  where an IPv6-rotating flood would otherwise grow the Map without
   *  limit (the same memory-DoS class the reception rate-limiter caps).
   *  Omit for caller-bounded keys (per-token limiters key on issued
   *  tokens, already bounded). */
  max_keys?: number;
}

export type RateLimitDecision =
  | { allowed: true; remaining: number; reset_at: number }
  | { allowed: false; retry_after_ms: number; reset_at: number };

interface BucketState {
  tokens: number;
  /** Last time the bucket was refilled, in ms. */
  refilled_at: number;
}

export interface RateLimiter {
  /** Consume one token from the per-key bucket. Returns `allowed:
   *  true` with the remaining quota when the budget covers the call;
   *  otherwise `allowed: false` with the retry-after delta. */
  consume(key: string): RateLimitDecision;
  /** Drop a key's bucket — used at token revocation. No-op when the
   *  key isn't tracked. */
  reset(key: string): void;
  /** Drop every bucket. Used on full server restart-equivalent
   *  paths (housekeeping cycle reset). */
  clear(): void;
}

export const createRateLimiter = (options: RateLimitOptions): RateLimiter => {
  const { capacity, refill_window_ms } = options;
  const now = options.now ?? (() => Date.now());
  const buckets = new Map<string, BucketState>();
  // refill rate is `capacity` tokens per `refill_window_ms` ms.
  const refill_per_ms = capacity / refill_window_ms;

  const refill = (state: BucketState, t: number): void => {
    const elapsed = t - state.refilled_at;
    if (elapsed <= 0) return;
    const refilled = elapsed * refill_per_ms;
    state.tokens = Math.min(capacity, state.tokens + refilled);
    state.refilled_at = t;
  };

  const max_keys = options.max_keys;

  return {
    consume: (key) => {
      const t = now();
      let state = buckets.get(key);
      if (!state) {
        state = { tokens: capacity, refilled_at: t };
        buckets.set(key, state);
        // FIFO eviction when a new key trips the soft cap. Map preserves
        // insertion order, so the first key is always the oldest-inserted.
        // Bounds memory against unbounded-cardinality (e.g. rotating-IP)
        // keys; a legit caller's evicted bucket simply re-fills fresh on
        // its next call (a benign reset, never a bypass — capacity only
        // shrinks the budget, never grants extra).
        if (max_keys !== undefined && buckets.size > max_keys) {
          const oldest = buckets.keys().next().value;
          if (oldest !== undefined && oldest !== key) buckets.delete(oldest);
        }
      }
      refill(state, t);
      if (state.tokens >= 1) {
        state.tokens -= 1;
        const remaining = Math.floor(state.tokens);
        // Reset when the bucket would refill back to capacity.
        const tokens_needed = capacity - state.tokens;
        const reset_in_ms = tokens_needed / refill_per_ms;
        return { allowed: true, remaining, reset_at: t + reset_in_ms };
      }
      // Need 1 token; bucket has < 1. Compute how long until 1 is
      // available — that's the `Retry-After` hint surfaced as the
      // 429 header.
      const tokens_needed = 1 - state.tokens;
      const retry_after_ms = Math.ceil(tokens_needed / refill_per_ms);
      return {
        allowed: false,
        retry_after_ms,
        reset_at: t + retry_after_ms,
      };
    },
    reset: (key) => {
      buckets.delete(key);
    },
    clear: () => {
      buckets.clear();
    },
  };
};
