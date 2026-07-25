/** D-145 PA9 — `note_relevance_decay` enrichment producer.
 *
 *  Per-note recency-weighted relevance score, decaying over the 180-day
 *  rolling window. Walks `data_note` via the note source-walker (D-145
 *  PA9 novel walker pattern — first per-record producer on a work-entity
 *  scope). For each note the producer:
 *
 *    1. Reads the most recent user-driven entry from `note_access_ledger`
 *       (`access_kind IN ('user_open', 'user_edit')`).
 *    2. Falls back to `data_note.last_user_action_at` when the ledger
 *       has no user-driven entries (newly created notes never opened
 *       since insert — `last_user_action_at` is set at creation per
 *       § A.1.2 + `writeNote` line 1580).
 *    3. Computes `decay_score = max(0, 1 - elapsed / 180d)` — linear
 *       decay over the rolling window.
 *
 *  Why only user-driven access kinds? Spec § A.1.2 explicitly warns
 *  about the AI retrieval feedback loop: "AI surfaces a note → mutation
 *  → producer re-ranks → AI more likely to surface it again — runaway
 *  personalization". Counting `recipe_query` / `ai_packet_inclusion` /
 *  `mcp_read` as "freshness" would close that loop. The ledger records
 *  all five kinds so the audit trail survives, but the producer's math
 *  is user-only.
 *
 *  Why linear decay (not exponential)? Linear matches the registry's
 *  `aggregate_window_ms = 180 * 86_400_000` semantics: notes accessed
 *  inside the window contribute proportional freshness; notes outside
 *  → 0. Exponential would require picking a half-life that's not
 *  derivable from spec. Linear is the deterministic-first choice — the
 *  user-facing surface can re-shape the curve at the pack-recipe layer
 *  per § A.7.4 ("substrate emits signal; pack composes signal").
 *
 *  Why `last_access_at: number | null`? The value-schema permits null
 *  (registry:4296) so consumers can distinguish:
 *    - `null` → no user-driven ledger entries → score derived from
 *      bootstrap `last_user_action_at` (note exists but has never been
 *      opened by a user since creation).
 *    - `number` → user accessed it at this timestamp → score derived
 *      from this exact ledger row.
 *  Both paths yield a decay_score; the null variant preserves the
 *  "never accessed" signal for consumers that want to surface it
 *  distinctly.
 *
 *  Sample-floor semantics. Declaration carries `sample_floor: 1` —
 *  trivially met for every note (per-record producer). No abstention
 *  on floor. Notes with `decay_score = 0` still emit (the row
 *  communicates "this note is stale" — distinct from "never computed",
 *  which is row absence).
 *
 *  Cadence + invalidation. Housekeeping 7d (registry). Cascade fires
 *  on `data.note.created` + `data.note.accessed` per the declaration's
 *  `invalidation_triggers`. The `aggregates_from = ['note']` registry
 *  entry keeps the cascade walker on the canonical scope; the ledger
 *  is server-internal and doesn't cascade, but ledger writes flow into
 *  the producer next cycle via the staleness sweep + cascade hook on
 *  `data.note.accessed`.
 *
 *  Spec: D-145 §§ A.1.2 + A.7.1 + A.7.3 + A.7.5 +
 *        `ENRICHMENT_REGISTRY.note_relevance_decay` +
 *        `packages/contracts/src/enrichment-declarations/note-relevance-decay.ts`. */

import {
  type Note,
  type NoteRelevanceDecayValue,
} from '@recued/contracts';

import type { HousekeepingContext } from '../registry.js';
import type { SourceRecord } from '../source-walkers.js';
import type { HousekeepingEnrichmentProducer } from '../enrichment-producer.js';
import { NOTE_ACCESS_LEDGER_TABLE } from '../../storage/work-entity-store.js';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

/** 180-day rolling window — matches the registry's `aggregate_window_ms`
 *  + the declaration's `window: { kind: 'rolling_days', n: 180 }` so
 *  cascade invalidation, the value schema, and producer computation all
 *  agree on the same horizon. */
export const NOTE_RELEVANCE_DECAY_WINDOW_MS = 180 * 86_400_000;

