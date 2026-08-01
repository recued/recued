/** D-160 spec-O-5 Stage 3 — chat-stream source-binding adapters.
 *
 *  Stage 3 (D-160 A.8 step 3 + N.9) migrates the chat
 *  turn's four inline producers onto the framework's shared `state` via
 *  REGISTERED HOOKS: the chat turn now runs through `runStream` over a
 *  registry that carries these adapters, instead of the orchestrator
 *  hand-wiring `gather…`/`compute…` calls around the turn. The discipline
 *  is N.9's: **hooks DECIDE → write `state`; the TurnExecutor / shell
 *  ENACT → read `state` + apply** at the mechanical / I/O point.
 *
 *  Each adapter is the SERVER-SIDE source binding for a first-party D-160
 *  middleware whose data lives server-side (the framework can never
 *  synthesise per-pair state). The adapter does the store I/O the real
 *  middleware deliberately leaves to a producer — it seeds the
 *  middleware's `ctx.state` input snapshot, then DELEGATES to the real
 *  middleware object (the chosen O-5 mechanism — not a re-implementation
 *  of its pure core). The real middleware reads the snapshot, decides, and
 *  writes its result back to the SAME shared `ctx.state`:
 *
 *    · `correction-learning` — `prompt` (before-turn): seeds the recent
 *      per-pair `CorrectionEventsStore.listRecent()`, delegates; the real
 *      middleware contributes its flat "recent corrections — …" summary
 *      to the turn's prompt draft. The executor reads that contribution
 *      back (filtered to this adapter's id) as the turn's
 *      `correction_context`.
 *    · `personal-recipes` — `update` (after-turn): seeds the turn's
 *      composed `AIOutput.events[]` (from the after-turn stash) +
 *      `ContactStore.getPersonalRecipes`, delegates; the real middleware
 *      writes the matched (event, entry) pairs. Same after-turn-stash
 *      gate as the SI final guard.
 *
 *  The real middleware objects are sourced from the live D-160 registry
 *  (`registry.enabled()`), so each adapter HONOURS that registry's
 *  per-middleware enabled-state (the uniform D-160 gate, N.3): a disabled
 *  or unregistered middleware short-circuits the adapter BEFORE any store
 *  I/O. The adapters themselves are always registered + enabled in the
 *  orchestrator's stream registry; a missing source getter (or a registry
 *  that lacks the middleware) collapses the corresponding adapter to a
 *  faithful no-op — the turn proceeds exactly as before.
 *
 *  D-160 A.8 step 5 binds the remaining two first-party concerns as
 *  registered turn hooks (the SEAM, not the live producer):
 *    · `scope-search` — `prompt` (before-turn): seeds the per-turn
 *      `{ args, sources }` fan-out input from the `getScopeSearchInput`
 *      producer, delegates; the real middleware runs the fan-out and
 *      writes `SCOPE_SEARCH_RESULT_STATE_KEY` (+ a context prompt part).
 *    · `confidence-shape` — `update` (after-turn): chains off that
 *      fan-out result (the documented producer — "populates it from the
 *      scope-search fan-out"), maps `ScopeSearchCandidate[]` →
 *      `ScoredCandidate[]`, delegates; the real middleware classifies the
 *      distribution and writes `CONFIDENCE_SHAPE_RESULT_STATE_KEY`.
 *  Both gate on the registry enabled-state like the three above; both
 *  stay FAITHFUL NO-OPS on the live chat path — and that dormancy is
 *  ARCHITECTURAL, not a missing one-liner (investigated + confirmed
 *  2026-06-02; D-160 O-5). The turn-level pipeline is a TWO-SIDED seam
 *  with BOTH ends absent in the single-stage chat path:
 *    1. No pre-AI intent signal (PRODUCER side). A `prompt` hook fires
 *       ONCE before `runChatTurn`, which contains the AI call AND the
 *       whole cooperative tool loop — so it cannot see the AI's search
 *       decisions. To fan out for real it would have to decide WHAT to
 *       search from the only pre-AI signal, the raw user message. The
 *       Stage-1 intent classifier that would have produced "this turn
 *       needs a contact lookup for X" was code-deleted (D-164 P6.5/6.6);
 *       the live path is deliberately single-stage (D-137 single-stage
 *       amendment). So `getScopeSearchInput` has no sound signal to
 *       derive `{ args, sources }` from before the turn.
 *    2. No consumer (OUTPUT side). NOTHING CONSUMES the chain's output:
 *       `CONFIDENCE_SHAPE_RESULT_STATE_KEY` has no reader, and
 *       `SCOPE_SEARCH_RESULT_STATE_KEY` is read ONLY by the chain's own
 *       confidence-shape stage (not by anything that shapes the turn). The
 *       scope-search hook contributes a bare candidate-COUNT context line,
 *       but `chat-turn-executor.ts` forwards ONLY the `correction-learning`
 *       contribution into the packet — so even that count is dropped.
 *  The PRODUCTIVE scope-search already runs COMPLETE at TOOL-dispatch
 *  level: when the AI calls `contact.search` / `deal.search`,
 *  `chat-tool-handlers.ts` builds the sources, runs the fan-out, augments
 *  with confidence-shape, and returns the envelope to the AI — there the
 *  AI's tool args ARE the intent signal and the AI reading the envelope
 *  IS the consumer. That is the correct "mid-turn" firing for single-stage.
 *  Lighting up the turn-level producer therefore is NOT a producer
 *  hand-off but the full D-137-chat refactor (turn-level pre-fetch + the
 *  § A.5 confidence Patterns 1-4 disambiguation UX as a real consumer + a
 *  new pre-AI intent signal) — a product decision — so the seam is left
 *  dormant BY DESIGN. `getScopeSearchInput` is kept as the proven wiring
 *  point (the s5 e2e test pins that a wired producer fires the fan-out
 *  mid-turn) so that refactor plugs into a live seam rather than
 *  re-threading the registry; absent it the scope-search hook no-ops →
 *  no fan-out result → the confidence-shape hook no-ops, behavior-
 *  preserving. `prompt-cache` (entity prefetch) is registered by
 *  `wire-chat-orchestrator.ts` and — UNLIKE scope-search — resolved + run in
 *  the list below: its seam is one-sided + ready (the user message is the live
 *  producer signal via the contact-backed search; the agent reading the
 *  injected candidates is the live consumer). PII-safe by construction — the
 *  hook contributes a STRUCTURED `entity` part the egress gather aliases against
 *  the turn's shared ledger before rendering (D-167 P2 / N.10.1), so the model
 *  sees aliases, never raw warehouse PII. The bundled D-164 gate stays a
 *  pass-through no-op under the default gate deps, so only `contributePrefetch`
 *  fires.
 *
 *  Spec: D-160 § N.9 / A.8 step 3 + step 5 / P2.
 */

