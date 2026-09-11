/** D-157 P0 — the `in_doubt` reconciliation flow (gateway-side leaf).
 *
 *  D-153 makes `in_doubt` a normal outcome: any irreversible call that
 *  crashes mid-dispatch leaves a `pending` commit the boot sweep
 *  (`sweepPendingToInDoubt`) flags `in_doubt` — the honest "we don't
 *  know whether the side effect reached the outside world". D-157 P0 is
 *  the missing half: turning that `in_doubt` commit into a question for
 *  the user, and recording their answer.
 *
 *  The flow (A.1) — no recipe at either end:
 *
 *    in_doubt commit
 *      → gateway: notification.ask("We tried X, crashed before
 *        confirming — did it go through?", [Sent / No — retry / Skip],
 *        handler kind `gateway.in_doubt`)
 *      → user answers (any channel, durable across a restart)
 *      → on_answer → a fresh off-commit `data.memory` annotation
 *        linked to the commit (`commit_id` / `correlation_id`)
 *
 *  Invariants this leaf upholds:
 *   - I-1  the gateway names no channel — it only calls `ask` /
 *          `registerAskHandler` on the injected `InDoubtNotifier`; the
 *          interface has no channel surface to name.
 *   - I-2  no auto-resume — the answer handler only writes an
 *          annotation; `No — retry` re-dispatches NOTHING. The handler
 *          structurally has no dispatcher.
 *   - I-3  the commit log is append-only — the answer is a fresh
 *          annotation; this leaf never touches a commit row.
 *   - I-9  the annotation links to its commit (`commit_id` /
 *          `correlation_id`) so it surfaces in `data.timeline()`.
 *
 *  This module is the pure leaf — the `InDoubtNotifier` (the D-158
 *  notification block) and the `InDoubtAnnotationWriter` (the
 *  server-side `data.memory` writer) are both injected. Wiring the boot
 *  sweep + the real implementations into `recued-server` is the
 *  deferred D-157 server-wiring slice.
 *
 *  Spec: D-157 § N.2 / A.1 / I-1..I-3 / I-9.
 */

import type { Commit } from '@recued/contracts';
import type {
  Answer,
  AskHandlerFn,
  AskHandlerKind,
  AskHandlerRef,
  AskOption,
  NotificationMessage,
} from '@recued/notification';

// ────────────────────────────────────────────────────────────────
// Vocabulary — the constants that name the `in_doubt` flow
// ────────────────────────────────────────────────────────────────

/** The `AskHandlerKind` the gateway registers with the notification
 *  block for `in_doubt` reconciliation answers (A.1 / A.3). The block
 *  persists this slug — never a closure — and re-dispatches an answer to
 *  the function registered under it, so the handler survives the
 *  restart between an outstanding ask and its answer (I-5-shaped
 *  durability; D-158 N.3). */
export const IN_DOUBT_HANDLER_KIND: AskHandlerKind = 'gateway.in_doubt';

/** The annotation `key` of an `in_doubt` reconciliation memory row
 *  (A.1 — `{ kind: 'in_doubt_reconciliation', ... }`). */
export const IN_DOUBT_ANNOTATION_KEY = 'in_doubt_reconciliation';

/** The annotation `target_collection` for an `in_doubt` reconciliation.
 *  An off-commit annotation has no warehouse entity of its own; it
 *  targets the commit so `data.timeline('commit:<commit_id>')` surfaces
 *  it (I-9 / N.6). There is no `commits` collection in the warehouse
 *  graph — `data.timeline()`'s annotation loader keys purely on
 *  `(target_collection, target_id)`, so this synthetic collection name
 *  needs no schema change. */
export const IN_DOUBT_TARGET_COLLECTION = 'commit';

/** The three answers an `in_doubt` ask offers (N.8 SHOULD):
 *   - `sent`  — the user confirms the action reached the outside world.
 *   - `retry` — it did not complete; the user will trigger a fresh
 *               recipe run themselves. The gateway re-dispatches
 *               NOTHING (I-2 / TR-2 — no auto-resume, ever).
 *   - `skip`  — assume it failed; take no further action.
 *  All three record the same shape — a linked off-commit annotation
 *  (A.1); they differ only in the recorded `answer`. */
export const IN_DOUBT_ASK_OPTIONS: readonly AskOption[] = [
  { id: 'sent', label: 'Sent' },
  { id: 'retry', label: 'No — retry' },
  { id: 'skip', label: 'Skip' },
];

// ────────────────────────────────────────────────────────────────
// Injected seams — the leaf depends on interfaces, not the server
// ────────────────────────────────────────────────────────────────

