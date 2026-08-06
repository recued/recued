/** D-145 PA9 — `open_loop_pressure` enrichment producer (per-contact v1).
 *
 *  Per-contact pressure rollup over unresolved work owed to or by this
 *  counterparty — the engine's primary "what needs attention?" signal.
 *  Walks the contact warehouse; for each contact the producer folds
 *  three categories of open loop:
 *
 *    1. Open commitments — `lifecycle_state = 'pending'` rows where
 *       `counterparty_contact_id = <contact.email>`. Both inbound (the
 *       contact owes me) and outbound (I owe the contact) directions
 *       count toward pressure. `direction = 'internal'` is excluded
 *       (matches `commitment_imbalance` convention — internal
 *       commitments don't speak to a relationship's open-loop state).
 *    2. Open tasks — `done = false` rows where
 *       `assigned_contact_id = <contact.email>`. A task assigned to
 *       this contact and not yet done is real open work.
 *    3. Unread inbound mails — across `collection_mail_*` tables,
 *       messages where the contact appears in any of From/To/Cc AND
 *       `is_read = false`. Pragmatic "unanswered thread" proxy at v1;
 *       a richer thread-aware variant ships when D-139 engagement
 *       evidence feeds back into the producer.
 *
 *  Each item carries `age_days = (now - item_timestamp) / 86_400_000`
 *  where `item_timestamp` is `state_changed_at` for commitments,
 *  `updated_at` for tasks, `received_at` for mails. Negative ages
 *  (clock skew) clamp to 0; non-finite ages skip the item.
 *
 *  Math:
 *    - `open_count = commitments_open + tasks_open + mails_unread`
 *    - `age_weighted_score = Σ max(0, age_days)` across all open items
 *    - `pressure_score = clamp(age_weighted_score / 60, 0, 1)`
 *
 *  Why a 60-person-day saturation cap? Saturation at 60 means one
 *  60-day-old loop hits max pressure, OR six 10-day loops, OR
 *  twelve 5-day loops. Matches the spec's "what needs attention?"
 *  framing — a single contact with weeks of stale open loops is
 *  always max-priority, multiple younger loops accumulate. The pack
 *  recipe layer (`today` / `before-you-reply`) re-shapes the curve
 *  per its own UX — substrate emits signal, pack composes signal.
 *
 *  Sample-floor semantics. Declaration carries `sample_floor: 1` —
 *  contacts with zero open work get no row (`produce()` returns null).
 *  This keeps the warehouse small: every paired contact would
 *  otherwise emit a `pressure_score: 0` row that consumers have to
 *  filter. Matches `outbound_commitment_overdue_count`'s precedent
 *  (zero-floor contacts abstain; nonzero-floor contacts emit even
 *  when the inner state is empty).
 *
 *  Dual-scope deferral. Spec § A.7.2 frames this as TWO scopes
 *  (per-contact AND per-project) sharing one producer. v1 ships
 *  per-contact only — engine's primary consumer (`today` /
 *  `before-you-reply`). Per-project rows ship in a follow-on slice
 *  that introduces the multi-scope task-id substrate
 *  (`enrichment.${topic}.${scope}`); the current harness binds each
 *  producer instance to a single `source_scope` via
 *  `id = enrichment.${topic}`, so two producers sharing a topic
 *  would collide. Registry retains `valid_scopes: ['contact',
 *  'project']` so per-project storage is reserved.
 *
 *  Cadence + invalidation. Housekeeping 24h. Cascade fires on
 *  `data.commitment.state_changed` + `data.task.state_changed` +
 *  `data.mail.received` per the declaration's `invalidation_triggers`.
 *  The work-entity due-status sweep already marks commitment topics
 *  stale on every transition — same cascade flow `commitment_imbalance`
 *  + `outbound_commitment_overdue_count` ride.
 *
 *  Spec: D-145 §§ A.7.1 (line 753) + A.7.2 + A.7.3 +
 *        A.7.5 + A.7.6 #1 +
 *        `ENRICHMENT_REGISTRY.open_loop_pressure` +
 *        `packages/contracts/src/enrichment-declarations/open-loop-pressure.ts`. */

import {
  type ContactRecord,
  type OpenLoopPressureValue,
} from '@recued/contracts';

import type { HousekeepingContext } from '../registry.js';
import type { SourceRecord } from '../source-walkers.js';
import type { HousekeepingEnrichmentProducer } from '../enrichment-producer.js';
import { COMMITMENT_TABLE, TASK_TABLE } from '../../storage/work-entity-store.js';
import { collectAddresses } from './_email-addresses.js';
import {
  contactAddresses,
  likeAnyParams,
  matchesAnyAddress,
  sqlInList,
  sqlLikeAny,
} from './_contact-addresses.js';
import { listCollectionDataTables } from '../../collections/table.js';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

/** One day in milliseconds. */
const DAY_MS = 86_400_000;

