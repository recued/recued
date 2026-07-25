/** D-132 Phase 1 — `enrichment_trust` store + global config helpers.
 *
 *  Per-topic trust state + pool policy persisted on `enrichment_trust`.
 *  Absent row means "registry default" — `read()` returns the resolved
 *  effective shape (registry default folded in) so callers don't have
 *  to branch. Writes upsert.
 *
 *  Global pause-AI + BYOK-allowed live on `housekeeping_config`
 *  (singleton row keyed `'singleton'`); thin pass-through helpers
 *  here keep callers in one place. The runtime check (scheduler
 *  eligibility, harness forceLayer threading) lands in P2.
 *
 *  Spec: D-132 A.1 / A.3. */

import type Database from 'better-sqlite3';

import {
  type EnrichmentPoolPolicy,
  type EnrichmentTopic,
  type EnrichmentTrustRow,
  type EnrichmentTrustState,
  type HousekeepingErrorEntry,
  TRUST_ERROR_HISTORY_SIZE,
  isEnrichmentTopic,
  resolveEnrichmentPoolPolicyDefault,
  resolveEnrichmentTrustDefault,
} from '@recued/contracts';

// ────────────────────────────────────────────────────────────────
// Trust store — per-topic CRUD
// ────────────────────────────────────────────────────────────────

export interface TrustStore {
  /** Resolve effective trust state + pool policy for a topic. Returns
   *  the persisted row when present; otherwise synthesises a row from
   *  the registry defaults so callers always get a fully-populated
   *  shape. The synthesised row carries `manual_run_count: 0` and
   *  null promotion timestamps. */
  read(topic: EnrichmentTopic, isAiSurface: boolean): EnrichmentTrustRow;
  /** Persist a partial update to a topic's trust shape. Missing fields
   *  default from registry on first write. Bumps `updated_at`. */
  write(
    topic: EnrichmentTopic,
    patch: Partial<Pick<EnrichmentTrustRow, 'trust_state' | 'pool_policy'>>,
    now: number,
  ): void;
  /** Increment `manual_run_count` after a successful manual fire of an
   *  AI-surface producer. Returns the new count so the rpc layer can
   *  decide whether to fire `RealtimePromotionSuggestedEvent`. Idempotent
   *  on absent row — initialises with registry defaults + count 1. */
  bumpManualRunCount(
    topic: EnrichmentTopic,
    isAiSurface: boolean,
    now: number,
  ): number;
  /** Mark the promotion banner as fired. Sets `promotion_suggested_at`
   *  to `now` iff currently null. */
  markPromotionSuggested(topic: EnrichmentTopic, now: number): void;
  /** Mark "Don't ask again" — sets `promotion_dismissed_at`. Banner
   *  re-arming requires user-side action via the trust radios. */
  markPromotionDismissed(topic: EnrichmentTopic, now: number): void;
  /** List every persisted trust row. Used by the Settings panel to
   *  render the per-topic status table; topics absent from the list
   *  fall back to registry defaults at render time. */
  list(): ReadonlyArray<EnrichmentTrustRow>;
}

interface PersistedRow {
  topic: string;
  trust_state: string;
  pool_policy: string;
  manual_run_count: number;
  promotion_suggested_at: number | null;
  promotion_dismissed_at: number | null;
  updated_at: number;
}

const decodeRow = (raw: PersistedRow): EnrichmentTrustRow => ({
  topic: raw.topic,
  trust_state: raw.trust_state as EnrichmentTrustState,
  pool_policy: raw.pool_policy as EnrichmentPoolPolicy,
  manual_run_count: raw.manual_run_count,
  promotion_suggested_at: raw.promotion_suggested_at,
  promotion_dismissed_at: raw.promotion_dismissed_at,
  updated_at: raw.updated_at,
});

