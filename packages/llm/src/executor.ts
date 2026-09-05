import { isAIBatchMode, isBatchCapableAISlug, isCoreSlug, normalizePiiFields } from '@recued/contracts';
import type {
  AIBatchEntry,
  IngredientManifest,
  LLMRequirements,
  ModelHint,
  PiiAliasableData,
  PiiFieldTag,
  WebChatTab,
} from '@recued/contracts';
import { aliasFields, aliasFieldsBatch, createLedger, restoreArgs, type Ledger } from '@recued/transforms';
import type {
  AdapterRegistry,
  AvailabilitySnapshot,
  ContentPart,
  CoordinationStrategy,
  LLMAdapter,
  LLMCompletionOptions,
  LLMCompletionResult,
  LLMConfig,
  LLMFinishReason,
  LLMMessage,
  LLMSlot,
  Match,
  Modalities,
  TokenUsage,
  TokenUsageAttribution,
} from './types.js';
import { hasModalityDemand, LLMError, requiredModalities } from './types.js';
import { computeMaxTokens, shouldEnableThinking } from './router.js';
import { buildContractedPrompt, buildUncontractedPrompt, isContractedSlug } from './prompts.js';
import {
  parseContractedBatch,
  parseContractedOutput,
  parseJSONArray,
  parseJSONObject,
} from './parse.js';
import {
  demoteSystemMessages,
  hasSystemMessage,
  isContextOverflowRejection,
  isJsonModeRejection,
  jsonModeUnsupported,
  noteContextAccepted,
  noteContextRefused,
  noteJsonModeUnsupported,
  noteSystemRoleUnsupported,
  isSystemRoleRejection,
  systemRoleUnsupported,
} from './endpoint-capabilities.js';
import { estimateConservativeMessagesTokens } from './context-budget.js';
import { resolveLLMTimeoutMs } from './timeout.js';
import { buildAvailability } from './availability.js';
import { matchLLM, type ForceLayer, type PinnedSlot } from './match.js';
import type { QuotaTracker } from './quota.js';

/** §5 publish-policy egress neutralization: web-search is forced OFF for EVERY
 *  publishable `core-*` AI slug (not just `core-ai-prompt`). A published recipe may
 *  carry only `core-*` ingredient steps, and §5 routes web egress for published
 *  recipes ONLY through gated pack ops (e.g. `web.search`) — never an ungated AI-step
 *  search. So an arbitrary published prompt (or any contracted core- call) can
 *  transform already-gated data but cannot open a new egress path. The kernel BARE
 *  slugs (`ai-prompt`, …), used only by trusted bundled recipes, keep search. */
const wantsWebSearch = (
  manifest: IngredientManifest,
  input: Record<string, unknown>,
): boolean => input['llm.allow_search'] === true && !isCoreSlug(manifest.slug);

/** Per-call hook by which the runtime supplies recipe-level context the
 *  LLM layer would otherwise have no way to know. Return null to fall back
 *  to defaults (allow_upgrade from user global, forceLayer 'any'). */
export interface MatchContextHook {
  (manifest: IngredientManifest, input: Record<string, unknown>): {
    allowUpgrade?: boolean;
    forceLayer?: ForceLayer;
    /** D-191 Phase 6 — exact-slot pin (a manual chat pick of a configured
     *  slot). Restricts the match to this slot only; fail-closed. */
    pinSlot?: PinnedSlot;
  } | null;
}

/** Debug event emitted by the executor on every successful match. Runtimes
 *  can subscribe to populate audit logs or a "why this LLM?" UI. */
export interface LLMMatchResolved {
  type: 'llm_match_resolved';
  snapshot: AvailabilitySnapshot;
  winner: Match;
  reject_set: string[];
  allow_downgrade: boolean;
  allow_upgrade: boolean;
  force_layer: ForceLayer;
  /** D-191 Phase 6 — the pinned slot when the match was slot-pinned. */
  pin_slot?: PinnedSlot;
}

/** Dependencies the caller must supply. Kept narrow so tests can inject fakes. */
export interface LLMExecutorDeps {
  /** User's LLM configuration (slot_1 + optional slot_2 + optional free_pool). */
  config: LLMConfig;
  /** Adapter registry keyed by adapter key. Typically `createDefaultRegistry()`. */
  adapters: AdapterRegistry;
  /** Quota tracker for the free pool. Required; use `createQuotaTracker()` if
   *  no pool is configured (it becomes a no-op for slot-only flows). */
  quota: QuotaTracker;
  /** Retired web-chat compatibility seam. The availability builder ignores it. */
  tabProbe: () => Promise<Set<WebChatTab>>;
  /** Retired web-chat compatibility seam. */
  webChatSupported?: boolean;
  /** Pre-built availability snapshot. When set, the executor skips
   *  `buildAvailability` (and thus the tabProbe). Runtimes that want
   *  every AI step in a single recipe run to see the same LLM list
   *  compute availability once at recipe start and pass it here. */
  preBuiltAvailability?: AvailabilitySnapshot;
  /** Reports whether a slot is over its scheduled-cutoff budget threshold.
   *  Used by the `under_budget_only` offer flag. Return null when no budget. */
  budgetStatus?: (slotKey: 'slot_1' | 'slot_2') => { over_cutoff: boolean } | null;
  /** Coordination strategy applied within a tie-group. Default 'round_robin'. */
  strategy?: CoordinationStrategy;
  /** Random-number generator for the `weighted` strategy. Defaults to
   *  `Math.random`. Injectable so integration tests can drive the
   *  weighted free-pool pick deterministically. */
  rng?: () => number;
  /** Recipe-level offers + allow_upgrade for this call. */
  matchContext?: MatchContextHook;
  /** Per-call timeout in milliseconds. */
  timeout_ms?: number;
  /** Callback to report token usage after each LLM call. */
  onTokenUsage?: (usage: TokenUsage) => void;
  /** Provider-normalized stop reason for each successful completion. */
  onFinishReason?: (reason: LLMFinishReason | undefined) => void;
  /** Optional observer for the match resolution. Fires once per successful
   *  call (and once per retry-walk attempt). */
  onMatchResolved?: (evt: LLMMatchResolved) => void;
}

