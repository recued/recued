import type { LLMConfig, LLMSlot } from '@recued/llm';

/** Resolve LLM config from environment variables.
 *
 *  Env var convention:
 *    RECUED_LLM_PROVIDER=openai            (slot_1 provider)
 *    RECUED_LLM_MODEL=gpt-4.1-mini         (slot_1 model)
 *    RECUED_LLM_API_KEY=sk-...             (slot_1 API key)
 *    RECUED_LLM_BASE_URL=...               (slot_1 base URL, optional)
 *    RECUED_LLM_SLOT2_PROVIDER=anthropic   (slot_2 provider)
 *    RECUED_LLM_SLOT2_MODEL=claude-opus-4-6 (slot_2 model)
 *    RECUED_LLM_SLOT2_API_KEY=sk-ant-...   (slot_2 API key)
 *    RECUED_LLM_THINKING=off               (D-344: slot_1's thinking, on | off; unset, the provider's default)
 *    RECUED_LLM_SLOT2_THINKING=on          (D-344: slot_2's thinking)
 *    RECUED_LLM_CONTEXT_WINDOW_TOKENS=128000 (slot_1's context window, as Settings → AI models takes it; unset, none)
 *    RECUED_LLM_SLOT2_CONTEXT_WINDOW_TOKENS=200000 (slot_2's)
 */
const thinkingOf = (value: string | undefined): LLMSlot['thinking'] =>
  value === 'on' || value === 'off' ? value : undefined;
/** A window in whole tokens; anything else is no window, as an empty Settings field is. */
const windowOf = (value: string | undefined): { context_window_tokens: number } | Record<string, never> => {
  const tokens = value !== undefined && /^[1-9]\d{0,9}$/.test(value.trim()) ? Number(value.trim()) : undefined;
  return tokens !== undefined && Number.isSafeInteger(tokens) ? { context_window_tokens: tokens } : {};
};

export const resolveLLMConfigFromEnv = (
  env: Record<string, string | undefined> = process.env,
): LLMConfig | undefined => {
  const provider = env.RECUED_LLM_PROVIDER;
  const model = env.RECUED_LLM_MODEL;
  const apiKey = env.RECUED_LLM_API_KEY;

  if (!provider || !model || !apiKey) return undefined;

  const slot_1: LLMSlot = {
    provider: provider as LLMSlot['provider'],
    model,
    api_key: apiKey,
    base_url: env.RECUED_LLM_BASE_URL,
    ...(thinkingOf(env.RECUED_LLM_THINKING) !== undefined ? { thinking: thinkingOf(env.RECUED_LLM_THINKING) } : {}),
    ...windowOf(env.RECUED_LLM_CONTEXT_WINDOW_TOKENS),
  };

  const config: LLMConfig = { slot_1 };

  const p2 = env.RECUED_LLM_SLOT2_PROVIDER;
  const m2 = env.RECUED_LLM_SLOT2_MODEL;
  const k2 = env.RECUED_LLM_SLOT2_API_KEY;
  if (p2 && m2 && k2) {
    config.slot_2 = {
      provider: p2 as LLMSlot['provider'],
      model: m2,
      api_key: k2,
      base_url: env.RECUED_LLM_SLOT2_BASE_URL,
      ...(thinkingOf(env.RECUED_LLM_SLOT2_THINKING) !== undefined ? { thinking: thinkingOf(env.RECUED_LLM_SLOT2_THINKING) } : {}),
      ...windowOf(env.RECUED_LLM_SLOT2_CONTEXT_WINDOW_TOKENS),
    };
  }

  return config;
};
