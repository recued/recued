/** D-145 PB15 — Engine Failure Semantics substrate barrel.
 *
 *  Per § B.15.1-§ B.15.11 + § C.3.3. The closed-list scaffolding the
 *  engine uses to:
 *    - Map every halt PlanStatus to its canonical FailureClass.
 *    - Compose a truthful + actionable user_response per halt path.
 *    - Build the four PB15-specific Transparency Stream events
 *      (`ai_call.malformed` / `ai_call.giving_up_malformed` /
 *      `privacy.hard_fail` / `capacity_gap_mid_run`).
 *    - Run the privacy hard-fail runtime guard before AI packet
 *      composition.
 *    - Wrap `ai.synthesize` in the at-most-2-attempts malformed retry
 *      helper.
 *    - Decide approval / capacity / replay / bridge-disconnect paths.
 *    - Surface partial-primitive-failure coverage metadata.
 *
 *  Spec: § B.15 + § C.3.3 + § B.15.11 summary table. */

export {
  PLAN_STATUS_TO_FAILURE_CLASS,
  failureClassForStatus,
} from './failure-class-map.js';

export {
  USER_RESPONSE_TEMPLATES,
  userResponseForStatus,
  type HaltPlanStatus,
} from './user-response-templates.js';

export {
  composeFailureResult,
  type ComposeFailureInput,
  type ComposedFailureResult,
} from './compose-failure-result.js';

export {
  buildAiCallMalformedEvent,
  buildAiCallGivingUpMalformedEvent,
  buildPrivacyHardFailEvent,
  buildCapacityGapMidRunEvent,
} from './event-builders.js';

export {
  checkPrivacyContext,
  type PrivacyGuardInput,
  type PrivacyGuardResult,
  type PrivacyGuardOk,
  type PrivacyGuardViolation,
} from './privacy-guard.js';

export {
  withMalformedAiRetry,
  MALFORMED_AI_RETRY_PROMPT_NOTE,
  type MalformedAiRetryInput,
  type MalformedAiRetryResult,
  type MalformedAiRetryOk,
  type MalformedAiRetryDegraded,
  type SalvageExtractor,
  type ValidateAiResult,
} from './malformed-ai-retry.js';

export {
  mapApprovalDecision,
  type ApprovalHaltKind,
  type ApprovalMappingResult,
  type ApprovalMappingOk,
  type ApprovalMappingHalt,
} from './approval-mapping.js';

export {
  composePartialCoverage,
  decidePartialCoverageHalt,
  buildCoverageContextItem,
  PARTIAL_COVERAGE_REASONS,
  PARTIAL_COVERAGE_REASON_SET,
  type PartialCoverageReason,
  type DegradedSource,
  type PartialCoverageEnvelope,
  type CoverageGapInput,
  type CoverageGapDecision,
} from './partial-coverage.js';

export {
  detectCapacityGapMidRun,
  CAPACITY_GAP_MID_RUN_REASONS,
  CAPACITY_GAP_MID_RUN_REASON_SET,
  type CapacityGapMidRunReason,
  type CapacityMidRunDetectInput,
  type CapacityMidRunDetectResult,
} from './capacity-mid-run.js';

export {
  detectReplayDrift,
  type ReplayMode,
  type ReplayDriftInput,
  type ReplayDriftResult,
  type ReplayDriftOk,
  type ReplayDriftBlocked,
  type DriftEntry,
} from './replay-drift.js';

export {
  decideBridgeDisconnectPath,
  type BridgeDisconnectInput,
  type BridgeDisconnectDecision,
} from './bridge-disconnect.js';

export {
  composeNoAlternativeFailure,
  MAX_CONFLICT_EXPLANATION_LEN,
  type NoAlternativeInput,
} from './no-alternative-mapping.js';
