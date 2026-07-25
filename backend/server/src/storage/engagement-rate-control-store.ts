/** D-139 Phase 1a.2 — per-connection HubSpot rate-control substrate.
 *
 *  Tracks the per-`connection_id` daily token budget on the 15-min
 *  HubSpot fallback path per § A.6.2. Two HubSpot portals enforce
 *  budgets independently (the `connection_id` is the keying primary).
 *  Salesforce CometD makes most of this moot for SF-side engagements;
 *  Salesforce reconciler-only fallback inherits the same machinery on
 *  Salesforce's daily API limit.
 *
 *  Cadence escalation per spec § A.6.2:
 *    - > 80% used → push cadence to 30m
 *    - > 95% → 1h
 *    - 100% → reconciler suspended until next day
 *
 *  Budget recomputes daily — `recordUsage` checks if the stored
 *  `bucket_started_at` is older than 24h and resets the counter +
 *  bucket-start before recording the new call.
 *
 *  429 backoff: exponential with `base = 30s` doubling per consecutive
 *  429 up to `max = 30m`. Counter resets on first successful response.
 *  Per-`(connection_id, vendor, entity)` tuple — one entity hitting
 *  429 doesn't pause its siblings.
 *
 *  Cursor checkpoints: per `(connection_id, vendor, entity)`. Already
 *  served by `housekeeping_state` for the per-task case; this store
 *  carries the per-tuple `last_429_at` + `consecutive_429s` for
 *  backoff-state recovery + the connection-scoped budget metadata.
 *
 *  Server-internal table; no cross-cloud sync (D-097 / D-168).
 *
 *  Spec: `docs/d-139-spec.md` § A.6.2. */

import type Database from 'better-sqlite3';

import { engagementDailyBudget, type EngagementVendor } from '@recued/contracts';

export const ENGAGEMENT_BUDGET_TABLE = 'engagement_budget';
export const ENGAGEMENT_RATE_CONTROL_TABLE = 'engagement_rate_control';
/** D-139 P2 Codex review fold #3 — per-(connection, vendor, entity)
 *  daily pages-fetched counter. Drives `pages_fetched_today` on the
 *  health-surface rpc. The pages counter shares the same daily-bucket
 *  reset machinery as `engagement_budget.calls_today` (24h window
 *  rolling at the source-of-call's `bucket_started_at`); per-entity
 *  granularity matches the health-surface row keying. */
export const ENGAGEMENT_PAGE_TABLE = 'engagement_page_counter';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

/** Daily window — bucket resets after this elapses since
 *  `bucket_started_at`. Independent of the HubSpot portal's quota
 *  reset time at v1; spec § A.6.2 notes "Budget recomputes daily at
 *  the org's HubSpot quota reset time" as a future refinement (P1c
 *  + P2 widen the bucket-rollover policy to accept a per-vendor
 *  reset-time hook). */
export const DAILY_BUCKET_MS = 24 * 60 * 60 * 1000;

/** Default per-day call budget when the connection record doesn't
 *  carry a vendor-stamped quota (HubSpot Standard tier ships
 *  250,000/day; Pro/Enterprise lower-tier portals vary). The substrate
 *  default is Standard's 250k; per-portal overrides land via
 *  Settings → Connections → HubSpot at P2. */
export const HUBSPOT_DAILY_BUDGET_DEFAULT = 250_000;

/** Salesforce reconciler-only daily budget default — Salesforce's
 *  per-edition baseline starts at 5,000 + per-licensed-user delta;
 *  the substrate's conservative default at v1 is 50,000 (typical
 *  small-team seat baseline). Per-org override at P2. */
export const SALESFORCE_DAILY_BUDGET_DEFAULT = 50_000;

/** Auto-degrade thresholds — percent of daily budget consumed. */
export const RATE_CONTROL_THRESHOLDS = {
  degraded_30m: 0.8,
  degraded_1h: 0.95,
  suspended: 1.0,
} as const;