export const createTrustStore = (db: Database.Database): TrustStore => {
  const selectOne = db.prepare(
    `SELECT topic, trust_state, pool_policy, manual_run_count,
            promotion_suggested_at, promotion_dismissed_at, updated_at
       FROM enrichment_trust WHERE topic = ?`,
  );
  const selectAll = db.prepare(
    `SELECT topic, trust_state, pool_policy, manual_run_count,
            promotion_suggested_at, promotion_dismissed_at, updated_at
       FROM enrichment_trust`,
  );
  const upsert = db.prepare(
    `INSERT INTO enrichment_trust (
       topic, trust_state, pool_policy, manual_run_count,
       promotion_suggested_at, promotion_dismissed_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(topic) DO UPDATE SET
       trust_state = excluded.trust_state,
       pool_policy = excluded.pool_policy,
       manual_run_count = excluded.manual_run_count,
       promotion_suggested_at = excluded.promotion_suggested_at,
       promotion_dismissed_at = excluded.promotion_dismissed_at,
       updated_at = excluded.updated_at`,
  );

  const synthesizeDefault = (
    topic: EnrichmentTopic,
    isAiSurface: boolean,
    now: number,
  ): EnrichmentTrustRow => ({
    topic,
    trust_state: resolveEnrichmentTrustDefault(topic, isAiSurface),
    pool_policy: resolveEnrichmentPoolPolicyDefault(topic),
    manual_run_count: 0,
    promotion_suggested_at: null,
    promotion_dismissed_at: null,
    updated_at: now,
  });

  return {
    read(topic, isAiSurface) {
      const raw = selectOne.get(topic) as PersistedRow | undefined;
      if (raw) return decodeRow(raw);
      return synthesizeDefault(topic, isAiSurface, 0);
    },

    write(topic, patch, now) {
      if (!isEnrichmentTopic(topic)) {
        throw new Error(`enrichment_topic_unknown: '${topic}'`);
      }
      // We don't know `isAiSurface` here without producer context, but
      // the registry default helper accepts the heuristic flag and the
      // user is overriding, so the synthesised baseline is irrelevant
      // to the final stored row — the patch fields win. Only fall-back
      // to registry default when the patch omits the field on first
      // write (no prior row).
      const existing = selectOne.get(topic) as PersistedRow | undefined;
      const nextTrust = patch.trust_state ??
        (existing?.trust_state as EnrichmentTrustState | undefined) ??
        resolveEnrichmentTrustDefault(topic, false);
      const nextPool = patch.pool_policy ??
        (existing?.pool_policy as EnrichmentPoolPolicy | undefined) ??
        resolveEnrichmentPoolPolicyDefault(topic);
      upsert.run(
        topic,
        nextTrust,
        nextPool,
        existing?.manual_run_count ?? 0,
        existing?.promotion_suggested_at ?? null,
        existing?.promotion_dismissed_at ?? null,
        now,
      );
    },

    bumpManualRunCount(topic, isAiSurface, now) {
      const existing = selectOne.get(topic) as PersistedRow | undefined;
      const nextCount = (existing?.manual_run_count ?? 0) + 1;
      upsert.run(
        topic,
        existing?.trust_state ?? resolveEnrichmentTrustDefault(topic, isAiSurface),
        existing?.pool_policy ?? resolveEnrichmentPoolPolicyDefault(topic),
        nextCount,
        existing?.promotion_suggested_at ?? null,
        existing?.promotion_dismissed_at ?? null,
        now,
      );
      return nextCount;
    },

    markPromotionSuggested(topic, now) {
      const existing = selectOne.get(topic) as PersistedRow | undefined;
      if (!existing) {
        // No row yet — synthesise + stamp suggestion. AI vs deterministic
        // doesn't matter here; promotion suggestions only fire for AI
        // surfaces but the trust row defaults to manual either way.
        upsert.run(
          topic,
          resolveEnrichmentTrustDefault(topic, true),
          resolveEnrichmentPoolPolicyDefault(topic),
          0,
          now,
          null,
          now,
        );
        return;
      }
      if (existing.promotion_suggested_at !== null) return; // idempotent
      upsert.run(
        topic,
        existing.trust_state,
        existing.pool_policy,
        existing.manual_run_count,
        now,
        existing.promotion_dismissed_at,
        now,
      );
    },

    markPromotionDismissed(topic, now) {
      const existing = selectOne.get(topic) as PersistedRow | undefined;
      if (!existing) {
        upsert.run(
          topic,
          resolveEnrichmentTrustDefault(topic, true),
          resolveEnrichmentPoolPolicyDefault(topic),
          0,
          null,
          now,
          now,
        );
        return;
      }
      upsert.run(
        topic,
        existing.trust_state,
        existing.pool_policy,
        existing.manual_run_count,
        existing.promotion_suggested_at,
        now,
        now,
      );
    },

    list() {
      const rows = selectAll.all() as PersistedRow[];
      return rows.map(decodeRow);
    },
  };
};

