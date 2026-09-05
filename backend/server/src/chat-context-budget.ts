/** The chat half of context fitting: how large a prompt this turn may compose.
 *
 *  ⛔⛔ WHY THIS EXISTS. `input_token_budget` is the one input to every trim in
 *  `chat-turn-executor.ts`, and a census (2026-09-03) found two things about
 *  it. Its only declared source, `slot.context_window_tokens`, is OWNER-TYPED
 *  ONLY — read in `llm-config.ts`, written back from settings, supplied by
 *  nothing else: no model table, no probe, no default. And the ONLY code that
 *  ever passed the budget was the llm_gateway handler. So on ordinary chat it
 *  was undefined, `promptFits` short-circuited to true, and the entire fitting
 *  path was inert — which is why the tail-eviction loop carries the comment
 *  "Normal chat never enters this branch", why a 113,616-token request went out
 *  and was accepted, and why `ChatContextLength` appears ZERO times in 1,546
 *  stored bench reports. The guard was correct and starved of its one input.
 *
 *  The missing input is now learned from the endpoint itself
 *  (`endpoint-capabilities.ts`), because a static `model -> window` map cannot
 *  work here: one adapter serves every openai-compatible server and `base_url`
 *  overrides the endpoint, so the reachable set is open and the windows are
 *  often unpublished.
 *
 *  ⚠ Everything below returns `undefined` until an endpoint has actually
 *  refused something, so an install that has never overflowed behaves exactly
 *  as it does today. */

import {
  candidateSlotsForLayer,
  computeContextInputTokenBudget,
  computeMaxTokens,
  maxProvenAcceptedInput,
  minLearnedContextWindow,
  type LLMConfig,
  type ModelHint,
} from '@recued/llm';
import {
  CHAT_CATALOG_DELIVERY_MODES,
  chatModelLayerToForceLayer,
  type ChatModelHint,
  type ChatModelRoutingLayer,
  type ChatModelSourceId,
  type ChatCatalogDeliveryMode,
} from '@recued/contracts';

export interface ChatBudgetRoute {
  readonly layer: ChatModelRoutingLayer;
  readonly hint?: ChatModelHint;
  readonly source_id?: ChatModelSourceId;
}

/** The candidate set this turn could actually route to.
 *
 *  ⛔ THE PIN RULE IS COPIED FROM `chat-turn-executor.ts` ON PURPOSE AND MUST
 *  STAY EQUAL TO IT. A pin is only meaningful inside the byok layer (match.ts
 *  INV3): under `free` the matcher excludes slots by layer AND excludes the
 *  pool on any pin, a provably-empty intersection, so the executor drops the
 *  pin there — and a budget computed over a wider set than the call can reach
 *  is a budget for the wrong endpoints. */
export const chatCandidateSlots = (config: LLMConfig, route: ChatBudgetRoute) => {
  const forceLayer = chatModelLayerToForceLayer(route.layer);
  const pinSlot: 'slot_1' | 'slot_2' | undefined =
    forceLayer === 'byok'
    && (route.source_id === 'slot_1' || route.source_id === 'slot_2')
      ? route.source_id
      : undefined;
  return candidateSlotsForLayer(config, forceLayer, pinSlot);
};

/** The input-token ceiling for this turn, or `undefined` to leave the trim
 *  inert (today's behaviour).
 *
 *  ⛔⛔ THE MINIMUM OVER CANDIDATES IS NOT TIMIDITY — IT IS THE ONLY SOUND
 *  ANSWER. `matchLLM` picks among candidates using `deps.rng` and live quota
 *  state, so resolving "the" slot before the call is a DIFFERENT DRAW from the
 *  one the call will make. Budgeting to a slot that then loses the draw is not
 *  a smaller bug than not budgeting at all: it trims the prompt to the wrong
 *  endpoint's limit. Only the smallest known window is safe for every draw.
 *
 *  ⚠ A candidate with nothing learned contributes nothing to the minimum, so
 *  this is a BOUND, not a guarantee — if such a candidate wins the draw and is
 *  smaller, the turn can still overflow, and that overflow is what teaches its
 *  bound. What is ruled out is the silent case: once ANY candidate is known to
 *  be small, no turn is composed as though every candidate were large. */
