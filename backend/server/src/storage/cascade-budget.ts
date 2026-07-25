/** D-136 §A.5 / audit §24.4 A17 — Cascade fan-out budget governor.
 *
 *  Two ceilings keep cascade primitives bounded under load:
 *
 *    1. **Per-identity rate ceiling** —
 *       `housekeeping_config.cascade_budget_per_second_per_identity`
 *       (default 100). Caps the number of enqueues attributable to a
 *       single identity-key in any 1-second window. The canonical
 *       case is a hot contact getting a flurry of mail / calendar
 *       events — without the cap, every event would fan out to
 *       every perspective topic touching that identity, multiplying
 *       work without adding signal. Last-action-wins on overflow:
 *       when a cascade primitive arrives with an identity already at
 *       the cap, the over-cap enqueues are dropped (the underlying
 *       row simply doesn't enter the queue this second; the next
 *       cascade firing at a fresh window picks it up).
 *
 *    2. **Per-topic queue-depth ceiling** —
 *       `housekeeping_config.cascade_queue_depth_max_per_topic`
 *       (default 10000). Caps the number of pending lifecycle
 *       actions a single topic may carry. Without the cap, a
 *       cascade-firing storm could push a single topic's pending
 *       count into the millions, starving the drain consumer +
 *       inflating the planner's pending-row scan. Once at cap,
 *       further enqueues for the same topic skip; observability
 *       counter on `CascadeResult.rows_queue_depth_capped` records
 *       what was dropped.
 *
 *  Both ceilings are SOFT — they reduce cascade noise + protect the
 *  drain consumer's working set, but they do NOT guarantee
 *  correctness. The cascade primitives' idempotency contract
 *  (column-state-driven, content-hash-driven) means a dropped
 *  enqueue will be re-enqueued on the next source change that walks
 *  through the same primitive. The governor's job is to avoid
 *  thrash, not to enforce data correctness.
 *
 *  Spec: `docs/d-136-spec.md` §A.5 (Fan-out budget) + audit §24.4
 *  A17 (rate ceiling rationale). */

// ────────────────────────────────────────────────────────────────
// Configurable knobs
// ────────────────────────────────────────────────────────────────

/** Read by the governor at construction. Mirrors
 *  `housekeeping_config` columns + their defaults from
 *  `housekeeping/schema.ts`. The `bin.ts` cascade wiring reads the
 *  config row + threads these through; tests + harnesses construct
 *  inline. */
export interface CascadeBudgetConfig {
  /** Per-second per-identity-key cap on enqueues. */
  cascade_budget_per_second_per_identity: number;
  /** Per-topic cap on pending lifecycle actions. */
  cascade_queue_depth_max_per_topic: number;
}

const RATE_WINDOW_MS = 1_000;

// ────────────────────────────────────────────────────────────────
// Governor surface
// ────────────────────────────────────────────────────────────────

/** Outcome of a per-identity rate-limit reservation. Cascade
 *  primitives ask the governor "I want to enqueue N rows for this
 *  identity" — the governor returns how many fit under the cap +
 *  how many were dropped. The primitive then applies the allowed
 *  count to its store call. */
export interface RateReservation {
  /** Number of rows admitted under the per-identity rate cap. */
  admitted: number;
  /** Number of rows dropped because admitting them would exceed the
   *  per-identity cap for this 1-second window. */
  dropped: number;
}

/** Outcome of a per-topic queue-depth check. Similar shape to
 *  `RateReservation` — `admitted` is what the governor permits to
 *  enqueue + `dropped` is what was over-cap.
 *
 *  Note this is an *advisory* check: the governor reads the current
 *  pending count via `currentDepth(topic)` (a callback the primitive
 *  passes in) and compares to the cap. Race against an in-flight
 *  enqueue from another worker would over-shoot by a few rows, but
 *  the cap is a soft ceiling for fan-out smoothing, not a hard
 *  barrier. */
export interface QueueDepthReservation {
  admitted: number;
  dropped: number;
}