import type { Middleware, MiddlewareRegistry, TurnContext, TurnResult } from '@recued/middleware';
import { PROMPT_CACHE_MIDDLEWARE_ID } from '@recued/middleware-prompt-cache';
import {
  CORRECTION_LEARNING_EVENTS_STATE_KEY,
  PERSONAL_RECIPES_INPUT_STATE_KEY,
  type ScopeSearchSource,
} from '@recued/middleware-recued';
// D-160 A.8 step 5 — the `scope-search` / `confidence-shape` source-binding
// adapters' shared `state` keys, deep-imported (these
// keys are NOT root-re-exported from `@recued/middleware-recued`). The scope-
// search hook seeds `SCOPE_SEARCH_INPUT_STATE_KEY` + the real middleware writes
// `SCOPE_SEARCH_RESULT_STATE_KEY`; the confidence-shape hook chains off that
// result, seeding `CONFIDENCE_SHAPE_CANDIDATES_STATE_KEY`.
import {
  SCOPE_SEARCH_INPUT_STATE_KEY,
  SCOPE_SEARCH_RESULT_STATE_KEY,
} from '@recued/middleware-recued/scope-search/middleware.js';
import { CONFIDENCE_SHAPE_CANDIDATES_STATE_KEY } from '@recued/middleware-recued/confidence-shape/middleware.js';
import type { ScoredCandidate } from '@recued/middleware-recued/confidence-shape/index.js';
import {
  isChatCatalogDeliveryMode,
  validateExtractionEvent,
  type ChatPickerTarget,
  type ExecutionSource,
  type ExtractionEvent,
  type ScopeSearchResult,
} from '@recued/contracts';

import {
  createPiiProtectMiddleware,
  createPiiRestoreMiddleware,
  type PiiEgressHookDeps,
} from './chat-pii-egress.js';
// D-160 A.8 step 4 — type-only import of the AI-facing tool shape the
// `catalog` hook passes through. `chat-orchestrator.ts` imports `runChatTurn`
// (value) from this lane's sibling `chat-turn-executor.ts`, which in turn
// imports `ChatMainTurnTool` (type) from `chat-orchestrator.ts` — a tolerated
// type-value cycle (types erase at runtime). This adds the same shape:
// type-only, cycle-safe.
import type {
  ChatCatalogProjectionConfig,
  ChatMainTurnTool,
} from './chat-orchestrator.js';
import {
  createScopedGrantParseSource,
  type ScopedGrantParseDeps,
} from './chat-scoped-grant-middleware.js';
import {
  createSpanAnchorSource,
  type SpanAnchorDeps,
} from './chat-span-anchor-middleware.js';
import {
  createExecutionCaseAugmentationSource,
  type RequestAugmentationDeps,
} from './execution-case-retrieval.js';
import {
  type ExecutionCasePrecedentDeps,
} from './execution-case-precedent.js';
import {
  createExecutionCaseFinalizerSource,
} from './chat-execution-case-finalizer.js';
import type {
  ExecutionCaseLifecycle,
} from './chat-execution-case-tools.js';
import type {
  ExecutionCaseOfferLifecycle,
} from './execution-case-offer-lifecycle.js';
import type { ContactStore } from './storage/contact-store.js';
import type { CorrectionEventsStore } from './storage/correction-events-store.js';

/** `ctx.state` key — the after-turn input snapshot the TurnExecutor
 *  writes once the turn produced an `AIOutput`. The `update`-phase
 *  adapters (SI final guard, personal-recipes) read it: its PRESENCE is
 *  the "the turn produced a `final_ai_output`" signal that gates them
 *  (absent on the conflict-halt / no-executor / provider-failure paths,
 *  exactly the prior in-`else`-only placement), and its fields carry the
 *  turn-derived inputs those checkpoints need. */
