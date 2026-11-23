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
    // OpenAI's own API: off is as far down as the model goes, `none` until it refuses that.
    expect(openAiThinkingSwitch(slotAt(undefined, 'openai'), false)).toEqual({ reasoning_effort: 'none' });
    expect(openAiThinkingSwitch(slotAt(undefined, 'openai'), false, 2)).toEqual({ reasoning_effort: 'low' });
    expect(openAiThinkingSwitch(slotAt('https://api.openai.com/v1'), true)).toEqual({ reasoning_effort: 'medium' });
    // No address sends an OpenAI-compatible slot to api.openai.com, so it gets OpenAI's switch.
    expect(openAiThinkingSwitch(slotAt(undefined), false)).toEqual({ reasoning_effort: 'none' });
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

  it('Gemini: a thinking budget of 0 off and -1 on; Anthropic: disabled off and adaptive on', async () => {
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
    await anthropic.complete(slotAt(undefined, 'anthropic'), message, options());
    // ⛔ Off used to send nothing, which every Claude 5.x model reads as "think as you like".
    expect(bodies.map((body) => body.thinking)).toEqual([{ type: 'disabled' }, { type: 'adaptive' }, undefined]);
  });
});

/** Claude's models take different forms of the same setting (the claude-api reference, cached
 *  2026-11-03), and refuse the rest with a 400 naming the field. The real executor and Anthropic
 *  adapter against a fake api.anthropic.com that refuses what `refuse` names. */
