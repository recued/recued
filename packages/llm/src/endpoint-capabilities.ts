/** Endpoint capability detection — what an endpoint ACTUALLY accepts, learned
 *  from what it refuses, never from what someone declared.
 *
 *  Two capabilities live here, and they are the same problem twice:
 *    - the `system` wire role  (was an owner-facing picker; now detected)
 *    - native JSON mode        (still owner-DECLARED via `supports_json`,
 *                               and the declaration is not verified)
 *
 *  Both are discovered the same way: send the capable form, and if the
 *  endpoint refuses AT THE REQUEST BOUNDARY, drop that one thing and retry.
 *  Both refusals cost zero completion tokens, which is what makes retrying
 *  compatible with the zero-retry policy.
 *
 *  ── Why this exists at all ─────────────────────────────────────────
 *  A handful of OpenAI-compatible endpoints reject a `system` role outright:
 *  early reasoning models, and self-hosted servers whose chat template has no
 *  system turn. Recued used to answer that with an owner-facing setting — a
 *  `system / user / assistant` picker in Settings → AI/Models, stored PER
 *  SURFACE. Three things were wrong with it:
 *
 *  1. It asked the owner for a fact only the ENDPOINT knows. The only way to
 *     discover the answer is to send a request and read the 400 — which is
 *     what this module does, once, instead of asking.
 *  2. It was stored on the wrong thing. Role support is a property of
 *     (provider, base_url, model); the setting lived on the surface. One chat
 *     surface routes to a BYOK slot that accepts `system` and a free-pool entry
 *     that does not, and one surface-level value cannot be right for both.
 *  3. Its three options read as three prompt slots. There has only ever been
 *     ONE stored string per surface delivered as ONE message — the picker's
 *     vocabulary described a data shape the substrate does not have.
 *
 *  ⚠ `system` is not merely the sensible default — on two of the three
 *  first-party adapters it is the only value that composes correctly.
 *  `adapters/anthropic.ts` (`splitSystem`) promotes a system message into
 *  `body.system`; `adapters/google.ts` (`splitGoogleMessages`) promotes it into
 *  `system_instruction`. Demote it there and the prompt falls out of the
 *  dedicated instruction channel into the ordinary conversation — losing
 *  Anthropic prompt caching, and weakening adherence to the AIOutput contract,
 *  which is the part that most needs it. So demotion must be driven by an
 *  actual refusal, never by preference. It is.
 *
 *  ── Shape ──────────────────────────────────────────────────────────
 *  Modelled on `isJsonModeRejection` / `completeWithJsonFallback` in
 *  `executor.ts`, which solves the identical problem for the native JSON-mode
 *  param, and for the same reason: the rejection lands at the REQUEST boundary,
 *  before any completion tokens are billed, so retrying once preserves the
 *  zero-retry policy (one successful call = one billing event).
 *
 *  🔑 THE MEMORY IS IN-PROCESS *AND* PERSISTED — the trade this comment once
 *  named as hypothetical was taken in `243521a2a`, and the objection was
 *  ANSWERED rather than overruled. This package still owns the in-memory truth;
 *  the server owns storage, hydrating at boot via
 *  {@link hydrateEndpointCapabilities} and writing through the
 *  {@link onEndpointCapabilityLearned} durability seam (`packages/` cannot
 *  import `backend/`, so the seam is the whole mechanism).
 *
 *  The original objection was that a persisted "this endpoint refuses system"
 *  becomes a cache with no way to see it and no way to clear it — the
 *  invisible-stuck-setting the picker was removed for. That is still the
 *  governing constraint, and it is why durability shipped WITH
 *  {@link forgetEndpoint} and a re-probe rather than on its own: a wrong
 *  detection is undoable by the owner instead of permanent. What persistence
 *  buys is that the cost of being wrong is no longer paid again on every boot.
 *
 *  ⛔ SO THE THING TO PRESERVE IS THE CLEARABILITY, NOT THE FORGETFULNESS. A
 *  future change that keeps the write and drops the forget/re-probe path
 *  recreates exactly the setting this design was built to avoid, and it will
 *  look like a simplification when it does. */