export const CHAT_TURN_AFTER_INPUTS_STATE_KEY = 'chat:after_turn_inputs';

/** The turn-derived inputs the after-turn adapters consume — the FINAL
 *  `AIOutput.events[]` (personal-recipes) and the settled assistant
 *  tool-call kinds. Written by the TurnExecutor closure
 *  iff the turn produced a `final_ai_output`. */
export interface ChatTurnAfterInputs {
  readonly events: readonly ExtractionEvent[];
  readonly tool_call_kinds: readonly string[];
}

/** `ctx.state` key — the per-turn catalog INPUTS the shell seeds before
 *  `runStream`: the picker target the catalog projection is scoped to
 *  (`'self'` vs a `connection.mcp.<name>` peer). The `catalog` before-turn
 *  adapter reads it; absent → the adapter no-ops (the executor falls back
 *  to an empty tool list). */
export const CHAT_CATALOG_INPUTS_STATE_KEY = 'chat:catalog_inputs';

/** `ctx.state` key — the assembled AI-facing `available_tools` the
 *  `catalog` before-turn adapter DECIDED. The TurnExecutor ENACTs it:
 *  reads it here + threads it into the main-turn packet (N.9). */
export const CHAT_CATALOG_RESULT_STATE_KEY = 'chat:catalog_available_tools';

/** The per-turn catalog inputs the shell seeds — the picker target the
 *  catalog projection scopes to, plus (Lever-2 per-slot) the per-turn catalog
 *  projection the orchestrator resolved from the turn's LLM source. */
export interface ChatCatalogInputs {
  readonly picker_target: ChatPickerTarget;
  readonly projection: ChatCatalogProjectionConfig;
}

/** The catalog projection the `catalog` before-turn hook DECIDES, bound as
 *  a source by the orchestrator (the chat-specific projection is NOT a
 *  `@recued/middleware-recued` middleware, so the adapter delegates to a
 *  provided closure rather than a registry middleware). Given the per-turn
 *  picker target, returns the post-capability-filter AI-facing
 *  `available_tools` union — the lifted former inline catalog gather. */
export type ChatCatalogBuilder = (
  picker_target: ChatPickerTarget,
  projection: ChatCatalogProjectionConfig,
  /** D-225 § 9.8.1 — the TURN's execution source, so the catalog can be derived
   *  from the caller's contract rather than assembled and filtered later.
   *
   *  ⛔ Optional because `TurnContext.source` is ("only for bare test
   *  harnesses"), and an ABSENT one must DENY. `isOpGranted` returns true when
   *  no contract governs, so a filter handed no source would admit everything
   *  while looking identical to a working one. */
  source?: ExecutionSource,
) => ReadonlyArray<ChatMainTurnTool>;

/** D-160 A.8 step 5 — the per-turn scope-search fan-out input the shell's
 *  `getScopeSearchInput` producer supplies: the per-tool `args` plus the
 *  `ScopeSearchSource[]` list the real `scope-search` middleware fans out
 *  over. Mirrors the middleware's `ScopeSearchSnapshot` shape. Absent (the
 *  producer not wired) → the `scope-search` hook is a faithful no-op. */
export interface ChatScopeSearchInput {
  readonly args: unknown;
  readonly sources: readonly ScopeSearchSource<unknown, unknown>[];
}

/** The id the framework stamps onto the `correction-learning` adapter's
 *  prompt contributions (`PromptPart.source`). The TurnExecutor reads the
 *  turn's `correction_context` by filtering the assembled prompt parts to
 *  this source — so the SI adapter's own `prompt` contribution (a
 *  different source) never leaks into the correction context. */
export const CORRECTION_LEARNING_MIDDLEWARE_ID = 'correction-learning';

const PERSONAL_RECIPES_MIDDLEWARE_ID = 'personal-recipes';
/** D-160 A.8 step 5 — the two remaining first-party concerns bound as
 *  registered chat turn hooks (the seam). Ids match the
 *  `@recued/middleware-recued` `FIRST_PARTY_MIDDLEWARES` registry. */
const SCOPE_SEARCH_MIDDLEWARE_ID = 'scope-search';
const CONFIDENCE_SHAPE_MIDDLEWARE_ID = 'confidence-shape';

/** The id the framework stamps onto the `catalog` before-turn hook (A.8
 *  step 4) — the D-164 catalog consumer, first among the turn concerns
 *  (N.9 home map). */
const CATALOG_MIDDLEWARE_ID = 'catalog';

/** Look up an enabled middleware by id. Returns `undefined` when the
 *  registry is absent, OR the middleware is unregistered OR registry-disabled
 *  — either way the adapter short-circuits BEFORE any store I/O (the D-160
 *  enabled-state gate, honoured uniformly). The three source adapters are
 *  built only when the registry is wired (see `createChatStreamMiddlewares`);
 *  the null-guard keeps them faithful no-ops if ever invoked without one. */
const findEnabledMiddleware = (
  registry: MiddlewareRegistry | undefined,
  id: string,
): Middleware | undefined => registry?.enabled().find((mw) => mw.id === id);