/** Execute a single LLM ingredient call.
 *
 *  Flow:
 *   1. Derive `requires` from ingredient manifest (`llm.requires` or legacy keys).
 *   2. Derive `offers` + `allowUpgrade` via `matchContext` hook, fall back to
 *      user defaults (per-hint from config.default_offers).
 *   3. Build availability snapshot (pool quota + tabs + slot budgets).
 *   4. Resolve a Match. On `retryable: true` errors from the adapter, re-match
 *      with the failed source rejected. Hard cap at 3 walks.
 *   5. Single adapter.complete path — no transport branching.
 *   6. Report one TokenUsage per successful call.
 *
 *  Zero-retry policy (unchanged from pre-v1): one SUCCESSFUL call = one billing
 *  event. Parse/validation failures surface; cascade re-matches only happen
 *  BEFORE any completion tokens have been consumed (auth-fail, quota-exhausted,
 *  tab-closed-before-response). */

/** Call the adapter, degrading native JSON mode gracefully. On a json-mode
 *  rejection (see `isJsonModeRejection`) from a json-mode attempt, retry ONCE
 *  without json mode — the consolidated post-hoc parser then handles the
 *  (possibly fenced) output. The rejection happens at the request boundary
 *  before any completion tokens are billed, so this preserves the zero-retry
 *  policy. Any other error (and a non-json call) re-throws unchanged. */
const completeWithJsonFallback = async (
  adapter: LLMAdapter,
  slot: LLMSlot,
  messages: LLMMessage[],
  options: LLMCompletionOptions,
): Promise<LLMCompletionResult> => {
  // ⚠ REMEMBER THE ANSWER. This fallback shipped without a memory, so a slot
  // whose `supports_json` declaration was wrong re-paid the rejected
  // round-trip on EVERY call, forever — and since every contracted ai-*
  // function asks for JSON, that is nearly every call the server makes. The
  // rejection is free in tokens but not in latency.
  const effective = options.json && jsonModeUnsupported(slot)
    ? { ...options, json: false }
    : options;
  try {
    return await adapter.complete(slot, messages, effective);
  } catch (e) {
    if (effective.json && isJsonModeRejection(e)) {
      noteJsonModeUnsupported(slot);
      return adapter.complete(slot, messages, { ...options, json: false });
    }
    throw e;
  }
};

/** The single call seam for every adapter invocation the executor makes, with
 *  BOTH request-boundary degradations composed: native JSON mode, and the
 *  `system` wire role.
 *
 *  Send `system` always. If this endpoint has already refused it in this
 *  process, fold it into the user turn up front; otherwise discover it from the
 *  refusal and retry once. See `system-role-fallback.ts` for why this is
 *  detected rather than configured, and why the memory is not persisted.
 *
 *  ⚠ Billing: both degradations are 400s at the REQUEST boundary, so a call
 *  that trips both still bills ZERO completion tokens before the attempt that
 *  succeeds — the zero-retry policy ("one SUCCESSFUL call = one billing event")
 *  is about generated tokens, and none are generated by a rejected request.
 *
 *  ⚠ The retry is gated on the prompt ACTUALLY carrying a system message. The
 *  gateway forwards caller-supplied system messages, so without that gate a
 *  caller could put the trigger phrase in their own prompt text and make an
 *  unrelated bad request look like a role refusal. */
export const completeWithFallbacks = async (
  adapter: LLMAdapter,
  slot: LLMSlot,
  messages: LLMMessage[],
  options: LLMCompletionOptions,
): Promise<LLMCompletionResult> => {
  // ⛔⛔ THE CONTEXT WINDOW IS LEARNED HERE, AND ONLY HERE, BECAUSE THIS IS THE
  //   ONE PLACE THAT KNOWS WHICH ENDPOINT WAS ASKED. A context refusal is built
  //   NON-retryable (`classifyProviderError`), so it does not cascade and it
  //   surfaces out of `executeLLM` with no `usage` attached — meaning the
  //   caller cannot tell which slot was tried, and an attempt to learn the
  //   bound above this line either duplicates routing or learns nothing at all.
  //   Down here the slot is simply in hand, on both outcomes.
  //
  // ⛔ BOTH NUMBERS COME FROM THE ESTIMATOR, NOT FROM `usage`. The temptation
  //   is to take the floor from `result.usage.input_tokens` — it is right there
  //   and it is exact. It is also a DIFFERENT MEASURE from the ceiling
  //   (a refused call reports no usage, so that one can only be estimated), and
  //   mixing them makes the floor/ceiling guard compare two scales. Worse, the
  //   consumer — `promptFits` in `chat-turn-executor.ts` — asks
  //   `estimateConservativeMessagesTokens(...) <= budget`, so a budget derived
  //   from provider counts is measured against estimator counts on every check.
  //   Keeping one unit end to end makes the loop self-consistent and lets the
  //   estimator's conservatism cancel out on both sides.
  const attempted = estimateConservativeMessagesTokens(messages);
  try {
    const result = await completeWithFallbacksInner(adapter, slot, messages, options);
    noteContextAccepted(slot, attempted);
    return result;
  } catch (e) {
    if (isContextOverflowRejection(e)) noteContextRefused(slot, attempted, e);
    throw e;
  }
};

const completeWithFallbacksInner = async (
  adapter: LLMAdapter,
  slot: LLMSlot,
  messages: LLMMessage[],
  options: LLMCompletionOptions,
): Promise<LLMCompletionResult> => {
  if (!hasSystemMessage(messages)) {
    return completeWithJsonFallback(adapter, slot, messages, options);
  }
  if (systemRoleUnsupported(slot)) {
    return completeWithJsonFallback(
      adapter,
      slot,
      demoteSystemMessages(messages),
      options,
    );
  }
  try {
    return await completeWithJsonFallback(adapter, slot, messages, options);
  } catch (e) {
    if (!isSystemRoleRejection(e)) throw e;
    noteSystemRoleUnsupported(slot);
    return completeWithJsonFallback(
      adapter,
      slot,
      demoteSystemMessages(messages),
      options,
    );
  }
};

