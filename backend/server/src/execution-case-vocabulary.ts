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

/** Dispatch reasons meaning the call was REJECTED BEFORE IT RAN.
 *
 *  ⛔⛔ NOTHING EXECUTED, SO THE FLOW DID NOT BREAK — and that distinction is the
 *  whole point. `ungroundedArgumentsInCall` refuses a call whose identifier
 *  argument the model could not have read, and the refusal is INSTRUCTIVE: it
 *  names the argument, says the value was not in anything the model was given,
 *  and tells it to run the step that returns it first. The model then corrects
 *  and proceeds.
 *
 *  Filing that as `execution_failure` was wrong in the same way the ATTRIBUTION
 *  GATE already refuses a stopwatch: it teaches "this flow does not work" about
 *  a flow that was stopped for a fixable reason and then worked. Measured on
 *  bench 181 — a run whose `open-rental-contract` was refused for
 *  `unit_id = "<pending from add-unit>"` filed `execution_failure` and was
 *  excluded by D-219 slice 3, even though the substrate had done exactly its job
 *  and nothing was written.
 *
 *  ⚠ SCOPED TO NON-DISPATCH, not to "an error we would rather ignore". A call
 *  that RAN and failed is still a real `execution_failure`; this covers only the
 *  ones the engine refused to send. ⚠ It does not manufacture positive evidence
 *  either — a turn whose only activity was a refusal still carries no polarity
 *  and still cannot be offered. */
export const EXECUTION_CASE_UNDISPATCHED_REASONS = [
  'invalid_args',
] as const;

const EXECUTION_CASE_UNDISPATCHED_REASON_SET: ReadonlySet<string> = new Set(
  EXECUTION_CASE_UNDISPATCHED_REASONS,
);

/** True when the activity was refused BEFORE dispatch — see the note above. */
export const isExecutionCaseUndispatchedReason = (
  reason: string | undefined,
): boolean =>
  reason !== undefined
  && EXECUTION_CASE_UNDISPATCHED_REASON_SET.has(reason);