export interface CascadeBudgetGovernor {
  /** Reserve `desired` enqueue slots for `identity_key` against the
   *  per-second rate ceiling. Returns the admitted + dropped counts.
   *  Internal: each call appends to a sliding 1-second window per
   *  identity; expired entries are reaped on each call. */
  reserveForIdentity(
    identity_key: string,
    desired: number,
    now: number,
  ): RateReservation;
  /** Check the per-topic queue-depth ceiling. `currentDepth` reads the
   *  store's `countLifecycleActionPendingByTopic` filtered to this
   *  topic; the governor returns how many of `desired` fit under the
   *  cap. */
  reserveForTopic(
    topic: string,
    desired: number,
    currentDepth: number,
  ): QueueDepthReservation;
  /** Adjust caps at runtime (Settings → Housekeeping panel write
   *  flushes here so a config change takes effect on the next cascade
   *  firing without a process restart). */
  reconfigure(config: Partial<CascadeBudgetConfig>): void;
  /** Snapshot the active config — Settings + observability surfaces
   *  read this to render the cap alongside the per-cycle counters. */
  config(): CascadeBudgetConfig;
}

interface IdentityWindow {
  /** Sorted ascending — the oldest entry's `ts` decides the trim
   *  point on each access. Uses `number[]` over a richer shape so
   *  the steady-state cost is one `push` + one `shift`. */
  ts: number[];
}

export const createCascadeBudgetGovernor = (
  initial: CascadeBudgetConfig,
): CascadeBudgetGovernor => {
  let cfg: CascadeBudgetConfig = { ...initial };
  const windows = new Map<string, IdentityWindow>();

  const trim = (window: IdentityWindow, now: number): void => {
    while (window.ts.length > 0 && now - window.ts[0]! >= RATE_WINDOW_MS) {
      window.ts.shift();
    }
  };

  return {
    reserveForIdentity(identity_key, desired, now) {
      if (desired <= 0) return { admitted: 0, dropped: 0 };
      const cap = cfg.cascade_budget_per_second_per_identity;
      // Cap of 0 effectively disables enqueue for this identity —
      // surface as dropped so observability shows the configured
      // shutoff. Negative caps treated identically.
      if (cap <= 0) return { admitted: 0, dropped: desired };
      let window = windows.get(identity_key);
      if (!window) {
        window = { ts: [] };
        windows.set(identity_key, window);
      }
      trim(window, now);
      const remaining = Math.max(0, cap - window.ts.length);
      const admitted = Math.min(desired, remaining);
      for (let i = 0; i < admitted; i++) window.ts.push(now);
      return { admitted, dropped: desired - admitted };
    },
    reserveForTopic(_topic, desired, currentDepth) {
      if (desired <= 0) return { admitted: 0, dropped: 0 };
      const cap = cfg.cascade_queue_depth_max_per_topic;
      if (cap <= 0) return { admitted: 0, dropped: desired };
      const headroom = Math.max(0, cap - currentDepth);
      const admitted = Math.min(desired, headroom);
      return { admitted, dropped: desired - admitted };
    },
    reconfigure(patch) {
      cfg = { ...cfg, ...patch };
    },
    config() {
      return { ...cfg };
    },
  };
};

// ────────────────────────────────────────────────────────────────
// No-op governor (testing + harness paths without budget wiring)
// ────────────────────────────────────────────────────────────────

/** Pass-through governor — admits everything, never drops. The
 *  cascade engine accepts an optional governor; absence collapses to
 *  this shape. Lets pre-D-136-P5b harness paths + tests work without
 *  threading a budget config through. */
export const NO_OP_CASCADE_BUDGET_GOVERNOR: CascadeBudgetGovernor = {
  reserveForIdentity: (_identity, desired) => ({ admitted: desired, dropped: 0 }),
  reserveForTopic: (_topic, desired) => ({ admitted: desired, dropped: 0 }),
  reconfigure: () => {
    /* no-op */
  },
  config: () => ({
    cascade_budget_per_second_per_identity: Number.POSITIVE_INFINITY,
    cascade_queue_depth_max_per_topic: Number.POSITIVE_INFINITY,
  }),
};