export const resolveChatInputTokenBudget = (
  config: LLMConfig | undefined,
  route: ChatBudgetRoute,
): number | undefined => {
  if (!config) return undefined;
  const candidates = chatCandidateSlots(config, route);
  const window = minLearnedContextWindow(candidates);
  if (window === undefined) return undefined;
  // Reserve the LARGEST output any candidate might ask for. Under-reserving
  // promises the model room it will not get, which is the failure this
  // prevents; over-reserving only costs a little input room.
  const modelHint: ModelHint =
    route.hint === 'fast' || route.hint === 'thinking' ? route.hint : 'quality';
  const reserved = candidates.reduce(
    (max, slot) => Math.max(max, computeMaxTokens(modelHint, slot)),
    0,
  );
  const budget = computeContextInputTokenBudget(window, reserved);
  if (budget === null) return undefined;
  // ⛔ Never trim below an input some candidate has already ACCEPTED — that
  // would discard context demonstrably known to fit.
  const floor = maxProvenAcceptedInput(candidates);
  return floor !== undefined && budget < floor ? floor : budget;
};

/** Step the tool catalog down until it FITS, or until there is nothing leaner.
 *
 *  ⛔⛔ RUNG 0, AND THE ONLY RUNG THAT CAN REACH THE BIGGEST FIELD. Every trim
 *  in `chat-turn-executor.ts` operates below the catalog: `composePrompt()`
 *  passes `inputs.available_tools` through unchanged on all six
 *  recompositions, because it is the D-164 cacheable prefix and
 *  `body.startsWith(cacheable_prefix)` is load-bearing. So the ladder's floor
 *  is *catalog + system prompt*, not zero — and when the catalog alone exceeds
 *  the budget, the ladder evicts the entire conversation, drops every tool
 *  result, and still cannot fit. Measured: 6 tail rows → 1, prompt still over.
 *  Nothing below rung 0 can fix that, because nothing below rung 0 can touch
 *  the thing that is too big.
 *
 *  ⛔ THE TEST IS "THE CATALOG ALONE DOES NOT FIT", not a fraction of the
 *  budget. A fraction would be a guessed threshold; this one is a fact about
 *  the turn — if the catalog alone is over budget, no composition of anything
 *  else can succeed, so stepping down is not a trade-off, it is the only way
 *  the turn can happen at all. A catalog that merely crowds the budget is left
 *  to the lower rungs, which trim the things that actually grew.
 *
 *  ⚠ IT STEPS DOWN PAST AN EXPLICIT OWNER SETTING, deliberately. `full` is a
 *  preference for the fullest catalog, not an instruction to fail rather than
 *  degrade, and honouring it here would mean every turn fails with no output.
 *  The step-down is observable — `lean-core` drops the Tier-2 listing entirely,
 *  so `engine.catalog_assembled`'s section counts and the plan IR's
 *  `tier2_selected_count` both move — and the system prompt's own catalog-mode
 *  guidance changes with it, so the model is told too.
 *
 *  ⚠ TURN-LEVEL, NOT ROUND-LEVEL, so the cacheable prefix stays byte-stable
 *  across a turn's rounds. Growth WITHIN a turn is `prior_tool_calls`, which
 *  the lower rungs already target; re-thinning the catalog mid-turn would
 *  invalidate the prefix to fix something the catalog did not cause. */
export const fitCatalogModeToBudget = (input: {
  readonly mode: ChatCatalogDeliveryMode;
  readonly inputTokenBudget: number | undefined;
  /** Cost of the catalog ALONE in this mode, in estimator tokens. Called at
   *  most once per mode, and not at all when there is no budget. */
  readonly measureCatalogTokens: (mode: ChatCatalogDeliveryMode) => number;
}): ChatCatalogDeliveryMode => {
  const { mode, inputTokenBudget, measureCatalogTokens } = input;
  // No budget ⇒ no measurement ⇒ today's behaviour, and zero added cost on
  // the overwhelmingly common path.
  if (inputTokenBudget === undefined) return mode;
  const from = CHAT_CATALOG_DELIVERY_MODES.indexOf(mode);
  if (from < 0) return mode;
  for (const next of CHAT_CATALOG_DELIVERY_MODES.slice(from)) {
    if (measureCatalogTokens(next) < inputTokenBudget) return next;
  }
  // Nothing fits. Return the leanest rather than the original: the turn is
  // going to be tight either way, and the lower rungs have more room to work
  // with. `chat-turn-executor.ts` decides what to do when even this is over.
  return CHAT_CATALOG_DELIVERY_MODES[CHAT_CATALOG_DELIVERY_MODES.length - 1] ?? mode;
};
