/** D-145 PA9 — `commitment_reliability_band` enrichment producer.
 *
 *  Per-contact band over `commitment_followthrough_score`. The source is
 *  PSI-eligible (raw 0..1 confidence) — bands convert that raw float into
 *  a closed-list reliability tag (`insufficient_data | reliable | mixed
 *  | risky`) that's safe to expose in user-facing surfaces (avoids
 *  showing arbitrary 0-1 floats) while preserving the underlying score
 *  in `source_score` for downstream consumers that want the number.
 *
 *  Source read. Per spec § A.7.3 + registry `consumes_topics:
 *  ['commitment_followthrough_score']`, the producer reads the freshest
 *  `commitment_followthrough_score` enrichment row for the contact via
 *  `ctx.enrichmentStore.list`. The cascade engine invalidates this
 *  band row whenever the source row changes (`data.enrichment
 *  .commitment_followthrough_score.updated` per the declaration's
 *  `invalidation_triggers`); the harness re-runs `produce()` against the
 *  affected contact within one cycle.
 *
 *  Band thresholds (closed list, validator-gated by `COMMITMENT_-
 *  RELIABILITY_BANDS`):
 *
 *    - `reliable`         — `score ≥ RELIABLE_THRESHOLD` (default 0.80)
 *                           Mostly follows through; safe to lean on.
 *    - `mixed`            — `MIXED_THRESHOLD ≤ score < RELIABLE_THRESHOLD`
 *                           (default 0.50)
 *                           More followed-through than not but
 *                           inconsistent — confirm before relying on.
 *    - `risky`            — `score < MIXED_THRESHOLD`
 *                           More broken than kept; flag explicitly.
 *    - `insufficient_data` — source row missing OR
 *                            `sample_count < sample_floor` (default 30
 *                            per spec § A.7.5 PSI calibration baseline).
 *
 *  Sample-floor semantics. Two below-floor paths:
 *
 *    - Source row missing: contact has no `commitment_followthrough_score`
 *      row at all. `produce()` returns `null` (no band row). Distinct
 *      from the "tracked but unstable" path — keeps the warehouse small
 *      (every paired contact would otherwise emit an `insufficient_data`
 *      row). Matches `commitment_imbalance`'s zero-sample abstention.
 *    - Source row present + `sample_count < sample_floor`: emit
 *      `{band: 'insufficient_data', source_score: <score>, computed_at}`.
 *      Consumers see "computed, tracking, can't decide yet" distinct
 *      from "never computed" (row absent). `source_score` carries the
 *      raw value so downstream callers can re-decide with different
 *      thresholds.
 *
 *  Threshold rationale. The 0.80 / 0.50 split mirrors common reliability-
 *  ranking literature: ≥ 80% follow-through reads as dependable; 50-80%
 *  reads as inconsistent; < 50% means breaks-more-than-keeps. Exposed as
 *  constants so unit tests pin them + a future tunable_params lift (§
 *  A.7.8) can adjust per user. Strict inequality at the high end so a
 *  clean 0.80 lands in `reliable`, not `mixed`; ditto for the 0.50
 *  boundary (clean 0.50 lands in `mixed`).
 *
 *  Cadence + invalidation. Housekeeping 24h. Cascade fires on
 *  `data.enrichment.commitment_followthrough_score.updated` per the
 *  declaration's `invalidation_triggers`. Pure SQL + arithmetic — zero
 *  token cost, idle-eligible.
 *
 *  Spec: `docs/d-145-spec.md` §§ A.7.1 (line 754) + A.7.2 + A.7.3 +
 *        A.7.5 + A.7.6 #2 +
 *        `ENRICHMENT_REGISTRY.commitment_reliability_band` +
 *        `packages/contracts/src/enrichment-declarations/commitment-reliability-band.ts`. */

import {
  type CommitmentReliabilityBand,
  type CommitmentReliabilityBandValue,
  type ContactRecord,
} from '@recued/contracts';

import type { HousekeepingContext } from '../registry.js';
import type { SourceRecord } from '../source-walkers.js';
import type { HousekeepingEnrichmentProducer } from '../enrichment-producer.js';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

/** Score at or above which the contact lands in `'reliable'`. Strict
 *  greater-than-or-equal so a clean 0.80 reads as reliable, not mixed. */
export const COMMITMENT_RELIABILITY_BAND_RELIABLE_THRESHOLD = 0.8;

/** Score at or above which the contact lands in `'mixed'` (when below
 *  the reliable threshold). Below this lands in `'risky'`. Strict
 *  greater-than-or-equal so a clean 0.50 reads as mixed, not risky. */
