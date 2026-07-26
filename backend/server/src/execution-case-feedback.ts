/** D-214 explicit product feedback producer.
 *
 * The caller names an anchored turn, never a case. The server resolves the
 * durable span root, records or retracts one exact typed fact with no free text,
 * and recompiles any already-closed report for that root. Feedback remains
 * independent of model reporting and can be corrected by the owner.
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
  CaseInterventionStore,
} from './storage/case-intervention-store.js';
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

export type ExecutionCaseFeedbackRetractResult =
  | { ok: true; retracted: boolean }
  | {
      ok: false;
      reason: 'span_not_found' | 'plan_not_in_span';
    };

export interface ExecutionCaseFeedbackTarget {
  session_id: string;
  turn_id: string;
  kind: ExecutionCaseFeedbackKind;
  source_plan_id?: string;
}

export interface ExecutionCaseFeedbackRecorder {
  record(
    input: ExecutionCaseFeedbackTarget,
  ): Promise<ExecutionCaseFeedbackRecordResult>;
  retract(
    input: ExecutionCaseFeedbackTarget,
  ): Promise<ExecutionCaseFeedbackRetractResult>;
}

export const createExecutionCaseFeedbackRecorder = (deps: {
  anchorStore: ExecutionSpanAnchorStore;
  feedbackStore: ExecutionCaseFeedbackStore;
  reportStore: ExecutionReportStore;
  caseStore: ExecutionCaseStore;
  interventionStore: Pick<CaseInterventionStore, 'deleteForCase'>;
  compiler: ExecutionCaseCompiler;
  now?: () => number;
}): ExecutionCaseFeedbackRecorder => {
  const resolveTarget = (
    input: ExecutionCaseFeedbackTarget,
  ):
    | { ok: true; root_request_id: string; feedback_id: string }
    | {
        ok: false;
        reason: 'span_not_found' | 'plan_not_in_span';
      } => {
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
    return {
      ok: true,
      root_request_id: rootRequestId,
      feedback_id:
        `feedback_${hashExecutionCaseValue([
          rootRequestId,
          input.kind,
          input.source_plan_id ?? '',
        ]).slice(0, 32)}`,
    };
  };

  const reprojectClosedReports = async (
    root_request_id: string,
  ): Promise<void> => {
    // Re-project closed sources in-place. Deleting by report also removes every
    // per-flow observation, so a changed feedback axis cannot leave a stale
    // sibling observation behind.
    const affectedCaseIds = new Set<string>();
    for (const stored of await deps.reportStore.listForRoot(root_request_id)) {
      if (stored.closed_at === undefined) continue;
      for (const caseId of deps.caseStore.deleteUnsupported(
        stored.report.report_id,
      )) {
        affectedCaseIds.add(caseId);
      }
      await deps.compiler.compileReport(stored.report.report_id);
    }
    // Feedback can be the sole strong signal admitting a case. Match the
    // privacy/source-deletion coordinator: once the complete reprojection has
    // settled, remove intervention rows whose evidence now names a vanished
    // case so an owner's correction cannot become a later render mismatch.
    for (const caseId of affectedCaseIds) {
      if (await deps.caseStore.get(caseId)) continue;
      await deps.interventionStore.deleteForCase(caseId);
    }
  };

  return {
    async record(input) {
      const target = resolveTarget(input);
      if (!target.ok) return target;
      const recorded = deps.feedbackStore.record({
        feedback_id: target.feedback_id,
        root_request_id: target.root_request_id,
        session_id: input.session_id,
        kind: input.kind,
        ...(input.source_plan_id !== undefined
          ? { source_plan_id: input.source_plan_id }
          : {}),
        recorded_at: deps.now?.() ?? Date.now(),
      });
      if (!recorded) return { ok: true, recorded: false };
      await reprojectClosedReports(target.root_request_id);
      return { ok: true, recorded: true };
    },

    async retract(input) {
      const target = resolveTarget(input);
      if (!target.ok) return target;
      const retracted = deps.feedbackStore.deleteExact({
        feedback_id: target.feedback_id,
        root_request_id: target.root_request_id,
      });
      if (!retracted) return { ok: true, retracted: false };
      await reprojectClosedReports(target.root_request_id);
      return { ok: true, retracted: true };
    },
  };
};