import type { ContentPart, LLMMessage, LLMSlot } from './types.js';
import { LLMError } from './types.js';
import { joinTextParts } from './adapters/content-parts.js';

/** The shapes endpoints actually use to say "not that role".
 *
 *  ⛔ NARROW ON PURPOSE, same discipline as `isJsonModeRejection`: a false
 *  negative costs one surfaced error the owner can act on; a FALSE POSITIVE
 *  silently rewrites the prompt's structure and masks a real bad request.
 *
 *  ⚠ "roles must alternate" is deliberately NOT here. It is a different fault,
 *  and demoting a system message is one of the things that CAUSES it — treating
 *  it as a system-role refusal would make this module retry itself into the
 *  very error it was reacting to. */
const SYSTEM_ROLE_REJECTION_RE = new RegExp(
  [
    // OpenAI reasoning-model shape:
    // "Unsupported value: 'messages[0].role' does not support 'system' with this model."
    'messages\\[\\d+\\]\\.role[\'"`]?\\s+does not support\\s+[\'"`]?system',
    // "System role not supported" / "system messages are not supported"
    'system\\s+(?:role|message)s?\\s+(?:is\\s+|are\\s+)?(?:not supported|unsupported)',
    // "'system' is not a valid role" / "'system' role is not supported"
    '[\'"`]system[\'"`]\\s*(?:role\\s*)?(?:is\\s+)?(?:not\\s+(?:a\\s+valid|supported)|unsupported)',
    // "only user and assistant roles are supported"
    'only\\s+user\\s+and\\s+assistant\\s+roles?\\s+are\\s+supported',
  ].join('|'),
  'i',
);

/** Did the provider reject the request BECAUSE of the `system` role?
 *
 *  Gated exactly like `isJsonModeRejection`: a non-retryable `LLMError` only.
 *  Auth / rate-limit / 5xx are retryable and are excluded so they still surface
 *  and still reroute; `AI_TOKEN_BUDGET_EXCEEDED` is excluded because an
 *  over-long prompt is not a role problem and demoting would not fix it. */
export const isSystemRoleRejection = (e: unknown): boolean =>
  e instanceof LLMError
  && !e.retryable
  && e.code !== 'AI_TOKEN_BUDGET_EXCEEDED'
  && SYSTEM_ROLE_REJECTION_RE.test(e.message);

/** What actually determines the answer. NOT the slot key: an owner who repoints
 *  slot_1 at a different model must get a fresh probe, and two slots sharing one
 *  local server + model must share one answer. `api_key` is deliberately absent
 *  — rotating a key does not change a chat template, and keying on a secret
 *  would put it in a process-lifetime map. */
export const endpointFingerprint = (slot: LLMSlot): string =>
  `${slot.provider} ${slot.base_url ?? ''} ${slot.model}`;

const unsupported = new Set<string>();

/** Record that this endpoint refuses `system`, so the next call demotes up
 *  front instead of paying the rejection again. Process-lifetime only — see the
 *  module header for why that is the design and not a shortcut. */
export const noteSystemRoleUnsupported = (slot: LLMSlot): void => {
  const key = endpointFingerprint(slot);
  unsupported.add(key);
  announce(key);
};

export const systemRoleUnsupported = (slot: LLMSlot): boolean =>
  unsupported.has(endpointFingerprint(slot));

/** Test seam. Also the "forget everything and re-probe" lever if a caller ever
 *  wants one (e.g. after the owner edits provider settings). */
export const resetEndpointCapabilities = (): void => {
  unsupported.clear();
  jsonUnsupported.clear();
  contextBounds.clear();
};

/** Drop everything learned about ONE endpoint, so the next call re-detects.
 *
 *  ⛔ THIS IS WHAT KEEPS THE CACHE FALSIFIABLE, and `probeLlmSource` calls it
 *  before every probe. Without it a probe is SELF-CONFIRMING: the fallback
 *  reads the memory and sends the degraded request up front, so the probe never
 *  re-tests the capability and reports back the very thing that was already
 *  cached. In-process that is a wart a restart clears. Persisted, it is a
 *  permanent verdict that no affordance in the product can overturn — which is
 *  precisely the invisible-stuck-flag this whole line of work removed once
 *  already. */