export const executeLLM = async (
  manifest: IngredientManifest,
  input: Record<string, unknown>,
  deps: LLMExecutorDeps,
): Promise<unknown> => {
  // D-162 — a batch-capable ai-* call is in batch mode when `llm.data` is
  // an array and `llm.id_field` is a non-empty string. `ai-compare` is
  // excluded (I-6 — no single `llm.data`); an `ai-compare` batch opt-in is
  // left for `comparePrompt` to reject, never silently short-circuited. An
  // empty `llm.data` array has nothing to classify — short-circuit to `[]`
  // with zero model calls, ahead of match resolution + prompt construction
  // (A.7 / N.3 / I-3).
  const batchMode = isBatchCapableAISlug(manifest.slug) && isAIBatchMode(input);

  // D-167 P6 — single-step ai-* PII. Validate the declaration BEFORE the
  // empty-batch short-circuit and any egress so an unsupported configuration
  // or a malformed declaration can never silently ship raw PII to the model.
  const piiFieldsRaw = input['llm.pii_fields'];
  const piiActive = piiFieldsRaw !== undefined && piiFieldsRaw !== null;
  let piiFields: PiiFieldTag[] = [];
  if (piiActive) {
    // P6.0 — single-step PII is defined ONLY for the contracted functions whose
    // model-bound payload IS `llm.data` (exactly the batch-capable set).
    // `ai-compare` (llm.data_a / llm.data_b) and `ai-prompt` (llm.prompt /
    // llm.data_block) — and any other slug — route their real payload through
    // other keys, so aliasing `llm.data` alone would leave that payload raw.
    // Fail closed rather than create that illusion of protection.
    if (!isBatchCapableAISlug(manifest.slug)) {
      throw new LLMError(
        'AI_OUTPUT_INVALID',
        `${manifest.slug}: llm.pii_fields is only supported on contracted ai-* functions that take a single llm.data; `
        + 'this slug routes its model payload through other keys — alias upstream with the pii-protect transform',
        { slug: manifest.slug },
      );
    }
    // Normalize + fail closed on a malformed declaration now, ahead of the
    // empty-batch short-circuit, so empty + batch + a malformed declaration
    // still fails closed (the declaration is the fail-closed boundary —
    // matching pii-protect, P4 slice 1).
    piiFields = normalizePiiFields(piiFieldsRaw);
  }

  // D-172 P5 / A.10 — validate + parse the optional TOP-LEVEL multimodal
  // content parts BEFORE any egress so a malformed declaration fails closed
  // (never silently drops media — I-6). The top-level `llm.content_parts`
  // attaches to the single user turn and is SINGLE-MODE only: in batch mode it
  // has no element to bind to, so reject it rather than guess. Per-element
  // batch media rides a reserved per-element `content_parts` field instead
  // (extracted below).
  const contentParts = parseInputContentParts(input);
  if (contentParts.length > 0 && batchMode) {
    throw new LLMError(
      'AI_OUTPUT_INVALID',
      `${manifest.slug}: top-level llm.content_parts is single-mode only — in batch mode attach media per element via each llm.data[i].${BATCH_ELEMENT_MEDIA_KEY}`,
      { slug: manifest.slug },
    );
  }

  // D-162 A.7 — an empty `llm.data` batch has nothing to classify; short-circuit
  // to `[]` ahead of per-element media extraction, match resolution, and prompt
  // construction (zero model calls).
  if (batchMode && (input['llm.data'] as unknown[]).length === 0) {
    return [];
  }

  // D-172 follow-on — per-element batch media. Each `llm.data[i]` MAY carry its
  // OWN media on a reserved `content_parts: ContentPart[]` field. Extract + strip
  // it from every element HERE, before the PII alias pass and the prompt build,
  // so:
  //   - the base64 bytes never reach `aliasFieldsBatch` (media is not
  //     PII-aliased — D5) nor the JSON text the model reads,
  //   - the per-element TEXT fields still alias normally (the alias→restore
  //     round-trip is untouched — only the reserved media key is removed),
  //   - the carry-through merge emits clean rows (no base64 echoed back).
  // A present-but-malformed per-element declaration fails closed (I-6). The
  // bytes must arrive ALREADY RESOLVED — the executor never fetches a
  // `file_ref`; the producer / server-executor resolves each element's media to
  // ContentParts and writes this key (a SEPARATE backend follow-on).
  let batchElementMedia: BatchElementMedia[] = [];
  if (batchMode) {
    const extracted = extractBatchElementMedia(input['llm.data'] as unknown[]);
    batchElementMedia = extracted.media;
    if (extracted.changed) {
      input = { ...input, 'llm.data': extracted.cleanedData };
    }
  }
  // No Recued media-count ceiling (D-172 §A.5 / Resolved Q5): the constraint is
  // the PROVIDER's input window, not a Recued constant, and the resolved
  // provider isn't known until after match. An oversized batch surfaces as the
  // provider's own error (exactly like single-mode media); per-provider window
  // sizing (downscale / chunk) is the deferred backend follow-on.

  // The modality demand (image/audio/document) the turn carries; undefined for
  // a text-only call (incl. content_parts that are ALL text — those behave
  // exactly like the text path, never raising the modality warn). Single mode
  // reads the top-level parts; batch mode reads the UNION across every element's
  // media. Threaded into match so a media turn routes to a modality-capable
  // model (N.8) and surfaces the warn when none is (Q4).
  const mediaParts = batchMode
    ? batchElementMedia.flatMap((e) => e.parts)
    : contentParts;
  const requireModalities = requireModalitiesFromParts(mediaParts);

  // Alias the tagged fields of `llm.data` before egress; the result is restored
  // on exit (`finishPii`). D-162 batch mode (`llm.data` an array + non-empty
  // `llm.id_field`) runs the list-wide `aliasFieldsBatch` so identical real
  // values across elements share one alias number; single-object mode runs
  // `aliasFields` (P6.1). A tagged PII `id_field` is aliased like any other
  // field — and because the aliased list is swapped into `input` below, D-162's
  // carry-through (which matches on the `id_field` VALUE — `mergeBatchResult`)
  // runs entirely in alias space, so the aliased id rides through and restore
  // runs last. (Caveat for a tagged-PII `id_field`: the NORMALIZING kinds —
  // email/url lowercase, url drops the default port, phone/address strip
  // formatting — can map two DISTINCT raw ids to one canonical, hence one alias
  // (`Alice@Acme.com` + `alice@acme.com` → the same `m1@d1.invalid`). The N.2
  // duplicate-id check in `buildContractedPrompt` then rejects the batch
  // fail-closed — a stricter reject than un-aliased D-162, which would treat the
  // two as distinct ids — never a raw-PII leak. One more reason a stable non-PII
  // `id_field` is the recommended shape.)
  // Best-effort — a tagged path absent from the data passes through
  // (recipes read fields outside the ingredient contract); a malformed
  // declaration already threw above. One ephemeral per-call ledger; no
  // cross-step bridge.
  let piiLedger: Ledger | undefined;
  if (piiFields.length > 0) {
    piiLedger = createLedger('llm:single-step');
    const aliasedData = batchMode
      ? aliasFieldsBatch(piiLedger, input['llm.data'] as readonly unknown[], piiFields)
      : aliasFields(piiLedger, input['llm.data'] as PiiAliasableData, piiFields);
    input = { ...input, 'llm.data': aliasedData };
  }
  /** Restore this call's own output before it leaves the executor (single-step
   *  P6). No-op when no ledger was minted. In batch mode the merged carry-through
   *  array is restored as a whole — each element's aliased fields (including a
   *  tagged `id_field` that rode through) plus any alias the model echoed in its
   *  result fields. Best-effort like all restore: a model-INVENTED string that
   *  happens to equal a minted alias is restored too (the same inherent
   *  alias↔literal ambiguity the substrate carries — e.g. a contracted enum
   *  value identical to a `pii.Person<N>` alias); accepted under the comfort-layer
   *  stance. */
  const finishPii = <T>(result: T): T => (piiLedger ? restoreArgs(piiLedger, result) : result);

  const requires = deriveRequires(manifest, input);
  const ctx = deps.matchContext?.(manifest, input) ?? null;
  const stepForceLayer = input['llm.force_layer'] as ForceLayer | undefined;
  const forceLayer: ForceLayer = stepForceLayer ?? ctx?.forceLayer ?? 'any';
  // D-191 Phase 6 — exact-slot pin: a step-level `llm.pin_slot` (set by a manual
  // chat pick) wins, else the match-context hook's pin. A malformed value falls
  // through to undefined (normal routing) rather than pinning to a bad slot.
  const stepPinSlot = input['llm.pin_slot'];
  const pinSlot: PinnedSlot | undefined =
    stepPinSlot === 'slot_1' || stepPinSlot === 'slot_2'
      ? stepPinSlot
      : ctx?.pinSlot;
  const allowUpgrade = ctx?.allowUpgrade ?? deps.config.allow_upgrade_default ?? false;
  const strategy: CoordinationStrategy = deps.strategy
    ?? deps.config.free_pool_strategy
    ?? 'round_robin';

  const availability = deps.preBuiltAvailability ?? await buildAvailability({
    config: deps.config,
    quota: deps.quota,
    tabProbe: deps.tabProbe,
    budgetStatus: deps.budgetStatus,
    webChatSupported: deps.webChatSupported,
  });

  const rejectSet = new Set<string>();
  const MAX_WALKS = 3;
  let lastError: LLMError | null = null;

  for (let walk = 0; walk < MAX_WALKS; walk++) {
    let match: Match;
    try {
      match = matchLLM(
        {
          requires, allowUpgrade, forceLayer,
          ...(pinSlot ? { pinSlot } : {}),
          ...(requireModalities ? { requireModalities } : {}),
        },
        { config: deps.config, availability, quota: deps.quota, strategy, rejectSet, rng: deps.rng },
      );
    } catch (e) {
      // D-172 P5 / N.8 / Q4 — a media turn that finds no modality-capable
      // source surfaces the WARN (typed error), never a silent drop / reroute.
      // Only convert on the FIRST walk (empty rejectSet) — a later-walk
      // no-match means the capable model(s) were rate-limited/exhausted by the
      // cascade, which is the truer AI_LLM_UNAVAILABLE story.
      if (
        requireModalities
        && rejectSet.size === 0
        && e instanceof LLMError
        && e.code === 'AI_LLM_UNAVAILABLE'
      ) {
        throw new LLMError(
          'AI_MODALITY_UNSUPPORTED',
          modalityWarnMessage(requireModalities),
          { slug: manifest.slug, requireModalities },
          false,
        );
      }
      // F7a (s13 spot-run) — a no-match on a LATER walk (rejectSet non-empty)
      // means the cascade exhausted because the candidate source(s) FAILED
      // mid-call. The bare "No LLM source matches requirements (speed: quality)"
      // HIDES that — the user saw it for a transient provider 500 and read it
      // as a config problem. Lead with the real provider failure (`lastError`,
      // preserving its code so 429/retry_after detail survives) and append the
      // no-fallback context. Terminal: the cascade is done. (`rejectSet.size`
      // is 0 only on the first walk, where `e` is the genuine no-config story
      // and there is no provider error to surface — fall through.)
      if (rejectSet.size > 0 && lastError) {
        const noMatch = e instanceof Error ? e.message : String(e);
        throw new LLMError(
          lastError.code,
          `${lastError.message} — and no fallback LLM source matched after the failed source was excluded (${noMatch})`,
          { ...(lastError.details ?? {}), fallback_unavailable: noMatch, exhausted_sources: rejectSet.size },
          false,
        );
      }
      throw e;
    }

    deps.onMatchResolved?.({
      type: 'llm_match_resolved',
      snapshot: availability,
      // F7b (s13 spot-run) — the match event is a "why this LLM?" debug
      // surface a consumer may log; `winner.slot.api_key` (and a pool entry's
      // key) must never ride it. Redact at the EMIT boundary so the live
      // `match` used for the call below keeps its real key. The `snapshot`
      // is already secret-free (`free_pool` carries only `{ id, status }`).
      winner: redactMatchSecrets(match),
      reject_set: Array.from(rejectSet),
      allow_downgrade: requires.allow_downgrade === true,
      allow_upgrade: allowUpgrade,
      force_layer: forceLayer,
      ...(pinSlot ? { pin_slot: pinSlot } : {}),
    });

    try {
      const adapter = deps.adapters(match.adapterKey);
      const contracted = isContractedSlug(manifest.slug);
      const messages: LLMMessage[] = contracted
        ? buildContractedPrompt(manifest.slug, input)
        : buildUncontractedPrompt(input);

      // D-172 P5 — fold the single-mode multimodal parts onto the user turn
      // (the prompt builder produced the instruction text; the media rides
      // alongside it). No-op in batch mode (top-level parts are rejected above).
      attachContentParts(messages, contentParts);
      // D-172 follow-on — fold per-element batch media onto the user turn, each
      // block labeled by its record id so the model returns per-element results
      // keyed to `llm.id_field`. Reads ids from the aliased + media-stripped
      // `llm.data` so a PII-tagged id_field's marker matches the prompt's
      // records (and restores with the result).
      if (batchMode && batchElementMedia.length > 0) {
        attachBatchElementMedia(
          messages,
          input['llm.data'] as readonly unknown[],
          input['llm.id_field'] as string,
          batchElementMedia,
        );
      }

      // Native JSON mode — every contracted ai-* function returns JSON, and an
      // uncontracted call opts in via `llm.output_format:'json'`. Only sent when
      // the resolved slot DECLARES `supports_json` (so it never reaches a
      // text-only slot); a slot whose endpoint rejects the param
      // despite the declaration degrades via completeWithJsonFallback below.
      const wantsJson =
        contracted || input['llm.output_format'] === 'json';
      const options: LLMCompletionOptions = {
        model: match.slot.model,
        max_tokens: computeMaxTokens(match.resolved_hint, match.slot),
        thinking: shouldEnableThinking(match.resolved_hint, match.slot),
        search: wantsWebSearch(manifest, input) && match.slot.supports_search === true,
        timeout_ms: resolveLLMTimeoutMs(deps.timeout_ms),
        json: wantsJson && match.slot.supports_json === true,
      };

      deps.quota.registerRequest(matchSourceId(match));

      const result = await completeWithFallbacks(adapter, match.slot, messages, options);
      const raw = result.text;
      deps.onFinishReason?.(result.finish_reason);

      const attribution = attributionFor(match);
      if (deps.onTokenUsage) {
        deps.onTokenUsage({
          ...result.usage,
          attribution,
          // Back-compat: populate slot_key when the match was a slot.
          slot_key: attribution.kind === 'slot' ? attribution.slot_key : undefined,
        });
      }
      // Advance the round-robin cursor after a successful call. Cursor
      // keying mirrors the match-time group key so subsequent calls rotate
      // through tied candidates. `free:<tier>` covers pool API wins; `byok:<tier>` covers slot wins.
      const cursorKey = match.source.kind === 'slot'
        ? `byok:${match.resolved_hint}`
        : `free:${match.resolved_hint}`;
      deps.quota.advanceCursor(cursorKey);
      if (match.source.kind === 'pool') {
        deps.quota.recordUsage(match.source.entry.id, result.usage.total_tokens);
      } else if (match.source.kind === 'slot') {
        // Record BYOK slot consumption under the slot key so per-slot
        // daily budgets (D-079/D-094, reinstated) can be enforced via
        // `quota.tokensToday(slotKey)` in `buildAvailability`. The slot
        // key is the same id `markRateLimited`/`isInCooldown` already use.
        deps.quota.recordUsage(match.source.slot_key, result.usage.total_tokens);
      }

      // Provider adapters normalize explicit safety/refusal stops to
      // `content_filter`. Account for the completed call above, then surface a
      // stable typed refusal before contracted parsing can mislabel an absent
      // response body as malformed output. This is terminal for this call and
      // deliberately does not cascade to another provider: silently shopping a
      // refused request across models would weaken the provider's safety stop.
      if (result.finish_reason === 'content_filter') {
        throw new LLMError(
          'AI_MODEL_REFUSED',
          `${manifest.slug} was refused by the selected model`,
          { slug: manifest.slug, finish_reason: result.finish_reason },
        );
      }

      if (contracted) {
        if (batchMode) {
          // D-162 A.4 — batch result: parse the JSON array + carry-through
          // merge against `llm.data`. A null is mapped to the same terminal
          // AI_OUTPUT_INVALID path single mode uses (N.6); the retry model
          // is unchanged.
          const merged = mergeBatchResult(manifest.slug, input, raw);
          if (merged) return finishPii(merged);
          throw new LLMError(
            'AI_OUTPUT_INVALID',
            `${manifest.slug} batch output validation failed — provider returned an invalid or incomplete JSON array for the contracted schema`,
            { slug: manifest.slug, sample: raw.slice(0, 200) },
          );
        }
        const parsed = parseContractedOutput(manifest.slug, raw);
        if (parsed) return finishPii(parsed);
        throw new LLMError(
          'AI_OUTPUT_INVALID',
          `${manifest.slug} output validation failed — provider returned invalid JSON for the contracted schema`,
          { slug: manifest.slug, sample: raw.slice(0, 200) },
        );
      }

      if (input['llm.output_format'] === 'json') {
        try {
          return JSON.parse(raw);
        } catch {
          // Provider ignored the JSON-only instruction and wrapped the JSON in
          // a markdown ```json fence (or added surrounding prose) — common with
          // reasoning/coding models (e.g. DashScope's qwen3.7). Reuse the
          // contracted path's fence-tolerant extraction before giving up. Try a
          // top-level ARRAY first (a model that emits a bare list of tool calls
          // — `coerceAIOutput` wraps it downstream): `parseJSONArray` is strict
          // (it returns null for an object, whose `{` precedes any `[`), so an
          // object never matches it; without this order the object scanner would
          // greedily grab a fenced array's first element. Then fall to an object
          // (the chat AIOutput + ai-prompt json common case).
          const arr = parseJSONArray(raw);
          if (arr) return arr;
          const obj = parseJSONObject(raw);
          if (obj) return obj;
          return raw;
        }
      }
      return raw;
    } catch (e) {
      if (e instanceof LLMError && e.retryable) {
        const sourceId = matchSourceId(match);
        rejectSet.add(sourceId);
        // Persist the cooldown beyond this call so subsequent LLM calls
        // also skip the rate-limited source until Retry-After expires
        // (or the default 60s, matching the RPM window). Without this,
        // call N+1 would happily try the just-429'd source again and
        // burn a round-trip to learn it's still rate-limited.
        const retryAfterMs = typeof e.details?.retry_after_ms === 'number'
          ? e.details.retry_after_ms
          : undefined;
        deps.quota.markRateLimited(sourceId, retryAfterMs);
        lastError = e;
        continue;
      }
      throw e;
    }
  }

  throw lastError ?? new LLMError(
    'AI_LLM_UNAVAILABLE',
    `Cascade exhausted after ${MAX_WALKS} walks`,
    { walks: MAX_WALKS },
  );
};