/** Read the after-turn input snapshot off `ctx.state`. Requires both an
 *  `events` array and a `tool_call_kinds` array; an absent / malformed
 *  key yields `undefined` and the after-turn adapter no-ops without any
 *  store read. */
const readAfterTurnInputs = (
  state: TurnResult['state'],
): ChatTurnAfterInputs | undefined => {
  const raw = state.get(CHAT_TURN_AFTER_INPUTS_STATE_KEY);
  if (raw === null || typeof raw !== 'object') return undefined;
  const snapshot = raw as { events?: unknown; tool_call_kinds?: unknown };
  if (!Array.isArray(snapshot.events) || !Array.isArray(snapshot.tool_call_kinds)) {
    return undefined;
  }
  return raw as ChatTurnAfterInputs;
};

/** Read the per-turn catalog inputs off `ctx.state`. STRUCTURAL validation
 *  only — requires a string `picker_target`; an absent key or a non-object /
 *  non-string-target snapshot yields `undefined` and the catalog adapter
 *  no-ops. The picker's SEMANTICS (`'self'` vs `connection.mcp.<name>`, incl.
 *  the malformed → treated-as-self fall-through) are `extractPeerName`'s job
 *  inside `buildCatalog`, exactly as the former inline gather handled them —
 *  so a malformed target resolves to the self catalog, NOT an empty one
 *  (rejecting it here would diverge from the pre-A.8-step-4 behavior). The
 *  shell seeds this from an rpc-validated `ChatPickerTarget`, so a malformed
 *  value is unreachable in production regardless. */
/** Lever-2 per-slot — the safe fallback projection when the seeded snapshot
 *  lacks a valid `projection` (a legacy/malformed snapshot): the `full`
 *  baseline, matching `chat-orchestrator.DEFAULT_CHAT_CATALOG_PROJECTION`. A
 *  local literal (not imported) so this leaf doesn't take a runtime value
 *  dependency back on `chat-orchestrator` (which imports this module). */
const FALLBACK_CATALOG_PROJECTION: ChatCatalogProjectionConfig = { mode: 'full' };

/** A structurally-valid projection snapshot: a known `mode` AND — if present —
 *  a positive-integer `indexDescriptionMaxChars`. A bad cap (e.g. a string)
 *  rejects the WHOLE snapshot to the safe `full` fallback rather than reaching
 *  `truncateForIndex` and being coerced. */
const isValidProjectionSnapshot = (p: unknown): p is ChatCatalogProjectionConfig => {
  if (p === null || typeof p !== 'object') return false;
  const o = p as { mode?: unknown; indexDescriptionMaxChars?: unknown };
  if (!isChatCatalogDeliveryMode(o.mode)) return false;
  const cap = o.indexDescriptionMaxChars;
  return cap === undefined || (typeof cap === 'number' && Number.isInteger(cap) && cap > 0);
};

const readCatalogInputs = (
  state: TurnContext['state'],
): ChatCatalogInputs | undefined => {
  const raw = state.get(CHAT_CATALOG_INPUTS_STATE_KEY);
  if (raw === null || typeof raw !== 'object') return undefined;
  const snapshot = raw as { picker_target?: unknown; projection?: unknown };
  if (typeof snapshot.picker_target !== 'string') return undefined;
  // Lever-2 per-slot — carry the orchestrator's per-turn projection; an
  // absent/malformed one (legacy snapshot) falls to the safe `full` default,
  // preserving the "malformed → safe default" discipline.
  const projection = isValidProjectionSnapshot(snapshot.projection)
    ? snapshot.projection
    : FALLBACK_CATALOG_PROJECTION;
  return { picker_target: snapshot.picker_target, projection };
};

/** D-160 A.8 step 5 — read the `scope-search` fan-out result the real
 *  middleware wrote in the before-turn phase, the documented producer the
 *  `confidence-shape` after-turn hook chains off. STRUCTURAL guard only —
 *  requires a `candidates` array; an absent key (scope-search no-op'd this
 *  turn) or a malformed snapshot yields `undefined` and the confidence-shape
 *  adapter no-ops. The result is written by the trusted first-party
 *  middleware, so the guard is cheap insurance, not validation. */
const readScopeSearchResult = (
  state: TurnResult['state'],
): ScopeSearchResult<unknown> | undefined => {
  const raw = state.get(SCOPE_SEARCH_RESULT_STATE_KEY);
  if (raw === null || typeof raw !== 'object') return undefined;
  if (!Array.isArray((raw as { candidates?: unknown }).candidates)) return undefined;
  return raw as ScopeSearchResult<unknown>;
};

/** The source bindings the chat stream adapters need: the live D-160
 *  registry (for the enabled-state gate + the real middleware objects)
 *  plus the existing per-pair stores + the engine clock / tz resolver. */