export const forgetEndpoint = (slot: LLMSlot): void => {
  const key = endpointFingerprint(slot);
  unsupported.delete(key);
  jsonUnsupported.delete(key);
  // ⛔ The learned window is forgotten too. The module header's governing
  // constraint is CLEARABILITY, and a bound is the one learned fact here that
  // silently shrinks what the model can see — so it is the LAST thing that
  // should survive an owner asking for a re-probe.
  contextBounds.delete(key);
  // ⚠ ANNOUNCE THE FORGETTING TOO, or the clear lasts only until the next
  // boot. Storage is written from `snapshotEndpointCapabilities()`, and a
  // fully-forgotten fingerprint drops out of that snapshot — but only if
  // something triggers the write. Without this, Test connection would appear
  // to overturn a stale verdict, and hydration would hand it straight back on
  // the next restart.
  announce(key);
};

/** One endpoint's learned capabilities, as persisted. Absent flags mean
 *  "supported" — the optimistic default, so a store that loses a row degrades
 *  to one extra probe rather than to a permanently crippled endpoint. */
export interface EndpointCapabilityNote {
  fingerprint: string;
  system_role_unsupported?: boolean;
  json_mode_unsupported?: boolean;
}

type LearnListener = (note: EndpointCapabilityNote) => void;
let onLearned: LearnListener | undefined;

/** Durability seam. `packages/` cannot import `backend/`, so this package owns
 *  the in-memory truth and the SERVER owns storage: it hydrates at boot and
 *  subscribes here to write through.
 *
 *  ⚠ The listener must never throw into the call path — a failed capability
 *  WRITE must not fail the LLM call that discovered it. Guarded below. */
export const onEndpointCapabilityLearned = (
  listener: LearnListener | undefined,
): void => {
  onLearned = listener;
};

const noteFor = (fingerprint: string): EndpointCapabilityNote => ({
  fingerprint,
  ...(unsupported.has(fingerprint) ? { system_role_unsupported: true } : {}),
  ...(jsonUnsupported.has(fingerprint) ? { json_mode_unsupported: true } : {}),
});

const announce = (fingerprint: string): void => {
  if (!onLearned) return;
  try {
    onLearned(noteFor(fingerprint));
  } catch {
    // Persistence is an optimisation. Losing it costs one probe next boot;
    // letting it throw would fail a call that had already succeeded.
  }
};

/** Restore what a previous process learned. Called once at boot. */
export const hydrateEndpointCapabilities = (
  notes: readonly EndpointCapabilityNote[],
): void => {
  for (const note of notes) {
    if (note.system_role_unsupported === true) unsupported.add(note.fingerprint);
    if (note.json_mode_unsupported === true) jsonUnsupported.add(note.fingerprint);
  }
};

/** Everything currently known, for a caller that wants to prune or inspect. */
export const snapshotEndpointCapabilities = (): EndpointCapabilityNote[] => {
  const keys = new Set([...unsupported, ...jsonUnsupported]);
  return [...keys].map(noteFor);
};

// ── Native JSON mode ────────────────────────────────────────────────
//
// ⚠ `supports_json` is owner/pool-DECLARED and defaults ON, so a slot whose
// endpoint does not implement `response_format` 400s on every call that wants
// JSON — which is nearly every call, since every contracted ai-* function
// returns JSON. The fallback for that has existed since D-137 and works, but it
// had NO MEMORY: it re-paid the rejected round-trip on EVERY call, forever,
// because nothing recorded the answer. Same shape as the system-role probe, so
// it gets the same treatment.

const jsonUnsupported = new Set<string>();

/** Did this error come from the provider REJECTING the native JSON-mode param
 *  (`response_format` / `responseMimeType`), as opposed to a genuine failure?
 *
 *  Moved here from `executor.ts` so the two capability detectors sit together
 *  and share one discipline. Narrow on purpose: a false negative just means the
 *  (rare) opaque-message rejection surfaces once per call instead of being
 *  cached; a false positive would mask a real error.
 *
 *  ⛔ THE OLD ADVICE HERE WAS "the owner sets `supports_json:false`", AND IT
 *  WAS A TRAP. That field is a MATCH input — `match.ts:121` excludes such a
 *  source from every json call, which is every contracted ai-* function and all
 *  of chat — so following it would take a slot that merely lacks the
 *  `response_format` param and make it unroutable, converting a graceful
 *  degradation into a total outage. Nothing in the UI can set it (there is no
 *  control), and nothing should: the fallback below plus the post-hoc parser
 *  already handle a missing native mode, and Test connection reports it. */
