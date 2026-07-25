/** D-138 — contact-merge rpc-deps composer.
 *
 *  Builds the `ContactMergeRpcDeps` shape consumed by the six
 *  `contact.merge.*` rpcs (`list` / `confirm` / `reject` / `split` /
 *  `undo_rejection` / `resolve_remerge_prompt`) plus the
 *  `contact.merge.scan_now` manual-trigger rpc. Two integrations land
 *  here:
 *
 *    1. **`emitMergeCandidate`** — bridges queue mutations onto the
 *       D-121 broadcast bus (`kind: 'merge_candidate'`). Best-effort —
 *       bus throws never abort the rpc.
 *    2. **`runScanNow`** — manual-trigger backend for `contact.merge.
 *       scan_now`. Late-binds against the housekeeping scheduler
 *       registry (the rpc surface throws `housekeeping scheduler not
 *       yet constructed` until the scheduler composer runs later in
 *       cmdServe). `mode: 'full'` first resets the per-task
 *       `housekeeping_state` cursor so the scan walks every non-
 *       tombstone contact. The yield-resume loop honours the per-cycle
 *       budget (each `runOnce` returns when the budget exhausts), so
 *       very large graphs progress in chunks rather than blocking the
 *       rpc — capped at 50 iterations defensively.
 *
 *  Late-binding contract: `setActiveScanMode` mutates a bin.ts module-
 *  top scan-mode reference that the registered scan task's
 *  `merge_scan_progress` bus emits consult via `getActiveContactMergeScanMode`.
 *  Flipping it to `mode` for the rpc duration and back to `'delta'` in
 *  the `finally` block keeps reactive consumers observing the correct
 *  mode for the manual run while background cycles resume emitting the
 *  steady-state mode regardless of how the rpc exits.
 *
 *  Returns `{ contactMergeDeps: undefined }` when `contactStore` is
 *  absent — dbless harnesses leave the slice off + the six rpc methods
 *  return `not_configured`. The `runScanNow` slice is further
 *  conditional on `housekeepingState && db` (both populated together
 *  in bin.ts so realistically gated by the same `db` predicate). */

import type Database from 'better-sqlite3';
import {
  CONTACT_MERGE_CANDIDATE_SCAN_TASK_ID,
  type ContactMergeScanMode,
} from '@recued/contracts';
import type { AnnotationStore } from '../../storage/annotation-store.js';
import type { CascadeEngine } from '../../storage/enrichment-cascade.js';
import type { ContactStore } from '../../storage/contact-store.js';
import type {
  ContactMergeRpcDeps,
  RemergePromptStore,
} from '../../contact-merge-handler.js';
import type { HousekeepingStateStore } from '../../housekeeping/state-store.js';
import type { HousekeepingSchedulerRegistry } from './housekeeping-scheduler-instance.js';
import type { EventBus } from '../../events/bus.js';

