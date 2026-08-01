/**
 * Convert automation failures into text that is safe to persist on the
 * user-facing Automation surface. Most execution errors are already useful to
 * the owner and pass through unchanged. Producer/policy invariants are server
 * defects, however, so their implementation details stay in server logs.
 */

export const AUTOMATION_PERMISSION_FAILURE_MESSAGE =
  'Recued stopped this automation because the required permissions could not be verified. The blocked action was not run.';

export interface AutomationFailurePresentation {
  /** Safe for schedule/trigger/auto-run status rows. */
  userMessage: string;
  /** Exact diagnostic retained for server logging. */
  internalMessage: string;
  /** True when userMessage intentionally replaces internalMessage. */
  redacted: boolean;
}

const failureMessage = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure);

const isContractSnapshotInvariant = (message: string): boolean =>
  message.includes('requires a ContractSnapshot')
  && (
    message.includes('gateRecipeAgainstPolicy')
    || message.includes('evaluatePreflightAdmission')
  );

export const presentAutomationFailure = (
  failure: unknown,
): AutomationFailurePresentation => {
  const internalMessage = failureMessage(failure);
  const redacted = isContractSnapshotInvariant(internalMessage);
  return {
    userMessage: redacted
      ? AUTOMATION_PERMISSION_FAILURE_MESSAGE
      : internalMessage,
    internalMessage,
    redacted,
  };
};
