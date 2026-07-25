/** D-164 P4b/P4c/P4e — `@recued/middleware-prompt-cache` public surface.
 *
 *  Registers the prompt-cache middleware against a D-160
 *  `MiddlewareRegistry`. The middleware adapter mirrors the pattern the
 *  `@recued/middleware-recued` first-party adapters use — `id` +
 *  optional lifecycle hooks; the registry's `register()` enables it by
 *  default and throws on a duplicate id.
 *
 *  Lifecycle footprint: `prompt` (`before-turn`) — the middleware owns
 *  the whole pre-LLM pipeline (intention router → NER → templates →
 *  data-presence → render) per design § 1 / § 3. The `prompt` hook
 *  composes two phases:
 *    1. `attachIntention(ctx)` (P4c) — closed-list anaphora detection;
 *       writes an `IntentionResult` to `ctx.state` when it fires.
 *    2. `runGate(ctx, deps)` (P4e) — the deterministic short-circuit
 *       orchestrator. With the default no-op deps, the gate evaluates
 *       NER over the chosen input text and always returns pass-through
 *       (the production template library + warehouse probe + renderer
 *       wire in via `registerPromptCacheMiddleware(registry, deps)`
 *       at P5/P6 boot time).
 *
 *  Default deps + identity. `promptCacheMiddleware` is the const built
 *  with `DEFAULT_GATE_DEPS`. `registerPromptCacheMiddleware(registry)`
 *  without deps registers that exact const so tests asserting registry
 *  identity continue to hold. Callers passing a custom `GateDeps` get
 *  a freshly-built middleware via `createPromptCacheMiddleware(deps)`.
 *
 *  Live-boot wiring is already in place as of D-164 P6.4:
 *  `backend/server/src/composition/bin/wire-chat-orchestrator.ts` calls
 *  `registerPromptCacheMiddleware(middlewareRegistry)` after
 *  `registerFirstPartyMiddlewares`. The chat-orchestrator owns the AI
 *  call directly (P6.0 (b)) and does not yet consume prompt-cache
 *  output — the registry has no live consumer today, prompt-cache slots
 *  in for future consumers without re-touching boot. D-164 P6.5 retired
 *  the two-stage decoder, dropping `FIRST_PARTY_MIDDLEWARES` from six
 *  to five adapters; prompt-cache continues to register separately.
 *
 *  Import boundary (D-159 N.7 / D-160 I-1): this sub-package imports
 *  `@recued/middleware` (the framework). The framework MUST NOT import
 *  it back — a framework never imports a bundle.
 *
 *  See: docs/d-164-prompt-cache-consolidation-pending-design.md
 *  § 1 The middleware / § 2 Intention router / § 3 The deterministic
 *  gate / § Packaging.
 */

import type {
  Middleware,
  MiddlewareRegistry,
  TurnContext,
} from '@recued/middleware';

import { attach as attachIntention } from './intention/index.js';
import {
  DEFAULT_GATE_DEPS,
  runGate,
  type GateDeps,
} from './gate/index.js';
import {
  contributePrefetch,
  DEFAULT_PREFETCH_DEPS,
  type PrefetchDeps,
} from './prefetch/index.js';

export {
  DEFAULT_GATE_DEPS,
  runGate,
  rewriteAnaphoricPrompt,
  containsListMarkerLine,
  parseInlineNameList,
  parseReferentList,
  type AnaphoraRewriteInput,
  createContactAttributePresenceProbe,
  createCalendarNextMeetingProbe,
  createContactHasEmailProbe,
  createMailFromCountProbe,
  composeShortCircuitFamilies,
  resolveUniqueExactContact,
  type CalendarNextMeeting,
  type CalendarNextMeetingLookup,
  type ContactAttributeLookup,
  type ContactAttributeRow,
  type DataPresenceProbe,
  type DataPresenceQuery,
  type DataSnapshot,
  type GateDeps,
  type HasCrmContactSource,
  type MailFromCountLookup,
  type GateOutcome,
  type GatePassThroughReason,
  type ShortCircuitFamily,
  type TemplateMatcher,
  type TemplateRenderer,
  noopDataPresenceProbe,
} from './gate/index.js';

export {
  createTemplateRenderer,
  matchContactAttributeTemplate,
  matchCalendarNextMeetingTemplate,
  matchMailFromCountTemplate,
  matchContactHasEmailTemplate,
  CONTACT_ATTRIBUTE_TEMPLATES,
  CALENDAR_NEXT_MEETING_TEMPLATE,
  MAIL_FROM_COUNT_TEMPLATE,
  CONTACT_HAS_EMAIL_TEMPLATE,
  CONTACT_HAS_NO_EMAIL_TEMPLATE,
  type ContactAttribute,
} from './templates/index.js';

export {
  contributePrefetch,
  DEFAULT_PREFETCH_DEPS,
  decomposeToTokens,
  extractPhoneRuns,
  extractEmailRuns,
  formatPrefetchContext,
  noopEntitySearch,
  prefetchEntities,
  selectWithPinned,
  PINNED_CANDIDATE_MAX,
  COMMON_SINGLE_TOKEN_WORDS,
  PROSE_FUNCTION_WORDS,
  isCommonSingleTokenWord,
  isProseFunctionWord,
  shouldSeedEntityValue,
  type EntitySearchPort,
  type PrefetchCandidate,
  type PrefetchDeps,
} from './prefetch/index.js';

