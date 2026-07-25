/** D-145 PA9 — `source_freshness_degradation` enrichment producer.
 *
 *  Per-Source health signal (spec § A.7.6 #6). The Recued engine reads
 *  this row to decide which Sources to include in or omit from an AI
 *  context packet (degraded Source → omit, OR include with the
 *  `coverage.sources_degraded` flag so the AI knows). Produces input to
 *  every other producer's `sources_degraded` coverage field.
 *
 *  Seventh D-145 PA9 producer + first scenario-aggregation Shape B
 *  derived-entity producer in this arc (the prior six are all
 *  per-record on a work-entity walker scope). Standalone task — one
 *  task instance iterates every registered Source on each cycle, emits
 *  one row per Source, then sweeps rows whose Source has been
 *  unregistered. Matches the `organizationTask` / `confidenceDriftSignalTask`
 *  precedent (derived_entity / policy: independent / one cycle walks
 *  the whole input domain).
 *
 *  Inputs:
 *
 *    1. `source_registry` rows (read via `ctx.workEntityStore.listSources()`).
 *       Optional — when the store is unwired the producer abstains
 *       (empty cycle + sweep), same way `organization` tolerates a
 *       missing `contacts` table.
 *    2. `connections` rows (read directly via `ctx.db` raw SQL —
 *       parallel to the `connection_health_trend` producer's read
 *       path; no per-pair connection store sits on the housekeeping
 *       context).
 *
 *  Degradation detection (closed list per
 *  `SourceFreshnessDegradationValue.reasons` →
 *  `SOURCE_DEGRADATION_REASONS`):
 *
 *    - `permission_revoked` — `enabled === false` on the registry row
 *      (user disabled the Source in Settings → Work Entities → Sources)
 *      OR a `source_kind: 'connection'` row whose backing connection
 *      record is missing (un-enrolled at the connection layer) OR a
 *      backing connection whose `health.status` is `'auth_failed'`.
 *    - `quota_suspended` — backing connection whose `health.status` is
 *      `'unreachable'`. v1 maps the `ConnectionHealth.status` enum's
 *      single non-auth failure state into the closest reason — full
 *      `quota_suspended` / `rate_limit_active` / `webhook_delivery_degraded`
 *      discrimination needs vendor-specific health payloads which
 *      reconcilers don't populate yet. The closed list stays accurate
 *      for forward compatibility (the schema accepts richer reasons
 *      when reconcilers start writing them); v1 conservatively
 *      under-discriminates rather than over-claim quota / rate-limit
 *      status from an `'unreachable'` signal.
 *
 *  `last_seen_at` (number | null) is the most recent `last_seen_at`
 *  across the four work-entity tables for the Source. Surfaces "this
 *  Source contributed a row N ms ago" without forcing the engine to
 *  re-derive on every read. NULL means the Source has not yet
 *  contributed any row (newly registered, never reconciled, or builtin
 *  Source on an empty pair).
 *
 *  Sample-floor semantics. `sample_floor: 1` — every registered Source
 *  emits a row, even when no entity rows exist yet. Engine reads the
 *  empty-history case as "Source is known but contributed nothing"; an
 *  unregistered Source has no row at all.
 *
 *  Cadence + invalidation. Registry's `producer_kind: 'housekeeping'`
 *  drives the steady-state cycle. The declaration's
 *  `invalidation_triggers` carry the spec's reactivity (source_registry
 *  updates + connection state changes) inside one cycle, pending the
 *  reactive harness lift. Spec § A.7.2 frames this as
 *  "housekeeping (hourly) + reactive (on connection state change)".
 *
 *  Spec: `docs/d-145-spec.md` §§ A.7.2 + A.7.5 + A.7.6 #6 +
 *        `ENRICHMENT_REGISTRY.source_freshness_degradation` +
 *        `packages/contracts/src/enrichment-declarations/source-freshness-degradation.ts`. */

import type Database from 'better-sqlite3';

import {
  ENRICHMENT_REGISTRY,
  computeHousekeepingMetaTags,
  type ConnectionHealth,
  type EnrichmentTopic,
  type HousekeepingCursor,
  type HousekeepingStepResult,
  type SourceDegradationReason,
  type SourceFreshnessDegradationValue,
  type SourceRegistration,
  type SourceTopTierKind,
} from '@recued/contracts';

