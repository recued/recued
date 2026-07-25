/** D-145 PA9 — `outbound_commitment_overdue_count` enrichment producer.
 *
 *  Per-contact snapshot of overdue outbound commitments to this
 *  counterparty. Walks the contact warehouse; for each contact the
 *  producer queries `data_commitment` for rows where
 *
 *      direction              = 'outbound'
 *      lifecycle_state        = 'pending'      (terminal lifecycles excluded)
 *      due_status             = 'overdue'
 *      counterparty_contact_id = <contact.email>
 *      deleted_at             IS NULL          (tombstones excluded)
 *
 *  and emits `{ count, oldest_overdue_at, computed_at }`.
 *  `oldest_overdue_at` is `min(promised_for_at)` of the matching rows
 *  (NULL only when count is zero).
 *
 *  Sample-floor semantics. Spec § A.7.1 + A.7.5 — `sample_floor: 1`.
 *  The sample here is "outbound pending commitments to this contact"
 *  (not "overdue rows"): a contact with at least one open outbound
 *  promise gets a row even when nothing is overdue yet, so the engine
 *  + alert recipes see the explicit `count: 0` signal distinct from
 *  "we haven't computed yet" (row absent). Contacts with zero open
 *  outbound commitments fall below the floor — `produce()` returns
 *  `null` and the harness leaves no row.
 *
 *  Spec § A.7.1 frames this as "per-pair (boss-level)"; the
 *  implementation slice ships per-contact rows so engine + alert
 *  recipes can surface per-counterparty growth. Global rollup is a
 *  derived aggregation off the per-contact set, not a separate
 *  producer.
 *
 *  Cadence + invalidation. Housekeeping 24h. The work-entity
 *  due-status sweep (`work-entity-due-status-sweep.ts`) calls
 *  `cascadeForSourceUpdate('commitment', ...)` on every state +
 *  due-status transition, which marks this topic's rows stale; the
 *  harness's stale-sweep re-runs `produce()` against the affected
 *  contact on the next cycle. No reactive harness needed.
 *
 *  Spec: D-145 §§ A.7.1 + A.7.3 + A.7.5 +
 *        `ENRICHMENT_REGISTRY.outbound_commitment_overdue_count` +
 *        `packages/contracts/src/enrichment-declarations/outbound-commitment-overdue-count.ts`. */

import {
  type ContactRecord,
  type OutboundCommitmentOverdueCountValue,
} from '@recued/contracts';

import type { HousekeepingContext } from '../registry.js';
import type { SourceRecord } from '../source-walkers.js';
import type { HousekeepingEnrichmentProducer } from '../enrichment-producer.js';
import { COMMITMENT_TABLE } from '../../storage/work-entity-store.js';
import { contactAddresses, sqlInList } from './_contact-addresses.js';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

/** Pure SQL aggregation — zero token cost, idle-eligible. */
const TOKEN_ESTIMATE_PER_RECORD = 0;

// ────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────

export interface CommitmentCountRow {
  /** Total outbound pending commitments to this contact (sample). */
  outbound_pending_count: number;
  /** Subset that are also `due_status = 'overdue'`. */
  overdue_count: number;
  /** `min(promised_for_at)` over overdue rows; `null` when none. */
  oldest_overdue_at: number | null;
}

/** Pure query over the commitment table for one contact. Exposed for
 *  direct unit testing without round-tripping through the harness.
 *  Uses `idx_commitment_counterparty_lifecycle` (counterparty + lifecycle)
 *  to narrow before the in-row direction + due_status filters. */
export const countOutboundCommitmentsForContact = (
  ctx: HousekeepingContext,
  contact_email: string,
): CommitmentCountRow => {
  if (contact_email === '') {
    return { outbound_pending_count: 0, overdue_count: 0, oldest_overdue_at: null };
  }
  // D-205 #3.5 — across the merge group. This one counts what *I* owe *them*:
  // a promise made to an address they later merged away from is still a promise
  // I owe, and it must not drop out of the count the day the contacts merge.
  const addresses = contactAddresses(ctx, contact_email);
  if (addresses.length === 0) {
    return { outbound_pending_count: 0, overdue_count: 0, oldest_overdue_at: null };
  }
  const row = ctx.db
    .prepare(
      `SELECT
          COUNT(*) AS outbound_pending_count,
          SUM(CASE WHEN due_status = 'overdue' THEN 1 ELSE 0 END) AS overdue_count,
          MIN(CASE WHEN due_status = 'overdue' THEN promised_for_at ELSE NULL END) AS oldest_overdue_at
        FROM "${COMMITMENT_TABLE}"
        WHERE counterparty_contact_id IN (${sqlInList(addresses.length)})
          AND direction = 'outbound'
          AND lifecycle_state = 'pending'
          AND deleted_at IS NULL`,
    )
    .get(...addresses) as
    | {
        outbound_pending_count: number | null;
        overdue_count: number | null;
        oldest_overdue_at: number | null;
      }
    | undefined;
  if (!row) {
    return { outbound_pending_count: 0, overdue_count: 0, oldest_overdue_at: null };
  }
  return {
    outbound_pending_count: row.outbound_pending_count ?? 0,
    overdue_count: row.overdue_count ?? 0,
    oldest_overdue_at: row.oldest_overdue_at,
  };
};

// ────────────────────────────────────────────────────────────────
// Producer
// ────────────────────────────────────────────────────────────────

export const outboundCommitmentOverdueCountProducer: HousekeepingEnrichmentProducer<ContactRecord> = {
  topic: 'outbound_commitment_overdue_count',
  source_scope: 'contact',
  scope_read_declaration: [
    // `merged_into`: the counterparty query reads the merge graph to widen
    // itself across the contact's absorbed addresses (D-205 #3.5).
    { collection: 'data.contact', sample_field_paths: ['email', 'merged_into'] },
    {
      collection: 'data.commitment',
      sample_field_paths: [
        'direction',
        'lifecycle_state',
        'due_status',
        'counterparty_contact_id',
        'promised_for_at',
      ],
    },
  ],
  estimate_per_record_tokens: () => TOKEN_ESTIMATE_PER_RECORD,
  recompute_cadence: '24h',

  async produce(ctx: HousekeepingContext, source_record: SourceRecord<ContactRecord>) {
    const email = source_record.data.email;
    if (!email) return null;
    const { outbound_pending_count, overdue_count, oldest_overdue_at } =
      countOutboundCommitmentsForContact(ctx, email);

    if (outbound_pending_count < 1) {
      // Sample floor unmet — contact has no open outbound commitments
      // to anchor the signal. Producer abstains rather than emit a
      // zero-row for every contact in the warehouse.
      return null;
    }

    const value: OutboundCommitmentOverdueCountValue = {
      count: overdue_count,
      oldest_overdue_at,
      computed_at: ctx.now(),
    };
    return { value };
  },
};
