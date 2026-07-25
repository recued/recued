/** Trusted deterministic-verification producer for D-214. */

import { hashExecutionCaseValue } from './execution-case-core.js';
import type {
  ExecutionCaseCompiler,
} from './execution-case-compiler.js';
import type {
  ExecutionCaseStore,
} from './storage/execution-case-store.js';
import type {
  ExecutionReportStore,
} from './storage/execution-report-store.js';
import type {
  ExecutionSpanAnchorStore,
} from './storage/execution-span-anchor-store.js';
import type {
  ExecutionCaseVerificationKind,
  ExecutionCaseVerificationStore,
} from './storage/execution-case-verification-store.js';

export interface ExecutionCaseVerificationRecorder {
  record(input: {
    session_id: string;
    turn_id: string;
    kind: ExecutionCaseVerificationKind;
    postcondition_key: string;
    source_event_id: string;
  }): Promise<{ recorded: boolean } | { recorded: false; missing_span: true }>;
}

export const createExecutionCaseVerificationRecorder = (deps: {
  anchorStore: ExecutionSpanAnchorStore;
  verificationStore: ExecutionCaseVerificationStore;
  reportStore: ExecutionReportStore;
  caseStore: ExecutionCaseStore;
  compiler: ExecutionCaseCompiler;
  now?: () => number;
}): ExecutionCaseVerificationRecorder => ({
  async record(input) {
    const rootRequestId =
      deps.compiler.resolveRootForClose(input.session_id, input.turn_id)
      ?? deps.anchorStore.resolveRoot(input.session_id, input.turn_id);
    const root = rootRequestId
      ? deps.anchorStore.getRoot(rootRequestId)
      : undefined;
    if (!rootRequestId || !root) {
      return { recorded: false, missing_span: true };
    }
    // The exact current turn anchor/correlation is the authority. A root keeps
    // the session that initiated it, so equality here would reject a legitimate
    // continuation in another stream.
    const recorded = deps.verificationStore.record({
      verification_id:
        `verification_${hashExecutionCaseValue([
          rootRequestId,
          input.postcondition_key,
          input.source_event_id,
        ]).slice(0, 32)}`,
      root_request_id: rootRequestId,
      session_id: input.session_id,
      kind: input.kind,
      postcondition_key: input.postcondition_key,
      source_event_id: input.source_event_id,
      recorded_at: deps.now?.() ?? Date.now(),
    });
    if (!recorded) return { recorded: false };
    for (const stored of await deps.reportStore.listForRoot(rootRequestId)) {
      if (stored.closed_at === undefined) continue;
      deps.caseStore.deleteUnsupported(stored.report.report_id);
      await deps.compiler.compileReport(stored.report.report_id);
    }
    return { recorded: true };
  },
});