/** User-driven access kinds — the only kinds counted toward freshness.
 *  Excludes `'recipe_query'`, `'ai_packet_inclusion'`, `'mcp_read'` to
 *  avoid the AI feedback loop spec § A.1.2 calls out. Keep this in
 *  sync with `NOTE_ACCESS_KINDS` in `packages/contracts/src/work-entities.ts`. */
export const NOTE_RELEVANCE_USER_ACCESS_KINDS = ['user_open', 'user_edit'] as const;

/** Pure SQL + arithmetic — zero token cost, idle-eligible. */
const TOKEN_ESTIMATE_PER_RECORD = 0;

// ────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────

/** Compute linear decay score from elapsed time since last access.
 *
 *  Algorithm:
 *    - elapsed ≤ 0  → 1.0 (just accessed, OR clock-skew defensive)
 *    - elapsed ≥ window_ms → 0.0 (window expired)
 *    - else → 1 - elapsed / window_ms
 *
 *  Non-finite inputs (NaN / Infinity) coerce to 0 defensively.
 *  Exposed for direct unit testing without round-tripping through SQL. */
export const computeNoteDecayScore = (
  last_access_at: number,
  now: number,
  window_ms: number = NOTE_RELEVANCE_DECAY_WINDOW_MS,
): number => {
  if (!Number.isFinite(last_access_at) || !Number.isFinite(now) || !Number.isFinite(window_ms)) {
    return 0;
  }
  if (window_ms <= 0) return 0;
  const elapsed = now - last_access_at;
  if (elapsed <= 0) return 1;
  if (elapsed >= window_ms) return 0;
  return 1 - elapsed / window_ms;
};

// ────────────────────────────────────────────────────────────────
// SQL query
// ────────────────────────────────────────────────────────────────

/** Pure query over the note access ledger for one note. Returns the
 *  MAX(accessed_at) across user-driven kinds only, or `null` when no
 *  matching entries exist. Uses the `idx_nal_note_time` index for the
 *  note_id narrow + `idx_nal_kind_time` for the kind filter; SQLite
 *  picks the better-selectivity index per query.
 *
 *  Empty `note_id` short-circuits to `null` — defensive against malformed
 *  source records (the walker filters tombstones but a hand-constructed
 *  test record with `id: ''` shouldn't trip a wildcard match). */
export const readLatestUserAccessForNote = (
  ctx: HousekeepingContext,
  note_id: string,
): number | null => {
  if (note_id === '') return null;
  const row = ctx.db
    .prepare(
      `SELECT MAX(accessed_at) AS max_at
         FROM "${NOTE_ACCESS_LEDGER_TABLE}"
         WHERE note_id = ?
           AND access_kind IN ('user_open', 'user_edit')`,
    )
    .get(note_id) as { max_at: number | null } | undefined;
  return row?.max_at ?? null;
};

// ────────────────────────────────────────────────────────────────
// Producer
// ────────────────────────────────────────────────────────────────

export const noteRelevanceDecayProducer: HousekeepingEnrichmentProducer<Note> = {
  topic: 'note_relevance_decay',
  source_scope: 'note',
  scope_read_declaration: [
    { collection: 'data.note', sample_field_paths: ['id', 'last_user_action_at'] },
    {
      collection: 'note_access_ledger',
      sample_field_paths: ['note_id', 'accessed_at', 'access_kind'],
    },
  ],
  estimate_per_record_tokens: () => TOKEN_ESTIMATE_PER_RECORD,
  recompute_cadence: '7d',

  async produce(ctx: HousekeepingContext, source_record: SourceRecord<Note>) {
    const note = source_record.data;
    if (!note.id) return null;
    const now = ctx.now();

    // Read most recent user-driven access from the ledger. Null when
    // the note has never been opened / edited by a user since creation.
    const ledger_max = readLatestUserAccessForNote(ctx, note.id);

    // Bootstrap: notes without ledger entries fall back to the
    // canonical row's `last_user_action_at` (always populated — set at
    // insert + bumped on explicit user actions per § A.1.2). Both
    // signals are valid "user touched this note" markers; whichever is
    // newer drives the score.
    const score_reference_at = Math.max(
      ledger_max ?? Number.NEGATIVE_INFINITY,
      note.last_user_action_at,
    );

    const decay_score = computeNoteDecayScore(score_reference_at, now);

    const value: NoteRelevanceDecayValue = {
      decay_score,
      last_access_at: ledger_max,
      computed_at: now,
    };
    return { value };
  },
};