/** F7b (s13 spot-run) — strip BYOK + free-pool secrets from a `Match` before
 *  it rides the `onMatchResolved` debug event. The live match the executor
 *  fires the call with is untouched; only this emit-boundary copy is
 *  redacted, so a consumer that logs / renders the "why this LLM?" payload
 *  can never surface the key. Two key-bearing fields: `slot.api_key`
 *  (always) and, for a pool win, `source.entry.api_key`. Shallow clones —
 *  the rest of the Match is shared by reference (read-only at the consumer). */
const REDACTED_KEY = '[redacted]';
const redactMatchSecrets = (match: Match): Match => {
  const slot = match.slot.api_key
    ? { ...match.slot, api_key: REDACTED_KEY }
    : match.slot;
  const source =
    match.source.kind === 'pool' && match.source.entry.api_key
      ? { ...match.source, entry: { ...match.source.entry, api_key: REDACTED_KEY } }
      : match.source;
  return { ...match, slot, source };
};

/** D-162 A.4 — the batch carry-through merge. Parses the model's JSON-array
 *  response (`parseContractedBatch`), then walks `llm.data` in input order
 *  (I-7 — the model's response order is untrusted), looks each input
 *  element's result fields up by its `id_field` value, and emits
 *  `{ …element, …result fields }`. Result fields win on a name collision
 *  (N.4); `id_field` itself is carried from the input element (N.2 forbids
 *  it from naming a result field).
 *
 *  Returns null — the caller maps it to `AI_OUTPUT_INVALID` — on any N.6
 *  failure: a parser-side reject (`parseContractedBatch` — bad array, bad
 *  entry, duplicate id), a model entry missing for an input id, or a model
 *  id absent from `llm.data`.
 *
 *  Called only on the `batchMode` path, so `llm.id_field` is a non-empty
 *  string and `llm.data` an array of objects (the N.2 prompt-build checks
 *  already passed) — the casts are sound. */