import type {
  HousekeepingContext,
  HousekeepingTaskInstance,
} from '../registry.js';
import {
  COMMITMENT_TABLE,
  NOTE_TABLE,
  PROJECT_TABLE,
  TASK_TABLE,
} from '../../storage/work-entity-store.js';
import { FILE_SOURCE_SYNC_STATE_TABLE } from '../../storage/file-source-sync-state.js';
import { CONTACT_SOURCE_SYNC_STATE_TABLE } from '../../storage/contact-source-sync-state.js';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

/** Topic key for this producer's emitted rows. */
export const SOURCE_FRESHNESS_DEGRADATION_TOPIC: EnrichmentTopic =
  'source_freshness_degradation';

/** Authored-by stamp for the producer's writes. Matches the
 *  `system.housekeeping.<topic>` convention every other harness-driven
 *  producer follows; surfaces in Memory as the row attribution. */
export const SOURCE_FRESHNESS_DEGRADATION_AUTHORED_BY =
  'system.housekeeping.source_freshness_degradation';

/** Per-cycle token estimate for the Run-Now cost preview. Pure SQL +
 *  JSON parse; no LLM, no embeddings. Idle-eligible by construction
 *  (`is_ai_surface: false` + the registry resolver returns `'auto'` for
 *  non-AI topics). */
export const SOURCE_FRESHNESS_DEGRADATION_TOKEN_ESTIMATE = 0;

/** Hard cap on Sources walked per cycle. A pair with > 1000 Sources is
 *  pathological — typical user has < 20 across builtin (4 by default)
 *  + per-connection (2 per HubSpot / Salesforce). The cap is defensive,
 *  not a bottleneck. */
export const SOURCE_FRESHNESS_DEGRADATION_MAX_SOURCES = 1000;

/** Closed-list connection kinds the producer iterates when looking up
 *  the backing connection for a `source_kind: 'connection'` Source.
 *  Mirrors `CONNECTION_KINDS` from contracts (intentionally not
 *  imported here to keep the dependency surface narrow — the producer
 *  uses these as a lookup probe order, not as a typed contract). */
const PROBE_CONNECTION_KINDS = ['api', 'mcp', 'notification'] as const;

/** Cap on `last_seen_at` query result size — defensive against future
 *  schema changes that might introduce a row matching multiple Sources
 *  (today there's a 1:1 row→Source mapping). */
const LAST_SEEN_QUERY_LIMIT = 1;

// ────────────────────────────────────────────────────────────────
// Pure helpers — Source id parsing
// ────────────────────────────────────────────────────────────────

/** Parsed connection reference inside a connection-derived Source id.
 *  Per `CONNECTION_SOURCE_ID(vendor, connection_name, kind)`:
 *    `<vendor>.<connection_name>.<top_tier_kind>`
 *  e.g. `hubspot.conn_1.task` → vendor='hubspot', connection_name='conn_1'. */
export interface ParsedConnectionSourceRef {
  vendor: string;
  connection_name: string;
}

/** Parse a connection-derived Source id back into `(vendor, connection_name)`.
 *  Returns null for builtin / adapter / dish Sources (the parser is
 *  source-kind agnostic; the caller gates on `source_kind === 'connection'`
 *  before calling).
 *
 *  Connection names may contain `.` — the format is vendor first
 *  segment, top_tier_kind last segment, middle segments rejoined as the
 *  connection name. Same parsing discipline as the spec's
 *  `<vendor>.<connection_id>.<kind>` format. */
export const parseConnectionSourceRef = (
  id: string,
): ParsedConnectionSourceRef | null => {
  const segments = id.split('.');
  if (segments.length < 3) return null;
  const vendor = segments[0]!;
  const middle = segments.slice(1, -1).join('.');
  if (vendor.length === 0 || middle.length === 0) return null;
  return { vendor, connection_name: middle };
};

// ────────────────────────────────────────────────────────────────
// Pure helpers — connection health → reasons
// ────────────────────────────────────────────────────────────────

