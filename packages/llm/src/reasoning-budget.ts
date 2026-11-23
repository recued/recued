import type { LLMCompletionOptions, LLMSlot } from './types.js';

/** Request-local resource hint. Capability is deliberately limited to the
 * endpoint/model qualified for this wire protocol. It never enables thinking
 * or changes saved configuration; unsupported routes retain their old body. */
export function openAiReasoningBudget(slot: LLMSlot, options: LLMCompletionOptions): { thinking_budget: number } | undefined {
  const budget = options.reasoning_token_budget;
  if (slot.provider !== 'openai-compatible' || options.model !== 'qwen3.7-plus' || options.thinking !== true
    || !Number.isSafeInteger(budget) || Number(budget) <= 0) return undefined;
  try {
    const url = new URL(slot.base_url ?? '');
    if (url.protocol !== 'https:' || url.hostname !== 'coding-intl.dashscope.aliyuncs.com' || url.port
      || url.username || url.password || url.search || url.hash || !['/v1', '/v1/'].includes(url.pathname)) return undefined;
    return { thinking_budget: budget! };
  } catch { return undefined; }
}
