/** D-344 slice A — a model's thinking is the owner's setting: on each slot and free-pool entry, sent
 *  as its provider's switch on every call through it, and no switch when none is set. D-335 E
 *  measured a provider thinking by default for every call, 2,363 to 12,256 reasoning tokens on one
 *  question about a page, with nothing in Recued able to turn it off. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IngredientManifest, WebChatTab } from '@recued/contracts';

import { createAnthropicAdapter } from '../adapters/anthropic.js';
import { createGoogleAdapter } from '../adapters/google.js';
import { createOpenAIAdapter } from '../adapters/openai.js';
import { forgetEndpoint, resetEndpointCapabilities } from '../endpoint-capabilities.js';
import { executeLLM } from '../executor.js';
import { createQuotaTracker } from '../quota.js';
import { resolveThinking } from '../router.js';
import { openAiThinkingSwitch } from '../thinking-switch.js';
import { LLMError } from '../types.js';
import type { LLMAdapter, LLMCompletionOptions, LLMConfig, LLMSlot } from '../types.js';
import { parseLLMConfig } from '../validate-config.js';

beforeEach(() => resetEndpointCapabilities());

const DASHSCOPE = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
const slotAt = (base_url: string | undefined, provider: LLMSlot['provider'] = 'openai-compatible'): LLMSlot => ({
  provider, model: 'm', api_key: 'k', ...(base_url !== undefined ? { base_url } : {}) });

describe('D-344 — each provider\'s switch', () => {
  it('chooses the field by the host an OpenAI-compatible endpoint answers on', () => {
    expect(openAiThinkingSwitch(slotAt(DASHSCOPE), false)).toEqual({ enable_thinking: false });
    expect(openAiThinkingSwitch(slotAt('https://openrouter.ai/api/v1'), true)).toEqual({ reasoning: { enabled: true } });
    expect(openAiThinkingSwitch(slotAt('https://api.groq.com/openai/v1'), false)).toEqual({ reasoning_effort: 'none' });
    expect(openAiThinkingSwitch(slotAt('https://generativelanguage.googleapis.com/v1beta/openai'), false))
      .toEqual({ reasoning_effort: 'none' });
    expect(openAiThinkingSwitch(slotAt(undefined, 'openai'), false)).toEqual({ reasoning_effort: 'minimal' });
    expect(openAiThinkingSwitch(slotAt('https://api.deepseek.com/v1'), false)).toBeUndefined();
    // A server it does not know: the chat template's switch, as vLLM and SGLang read it.
    expect(openAiThinkingSwitch(slotAt('http://localhost:8000/v1'), false)).toEqual({ chat_template_kwargs: { enable_thinking: false } });
  });

  it('a call\'s thinking: the owner\'s setting first, else reasoning for the thinking tier, else none', () => {
    expect(resolveThinking('fast', { ...slotAt(DASHSCOPE), thinking: 'off' })).toBe(false);
    expect(resolveThinking('thinking', { ...slotAt(DASHSCOPE), thinking: 'off', supports_thinking: true })).toBe(false);
    expect(resolveThinking('fast', { ...slotAt(DASHSCOPE), thinking: 'on' })).toBe(true);
    expect(resolveThinking('thinking', { ...slotAt(DASHSCOPE), supports_thinking: true })).toBe(true);
    expect(resolveThinking('fast', slotAt(DASHSCOPE))).toBeUndefined();
  });
});

describe('D-344 — the adapters send it, and only when set', () => {
  const realFetch = globalThis.fetch;
  let bodies: Array<Record<string, unknown>> = [];
  const answer = (json: unknown) => vi.fn(async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  beforeEach(() => { bodies = []; });
  afterEach(() => { globalThis.fetch = realFetch; });
  const options = (thinking?: boolean): LLMCompletionOptions => ({ model: 'm', max_tokens: 100, timeout_ms: null,
    ...(thinking !== undefined ? { thinking } : {}) });
  const message = [{ role: 'user' as const, content: 'hi' }];

  it('OpenAI-compatible: the endpoint\'s field when set, nothing when not', async () => {
    globalThis.fetch = answer({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) as unknown as typeof fetch;
    const adapter = createOpenAIAdapter('openai-compatible');
    await adapter.complete(slotAt(DASHSCOPE), message, options(false));
    await adapter.complete(slotAt(DASHSCOPE), message, options(true));
    await adapter.complete(slotAt(DASHSCOPE), message, options());
    expect(bodies.map((body) => body.enable_thinking)).toEqual([false, true, undefined]);
  });

  it('Gemini: a thinking budget of 0 off and -1 on; Anthropic: thinking only on', async () => {
    globalThis.fetch = answer({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } }) as unknown as typeof fetch;
    const google = createGoogleAdapter();
    await google.complete(slotAt(undefined, 'google'), message, options(false));
    await google.complete(slotAt(undefined, 'google'), message, options());
    expect(bodies.map((body) => (body.generationConfig as Record<string, unknown>).thinkingConfig))
      .toEqual([{ thinkingBudget: 0 }, undefined]);
    bodies = [];
    globalThis.fetch = answer({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 } }) as unknown as typeof fetch;
    const anthropic = createAnthropicAdapter();
    await anthropic.complete(slotAt(undefined, 'anthropic'), message, options(false));
    await anthropic.complete(slotAt(undefined, 'anthropic'), message, options(true));
    expect(bodies.map((body) => body.thinking)).toEqual([undefined, { type: 'enabled', budget_tokens: 50 }]);
  });
});

describe('D-344 — every call through the model follows it, and a refused switch is dropped once', () => {
  const manifest: IngredientManifest = { slug: 'ai-prompt', name: 'Prompt', description: '', author: 'recued', kind: 'ai',
    category: 'ai', risk_tier: 'read', input: {}, output: {} };
  const noTabs = async (): Promise<Set<WebChatTab>> => new Set();
  const recording = (refuse?: LLMError) => {
    const seen: Array<boolean | undefined> = [];
    const adapter: LLMAdapter = {
      provider: 'openai-compatible',
      complete: async (_slot, _messages, opts) => {
        seen.push(opts.thinking);
        if (refuse && opts.thinking !== undefined) throw refuse;
        return { text: 'ok', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
      },
    };
    return { adapter, seen };
  };
  const run = (config: LLMConfig, adapter: LLMAdapter) => executeLLM(manifest, { 'llm.prompt': 'q' },
    { config, adapters: () => adapter, quota: createQuotaTracker(), tabProbe: noTabs });

  it('a slot\'s setting reaches the call; a slot without one sends no switch', async () => {
    const { adapter, seen } = recording();
    await run({ slot_1: { ...slotAt(DASHSCOPE), thinking: 'off' } }, adapter);
    await run({ slot_1: slotAt(DASHSCOPE) }, adapter);
    expect(seen).toEqual([false, undefined]);
  });

  it('a free-pool entry\'s setting reaches the call too', async () => {
    const { adapter, seen } = recording();
    await run({ slot_1: null, free_pool: [{ id: 'qwen', type: 'api', provider: 'openai-compatible', model: 'm', api_key: 'k',
      base_url: DASHSCOPE, speed: 'fast', supports_json: true, enabled: true, thinking: 'off' }] } as unknown as LLMConfig, adapter);
    expect(seen).toEqual([false]);
  });

  it('an endpoint that refuses the switch is asked again without it, and not sent it again until forgotten', async () => {
    const refused = new LLMError('AI_LLM_UNAVAILABLE', 'LLM error (400): Unrecognized request argument supplied: chat_template_kwargs');
    const { adapter, seen } = recording(refused);
    const slot: LLMSlot = { ...slotAt('http://localhost:8000/v1'), thinking: 'off' };
    expect(await run({ slot_1: slot }, adapter)).toBe('ok');
    expect(await run({ slot_1: slot }, adapter)).toBe('ok');
    expect(seen).toEqual([false, undefined, undefined]);
    forgetEndpoint(slot);
    await run({ slot_1: slot }, adapter);
    expect(seen.at(-2)).toBe(false);
  });

  it('another refusal is not taken for the switch\'s', async () => {
    const { adapter } = recording(new LLMError('AI_LLM_UNAVAILABLE', 'LLM error (400): model not found'));
    await expect(run({ slot_1: { ...slotAt(DASHSCOPE), thinking: 'off' } }, adapter)).rejects.toThrow(/model not found/);
  });
});

describe('D-344 — the setting is on or off', () => {
  it('validates on slots and pool entries, and refuses anything else', () => {
    const config = parseLLMConfig({ slot_1: { ...slotAt(DASHSCOPE), thinking: 'off' },
      free_pool: [{ id: 'q', type: 'api', provider: 'openai-compatible', model: 'm', api_key: 'k', speed: 'fast',
        supports_json: true, enabled: true, thinking: 'on' }] });
    expect(config.slot_1?.thinking).toBe('off');
    expect(config.free_pool?.[0]?.thinking).toBe('on');
    expect(() => parseLLMConfig({ slot_1: { ...slotAt(DASHSCOPE), thinking: 'maybe' } })).toThrow(/thinking.*on \| off/);
  });
});
