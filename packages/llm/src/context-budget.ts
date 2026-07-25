import type { LLMMessage } from './types.js';

/** Reserved provider framing/headroom beyond the explicit output allowance. */
export const DEFAULT_CONTEXT_SAFETY_MARGIN_TOKENS = 256;

/** Conservative allowance for role delimiters and provider message framing. */
export const LLM_TEXT_MESSAGE_OVERHEAD_TOKENS = 16;

const UTF8 = new TextEncoder();

/**
 * Cross-provider upper-bound estimate for TEXT content.
 *
 * The supported providers ultimately tokenize non-empty byte sequences; using
 * one token per UTF-8 byte deliberately overestimates normal prose while also
 * remaining conservative for code, identifiers, CJK, emoji, and unknown
 * OpenAI-compatible tokenizers. Exact provider tokenizers can replace this
 * estimate later without changing the budget contract.
 */
export const estimateConservativeTextTokens = (value: string): number =>
  UTF8.encode(value).byteLength;

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