export interface ChatStreamMiddlewareDeps {
  /** The live first-party middleware registry (built in
   *  `wire-chat-orchestrator.ts`). Each source adapter gates on + delegates
   *  to a middleware sourced from `registry.enabled()`. Absent → the three
   *  source adapters are not built (the always-on PII bookends still are, if
   *  `pii` is wired). */
  readonly registry?: MiddlewareRegistry;
  /** D-160 A.8 step 4 — the catalog projection source. Present → the
   *  `catalog` before-turn hook is built; it reads the per-turn picker
   *  target the shell seeds + writes the assembled `available_tools` to
   *  shared `state`. Absent → no catalog hook (a harness with no tool
   *  catalog; the executor falls back to an empty tool list). Built
   *  INDEPENDENT of `registry`: the catalog projection is chat-specific,
   *  not a first-party `@recued/middleware-recued` middleware. */
  readonly buildCatalog?: ChatCatalogBuilder;
  /** Per-pair correction-event read view — the `correction-learning`
   *  `before-turn` source. Absent → that adapter no-ops. */
  readonly getCorrectionEventsStore?: () => CorrectionEventsStore | undefined;
  /** Per-pair contact store — the `personal-recipes` `after-turn`
   *  per-contact lookup source. Absent → that adapter no-ops. */
  readonly getContactStore?: () => ContactStore | undefined;
  /** D-160 A.8 step 5 — the per-turn scope-search fan-out producer: the
   *  `{ args, sources }` the `scope-search` `before-turn` hook seeds onto
   *  shared `state`, the dep that fires the scope-search → confidence-shape
   *  chain. Left UNWIRED on the live chat path by design — the turn-level
   *  pipeline is a two-sided seam with no pre-AI intent signal (single-stage;
   *  Stage-1 deleted) AND no consumer of the results; the productive
   *  scope-search runs complete at TOOL level in `chat-tool-handlers.ts`.
   *  See the file-header block for the full account. Absent → the
   *  scope-search hook no-ops, so the confidence-shape hook (which chains
   *  off the fan-out result) no-ops too. */
  readonly getScopeSearchInput?: () => ChatScopeSearchInput | undefined;
  /** D-167 P5 S4 — the always-on PII bookend hooks' source bindings
   *  (`pii-protect` / `pii-restore`). Absent → no PII bookends (a harness
   *  without a PII substrate). When present they bracket the source adapters
   *  unconditionally — NOT gated on `registry`'s enabled-state. */
  readonly pii?: PiiEgressHookDeps;
  /** D-177 N.11 rule 5 (5.c, slice C) — the scoped-grant parse hook's
   *  late-bound deps (suggestion store + catalog vocabulary + connection
   *  candidates + bus emit). Absent (or resolving undefined per turn) →
   *  the hook is a faithful no-op. Built INDEPENDENT of `registry` — like
   *  the catalog hook, it is chat-substrate-specific, not a first-party
   *  `@recued/middleware-recued` middleware. */
  readonly getScopedGrantParseDeps?: () => ScopedGrantParseDeps | undefined;
  /** D-214 S0 — the span-anchor hook's late-bound deps (the root-request edge
   *  store + a root-id minter + the optional cross-stream continuation
   *  resolver). Absent (or resolving undefined per turn) → the hook is not
   *  built at all, which is D-214's §0 R4 removability discipline: unregistered
   *  means zero footprint on the turn. Built INDEPENDENT of `registry` — it is
   *  chat-substrate-specific, not a first-party
   *  `@recued/middleware-recued` middleware, and it contributes nothing
   *  model-visible. */
  readonly getSpanAnchorDeps?: () => SpanAnchorDeps | undefined;
  /** D-214 S4 — optional, experiment-gated request augmentation. */
  readonly getExecutionCaseAugmentationDeps?:
    () => RequestAugmentationDeps | undefined;
  /** D-219 — the ordinary-path shape-only precedent surface: the first reader
   *  the corpus has that needs no pre-registration. Mutually exclusive with the
   *  experiment surfaces by composition, not by a runtime check. */
  readonly getExecutionCasePrecedentDeps?:
    () => ExecutionCasePrecedentDeps | undefined;
  /** D-214 S0/S2 — closes pending reports and harvests strong signals. */
  readonly getExecutionCaseLifecycle?:
    () => ExecutionCaseLifecycle | undefined;
  /** D-219 slice 9c — the owner-facing offer's lifecycle: raised after the turn
   *  that earned it, retired at the owner's next request. Rides on the SAME
   *  middleware as the finalizer rather than a second registration, because it
   *  is the same concern (what happens at the turn boundary) and it must run
   *  AFTER finalization — the offer is decided from the observation the
   *  finalizer just recorded. Absent → both halves are a faithful no-op. */
  readonly getExecutionCaseOfferLifecycle?:
    () => ExecutionCaseOfferLifecycle | undefined;
  /** Engine clock — the recency window for `correction-learning`. */
  readonly now: () => number;
}

/** The `correction-learning` source-binding adapter — `before-turn` /
 *  `prompt` only. Seeds the recent per-pair correction stream, delegates;
 *  the real middleware contributes its flat summary to the prompt draft. */
const createCorrectionLearningSource = (
  deps: ChatStreamMiddlewareDeps,
): Middleware => ({
  id: CORRECTION_LEARNING_MIDDLEWARE_ID,
  async prompt(ctx: TurnContext): Promise<void> {
    const mw = findEnabledMiddleware(deps.registry, CORRECTION_LEARNING_MIDDLEWARE_ID);
    if (mw?.prompt === undefined) return;
    const store = deps.getCorrectionEventsStore?.();
    if (store === undefined) return;
    ctx.state.set(CORRECTION_LEARNING_EVENTS_STATE_KEY, {
      rows: store.listRecent(),
      now: deps.now(),
    });
    await mw.prompt(ctx);
  },
});

