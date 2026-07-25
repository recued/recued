/** D-145 PA9 — `commitment_followthrough_score` enrichment producer.
 *
 *  Per-contact PSI-eligible score over inbound commitment terminal
 *  outcomes in the 90-day rolling window. The score is the fulfilled-
 *  vs-total ratio for commitments the counterparty made to me:
 *
 *      score = fulfilled / (fulfilled + cancelled + expired)
 *
 *  Direction filter is `'inbound'` only — outbound commitments are MY
 *  followthrough, not theirs. Internal direction is irrelevant
 *  (commitment to self). Lifecycle filter is the terminal triple per
 *  spec § A.1.3 line 285: `'fulfilled' | 'cancelled' | 'expired'`. Open
 *  (`'pending'`) commitments don't contribute to a followthrough score
 *  — the counterparty hasn't decided yet.
 *
 *  Window. 90 days on `state_changed_at` — when the terminal transition
 *  happened, not when the commitment was created. A commitment created
 *  six months ago but cancelled yesterday should count toward today's
 *  reliability picture; a commitment created two months ago that's
 *  still pending should NOT (no terminal signal yet).
 *
 *  Sample-floor. 30 terminal commitments in window per spec § A.7.5 PSI
 *  calibration baseline. Below floor → `produce()` returns null (no
 *  row); spec § A.7.5: "under floor → emit `coverage.sources_degraded:
 *  'sample_floor_unmet'` + abstain; never compute thin". The
 *  `commitment_reliability_band` consumer detects abstention and emits
 *  `'insufficient_data'` itself when source row missing — substrate
 *  stays small instead of every contact carrying a thin baseline.
 *
 *  Confidence (PSI-eligible). The value carries a per-row confidence
 *  scalar that D-133 drift detection iterates over. Linear in sample
 *  size up to a saturation cap:
 *
 *      confidence = clamp(sample_count / 100, 0, 1)
 *
 *  At sample_floor (30) → confidence ≈ 0.30; at the saturation cap
 *  (100 terminal commitments) → 1.00. The cap is exposed as
 *  `COMMITMENT_FOLLOWTHROUGH_SCORE_CONFIDENCE_SATURATION` so unit tests
 *  pin it + a future tunable_params lift (§ A.7.8) can adjust per
 *  industry (sales reps see hundreds of terminal commitments / quarter;
 *  individual contributors see dozens — saturation differs).
 *
 *  Event time. `event_at` on the produced row is MAX(`state_changed_at`)
 *  across the contributing rows so the bistemporal stamping reflects
 *  when the most recent terminal transition I observed actually happened
 *  (not when this producer cycle ran). Spec § A.7.5 event_time_field:
 *  `'commitment.state_changed_at'`.
 *
 *  Producer-version hash. Static base hash exposed as a constant. PSI
 *  drift detection (D-133) iterates the confidence distribution per
 *  producer-version; a bump here invalidates all rows + lets the drift
 *  signal pick up the new distribution. No tunable params yet — the
 *  saturation cap could lift to one later.
 *
 *  Cadence + invalidation. Housekeeping 24h. Cascade fires on
 *  `data.commitment.state_changed` + `data.commitment.created` per the
 *  declaration's `invalidation_triggers`. The work-entity due-status
 *  sweep already cascades commitment transitions to downstream PA9
 *  enrichment (see `work-entity-due-status-sweep.ts` line 367-377), so
 *  no separate reactive harness is required.
 *
 *  Spec: `docs/d-145-spec.md` §§ A.7.1 (line 738) + A.7.2 + A.7.3 +
 *        A.7.5 + A.7.6 + line 285 (lifecycle filter) +
 *        `ENRICHMENT_REGISTRY.commitment_followthrough_score` +
 *        `packages/contracts/src/enrichment-declarations/commitment-followthrough-score.ts`. */

import {
  computeProducerVersionHash,
  type ContactRecord,
  type PsiEligibleScoreValue,
} from '@recued/contracts';

import type { HousekeepingContext } from '../registry.js';
import type { SourceRecord } from '../source-walkers.js';
import type { HousekeepingEnrichmentProducer } from '../enrichment-producer.js';
import { COMMITMENT_TABLE } from '../../storage/work-entity-store.js';
import { contactAddresses, sqlInList } from './_contact-addresses.js';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

