/** `@recued/middleware` — the stream-middleware framework.
 *
 *  The third flow controller — a peer of `@recued/engine` (deterministic
 *  recipe-plan execution) and `@recued/gateway` (the enforcement
 *  boundary). It owns the turn loop; the middlewares register and do the
 *  work. The framework contains no cognition logic and no middleware
 *  *implementation* — those ship in `@recued/middleware-recued` and
 *  register against the registry here.
 *
 *  This barrel exposes EXACTLY the D-160 framework surface (I-3):
 *    · `runStream`                — the turn pipeline (§ N.2 / A.2)
 *    · `createMiddlewareRegistry` — the registry (§ N.3 / A.3; internal-
 *                                   only, dynamic count per D-164 P5)
 *    · `createOutStream`          — the transparency out-stream (§ N.6)
 *    · `createCapacity`           — the capacity envelope primitive (§ N.4)
 *    · `dispatchToolCalls`        — concurrent tool-call dispatch (D-164
 *                                   § 6 / P5; parallel iff every emitted
 *                                   call declares `concurrency_safe`)
 *    · `Middleware` + the lifecycle contexts (§ N.2)
 *
 *  The D-145 Part-B substrate relocated here in D-159 P0 (`capacity/`,
 *  `primitives/`, `orchestrator/`, `ai-cooperative/`, `ai-output/`,
 *  `transparency-stream/`, `failure-semantics/`, `internal-tool-registry/`)
 *  is the framework's *internal* building blocks — NOT public surface.
 *  The framework composes them; a consumer that still needs one reaches
 *  it by a deep subpath import (`@recued/middleware/<dir>/…`), never
 *  this barrel. D-160 P2 narrowed the barrel to the framework surface
 *  and moved every D-145-substrate consumer onto deep imports; the
 *  `d-160-phase-1-surface.ratchet` test pins the barrel exact (I-3).
 *
 *  Import boundary (D-159 N.7 / D-160 I-1): `middleware` may import
 *  `@recued/engine` (run a recipe-as-tool) but MUST NOT import
 *  `@recued/middleware-recued` — a framework never imports a bundle.
 *
 *  Spec: docs/d-160-spec.md (framework) + docs/d-159-spec.md (relocation)
 *  + docs/d-164-prompt-cache-consolidation-pending-design.md P5
 *  (parallel tool dispatch + registry-role clarification).
 */

// § N.2 / A.2 — the turn pipeline.
export {
  runStream,
  type RunStreamInput,
  type StreamSummary,
  type StreamDoneReason,
} from './pipeline.js';

// § N.3 / A.3 — the middleware registry.
export {
  createMiddlewareRegistry,
  type MiddlewareRegistry,
  type MiddlewareEntry,
} from './registry.js';

// § N.6 / A.4 — the transparency out-stream.
export { createOutStream, projectTurnToOutStream } from './out-stream.js';

// § N.4 / A.1 — the capacity envelope primitive.
export {
  createCapacity,
  narrowCapacity,
  capacityBreach,
  DEFAULT_MAX_TURNS,
  type Capacity,
  type CapacityUsage,
  type CapacityBreach,
} from './capacity.js';

// D-164 § 6 / P5 — concurrent tool-call dispatch primitive.
export {
  dispatchToolCalls,
  type DispatchableToolCall,
  type ToolCallDispatchInput,
  type ToolCallDispatchOutput,
  type ToolCallResult,
  type ToolDispatchStrategy,
} from './dispatch.js';

// § N.2 — the middleware interface + the lifecycle contexts.
export type {
  Middleware,
  StreamContext,
  TurnContext,
  TurnResult,
  TurnOutput,
  TurnExecutor,
  ToolCallRecord,
  OutStream,
  PromptDraft,
  PromptPart,
  TextPromptPart,
  ContentPromptPart,
  EntityPromptPart,
  PromptContribution,
  ChannelOutbound,
} from './types.js';