export const isJsonModeRejection = (e: unknown): boolean =>
  e instanceof LLMError
  && !e.retryable
  && e.code !== 'AI_TOKEN_BUDGET_EXCEEDED'
  && /response[_ ]?format|json[_ ]?object|responsemimetype|json mode|json_schema/i.test(
    e.message,
  );

export const noteJsonModeUnsupported = (slot: LLMSlot): void => {
  const key = endpointFingerprint(slot);
  jsonUnsupported.add(key);
  announce(key);
};

export const jsonModeUnsupported = (slot: LLMSlot): boolean =>
  jsonUnsupported.has(endpointFingerprint(slot));

// ── Context window ──────────────────────────────────────────────────
//
// ⛔⛔ THE THIRD CAPABILITY, AND THE SAME PROBLEM A THIRD TIME. `slot
// .context_window_tokens` is OWNER-TYPED ONLY — a census of the tree
// (2026-09-03) found it read in `llm-config.ts` and written back from settings,
// and supplied by NOTHING else: no model table, no probe, no default. Two
// surfaces then diverge on the absence, and BOTH are wrong:
//
//   · chat  — `input_token_budget` is undefined, `promptFits` short-circuits
//             to true, and every trim in `chat-turn-executor.ts` is inert.
//             That is why the tail-eviction loop carries the comment "Normal
//             chat never enters this branch", why a 113,616-token request went
//             out and was accepted, and why `ChatContextLength` appears ZERO
//             times in 1,546 stored bench reports. The guard is correct and
//             starved of its one input.
//   · gateway — `resolveRouteContextBudget` REFUSES the call outright with
//             `llm_gateway_context_window_not_configured`.
//
// 🔑 A STATIC `model -> window` MAP CANNOT FIX THAT, for the reason this whole
// module exists: one adapter serves every openai-compatible server (its own
// comment names Together, Groq, Ollama, vLLM) and `base_url` overrides the
// endpoint, so the reachable set is open and the windows are often unpublished.
// The endpoint is the only authority on its own limit — so learn it here,
// beside the two capabilities already learned exactly this way.
//
// The record is two numbers, and BOTH are needed:
//   · floor (`accepted`) — the largest input this endpoint has ACCEPTED. Free:
//                          every success already reports `usage.input_tokens`.
//   · ceiling (`refused`) — learned from one context-length refusal.
//
// ⚠ Nothing is learned until one exists, so an endpoint that has never refused
// behaves byte-identically to today.

interface ContextBounds {
  /** Largest input observed to SUCCEED. A budget may never fall below it. */
  accepted?: number;
  /** Total context ceiling, learned from a refusal. */
  refused?: number;
}

const contextBounds = new Map<string, ContextBounds>();

/** Did the provider refuse because the INPUT was too large?
 *
 *  ⛔ DO NOT RE-DERIVE THIS FROM THE MESSAGE TEXT. `classifyProviderError`
 *  already made this call at the HTTP boundary, where it had the STATUS CODE
 *  (413, or `PROVIDER_CONTEXT_OVERFLOW_RE` against the body) — strictly more
 *  evidence than a second regex over the rendered message would have. A
 *  parallel classifier here would drift from that one and disagree with it.
 *
 *  ⛔ AND IT MUST NOT BE RETRYABLE. Auth, quota, 429 and 5xx are all built as
 *  `retryable`, and a 429 body routinely says "too many tokens" — learning a
 *  ceiling from a rate limit would cap the endpoint at whatever happened to be
 *  in flight when the owner hit their quota. The retryable flag is the guard,
 *  and it is set by the same function that recognised the overflow. */
export const isContextOverflowRejection = (e: unknown): boolean =>
  e instanceof LLMError && !e.retryable && e.code === 'AI_TOKEN_BUDGET_EXCEEDED';

