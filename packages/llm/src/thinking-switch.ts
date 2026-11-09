/** D-344 — how an OpenAI or OpenAI-compatible endpoint's thinking is turned on or off.
 *
 *  The owner's setting for a model (`LLMSlot.thinking`) is sent as its provider's switch on every
 *  call through it. One adapter serves every OpenAI-compatible server, and each takes its own field,
 *  so the field is chosen by the host the endpoint answers on; a server this does not know takes the
 *  chat template's (`chat_template_kwargs.enable_thinking`, as vLLM and SGLang read it for Qwen). An
 *  endpoint that refuses the field is retried once without it and remembered
 *  (`noteThinkingSwitchUnsupported`), so a wrong guess costs one refused request a process.
 *
 *  D-335 E measured why: through a proxy, Recued's and browser-use's calls on qwen3.7-plus both
 *  thought by default, and an Ask a web page call spent 2,363 reasoning tokens (43 s) on one run and
 *  12,256 on another, which `max_tokens` did not bound. */

import type { LLMSlot } from './types.js';

const hostOf = (base_url: string | undefined): string | undefined => {
  if (base_url === undefined || base_url === '') return undefined;
  try {
    return new URL(base_url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
};
const on = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);

/** The request fields that turn `slot`'s thinking on (`true`) or off (`false`), merged into its body;
 *  `undefined` for an endpoint whose thinking is its model's alone (DeepSeek's reasoner). */
export const openAiThinkingSwitch = (slot: Pick<LLMSlot, 'provider' | 'base_url'>, thinking: boolean)
  : Record<string, unknown> | undefined => {
  if (slot.provider === 'openai') {
    const host = hostOf(slot.base_url);
    if (host === undefined || on(host, 'openai.com')) return { reasoning_effort: thinking ? 'medium' : 'minimal' };
  }
  const host = hostOf(slot.base_url);
  if (host === undefined) return undefined;
  // Qwen on Alibaba Cloud Model Studio (DashScope), in its OpenAI-compatible mode.
  if (on(host, 'aliyuncs.com')) return { enable_thinking: thinking };
  if (on(host, 'openrouter.ai')) return { reasoning: { enabled: thinking } };
  if (on(host, 'groq.com')) return { reasoning_effort: thinking ? 'default' : 'none' };
  // Gemini's OpenAI-compatible endpoint.
  if (on(host, 'googleapis.com')) return { reasoning_effort: thinking ? 'medium' : 'none' };
  if (on(host, 'openai.com')) return { reasoning_effort: thinking ? 'medium' : 'minimal' };
  if (on(host, 'deepseek.com')) return undefined;
  return { chat_template_kwargs: { enable_thinking: thinking } };
};

/** The field names a provider's refusal of the switch would name, for `isThinkingSwitchRejection`. */
export const THINKING_SWITCH_FIELDS = /enable_thinking|chat_template_kwargs|reasoning_effort|reasoning|thinking_?config|thinkingbudget|thinking/i;
