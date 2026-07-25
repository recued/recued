/** D-138 Phase 3 — `contact-merge-candidate-scan` housekeeping task.
 *
 *  Fifth task kind on D-123's housekeeping substrate (alongside
 *  `audit-compaction`, `cache-eviction-beyond-ttl`, `link-discovery`,
 *  `deterministic-risk-patterns`). Walks contacts whose
 *  `(updated_at, email)` is past the cursor, evaluates the predicate
 *  from `evaluateContactMatch` against blocking-key-narrowed candidates
 *  in the existing graph, and enqueues new merge candidates via
 *  `store.enqueueMergeCandidate`. Pre-filters via `rejectedPairKeys()`
 *  in every iteration so durably-rejected pairs never re-surface from
 *  the scan path.
 *
 *  Cursor: `{ kind: 'time_email', last_seen_at, last_email }` — the
 *  email tiebreaker (Codex review fix) ensures a same-millisecond
 *  group of contacts that split across batches doesn't lose its
 *  un-walked peers when the next iteration's `> last_seen_at` filter
 *  excludes them.
 *
 *  Yield discipline (Codex review fix): the task returns
 *  `'budget_exhausted'` whenever the per-step batch fills up so the
 *  rpc-driven drain loop can call back into `runOnce` and pick up
 *  where the cursor left off. `'no_work'` is reserved for the
 *  steady-state "no contacts have moved past the cursor" case.
 *
 *  Idempotency: re-running on identical data is a no-op via the
 *  `pair_key` UNIQUE constraint on `contact_merge_candidate_queue`
 *  (the store's `enqueueMergeCandidate` ON CONFLICT DO NOTHING — see
 *  `contact-store.ts`). Once a pair has been resolved (merged /
 *  rejected), the store's re-queue path stays inert because the
 *  rejection table acts as the authoritative blocklist + rejected
 *  pairs are filtered before predicate evaluation.
 *
 *  Bus emit: each new candidate triggers a `kind: 'merge_candidate'`
 *  bus event (mirrors the inline-detection emit shape from `bin.ts`).
 *  Per-iteration progress emits a `kind: 'merge_scan_progress'`
 *  event so the focus-page renderer (P2) can drive its sample-gated
 *  ETA + counter display without per-iteration round-trips. The mode
 *  on the emit is read at step time from the optional `getMode`
 *  callable (Codex review fix) so a `contact.merge.scan_now({ mode:
 *  'full' })` invocation surfaces `mode: 'full'` on the wire while
 *  the same registered task instance keeps serving the background
 *  delta cycle.
 *
 *  Spec: `docs/d-138-spec.md` § A.4 path 2 + § P3. */

import { randomUUID } from 'node:crypto';

import {
  CONTACT_MERGE_CANDIDATE_SCAN_TASK_ID,
  canonicalPairKey,
  evaluateContactMatch,
  type ContactRecord,
  type HousekeepingCursor,
  type HousekeepingStepResult,
} from '@recued/contracts';

import type {
  HousekeepingContext,
  HousekeepingTaskInstance,
} from '../registry.js';
import type { ContactStore } from '../../storage/contact-store.js';
import type { EventBus } from '../../events/bus.js';

/** Default per-step batch size — keeps cycle budget manageable on
 *  large graphs (the per-iteration cost is the predicate eval +
 *  blocking-key lookup, both bounded). The Run-Now full-scan flow
 *  walks the same loop and yields cleanly when the batch fills so
 *  the rpc-driven drain loop can resume from the cursor. */
export const CONTACT_MERGE_SCAN_BATCH_SIZE = 200;

/** Default progress-emit cadence — emit one `merge_scan_progress`
 *  event every N contacts walked. Lower for the focus-page renderer
 *  (50) so the ETA helper sees enough samples; higher for long-haul
 *  delta scans (no consumer polls those for progress). */
export const CONTACT_MERGE_SCAN_PROGRESS_STRIDE = 50;