/** Raise the proven floor from a successful call. */
export const noteContextAccepted = (slot: LLMSlot, inputTokens: number): void => {
  if (!Number.isSafeInteger(inputTokens) || inputTokens <= 0) return;
  const key = endpointFingerprint(slot);
  const prev = contextBounds.get(key);
  if (prev !== undefined && (prev.accepted ?? 0) >= inputTokens) return;
  contextBounds.set(key, { ...prev, accepted: inputTokens });
};

/** Learn the ceiling from a refusal.
 *
 *  ⛔⛔ A CEILING AT OR BELOW A PROVEN FLOOR IS WRONG AND IS DISCARDED, AND
 *  THIS GUARD IS THE WHOLE SAFETY ARGUMENT FOR LEARNING A NUMBER AT ALL. The
 *  failure being fenced against is not "we fail to learn a limit" — it is
 *  learning a WRONG one: a low ceiling caches, and the endpoint is over-trimmed
 *  forever, silently, in the direction that LOSES context. That is worse than
 *  the problem being solved.
 *
 *  If the candidate sits under an input this endpoint has already accepted, the
 *  observation contradicts reality — a shared key routing elsewhere, a changed
 *  model behind one name, a stated number that is not the window. The floor is
 *  EVIDENCE; the candidate is INFERENCE; evidence wins.
 *
 *  ⚠ `attemptedInputTokens` is our own conservative ESTIMATE, not the
 *  provider's count (a refused call reports no usage). It is therefore an upper
 *  bound on nothing — it is only ever used to say "at least this much was too
 *  much", which is why it becomes the ceiling rather than being trusted as one. */
/** The provider's own ceiling, when it names one.
 *
 *  ⛔⛔ WITHOUT THIS THE FIRST BOUND IS USELESSLY LOOSE, AND THAT IS NOT A
 *  ROUNDING ERROR — IT IS THE DIFFERENCE BETWEEN CONVERGING IN ONE TURN AND
 *  CONVERGING IN SEVERAL VISIBLE FAILURES. The fallback ceiling is our estimate
 *  of the prompt that was just refused, which is an upper bound on nothing
 *  useful: send 500,000 tokens at an 8,192-token endpoint and the learned
 *  ceiling is ~500,000, the next budget is still vastly over, and the turn
 *  fails again. Each failure only ratchets down by however much the trim
 *  happened to remove. The provider states the real number in the same body
 *  `PROVIDER_CONTEXT_OVERFLOW_RE` already matched — taking it makes the very
 *  next turn fit.
 *
 *  ⚠ BOTH UNITS ARE NOW TOKENS, and that was not always true. This figure is
 *  the provider's own token count; the fallback below is
 *  `estimateConservativeMessagesTokens`, which returned one token per UTF-8
 *  BYTE until the divisor was fixed. While it did, the floor guard compared two
 *  scales — an inflated proven-accepted floor could veto a TRUE stated limit
 *  (accept 54,000 byte-units on a call the provider counted at ~13,500, then
 *  discard a genuine 32,768 as "below the floor"). Keep both sides in the
 *  estimator's tokens; a future exact tokenizer replaces the estimate without
 *  reopening this.
 *
 *  ⛔ THE SMALLEST PLAUSIBLE NUMBER WINS, because these messages carry two
 *  ("maximum context length is 128000 tokens, however you requested 130000")
 *  and the limit is never the larger. Anything under 1,000 is discarded as a
 *  model name, an error code, or a status. */