const mergeBatchResult = (
  slug: string,
  input: Record<string, unknown>,
  raw: string,
): AIBatchEntry[] | null => {
  const idField = input['llm.id_field'] as string;
  const data = input['llm.data'] as Record<string, unknown>[];
  const byId = parseContractedBatch(slug, raw, idField);
  if (!byId) return null;
  const merged: AIBatchEntry[] = [];
  for (const element of data) {
    const resultFields = byId.get(element[idField]);
    if (resultFields === undefined) return null; // N.6 — no model entry for this input id
    merged.push({ ...element, ...resultFields });
  }
  // N.6 — a model id absent from `llm.data`. Input ids are unique (N.2,
  // enforced at prompt-build); once every input element has resolved above,
  // a larger map means the model returned extra entries.
  if (byId.size !== data.length) return null;
  return merged;
};

/** D-136 P3 — pre-call probe. Runs `executeLLM`'s match-resolution
 *  pipeline and returns the would-be `'<provider>:<model>'` identity
 *  WITHOUT firing the underlying adapter call. Producer wrappers that
 *  fold the resolved model id into their dedup key (`runAIProducer`)
 *  call this BEFORE the dedup probe so cross-pool changes
 *  (free-pool ↔ BYOK) invalidate cached rows authored by a different
 *  model — without it, the dedup probe matches on the static
 *  producer-version hash composed with `model_id: ''` and reuses
 *  cross-model rows.
 *
 *  Returns the empty string when no match resolves (e.g. no AI path
 *  configured at all). Callers fall back to the static hash and let
 *  the actual `executeLLM` call throw `AI_LLM_UNAVAILABLE` — the
 *  probe is best-effort, not a hard guarantee.
 *
 *  No round-robin cursor advancement, no rate-limit accounting, no
 *  reject-set side effects. The probe re-runs cleanly; the actual
 *  `executeLLM` call does its own match resolution and may pick a
 *  different candidate when availability shifts between probe and
 *  call (rare; producers handle by writing the actual resolved
 *  model_id on the row). */
