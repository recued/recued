/** D-145 engine-wiring slice 3b.2 — `@recued/gateway` public surface.
 *
 *  The commit Gateway: the chokepoint that wraps an ingredient executor
 *  so every boundary-crossing tool call is recorded as a D-153 atomic
 *  commit (pending → dispatch → terminal outcome), and a dispatch past
 *  the `MAX_DISPATCH_DEPTH` loop ceiling is refused.
 *
 *  ⚠ **This header used to say "Authored INERT — slice 3b.3 wires
 *  `wrapWithCommitGateway` into the engine's executor chokepoint."** That was
 *  true when written at slice 3b.2 and became false on 2026-05-20, when 3b.3
 *  (`fe29dbdbb`) landed the wiring. It is corrected here because it actively
 *  misled a reader into concluding the Gateway never runs (D-225 § 13.3).
 *
 *  LIVE as of 3b.3: `execute-handler.ts:3364` wraps the engine executor,
 *  gated on `commitGatewayActive` (`runIdentity !== undefined &&
 *  deps.commitStore !== undefined`). That is the ONLY production call site.
 *
 *  ⛔ The door path does NOT go through it. `raw-op-dispatch.ts` dispatches via
 *  `runCatalogOperation` and re-implements `handleExecute`'s admission gates in
 *  parallel ("IDENTICAL to `handleExecute`'s"), so a door-originated raw op
 *  gets no commit-Gateway wrap and no `MAX_DISPATCH_DEPTH` ceiling.
 *
 *  Spec: D-153 § Gateway / § Commit substrate.
 */

export {
  wrapWithCommitGateway,
  liftExecutor,
  DispatchDepthExceededError,
  PreflightDeniedError,
  type CommitRunIdentity,
  type CommitGatewayDeps,
  type GatewayExecutor,
  type GatewayInner,
  type GatewayCallProbe,
  // D-177 P2 — the session-grant lookup + consumption seam (N.4): the host
  // wires a resolver over the contract-definition store; the Gateway calls
  // `match` in its ask-branch and `consume` at the dispatch proceed point.
  // P3 adds the mint half (`SessionGrantHooks.mint` + the mint-side gate
  // call) — fired at the resume-admitted ask-branch on the `allow_session`
  // answer's marker (N.5/D9).
  type SessionGrantGateCall,
  type SessionGrantHooks,
  type SessionGrantMintGateCall,
  // D-202 task 4a — the QUALITY-delegation lookup + Switch A/B status seam (the
  // second gate axis): the host wires a resolver over the contract-definition
  // store + persisted switch state; the Gateway calls `match` / `getSwitches` in
  // its ask-branch and composes the three-conjunct gate. Read-only (no consume —
  // a quality delegation is standing).
  type QualityDelegationGateCall,
  type QualityGateHooks,
} from './commit-gateway.js';
export { deriveCommitKind } from './commit-kind.js';

// D-137 P3 § A.11 — Plan-approval substrate (pure predicate +
// proposal constructor + in-memory pending-plan store). D-159 P0
// relocated it from `@recued/engine`: a chat-proposed write is a
// boundary-crossing dispatch, so it homes with the Gateway (D-157 P1
// folds it into the unified preflight `ask`).
export * as planApproval from './plan-approval/index.js';

// D-167 P1 — chat-mode AI-egress PII aliasing. The Gateway owns enforcement
// at the LLM boundary (spec §"Gateway"): alias known PII before egress, keep
// the session-scoped ledger local, restore at approved local boundaries, emit
// a redaction summary into audit. Authored as a substrate-only slice — the
// session-ledger store + per-packet alias pass + restore + owns_llm_egress
// gate, composing the `@recued/transforms` alias substrate, with an injected
// privacy-tag resolver (no-op default until D-165's runtime schema source
// lands). No chat-orchestrator wiring yet.
export * as piiEgress from './pii-egress/index.js';

// D-153 P1 — commit-substrate identity: three-tier session IDs +
// the ~1-min intent-burst correlation tracker. D-159 P1 relocated it
// from `@recued/engine` — a commit's session / correlation identity
// is gateway-substrate concern.
export {
  deriveChannelSessionId,
  createCorrelationTracker,
  CORRELATION_WINDOW_MS,
} from './commit-identity.js';
export type { CorrelationTracker } from './commit-identity.js';