export const COMMITMENT_RELIABILITY_BAND_MIXED_THRESHOLD = 0.5;

/** PSI calibration baseline (matches the declaration's `sample_floor`
 *  + `commitment_followthrough_score`'s sample_floor — bands shouldn't
 *  fire on a sample size the source itself wouldn't trust). */
export const COMMITMENT_RELIABILITY_BAND_SAMPLE_FLOOR = 30;

/** Pure enrichment-store read + threshold math — zero token cost,
 *  idle-eligible. */
const TOKEN_ESTIMATE_PER_RECORD = 0;

// ────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────

/** Convert a `commitment_followthrough_score` score into a closed-list
 *  band. Pure function — exposed for direct unit testing without
 *  round-tripping through the enrichment-store read.
 *
 *  Algorithm:
 *    - `sample_count < sample_floor` → `'insufficient_data'`.
 *    - non-finite score → `'insufficient_data'` (defensive).
 *    - `score ≥ reliable_threshold` → `'reliable'`.
 *    - `score ≥ mixed_threshold` → `'mixed'`.
 *    - Otherwise → `'risky'`. */
export const decideCommitmentReliabilityBand = (
  score: number,
  sample_count: number,
  sample_floor: number = COMMITMENT_RELIABILITY_BAND_SAMPLE_FLOOR,
  reliable_threshold: number = COMMITMENT_RELIABILITY_BAND_RELIABLE_THRESHOLD,
  mixed_threshold: number = COMMITMENT_RELIABILITY_BAND_MIXED_THRESHOLD,
): CommitmentReliabilityBand => {
  if (!Number.isFinite(sample_count) || sample_count < sample_floor) return 'insufficient_data';
  if (!Number.isFinite(score)) return 'insufficient_data';
  if (score >= reliable_threshold) return 'reliable';
  if (score >= mixed_threshold) return 'mixed';
  return 'risky';
};

// ────────────────────────────────────────────────────────────────
// Source-row read
// ────────────────────────────────────────────────────────────────

export interface FollowthroughScoreRead {
  /** 0..1 normalized score from `PsiEligibleScoreValue.score`. */
  score: number;
  /** Number of commitments in the rolling window that contributed
   *  (`PsiEligibleScoreValue.sample_count`). */
  sample_count: number;
}

/** Read the freshest `commitment_followthrough_score` enrichment row
 *  for the contact. Returns `null` when no row exists; returns the
 *  numeric fields when present. Defensive: non-finite values surface as
 *  null so the producer abstains rather than emit a fabricated band. */
export const readFollowthroughScoreForContact = (
  ctx: HousekeepingContext,
  contact_email: string,
): FollowthroughScoreRead | null => {
  if (contact_email === '') return null;
  const rows = ctx.enrichmentStore.list({
    topic: 'commitment_followthrough_score',
    scope: 'contact',
    target_id: contact_email,
    limit: 1,
  });
  if (rows.length === 0) return null;
  const v = rows[0]!.value as Record<string, unknown>;
  const score = typeof v.score === 'number' && Number.isFinite(v.score) ? v.score : null;
  const sample_count =
    typeof v.sample_count === 'number' && Number.isFinite(v.sample_count) ? v.sample_count : null;
  if (score === null || sample_count === null) return null;
  return { score, sample_count };
};

// ────────────────────────────────────────────────────────────────
// Producer
// ────────────────────────────────────────────────────────────────

export const commitmentReliabilityBandProducer: HousekeepingEnrichmentProducer<ContactRecord> = {
  topic: 'commitment_reliability_band',
  source_scope: 'contact',
  scope_read_declaration: [
    { collection: 'data.contact', sample_field_paths: ['email'] },
    {
      collection: 'data.enrichment.commitment_followthrough_score',
      sample_field_paths: ['score', 'sample_count'],
    },
  ],
  estimate_per_record_tokens: () => TOKEN_ESTIMATE_PER_RECORD,
  recompute_cadence: '24h',

  async produce(ctx: HousekeepingContext, source_record: SourceRecord<ContactRecord>) {
    const email = source_record.data.email;
    if (!email) return null;

    const source = readFollowthroughScoreForContact(ctx, email);
    if (source === null) {
      // No followthrough row for this contact yet. Distinct from the
      // below-floor path which emits `'insufficient_data'` — keeps the
      // warehouse small (every paired contact would otherwise carry an
      // `insufficient_data` band row).
      return null;
    }

    const band = decideCommitmentReliabilityBand(source.score, source.sample_count);
    const value: CommitmentReliabilityBandValue = {
      band,
      source_score: source.score,
      computed_at: ctx.now(),
    };
    return { value };
  },
};
