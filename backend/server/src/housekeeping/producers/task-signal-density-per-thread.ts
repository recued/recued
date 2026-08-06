/** D-145 PA9 — `task_signal_density_per_thread` enrichment producer.
 *
 *  Per-thread density of task-shaped signals over message count.
 *  Walks the mail collection one record at a time (mail-thread walker,
 *  body-blind) and for each input mail computes the thread-level
 *  rollup that mail belongs to. Multiple mails in the same thread
 *  carry identical density values — same redundancy [[thread_signals]]
 *  already lives with under `walker_kind: 'mail-thread'`.
 *
 *  Ninth D-145 PA9 producer impl + second per-record producer on
 *  `walker_kind: 'mail-thread'` (after [[thread_signals]]). Reuses the
 *  body-blind mail walker; differs in what it counts.
 *
 *  Algorithm. For each input mail:
 *    1. Read `thread_id` from `hot_fields`. Empty thread_id collapses
 *       to a degenerate "thread of one" → message_count = 1, signal_count
 *       can only count tasks NOT linked to a thread (kept at 0 — tasks
 *       without a `linked_mail_thread_id` aren't this thread's signal).
 *    2. Count `data_task` rows where
 *
 *           linked_mail_thread_id = ?
 *           sync_state IN ('live', 'stale_unreachable')
 *           deleted_at IS NULL
 *
 *       Tombstoned + orphan rows excluded. Tasks linked to the thread
 *       (declared, mail-extracted, recipe-emitted — any
 *       `derivation_kind`) all count toward signal density; the spec
 *       hint § A.7.1 line 26 says "mentions, asks, follow-ups," which
 *       maps to "any task we managed to land that references this
 *       thread."
 *    3. Count thread siblings across `collection_mail_*` tables — same
 *       SQL pattern as [[thread_signals]]. The walker iterates one mail
 *       at a time, but the producer scans for siblings so the rollup
 *       matches across messages.
 *    4. `density = signal_count / message_count` when message_count >
 *       0; else 0. Density > 1 is possible (high-signal thread of one
 *       message with multiple tasks); the schema accepts any finite
 *       number per registry:4255.
 *
 *  Why all-time signal counts (no time filter on tasks)? The spec
 *  hint frames the math as "count task-shaped signals over its message
 *  count" — no qualifier on task age. Restricting tasks to the 30d
 *  registry window would undercount cases where the thread surfaced
 *  weeks ago but the task landed yesterday. The 30d
 *  `aggregate_window_ms` lives in the registry as the cascade-
 *  invalidation cadence framing, not a SQL filter.
 *
 *  Why all-time message counts (no time filter on siblings)? Matches
 *  [[thread_signals]]'s approach exactly — thread message_count is a
 *  thread-level fact, not a windowed signal. Restricting siblings to
 *  the 30d window would shrink message_count and inflate density
 *  artificially as old threads roll out of view.
 *
 *  Sample-floor semantics. Declaration carries `sample_floor: 1` —
 *  every mail with a thread_id gets evaluated; the trivial "thread of
 *  one + zero tasks" case still emits density = 0 so consumers see
 *  the explicit "no signal" row distinct from "we haven't computed
 *  yet" (row absent).
 *
 *  Cadence + invalidation. Housekeeping 24h (registry). Cascade fires
 *  on `data.mail.received` + `data.task.created` per the declaration's
 *  `invalidation_triggers`. The `aggregates_from = ['task', 'mail']`
 *  registry entry keeps the cascade walker on both scopes; the
 *  harness's stale-sweep re-derives within the next eligible cycle.
 *  No reactive harness needed — the registry-driven cascade is the
 *  reactivity primitive.
 *
 *  Spec: D-145 §§ A.7.1 (line 742) + A.7.3 + A.7.5 +
 *        `ENRICHMENT_REGISTRY.task_signal_density_per_thread` +
 *        `packages/contracts/src/enrichment-declarations/task-signal-density-per-thread.ts`. */

import {
  type CollectionRecord,
  type TaskSignalDensityValue,
} from '@recued/contracts';

import type { HousekeepingContext } from '../registry.js';
import type { SourceRecord } from '../source-walkers.js';
import type { HousekeepingEnrichmentProducer } from '../enrichment-producer.js';
import { TASK_TABLE } from '../../storage/work-entity-store.js';
import { listCollectionDataTables } from '../../collections/table.js';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

/** Hot-field key the producer reads from each mail record. */
const THREAD_ID_KEY = 'thread_id';

/** Pure SQL aggregation — zero token cost, idle-eligible. */
const TOKEN_ESTIMATE_PER_RECORD = 0;

// ────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────

/** Compute density = signal_count / message_count with the zero-
 *  denominator guard. Exposed for direct unit testing without
 *  round-tripping through SQL. Non-finite inputs coerce to 0
 *  defensively — the call site shouldn't pass them, but a future
 *  scaffold mis-shaping signal_count to NaN shouldn't blow up the
 *  producer. */