/** Parse a connection row's `health_json` defensively. Returns null
 *  when absent, malformed, or shape-incompatible — caller treats null
 *  as "no health signal recorded yet". Mirrors the same defensive
 *  posture `connection_health_trend` uses on audit-row JSON. */
export const parseConnectionHealth = (
  health_json: string | null | undefined,
): ConnectionHealth | null => {
  if (health_json === null || health_json === undefined) return null;
  if (typeof health_json !== 'string' || health_json.length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(health_json);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const status = obj.status;
  if (
    status !== 'ok' &&
    status !== 'auth_failed' &&
    status !== 'unreachable' &&
    status !== 'unknown'
  ) {
    return null;
  }
  return obj as unknown as ConnectionHealth;
};

/** Map a `ConnectionHealth.status` into the closed-list degradation
 *  reason set. v1 collapses the two non-`ok` failure modes onto
 *  `permission_revoked` (auth-side) + `quota_suspended` (transport-
 *  side); `'unknown'` and `'ok'` contribute no reason. */
export const reasonsFromConnectionHealth = (
  health: ConnectionHealth | null,
): SourceDegradationReason[] => {
  if (health === null) return [];
  if (health.status === 'auth_failed') return ['permission_revoked'];
  if (health.status === 'unreachable') return ['quota_suspended'];
  return [];
};

// ────────────────────────────────────────────────────────────────
// Pure helpers — reason composition
// ────────────────────────────────────────────────────────────────

/** Append a reason to the list iff not already present. Keeps the
 *  emitted `reasons[]` deduplicated when multiple signals (e.g.
 *  `enabled: false` + missing connection + health: auth_failed) all
 *  resolve to the same closed-list token. */
export const appendUniqueReason = (
  reasons: SourceDegradationReason[],
  reason: SourceDegradationReason,
): void => {
  if (!reasons.includes(reason)) reasons.push(reason);
};

// ────────────────────────────────────────────────────────────────
// SQL queries
// ────────────────────────────────────────────────────────────────

/** Connection row shape — the four columns the producer reads. Mirrors
 *  the `ConnectionStoreSqlite`-managed schema; we read directly off
 *  `ctx.db` so no per-pair connection store needs to be threaded on
 *  the housekeeping context. */
export interface ConnectionLookupRow {
  kind: 'api' | 'mcp' | 'notification';
  name: string;
  health_json: string | null;
}

/** Read one connection row by `(kind, name)`. Returns null when the
 *  composite key doesn't match. Tolerant of a missing `connections`
 *  table — fresh-pair / first-boot scenarios may not yet have the
 *  schema installed, in which case every lookup returns null and the
 *  caller marks all connection-derived Sources as
 *  `permission_revoked`. */
export const getConnectionByKindAndName = (
  db: Database.Database,
  kind: 'api' | 'mcp' | 'notification',
  name: string,
): ConnectionLookupRow | null => {
  const tableExists = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='connections'`,
    )
    .get() as { name: string } | undefined;
  if (!tableExists) return null;
  const row = db
    .prepare(
      `SELECT kind, name, health_json FROM connections
         WHERE kind = ? AND name = ?
         LIMIT 1`,
    )
    .get(kind, name) as ConnectionLookupRow | undefined;
  return row ?? null;
};

/** Probe each connection kind in order, returning the first match for
 *  `name`. Connection-derived Source ids don't carry the connection
 *  kind, so the producer can't address the row directly — the probe is
 *  the simplest correct disambiguation across `api` / `mcp` /
 *  `notification`. Returns null when no kind matches. */
export const findConnectionByName = (
  db: Database.Database,
  name: string,
): ConnectionLookupRow | null => {
  for (const kind of PROBE_CONNECTION_KINDS) {
    const row = getConnectionByKindAndName(db, kind, name);
    if (row !== null) return row;
  }
  return null;
};

/** Compute the most recent `last_seen_at` across the four work-entity
 *  tables for one Source. Tombstoned rows excluded — they're audit-
 *  preserved but no longer "current". Tolerant of missing tables (the
 *  schema may not be installed on fresh-pair scenarios); returns null
 *  when no rows match.
 *
 *  Each entity table is queried independently rather than UNIONed — the
 *  four tables aren't co-indexed and the per-table prepared-statement
 *  cache wins over a multi-statement UNION at smaller per-pair entity
 *  counts. */
export const computeLastSeenAtForSource = (
  db: Database.Database,
  source_id: string,
): number | null => {
  let maxSeen: number | null = null;
  for (const table of [TASK_TABLE, NOTE_TABLE, COMMITMENT_TABLE, PROJECT_TABLE]) {
    const tableExists = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
      )
      .get(table) as { name: string } | undefined;
    if (!tableExists) continue;
    const row = db
      .prepare(
        `SELECT MAX(last_seen_at) AS m FROM "${table}"
           WHERE source_id = ?
             AND sync_state IN ('live', 'stale_unreachable')
             AND deleted_at IS NULL
           LIMIT ${LAST_SEEN_QUERY_LIMIT}`,
      )
      .get(source_id) as { m: number | null } | undefined;
    if (row && row.m !== null && (maxSeen === null || row.m > maxSeen)) {
      maxSeen = row.m;
    }
  }
  return maxSeen;
};

/** The per-kind table carrying a Source's OWN freshness + sync health.
 *
 *  A work-entity Source's recency comes from the four entity tables. A file or
 *  contact Source has no entity rows at all, so `computeLastSeenAtForSource` is
 *  always null for it and its health lives on its own state row instead. Both tables
 *  expose the same `(source_id, last_success_at, degraded)` triple, so ONE reader
 *  serves both — a second per-kind branch here would be a copy of the first.
 *
 *  ⚠ D-205 item #1 — the CONTACT entry is new, and its absence was a real hole: a
 *  contact Source whose leaf failed EVERY record on EVERY cycle reported
 *  `degraded: false, last_seen_at: null` — a straight face over total failure — for
 *  the simple reason that nothing recorded its health and nothing looked. */
const SOURCE_SYNC_STATE_TABLE_BY_KIND: Partial<Record<SourceTopTierKind, string>> = {
  file: FILE_SOURCE_SYNC_STATE_TABLE,
  contact: CONTACT_SOURCE_SYNC_STATE_TABLE,
};

/** Read one Source's state row. `last_success_at` is the freshness anchor, and a
 *  `degraded` last cycle contributes `partial_api_failure` (the closest closed-list
 *  reason — a partial/failed vendor list walk). Table-exists-tolerant (a
 *  work-entity-only pair never installed the file or contact schema) → `null` when
 *  absent. Read via `ctx.db` raw SQL, parallel to the connection-health read path —
 *  no file/contact store sits on the housekeeping context. */
const readSourceSyncState = (
  db: Database.Database,
  table: string,
  source_id: string,
): { last_success_at: number | null; degraded: boolean } | null => {
  const tableExists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(table) as { name: string } | undefined;
  if (!tableExists) return null;
  const row = db
    .prepare(`SELECT last_success_at, degraded FROM ${table} WHERE source_id = ?`)
    .get(source_id) as { last_success_at: number | null; degraded: number } | undefined;
  if (row === undefined) return null;
  return { last_success_at: row.last_success_at ?? null, degraded: row.degraded === 1 };
};

// ────────────────────────────────────────────────────────────────
// Per-Source degradation computation
// ────────────────────────────────────────────────────────────────

/** Compute the degradation reasons for one Source. Pure function over
 *  the resolved inputs — caller hands in `(source, connectionLookup)`
 *  and the function decides reasons. Exported for direct unit testing
 *  without a SQLite fixture.
 *
 *  Detection order matches the spec's closed reason list — reasons are
 *  appended in canonical order so the emitted `reasons[]` is
 *  deterministic across runs with the same input. */
export const detectDegradationReasons = (
  source: SourceRegistration,
  resolveConnection: (name: string) => ConnectionLookupRow | null,
): SourceDegradationReason[] => {
  const reasons: SourceDegradationReason[] = [];

  // (1) User-disabled or substrate-disabled. `enabled` defaults to
  // true at the storage layer; `false` is the explicit toggle from
  // Settings → Work Entities → Sources.
  if (source.enabled === false) {
    appendUniqueReason(reasons, 'permission_revoked');
  }

  // (2) Connection-derived Source whose backing connection record is
  // gone or unhealthy. Builtin / adapter / dish Sources skip this
  // branch — they don't depend on a `connections` row.
  if (source.source_kind === 'connection') {
    const ref = parseConnectionSourceRef(source.id);
    if (ref !== null) {
      const conn = resolveConnection(ref.connection_name);
      if (conn === null) {
        // Connection was un-enrolled but the Source registration
        // outlived it (orphan). Substrate's
        // `unregisterConnectionTaskSource` hook should normally clear
        // both; the orphan branch is defensive.
        appendUniqueReason(reasons, 'permission_revoked');
      } else {
        const health = parseConnectionHealth(conn.health_json);
        for (const reason of reasonsFromConnectionHealth(health)) {
          appendUniqueReason(reasons, reason);
        }
      }
    }
  }

  return reasons;
};

// ────────────────────────────────────────────────────────────────
// Cycle
// ────────────────────────────────────────────────────────────────

/** Sweep rows whose backing Source has been unregistered since the
 *  last cycle. Walks every existing topic row + deletes those whose
 *  `_id` (= source_id) isn't in the fresh-source set. Pre-launch
 *  zero-installs semantics — the cascade engine doesn't fire on
 *  `source_registry.delete`, so this sweep is the only orphan-cleanup
 *  mechanism. Matches `sweepStaleOrgs` precedent. */
export const sweepStaleSourceFreshnessRows = (
  ctx: HousekeepingContext,
  freshIds: ReadonlySet<string>,
): { deleted: number } => {
  const existing = ctx.enrichmentStore.list({
    topic: SOURCE_FRESHNESS_DEGRADATION_TOPIC,
    fresh_only: false,
    limit: 1000,
  });
  let deleted = 0;
  for (const row of existing) {
    if (freshIds.has(row._id)) continue;
    if (ctx.enrichmentStore.deleteById(row._id)) deleted += 1;
  }
  return { deleted };
};

/** One-shot scan-and-emit cycle. Iterates every registered Source +
 *  emits one row per Source + sweeps stale rows.
 *
 *  Returns `{ produced, swept }` for caller-side assertions on cycle
 *  output. The standalone task wrapper drops the count + reports
 *  `complete` to the scheduler — the count is for tests / debug
 *  surfaces. */
export const runSourceFreshnessDegradationCycle = (
  ctx: HousekeepingContext,
): { produced: number; swept: number } => {
  const now = ctx.now();

  // Source registry — gated on the optional `workEntityStore` ctx
  // field (same nullness posture as `note_relevance_decay` /
  // `task_duplicate_candidate` / `project_next_action_gap`). Test
  // scaffolding without a work-entity store yields zero produced;
  // sweep still runs to drop any rows from a prior boot's wiring.
  if (ctx.workEntityStore === undefined) {
    const sweep = sweepStaleSourceFreshnessRows(ctx, new Set());
    return { produced: 0, swept: sweep.deleted };
  }
  const sources = ctx.workEntityStore.listSources();
  if (sources.length === 0) {
    const sweep = sweepStaleSourceFreshnessRows(ctx, new Set());
    return { produced: 0, swept: sweep.deleted };
  }
  const capped = sources.slice(0, SOURCE_FRESHNESS_DEGRADATION_MAX_SOURCES);

  const freshIds = new Set<string>();
  let produced = 0;
  const resolveConnection = (name: string): ConnectionLookupRow | null =>
    findConnectionByName(ctx.db, name);

  for (const source of capped) {
    const reasons = detectDegradationReasons(source, resolveConnection);
    // A file Source's recency + sync health live on `file_source_sync_state`
    // (the work-entity walk is always null for it); a degraded last cycle adds
    // `partial_api_failure` on top of any connection-derived reason.
    let last_seen_at = computeLastSeenAtForSource(ctx.db, source.id);
    const stateTable = SOURCE_SYNC_STATE_TABLE_BY_KIND[source.top_tier_kind];
    if (stateTable !== undefined) {
      const state = readSourceSyncState(ctx.db, stateTable, source.id);
      if (state !== null) {
        last_seen_at = state.last_success_at;
        if (state.degraded) appendUniqueReason(reasons, 'partial_api_failure');
      }
    }
    const value: SourceFreshnessDegradationValue = {
      degraded: reasons.length > 0,
      reasons,
      last_seen_at,
      computed_at: now,
    };
    ctx.enrichmentStore.upsert({
      topic: SOURCE_FRESHNESS_DEGRADATION_TOPIC,
      derived_entity_id: source.id,
      value,
      authored_by: SOURCE_FRESHNESS_DEGRADATION_AUTHORED_BY,
      event_at: now,
    });
    freshIds.add(source.id);
    produced += 1;
  }

  const sweep = sweepStaleSourceFreshnessRows(ctx, freshIds);
  return { produced, swept: sweep.deleted };
};

// ────────────────────────────────────────────────────────────────
// Task instance
// ────────────────────────────────────────────────────────────────

export const sourceFreshnessDegradationTask: HousekeepingTaskInstance = {
  meta: {
    id: 'enrichment.source_freshness_degradation',
    description:
      'Per-Source health signal — disabled flag / missing connection / auth-failed / unreachable. Engine consumes for omission decisions.',
    interruptible: true,
    kind: 'enrichment',
    tags: computeHousekeepingMetaTags({
      def: ENRICHMENT_REGISTRY.source_freshness_degradation,
      isAiSurface: false,
    }),
  },
  topic: SOURCE_FRESHNESS_DEGRADATION_TOPIC,
  is_ai_surface: false,

  async step(
    ctx: HousekeepingContext,
    _cursor: HousekeepingCursor,
    _budget_ms: number,
  ): Promise<HousekeepingStepResult> {
    runSourceFreshnessDegradationCycle(ctx);
    return { status: 'complete', cursor: { kind: 'complete' } };
  },
};

/** Per-cycle token estimate for the Run-Now cost preview. Exposed
 *  separately from the task instance so the rpc handler that builds
 *  the preview can call it without instantiating a step. Always 0
 *  (deterministic). */
export const sourceFreshnessDegradationTokenEstimate = (): number =>
  SOURCE_FRESHNESS_DEGRADATION_TOKEN_ESTIMATE;

/** Scope-of-read declaration surfaced in the Run-Now scope dialog +
 *  detail drawer. Reflects the producer's actual reads — the Source
 *  registry table + the connections table for the connection-derived
 *  health probe + the four work-entity tables for the `last_seen_at`
 *  derivation + the file-source sync-state table for a file Source's
 *  freshness (D-192). Each entry's `sample_field_paths` lists the columns
 *  the producer actually consumes so the dialog can render an honest
 *  preview. */
export const sourceFreshnessDegradationScopeReadDeclaration = [
  {
    collection: 'source_registry',
    sample_field_paths: ['id', 'source_kind', 'enabled'],
  },
  {
    collection: 'connection',
    sample_field_paths: ['kind', 'name', 'health_json'],
  },
  {
    collection: 'data.task',
    sample_field_paths: ['source_id', 'last_seen_at', 'sync_state', 'deleted_at'],
  },
  {
    collection: 'data.note',
    sample_field_paths: ['source_id', 'last_seen_at', 'sync_state', 'deleted_at'],
  },
  {
    collection: 'data.commitment',
    sample_field_paths: ['source_id', 'last_seen_at', 'sync_state', 'deleted_at'],
  },
  {
    collection: 'data.project',
    sample_field_paths: ['source_id', 'last_seen_at', 'sync_state', 'deleted_at'],
  },
  {
    // D-192 — a file Source's recency + sync health (read for `top_tier_kind === 'file'`).
    collection: 'file_source_sync_state',
    sample_field_paths: ['source_id', 'last_success_at', 'degraded'],
  },
  {
    // D-205 #1 — the CONTACT twin. It was added to `SOURCE_SYNC_STATE_TABLE_BY_KIND`
    // (so the producer genuinely reads it) but never disclosed here — an UNDECLARED
    // read, found while building #2c. A read-scope declaration that under-reports is
    // worse than none: every consumer of it reasons from a table list that is a lie.
    collection: 'contact_source_sync_state',
    sample_field_paths: ['source_id', 'last_success_at', 'degraded'],
  },
] as const;