export interface ContactMergeCandidateScanDeps {
  store: ContactStore;
  /** Optional realtime bus — when present, the scan emits a
   *  `'merge_candidate'` event for each newly-surfaced candidate +
   *  `'merge_scan_progress'` events at the iteration stride. Tests
   *  pass a recorder; production wires the real bus from `bin.ts`. */
  eventBus?: EventBus;
  /** Optional id factory — defaults to `randomUUID`. Tests pin this
   *  for deterministic queue rows. */
  idFactory?: () => string;
  /** Optional batch-size override. Tests pass 1 or 2 to exercise
   *  budget-yield behaviour without pathological data sizes. */
  batchSize?: number;
  /** Optional progress-stride override. Tests pass 1 to force an
   *  emit on every iteration. */
  progressStride?: number;
  /** Runtime-resolved scan mode (Codex review fix). Read on each
   *  step so a `contact.merge.scan_now({ mode: 'full' })` invocation
   *  flips the `merge_scan_progress` emit's `mode` field while the
   *  same registered task instance also serves the background delta
   *  cycle as `mode: 'delta'`. Defaults to `'delta'` when unset. */
  getMode?: () => 'delta' | 'full';
  /** Static fallback for `getMode`. Honoured only when `getMode` is
   *  unset. Tests pass it directly to pin the bus-emit mode without
   *  threading a callable. */
  mode?: 'delta' | 'full';
}

interface ContactsWalkRow {
  email: string;
  updated_at: number;
}

interface CursorState {
  last_seen_at: number;
  last_email: string;
}

const cursorToState = (cursor: HousekeepingCursor): CursorState => {
  if (cursor.kind === 'time_email') {
    return { last_seen_at: cursor.last_seen_at, last_email: cursor.last_email };
  }
  if (cursor.kind === 'time') {
    return { last_seen_at: cursor.last_seen_at, last_email: '' };
  }
  return { last_seen_at: 0, last_email: '' };
};

const stateToCursor = (state: CursorState): HousekeepingCursor => ({
  kind: 'time_email',
  last_seen_at: state.last_seen_at,
  last_email: state.last_email,
});

/** Build the scan-task instance bound to a `ContactStore`. The bin
 *  registers it via `registerHousekeepingTask` after the store is
 *  constructed; tests can construct an isolated registry to exercise
 *  the task in pure form. */