// ────────────────────────────────────────────────────────────────
// Pause-AI + BYOK-allowed — global config pass-through
// ────────────────────────────────────────────────────────────────

/** Whether a paused-AI window is currently active. The transient
 *  timestamp lives on `housekeeping_config.pause_background_ai_until`
 *  — when set + `now < pause_background_ai_until`, every AI-surface
 *  producer skips the idle cycle / reactive dispatch path. */
export const isAiPaused = (
  db: Database.Database,
  now: number,
): boolean => {
  const row = db
    .prepare(
      `SELECT pause_background_ai_until FROM housekeeping_config WHERE id = 'singleton'`,
    )
    .get() as { pause_background_ai_until: number | null } | undefined;
  if (!row || row.pause_background_ai_until === null) return false;
  return now < row.pause_background_ai_until;
};

/** Whether the user has enabled BYOK for background producers. When
 *  false (the default), every effective `pool_policy` collapses to
 *  `'free_only'` regardless of the per-topic setting. */
export const isByokAllowedForBackground = (db: Database.Database): boolean => {
  const row = db
    .prepare(
      `SELECT allow_byok_background FROM housekeeping_config WHERE id = 'singleton'`,
    )
    .get() as { allow_byok_background: number } | undefined;
  return row?.allow_byok_background === 1;
};

// ────────────────────────────────────────────────────────────────
// Last-N error ring buffer — housekeeping_state extension
// ────────────────────────────────────────────────────────────────

/** Append a new error entry to a task's ring buffer. Trims to
 *  `TRUST_ERROR_HISTORY_SIZE` newest entries. Idempotent on
 *  malformed JSON — the existing column is treated as empty. */
export const appendTaskErrorEntry = (
  db: Database.Database,
  task_id: string,
  entry: HousekeepingErrorEntry,
): void => {
  const row = db
    .prepare(
      `SELECT last_errors_json FROM housekeeping_state WHERE task_id = ?`,
    )
    .get(task_id) as { last_errors_json: string | null } | undefined;
  let prior: HousekeepingErrorEntry[] = [];
  if (row?.last_errors_json) {
    try {
      const parsed = JSON.parse(row.last_errors_json) as unknown;
      if (Array.isArray(parsed)) prior = parsed as HousekeepingErrorEntry[];
    } catch {
      // malformed — treat as empty buffer
    }
  }
  const next = [entry, ...prior].slice(0, TRUST_ERROR_HISTORY_SIZE);
  db.prepare(
    `UPDATE housekeeping_state SET last_errors_json = ? WHERE task_id = ?`,
  ).run(JSON.stringify(next), task_id);
};

/** Read the ring buffer. Returns `[]` when the column is null /
 *  malformed / the row doesn't exist. */
export const readTaskErrorHistory = (
  db: Database.Database,
  task_id: string,
): ReadonlyArray<HousekeepingErrorEntry> => {
  const row = db
    .prepare(
      `SELECT last_errors_json FROM housekeeping_state WHERE task_id = ?`,
    )
    .get(task_id) as { last_errors_json: string | null } | undefined;
  if (!row?.last_errors_json) return [];
  try {
    const parsed = JSON.parse(row.last_errors_json) as unknown;
    if (Array.isArray(parsed)) return parsed as HousekeepingErrorEntry[];
  } catch {
    // fall through
  }
  return [];
};
