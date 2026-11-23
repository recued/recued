import { beforeEach, expect, it } from 'vitest';
import type { IngredientManifest, WebChatTab } from '@recued/contracts';
import { buildLLMCompletionRequest, executeLLM, prepareLLMInput } from '../executor.js';
import { resetEndpointCapabilities } from '../endpoint-capabilities.js';
import { createQuotaTracker } from '../quota.js';
import { LLMError, type LLMAdapter, type LLMConfig, type LLMMessage, type LLMSlot, type Match } from '../types.js';

const manifest: IngredientManifest = { slug: 'ai-prompt', name: 'Prompt', description: '', author: 'recued',
  kind: 'ai', category: 'ai', risk_tier: 'read', input: {}, output: {} };
const base = 'Base instructions with full reasoning.';
const compact = 'Compact result instructions.';
const input = { 'llm.system_prompt': base, 'llm.system_prompt_when_thinking_off': compact,
  'llm.prompt': '{"owner":"Keep my exact text and evidence."}', 'llm.output_format': 'json' };
const slot: LLMSlot = { provider: 'openai-compatible', model: 'fixture', api_key: 'test',
  base_url: 'http://localhost:8000/v1', speed: 'fast', supports_json: true };
const matchFor = (thinking?: LLMSlot['thinking']): Match => ({ source: { kind: 'slot', slot_key: 'slot_1' },
  slot: { ...slot, ...(thinking ? { thinking } : {}) }, adapterKey: slot.provider,
  resolved_hint: 'fast', used_downgrade: false, used_upgrade: false });
const noTabs = async (): Promise<Set<WebChatTab>> => new Set();
beforeEach(() => resetEndpointCapabilities());

it.each(['off', 'on', undefined] as const)('selects only the actual source policy (%s) and preserves data, role and cached content', thinking => {
  const prepared = prepareLLMInput(manifest, { ...input, 'llm.system_role': 'user', 'llm.cache_prefix': 'owner' });
  const request = buildLLMCompletionRequest(manifest, prepared, matchFor(thinking));
  const original = buildLLMCompletionRequest(manifest, prepareLLMInput(manifest, {
    ...input, 'llm.system_prompt_when_thinking_off': undefined, 'llm.system_role': 'user', 'llm.cache_prefix': 'owner',
  }), matchFor(thinking));
  expect(request.messages[0]).toEqual({ role: 'user', content: thinking === 'off' ? compact : base });
  expect(request.messages.slice(1)).toEqual(original.messages.slice(1));
  expect(request.messages).toHaveLength(original.messages.length);
  expect(prepared.input['llm.system_prompt']).toBe(base);
  if (thinking !== 'off') expect(request).toEqual(original);
});

it('honors off even for the thinking tier and rejects a malformed variant without reflecting it', () => {
  const match = { ...matchFor('off'), resolved_hint: 'thinking' as const };
  expect(buildLLMCompletionRequest(manifest, prepareLLMInput(manifest, input), match).messages[0]?.content).toBe(compact);
  expect(() => buildLLMCompletionRequest(manifest, prepareLLMInput(manifest, {
    ...input, 'llm.system_prompt_when_thinking_off': { credential: 'private-value' },
  }), match)).toThrow('llm.system_prompt_when_thinking_off must be a string');
});

it('preserves the compact prompt through switch rejection and remembered protocol fallback', async () => {
  const seen: Array<{ messages: LLMMessage[]; thinking: boolean | undefined }> = [];
  const adapter: LLMAdapter = { provider: slot.provider, complete: async (_slot, messages, options) => {
    seen.push({ messages, thinking: options.thinking });
    if (options.thinking !== undefined) throw new LLMError('AI_LLM_UNAVAILABLE',
      'LLM error (400): Unrecognized request argument supplied: chat_template_kwargs');
    return { text: '{"response":"done"}', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  } };
  const deps = { config: { slot_1: { ...slot, thinking: 'off' as const } }, adapters: () => adapter,
    quota: createQuotaTracker(), tabProbe: noTabs };
  await executeLLM(manifest, input, deps);
  await executeLLM(manifest, input, deps);
  expect(seen.map(call => call.thinking)).toEqual([false, undefined, undefined]);
  expect(seen.every(call => call.messages[0]?.content === compact)).toBe(true);
});

it('reselects the prompt for a different source on cascade, rather than using the first slot setting', async () => {
  const seen: Array<{ model: string; instruction: string }> = [];
  const adapter: LLMAdapter = { provider: slot.provider, complete: async (current, messages) => {
    seen.push({ model: current.model, instruction: messages[0]!.content });
    if (current.model === 'first') throw new LLMError('AI_LLM_UNAVAILABLE', 'rate limited (429)',
      { status: 429, retry_after_ms: 120000 }, true);
    return { text: '{"response":"done"}', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  } };
  const config: LLMConfig = { slot_1: { ...slot, model: 'first', thinking: 'on' },
    slot_2: { ...slot, model: 'second', thinking: 'off' } };
  await executeLLM(manifest, input, { config, adapters: () => adapter, quota: createQuotaTracker(), tabProbe: noTabs });
  expect(seen).toEqual([{ model: 'first', instruction: base }, { model: 'second', instruction: compact }]);
});

it('uses a free-pool source setting and diagnoses truncated output before parsing', async () => {
  const diagnostics: unknown[] = [];
  const instructions: string[] = [];
  const adapter: LLMAdapter = { provider: slot.provider, complete: async (_slot, messages) => {
    instructions.push(messages[0]!.content);
    return { text: '{"tool_calls":[{"args":"unfinished', finish_reason: 'length',
      usage: { input_tokens: 2, output_tokens: 4000, total_tokens: 4002 } };
  } };
  const config = { slot_1: null, free_pool: [{ id: 'fixture', type: 'api', ...slot,
    enabled: true, thinking: 'off' }] } as unknown as LLMConfig;
  await executeLLM(manifest, input, { config, adapters: () => adapter, quota: createQuotaTracker(), tabProbe: noTabs,
    onOutputDiagnostics: diagnostic => { diagnostics.push(diagnostic); } });
  expect(instructions).toEqual([compact]);
  expect(diagnostics).toMatchObject([{ thinking_requested: 'off', prompt_variant: 'thinking_off', output_tokens: 4000,
    finish_reason: 'length', json_valid: false, tail_field: 'tool_calls', tail_position: 'value', tail_in_string: true }]);
});

it('diagnostic observer failures do not repeat a paid call or lose its accounting', async () => {
  for (const observer of [() => { throw new Error('observer'); }, async () => { throw new Error('observer'); }]) {
    let calls = 0, tokens = 0;
    const diagnostics: unknown[] = [];
    const adapter: LLMAdapter = { provider: slot.provider, complete: async () => {
      calls++;
      return { text: '{"response":"done"}', finish_reason: 'stop', usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } };
    } };
    expect(await executeLLM(manifest, input, { config: { slot_1: { ...slot, thinking: 'off' } },
      adapters: () => adapter, quota: createQuotaTracker(), tabProbe: noTabs,
      onOutputDiagnostics: diagnostic => {
        diagnostics.push(diagnostic);
        return observer();
      }, onTokenUsage: usage => { tokens += usage.total_tokens; } })).toEqual({ response: 'done' });
    expect({ calls, tokens }).toEqual({ calls: 1, tokens: 5 });
    expect(diagnostics).toMatchObject([{ thinking_requested: 'off', prompt_variant: 'thinking_off', output_tokens: 3,
      json_valid: true, fields: { response: { serialized_chars: 6, closed: true } } }]);
  }
});
