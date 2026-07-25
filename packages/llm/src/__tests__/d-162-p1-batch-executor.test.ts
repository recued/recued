/** D-162 P1 -- executor batch merge and error mapping. */

import { describe, expect, it, vi } from 'vitest';

import type { IngredientManifest, WebChatTab } from '@recued/contracts';
import { executeLLM } from '../executor.js';
import { createQuotaTracker } from '../quota.js';
import type { LLMAdapter, LLMConfig, TokenUsage } from '../types.js';

const classifyManifest: IngredientManifest = {
  slug: 'ai-classify',
  name: 'Classify',
  description: 'Classifier',
  author: 'recued',
  kind: 'ai',
  category: 'ai',
  risk_tier: 'read',
  input: {},
  output: {},
};

const compareManifest: IngredientManifest = {
  ...classifyManifest,
  slug: 'ai-compare',
  name: 'Compare',
};

const config: LLMConfig = {
  slot_1: { provider: 'openai', model: 'gpt-fast', api_key: 'sk-1' },
  slot_2: {
    provider: 'anthropic',
    model: 'claude-quality',
    api_key: 'sk-2',
    supports_thinking: true,
    supports_search: true,
  },
};

const DEFAULT_USAGE: TokenUsage = {
  input_tokens: 11,
  output_tokens: 7,
  total_tokens: 18,
};

type FakeResponse = string | { text: string; usage?: TokenUsage };

const fakeAdapter = (responses: FakeResponse[]): LLMAdapter => {
  let i = 0;
  return {
    provider: 'anthropic',
    complete: vi.fn(async () => {
      if (i >= responses.length) throw new Error(`No more canned responses (requested ${i + 1})`);
      const response = responses[i++];
      if (typeof response === 'string') {
        return { text: response, usage: DEFAULT_USAGE };
      }
      return { text: response.text, usage: response.usage ?? DEFAULT_USAGE };
    }),
  };
};

const noTabs = async (): Promise<Set<WebChatTab>> => new Set();

const makeDeps = (adapter: LLMAdapter) => ({
  config,
  adapters: () => adapter,
  quota: createQuotaTracker(),
  tabProbe: noTabs,
});

const batchInput = (
  data: Record<string, unknown>[],
): Record<string, unknown> => ({
  'llm.data': data,
  'llm.id_field': 'record_id',
  'llm.categories': ['support', 'sales'],
});

const validClassifyEntries = (
  data: Record<string, unknown>[],
): Record<string, unknown>[] => data.map((record, index) => ({
  record_id: record.record_id,
  category: index % 2 === 0 ? 'support' : 'sales',
  confidence: 0.8,
  reasoning: `reason ${index}`,
}));

describe('D-162 P1 executeLLM batch call count and usage', () => {
  it('I-3 sends one adapter completion and reports one TokenUsage for a non-empty batch', async () => {
    const data = Array.from({ length: 50 }, (_, index) => ({
      record_id: `r${index}`,
      text: `Record ${index}`,
    }));
    const adapter = fakeAdapter([JSON.stringify(validClassifyEntries(data))]);
    const usageEvents: TokenUsage[] = [];

    const result = await executeLLM(
      classifyManifest,
      batchInput(data),
      { ...makeDeps(adapter), onTokenUsage: (usage) => { usageEvents.push(usage); } },
    );

    expect(result).toHaveLength(50);
    expect(adapter.complete).toHaveBeenCalledTimes(1);
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({
      input_tokens: 11,
      output_tokens: 7,
      total_tokens: 18,
    });
  });

  it('I-3 short-circuits an empty batch to [] with zero completions and zero TokenUsage', async () => {
    const adapter = fakeAdapter([]);
    const usageEvents: TokenUsage[] = [];

    const result = await executeLLM(
      classifyManifest,
      batchInput([]),
      { ...makeDeps(adapter), onTokenUsage: (usage) => { usageEvents.push(usage); } },
    );

    expect(result).toEqual([]);
    expect(adapter.complete).toHaveBeenCalledTimes(0);
    expect(usageEvents).toEqual([]);
  });
});