describe('D-344 — Claude takes the setting in the form the model knows', () => {
  const manifest: IngredientManifest = { slug: 'ai-prompt', name: 'Prompt', description: '', author: 'recued', kind: 'ai',
    category: 'ai', risk_tier: 'read', input: {}, output: {} };
  const noTabs = async (): Promise<Set<WebChatTab>> => new Set();
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  /** What a request asked for: its thinking type, else the effort it set, else nothing. */
  const asked = (body: Record<string, unknown>): string | undefined =>
    (body.thinking as { type?: string } | undefined)?.type
    ?? ((body.output_config as { effort?: string } | undefined)?.effort !== undefined
      ? `effort ${(body.output_config as { effort: string }).effort}` : undefined);
  const anthropicApi = (refuse: string[]) => {
    const seen: Array<string | undefined> = [];
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const form = asked(body);
      seen.push(form);
      if (form !== undefined && refuse.includes(form)) {
        const field = form.startsWith('effort') ? 'output_config.effort' : 'thinking.type';
        return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error',
          message: `${field}: '${form}' is not supported for this model.` } }),
        { status: 400, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return seen;
  };
  const run = (slot: LLMSlot) => executeLLM(manifest, { 'llm.prompt': 'q' },
    { config: { slot_1: slot }, adapters: () => createAnthropicAdapter(), quota: createQuotaTracker(), tabProbe: noTabs });
  const claude = (model: string, thinking: 'on' | 'off'): LLMSlot => ({ provider: 'anthropic', model, api_key: 'k', thinking });

  it('off on Sonnet 5.5 is between_tools, kept once found', async () => {
    const seen = anthropicApi(['disabled']);
    const slot = claude('claude-sonnet-5-5', 'off');
    expect(await run(slot)).toBe('ok');
    expect(await run(slot)).toBe('ok');
    expect(seen).toEqual(['disabled', 'between_tools', 'between_tools']);
  });

  it('off on Opus 5.5, which cannot stop thinking, is its lowest effort', async () => {
    const seen = anthropicApi(['disabled', 'between_tools']);
    expect(await run(claude('claude-opus-5-5', 'off'))).toBe('ok');
    expect(seen).toEqual(['disabled', 'between_tools', 'effort low']);
  });

  it('on is adaptive, and a budget on a model that predates it', async () => {
    const seen = anthropicApi(['adaptive']);
    expect(await run(claude('claude-haiku-4-5', 'on'))).toBe('ok');
    expect(seen).toEqual(['adaptive', 'enabled']);
  });

  it('a model that knows no thinking at all ends with the switch dropped, not the call failed', async () => {
    const seen = anthropicApi(['disabled', 'between_tools', 'effort low']);
    expect(await run(claude('claude-3-5-haiku', 'off'))).toBe('ok');
    expect(seen).toEqual(['disabled', 'between_tools', 'effort low', undefined]);
  });

  it('remembers each direction apart, and forgets both on Test connection', async () => {
    const seen = anthropicApi(['disabled', 'adaptive']);
    const off = claude('claude-haiku-4-5', 'off');
    const on = claude('claude-haiku-4-5', 'on');
    await run(off);
    await run(on);
    await run(off);
    await run(on);
    expect(seen).toEqual(['disabled', 'between_tools', 'adaptive', 'enabled', 'between_tools', 'enabled']);
    forgetEndpoint(off);
    await run(on);
    expect(seen.at(-2)).toBe('adaptive');
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

/** OpenAI's models each take a different lowest effort, and refuse the rest with a 400 in the words
 *  below. These run the real executor and the real OpenAI adapter against a fake api.openai.com. */
describe('D-344 — thinking off on OpenAI\'s API goes as low as the model takes', () => {
  const manifest: IngredientManifest = { slug: 'ai-prompt', name: 'Prompt', description: '', author: 'recued', kind: 'ai',
    category: 'ai', risk_tier: 'read', input: {}, output: {} };
  const noTabs = async (): Promise<Set<WebChatTab>> => new Set();
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  /** A fake OpenAI that refuses the efforts in `refuse` ("Unsupported value"), or, with `noReasoning`,
   *  the parameter itself ("Unsupported parameter"), as `gpt-4.1-mini` does. */
  const openAI = (opts: { refuse?: string[]; noReasoning?: boolean }) => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      const effort = body.reasoning_effort;
      const refusal = effort === undefined ? undefined
        : opts.noReasoning ? 'Unsupported parameter: \'reasoning_effort\' is not supported with this model.'
          : opts.refuse?.includes(String(effort))
            ? `Unsupported value: 'reasoning_effort' does not support '${String(effort)}' with this model. Supported values are: 'low', 'medium', and 'high'.`
            : undefined;
      if (refusal !== undefined) {
        return new Response(JSON.stringify({ error: { message: refusal, type: 'invalid_request_error',
          param: 'reasoning_effort', code: opts.noReasoning ? 'unsupported_parameter' : 'unsupported_value' } }),
        { status: 400, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return bodies;
  };
  const run = (slot: LLMSlot) => executeLLM(manifest, { 'llm.prompt': 'q' },
    { config: { slot_1: slot }, adapters: () => createOpenAIAdapter('openai'), quota: createQuotaTracker(), tabProbe: noTabs });

  it('asks with the next effort up when one is refused, keeps the one taken, and starts over when forgotten', async () => {
    const bodies = openAI({ refuse: ['none', 'minimal'] });
    const slot: LLMSlot = { provider: 'openai', model: 'gpt-6.1-sol', api_key: 'k', thinking: 'off' };
    expect(await run(slot)).toBe('ok');
    expect(bodies.map((body) => body.reasoning_effort)).toEqual(['none', 'minimal', 'low']);
    expect(await run(slot)).toBe('ok');
    expect(bodies.map((body) => body.reasoning_effort)).toEqual(['none', 'minimal', 'low', 'low']);
    // Every attempt names the cap as OpenAI's reasoning models require.
    expect(bodies.every((body) => body.max_completion_tokens !== undefined && body.max_tokens === undefined)).toBe(true);
    forgetEndpoint(slot);
    await run(slot);
    expect(bodies.at(-3)?.reasoning_effort).toBe('none');
  });

  it('drops the switch at once for a model that does not reason, instead of walking the efforts', async () => {
    const bodies = openAI({ noReasoning: true });
    expect(await run({ provider: 'openai', model: 'gpt-4.1-mini', api_key: 'k', thinking: 'off' })).toBe('ok');
    expect(bodies.map((body) => body.reasoning_effort)).toEqual(['none', undefined]);
  });

  it('drops the switch once every effort is refused', async () => {
    const bodies = openAI({ refuse: ['none', 'minimal', 'low'] });
    expect(await run({ provider: 'openai', model: 'm', api_key: 'k', thinking: 'off' })).toBe('ok');
    expect(bodies.map((body) => body.reasoning_effort)).toEqual(['none', 'minimal', 'low', undefined]);
  });

  it('on is medium, which every reasoning model takes, and walks nothing', async () => {
    const bodies = openAI({ refuse: ['none', 'minimal'] });
    expect(await run({ provider: 'openai', model: 'm', api_key: 'k', thinking: 'on' })).toBe('ok');
    expect(bodies.map((body) => body.reasoning_effort)).toEqual(['medium']);
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
