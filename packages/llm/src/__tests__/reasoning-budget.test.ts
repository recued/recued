import { afterEach, beforeEach, expect, it } from 'vitest';
import type { IngredientManifest } from '@recued/contracts';
import { executeLLM } from '../executor.js';
import { createOpenAIAdapter } from '../adapters/openai.js';
import { createQuotaTracker } from '../quota.js';
import { resetEndpointCapabilities } from '../endpoint-capabilities.js';
import type { LLMConfig, LLMSlot } from '../types.js';

const nativeFetch = globalThis.fetch, endpoint = 'https://coding-intl.dashscope.aliyuncs.com/v1';
const manifest: IngredientManifest = { slug: 'reasoning-budget-probe', name: 'Budget probe', description: '', author: 'recued', kind: 'ai', category: 'ai', risk_tier: 'read', input: {}, output: {} };
const slot = (): LLMSlot => ({ provider: 'openai-compatible', model: 'qwen3.7-plus', base_url: endpoint, api_key: 'fixture', thinking: 'on', supports_json: true, max_output_tokens: 16384, speed: 'fast' });
const success = () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
let bodies: any[];
beforeEach(() => {
  resetEndpointCapabilities(); bodies = [];
  globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return success(); };
});
afterEach(() => { globalThis.fetch = nativeFetch; });
const run = (selected: LLMSlot, budget?: unknown) => executeLLM(manifest, { 'llm.system_prompt': 'Return only JSON.', 'llm.prompt': 'Classify.', 'llm.output_format': 'json',
  ...(budget === undefined ? {} : { 'llm.reasoning_token_budget': budget }) }, { config: { slot_1: selected } as LLMConfig,
  adapters: () => createOpenAIAdapter(selected.provider as 'openai' | 'openai-compatible'), quota: createQuotaTracker(), tabProbe: async () => new Set() });

it('sends each native request budget without changing thinking, answer limits or later calls', async () => {
  const selected = slot(), before = JSON.stringify(selected);
  await run(selected, 1024); await run(selected, 768); await run(selected);
  expect(bodies.map(body => body.thinking_budget)).toEqual([1024, 768, undefined]);
  expect(bodies.every(body => body.enable_thinking === true && body.max_tokens === 4000 && body.response_format.type === 'json_object')).toBe(true);
  expect(JSON.stringify(selected)).toBe(before);
});

it.each(['off', undefined] as const)('never enables thinking to apply a budget when the owner setting is %s', async thinking => {
  const selected = slot(); selected.thinking = thinking;
  await run(selected, 1024); expect(bodies[0].thinking_budget).toBeUndefined(); expect(bodies[0].enable_thinking).toBe(thinking === 'off' ? false : undefined);
});

it('leaves unsupported endpoints and models on their existing wire protocol', async () => {
  for (const selected of [{ ...slot(), base_url: 'https://coding-intl.dashscope.aliyuncs.com.other.example/v1' },
    { ...slot(), model: 'another-qwen-model' }, { ...slot(), provider: 'openai' as const, base_url: 'https://api.openai.com/v1' }]) await run(selected, 1024);
  expect(bodies.every(body => !Object.hasOwn(body, 'thinking_budget'))).toBe(true);
});

it.each([0, 1.5, '1024'])('refuses invalid budget %s before a provider request', async budget => {
  await expect(run(slot(), budget)).rejects.toThrow('positive safe integer'); expect(bodies).toEqual([]);
});

it('does not retry a rejected budget by removing thinking or poison the thinking capability cache', async () => {
  let reject = true;
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return reject ? new Response(JSON.stringify({ error: { message: 'unsupported parameter thinking_budget' } }), { status: 400 }) : success();
  };
  await expect(run(slot(), 1024)).rejects.toThrow(); expect(bodies).toHaveLength(1);
  reject = false; await run(slot()); expect(bodies).toHaveLength(2); expect(bodies[1].enable_thinking).toBe(true);
});