export interface ComposeContactMergeRpcDepsInput {
  /** Contact warehouse — required. Absent → composer returns the
   *  undefined-bundle and the caller drops the `contactMergeDeps`
   *  spread. */
  contactStore: ContactStore | undefined;
  /** Annotation warehouse — wired so the rpc can rewrite link rows
   *  on `confirm`/`split`. Absent in dbless harnesses. */
  annotationStore: AnnotationStore | undefined;
  /** A.10 upstream-re-merge prompt store. Absent →
   *  `contact.merge.resolve_remerge_prompt` surfaces `not_configured`. */
  promptStore: RemergePromptStore | undefined;
  /** Per-task cursor store. Required for the `runScanNow` slice
   *  (`mode: 'full'` resets the contact-merge-candidate-scan cursor
   *  here before the scan loop). Absent → no `runScanNow` slice
   *  emitted. */
  housekeepingState: HousekeepingStateStore | undefined;
  /** SQLite handle for the post-scan surfaced-count read against
   *  `contact_merge_candidate_queue`. Required for the `runScanNow`
   *  slice; absent → no slice emitted (mirrors the bin.ts pair-gate
   *  `housekeepingStateRef && db`). */
  db: Database.Database | undefined;
  /** D-121 broadcast bus — fans queue-mutation events to subscribed
   *  clients. Always present at the composition site. */
  eventBus: EventBus;
  /** Housekeeping scheduler singleton. The composer reads
   *  `getScheduler()` at rpc-call time (late-binding) — the rpc throws
   *  if the scheduler hasn't been published yet. */
  schedulerRegistry: HousekeepingSchedulerRegistry;
  /** Bridge into the bin.ts module-top `activeContactMergeScanMode`
   *  binding. The composer flips it for the duration of `runScanNow`
   *  so the registered scan task's bus emits report the requested
   *  mode; restored to `'delta'` in the `finally` block so background
   *  cycles keep emitting the steady-state mode regardless of how the
   *  rpc exits. */
  setActiveScanMode: (mode: ContactMergeScanMode) => void;
  /** D-205 — the D-136 cascade engine, so a confirmed merge can invalidate the
   *  enrichment keyed on the identities it just changed.
   *
   *  🔑 **This is why `onIdentityChanged` was dead.** `ContactMergeRpcDeps` has declared
   *  the hook since D-138 — and its own doc comment claims *"the boot wire injects the
   *  real cascade engine"*. No boot wire ever did: `cascadeForIdentityChange` had **zero
   *  production callers**, because the engine lived on the AppContext
   *  (`enrichmentCascadeRef`) and was only ever threaded to the contact-STORE wire, never
   *  to this rpc composer. So every confirmed merge left the loser's contact-scoped
   *  enrichment rows standing, keyed on an identity that no longer exists — declared,
   *  built, tested, and wired to nothing. (Exactly the shape of D-205 #2c's
   *  `contactSourceSyncStateRef`, which was a function-local `let` for the same reason.)
   *
   *  Absent (dbless harness / no enrichment store) → no hook, same as before. */
  enrichmentCascade: CascadeEngine | undefined;
}

export interface ContactMergeRpcBundle {
  /** Threaded into `createServerHandlerSet({ contactMergeDeps })`.
   *  Undefined when `contactStore` is missing → caller drops the
   *  conditional spread. */
  contactMergeDeps: ContactMergeRpcDeps | undefined;
}

