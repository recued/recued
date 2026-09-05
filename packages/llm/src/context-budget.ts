import type { LLMMessage } from './types.js';

/** Reserved provider framing/headroom beyond the explicit output allowance. */
export const DEFAULT_CONTEXT_SAFETY_MARGIN_TOKENS = 256;

/** Conservative allowance for role delimiters and provider message framing. */
export const LLM_TEXT_MESSAGE_OVERHEAD_TOKENS = 16;

const UTF8 = new TextEncoder();

/** UTF-8 bytes per token. The single conversion between the two units this
 *  file straddles: content is measured in bytes, windows are declared in
 *  tokens.
 *
 *  ⛔⛔ THIS WAS EFFECTIVELY 1, AND THAT WAS NOT CONSERVATISM — IT WAS A 3x
 *  OVER-COUNT WITH NO BACKSTOP. One-token-per-byte reads as the safe choice
 *  (a token is never fewer than one byte, so it cannot under-count), and for
 *  years nothing consumed it, so nothing exposed the cost. Once chat became
 *  budgeted it did: on a 32,768-token endpoint the budget came out at 24,512
 *  and the tool catalog ALONE is ~29,064 bytes, so the trim ladder ran to
 *  exhaustion, evicted the conversation 6 rows down to 1, and the provider
 *  then counted that prompt at ~7,000 real tokens and accepted it happily.
 *  Measured. A bound that fires 3-4x early does not protect anything; it
 *  destroys context and reports success.
 *
 *  ✅ CALIBRATED, NOT ASSUMED. Measured with a real BPE tokenizer
 *  (`o200k_base`, the GPT-4o/5 encoding; `cl100k_base` agrees within 1.5%)
 *  over every model-bound string in all 1,546 stored bench reports — 20,008
 *  samples — plus constructed payloads for the content classes that corpus
 *  does not contain. Ratios are for WHOLE PACKETS, because that is what
 *  `promptFits` measures:
 *
 *    round 1, no tool calls yet ........ 4.82
 *    typical, prose tool result ........ 4.47
 *    bench corpus, 20,008 strings ...... 4.71 aggregate, 3.95 MINIMUM
 *    worst realistic, id-only result ... 2.82
 *    extreme, thinned catalog + ids .... 2.15   ← the binding case
 *
 *  ⛔⛔ THE BENCH CORPUS ALONE WOULD HAVE CALIBRATED THIS WRONG. Its minimum is
 *  3.95, which makes 3 look comfortably safe — but every one of those packets
 *  is prose-heavy, because the bench asks conversational questions. Real tool
 *  results are frequently NOT: a 400-row id+hash listing measures 1.95, uuids
 *  2.08, enrichment rows 2.81. A corpus that never exercises a content class
 *  reports it as absent, not as safe.
 *
 *  ⛔ AND RUNG 0 MAKES THE WORST CASE WORSE, WHICH IS WHY 2 AND NOT 2.5.
 *  `fitCatalogModeToBudget` thins the catalog exactly when the budget is
 *  tight — and the catalog is the field that DILUTES id-dense results (it
 *  measures 4.84 on its own). Removing it leaves the id-dense payload
 *  dominant, which is how the extreme 2.15 arises. The mitigation moves the
 *  binding case, so the constant has to cover the post-mitigation packet.
 *
 *  ⚠ The cost is over-estimating a prose-heavy packet by ~2.2x. That is
 *  accepted deliberately: see the asymmetry below, and note that a learned
 *  ceiling is only meaningful if the estimate does not UNDER-count — a stated
 *  128,000-token limit is stored and compared in these units, so systematic
 *  under-counting would let a budgeted turn exceed a ceiling we had already
 *  learned. Over-counting merely trims early, and an unreachable trim is now
 *  abandoned rather than shipped.
 *
 *  ⚠ A SINGLE CONSTANT SPANS A 2.25x RANGE (2.15 → 4.82) BECAUSE THE RATIO IS
 *  A PROPERTY OF CONTENT, NOT OF THE PACKET. A content-sensitive estimate —
 *  weighing id-shaped runs differently from prose — would recover most of that
 *  and is the obvious next step if the conservatism starts costing real
 *  context. Not built: it needs its own calibration corpus, and one honest
 *  constant beats a heuristic nobody measured.
 *
 *  ⛔ AND THE ASYMMETRY NOW RUNS THE OTHER WAY, which is what makes 3 safe
 *  where 1 was not. An UNDER-estimate is self-correcting: the provider refuses,
 *  `noteContextRefused` learns the real ceiling from the refusal (preferring
 *  the provider's own stated number), and the context-overflow retry recomposes
 *  under it inside the same turn. None of that machinery existed when this was
 *  written. An OVER-estimate has no backstop at all — it silently discards
 *  context on a call that would have succeeded, and nothing ever reports it. */
export const ESTIMATED_BYTES_PER_TOKEN = 2;

/**
 * Cross-provider estimate for TEXT content, in TOKENS.
 *
 * The supported providers ultimately tokenize non-empty byte sequences, so the
 * byte length is the stable cross-tokenizer signal; {@link
 * ESTIMATED_BYTES_PER_TOKEN} converts it to the unit every window is declared
 * in. Exact provider tokenizers can replace this estimate later without
 * changing the budget contract.
 */
export const estimateConservativeTextTokens = (value: string): number =>
  Math.ceil(UTF8.encode(value).byteLength / ESTIMATED_BYTES_PER_TOKEN);

/** Estimate one text-only provider-neutral message, including framing. */
export const estimateConservativeMessageTokens = (
  message: Pick<LLMMessage, 'role' | 'content'>,
): number =>
  LLM_TEXT_MESSAGE_OVERHEAD_TOKENS
  + estimateConservativeTextTokens(message.role)
  + estimateConservativeTextTokens(message.content);

/** Estimate a complete text-only message list. */
export const estimateConservativeMessagesTokens = (
  messages: ReadonlyArray<Pick<LLMMessage, 'role' | 'content'>>,
): number =>
  messages.reduce(
    (total, message) => total + estimateConservativeMessageTokens(message),
    0,
  );

/**
 * Return the usable input-token budget after reserving output + safety room.
 * `null` means the metadata is invalid or leaves no input capacity.
 */
export const computeContextInputTokenBudget = (
  contextWindowTokens: number,
  reservedOutputTokens: number,
  safetyMarginTokens = DEFAULT_CONTEXT_SAFETY_MARGIN_TOKENS,
): number | null => {
  if (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens <= 0) return null;
  if (!Number.isSafeInteger(reservedOutputTokens) || reservedOutputTokens < 0) return null;
  if (!Number.isSafeInteger(safetyMarginTokens) || safetyMarginTokens < 0) return null;
  const available = contextWindowTokens - reservedOutputTokens - safetyMarginTokens;
  return available > 0 ? available : null;
};