const statedContextLimit = (error: unknown): number | undefined => {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (text.length === 0) return undefined;
  // ⛔⛔ ADJACENCY IS THE WHOLE GUARD — A BARE DIGIT SCAN IS ACTIVELY UNSAFE.
  //   "gpt-4o-2024-08-06: maximum context length is 128000 tokens" contains
  //   `2024`, which passes any plausible magnitude filter and is SMALLER than
  //   the real limit, so a smallest-wins rule would cache a 2,024-token ceiling
  //   and over-trim that endpoint permanently. Model names carry dates and
  //   version numbers; what they never carry is a following "tokens". Both
  //   first-party phrasings put the figure immediately before `tokens` or
  //   `maximum`, so require that.
  const numbers = [...text.matchAll(/(\d[\d,_]{2,})\s*(?:tokens?\b|maximum\b)/gu)]
    .map((m) => Number(m[1]!.replace(/[,_]/gu, '')))
    // ⚠ The magnitude floor is belt-and-braces and is NOT load-bearing today:
    // mutation testing (2026-09-03) shows removing it leaves every test green,
    // because the adjacency requirement above already excludes the cases it was
    // written for. It stays because the direction it guards is the unrecoverable
    // one — a sub-1,000 ceiling would silently cripple an endpoint — but it is
    // recorded here as unexercised rather than presented as verified.
    .filter((n) => Number.isSafeInteger(n) && n >= 1_000);
  return numbers.length > 0 ? Math.min(...numbers) : undefined;
};

export const noteContextRefused = (
  slot: LLMSlot,
  attemptedInputTokens: number | undefined,
  error?: unknown,
): void => {
  const candidate = statedContextLimit(error)
    ?? (Number.isSafeInteger(attemptedInputTokens ?? NaN) ? attemptedInputTokens : undefined);
  if (candidate === undefined || candidate <= 0) return;
  const key = endpointFingerprint(slot);
  const prev = contextBounds.get(key);
  const floor = prev?.accepted;
  // ⚠ BOTH SIDES ARE TOKENS. That is load-bearing and was not always true:
  //   while the estimator returned one token per UTF-8 byte, the floor was
  //   ~3x inflated and could veto a genuine provider-stated ceiling that sat
  //   below it. If the estimate ever drifts from the provider's scale again,
  //   this guard silently stops learning rather than announcing anything.
  //   Failing to learn is recoverable on the next refusal; a wrong bound is
  //   not, which is why the guard errs this way and not the other.
  if (floor !== undefined && candidate <= floor) return;
  // A second, smaller refusal is better evidence than the first — keep the
  // lowest ceiling seen, since everything above it is known to fail too.
  if (prev?.refused !== undefined && prev.refused <= candidate) return;
  contextBounds.set(key, { ...prev, refused: candidate });
};

/** The learned context window for this endpoint, or `undefined`.
 *
 *  ⛔ A FLOOR ALONE IS NOT A CEILING, and returns nothing. Knowing 113,616
 *  tokens were accepted proves nothing about where the limit is, and trimming
 *  on that guess would discard context that fits. Only a refusal bounds the
 *  window from above, which is why the error path is the one that teaches. */
export const learnedContextWindow = (slot: LLMSlot): number | undefined =>
  contextBounds.get(endpointFingerprint(slot))?.refused;

/** The largest input this endpoint is KNOWN to accept — the floor a computed
 *  budget must never fall below. */
export const provenAcceptedInput = (slot: LLMSlot): number | undefined =>
  contextBounds.get(endpointFingerprint(slot))?.accepted;

/** The window to budget against when ANY of `slots` might serve the turn.
 *
 *  ⛔⛔ WHY A MINIMUM, AND WHY THIS FUNCTION EXISTS AT ALL. The obvious design —
 *  resolve the slot, then look up its window — CANNOT be done before the call:
 *  `matchLLM` picks among candidates using `deps.rng` and live quota state, so a
 *  pre-call match is a DIFFERENT DRAW from the one the call will make. Budgeting
 *  to a slot that then loses the draw is not a smaller bug than not budgeting;
 *  it is a prompt trimmed to the wrong endpoint's limit.
 *
 *  So the budget is taken over the whole candidate set, and the only figure that
 *  is safe for every possible draw is the smallest known one.
 *
 *  ⚠ THIS IS A BOUND, NOT A GUARANTEE, AND THE GAP IS NAMED ON PURPOSE. A
 *  candidate with NO learned window contributes nothing to the minimum, so if it
 *  wins the draw and its true window is smaller, the prompt can still overflow —
 *  and it then teaches its own bound, which is exactly the intended path. What
 *  this rules out is the silent case: once ANY candidate is known to be small,
 *  no turn is composed as though every candidate were large. */
export const minLearnedContextWindow = (
  slots: readonly LLMSlot[],
): number | undefined => {
  let min: number | undefined;
  for (const slot of slots) {
    const learned = learnedContextWindow(slot);
    if (learned === undefined) continue;
    if (min === undefined || learned < min) min = learned;
  }
  return min;
};