/** The stable middleware id — registry key + `PromptPart.source` stamp. */
export const PROMPT_CACHE_MIDDLEWARE_ID = 'prompt-cache';

/** Build a prompt-cache middleware with the given gate dependencies.
 *  Use this when the caller has a real template library + warehouse
 *  probe + renderer (P5/P6 wiring). For the default no-op deps,
 *  prefer the `promptCacheMiddleware` const directly — it preserves
 *  reference identity for tests + registry lookups. */
export const createPromptCacheMiddleware = (
  deps: GateDeps = DEFAULT_GATE_DEPS,
  prefetchDeps: PrefetchDeps = DEFAULT_PREFETCH_DEPS,
): Middleware => ({
  id: PROMPT_CACHE_MIDDLEWARE_ID,
  async prompt(ctx: TurnContext): Promise<void> {
    attachIntention(ctx);
    // D-164 P10 / P12 — the deterministic short-circuit fires only on a
    // surface whose `(channel × actor)` policy cell would admit the
    // equivalent warehouse READ (the gate's probes bypass the
    // per-token-gated `contact.search` / `calendar.search` tools, so the
    // surface scope IS the read-permission boundary). The judgment is the
    // injected `authorizeShortCircuitRead` seam — the backend evaluates
    // the same policy primitives the execute-handler's gate uses
    // (`GateDeps` doc); ABSENT, it falls back to the original proven
    // chat-only scope, so a bare `createPromptCacheMiddleware()` (tests,
    // dbless harnesses) behaves exactly as before P10. P12 threads the
    // turn's REAL channel-minted `ExecutionSource` (`ctx.source`, from
    // `ChannelInbound.source` via `runStream`) so the seam judges the
    // actual `(channel × actor)` identity of the turn — the surface tag
    // stays as the fallback key for harness contexts that carry no
    // source. A denial, a non-`true` value, or a THROW fails closed to
    // pass-through (the LLM path is policy-gated on its own, so deferring
    // never widens anything). Prefetch is NOT surface-scoped (its
    // existing behavior runs on every surface; its model-egress story is
    // D-167 aliasing at the gather).
    const authorize: NonNullable<GateDeps['authorizeShortCircuitRead']> =
      deps.authorizeShortCircuitRead
      ?? ((surface: TurnContext['surface']): boolean => surface === 'chat');
    let surfaceAuthorized: boolean;
    try {
      surfaceAuthorized = (await authorize(ctx.surface, ctx.source)) === true;
    } catch {
      surfaceAuthorized = false;
    }
    const shortCircuited =
      surfaceAuthorized && (await runGate(ctx, deps)).kind === 'short-circuit';
    // Prefetch only matters when the gate didn't short-circuit (a
    // short-circuited turn makes no AI call, so injected context is moot).
    // Zero-harm + behavior-preserving with the default no-op search.
    if (!shortCircuited) {
      await contributePrefetch(ctx, prefetchDeps);
    }
  },
});

/** The default no-op-deps prompt-cache middleware. The `prompt` hook
 *  composes intention attach + the deterministic gate; with the
 *  default deps the gate always passes through (template matcher,
 *  data probe, and renderer are all no-ops). Used as the canonical
 *  registration target when callers don't supply custom deps. */
export const promptCacheMiddleware: Middleware = createPromptCacheMiddleware();

/** Register the `prompt-cache` middleware against a D-160
 *  `MiddlewareRegistry`. Enabled by default (matches
 *  `registerFirstPartyMiddlewares` for the five proven adapters — D-164
 *  P6.5 retired the two-stage slot). Throws on a duplicate id per the
 *  registry contract — register exactly once per registry instance (one
 *  registry per server boot).
 *
 *  When `deps` is omitted (the common P4e case + every test) the
 *  registered middleware is the `promptCacheMiddleware` const — same
 *  reference, so registry-identity assertions stay stable. Passing a
 *  custom `deps` builds a fresh middleware with `createPromptCacheMiddleware`
 *  and registers that instead (the P5/P6 live-boot path).
 *
 *  Called by `wire-chat-orchestrator.ts` after
 *  `registerFirstPartyMiddlewares` (D-164 P6.4). No live consumer in the
 *  chat orchestrator yet — chat owns its AI call directly per P6.0 (b);
 *  this registration prepares the seam for future consumers. */
export const registerPromptCacheMiddleware = (
  registry: MiddlewareRegistry,
  deps?: GateDeps,
  prefetchDeps?: PrefetchDeps,
): void => {
  const middleware = deps === undefined && prefetchDeps === undefined
    ? promptCacheMiddleware
    : createPromptCacheMiddleware(
        deps ?? DEFAULT_GATE_DEPS,
        prefetchDeps ?? DEFAULT_PREFETCH_DEPS,
      );
  registry.register(middleware);
};