// D-157 P0 — the `in_doubt` reconciliation flow. A commit stranded
// `in_doubt` by a crash → a `notification.ask` (kind `gateway.in_doubt`)
// → an off-commit `data.memory` annotation linked to the commit. The
// gateway names no channel (I-1) — it only calls into the injected
// D-158 notification block. This is the pure leaf; the server-side
// `InDoubtAnnotationWriter` implementation + the boot-sweep wiring are
// the deferred D-157 server-wiring slice.
export {
  IN_DOUBT_HANDLER_KIND,
  IN_DOUBT_ANNOTATION_KEY,
  IN_DOUBT_TARGET_COLLECTION,
  IN_DOUBT_ASK_OPTIONS,
  buildInDoubtAsk,
  createInDoubtAnswerHandler,
  registerInDoubtHandler,
  raiseInDoubtAsks,
} from './in-doubt-reconciliation.js';
export type {
  InDoubtReconciliationAnnotation,
  InDoubtAnnotationWriter,
  InDoubtNotifier,
  InDoubtAsk,
  RaiseInDoubtResult,
} from './in-doubt-reconciliation.js';

// R2 step 6 — torn-saga reconciliation. A run that terminal-fails
// AFTER ≥1 catalog write landed → a `notification.ask` (kind
// `gateway.saga`) disclosing the torn state; `undo` dispatches the
// host-derived compensation plans as fresh GATED runs (each still
// pauses at preflight approval); every answer records a fresh
// annotation linked to the run + its landed commits. Detection is
// derived from the flat commit log, never stored. The pure leaf —
// the annotation writer + compensation dispatcher implementations
// live server-side.
export {
  SAGA_HANDLER_KIND,
  SAGA_ANNOTATION_KEY,
  SAGA_TARGET_COLLECTION,
  SAGA_ASK_OPTIONS,
  detectTornSaga,
  buildSagaAsk,
  createSagaAnswerHandler,
  registerSagaHandler,
  raiseSagaAsk,
} from './saga-reconciliation.js';
export type {
  TornSaga,
  TornSagaWrite,
  SagaReconciliationAnnotation,
  SagaAnnotationWriter,
  SagaCompensationPlanRef,
  SagaCompensationDispatcher,
  SagaNotifier,
  SagaAsk,
} from './saga-reconciliation.js';

// Doc §4 close-out — >1-provider pick resolution. A run whose
// connection slot is UNBOUND with >1 capable enrolled connection →
// a `notification.ask` (kind `gateway.pick`) offering one option per
// candidate; the answer dispatches a FRESH run with the binding
// merged into `config` (re-run, never resume — §1.3), flowing
// through the normal gate path. Candidates derive host-side; the
// re-run dispatcher implementation lives server-side. Headless
// (system-actor) runs never reach this leaf — they fail closed at
// the dispatcher (pinned-target rule, v3 spec §9).
export {
  PICK_HANDLER_KIND,
  PICK_CANCEL_OPTION,
  buildPickAsk,
  createPickAnswerHandler,
  registerPickHandler,
  raisePickAsk,
} from './pick-resolution.js';
export type {
  PickCandidate,
  PickRerunDispatcher,
  PickRerunRef,
  PickNotifier,
  PickAskInput,
  PickAsk,
} from './pick-resolution.js';

// D-157 P1 slice 4 — the preflight-approval flow + per-call admission
// probe. The static pre-run walk (`gateRecipeAgainstPolicy`) treats
// `'ask'` verdicts as admissible; this leaf is the per-call boundary
// that turns an `'ask'` into a real pause: the commit gateway calls
// `evaluateAdmission` per dispatch, `raiseOnAsk` throws
// `PreflightRequiredSignal` on an `'ask'` verdict, the engine catches
// it + ends the execution, and the host raises a `notification.ask`
// (kind `gateway.preflight`) whose `on_answer` resumes or denies the
// run via the injected `PreflightResumer`.
export {
  evaluatePreflightAdmission,
  raiseOnAsk,
} from './preflight-gate.js';
export type { PreflightTool } from './preflight-gate.js';
export {
  PREFLIGHT_HANDLER_KIND,
  PREFLIGHT_ASK_OPTIONS,
  // D-177 P3 — the conditional `allow_session` third option (N.5) + the
  // three-option list an offering ask renders.
  ALLOW_SESSION_ASK_OPTION,
  NEVER_ASK_OPERATION_OPTION_ID,
  RELAX_OPERATION_TO_ASK_OPTION_ID,
  PREFLIGHT_ASK_OPTIONS_WITH_SESSION,
  buildPreflightAsk,
  createPreflightAnswerHandler,
  // D-177 P5a — exported for the batch answer flow's degenerate
  // single-member `allow_session` arm (one payload reader, two consumers).
  readSessionGrantPayload,
  readPreflightOverrideOffer,
  registerPreflightHandler,
  raisePreflightAsk,
  // D-210 Phase C — the passive twin, for `inbox_fanout_mode: 'notify'`.
  raisePreflightNotify,
} from './preflight-reconciliation.js';
export type {
  PreflightAsk,
  PreflightAskContext,
  // D-177 P5a — the batch answer flow's leaf-facing seam (N.10).
  PreflightBatchAnswerHooks,
  PreflightNotifier,
  PreflightResumer,
} from './preflight-reconciliation.js';
