/** D-145 PA9 — `project_stall_signal` enrichment producer.
 *
 *  Per-project signal flagging active projects whose effective last
 *  activity falls outside the stall window. Complements
 *  [[project_next_action_gap]] (structural: counts of open work) by
 *  carrying the temporal frame (recency of any work). The
 *  `stalled-projects` Personal Organizer Foundation pack recipe (spec
 *  § A.6.1 line 18: `last_activity_at > 14d`) consumes the `stalled`
 *  boolean; signals enumerate which source kinds have no activity
 *  within the same window — useful Layer-2 detail when the engine
 *  surfaces the project.
 *
 *  Eighth D-145 PA9 producer impl + second per-record producer on
 *  `walker_kind: 'project'` (after [[project_next_action_gap]]). Reuses
 *  the existing project walker + the cross-entity reader pattern over
 *  `ctx.db` (task / commitment / note timestamps). For each active
 *  focal project the producer:
 *
 *    1. Reads MAX(`updated_at`) for open + done tasks tied via
 *       `parent_project_id = ?` (the broad recency, not just open work).
 *    2. Reads MAX(`state_changed_at`) for commitments tied via
 *       `json_each(blocks_project_ids) = ?`.
 *    3. Reads MAX(`last_user_action_at`) for notes tied via
 *       `json_each(related_project_ids) = ?`.
 *
 *  Effective last activity is `MAX(project.last_activity_at, the three
 *  child MAXes)` — defensive against rollup drift. The producer is the
 *  authoritative recency lens; if the project row's rollup column has
 *  drifted (race / pre-tombstone delete / migration backfill), the
 *  child scan re-anchors. `stalled` flips when `now -
 *  effective_last_activity > 14d`.
 *
 *  Closed-list signal tokens emitted (one per source kind whose MAX is
 *  null or older than the cutoff):
 *    - `'no_recent_task_activity'`
 *    - `'no_recent_commitment_activity'`
 *    - `'no_recent_note_activity'`
 *
 *  Non-active projects (paused / completed / archived) return null —
 *  no row emitted. A paused project is intentionally dormant; an
 *  archived project is intentionally finished. Surfacing "stalled" on
 *  either would be noise in the `stalled-projects` recipe. Same
 *  precedent as [[project_next_action_gap]].
 *
 *  Window choice (14 days). Matches spec § A.6.1 line 18 +
 *  [[project_next_action_gap]]'s recent-note window so substrate signal
 *  + pack threshold + sibling producer all agree on the same horizon.
 *
 *  Sample-floor semantics. Declaration carries `sample_floor: 1` —
 *  every active project is evaluated. A project with no children at
 *  all + a fresh `last_activity_at` (e.g., just created) emits
 *  `stalled: false` + all three per-source signals — the empty-project
 *  case isn't itself a stall, but the per-source breakdown is faithful.
 *
 *  Cadence + invalidation. Housekeeping 24h (registry). Cascade fires
 *  on `data.project.updated` + `data.task.created` +
 *  `data.task.state_changed` + `data.note.created` +
 *  `data.commitment.state_changed` per declaration. The
 *  `aggregates_from = ['project', 'task', 'note', 'commitment']`
 *  registry entry keeps the cascade walker on all four scopes; the
 *  harness stale-sweep re-derives within the next eligible cycle.
 *
 *  Spec: `docs/d-145-spec.md` §§ A.6.1 (line 18 — pack semantics) +
 *        A.7.1 + A.7.5 +
 *        `ENRICHMENT_REGISTRY.project_stall_signal` +
 *        `packages/contracts/src/enrichment-declarations/project-stall-signal.ts`. */

import {
  computeProducerVersionHash,
  type Project,
  type ProjectStallSignalValue,
} from '@recued/contracts';

import type { HousekeepingContext } from '../registry.js';
import type { SourceRecord } from '../source-walkers.js';
import type { HousekeepingEnrichmentProducer } from '../enrichment-producer.js';
import {
  COMMITMENT_TABLE,
  NOTE_TABLE,
  TASK_TABLE,
} from '../../storage/work-entity-store.js';
import { getTunableNumber } from '../tunable-params-accessor.js';
import { canonicalizeEffectiveParams } from '../tunable-params-store.js';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