/** The `personal-recipes` source-binding adapter — `after-turn` /
 *  `update` only. Seeds the turn's extraction events + the per-contact
 *  lookup, delegates; the real middleware writes the matched pairs. */
const createPersonalRecipesSource = (
  deps: ChatStreamMiddlewareDeps,
): Middleware => ({
  id: PERSONAL_RECIPES_MIDDLEWARE_ID,
  async update(ctx: TurnResult): Promise<void> {
    const mw = findEnabledMiddleware(deps.registry, PERSONAL_RECIPES_MIDDLEWARE_ID);
    if (mw?.update === undefined) return;
    const afterInputs = readAfterTurnInputs(ctx.state);
    if (afterInputs === undefined) return;
    const store = deps.getContactStore?.();
    if (store === undefined) return;
    // `AIOutput.events` only passed `validateAIOutput`'s array-level gate
    // (`events` is an array) — individual events are still untrusted model
    // output. Feeding a malformed kind straight into `dispatchPersonalRecipes`
    // would throw (`eventSkipReason` → `classForExtractionEventKind` rejects
    // any kind lacking a `resolution.`/`extraction.` prefix), aborting an
    // otherwise-successful chat turn; and a prefix-spoofed
    // `extraction.<unknown>` would slip past the dispatcher's class gate
    // into topic matching. The dispatcher's "never throw on bad input"
    // invariant assumes composed/validated input, so sanitize at this
    // boundary: drop every per-event-invalid event (`validateExtractionEvent`
    // never throws + rejects unknown kinds). Codex review P2 fold.
    const events = afterInputs.events.filter(
      (event) => validateExtractionEvent(event).length === 0,
    );
    ctx.state.set(PERSONAL_RECIPES_INPUT_STATE_KEY, {
      events,
      lookupPersonalRecipes: (contact_id: string) =>
        store.getPersonalRecipes(contact_id),
    });
    await mw.update(ctx);
  },
});

/** D-160 A.8 step 5 — the `scope-search` source-binding adapter;
 *  `before-turn` / `prompt` only. Scope search PRE-FETCHES the read
 *  context a turn reasons over, so it runs pre-AI-call. Gates on the
 *  registry enabled-state (the uniform D-160 gate) + the per-turn
 *  `getScopeSearchInput` producer: seeds the `{ args, sources }` fan-out
 *  input onto shared `state`, delegates to the real middleware (which runs
 *  `runScopeSearchFanout`, writes `SCOPE_SEARCH_RESULT_STATE_KEY`, and
 *  contributes a context prompt part). Faithful no-op without the producer,
 *  which is unwired on the live chat path BY DESIGN — single-stage has no
 *  pre-AI intent signal to derive the fan-out `args` from, and nothing
 *  consumes the result; the productive fan-out runs at TOOL level in
 *  `chat-tool-handlers.ts` (the full account is in the file-header block;
 *  the deferred turn-level integration is the D-137-chat refactor, D-160
 *  O-5). */
const createScopeSearchSource = (
  deps: ChatStreamMiddlewareDeps,
): Middleware => ({
  id: SCOPE_SEARCH_MIDDLEWARE_ID,
  async prompt(ctx: TurnContext): Promise<void> {
    const mw = findEnabledMiddleware(deps.registry, SCOPE_SEARCH_MIDDLEWARE_ID);
    if (mw?.prompt === undefined) return; // disabled / unregistered → no producer read
    const input = deps.getScopeSearchInput?.();
    if (input === undefined) return; // no turn-level producer → faithful no-op
    ctx.state.set(SCOPE_SEARCH_INPUT_STATE_KEY, input);
    await mw.prompt(ctx);
  },
});

/** D-160 A.8 step 5 — the `confidence-shape` source-binding adapter;
 *  `after-turn` / `update` only. Resolves the discrete confidence pattern
 *  the disambiguation UX keys off from the candidate distribution. Gates on
 *  the registry enabled-state + the `scope-search` fan-out RESULT (the
 *  documented producer — confidence-shape "populates it from the
 *  scope-search fan-out"): reads the before-turn fan-out result off shared
 *  `state`, maps `ScopeSearchCandidate[]` → `ScoredCandidate[]` (the same
 *  score-passthrough projection `chat-tool-handlers.ts`'s
 *  `augmentWithConfidenceShape` applies at tool level), seeds the candidate
 *  snapshot, delegates to the real middleware (which classifies + writes
 *  `CONFIDENCE_SHAPE_RESULT_STATE_KEY`). Its input is the pre-fetched
 *  candidates, NOT the turn's AI output — so it gates on the fan-out result,
 *  not the after-turn stash the SI/personal-recipes adapters use. Faithful
 *  no-op without a fan-out result — so absent the `getScopeSearchInput`
 *  producer the whole chain stays inert (behavior-preserving). Note the
 *  RESULT it writes has no chat-path consumer either (nothing reads
 *  `CONFIDENCE_SHAPE_RESULT_STATE_KEY`) — the missing-consumer half of the
 *  two-sided seam; see the file-header block. */
