import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { IngredientManifest } from '@recued/contracts';
import { createOpenAIAdapter } from '../adapters/openai.js';
import { classifyProviderError } from '../adapters/anthropic.js';
import { buildLLMCompletionRequest, completeWithFallbacks, prepareLLMInput } from '../executor.js';
import { forgetEndpoint, jsonModeUnsupported, jsonSchemaUnsupported, resetEndpointCapabilities } from '../endpoint-capabilities.js';
import type { LLMAdapter, LLMCompletionOptions, LLMMessage, LLMSlot, Match } from '../types.js';
import { LLMError } from '../types.js';

const slot: LLMSlot = { provider: 'openai-compatible', model: 'fixture', api_key: 'test', base_url: 'https://provider.test', supports_json: true };
const schema = { type: 'object', properties: { result: { type: 'string', enum: ['yes', 'no', 'uncertain'] } }, required: ['result'], additionalProperties: false };
const options: LLMCompletionOptions = { model: slot.model, max_tokens: 400, timeout_ms: 120000, json: true, json_schema: schema };
const messages: LLMMessage[] = [{ role: 'system', content: 'Return the requested JSON.' }, { role: 'user', content: 'Assess this.' }];
const ok = { text: '{"result":"uncertain"}', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
const manifest: IngredientManifest = { slug: 'ai-prompt', name: 'Prompt', description: 'Prompt', author: 'recued', kind: 'ai', category: 'ai', risk_tier: 'read', input: {}, output: {} };
const match: Match = { source: { kind: 'slot', slot_key: 'slot_1' }, slot, adapterKey: slot.provider, resolved_hint: 'fast', used_downgrade: false, used_upgrade: false };
beforeEach(() => resetEndpointCapabilities());
afterEach(() => vi.unstubAllGlobals());

it('emits an opt-in strict schema on the actual compatible-provider wire without changing JSON-object or array calls', async () => {
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content: ok.text }, finish_reason: 'stop' }] })));
  vi.stubGlobal('fetch', fetch);
  const adapter = createOpenAIAdapter('openai-compatible');
  await adapter.complete(slot, messages, options);
  await adapter.complete(slot, messages, { ...options, json_schema: undefined });
  await adapter.complete(slot, messages, { ...options, json_shape: 'array' });
  const sent = fetch.mock.calls.map(call => JSON.parse((call[1] as RequestInit).body as string));
  expect(sent[0].response_format).toEqual({ type: 'json_schema', json_schema: { name: 'recued_response', strict: true, schema } });
  expect(sent[1].response_format).toEqual({ type: 'json_object' });
  expect(sent[2].response_format).toBeUndefined();
  expect(sent[0].messages).toEqual(messages);
});

it('carries a bounded schema through request preparation and supplies the JSON fallback instruction', () => {
  const input = { 'llm.prompt': 'Assess this.', 'llm.output_format': 'json', 'llm.output_schema': schema };
  const request = buildLLMCompletionRequest(manifest, prepareLLMInput(manifest, input), match, 110000);
  expect(request.options).toMatchObject({ json: true, json_schema: schema, timeout_ms: 110000 });
  expect(request.messages.some(message => /JSON/u.test(message.content))).toBe(true);
  const plain = buildLLMCompletionRequest(manifest, prepareLLMInput(manifest, { 'llm.prompt': 'Hello' }), match);
  expect(plain.options.json_schema).toBeUndefined();
});

it.each([null, [], { type: 'array' }, { type: 'object', description: 'x'.repeat(100001) }])('rejects an invalid schema before a provider call: %j', invalid => {
  const input = { 'llm.prompt': 'Assess.', 'llm.output_format': 'json', 'llm.output_schema': invalid };
  expect(() => buildLLMCompletionRequest(manifest, prepareLLMInput(manifest, input), match)).toThrow('llm.output_schema');
});

it('does not override contracted output or a text-only request', () => {
  const input = { 'llm.data': 'a', 'llm.output_format': 'json', 'llm.output_schema': schema };
  const contracted = { ...manifest, slug: 'ai-classify' };
  expect(() => buildLLMCompletionRequest(contracted, prepareLLMInput(contracted, input), match)).toThrow('uncontracted');
  expect(() => buildLLMCompletionRequest(manifest, prepareLLMInput(manifest, { 'llm.prompt': 'Hi', 'llm.output_schema': schema }), match)).toThrow('JSON');
});

it('falls back once for a refused schema without poisoning JSON-object support or different schemas, and can forget that refusal', async () => {
  const seen: LLMCompletionOptions[] = [];
  const adapter: LLMAdapter = { provider: 'openai-compatible', complete: async (_slot, _messages, current) => {
    seen.push(current);
    if (current.json_schema === schema) throw classifyProviderError(400, 'response_format json_schema is unsupported', null);
    return ok;
  } };
  await completeWithFallbacks(adapter, slot, messages, options);
  expect(seen.map(row => [row.json, Boolean(row.json_schema)])).toEqual([[true, true], [true, false]]);
  expect(jsonModeUnsupported(slot)).toBe(false);
  expect(jsonSchemaUnsupported(slot, schema)).toBe(true);
  await completeWithFallbacks(adapter, slot, messages, options);
  expect(seen).toHaveLength(3);
  const different = { ...schema, properties: { result: { type: 'string' } } };
  await completeWithFallbacks(adapter, slot, messages, { ...options, json_schema: different });
  expect(seen.at(-1)!.json_schema).toBe(different);
  forgetEndpoint(slot);
  expect(jsonSchemaUnsupported(slot, schema)).toBe(false);
});

it('composes schema and role refusals without reintroducing a refused role or repeating native schema', async () => {
  const seen: Array<{ system: boolean; schema: boolean }> = [];
  const adapter: LLMAdapter = { provider: 'openai-compatible', complete: async (_slot, packet, current) => {
    const attempt = { system: packet.some(message => message.role === 'system'), schema: !!current.json_schema };
    seen.push(attempt);
    if (attempt.schema) throw classifyProviderError(400, 'response_format json_schema is unsupported', null);
    if (attempt.system) throw classifyProviderError(400, 'System role is not supported', null);
    return ok;
  } };
  expect(await completeWithFallbacks(adapter, slot, messages, options)).toBe(ok);
  expect(seen).toEqual([{ system: true, schema: true }, { system: true, schema: false }, { system: false, schema: false }]);
  expect(jsonModeUnsupported(slot)).toBe(false);
});

it('never retries a timeout, generated response parse failure or non-protocol rejection', async () => {
  for (const error of [new LLMError('AI_TIMEOUT', 'Provider timed out'), new LLMError('AI_RESPONSE_PARSE_FAILED', 'Response was truncated'), classifyProviderError(400, 'Invalid model name', null)]) {
    const complete = vi.fn(async () => { throw error; });
    const adapter: LLMAdapter = { provider: 'openai-compatible', complete };
    await expect(completeWithFallbacks(adapter, slot, messages, options)).rejects.toBe(error);
    expect(complete).toHaveBeenCalledTimes(1);
  }
});