/** Default 14-day stall window. Matches spec § A.6.1 line 18
 *  (`stalled-projects` pack recipe) + sibling [[project_next_action_gap]]'s
 *  recent-note window. **Read at runtime from the user's tunable
 *  override** via `ctx.tunableParams.getNumber('project_stall_signal',
 *  'stall_window_days')` — the declaration's `tunable_params` field
 *  (§ A.7.8 Amended 2026-05-26) lets the user tune this to their
 *  industry cadence (SaaS ~7d, consulting ~30d, architecture ~365d).
 *  The exported constant is the declaration default in milliseconds
 *  for callers that pre-compute (tests, helper functions). */
export const PROJECT_STALL_SIGNAL_DEFAULT_WINDOW_DAYS = 14;
export const PROJECT_STALL_SIGNAL_WINDOW_MS =
  PROJECT_STALL_SIGNAL_DEFAULT_WINDOW_DAYS * 86_400_000;

/** Closed list of per-source stall-signal tokens. Consumers gate on
 *  these via string comparison; keep additions backward-compatible
 *  (recipes pin to known tokens). Order is the canonical emission
 *  order — task → commitment → note — matching the declaration's
 *  invalidation-trigger ordering. */
export const PROJECT_STALL_SIGNAL_TOKENS = [
  'no_recent_task_activity',
  'no_recent_commitment_activity',
  'no_recent_note_activity',
] as const;
export type ProjectStallSignalToken = (typeof PROJECT_STALL_SIGNAL_TOKENS)[number];

/** Pure SQL aggregation — zero token cost, idle-eligible. */
const TOKEN_ESTIMATE_PER_RECORD = 0;

/** Static base inputs for `computeProducerVersionHash`. Tunable params
 *  fold in dynamically per-cycle via `resolveProducerVersionHash`
 *  below — the harness invokes the callable form, the resolved hash
 *  flows through both the skip rule + the upserted row's
 *  `producer_version_hash` slot. Bumping any base field forces a
 *  refresh on every project; tuning `stall_window_days` forces a
 *  refresh on this producer only. */
const PRODUCER_VERSION_HASH_BASE = {
  producer_code_hash: 'project_stall_signal:1',
  model_id: '',
  prompt_template_hash: '',
  adapter_version: '',
  consumed_ingredients_versions: [],
} as const;

/** Resolve the producer-version hash for the current cycle. Reads the
 *  topic's effective tunable params via the typed accessor when ctx
 *  has one wired; falls back to declaration defaults via the helper
 *  otherwise (test scaffolds + first-boot before the store wires up).
 *
 *  D-145 § A.7.8 (Amended 2026-05-26): the dynamic hash is the
 *  invalidation primitive — when the user tunes `stall_window_days`
 *  via Settings → Housekeeping, the next cycle's hash differs from
 *  the persisted `data_enrichment` row's hash, the harness skip rule
 *  flips to "recompute," and the row re-derives with the new value. */
export const resolveProducerVersionHash = (
  ctx: Pick<HousekeepingContext, 'tunableParams'>,
): string => {
  const stall_window_days = getTunableNumber(
    ctx,
    'project_stall_signal',
    'stall_window_days',
  );
  const tunable_params_hash = canonicalizeEffectiveParams({
    stall_window_days: Number.isFinite(stall_window_days)
      ? stall_window_days
      : PROJECT_STALL_SIGNAL_DEFAULT_WINDOW_DAYS,
  });
  return computeProducerVersionHash({
    ...PRODUCER_VERSION_HASH_BASE,
    tunable_params_hash,
  });
};

// ────────────────────────────────────────────────────────────────
// SQL queries
// ────────────────────────────────────────────────────────────────

