/** D-145 PA9 — `commitment_imbalance` enrichment producer.
 *
 *  Per-relationship signal of inbound-vs-outbound commitment skew over
 *  the 90-day rolling window. Walks the contact warehouse; for each
 *  contact the producer counts non-tombstoned commitments grouped by
 *  direction whose `created_at` falls inside `[now-90d, now)`:
 *
 *      inbound : direction='inbound'  AND counterparty_contact_id=<email>
 *      outbound: direction='outbound' AND counterparty_contact_id=<email>
 *
 *  Per spec § A.1.3 line 285: "`commitment_imbalance` filters
 *  per-direction with both axes considered" — both `lifecycle_state`
 *  and `due_status` are passed through; the imbalance signal measures
 *  *volume* of commitments per direction, not narrowed-on-state. A
 *  cancelled inbound and a fulfilled inbound both contribute to the
 *  inbound count because both represent a promise the counterparty
 *  made, regardless of whether it ultimately completed.
 *
 *  Internal direction (`direction='internal'`) is excluded — internal
 *  commitments are "I owe myself" and don't speak to a relationship's
 *  one-sidedness.
 *
 *  Decision math mirrors D-139's `inbound_outbound_ratio` precedent
 *  (registry:2720): `inbound > 1.5 × outbound` → `'inbound_heavy'`;
 *  `outbound > 1.5 × inbound` → `'outbound_heavy'`; otherwise
 *  `'aligned'`.
 *
 *  Sample-floor semantics. Spec § A.7.5 + declaration's
 *  `sample_floor: 5`. The producer differentiates two below-signal
 *  paths:
 *
 *    - `total = 0`: zero commitments to/from this contact in window
 *      → `produce()` returns `null` (no row). The contact has no
 *      cross-party commitment signal worth recording at all.
 *    - `0 < total < 5`: some commitments but below floor → emit
 *      `{inbound_count, outbound_count, imbalance_signal:
 *      'insufficient_data', computed_at}`. Consumers see "computed,
 *      tracking, can't decide yet" distinct from "never computed"
 *      (row absent).
 *
 *  This matches the closed-list signal `'insufficient_data'` in
 *  `CommitmentImbalanceSignal` — the deterministic analog of the
 *  "low confidence" path PSI-eligible producers emit. The producer
 *  side `source_degradation_reasons: ['sample_floor_unmet']` covers
 *  the second path.
 *
 *  Cadence + invalidation. Housekeeping 24h. The work-entity
 *  due-status sweep (`work-entity-due-status-sweep.ts`) cascades
 *  invalidation on commitment state transitions, marking this topic's
 *  rows stale; harness stale-sweep re-runs `produce()` against the
 *  affected contact within one cycle. Direct `commitment.created`
 *  events also cascade per the declaration's
 *  `invalidation_triggers`.
 *
 *  Spec: `docs/d-145-spec.md` §§ A.7.1 + A.7.3 + A.7.5 + line 285 +
 *        `ENRICHMENT_REGISTRY.commitment_imbalance` +
 *        `packages/contracts/src/enrichment-declarations/commitment-imbalance.ts`. */

import {
  type CommitmentImbalanceSignal,
  type CommitmentImbalanceValue,
  type ContactRecord,
} from '@recued/contracts';

import type { HousekeepingContext } from '../registry.js';
import type { SourceRecord } from '../source-walkers.js';
import type { HousekeepingEnrichmentProducer } from '../enrichment-producer.js';
import { COMMITMENT_TABLE } from '../../storage/work-entity-store.js';
import { contactAddresses, sqlInList } from './_contact-addresses.js';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

/** 90-day rolling window — matches the registry's `aggregate_window_ms`
 *  so cascade invalidation + producer computation agree on the same
 *  horizon. */
export const COMMITMENT_IMBALANCE_WINDOW_MS = 90 * 86_400_000;

/** Combined inbound+outbound sample floor. Below this the decision
 *  math is unstable — 0/3 and 3/0 both look "lopsided" but the sample
 *  is too small to commit to a band. Matches the declaration's
 *  `sample_floor: 5`. */
export const COMMITMENT_IMBALANCE_SAMPLE_FLOOR = 5;

/** Dominant-direction ratio threshold. Mirrors D-139's
 *  `inbound_outbound_ratio` decision math (registry:2720) — the same
 *  1.5× factor distinguishes a real imbalance from noise inside the
 *  3:2-ish "approximately aligned" band. Strictly greater so a clean
 *  3:2 split stays `'aligned'`. */
export const COMMITMENT_IMBALANCE_DOMINANT_RATIO = 1.5;

/** Pure SQL aggregation — zero token cost, idle-eligible. */
const TOKEN_ESTIMATE_PER_RECORD = 0;

// ────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────