/** 429 backoff schedule per `(connection_id, vendor, entity)` tuple. */
export const RATE_CONTROL_429_BACKOFF = {
  base_ms: 30 * 1000,
  max_ms: 30 * 60 * 1000,
} as const;

// ────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────

export type RateControlState =
  | 'normal'
  | 'degraded_30m'
  | 'degraded_1h'
  | 'suspended';

export interface BudgetUsage {
  connection_id: string;
  vendor: EngagementVendor;
  daily_budget: number;
  calls_today: number;
  bucket_started_at: number;
  /** Calls / daily_budget. Capped at 1.0 for the surface. */
  budget_utilization_pct: number;
  /** Substrate cadence given current usage. */
  rate_control_state: RateControlState;
}

export interface BackoffState {
  connection_id: string;
  vendor: EngagementVendor;
  entity: string;
  consecutive_429s: number;
  last_429_at: number | null;
  /** Computed wall-clock time at which the next call is allowed. `0`
   *  when no backoff is in effect. */
  next_attempt_at: number;
}

/** D-139 P2 Codex review fold #3 — per-(connection, vendor, entity)
 *  daily pages-fetched bucket. Same 24h rolling-window reset as the
 *  budget bucket. Surfaces in the health-surface rpc as
 *  `pages_fetched_today`. */
export interface PagesUsage {
  connection_id: string;
  vendor: EngagementVendor;
  entity: string;
  pages_today: number;
  bucket_started_at: number;
}

export class RateControlInvalidError extends Error {
  readonly code = 'RATE_CONTROL_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'RateControlInvalidError';
  }
}

// ────────────────────────────────────────────────────────────────
// Schema
// ────────────────────────────────────────────────────────────────