export const buildContactMergeCandidateScanTask = (
  deps: ContactMergeCandidateScanDeps,
): HousekeepingTaskInstance => {
  const batchSize = Math.max(1, deps.batchSize ?? CONTACT_MERGE_SCAN_BATCH_SIZE);
  const progressStride = Math.max(
    1,
    deps.progressStride ?? CONTACT_MERGE_SCAN_PROGRESS_STRIDE,
  );
  const idFactory = deps.idFactory ?? randomUUID;
  const resolveMode = (): 'delta' | 'full' => {
    if (deps.getMode) {
      try {
        return deps.getMode();
      } catch { /* fall through to static default */ }
    }
    return deps.mode ?? 'delta';
  };

  return {
    meta: {
      id: CONTACT_MERGE_CANDIDATE_SCAN_TASK_ID,
      description:
        'Scan recently-updated contacts for cross-platform merge candidates against the existing graph (deterministic predicate; rejection-pre-filtered).',
      interruptible: true,
      kind: 'core',
      tags: ['kind:core', 'domain:contact', 'surface:deterministic'],
    },

    async step(
      ctx: HousekeepingContext,
      cursor: HousekeepingCursor,
      budget_ms: number,
    ): Promise<HousekeepingStepResult> {
      // ── Schema gate — task is a no-op when the contact substrate
      //    isn't installed (dbless harness / pre-D-121 boot path).
      const tableExists = (
        ctx.db
          .prepare(
            `SELECT name FROM sqlite_master WHERE type='table' AND name='contacts'`,
          )
          .get() as { name: string } | undefined
      )?.name === 'contacts';
      if (!tableExists) {
        return { status: 'complete', cursor: { kind: 'complete' } };
      }

      const start = ctx.now();
      const cursorState = cursorToState(cursor);
      const mode = resolveMode();

      // Snapshot rejected pairs once per step so the inner loop is
      // O(1) per pair against a Set rather than a per-pair query.
      const rejectedPairs = deps.store.rejectedPairKeys();

      // Walk contacts whose `(updated_at, email)` is past the cursor
      // tuple, skipping tombstones (`merged_into IS NULL`). The
      // tiebreaker on `email` keeps us from skipping peers whose
      // `updated_at` is shared with the previous batch's tail row.
      const walkStmt = ctx.db.prepare(
        `SELECT email, updated_at FROM contacts
           WHERE merged_into IS NULL
             AND (updated_at > ?
                  OR (updated_at = ? AND email > ?))
           ORDER BY updated_at ASC, email ASC
           LIMIT ?`,
      );
      const walked = walkStmt.all(
        cursorState.last_seen_at,
        cursorState.last_seen_at,
        cursorState.last_email,
        batchSize,
      ) as ContactsWalkRow[];

      let iterated = 0;
      let surfaced = 0;
      const advanced: CursorState = { ...cursorState };
      let yieldedForBudget = false;

      const advanceCursor = (row: ContactsWalkRow): void => {
        if (
          row.updated_at > advanced.last_seen_at ||
          (row.updated_at === advanced.last_seen_at && row.email > advanced.last_email)
        ) {
          advanced.last_seen_at = row.updated_at;
          advanced.last_email = row.email;
        }
      };

      for (const walk of walked) {
        if (ctx.now() - start >= budget_ms) {
          yieldedForBudget = true;
          break;
        }
        iterated += 1;

        const changed = deps.store.get(walk.email);
        if (!changed) {
          // Row vanished between the walk and the lookup (rare —
          // delete races). Skip + advance cursor; next cycle picks
          // up where we left off.
          advanceCursor(walk);
          continue;
        }
        if (changed.merged_into) {
          // Tombstoned between walk + read. Same handling as above.
          advanceCursor(walk);
          continue;
        }

        const candidates = lookupBlockingCandidates(ctx, deps, changed);
        for (const partner of candidates) {
          if (partner.email === changed.email) continue;
          if (partner.merged_into) continue;
          const pairKey = canonicalPairKey(changed.email, partner.email);
          if (rejectedPairs.has(pairKey)) continue;

          const result = evaluateContactMatch(changed, partner);
          if (!result.matches) continue;

          let inserted = false;
          try {
            const id = idFactory();
            const cand = deps.store.enqueueMergeCandidate({
              id,
              email_a: changed.email,
              email_b: partner.email,
              matched_fields: result.matched_fields,
              detected_at: ctx.now(),
              detected_by: 'housekeeping',
            });
            // The store's enqueueMergeCandidate is idempotent — when
            // the pair already had a pending row, the returned
            // candidate's `id` is the existing row's id, NOT the one
            // we just generated. We only count "newly surfaced" when
            // the pair was previously absent from the queue.
            inserted = cand.id === id;
            if (inserted) {
              surfaced += 1;
              try {
                deps.eventBus?.emit({
                  kind: 'merge_candidate',
                  subkind: 'inserted',
                  candidate_id: cand.id,
                  pair_key: cand.pair_key,
                });
              } catch { /* bus emit is best-effort */ }
            }
          } catch { /* dedup conflict / row vanished: skip */ }
        }

        advanceCursor(walk);

        // Stride-emit progress so the focus-page renderer's ETA
        // sample buffer fills predictably without overwhelming the
        // bus on large graphs.
        if (iterated % progressStride === 0) {
          try {
            deps.eventBus?.emit({
              kind: 'merge_scan_progress',
              op: 'progress',
              mode,
              iterated,
              total: null,
              surfaced_count: surfaced,
            });
          } catch { /* best-effort */ }
        }
      }

      // Determine whether we ran out of work. If the walker returned
      // fewer rows than `batchSize` and we didn't yield-for-budget,
      // the scan is caught up.
      const morePending = walked.length === batchSize && !yieldedForBudget;
      const status: HousekeepingStepResult['status'] = morePending || yieldedForBudget
        ? 'yield'
        : 'complete';

      const cursorOut = stateToCursor(advanced);

      // Final progress emit — `op: 'complete'` only when the scan
      // fully drained its current run (`status === 'complete'`).
      // Mid-drain yields surface `op: 'progress'` so consumers know
      // more iterations are coming. Carries the surfaced count so
      // the focus-page renderer can render its closing summary.
      try {
        deps.eventBus?.emit({
          kind: 'merge_scan_progress',
          op: status === 'complete' ? 'complete' : 'progress',
          mode,
          iterated,
          total: null,
          surfaced_count: surfaced,
        });
      } catch { /* best-effort */ }

      // Codex review fix — both the budget-yield and batch-full paths
      // signal `'budget_exhausted'` so the rpc-driven drain loop can
      // tell "more pending, give me another slice" apart from the
      // `'complete'` (fully drained) terminal. `'no_work'` is reserved
      // for the case where the walker returned zero rows AND nothing
      // was iterated — handled implicitly via the `'complete'` exit
      // when `walked.length === 0`.
      if (status === 'yield') {
        return {
          status: 'yield',
          reason: 'budget_exhausted',
          cursor: cursorOut,
        };
      }
      return { status: 'complete', cursor: cursorOut };
    },
  };
};