/** Saturation cap for `pressure_score` — `age_weighted_score / 60d`
 *  hits 1.0 at 60 person-days of open loop. Exposed for unit testing
 *  + future tunable_params lift (§ A.7.8 could turn this knob —
 *  industry cadence varies between sprint teams and capital projects). */
export const OPEN_LOOP_PRESSURE_SATURATION_DAYS = 60;

/** Hot-field keys read off mail rows. Matches `preferred_channel_by_contact`. */
const MAIL_FROM_KEY = 'from';
const MAIL_TO_KEY = 'to';
const MAIL_CC_KEY = 'cc';
const MAIL_IS_READ_KEY = 'is_read';

/** Pure SQL + arithmetic — zero token cost, idle-eligible. */
const TOKEN_ESTIMATE_PER_RECORD = 0;

// ────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────

/** Compute age in days from a unix-ms timestamp to `now`. Negative
 *  ages (clock-skew from future timestamps) clamp to 0; non-finite
 *  inputs return 0 defensively. Exposed for direct unit testing. */
export const computeAgeDays = (item_timestamp: number, now: number): number => {
  if (!Number.isFinite(item_timestamp) || !Number.isFinite(now)) return 0;
  const elapsed_ms = now - item_timestamp;
  if (elapsed_ms <= 0) return 0;
  return elapsed_ms / DAY_MS;
};

/** Convert an `age_weighted_score` (sum of age-days) into a
 *  saturating 0..1 `pressure_score`. Matches the producer's framing:
 *  saturation_days person-days of open loop hits max pressure;
 *  pack recipes re-shape if they want a different curve. Pure
 *  function — exposed for direct unit testing without round-tripping
 *  through the producer. */
export const computePressureScore = (
  age_weighted_score: number,
  saturation_days: number = OPEN_LOOP_PRESSURE_SATURATION_DAYS,
): number => {
  if (!Number.isFinite(age_weighted_score)) return 0;
  if (!Number.isFinite(saturation_days) || saturation_days <= 0) return 0;
  if (age_weighted_score <= 0) return 0;
  const ratio = age_weighted_score / saturation_days;
  return ratio >= 1 ? 1 : ratio;
};

// ────────────────────────────────────────────────────────────────
// Per-source SQL queries
// ────────────────────────────────────────────────────────────────

export interface PendingItemAggregate {
  /** Number of items open for this contact. */
  count: number;
  /** Sum of age-in-days across the matching rows. */
  age_weighted: number;
}

const ZERO_AGGREGATE: PendingItemAggregate = { count: 0, age_weighted: 0 };

/** Aggregate open commitments for one contact — both inbound and
 *  outbound directions count (open loop is direction-agnostic).
 *  Internal direction excluded. Uses
 *  `idx_commitment_counterparty_lifecycle` for index-narrowed scan. */
export const aggregateOpenCommitmentsForContact = (
  ctx: HousekeepingContext,
  contact_email: string,
  now: number,
): PendingItemAggregate => {
  if (contact_email === '') return ZERO_AGGREGATE;
  // D-205 #3.5 — across the merge group (see `_contact-addresses.ts`).
  const addresses = contactAddresses(ctx, contact_email);
  if (addresses.length === 0) return ZERO_AGGREGATE;
  const row = ctx.db
    .prepare(
      `SELECT
          COUNT(*) AS count,
          COALESCE(SUM(CASE WHEN ? - state_changed_at > 0 THEN (? - state_changed_at) / 86400000.0 ELSE 0 END), 0) AS age_weighted
        FROM "${COMMITMENT_TABLE}"
        WHERE counterparty_contact_id IN (${sqlInList(addresses.length)})
          AND lifecycle_state = 'pending'
          AND direction IN ('inbound', 'outbound')
          AND sync_state IN ('live', 'stale_unreachable')
          AND deleted_at IS NULL`,
    )
    .get(now, now, ...addresses) as
    | { count: number | null; age_weighted: number | null }
    | undefined;
  return {
    count: row?.count ?? 0,
    age_weighted: row?.age_weighted ?? 0,
  };
};

/** Aggregate open tasks assigned to one contact. Uses
 *  `idx_task_assigned_done` for index-narrowed scan. */
export const aggregateOpenTasksForContact = (
  ctx: HousekeepingContext,
  contact_email: string,
  now: number,
): PendingItemAggregate => {
  if (contact_email === '') return ZERO_AGGREGATE;
  // D-205 #3.5 — across the merge group (see `_contact-addresses.ts`).
  const addresses = contactAddresses(ctx, contact_email);
  if (addresses.length === 0) return ZERO_AGGREGATE;
  const row = ctx.db
    .prepare(
      `SELECT
          COUNT(*) AS count,
          COALESCE(SUM(CASE WHEN ? - updated_at > 0 THEN (? - updated_at) / 86400000.0 ELSE 0 END), 0) AS age_weighted
        FROM "${TASK_TABLE}"
        WHERE assigned_contact_id IN (${sqlInList(addresses.length)})
          AND done = 0
          AND sync_state IN ('live', 'stale_unreachable')
          AND deleted_at IS NULL`,
    )
    .get(now, now, ...addresses) as
    | { count: number | null; age_weighted: number | null }
    | undefined;
  return {
    count: row?.count ?? 0,
    age_weighted: row?.age_weighted ?? 0,
  };
};