export const resolveLLMModelId = async (
  manifest: IngredientManifest,
  input: Record<string, unknown>,
  deps: Pick<
    LLMExecutorDeps,
    | 'config'
    | 'quota'
    | 'tabProbe'
    | 'webChatSupported'
    | 'preBuiltAvailability'
    | 'budgetStatus'
    | 'strategy'
    | 'rng'
    | 'matchContext'
  >,
): Promise<string> => {
  try {
    const requires = deriveRequires(manifest, input);
    const ctx = deps.matchContext?.(manifest, input) ?? null;
    const stepForceLayer = input['llm.force_layer'] as ForceLayer | undefined;
    const forceLayer: ForceLayer = stepForceLayer ?? ctx?.forceLayer ?? 'any';
    // D-191 Phase 6 — mirror the real call's exact-slot pin so the probe routes
    // to the SAME pinned slot (else the dedup key would never match).
    const stepPinSlot = input['llm.pin_slot'];
    const pinSlot: PinnedSlot | undefined =
      stepPinSlot === 'slot_1' || stepPinSlot === 'slot_2'
        ? stepPinSlot
        : ctx?.pinSlot;
    const allowUpgrade = ctx?.allowUpgrade ?? deps.config.allow_upgrade_default ?? false;
    const strategy: CoordinationStrategy = deps.strategy
      ?? deps.config.free_pool_strategy
      ?? 'round_robin';

    const availability = deps.preBuiltAvailability ?? await buildAvailability({
      config: deps.config,
      quota: deps.quota,
      tabProbe: deps.tabProbe,
      budgetStatus: deps.budgetStatus,
      webChatSupported: deps.webChatSupported,
    });

    // D-172 — mirror the real call's modality demand (top-level or per-element
    // batch media) so the probe routes to the SAME model. Without it a media
    // call would probe a text-only model while the real call routes to a
    // vision/audio one, and the producer dedup key would never match (avoidable
    // LLM calls every run). A malformed media declaration throws here → the
    // outer catch returns '' (best-effort; the real call re-derives + throws).
    const requireModalities = requireModalitiesFromParts(gatherMediaParts(manifest.slug, input));

    const match = matchLLM(
      {
        requires, allowUpgrade, forceLayer,
        ...(pinSlot ? { pinSlot } : {}),
        ...(requireModalities ? { requireModalities } : {}),
      },
      {
        config: deps.config,
        availability,
        quota: deps.quota,
        strategy,
        rejectSet: new Set<string>(),
        rng: deps.rng,
      },
    );
    return `${match.slot.provider}:${match.slot.model}`;
  } catch {
    return '';
  }
};

/** Identifier used for reject-set membership and quota attribution. Slots use
 *  the slot key; pool entries use their id. */
const matchSourceId = (match: Match): string => {
  switch (match.source.kind) {
    case 'slot': return match.source.slot_key;
    case 'pool': return match.source.entry.id;
  }
};

const attributionFor = (match: Match): TokenUsageAttribution => {
  switch (match.source.kind) {
    case 'slot': return { kind: 'slot', slot_key: match.source.slot_key };
    case 'pool': return { kind: 'pool', entry_id: match.source.entry.id };
  }
};

/** Pull ingredient requirements from the manifest or derive from legacy keys.
 *
 *  Legacy derivation: contracted ingredients (`ai-classify` / `ai-score` /
 *  `ai-extract` / `ai-sentiment` / `ai-compare`) need structured output, so
 *  `output_format: 'json'` is implied. For legacy ingredients the derived
 *  requirements include `allow_downgrade: true` — this preserves the silent
 *  slot-fallback behavior of the original resolveSlot (e.g. a quality-hint
 *  call on a user with only slot_1 used slot_1 silently). New ingredients
 *  should set `allow_downgrade` explicitly in `llm.requires`. */
