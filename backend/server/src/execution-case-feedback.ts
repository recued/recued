/** D-214 explicit product feedback producer.
 *
 * The caller names a same-session turn, never a case. The server resolves the
 * durable span root, records a typed fact with no free text, and recompiles any
 * already-closed report for that root so feedback is additive to (not a
 * replacement for) model reporting.
 */

import {
  type ExecutionCaseFeedbackKind,
} from '@recued/contracts';

import {
  hashExecutionCaseValue,
} from './execution-case-core.js';
import type {
  ExecutionCaseCompiler,
} from './execution-case-compiler.js';
import type {
  ExecutionCaseFeedbackStore,
} from './storage/execution-case-feedback-store.js';
import type {
  ExecutionCaseStore,
} from './storage/execution-case-store.js';
import type {
  ExecutionReportStore,
} from './storage/execution-report-store.js';
import type {
  ExecutionSpanAnchorStore,
} from './storage/execution-span-anchor-store.js';

export type ExecutionCaseFeedbackRecordResult =
  | { ok: true; recorded: boolean }
  | {
      ok: false;
      reason: 'span_not_found' | 'plan_not_in_span';
    };

export interface ExecutionCaseFeedbackRecorder {
  record(input: {
    session_id: string;
    turn_id: string;
    kind: ExecutionCaseFeedbackKind;
    source_plan_id?: string;
  }): Promise<ExecutionCaseFeedbackRecordResult>;
}

export const createExecutionCaseFeedbackRecorder = (deps: {
  anchorStore: ExecutionSpanAnchorStore;
  feedbackStore: ExecutionCaseFeedbackStore;
  reportStore: ExecutionReportStore;
  caseStore: ExecutionCaseStore;
  compiler: ExecutionCaseCompiler;
  now?: () => number;
}): ExecutionCaseFeedbackRecorder => ({
  async record(input) {
    const rootRequestId =
      deps.compiler.resolveRootForClose(input.session_id, input.turn_id)
      ?? deps.anchorStore.resolveRoot(input.session_id, input.turn_id);
    if (!rootRequestId) {
      return { ok: false, reason: 'span_not_found' };
    }
    const root = deps.anchorStore.getRoot(rootRequestId);
    if (!root) {
      return { ok: false, reason: 'span_not_found' };
    }
    // `resolveRootForClose` and the fallback anchor both start from this exact
    // `(session_id, turn_id)`. The root's own `session_id` names the initiating
    // stream and may legitimately differ after an explicit continuation.
    if (
      input.source_plan_id !== undefined
      && !deps.compiler.resolveSpan(rootRequestId).plans.some((plan) =>
        plan.plan_id === input.source_plan_id)
    ) {
      return { ok: false, reason: 'plan_not_in_span' };
    }
    const recorded = deps.feedbackStore.record({
      feedback_id:
        `feedback_${hashExecutionCaseValue([
          rootRequestId,
          input.kind,
          input.source_plan_id ?? '',
        ]).slice(0, 32)}`,
      root_request_id: rootRequestId,
      session_id: input.session_id,
      kind: input.kind,
      ...(input.source_plan_id !== undefined
        ? { source_plan_id: input.source_plan_id }
        : {}),
      recorded_at: deps.now?.() ?? Date.now(),
    });
    if (!recorded) return { ok: true, recorded: false };

    // Re-project closed sources in-place. Deleting by report also removes every
    // per-flow observation, so a changed feedback axis cannot leave a stale
    // sibling observation behind.
    for (const stored of await deps.reportStore.listForRoot(rootRequestId)) {
      if (stored.closed_at === undefined) continue;
      deps.caseStore.deleteUnsupported(stored.report.report_id);
      await deps.compiler.compileReport(stored.report.report_id);
    }
    return { ok: true, recorded: true };
  },
});