/** Latest `updated_at` across all tasks for one project (both open
 *  and done) — the broad task-recency lens. Uses
 *  `idx_task_project_done` for index-narrowed scan. Tombstoned +
 *  orphan rows excluded; pre-tombstone deletion races filtered via
 *  `deleted_at IS NULL`. Empty `project_id` short-circuits to null —
 *  defensive against malformed source records. Returns null when no
 *  matching task exists. */
export const maxTaskActivityForProject = (
  ctx: HousekeepingContext,
  project_id: string,
): number | null => {
  if (project_id === '') return null;
  const row = ctx.db
    .prepare(
      `SELECT MAX(updated_at) AS max_at FROM "${TASK_TABLE}"
         WHERE parent_project_id = ?
           AND sync_state IN ('live', 'stale_unreachable')
           AND deleted_at IS NULL`,
    )
    .get(project_id) as { max_at: number | null } | undefined;
  return row?.max_at ?? null;
};

/** Latest `state_changed_at` across commitments linked to one project
 *  via `blocks_project_ids`. The Commitment schema (§ A.1.3) stores
 *  the project relationship as a JSON array — `json_each`
 *  membership-tests efficiently without a join table. All lifecycle
 *  states count toward "activity" (pending state_changed fires on
 *  fulfillment / cancellation / expiry too — those are all real
 *  signal). Tombstoned + orphan rows excluded. Returns null when no
 *  matching commitment exists. */
export const maxCommitmentActivityForProject = (
  ctx: HousekeepingContext,
  project_id: string,
): number | null => {
  if (project_id === '') return null;
  const row = ctx.db
    .prepare(
      `SELECT MAX(state_changed_at) AS max_at FROM "${COMMITMENT_TABLE}"
         WHERE sync_state IN ('live', 'stale_unreachable')
           AND deleted_at IS NULL
           AND EXISTS (
             SELECT 1 FROM json_each(blocks_project_ids)
               WHERE json_each.value = ?
           )`,
    )
    .get(project_id) as { max_at: number | null } | undefined;
  return row?.max_at ?? null;
};

/** Latest `last_user_action_at` across notes linked to one project via
 *  `related_project_ids`. Uses the user-driven canonical-row timestamp
 *  (NOT the access ledger) so the query stays SQL-local; the ledger
 *  feeds [[note_relevance_decay]]'s separate decay math. Tombstoned +
 *  orphan rows excluded. Returns null when no matching note exists. */
export const maxNoteActivityForProject = (
  ctx: HousekeepingContext,
  project_id: string,
): number | null => {
  if (project_id === '') return null;
  const row = ctx.db
    .prepare(
      `SELECT MAX(last_user_action_at) AS max_at FROM "${NOTE_TABLE}"
         WHERE sync_state IN ('live', 'stale_unreachable')
           AND deleted_at IS NULL
           AND EXISTS (
             SELECT 1 FROM json_each(related_project_ids)
               WHERE json_each.value = ?
           )`,
    )
    .get(project_id) as { max_at: number | null } | undefined;
  return row?.max_at ?? null;
};

// ────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────

/** Compose the per-source stall-signal list from the three child-MAX
 *  timestamps. Pure function — exposed for direct unit testing. A
 *  signal fires when the MAX is null (no rows) OR older than the
 *  cutoff. Order matches `PROJECT_STALL_SIGNAL_TOKENS` declaration so
 *  the emitted array is deterministic across runs. */
export const composeStallSignals = (
  cutoff: number,
  max_task_at: number | null,
  max_commitment_at: number | null,
  max_note_at: number | null,
): ProjectStallSignalToken[] => {
  const signals: ProjectStallSignalToken[] = [];
  if (max_task_at === null || max_task_at < cutoff) {
    signals.push('no_recent_task_activity');
  }
  if (max_commitment_at === null || max_commitment_at < cutoff) {
    signals.push('no_recent_commitment_activity');
  }
  if (max_note_at === null || max_note_at < cutoff) {
    signals.push('no_recent_note_activity');
  }
  return signals;
};