/** 90-day rolling window — matches the declaration's `window.n` so
 *  cascade invalidation + producer computation agree on the same
 *  horizon. */
export const COMMITMENT_FOLLOWTHROUGH_SCORE_WINDOW_MS = 90 * 86_400_000;

/** Minimum terminal commitments in window for the producer to emit.
 *  Matches declaration `sample_floor: 30` + the substrate-wide PSI
 *  calibration baseline (`PSI_SAMPLE_FLOOR_MINIMUM`). Below this the
 *  fulfilled-vs-total ratio is too noisy to trust + PSI drift
 *  detection needs ≥ 30-row baseline per bucket. */
export const COMMITMENT_FOLLOWTHROUGH_SCORE_SAMPLE_FLOOR = 30;

/** Sample size at which confidence saturates to 1.0. Linear ramp from
 *  sample_floor up. Exposed for unit testing + future tunable_params
 *  lift (industry / role cadence varies — sales reps see hundreds of
 *  terminal commitments / quarter, ICs see dozens). */
export const COMMITMENT_FOLLOWTHROUGH_SCORE_CONFIDENCE_SATURATION = 100;

/** Static base inputs for `computeProducerVersionHash`. PSI drift
 *  detection iterates the confidence distribution per
 *  producer-version; bumping `producer_code_hash` invalidates every
 *  existing row + lets D-133 pick up the new distribution as a
 *  potential drift signal. Bump on every meaningful behaviour change
 *  (filter shift, window-size change, score formula tweak). */
const PRODUCER_VERSION_HASH_BASE = {
  producer_code_hash: 'commitment_followthrough_score:1',
  model_id: '',
  prompt_template_hash: '',
  adapter_version: '',
  consumed_ingredients_versions: [],
} as const;

/** Cached at module load — pure function over a closed set of inputs. */
export const COMMITMENT_FOLLOWTHROUGH_SCORE_PRODUCER_VERSION_HASH =
  computeProducerVersionHash(PRODUCER_VERSION_HASH_BASE);

/** Pure SQL aggregation — zero token cost, idle-eligible. */
const TOKEN_ESTIMATE_PER_RECORD = 0;

// ────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────

/** Convert a `(sample_count)` into a per-row confidence value the PSI
 *  drift detector iterates. Linear in sample size up to a saturation
 *  cap. Pure — exposed for direct unit testing. Defensive: non-finite
 *  or negative sample counts return 0. */
export const computeFollowthroughConfidence = (
  sample_count: number,
  saturation: number = COMMITMENT_FOLLOWTHROUGH_SCORE_CONFIDENCE_SATURATION,
): number => {
  if (!Number.isFinite(sample_count) || sample_count <= 0) return 0;
  if (!Number.isFinite(saturation) || saturation <= 0) return 0;
  const ratio = sample_count / saturation;
  return ratio >= 1 ? 1 : ratio;
};

// ────────────────────────────────────────────────────────────────
// SQL query
// ────────────────────────────────────────────────────────────────

export interface FollowthroughTerminalCounts {
  /** Count of `lifecycle_state = 'fulfilled'` rows in window. */
  fulfilled_count: number;
  /** Total terminal rows in window (fulfilled + cancelled + expired). */
  terminal_count: number;
  /** MAX(`state_changed_at`) across the contributing rows. NULL when
   *  no rows contribute (caller short-circuits before reading). */
  latest_terminal_at: number | null;
}

const ZERO_TERMINAL_COUNTS: FollowthroughTerminalCounts = {
  fulfilled_count: 0,
  terminal_count: 0,
  latest_terminal_at: null,
};

/** Query the commitment table for one contact's terminal inbound
 *  commitments in the rolling window. Uses
 *  `idx_commitment_counterparty_lifecycle` to narrow on counterparty +
 *  lifecycle. Tombstones (deleted_at IS NOT NULL or sync_state
 *  'tombstoned') excluded.
 *
 *  🔑 **D-205 #3.5 — reads across the MERGE GROUP.** `counterparty_contact_id`
 *  holds an email, and a merge leaves each commitment keyed on whichever
 *  address it was written under (a merge records an edge; it never moves rows).
 *  Asking for the survivor's address alone would score the person on only the
 *  commitments that happened to land on it — a confident ratio over a fraction
 *  of the evidence. The address set is `[the address]` until the user merges
 *  someone, so this is behavior-identical at zero merges. */