export const ensureEngagementRateControlSchema = (
  db: Database.Database,
): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${ENGAGEMENT_BUDGET_TABLE} (
      connection_id     TEXT NOT NULL,
      vendor            TEXT NOT NULL,
      daily_budget      INTEGER NOT NULL,
      calls_today       INTEGER NOT NULL DEFAULT 0,
      bucket_started_at INTEGER NOT NULL,
      PRIMARY KEY (connection_id, vendor)
    );

    CREATE TABLE IF NOT EXISTS ${ENGAGEMENT_RATE_CONTROL_TABLE} (
      connection_id    TEXT NOT NULL,
      vendor           TEXT NOT NULL,
      entity           TEXT NOT NULL,
      consecutive_429s INTEGER NOT NULL DEFAULT 0,
      last_429_at      INTEGER,
      PRIMARY KEY (connection_id, vendor, entity)
    );

    CREATE TABLE IF NOT EXISTS ${ENGAGEMENT_PAGE_TABLE} (
      connection_id     TEXT NOT NULL,
      vendor            TEXT NOT NULL,
      entity            TEXT NOT NULL,
      pages_today       INTEGER NOT NULL DEFAULT 0,
      bucket_started_at INTEGER NOT NULL,
      PRIMARY KEY (connection_id, vendor, entity)
    );
  `);
};

// ────────────────────────────────────────────────────────────────
// Pure derivation helpers (exported for unit testing)
// ────────────────────────────────────────────────────────────────

/** Map a usage percentage to the spec's cadence-tier state. */
export const deriveRateControlState = (
  utilization_pct: number,
): RateControlState => {
  if (utilization_pct >= RATE_CONTROL_THRESHOLDS.suspended) return 'suspended';
  if (utilization_pct >= RATE_CONTROL_THRESHOLDS.degraded_1h)
    return 'degraded_1h';
  if (utilization_pct >= RATE_CONTROL_THRESHOLDS.degraded_30m)
    return 'degraded_30m';
  return 'normal';
};

/** § A.6.2 — exponential backoff on 429: `base = 30s, max = 30m,
 *  doubling per consecutive 429`. Returns the next-allowed timestamp
 *  given the current consecutive count + last_429_at. */
export const computeNextAttemptAt = (
  consecutive_429s: number,
  last_429_at: number | null,
): number => {
  if (consecutive_429s <= 0 || last_429_at === null) return 0;
  const exp = Math.min(
    RATE_CONTROL_429_BACKOFF.base_ms * 2 ** (consecutive_429s - 1),
    RATE_CONTROL_429_BACKOFF.max_ms,
  );
  return last_429_at + exp;
};

// ────────────────────────────────────────────────────────────────
// Store
// ────────────────────────────────────────────────────────────────

export interface EngagementRateControlStore {
  /** Bump the per-connection daily call counter by `n` (default 1).
   *  Resets the bucket if `now - bucket_started_at >= DAILY_BUCKET_MS`. */
  recordUsage(input: {
    connection_id: string;
    vendor: EngagementVendor;
    n?: number;
    now: number;
  }): BudgetUsage;
  /** Read current usage. When no row exists, seeds a fresh row at
   *  `daily_budget = vendor default` and returns `'normal'`. */
  readUsage(input: {
    connection_id: string;
    vendor: EngagementVendor;
    now: number;
    /** Override the seeded budget at first read. Subsequent calls
     *  read whatever's persisted; setBudget changes it. */
    daily_budget?: number;
  }): BudgetUsage;
  /** Override the persisted daily budget — used by Settings →
   *  Connections to set per-portal overrides. */
  setBudget(input: {
    connection_id: string;
    vendor: EngagementVendor;
    daily_budget: number;
    now: number;
  }): void;
  /** Reset the bucket — used when the org's quota window flips,
   *  before the substrate's 24h timer would. */
  resetBucket(input: {
    connection_id: string;
    vendor: EngagementVendor;
    now: number;
  }): void;
  /** Record a 429 hit on the (connection, vendor, entity) tuple +
   *  return the new backoff state. */
  recordTooManyRequests(input: {
    connection_id: string;
    vendor: EngagementVendor;
    entity: string;
    now: number;
  }): BackoffState;
  /** Record a successful response — clears the consecutive_429s
   *  counter for the tuple. */
  recordSuccess(input: {
    connection_id: string;
    vendor: EngagementVendor;
    entity: string;
  }): void;
  /** Read the current backoff state. */
  readBackoff(input: {
    connection_id: string;
    vendor: EngagementVendor;
    entity: string;
  }): BackoffState;
  /** Cascade clear every per-tuple backoff state under a connection. */
  removeForConnection(connection_id: string): number;
  /** D-139 P2 Codex review fold #3 — bump the per-(connection, vendor,
   *  entity) daily pages-fetched counter by `n`. Resets the bucket if
   *  `now - bucket_started_at >= DAILY_BUCKET_MS`. Returns the post-
   *  bump usage row so callers can surface it without a separate
   *  read. */
  recordPages(input: {
    connection_id: string;
    vendor: EngagementVendor;
    entity: string;
    n: number;
    now: number;
  }): PagesUsage;
  /** Read the per-(connection, vendor, entity) daily pages-fetched
   *  counter. Seeds a fresh row at zero on first call so the health-
   *  surface rpc always returns a stable shape. */
  readPages(input: {
    connection_id: string;
    vendor: EngagementVendor;
    entity: string;
    now: number;
  }): PagesUsage;
}

// D-192 — the per-vendor default daily budget comes from the vendor-entity
// registry's `engagement` facet (`daily_budget`) instead of a `hubspot`/`salesforce`
// branch: HubSpot declares 250k, Salesforce 50k. Read over the shipped built-ins
// (this low-level store stays registry-free by design — a pack vendor's declared
// budget reaches the store via the rate-gate's explicit `daily_budget`, and a
// vendor with no declared budget falls back to the conservative floor).
const vendorDefault = (vendor: EngagementVendor): number =>
  engagementDailyBudget(vendor) ?? SALESFORCE_DAILY_BUDGET_DEFAULT;

export const createEngagementRateControlStore = (
  db: Database.Database,
): EngagementRateControlStore => {
  ensureEngagementRateControlSchema(db);

  const getBudgetStmt = db.prepare(
    `SELECT * FROM ${ENGAGEMENT_BUDGET_TABLE}
       WHERE connection_id = ? AND vendor = ?`,
  );
  const insertBudgetStmt = db.prepare(
    `INSERT INTO ${ENGAGEMENT_BUDGET_TABLE}
       (connection_id, vendor, daily_budget, calls_today, bucket_started_at)
       VALUES (?, ?, ?, 0, ?)
     ON CONFLICT(connection_id, vendor) DO NOTHING`,
  );
  const updateBudgetCallsStmt = db.prepare(
    `UPDATE ${ENGAGEMENT_BUDGET_TABLE}
        SET calls_today = ?, bucket_started_at = ?
      WHERE connection_id = ? AND vendor = ?`,
  );
  const setBudgetCapStmt = db.prepare(
    `UPDATE ${ENGAGEMENT_BUDGET_TABLE}
        SET daily_budget = ?
      WHERE connection_id = ? AND vendor = ?`,
  );

  const getBackoffStmt = db.prepare(
    `SELECT * FROM ${ENGAGEMENT_RATE_CONTROL_TABLE}
       WHERE connection_id = ? AND vendor = ? AND entity = ?`,
  );
  const upsertBackoffStmt = db.prepare(
    `INSERT INTO ${ENGAGEMENT_RATE_CONTROL_TABLE}
       (connection_id, vendor, entity, consecutive_429s, last_429_at)
       VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(connection_id, vendor, entity) DO UPDATE SET
       consecutive_429s = excluded.consecutive_429s,
       last_429_at      = excluded.last_429_at`,
  );
  const removeBackoffForConnectionStmt = db.prepare(
    `DELETE FROM ${ENGAGEMENT_RATE_CONTROL_TABLE}
       WHERE connection_id = ?`,
  );

  // Helpers
  const seedBudget = (
    connection_id: string,
    vendor: EngagementVendor,
    now: number,
    daily_budget?: number,
  ): {
    daily_budget: number;
    calls_today: number;
    bucket_started_at: number;
  } => {
    const cap = daily_budget ?? vendorDefault(vendor);
    insertBudgetStmt.run(connection_id, vendor, cap, now);
    const row = getBudgetStmt.get(connection_id, vendor) as
      | {
          daily_budget: number;
          calls_today: number;
          bucket_started_at: number;
        }
      | undefined;
    return row ?? { daily_budget: cap, calls_today: 0, bucket_started_at: now };
  };

  const computeUsage = (
    connection_id: string,
    vendor: EngagementVendor,
    daily_budget: number,
    calls_today: number,
    bucket_started_at: number,
  ): BudgetUsage => {
    const utilization = daily_budget > 0 ? calls_today / daily_budget : 0;
    const capped = Math.min(utilization, 1);
    const rate_control_state = deriveRateControlState(utilization);
    return {
      connection_id,
      vendor,
      daily_budget,
      calls_today,
      bucket_started_at,
      budget_utilization_pct: capped,
      rate_control_state,
    };
  };

  const recordUsage: EngagementRateControlStore['recordUsage'] = (input) => {
    // D-192 — vendor is opaque provenance at the store layer (the reconciler
    // write-path is the real engagement-vendor gate); reject only empty/corrupt.
    if (input.vendor.length === 0) {
      throw new RateControlInvalidError('vendor must be non-empty');
    }
    const seed = seedBudget(input.connection_id, input.vendor, input.now);
    let calls_today = seed.calls_today;
    let bucket_started_at = seed.bucket_started_at;
    const inc = input.n ?? 1;
    if (inc < 0) {
      throw new RateControlInvalidError('recordUsage `n` must be non-negative');
    }
    // Bucket-rollover: reset counter if window elapsed.
    if (input.now - bucket_started_at >= DAILY_BUCKET_MS) {
      calls_today = 0;
      bucket_started_at = input.now;
    }
    calls_today += inc;
    updateBudgetCallsStmt.run(
      calls_today,
      bucket_started_at,
      input.connection_id,
      input.vendor,
    );
    return computeUsage(
      input.connection_id,
      input.vendor,
      seed.daily_budget,
      calls_today,
      bucket_started_at,
    );
  };

  const readUsage: EngagementRateControlStore['readUsage'] = (input) => {
    const seed = seedBudget(
      input.connection_id,
      input.vendor,
      input.now,
      input.daily_budget,
    );
    let calls_today = seed.calls_today;
    let bucket_started_at = seed.bucket_started_at;
    if (input.now - bucket_started_at >= DAILY_BUCKET_MS) {
      // Bucket rolled but the read alone shouldn't increment; reflect
      // the zeroed view + persist the new bucket-start atomically so
      // subsequent recordUsage calls compute against the fresh bucket.
      calls_today = 0;
      bucket_started_at = input.now;
      updateBudgetCallsStmt.run(
        calls_today,
        bucket_started_at,
        input.connection_id,
        input.vendor,
      );
    }
    return computeUsage(
      input.connection_id,
      input.vendor,
      seed.daily_budget,
      calls_today,
      bucket_started_at,
    );
  };

  const setBudget: EngagementRateControlStore['setBudget'] = (input) => {
    if (input.daily_budget < 0) {
      throw new RateControlInvalidError(
        'daily_budget must be non-negative',
      );
    }
    seedBudget(input.connection_id, input.vendor, input.now, input.daily_budget);
    setBudgetCapStmt.run(
      input.daily_budget,
      input.connection_id,
      input.vendor,
    );
  };

  const resetBucket: EngagementRateControlStore['resetBucket'] = (input) => {
    seedBudget(input.connection_id, input.vendor, input.now);
    updateBudgetCallsStmt.run(
      0,
      input.now,
      input.connection_id,
      input.vendor,
    );
  };

  const readBackoff: EngagementRateControlStore['readBackoff'] = (input) => {
    const row = getBackoffStmt.get(
      input.connection_id,
      input.vendor,
      input.entity,
    ) as
      | { consecutive_429s: number; last_429_at: number | null }
      | undefined;
    const consecutive_429s = row?.consecutive_429s ?? 0;
    const last_429_at = row?.last_429_at ?? null;
    return {
      connection_id: input.connection_id,
      vendor: input.vendor,
      entity: input.entity,
      consecutive_429s,
      last_429_at,
      next_attempt_at: computeNextAttemptAt(consecutive_429s, last_429_at),
    };
  };

  const recordTooManyRequests: EngagementRateControlStore['recordTooManyRequests'] = (
    input,
  ) => {
    const current = readBackoff(input);
    const next_consecutive = current.consecutive_429s + 1;
    upsertBackoffStmt.run(
      input.connection_id,
      input.vendor,
      input.entity,
      next_consecutive,
      input.now,
    );
    return {
      connection_id: input.connection_id,
      vendor: input.vendor,
      entity: input.entity,
      consecutive_429s: next_consecutive,
      last_429_at: input.now,
      next_attempt_at: computeNextAttemptAt(next_consecutive, input.now),
    };
  };

  const recordSuccess: EngagementRateControlStore['recordSuccess'] = (
    input,
  ) => {
    upsertBackoffStmt.run(
      input.connection_id,
      input.vendor,
      input.entity,
      0,
      null,
    );
  };

  const removeForConnection: EngagementRateControlStore['removeForConnection'] = (
    connection_id,
  ) => {
    const result = removeBackoffForConnectionStmt.run(connection_id);
    return result.changes;
  };

  // ──────────────────────────────────────────────────────────
  // P2 Codex review fold #3 — per-(connection, vendor, entity)
  // daily pages-fetched counter. Same 24h rolling-window reset
  // as the budget bucket; surfaces in the health-surface rpc.
  // ──────────────────────────────────────────────────────────
  const getPagesStmt = db.prepare(
    `SELECT * FROM ${ENGAGEMENT_PAGE_TABLE}
       WHERE connection_id = ? AND vendor = ? AND entity = ?`,
  );
  const insertPagesStmt = db.prepare(
    `INSERT INTO ${ENGAGEMENT_PAGE_TABLE}
       (connection_id, vendor, entity, pages_today, bucket_started_at)
       VALUES (?, ?, ?, 0, ?)
     ON CONFLICT(connection_id, vendor, entity) DO NOTHING`,
  );
  const updatePagesStmt = db.prepare(
    `UPDATE ${ENGAGEMENT_PAGE_TABLE}
        SET pages_today = ?, bucket_started_at = ?
      WHERE connection_id = ? AND vendor = ? AND entity = ?`,
  );

  const seedPages = (
    connection_id: string,
    vendor: EngagementVendor,
    entity: string,
    now: number,
  ): { pages_today: number; bucket_started_at: number } => {
    insertPagesStmt.run(connection_id, vendor, entity, now);
    const row = getPagesStmt.get(connection_id, vendor, entity) as
      | { pages_today: number; bucket_started_at: number }
      | undefined;
    return row ?? { pages_today: 0, bucket_started_at: now };
  };

  const recordPages: EngagementRateControlStore['recordPages'] = (input) => {
    // D-192 — vendor is opaque provenance at the store layer (the reconciler
    // write-path is the real engagement-vendor gate); reject only empty/corrupt.
    if (input.vendor.length === 0) {
      throw new RateControlInvalidError('vendor must be non-empty');
    }
    if (input.entity.length === 0) {
      throw new RateControlInvalidError('entity must be non-empty');
    }
    const seeded = seedPages(input.connection_id, input.vendor, input.entity, input.now);
    let { pages_today, bucket_started_at } = seeded;
    // Roll the bucket if 24h passed since bucket_started_at.
    if (input.now - bucket_started_at >= DAILY_BUCKET_MS) {
      pages_today = 0;
      bucket_started_at = input.now;
    }
    const next = Math.max(0, pages_today + (input.n ?? 0));
    updatePagesStmt.run(
      next,
      bucket_started_at,
      input.connection_id,
      input.vendor,
      input.entity,
    );
    return {
      connection_id: input.connection_id,
      vendor: input.vendor,
      entity: input.entity,
      pages_today: next,
      bucket_started_at,
    };
  };

  const readPages: EngagementRateControlStore['readPages'] = (input) => {
    // D-192 — vendor is opaque provenance at the store layer (the reconciler
    // write-path is the real engagement-vendor gate); reject only empty/corrupt.
    if (input.vendor.length === 0) {
      throw new RateControlInvalidError('vendor must be non-empty');
    }
    if (input.entity.length === 0) {
      throw new RateControlInvalidError('entity must be non-empty');
    }
    const seeded = seedPages(input.connection_id, input.vendor, input.entity, input.now);
    let { pages_today, bucket_started_at } = seeded;
    if (input.now - bucket_started_at >= DAILY_BUCKET_MS) {
      pages_today = 0;
      bucket_started_at = input.now;
      updatePagesStmt.run(
        0,
        bucket_started_at,
        input.connection_id,
        input.vendor,
        input.entity,
      );
    }
    return {
      connection_id: input.connection_id,
      vendor: input.vendor,
      entity: input.entity,
      pages_today,
      bucket_started_at,
    };
  };

  return {
    recordUsage,
    readUsage,
    setBudget,
    resetBucket,
    recordTooManyRequests,
    recordSuccess,
    readBackoff,
    removeForConnection,
    recordPages,
    readPages,
  };
};