/** Effective last-activity timestamp — the MAX across the project's
 *  rollup column and the three child MAXes. Defensive against rollup
 *  drift: if `project.last_activity_at` is stale (race / migration /
 *  pre-tombstone delete), the child scan re-anchors. Returns null
 *  when every source is null (genuinely empty project with no
 *  meaningful `last_activity_at`). */
export const effectiveLastActivity = (
  project_last_activity_at: number | null,
  max_task_at: number | null,
  max_commitment_at: number | null,
  max_note_at: number | null,
): number | null => {
  const candidates = [
    project_last_activity_at,
    max_task_at,
    max_commitment_at,
    max_note_at,
  ].filter((v): v is number => typeof v === 'number');
  if (candidates.length === 0) return null;
  return Math.max(...candidates);
};

// ────────────────────────────────────────────────────────────────
// Producer
// ────────────────────────────────────────────────────────────────

export const projectStallSignalProducer: HousekeepingEnrichmentProducer<Project> = {
  topic: 'project_stall_signal',
  source_scope: 'project',
  // D-145 § A.7.8 — dynamic producer_version_hash. Per-cycle resolution
  // folds tunable_params_hash into the composition; harness compares
  // against existing row's hash and re-derives when the user tunes
  // `stall_window_days`.
  producer_version_hash: resolveProducerVersionHash,
  scope_read_declaration: [
    { collection: 'data.project', sample_field_paths: ['id', 'state', 'last_activity_at'] },
    {
      collection: 'data.task',
      sample_field_paths: ['parent_project_id', 'updated_at'],
    },
    {
      collection: 'data.commitment',
      sample_field_paths: ['blocks_project_ids', 'state_changed_at'],
    },
    {
      collection: 'data.note',
      sample_field_paths: ['related_project_ids', 'last_user_action_at'],
    },
  ],
  estimate_per_record_tokens: () => TOKEN_ESTIMATE_PER_RECORD,
  recompute_cadence: '24h',

  async produce(ctx: HousekeepingContext, source_record: SourceRecord<Project>) {
    const project = source_record.data;
    if (!project.id) return null;
    // Non-active projects (paused / completed / archived) get no row.
    // Paused is intentionally dormant; archived is intentionally
    // finished. Emitting `stalled: true` on either would surface noise
    // in the `stalled-projects` recipe.
    if (project.state !== 'active') return null;

    const now = ctx.now();
    // D-145 § A.7.8 (Amended 2026-05-26) — user-tunable stall window.
    // Falls back to the declaration default (14d) when the user hasn't
    // overridden via Housekeeping settings. Read via the typed accessor
    // helper so the call site stays clean across test (ctx unwired) +
    // production (ctx wired) paths.
    const stall_window_days = getTunableNumber(
      ctx,
      'project_stall_signal',
      'stall_window_days',
    );
    const window_ms = Number.isFinite(stall_window_days)
      ? stall_window_days * 86_400_000
      : PROJECT_STALL_SIGNAL_WINDOW_MS;
    const cutoff = now - window_ms;

    const max_task_at = maxTaskActivityForProject(ctx, project.id);
    const max_commitment_at = maxCommitmentActivityForProject(ctx, project.id);
    const max_note_at = maxNoteActivityForProject(ctx, project.id);

    const last_activity_at = effectiveLastActivity(
      typeof project.last_activity_at === 'number' ? project.last_activity_at : null,
      max_task_at,
      max_commitment_at,
      max_note_at,
    );

    const signals = composeStallSignals(cutoff, max_task_at, max_commitment_at, max_note_at);
    const stalled = last_activity_at === null ? false : last_activity_at < cutoff;

    const value: ProjectStallSignalValue = {
      stalled,
      signals,
      last_activity_at,
      computed_at: now,
    };
    // D-145 § A.7.8 — thread the resolved producer_version_hash onto
    // the upserted row so the next cycle's skip rule (which compares
    // existing.producer_version_hash to the producer's current dynamic
    // hash) matches. Without this, the row would persist the legacy
    // hash and the next cycle would always recompute (correct but
    // wasteful).
    return {
      value,
      producer_version_hash: resolveProducerVersionHash(ctx),
    };
  },
};