export const countTerminalCommitmentsForContact = (
  ctx: HousekeepingContext,
  contact_email: string,
  since: number,
): FollowthroughTerminalCounts => {
  if (contact_email === '') return ZERO_TERMINAL_COUNTS;
  const addresses = contactAddresses(ctx, contact_email);
  if (addresses.length === 0) return ZERO_TERMINAL_COUNTS;
  const row = ctx.db
    .prepare(
      `SELECT
          SUM(CASE WHEN lifecycle_state = 'fulfilled' THEN 1 ELSE 0 END) AS fulfilled_count,
          COUNT(*) AS terminal_count,
          MAX(state_changed_at) AS latest_terminal_at
        FROM "${COMMITMENT_TABLE}"
        WHERE counterparty_contact_id IN (${sqlInList(addresses.length)})
          AND direction = 'inbound'
          AND lifecycle_state IN ('fulfilled', 'cancelled', 'expired')
          AND state_changed_at >= ?
          AND sync_state IN ('live', 'stale_unreachable')
          AND deleted_at IS NULL`,
    )
    .get(...addresses, since) as
    | {
        fulfilled_count: number | null;
        terminal_count: number | null;
        latest_terminal_at: number | null;
      }
    | undefined;
  if (!row) return ZERO_TERMINAL_COUNTS;
  return {
    fulfilled_count: row.fulfilled_count ?? 0,
    terminal_count: row.terminal_count ?? 0,
    latest_terminal_at: row.latest_terminal_at,
  };
};

// ────────────────────────────────────────────────────────────────
// Producer
// ────────────────────────────────────────────────────────────────

export const commitmentFollowthroughScoreProducer: HousekeepingEnrichmentProducer<ContactRecord> = {
  topic: 'commitment_followthrough_score',
  source_scope: 'contact',
  producer_version_hash: COMMITMENT_FOLLOWTHROUGH_SCORE_PRODUCER_VERSION_HASH,
  scope_read_declaration: [
    // `merged_into` is declared because the counterparty query below reads the
    // merge graph to widen itself across the contact's absorbed addresses
    // (D-205 #3.5). A read-scope disclosure that under-reports is one its
    // consumers trust and that lies.
    { collection: 'data.contact', sample_field_paths: ['email', 'merged_into'] },
    {
      collection: 'data.commitment',
      sample_field_paths: [
        'counterparty_contact_id',
        'direction',
        'lifecycle_state',
        'state_changed_at',
      ],
    },
  ],
  estimate_per_record_tokens: () => TOKEN_ESTIMATE_PER_RECORD,
  recompute_cadence: '24h',

  async produce(ctx: HousekeepingContext, source_record: SourceRecord<ContactRecord>) {
    const email = source_record.data.email;
    if (!email) return null;
    const now = ctx.now();
    const since = now - COMMITMENT_FOLLOWTHROUGH_SCORE_WINDOW_MS;

    const { fulfilled_count, terminal_count, latest_terminal_at } =
      countTerminalCommitmentsForContact(ctx, email, since);

    if (terminal_count < COMMITMENT_FOLLOWTHROUGH_SCORE_SAMPLE_FLOOR) {
      // Below PSI calibration baseline — abstain rather than emit a
      // thin score. Per spec § A.7.5: "under floor → emit
      // `coverage.sources_degraded: 'sample_floor_unmet'` + abstain;
      // never compute thin". The band consumer detects abstention
      // and emits `'insufficient_data'` itself.
      return null;
    }

    const score = fulfilled_count / terminal_count;
    const confidence = computeFollowthroughConfidence(terminal_count);

    const value: PsiEligibleScoreValue = {
      score,
      sample_count: terminal_count,
      confidence,
      computed_at: now,
    };
    const output: { value: PsiEligibleScoreValue; event_at?: number } = { value };
    if (latest_terminal_at !== null && Number.isFinite(latest_terminal_at)) {
      output.event_at = latest_terminal_at;
    }
    return output;
  },
};