const createConfidenceShapeSource = (
  deps: ChatStreamMiddlewareDeps,
): Middleware => ({
  id: CONFIDENCE_SHAPE_MIDDLEWARE_ID,
  async update(ctx: TurnResult): Promise<void> {
    const mw = findEnabledMiddleware(deps.registry, CONFIDENCE_SHAPE_MIDDLEWARE_ID);
    if (mw?.update === undefined) return;
    const result = readScopeSearchResult(ctx.state);
    if (result === undefined) return; // no scope-search fan-out ran → no-op
    const scored: ReadonlyArray<ScoredCandidate<unknown>> = result.candidates.map((c) =>
      typeof c.score === 'number'
        ? { record: c.record, score: c.score }
        : { record: c.record },
    );
    ctx.state.set(CONFIDENCE_SHAPE_CANDIDATES_STATE_KEY, scored);
    await mw.update(ctx);
  },
});

/** D-160 A.8 step 4 — the `catalog` source-binding adapter; `before-turn`
 *  / `prompt` only. Lifts the former INLINE before-turn catalog gather
 *  (the post-capability-filter Tier 1/2/3 union → AI-facing
 *  `available_tools`) onto a registered hook: reads the per-turn picker
 *  target the shell seeded, delegates to the bound `buildCatalog`
 *  projection, and writes the assembled tools to the SAME shared
 *  `ctx.state` the executor ENACTs from (N.9: the hook DECIDES → `state`;
 *  the TurnExecutor reads `state` → composes the main-turn packet).
 *
 *  Unlike the three first-party source adapters this delegates to an
 *  orchestrator-provided CLOSURE (the catalog projection is chat-specific,
 *  not a `@recued/middleware-recued` middleware) and runs UNCONDITIONALLY
 *  — the inline gather it replaces was never gated on a per-middleware
 *  enabled-state, so gating the hook would silently empty the AI's tool
 *  list. The D-164 P3 6-section catalog substrate is the salvage path that
 *  replaces this projection's internals later; this slice establishes the
 *  hook wiring. */
const createCatalogSource = (build: ChatCatalogBuilder): Middleware => ({
  id: CATALOG_MIDDLEWARE_ID,
  prompt(ctx: TurnContext): void {
    const inputs = readCatalogInputs(ctx.state);
    if (inputs === undefined) return; // shell seeded no picker → no-op
    ctx.state.set(
      CHAT_CATALOG_RESULT_STATE_KEY,
      build(inputs.picker_target, inputs.projection, ctx.source),
    );
  },
});

/** D-164 prompt-cache (ENTITY PREFETCH) source-binding adapter; `before-turn`
 *  / `prompt` only. UNLIKE the scope-search seam this one is LIVE — its seam is
 *  one-sided + ready: the user message is the producer signal (via the
 *  contact-backed search wired at boot in `wire-chat-orchestrator.ts`) and the
 *  agent reading the injected candidates is the consumer. Mirrors the five
 *  source adapters' discipline: re-resolves the enabled `prompt-cache`
 *  middleware from the LIVE registry PER TURN — so the uniform D-160
 *  enabled-state gate (N.3) stays the single enable mechanism (a later-disabled
 *  prompt-cache stops firing; the adapter never bakes in a stale snapshot) —
 *  then delegates its `prompt` hook.
 *
 *  `contributePrefetch` reads the turn's latest user text from `ctx.history`.
 *  The chat session store degrades that to EMPTY — never a STALE prior turn —
 *  on a preload failure (`createChatStoreSessionStateStore`), so a failed warm
 *  yields a no-op rather than a previous-turn inject. PII-safe by construction:
 *  the hook contributes a STRUCTURED `entity` part the egress gather aliases
 *  against the turn's shared ledger before rendering (D-167 P2 / N.10.1) — the
 *  model sees aliases, never raw warehouse PII. The bundled D-164 gate stays a
 *  pass-through no-op under the default gate deps, so only `contributePrefetch`
 *  fires; zero-harm when nothing matches (the search returns no candidates →
 *  contributes nothing). Disabled / unregistered → no-op. */
const createPromptCacheSource = (
  deps: ChatStreamMiddlewareDeps,
): Middleware => ({
  id: PROMPT_CACHE_MIDDLEWARE_ID,
  async prompt(ctx: TurnContext): Promise<void> {
    const mw = findEnabledMiddleware(deps.registry, PROMPT_CACHE_MIDDLEWARE_ID);
    if (mw?.prompt === undefined) return; // disabled / unregistered → no prefetch
    await mw.prompt(ctx);
  },
});