const listMailCollectionTables = (ctx: HousekeepingContext): string[] => {
  const rows = listCollectionDataTables(ctx.db, 'mail');
  return rows;
};

/** Aggregate unread mails involving the contact across every mail
 *  collection table. The `is_read` flag lives inside `hot_fields`
 *  JSON, so the SQL pre-narrows on `hot_fields LIKE '%email%'` and
 *  the loop body parses each match to verify canonical address +
 *  unread state. Same cross-table scan pattern as
 *  `preferred_channel_by_contact.countMailMentionsInWindow`; differs
 *  in that we narrow on is_read instead of a received_at window
 *  (pressure is "open *now*", not "received in window"). */
export const aggregateUnreadMailsForContact = (
  ctx: HousekeepingContext,
  contact_email: string,
  now: number,
): PendingItemAggregate => {
  if (contact_email === '') return ZERO_AGGREGATE;
  // D-205 #3.5 — across the merge group. The `LIKE` below is only a pre-narrow;
  // `matchesAnyAddress` remains the authoritative test, so widening it can only
  // offer more candidate rows for that check to reject.
  const addresses = contactAddresses(ctx, contact_email);
  if (addresses.length === 0) return ZERO_AGGREGATE;
  let count = 0;
  let age_weighted = 0;
  for (const table of listMailCollectionTables(ctx)) {
    const rows = ctx.db
      .prepare(
        `SELECT received_at, hot_fields FROM "${table}"
          WHERE ${sqlLikeAny('hot_fields', addresses.length)}`,
      )
      .all(...likeAnyParams(addresses)) as Array<{
        received_at: number;
        hot_fields: string;
      }>;
    for (const row of rows) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(row.hot_fields) as Record<string, unknown>;
      } catch {
        continue;
      }
      const isReadVal = parsed[MAIL_IS_READ_KEY];
      // is_read = true (canonical) means already read; pressure
      // counts only unread. Missing / non-boolean is_read is treated
      // as unread (defensive — adapters that haven't wired is_read
      // shouldn't silently zero out the signal).
      if (isReadVal === true) continue;
      const participants = new Set<string>();
      collectAddresses(parsed[MAIL_FROM_KEY], participants);
      collectAddresses(parsed[MAIL_TO_KEY], participants);
      collectAddresses(parsed[MAIL_CC_KEY], participants);
      if (!matchesAnyAddress(participants, addresses)) continue;
      count += 1;
      age_weighted += computeAgeDays(row.received_at, now);
    }
  }
  return { count, age_weighted };
};

// ────────────────────────────────────────────────────────────────
// Producer
// ────────────────────────────────────────────────────────────────

export const openLoopPressureProducer: HousekeepingEnrichmentProducer<ContactRecord> = {
  topic: 'open_loop_pressure',
  source_scope: 'contact',
  scope_read_declaration: [
    // `merged_into`: the three aggregates below read the merge graph to widen
    // themselves across the contact's absorbed addresses (D-205 #3.5).
    { collection: 'data.contact', sample_field_paths: ['email', 'merged_into'] },
    {
      collection: 'data.commitment',
      sample_field_paths: [
        'counterparty_contact_id',
        'lifecycle_state',
        'direction',
        'state_changed_at',
      ],
    },
    {
      collection: 'data.task',
      sample_field_paths: ['assigned_contact_id', 'done', 'updated_at'],
    },
    {
      collection: 'data.mail',
      sample_field_paths: ['from', 'to', 'cc', 'is_read', 'received_at'],
    },
  ],
  estimate_per_record_tokens: () => TOKEN_ESTIMATE_PER_RECORD,
  recompute_cadence: '24h',

  async produce(ctx: HousekeepingContext, source_record: SourceRecord<ContactRecord>) {
    const email = source_record.data.email;
    if (!email) return null;
    const now = ctx.now();

    const commitments = aggregateOpenCommitmentsForContact(ctx, email, now);
    const tasks = aggregateOpenTasksForContact(ctx, email, now);
    const mails = aggregateUnreadMailsForContact(ctx, email, now);

    const open_count = commitments.count + tasks.count + mails.count;
    if (open_count < 1) {
      // Sample floor unmet — contact has no open loop at all.
      // Producer abstains rather than emit a zero-row for every
      // paired contact in the warehouse.
      return null;
    }

    const age_weighted_score =
      commitments.age_weighted + tasks.age_weighted + mails.age_weighted;
    const pressure_score = computePressureScore(age_weighted_score);

    const value: OpenLoopPressureValue = {
      pressure_score,
      open_count,
      age_weighted_score,
      computed_at: now,
    };
    return { value };
  },
};