export const computeTaskSignalDensity = (
  signal_count: number,
  message_count: number,
): number => {
  if (!Number.isFinite(signal_count) || !Number.isFinite(message_count)) return 0;
  if (message_count <= 0) return 0;
  return signal_count / message_count;
};

/** Pull `thread_id` from a mail record's hot_fields. Returns `''` when
 *  the message lacks one — the producer treats this as a degenerate
 *  one-message thread per [[thread_signals]]. */
export const threadIdOfMail = (record: CollectionRecord): string => {
  const raw = record.hot_fields[THREAD_ID_KEY];
  return typeof raw === 'string' ? raw : '';
};

// ────────────────────────────────────────────────────────────────
// SQL queries
// ────────────────────────────────────────────────────────────────

/** Count tasks linked to one thread. Filters out tombstones + non-live
 *  syncs; counts all derivations (user-declared, mail-extracted,
 *  recipe-emitted — any task we managed to land that references this
 *  thread). Empty `thread_id` short-circuits to 0 — tasks without a
 *  `linked_mail_thread_id` cannot belong to a degenerate empty-thread
 *  signal. Returns the count as a number; never null. */
export const countTasksLinkedToThread = (
  ctx: HousekeepingContext,
  thread_id: string,
): number => {
  if (thread_id === '') return 0;
  const row = ctx.db
    .prepare(
      `SELECT COUNT(*) AS task_count FROM "${TASK_TABLE}"
         WHERE linked_mail_thread_id = ?
           AND sync_state IN ('live', 'stale_unreachable')
           AND deleted_at IS NULL`,
    )
    .get(thread_id) as { task_count: number | null } | undefined;
  return row?.task_count ?? 0;
};

/** Count mail siblings in one thread across every `collection_mail_*`
 *  table. Matches [[thread_signals]]'s SQL discipline — the collection
 *  layer's invariant is one table per mail account; the producer
 *  enumerates them via `sqlite_master` and sums each table's matching
 *  row count. Empty `thread_id` returns 0 so callers can fall back to
 *  the degenerate single-message path. */
export const countMailSiblingsInThread = (
  ctx: HousekeepingContext,
  thread_id: string,
): number => {
  if (thread_id === '') return 0;
  const tables = listCollectionDataTables(ctx.db, 'mail');

  let total = 0;
  for (const table of tables) {
    const row = ctx.db
      .prepare(
        `SELECT COUNT(*) AS message_count FROM "${table}"
          WHERE json_extract(hot_fields, '$.thread_id') = ?`,
      )
      .get(thread_id) as { message_count: number | null } | undefined;
    total += row?.message_count ?? 0;
  }
  return total;
};

// ────────────────────────────────────────────────────────────────
// Producer
// ────────────────────────────────────────────────────────────────

export const taskSignalDensityPerThreadProducer: HousekeepingEnrichmentProducer = {
  topic: 'task_signal_density_per_thread',
  source_scope: 'mail',
  scope_read_declaration: [
    { collection: 'data.mail', sample_field_paths: ['thread_id', 'record_id'] },
    {
      collection: 'data.task',
      sample_field_paths: ['linked_mail_thread_id'],
    },
  ],
  estimate_per_record_tokens: () => TOKEN_ESTIMATE_PER_RECORD,
  recompute_cadence: '24h',

  async produce(ctx: HousekeepingContext, source_record: SourceRecord) {
    const thread_id = threadIdOfMail(source_record.data);
    const now = ctx.now();

    if (thread_id === '') {
      // Degenerate "thread of one" — emit the trivial rollup so
      // recipes reading data.enrichment.mail.<id>.task_signal_density_per_thread
      // never see undefined for a real mail record. Tasks can only
      // join via `linked_mail_thread_id`, which is null for messages
      // missing a thread_id, so signal_count is 0 by construction.
      const value: TaskSignalDensityValue = {
        density: 0,
        signal_count: 0,
        computed_at: now,
      };
      return { value };
    }

    const signal_count = countTasksLinkedToThread(ctx, thread_id);
    const message_count = countMailSiblingsInThread(ctx, thread_id);
    // Defensive fallback: the walker handed us this mail, so the SQL
    // sibling scan MUST find at least it. If the scan returns 0 (e.g.
    // running against a stub registry or an in-test mail not yet
    // committed), treat the input mail as its own thread of one rather
    // than emit a divide-by-zero row.
    const effective_message_count = message_count > 0 ? message_count : 1;

    const density = computeTaskSignalDensity(signal_count, effective_message_count);

    const value: TaskSignalDensityValue = {
      density,
      signal_count,
      computed_at: now,
    };
    return { value };
  },
};
