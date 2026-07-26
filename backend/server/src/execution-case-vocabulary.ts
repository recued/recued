/** Shared closed vocabularies used across the D-214 compiler and experiment.
 * Keep classifications here so learning and measurement cannot silently
 * interpret the same stored activity differently. */

export const OUTCOME_REPORT_TOOL_NAME = 'outcome.report';
export const REQUEST_DISSECTION_TOOL_NAME = 'request.dissection';

export const D214_INTERNAL_TOOL_NAMES: ReadonlySet<string> = new Set([
  OUTCOME_REPORT_TOOL_NAME,
  REQUEST_DISSECTION_TOOL_NAME,
]);

export const EXECUTION_CASE_GATEWAY_DENIAL_REASONS = [
  'classification_blocked',
  'contract_denied',
  'policy_denied',
  'destructive_denied',
  'channel_denied',
] as const;

const EXECUTION_CASE_GATEWAY_DENIAL_REASON_SET: ReadonlySet<string> = new Set(
  EXECUTION_CASE_GATEWAY_DENIAL_REASONS,
);

export const isExecutionCaseGatewayDenialReason = (
  reason: string | undefined,
): boolean =>
  reason !== undefined
  && EXECUTION_CASE_GATEWAY_DENIAL_REASON_SET.has(reason);