/** The floor a computed budget must never fall below, over the same candidate
 *  set. The MAXIMUM proven-accepted input: trimming below a size some candidate
 *  has already swallowed would discard context that demonstrably fits. */
export const maxProvenAcceptedInput = (
  slots: readonly LLMSlot[],
): number | undefined => {
  let max: number | undefined;
  for (const slot of slots) {
    const proven = provenAcceptedInput(slot);
    if (proven === undefined) continue;
    if (max === undefined || proven > max) max = proven;
  }
  return max;
};

export const hasSystemMessage = (messages: readonly LLMMessage[]): boolean =>
  messages.some((m) => m.role === 'system');

/** Read one message's text whether it carries `content_parts` or plain
 *  `content`. A system turn is plain text in every path we build today; this
 *  stays total anyway rather than silently dropping a parts-carrying one. */
const messageText = (m: LLMMessage): string =>
  m.content_parts && m.content_parts.length > 0
    ? joinTextParts(m.content_parts)
    : m.content;

/** Fold every `system` message into the FIRST user turn and drop them.
 *
 *  ⚠ MERGE, not relabel. Rewriting `role:'system'` → `role:'user'` in place
 *  leaves two consecutive user turns, and a chunk of the same endpoints that
 *  refuse a system role ALSO require strict user/assistant alternation — the
 *  "fix" would trade one 400 for another. Merging cannot produce that.
 *
 *  Order is preserved, and multiple system messages join in wire order (the
 *  gateway forwards the caller's own system messages alongside Recued's, and
 *  under a refusal ALL of them have to move or the request still fails).
 *
 *  ⚠ `content_parts`: the merged text is prepended as a new text part AND to
 *  `content`, so an adapter reading either sees it. This shifts the D-164
 *  cache breakpoint off the catalog prefix — which is inert here, because
 *  `cache_breakpoint` is honoured only by the Anthropic adapter and Anthropic
 *  promotes system messages rather than refusing them, so this path never runs
 *  against an explicit-caching provider. */
/*  D-116 AND THIS MERGE — checked, and it holds.
 *
 *  The contracted instruction/data shape puts the instruction half in a system
 *  message and fences the data between engine-private sentinels
 *  (`prompts.ts` → `D116_DELIMITER`). Merging moves the instruction half into
 *  the user turn, so it is worth stating why that does not dismantle the
 *  construction: THE SENTINEL IS THE TRUST BOUNDARY, NOT THE ROLE —
 *  `prompts.ts:238` says so where it refuses to let the owner's role knob touch
 *  this shape. The sentinel is high-entropy and engine-private, so data still
 *  cannot reconstruct it, and merging changes nothing about that.
 *
 *  🔑 And the alternative is not "keep the role separation" — it is NO CALL AT
 *  ALL. On an endpoint that refuses a system role there is no system channel to
 *  separate into; the instruction half travels as user text or it does not
 *  travel. Pinned by `demoteSystemMessages` + D-116 in the test file. */
export const demoteSystemMessages = (
  messages: readonly LLMMessage[],
): LLMMessage[] => {
  const systemText = messages
    .filter((m) => m.role === 'system')
    .map(messageText)
    .filter((t) => t.length > 0)
    .join('\n\n');
  const rest = messages.filter((m) => m.role !== 'system');
  if (systemText.length === 0) return [...rest];

  const target = rest.findIndex((m) => m.role === 'user');
  // No user turn to carry it (a system-only or assistant-led prompt) — the text
  // still has to reach the model, so it becomes the leading user turn itself.
  if (target < 0) return [{ role: 'user', content: systemText }, ...rest];

  return rest.map((m, i) => {
    if (i !== target) return m;
    const merged = `${systemText}\n\n${m.content}`;
    if (!m.content_parts || m.content_parts.length === 0) {
      return { ...m, content: merged };
    }
    const parts: ContentPart[] = [
      { type: 'text', text: `${systemText}\n\n` },
      ...m.content_parts,
    ];
    return { ...m, content: merged, content_parts: parts };
  });
};
