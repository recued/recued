/** D-145 PB3 — orchestrator barrel.
 *
 *  Public surface: `executeRecuedRequest` entry point + composition
 *  rule validator + the `OrchestrationPolicy` callback shape that
 *  PB4 / PB13 wire production policies into. */

export {
  executeRecuedRequest,
  RecuedPlanStatusMismatchError,
  type ExecuteRecuedRequestContext,
  type OrchestrationPolicy,
  type OrchestrationPolicyResult,
  type PlanDraft,
} from './execute-recued-request.js';

export {
  validateCompositionRules,
  assertValidComposition,
  preCheckBridgeDispatchAllowed,
  CompositionRuleError,
  COMPOSITION_RULE_KINDS,
  COMPOSITION_RULE_KIND_SET,
  type CompositionRuleKind,
  type CompositionRuleViolation,
} from './composition-rules.js';

// D-159 P0 — the `tier-policy` helper lives in
// `@recued/middleware-recued` (it imports framework types, so it must
// not live in the framework; see tier-strategy/index.ts). D-164 P6.1
// moved it into `tier-strategy/` when the `two-stage/` dir retired.