/** Decide the imbalance signal from a per-contact inbound/outbound
 *  count pair. Exposed for direct unit testing without round-tripping
 *  through the SQL plumbing.
 *
 *  Algorithm:
 *    - Sum to total. Below `sample_floor` → `'insufficient_data'`.
 *    - `inbound > ratio × outbound` → `'inbound_heavy'`.
 *    - `outbound > ratio × inbound` → `'outbound_heavy'`.
 *    - Otherwise → `'aligned'`.
 *
 *  Edge cases:
 *    - One side zero with the other above floor → the non-zero side's
 *      `<dir>_heavy` (the zero side fails the ratio comparison
 *      trivially).
 *    - Both sides equal → `'aligned'` (`x > 1.5×x` is false for
 *      positive x).
 *    - Negative / non-finite counts coerced to 0 defensively. */
export const decideCommitmentImbalanceSignal = (
  inbound_count: number,
  outbound_count: number,
  sample_floor: number = COMMITMENT_IMBALANCE_SAMPLE_FLOOR,
  ratio: number = COMMITMENT_IMBALANCE_DOMINANT_RATIO,
): CommitmentImbalanceSignal => {
  const inbound = Number.isFinite(inbound_count) && inbound_count > 0 ? inbound_count : 0;
  const outbound = Number.isFinite(outbound_count) && outbound_count > 0 ? outbound_count : 0;
  const total = inbound + outbound;
  if (total < sample_floor) return 'insufficient_data';
  if (inbound > ratio * outbound) return 'inbound_heavy';
  if (outbound > ratio * inbound) return 'outbound_heavy';
  return 'aligned';
};

// ────────────────────────────────────────────────────────────────
// SQL query
// ────────────────────────────────────────────────────────────────

export interface CommitmentDirectionCounts {
  inbound_count: number;
  outbound_count: number;
}

/** Pure query over the commitment table for one contact across the
 *  rolling window. Internal direction is filtered out; tombstones are
 *  excluded; both lifecycle_state and due_status pass through unfiltered
 *  per spec line 285. Uses `idx_commitment_counterparty_lifecycle`
 *  to narrow on counterparty before the in-row direction + created_at
 *  filters. */
export const countCommitmentsByDirectionForContact = (
  ctx: HousekeepingContext,
  contact_email: string,
  since: number,
  now: number,
): CommitmentDirectionCounts => {
  if (contact_email === '') {
    return { inbound_count: 0, outbound_count: 0 };
  }
  // D-205 #3.5 — across the merge group. An imbalance is a RATIO, so a merge
  // that hides one direction's commitments behind an absorbed address does not
  // merely shrink the sample: it skews the verdict.
  const addresses = contactAddresses(ctx, contact_email);
  if (addresses.length === 0) {
    return { inbound_count: 0, outbound_count: 0 };
  }
  const row = ctx.db
    .prepare(
      `SELECT
          SUM(CASE WHEN direction = 'inbound'  THEN 1 ELSE 0 END) AS inbound_count,
          SUM(CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END) AS outbound_count
        FROM "${COMMITMENT_TABLE}"
        WHERE counterparty_contact_id IN (${sqlInList(addresses.length)})
          AND direction IN ('inbound', 'outbound')
          AND created_at >= ?
          AND created_at < ?
          AND deleted_at IS NULL`,
    )
    .get(...addresses, since, now) as
    | { inbound_count: number | null; outbound_count: number | null }
    | undefined;
  if (!row) {
    return { inbound_count: 0, outbound_count: 0 };
  }
  return {
    inbound_count: row.inbound_count ?? 0,
    outbound_count: row.outbound_count ?? 0,
  };
};

// ────────────────────────────────────────────────────────────────
// Producer
// ────────────────────────────────────────────────────────────────

export const commitmentImbalanceProducer: HousekeepingEnrichmentProducer<ContactRecord> = {
  topic: 'commitment_imbalance',
  source_scope: 'contact',
  scope_read_declaration: [
    // `merged_into`: the counterparty query reads the merge graph to widen
    // itself across the contact's absorbed addresses (D-205 #3.5).
    { collection: 'data.contact', sample_field_paths: ['email', 'merged_into'] },
    {
      collection: 'data.commitment',
      sample_field_paths: [
        'direction',
        'counterparty_contact_id',
        'created_at',
      ],
    },
  ],
  estimate_per_record_tokens: () => TOKEN_ESTIMATE_PER_RECORD,
  recompute_cadence: '24h',

  async produce(ctx: HousekeepingContext, source_record: SourceRecord<ContactRecord>) {
    const email = source_record.data.email;
    if (!email) return null;
    const now = ctx.now();
    const since = now - COMMITMENT_IMBALANCE_WINDOW_MS;

    const { inbound_count, outbound_count } = countCommitmentsByDirectionForContact(
      ctx,
      email,
      since,
      now,
    );

    if (inbound_count + outbound_count === 0) {
      // No cross-party commitments to/from this contact in the
      // 90-day window. Nothing to record. Distinct from the
      // below-floor path which emits `'insufficient_data'`.
      return null;
    }

    const imbalance_signal = decideCommitmentImbalanceSignal(
      inbound_count,
      outbound_count,
    );

    const value: CommitmentImbalanceValue = {
      inbound_count,
      outbound_count,
      imbalance_signal,
      computed_at: now,
    };
    return { value };
  },
};
