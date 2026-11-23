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

import type { LLMSlot, OpenAIOffEffort } from './types.js';

const hostOf = (base_url: string | undefined): string | undefined => {
  if (base_url === undefined || base_url === '') return undefined;
  try {
    return new URL(base_url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
};
const on = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);

/** OpenAI's own API: a slot of the OpenAI protocol with no address, which the OpenAI adapter sends to
 *  api.openai.com, or one whose address is on openai.com. Every other server speaking the protocol
 *  keeps its own rules, here and for the output cap's name (`adapters/openai.ts`). */
export const isOpenAIApi = (slot: Pick<LLMSlot, 'provider' | 'base_url'>): boolean => {
  if (slot.provider !== 'openai' && slot.provider !== 'openai-compatible') return false;
  if (slot.base_url === undefined) return true;
  const host = hostOf(slot.base_url);
  return host !== undefined && on(host, 'openai.com');
};

/** "Thinking off" on OpenAI's API: the lowest `reasoning_effort` first. Each model takes only some.
 *  OpenAI's pages (read 2026-11-16) give `gpt-6-luna` `none` but not `minimal`, refuse `none` on
 *  `gpt-6-astra`, and give `gpt-6.1-sol` neither, so `low` is as far down as it goes. One value sent
 *  to every model was refused by some, and a refused switch used to be dropped, which left the model
 *  thinking at its default. So an endpoint that refuses one is asked with the next
 *  (`noteThinkingStepRefused`, `endpoint-capabilities.ts`). */
export const OPENAI_OFF_EFFORTS: readonly OpenAIOffEffort[] = ['none', 'minimal', 'low'];

/** The Anthropic request fields for each way to turn thinking off, in the order tried. Claude's
 *  models disagree (the claude-api reference, cached 2026-11-03): most take `disabled`; Sonnet 5.5
 *  refuses it and turns thinking off with `between_tools`; Opus 5.5 and Fable cannot stop thinking at
 *  all, so the least they do is the lowest effort. ⛔ Off used to send NOTHING, which is "off" only on
 *  models that do not think by default: every Claude 5.x model does, so Off changed nothing there. */
const ANTHROPIC_OFF: ReadonlyArray<Record<string, unknown>> = [
  { thinking: { type: 'disabled' } },
  { thinking: { type: 'between_tools' } },
  { output_config: { effort: 'low' } },
];

/** The Anthropic request fields for each way to turn thinking on, in the order tried: `adaptive` on
 *  4.6 and later; a token budget on older models (Haiku 4.5), and the only form before. ⛔ The budget
 *  form is refused by every Claude 5.x model and by Opus 4.7 and 4.8. `maxTokens` sizes it, as before. */
const anthropicOn = (maxTokens: number): ReadonlyArray<Record<string, unknown>> => [
  { thinking: { type: 'adaptive' } },
  { thinking: { type: 'enabled', budget_tokens: Math.floor(maxTokens / 2) } },
];

/** How many ways a provider has to send one thinking setting, tried in order until the endpoint takes
 *  one (`noteThinkingStepRefused`). One for every provider not named here: its single form, dropped
 *  when refused, as before. */
export const thinkingStepCount = (slot: Pick<LLMSlot, 'provider' | 'base_url'>, thinking: boolean): number => {
  if (slot.provider === 'anthropic') return thinking ? anthropicOn(0).length : ANTHROPIC_OFF.length;
  if (isOpenAIApi(slot)) return thinking ? 1 : OPENAI_OFF_EFFORTS.length;
  return 1;
};

/** The Anthropic request fields for the owner's thinking setting, the `step`-th way of sending it
 *  (`thinkingStepCount`). */
export const anthropicThinkingFields = (
  thinking: boolean,
  step: number,
  maxTokens: number,
): Record<string, unknown> => {
  const ways = thinking ? anthropicOn(maxTokens) : ANTHROPIC_OFF;
  return ways[Math.min(step, ways.length - 1)]!;
};

/** The request fields that turn `slot`'s thinking on (`true`) or off (`false`), merged into its body;
 *  `undefined` for an endpoint whose thinking is its model's alone (DeepSeek's reasoner). `step` is
 *  how many of OpenAI's "off" efforts the endpoint has refused (`OPENAI_OFF_EFFORTS`). */
export const openAiThinkingSwitch = (
  slot: Pick<LLMSlot, 'provider' | 'base_url'>,
  thinking: boolean,
  step = 0,
): Record<string, unknown> | undefined => {
  if (isOpenAIApi(slot)) {
    return { reasoning_effort: thinking ? 'medium' : OPENAI_OFF_EFFORTS[Math.min(step, OPENAI_OFF_EFFORTS.length - 1)] };
  }
  const host = hostOf(slot.base_url);
  if (host === undefined) return undefined;
  // Qwen on Alibaba Cloud Model Studio (DashScope), in its OpenAI-compatible mode.
  if (on(host, 'aliyuncs.com')) return { enable_thinking: thinking };
  if (on(host, 'openrouter.ai')) return { reasoning: { enabled: thinking } };
  if (on(host, 'groq.com')) return { reasoning_effort: thinking ? 'default' : 'none' };
  // Gemini's OpenAI-compatible endpoint.
  if (on(host, 'googleapis.com')) return { reasoning_effort: thinking ? 'medium' : 'none' };
  if (on(host, 'deepseek.com')) return undefined;
  return { chat_template_kwargs: { enable_thinking: thinking } };
};

/** The field names a provider's refusal of the switch would name, for `isThinkingSwitchRejection`.
 *  `output_config` / `effort` are Anthropic's last way to turn thinking down: a model that knows no
 *  thinking at all refuses that too, and must end with the switch dropped, not the call failed. */
export const THINKING_SWITCH_FIELDS =
  /enable_thinking|chat_template_kwargs|reasoning_effort|reasoning|thinking_?config|thinkingbudget|thinking|output_config|\beffort\b/i;