/** Look up candidate partner rows for a changed contact via the
 *  blocking-key indexes installed in `ensureContactSchema`. Returns a
 *  bounded set of canonicalized rows (deduped on email) — the caller
 *  runs the per-row predicate eval. NULL fields on the `changed` side
 *  drop out (no JOIN noise); the row's own email is filtered above
 *  before the predicate runs.
 *
 *  The list-based path goes through `store.list({ limit: 1000 })`
 *  when none of the blocking keys are populated — preserves the
 *  inline-detector fallback for newly-onboarded rows that haven't yet
 *  acquired phone / address / company state. */
const lookupBlockingCandidates = (
  ctx: HousekeepingContext,
  deps: ContactMergeCandidateScanDeps,
  changed: ContactRecord,
): ContactRecord[] => {
  const filters: string[] = [];
  const params: unknown[] = [];
  if (changed.phone) {
    filters.push('phone = ?');
    params.push(changed.phone);
  }
  if (changed.name_key) {
    filters.push('name_key = ?');
    params.push(changed.name_key);
  }
  if (changed.company_norm) {
    filters.push('company_norm = ?');
    params.push(changed.company_norm);
  }
  if (changed.address_zip_country_key) {
    filters.push('address_zip_country_key = ?');
    params.push(changed.address_zip_country_key);
  }
  if (filters.length === 0) {
    // Fallback: no blocking key on the changed row → nothing to
    // narrow against. The inline-detector still surfaces these via
    // its full-list fallback; the housekeeping scan honours the same
    // discipline only when the row is brand-new (zero blocking keys
    // populated). Bounded list scan keeps the hot path predictable.
    return deps.store.list({ limit: 500 });
  }
  const sql = `
    SELECT email FROM contacts
      WHERE email != ?
        AND merged_into IS NULL
        AND (${filters.join(' OR ')})
      ORDER BY email ASC
      LIMIT 500
  `;
  const rows = ctx.db
    .prepare(sql)
    .all(changed.email, ...params) as { email: string }[];
  const out: ContactRecord[] = [];
  for (const row of rows) {
    const rec = deps.store.get(row.email);
    if (rec) out.push(rec);
  }
  return out;
};
