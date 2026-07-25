/** D-157 server-wiring — `InDoubtAnnotationWriter` implementation.
 *
 *  The `@recued/gateway` in-doubt P0 leaf
 *  (`packages/gateway/src/in-doubt-reconciliation.ts`) defines the
 *  `InDoubtAnnotationWriter` interface: a single
 *  `writeReconciliation(annotation)` call that persists a fresh
 *  off-commit `data.memory` annotation linked to an `in_doubt` commit
 *  (D-157 § N.2 / A.1 step 2 / I-9).
 *
 *  The leaf can't reach `backend/server/storage/annotation-store.ts`
 *  (public-boundary rule); this module is the host side of the seam.
 *
 *  Idempotency (codex MAJOR 3 fold). The notification block's
 *  `on_answer` is at-least-once, so a crash between the writer call
 *  and `block.markHandled` re-dispatches the same payload on next
 *  boot. The annotation identity is
 *  `(target_collection='commit', target_id=commit_id, key='in_doubt_reconciliation')`
 *  — the same triple the gateway leaf's `IN_DOUBT_TARGET_COLLECTION`
 *  + `IN_DOUBT_ANNOTATION_KEY` constants fix. The underlying SQLite
 *  annotation table doesn't enforce a UNIQUE on that triple today, so
 *  we read the triple's existing rows first and short-circuit when
 *  a reconciliation row already exists for the commit. A duplicate
 *  answer attempt (rare crash-retry window) is a no-op rather than a
 *  second row.
 *
 *  Spec: D-157 § A.1 / I-3 / I-9; the gateway-side
 *  contract is `packages/gateway/src/in-doubt-reconciliation.ts`.
 */

import type {
  InDoubtAnnotationWriter,
  InDoubtReconciliationAnnotation,
} from '@recued/gateway';
import {
  IN_DOUBT_ANNOTATION_KEY,
  IN_DOUBT_TARGET_COLLECTION,
} from '@recued/gateway';
import type { AnnotationStore } from './storage/annotation-store.js';

/** Synthetic `authored_by_recipe_id` carried on a gateway-authored
 *  reconciliation annotation. The annotation is not produced by any
 *  recipe — the gateway emits it directly out of an `on_answer`
 *  callback — but the underlying `AnnotateInput` requires a non-empty
 *  recipe id. The constant identifies the source unambiguously so
 *  audit consumers can filter or treat reconciliation rows distinctly.
 *  Not a real recipe slug — the `recued/` prefix matches the
 *  RESERVED_HANDLES kernel namespace (CLAUDE.md § Publisher Namespaces),
 *  signalling "engine-emitted, not author-installable". */
export const GATEWAY_IN_DOUBT_AUTHOR_ID = 'recued/in-doubt-reconciliation';

/** Build an `InDoubtAnnotationWriter` over `recued-server`'s
 *  `AnnotationStore`. */
export const createInDoubtAnnotationWriter = (
  store: AnnotationStore,
): InDoubtAnnotationWriter => ({
  async writeReconciliation(
    annotation: InDoubtReconciliationAnnotation,
  ): Promise<void> {
    // Codex MAJOR 3 fold — read-modify guard against duplicate writes.
    // `annotationsForRecord` returns the latest row per
    // `(target_collection, target_id, key)` triple — last write wins
    // semantically, but the underlying SQLite table accumulates rows
    // (no UNIQUE constraint on the triple). An at-least-once
    // `on_answer` retry would otherwise insert a second physical row.
    // Skip the write when a reconciliation already exists for this
    // commit; the in-doubt path has no payload that legitimately needs
    // a re-write (the answer is decisive, recorded once).
    //
    // Single-process invariant: only the daemon holding the lifecycle
    // lock writes here, so the read-modify-write is race-free in
    // practice. A future multi-writer scenario would need a stronger
    // primitive (a UNIQUE index or an upsert-keyed annotate).
    const existing = await store.annotationsForRecord(
      IN_DOUBT_TARGET_COLLECTION,
      annotation.commit_id,
    );
    if (existing.some((row) => row.key === IN_DOUBT_ANNOTATION_KEY)) {
      // Already reconciled — at-least-once retry. No-op.
      return;
    }

    // The leaf's `InDoubtReconciliationAnnotation` carries the link
    // keys + answer payload; we add the bookkeeping stamps the
    // underlying `AnnotateInput` requires:
    //   - `authored_by_recipe_id`: the synthetic gateway author id.
    //   - `source_record_hash`: the `commit_id` itself — uniquely
    //     identifies the source commit being reconciled, doubles as
    //     the cache key for staleness-eviction reads on the commit.
    //   - `recipe_hash`: a stable constant; there is no recipe to
    //     hash. Distinct from any real recipe hash so a downstream
    //     evict-on-stale comparison treats reconciliation rows as
    //     immutable.
    //
    // The value payload echoes the link keys (I-9: explicit link so
    // `data.timeline()` surfaces the row) + the answer + the
    // bistemporal `event_at` matches the commit's `dispatched_at`.
    await store.annotate({
      target_collection: IN_DOUBT_TARGET_COLLECTION,
      target_id: annotation.commit_id,
      key: IN_DOUBT_ANNOTATION_KEY,
      value: {
        answer: annotation.answer,
        answered_at: annotation.answered_at,
        commit_id: annotation.commit_id,
        correlation_id: annotation.correlation_id,
      },
      authored_by_recipe_id: GATEWAY_IN_DOUBT_AUTHOR_ID,
      source_record_hash: annotation.commit_id,
      recipe_hash: 'gateway-in-doubt-reconciliation',
      event_at: annotation.event_at,
    });
  },
});