export const composeContactMergeRpcDeps = (
  input: ComposeContactMergeRpcDepsInput,
): ContactMergeRpcBundle => {
  const {
    contactStore,
    annotationStore,
    promptStore,
    housekeepingState,
    db,
    eventBus,
    schedulerRegistry,
    setActiveScanMode,
    enrichmentCascade,
  } = input;

  if (!contactStore) {
    return { contactMergeDeps: undefined };
  }

  const emitMergeCandidate: NonNullable<
    ContactMergeRpcDeps['emitMergeCandidate']
  > = (subkind, candidate) => {
    try {
      eventBus.emit({
        kind: 'merge_candidate',
        subkind,
        candidate_id: candidate.id,
        pair_key: candidate.pair_key,
      });
    } catch { /* best-effort */ }
  };

  let runScanNow: ContactMergeRpcDeps['runScanNow'] | undefined;
  if (housekeepingState && db) {
    // Local rebindings so the closure captures non-undefined narrows.
    const state = housekeepingState;
    const sqlite = db;
    runScanNow = async ({ mode }) => {
      const scheduler = schedulerRegistry.getScheduler();
      if (!scheduler) {
        throw new Error('housekeeping scheduler not yet constructed');
      }
      if (mode === 'full') {
        state.set({
          task_id: CONTACT_MERGE_CANDIDATE_SCAN_TASK_ID,
          cursor: { kind: 'time_email', last_seen_at: 0, last_email: '' },
          last_status: 'pending',
          last_run_at: Date.now(),
          consecutive_errors: 0,
        });
      }
      // D-138 P3 (Codex review fix) — flip the global mode reference
      // for the duration of this rpc so the registered scan task's bus
      // emits report the requested mode. Restored to `'delta'` in the
      // `finally` block so the background cycle keeps emitting steady-
      // state mode regardless of how the rpc exits.
      setActiveScanMode(mode);
      const startTs = Date.now();
      let cycleIterations = 0;
      let yieldReason: 'budget_exhausted' | 'no_work' | undefined;
      try {
        // Drain successive yield-resumes until the scan settles
        // (`'complete'` or `'error'`). Each `runOnce` call honours the
        // cycle budget so very large graphs progress in chunks rather
        // than blocking the rpc. Codex review fix — only `'complete'` /
        // `'error'` exits the loop; `'budget_exhausted'` (the post-fix
        // yield reason for "batch full, more pending") drives another
        // iteration so a multi-batch full-scan doesn't bail after the
        // first 200 contacts.
        for (let i = 0; i < 50; i++) {
          const cycle = await scheduler.runOnce({
            task_id: CONTACT_MERGE_CANDIDATE_SCAN_TASK_ID,
          });
          const taskResult = cycle.per_task.find(
            (p) => p.task_id === CONTACT_MERGE_CANDIDATE_SCAN_TASK_ID,
          );
          if (!taskResult) break;
          cycleIterations += 1;
          // Narrow the yield reason to the rpc-surfaced closed list.
          // `'dependency_pending'` / `'pool_policy_unsatisfiable'`
          // don't apply to this deterministic core task.
          if (
            taskResult.yield_reason === 'budget_exhausted' ||
            taskResult.yield_reason === 'no_work'
          ) {
            yieldReason = taskResult.yield_reason;
          }
          if (taskResult.status !== 'yield') break;
        }
      } finally {
        setActiveScanMode('delta');
      }
      const surfacedRow = sqlite.prepare(
        `SELECT COUNT(*) AS c FROM contact_merge_candidate_queue
            WHERE detected_by = 'housekeeping'
              AND detected_at >= ?`,
      ).get(startTs) as { c: number } | undefined;
      const surfaced_count = surfacedRow?.c ?? 0;
      return {
        iterated: cycleIterations,
        surfaced_count,
        ...(yieldReason !== undefined ? { yield_reason: yieldReason } : {}),
      };
    };
  }

  // D-205 — supply the hook D-138 declared and nothing ever provided.
  //
  // Both identities are passed, and each for its own reason:
  //   · the LOSERS — their perspective rows are keyed on an identity that no longer
  //     exists, so they are stale by construction;
  //   · the SURVIVOR — its rows must recompute to absorb what the merge just handed it
  //     (C-2's projection reads ACROSS the merge group, so the survivor's aggregates
  //     genuinely change even though nothing MOVED between contacts — D-205 rule 2).
  //
  // Safe by construction: `cascadeForIdentityChange` marks rows stale and ENQUEUES a
  // recompute — it deletes nothing, and its per-identity rate governor bounds the fan-out.
  // Worst case is a redundant recompute; the status quo is a silently wrong aggregate.
  //
  // `source_id` is observability-only here (the cascade passes it to `fireNotifier` and
  // never keys on it), so the survivor's canonical email is the honest label for "which
  // merge caused this".
  const onIdentityChanged: ContactMergeRpcDeps['onIdentityChanged'] | undefined =
    enrichmentCascade
      ? ({ survivor_email, loser_emails }) => {
          enrichmentCascade.cascadeForIdentityChange('contact', survivor_email, [
            survivor_email,
            ...loser_emails,
          ]);
        }
      : undefined;

  const contactMergeDeps: ContactMergeRpcDeps = {
    contactStore,
    ...(annotationStore ? { annotationStore } : {}),
    ...(promptStore ? { promptStore } : {}),
    emitMergeCandidate,
    ...(runScanNow ? { runScanNow } : {}),
    ...(onIdentityChanged ? { onIdentityChanged } : {}),
  };

  return { contactMergeDeps };
};