/** Build the chat stream's registered middlewares, in hook-execution order.
 *
 *  D-167 P5 S4 — the order is a RATCHET-PINNED bookend: the always-on
 *  `pii-protect` (`prompt`) is FIRST, the always-on `pii-restore` (`update`)
 *  is LAST, and the four first-party source adapters (`scope-search`
 *  → `correction-learning` → `confidence-shape` →
 *  `personal-recipes`, mirroring `FIRST_PARTY_MIDDLEWARES`) sit between them.
 *  Because the framework runs `prompt` hooks in registration order and
 *  `update` hooks in registration order, this guarantees `pii-protect`
 *  DECIDES the egress plan before any other `prompt` hook runs, and
 *  `pii-restore`'s total-restore backstop runs after every other `update`
 *  hook. The aliasing itself is enacted at the wire seam
 *  (`wrapExecuteAiCallForPii`, N.9) on every AI call, NOT between the hooks:
 *  the hooks between the bookends operate on REAL values, and only the
 *  provider call sees aliases (egress boundary, spec §"Runtime flow"; D-160
 *  §N.9).
 *
 *  The PII bookends are built whenever `pii` is wired — independent of
 *  `registry` (they are always-on, never gated on the D-160 per-middleware
 *  enabled-state). The `catalog` hook (A.8 step 4) sits first among the
 *  concerns (after `pii-protect`), built whenever a `buildCatalog` source is
 *  wired — also independent of `registry`. The four first-party source
 *  adapters are built only when the first-party `registry` is wired (they
 *  delegate to its middleware objects); `scope-search` / `confidence-shape`
 *  (A.8 step 5) are built alongside the other three but stay faithful no-ops
 *  on the live chat path — the turn-level producer is unwired by design (the
 *  two-sided seam; see the file-header block). Any group absent collapses to a
 *  faithful subset; all absent yields an empty list (a single-turn
 *  `runStream` with no producers). */
export const createChatStreamMiddlewares = (
  deps: ChatStreamMiddlewareDeps,
): ReadonlyArray<Middleware> => {
  const middlewares: Middleware[] = [];
  // pii-protect — FIRST (ratchet-pinned), always-on.
  if (deps.pii) middlewares.push(createPiiProtectMiddleware(deps.pii));
  // catalog/prompt-cache — the D-164 catalog consumer as a before-turn hook
  // (A.8 step 4); first among the turn concerns (N.9 home map). Built when a
  // catalog source is wired; runs unconditionally (no enabled-state gate —
  // see `createCatalogSource`).
  if (deps.buildCatalog) middlewares.push(createCatalogSource(deps.buildCatalog));
  // scoped-grant parse (D-177 rule 5, 5.c) — before-turn over the user's own
  // utterance; files an inert proposal row, contributes nothing model-visible.
  // Independent of `registry` like the catalog hook; absent deps → no-op.
  if (deps.getScopedGrantParseDeps) {
    middlewares.push(createScopedGrantParseSource(deps.getScopedGrantParseDeps));
  }
  // D-214 S0 span anchor — before-turn over the turn's own identity; writes the
  // root-request edge and contributes NOTHING model-visible (request-time
  // augmentation is Slice 4). Independent of `registry` like the two hooks
  // above; absent deps → not built, so removal is "stop passing the dep".
  if (deps.getSpanAnchorDeps) {
    middlewares.push(createSpanAnchorSource(deps.getSpanAnchorDeps));
  }
  if (deps.getExecutionCaseAugmentationDeps) {
    middlewares.push(
      createExecutionCaseAugmentationSource(
        deps.getExecutionCaseAugmentationDeps,
      ),
    );
  }
  // ⛔⛔ D-219's ordinary-path precedent card is GONE from this surface, and the
  // registration is deleted rather than left gated on deps nobody supplies. A
  // dormant `if` reads as a live seam: it typechecks, it survives review, and it
  // re-enables a measured regression the moment someone wires the deps back.
  // The card multiplied invented arguments at ~5.5x odds across two
  // pre-registered rounds (p = 0.016, then p = 0.00006) because it hands a model
  // SHAPE WITHOUT VALUES, and a model given a route runs it in one batch and
  // invents the joins. See `wire-execution-cases.ts` for the full evidence and
  // for what deliberately survives (the offer, the Learning panel, the draft —
  // every one of them owner-reviewed).
  // The first-party source adapters — only when the registry is wired.
  // Registration order = the framework's per-hook iteration order, mirroring
  // `@recued/middleware-recued`'s `FIRST_PARTY_MIDDLEWARES`, then the D-164
  // prompt-cache (entity prefetch) adapter last in the prompt phase:
  // scope-search → correction-learning → prompt-cache
  // (prompt phase), then confidence-shape →
  // personal-recipes (update phase). scope-search/confidence-shape (A.8 step 5)
  // are faithful no-ops on the live path by design — the turn-level producer is
  // unwired (two-sided seam); prompt-cache, by contrast, is LIVE (one-sided
  // seam). Each adapter re-resolves its real middleware from the live registry
  // per turn, so the D-160 enabled-state gate stays the single enable
  // mechanism. All sit before the always-on `pii-restore` bookend.
  if (deps.registry) {
    middlewares.push(
      createScopeSearchSource(deps),
      createCorrectionLearningSource(deps),
      createConfidenceShapeSource(deps),
      createPersonalRecipesSource(deps),
      createPromptCacheSource(deps),
    );
  }
  if (deps.getExecutionCaseLifecycle) {
    middlewares.push(
      createExecutionCaseFinalizerSource(
        deps.getExecutionCaseLifecycle,
        deps.getExecutionCaseOfferLifecycle,
      ),
    );
  }
  // pii-restore — LAST (ratchet-pinned), always-on.
  if (deps.pii) middlewares.push(createPiiRestoreMiddleware());
  return middlewares;
};