describe('D-162 P1 executeLLM batch carry-through merge', () => {
  it('I-2 carries through non-judgment input fields by reference and merges result fields', async () => {
    const headers = { from: 'alice@example.com' };
    const tags = ['urgent', 'customer'];
    const data = [
      {
        record_id: 'm1',
        subject: 'Need help',
        headers,
        tags,
      },
    ];
    const adapter = fakeAdapter([JSON.stringify([
      {
        record_id: 'm1',
        category: 'support',
        confidence: 0.95,
        reasoning: 'Asks for help.',
      },
    ])]);

    const result = await executeLLM(
      classifyManifest,
      batchInput(data),
      makeDeps(adapter),
    ) as Record<string, unknown>[];

    expect(result).toHaveLength(1);
    expect(result[0]!.subject).toBe(data[0]!.subject);
    expect(result[0]!.headers).toBe(headers);
    expect(result[0]!.tags).toBe(tags);
    expect(result[0]).toMatchObject({
      record_id: 'm1',
      category: 'support',
      confidence: 0.95,
      reasoning: 'Asks for help.',
    });
  });

  it('I-7 emits output rows in llm.data input order when model entries are shuffled', async () => {
    const data = [
      { record_id: 'a', text: 'Alpha' },
      { record_id: 'b', text: 'Beta' },
      { record_id: 'c', text: 'Gamma' },
    ];
    const adapter = fakeAdapter([JSON.stringify([
      { record_id: 'c', category: 'support', confidence: 0.7, reasoning: 'third' },
      { record_id: 'a', category: 'sales', confidence: 0.8, reasoning: 'first' },
      { record_id: 'b', category: 'support', confidence: 0.9, reasoning: 'second' },
    ])]);

    const result = await executeLLM(
      classifyManifest,
      batchInput(data),
      makeDeps(adapter),
    ) as Record<string, unknown>[];

    expect(result.map((entry) => entry.record_id)).toEqual(['a', 'b', 'c']);
    expect(result.map((entry) => entry.reasoning)).toEqual(['first', 'second', 'third']);
  });

  it('N.4 lets result fields win when a non-id input field collides with a result field', async () => {
    const data = [
      {
        record_id: 'r1',
        text: 'Please call me about pricing.',
        category: 'input-category',
        confidence: 0.01,
        reasoning: 'input reasoning',
      },
    ];
    const adapter = fakeAdapter([JSON.stringify([
      {
        record_id: 'r1',
        category: 'sales',
        confidence: 0.88,
        reasoning: 'Mentions pricing.',
      },
    ])]);

    const result = await executeLLM(
      classifyManifest,
      batchInput(data),
      makeDeps(adapter),
    ) as Record<string, unknown>[];

    expect(result[0]).toMatchObject({
      record_id: 'r1',
      text: 'Please call me about pricing.',
      category: 'sales',
      confidence: 0.88,
      reasoning: 'Mentions pricing.',
    });
  });
});

describe('D-162 P1 executeLLM N.6 batch output invalid cases', () => {
  const data = [
    { record_id: 'r1', text: 'First' },
    { record_id: 'r2', text: 'Second' },
  ];

  it.each([
    [
      'model response is not an array',
      JSON.stringify({ results: validClassifyEntries(data) }),
    ],
    [
      'model entry missing for an input id',
      JSON.stringify([
        { record_id: 'r1', category: 'support', confidence: 0.8, reasoning: 'Only one.' },
      ]),
    ],
    [
      'model entry has an extra unknown id',
      JSON.stringify([
        { record_id: 'r1', category: 'support', confidence: 0.8, reasoning: 'First.' },
        { record_id: 'r2', category: 'sales', confidence: 0.7, reasoning: 'Second.' },
        { record_id: 'r3', category: 'support', confidence: 0.9, reasoning: 'Extra.' },
      ]),
    ],
    [
      'model response contains a duplicate id',
      JSON.stringify([
        { record_id: 'r1', category: 'support', confidence: 0.8, reasoning: 'First.' },
        { record_id: 'r1', category: 'sales', confidence: 0.7, reasoning: 'Duplicate.' },
      ]),
    ],
    [
      'model entry has a bad result field',
      JSON.stringify([
        { record_id: 'r1', category: 'support', confidence: 'high', reasoning: 'Bad.' },
        { record_id: 'r2', category: 'sales', confidence: 0.7, reasoning: 'Second.' },
      ]),
    ],
  ])('maps %s to AI_OUTPUT_INVALID', async (_name, raw) => {
    const adapter = fakeAdapter([raw]);

    await expect(executeLLM(
      classifyManifest,
      batchInput(data),
      makeDeps(adapter),
    )).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });

    expect(adapter.complete).toHaveBeenCalledTimes(1);
  });
});

describe('D-162 P1 executeLLM ai-compare exclusion', () => {
  it('I-6 rejects ai-compare with llm.id_field and empty llm.data instead of short-circuiting to []', async () => {
    const adapter = fakeAdapter([]);

    await expect(executeLLM(
      compareManifest,
      {
        'llm.data': [],
        'llm.id_field': 'record_id',
        'llm.data_a': { left: true },
        'llm.data_b': { right: true },
      },
      makeDeps(adapter),
    )).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });

    expect(adapter.complete).toHaveBeenCalledTimes(0);
  });
});