/** The off-commit `data.memory` annotation an `in_doubt` answer
 *  produces (A.1 / N.2 step 2). A fresh annotation row — the commit row
 *  itself is NEVER mutated (I-3, append-only log). It carries the
 *  answer and the link keys back to the commit so it surfaces in
 *  `data.timeline()` (I-9 / N.6) and backs the "clear the
 *  reconciliation queue" query. */
export interface InDoubtReconciliationAnnotation {
  /** The `in_doubt` commit being reconciled. The annotation targets
   *  `${IN_DOUBT_TARGET_COLLECTION}:${commit_id}` AND echoes this id in
   *  the annotation value as a link key (I-9 / TR-11). */
  commit_id: string;
  /** The commit's `correlation_id` — the second link key (N.2 step 2). */
  correlation_id: string;
  /** The chosen answer — one of `IN_DOUBT_ASK_OPTIONS`' `id`s
   *  (`'sent'` / `'retry'` / `'skip'`). Recorded verbatim: the answer
   *  is honest history, not a branch. */
  answer: string;
  /** Unix-ms the answer was recorded (D-158 `Answer.answered_at`) — the
   *  annotation's ingestion-time provenance. */
  answered_at: number;
  /** The commit's `dispatched_at` — the bistemporal `event_at` (D-120
   *  Phase 7.5): the real-world moment the uncertain action was
   *  attempted, so `data.timeline()`'s event-axis sort places the
   *  reconciliation against when it happened, not when it was answered. */
  event_at: number;
}

/** The narrow annotation-writing seam this leaf needs. `@recued/gateway`
 *  is a `packages/`-side leaf and cannot reach the server-side
 *  `AnnotationStore`; the deferred D-157 server-wiring slice injects an
 *  implementation.
 *
 *  That implementation MUST persist the record as a fresh annotation:
 *    target_collection = IN_DOUBT_TARGET_COLLECTION  (`'commit'`)
 *    target_id         = commit_id
 *    key               = IN_DOUBT_ANNOTATION_KEY     (`'in_doubt_reconciliation'`)
 *    value             = { answer, answered_at, commit_id, correlation_id }
 *    event_at          = event_at
 *  upsert-keyed on `(target_collection, target_id, key)` so the
 *  notification block's at-least-once `on_answer` dispatch yields
 *  exactly one reconciliation row per commit. It MUST NOT touch the
 *  commit row (I-3). */
export interface InDoubtAnnotationWriter {
  writeReconciliation(
    annotation: InDoubtReconciliationAnnotation,
  ): Promise<void>;
}

/** The narrow notification-block seam this leaf calls — the subset of
 *  the D-158 `NotificationBlock` the `in_doubt` flow uses. A
 *  `NotificationBlock` satisfies it structurally. Channel-agnostic by
 *  construction (I-1): the interface offers only `ask` + an `on_answer`
 *  registration; channel fan-out is entirely the block's concern. */
export interface InDoubtNotifier {
  ask(
    message: NotificationMessage,
    options: readonly AskOption[],
    handler: AskHandlerRef,
  ): Promise<{ ask_id: string }>;
  registerAskHandler(kind: AskHandlerKind, handler: AskHandlerFn): void;
}

// ────────────────────────────────────────────────────────────────
// The flow
// ────────────────────────────────────────────────────────────────

/** The three components of an `in_doubt` `notification.ask`, ready to
 *  pass straight to `InDoubtNotifier.ask(...)`. */
export interface InDoubtAsk {
  message: NotificationMessage;
  options: readonly AskOption[];
  handler: AskHandlerRef;
}

/** Build the `notification.ask` for one `in_doubt` commit (A.1).
 *
 *  The handler `payload` carries exactly what the durable `on_answer`
 *  handler needs to write the reconciliation annotation — `commit_id` +
 *  `correlation_id` (the link keys, I-9) and `dispatched_at` (the
 *  bistemporal `event_at`). It is JSON-serialisable: the block persists
 *  the payload, never a closure (D-158 I-4). */
export const buildInDoubtAsk = (
  commit: Commit,
  /** ⚠ OPTIONAL, AND ITS ABSENCE IS THE OLD SENTENCE. Without it this asks about
   *  “salesforce-catalog” (salesforce-catalog) — `commit.tool` and
   *  `commit.ingredient` are BOTH the catalog slug for a catalog dispatch, so
   *  the owner was asked whether an entire vendor integration completed. With
   *  the manifest the same commit names the actual operation. */
  describe?: (commit: Commit) => string | null,
): InDoubtAsk => {
  const dispatchedIso = new Date(commit.dispatched_at).toISOString();
  const named = describe?.(commit) ?? null;
  const message: NotificationMessage = {
    title: 'Unconfirmed action',
    text:
      `Recued dispatched ${named !== null ? `“${named}”` : `“${commit.tool}” (${commit.ingredient})`} at `
      + `${dispatchedIso}, then crashed before the outcome could be `
      + `confirmed. Did it complete?`,
  };
  const handler: AskHandlerRef = {
    kind: IN_DOUBT_HANDLER_KIND,
    payload: {
      commit_id: commit.commit_id,
      correlation_id: commit.correlation_id,
      dispatched_at: commit.dispatched_at,
    },
  };
  return { message, options: IN_DOUBT_ASK_OPTIONS, handler };
};