export const deriveRequires = (
  manifest: IngredientManifest,
  input: Record<string, unknown>,
): LLMRequirements => {
  const fromManifest = manifest.input?.['llm.requires'];
  if (isLLMRequirements(fromManifest)) {
    // Input-level allow_downgrade override, if present
    const inputAd = input['llm.allow_downgrade'];
    if (typeof inputAd === 'boolean') {
      return { ...fromManifest, allow_downgrade: inputAd };
    }
    return fromManifest;
  }

  const speed = resolveHint(input, manifest);
  const outputFormat = resolveOutputFormat(manifest.slug, input);
  const needsSearch = wantsWebSearch(manifest, input);
  const inputAd = input['llm.allow_downgrade'];
  const allowDowngrade = typeof inputAd === 'boolean' ? inputAd : true; // legacy default
  return {
    speed,
    output_format: outputFormat,
    needs_search: needsSearch,
    allow_downgrade: allowDowngrade,
  };
};

const isLLMRequirements = (v: unknown): v is LLMRequirements => {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return isModelHint(r.speed);
};

const resolveOutputFormat = (
  slug: string,
  input: Record<string, unknown>,
): 'text' | 'json' => {
  if (isContractedSlug(slug)) return 'json';
  const fromInput = input['llm.output_format'];
  if (fromInput === 'json' || fromInput === 'text') return fromInput;
  return 'text';
};

const resolveHint = (
  input: Record<string, unknown>,
  manifest: IngredientManifest,
): ModelHint => {
  const fromInput = input['llm.model_hint'];
  if (isModelHint(fromInput)) return fromInput;
  const fromManifest = manifest.input?.['llm.model_hint'];
  if (isModelHint(fromManifest)) return fromManifest;
  return 'quality';
};

const isModelHint = (v: unknown): v is ModelHint =>
  v === 'fast' || v === 'quality' || v === 'thinking';

/** D-172 P5 — the N.8 warn message naming the unsupported modalities. */
const modalityWarnMessage = (req: Modalities): string => {
  const kinds = (['image', 'audio', 'document'] as const).filter((k) => req[k]).join('/');
  return `The configured LLM does not support ${kinds} input. `
    + 'Choose a model that supports it, or remove the file.';
};

/** D-172 P5 — validate + parse the top-level `llm.content_parts` into a typed
 *  `ContentPart[]`. Absent → []. Throws `AI_OUTPUT_INVALID` on a malformed
 *  declaration (fail closed; never silently drop media — I-6). */
const parseInputContentParts = (input: Record<string, unknown>): ContentPart[] => {
  const raw = input['llm.content_parts'];
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new LLMError('AI_OUTPUT_INVALID', 'llm.content_parts must be an array of content parts');
  }
  return raw.map((p, i) => validateContentPart(p, `llm.content_parts[${i}]`));
};

/** D-172 P5 — validate one provider-neutral content part. `where` names the
 *  declaration site (`llm.content_parts[i]` for single mode,
 *  `llm.data[i].content_parts[j]` for per-element batch media) so the
 *  fail-closed error points at the exact bad part. */
const validateContentPart = (p: unknown, where: string): ContentPart => {
  if (!p || typeof p !== 'object') {
    throw new LLMError('AI_OUTPUT_INVALID', `${where} must be an object`);
  }
  const part = p as Record<string, unknown>;
  if (part.type === 'text') {
    if (typeof part.text !== 'string') {
      throw new LLMError('AI_OUTPUT_INVALID', `${where}.text must be a string`);
    }
    return { type: 'text', text: part.text };
  }
  if (part.type === 'image' || part.type === 'audio' || part.type === 'document') {
    const src = part.source as Record<string, unknown> | undefined;
    if (
      !src
      || (src.kind !== 'base64' && src.kind !== 'url')
      || typeof src.media_type !== 'string'
      || typeof src.data !== 'string'
    ) {
      throw new LLMError(
        'AI_OUTPUT_INVALID',
        `${where} requires source { kind: 'base64'|'url', media_type, data }`,
      );
    }
    return { type: part.type, source: { kind: src.kind, media_type: src.media_type, data: src.data } };
  }
  throw new LLMError('AI_OUTPUT_INVALID', `${where} has an unknown type`);
};

/** D-172 follow-on — the reserved per-element media key. Each `llm.data[i]` of
 *  a contracted ai-* batch MAY carry its own media on this field; the executor
 *  strips it from the element (so it never reaches the JSON text, the PII alias
 *  pass, or the carry-through merge) and interleaves it into the batched user
 *  turn labeled by id. The producer / server-executor that resolves a
 *  per-element `file_ref` into ContentParts writes THIS key (a SEPARATE backend
 *  follow-on); exported so that wiring names one constant rather than a string
 *  literal. A real data field of the same name is treated as media and must be
 *  a valid MEDIA `ContentPart[]` — image/audio/document only, no `text` parts
 *  (those would bypass PII aliasing; see `parseElementContentParts`) — so a
 *  recipe author must rename a colliding field. */
export const BATCH_ELEMENT_MEDIA_KEY = 'content_parts';

/** D-172 follow-on — one batch element's resolved media, paired with its index
 *  into the (order-preserved) `llm.data` array. */
interface BatchElementMedia {
  index: number;
  parts: ContentPart[];
}

/** D-172 follow-on — pull the reserved per-element media key off every batch
 *  element. Returns the media (by index, in `llm.data` input order) + a cleaned
 *  `llm.data` with the key removed from each element + whether anything was
 *  removed (skip the swap when not). Fails closed (`AI_OUTPUT_INVALID`) on a
 *  present-but-malformed declaration (I-6 — never silently drop media).
 *
 *  Non-object / id-less elements are passed through untouched: the N.2
 *  `assertBatchInput` check at prompt-build is the single owner of those
 *  rejects, so this never duplicates (or diverges from) its error. */
