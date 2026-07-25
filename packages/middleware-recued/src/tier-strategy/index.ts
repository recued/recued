/** D-145 PB4 — tier-strategy substrate barrel.
 *
 *  Pure helpers consumed by the main-turn composer + the D-164 P6.3
 *  chat-orchestrator rewrite:
 *    - tier selection (`select-tier.ts`)
 *    - per-tier packet shape enforcement (`packet-shape.ts`)
 *    - mid-flight cost ceiling evaluation (`cost-ceiling.ts`)
 *    - per-tier composition strategy descriptor (`composition-strategy.ts`)
 *    - orchestrator tier-policy bridge (`tier-policy.ts`)
 *
 *  D-164 P6.1 relocated these from `../two-stage/`. The semantics are
 *  unchanged; the new location reflects that the substrate applies to
 *  the main turn (D-164 retires the Stage 1 / Stage 2 staging that
 *  this folder used to live alongside).
 *
 *  Spec: § B.3 + § B.15.10 + § C.3.6 +
 *  D-164 § P6. */

export {
  selectSynthesisTier,
  type SelectSynthesisTierInput,
} from './select-tier.js';

export {
  validatePacketShape,
  assertPacketShape,
  PacketShapeError,
  PACKET_SHAPE_VIOLATION_KINDS,
  PACKET_SHAPE_VIOLATION_KIND_SET,
  type PacketShapeViolationKind,
  type PacketShapeViolation,
  type PacketShapeInput,
  type PacketShapeOk,
  type PacketShapeFail,
  type PacketShapeResult,
} from './packet-shape.js';

export {
  evaluateCostCeiling,
  buildCostCeilingDemotedEvent,
  buildCostCeilingHaltedEvent,
  buildStandingInstructionConflictEvent,
  transparencyHaltReason,
  formatCostCeilingDemotionOutcomeSummary,
  formatCostCeilingHaltOutcomeSummary,
  COST_CEILING_OUTCOMES,
  COST_CEILING_DEMOTION_OUTCOME_PHRASE,
  COST_CEILING_HALT_OUTCOME_PHRASE,
  type CostCeilingOutcome,
  type CostCeilingInput,
  type CostCeilingResult,
} from './cost-ceiling.js';

export {
  resolveCompositionStrategy,
  COMPOSITION_STRATEGIES,
  COMPOSITION_STRATEGY_KINDS,
  COMPOSITION_STRATEGY_KIND_SET,
  type CompositionStrategy,
  type CompositionStrategyKind,
} from './composition-strategy.js';

// D-145 PB4 — orchestrator tier-policy bridge: composes
// `selectSynthesisTier` + mid-flight cost ceiling + halt ↔ PlanStatus
// mapping into a single helper. D-159 P0 relocated it here from
// `orchestrator/` to keep `middleware !-> middleware-recued`; D-164
// P6.1 followed it into `tier-strategy/` alongside its sibling
// dependencies (`select-tier`, `cost-ceiling`).
export {
  resolveSynthesisTier,
  checkMidFlightCostCeiling,
  TIER_POLICY_HALT_TO_PLAN_STATUS,
  TIER_POLICY_HALT_TO_FAILURE_CLASS,
  type TierPolicyHaltReason,
  type ResolveSynthesisTierInput,
  type ResolveSynthesisTierResult,
  type MidFlightCostCheckInput,
  type MidFlightCostCheckResult,
} from './tier-policy.js';