/** Build the durable `on_answer` handler for `in_doubt` reconciliation
 *  answers (A.1 step 2-3). When the user answers — on any channel, now
 *  or after a restart — the handler records the answer as a fresh
 *  off-commit `data.memory` annotation linked to the commit.
 *
 *  No-auto-resume (I-2 / TR-2) holds by construction: the handler's
 *  only capability is `writer.writeReconciliation`. `sent`, `retry`,
 *  and `skip` all flow through that one call — `retry` re-dispatches
 *  nothing because there is nothing here that *could* dispatch.
 *
 *  The notification block dispatches `on_answer` at least once (a crash
 *  between recording the answer and marking it handled re-dispatches on
 *  boot); the upsert contract on `InDoubtAnnotationWriter` makes a
 *  re-run idempotent. */
export const createInDoubtAnswerHandler = (
  writer: InDoubtAnnotationWriter,
): AskHandlerFn => {
  return async (payload: Record<string, unknown>, answer: Answer) => {
    const commitId = payload.commit_id;
    const correlationId = payload.correlation_id;
    const dispatchedAt = payload.dispatched_at;
    if (
      typeof commitId !== 'string'
      || typeof correlationId !== 'string'
      || typeof dispatchedAt !== 'number'
      || !Number.isFinite(dispatchedAt)
    ) {
      throw new Error(
        'in_doubt reconciliation handler: malformed payload — expected '
          + '{ commit_id: string, correlation_id: string, '
          + 'dispatched_at: finite number }',
      );
    }
    await writer.writeReconciliation({
      commit_id: commitId,
      correlation_id: correlationId,
      answer: answer.option,
      answered_at: answer.answered_at,
      event_at: dispatchedAt,
    });
  };
};

/** Register the `gateway.in_doubt` `on_answer` handler with the
 *  notification block. Call once at boot, before live traffic — the
 *  block re-dispatches a persisted answer to the function registered
 *  here (the registration is per-process; the persisted
 *  `(kind, payload)` is what is durable). */
export const registerInDoubtHandler = (
  notifier: InDoubtNotifier,
  writer: InDoubtAnnotationWriter,
): void => {
  notifier.registerAskHandler(
    IN_DOUBT_HANDLER_KIND,
    createInDoubtAnswerHandler(writer),
  );
};

/** Outcome of a `raiseInDoubtAsks` batch — best-effort per commit. */
export interface RaiseInDoubtResult {
  /** `ask_id` of every ask successfully raised — one per reconciled
   *  commit. */
  ask_ids: readonly string[];
  /** `commit_id`s passed in whose `status` was not `in_doubt` — skipped
   *  without raising an ask. */
  skipped: readonly string[];
  /** `commit_id`s whose ask could not be raised (`notifier.ask` threw —
   *  e.g. a persistence failure). The caller logs these; the commit
   *  stays `in_doubt` and unreconciled. */
  failed: readonly string[];
}

/** Raise one `in_doubt` `notification.ask` per commit (A.1 step 1).
 *
 *  The boot sweep (`sweepPendingToInDoubt`) and a runtime
 *  `recordOutcome` failure both produce `in_doubt` commits; this is the
 *  single entry point that turns either into user-facing questions.
 *  Best-effort per commit: a non-`in_doubt` commit is skipped, and a
 *  `notifier.ask` failure for one commit does not abort the batch (boot
 *  must not fail because one ask could not be persisted).
 *
 *  Not idempotent per commit — it raises one ask per call per commit.
 *  The caller is responsible for passing each commit at most once; the
 *  boot sweep does so naturally (it is itself idempotent and returns
 *  each swept commit once). */
export const raiseInDoubtAsks = async (
  notifier: InDoubtNotifier,
  commits: readonly Commit[],
  /** Names the operation instead of the catalog slug. Absent ⇒ prior wording. */
  describe?: (commit: Commit) => string | null,
): Promise<RaiseInDoubtResult> => {
  const askIds: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  for (const commit of commits) {
    if (commit.status !== 'in_doubt') {
      skipped.push(commit.commit_id);
      continue;
    }
    const { message, options, handler } = buildInDoubtAsk(commit, describe);
    try {
      const { ask_id } = await notifier.ask(message, options, handler);
      askIds.push(ask_id);
    } catch {
      failed.push(commit.commit_id);
    }
  }
  return { ask_ids: askIds, skipped, failed };
};