const extractBatchElementMedia = (
  data: readonly unknown[],
): { media: BatchElementMedia[]; cleanedData: unknown[]; changed: boolean } => {
  const media: BatchElementMedia[] = [];
  const cleanedData: unknown[] = [];
  let changed = false;
  for (let i = 0; i < data.length; i++) {
    const element = data[i];
    if (element === null || typeof element !== 'object' || Array.isArray(element)) {
      cleanedData.push(element); // N.2 assertBatchInput rejects this at prompt-build
      continue;
    }
    const record = element as Record<string, unknown>;
    if (!(BATCH_ELEMENT_MEDIA_KEY in record)) {
      cleanedData.push(record);
      continue;
    }
    const parts = parseElementContentParts(record[BATCH_ELEMENT_MEDIA_KEY], i);
    const { [BATCH_ELEMENT_MEDIA_KEY]: _omit, ...rest } = record;
    cleanedData.push(rest);
    changed = true;
    if (parts.length > 0) media.push({ index: i, parts });
  }
  return { media, cleanedData, changed };
};

/** D-172 follow-on — validate one element's reserved media field into a typed
 *  `ContentPart[]`. Absent/null → []. Reuses the single-mode `validateContentPart`
 *  per part so the shape validation is identical; throws `AI_OUTPUT_INVALID` on a
 *  malformed declaration (fail closed — I-6).
 *
 *  Per-element media is MEDIA ONLY — `text` parts are rejected. A text part is
 *  provider-visible text; if it were allowed it would egress UNALIASED (the key
 *  is stripped before the PII alias pass — D5 keeps media BYTES out of aliasing),
 *  silently bypassing `llm.pii_fields` for that text. Per-record text belongs in
 *  the element's own fields, which ride the JSON `Records:` block and alias
 *  normally. Rejecting text here keeps the alias→restore round-trip airtight. */
const parseElementContentParts = (raw: unknown, elementIndex: number): ContentPart[] => {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new LLMError(
      'AI_OUTPUT_INVALID',
      `llm.data[${elementIndex}].${BATCH_ELEMENT_MEDIA_KEY} must be an array of content parts`,
      { index: elementIndex },
    );
  }
  return raw.map((p, j) => {
    const where = `llm.data[${elementIndex}].${BATCH_ELEMENT_MEDIA_KEY}[${j}]`;
    const part = validateContentPart(p, where);
    if (part.type === 'text') {
      throw new LLMError(
        'AI_OUTPUT_INVALID',
        `${where} must be media (image/audio/document) — put per-record text in the record's own fields so llm.pii_fields can alias it`,
        { index: elementIndex },
      );
    }
    return part;
  });
};

/** D-172 — gather the media `ContentPart`s a call carries for modality routing:
 *  the top-level `llm.content_parts` (single mode) or the UNION across every
 *  element's reserved `content_parts` (batch mode). Shared by `executeLLM` and
 *  the `resolveLLMModelId` dedup probe so both route to the same model for a
 *  media call (otherwise the probe — which would otherwise ignore media — could
 *  resolve a text-only model while the real call routes to a vision/audio one,
 *  and the producer dedup key would never match). Throws on a malformed
 *  declaration (I-6); the best-effort probe wraps the call in its try/catch.
 *  Does NOT mutate input — `executeLLM` strips the key separately. */
const gatherMediaParts = (
  slug: string,
  input: Record<string, unknown>,
): ContentPart[] => {
  const batch = isBatchCapableAISlug(slug) && isAIBatchMode(input);
  if (!batch) return parseInputContentParts(input);
  const data = input['llm.data'] as unknown[];
  const parts: ContentPart[] = [];
  for (let i = 0; i < data.length; i++) {
    const element = data[i];
    if (element === null || typeof element !== 'object' || Array.isArray(element)) continue;
    const record = element as Record<string, unknown>;
    if (!(BATCH_ELEMENT_MEDIA_KEY in record)) continue;
    parts.push(...parseElementContentParts(record[BATCH_ELEMENT_MEDIA_KEY], i));
  }
  return parts;
};

/** D-172 — the modality demand a media part list imposes, or undefined for a
 *  text-only call (incl. an all-text part list — it never raises the warn). The
 *  single derivation both the executor and the dedup probe use so their routing
 *  matches. */
const requireModalitiesFromParts = (parts: readonly ContentPart[]): Modalities | undefined => {
  if (parts.length === 0) return undefined;
  const demand = requiredModalities(parts);
  return hasModalityDemand(demand) ? demand : undefined;
};

/** D-172 follow-on — interleave per-element batch media onto the user turn. The
 *  prompt builder already listed every element's TEXT fields as JSON; this adds
 *  a labeled media block per element that declared media, keyed by its
 *  `idField` value (read from the aliased + cleaned `llm.data` so a PII-tagged
 *  id matches the prompt). Reuses `attachContentParts` to fold onto the last
 *  user message (its existing string content becomes a leading text part). */
const attachBatchElementMedia = (
  messages: LLMMessage[],
  data: readonly unknown[],
  idField: string,
  elementMedia: readonly BatchElementMedia[],
): void => {
  if (elementMedia.length === 0) return;
  const parts: ContentPart[] = [{
    type: 'text',
    text:
      '\n\nAttached media for the records above follows — one labeled block per '
      + `record that has media, keyed by its "${idField}". Apply each record's `
      + "media when producing that record's result.",
  }];
  for (const { index, parts: media } of elementMedia) {
    const id = (data[index] as Record<string, unknown>)[idField];
    parts.push({ type: 'text', text: `\n\nMedia for ${idField}=${JSON.stringify(id)}:` });
    parts.push(...media);
  }
  attachContentParts(messages, parts);
};

/** D-172 P5 — fold media parts onto the last user message. The user
 *  message's existing string `content` becomes a leading text part so the
 *  model sees the instruction text alongside the media; `content` itself is
 *  left intact (additive — non-multimodal consumers still read it). When
 *  there is no user message, one is appended. */
const attachContentParts = (messages: LLMMessage[], parts: ContentPart[]): void => {
  if (parts.length === 0) return;
  let target: LLMMessage | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') {
      target = messages[i];
      break;
    }
  }
  if (!target) {
    target = { role: 'user', content: '' };
    messages.push(target);
  }
  // D-164 — when the turn ALREADY carries `content_parts` (e.g. the prompt-cache
  // prefix/suffix split, whose first block holds a `cache_breakpoint`), append
  // the media AFTER those blocks so the breakpoint survives. Otherwise the
  // existing string `content` becomes the leading text part (the D-172 default).
  // Rebuilding from `content` unconditionally would erase a cache split (today a
  // no-op — chat main-turns carry no media — but correct for a future multimodal
  // chat turn).
  const lead: ContentPart[] =
    target.content_parts && target.content_parts.length > 0
      ? [...target.content_parts]
      : target.content
        ? [{ type: 'text', text: target.content }]
        : [];
  target.content_parts = [...lead, ...parts];
};
