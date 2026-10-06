/** D-316 amendment (2026-10-05) — a recipe's `content`-tagged `llm.pii_fields`
 *  value is matched against the host's known values before the model call. */

import { describe, expect, it, vi } from 'vitest';

import type { IngredientManifest, WebChatTab } from '@recued/contracts';
import {
  PiiKnownValuesUnavailableError,
  buildKnownValueIndex,
  type PiiKnownValueSource,
} from '@recued/transforms';
import { executeLLM, prepareLLMInput } from '../executor.js';
import { createQuotaTracker } from '../quota.js';
import type { LLMAdapter, LLMConfig, LLMMessage } from '../types.js';

const manifest: IngredientManifest = {
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

const config: LLMConfig = {
  slot_1: { provider: 'openai', model: 'gpt-fast', api_key: 'sk-1' },
};

const fakeAdapter = (response: string): LLMAdapter => ({
  provider: 'openai',
  complete: vi.fn(async () => ({
    text: response,
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  })),
});

const noTabs = async (): Promise<Set<WebChatTab>> => new Set();

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gu;
const sourceOf = (degraded = false): PiiKnownValueSource => ({
  nameOrgIndex: {
    index: buildKnownValueIndex([
      { value: 'Dana Whitfield', kind: 'name' },
      { value: 'Northwind Traders', kind: 'org' },
    ]),
  },
  resolveIdentifiers: (text) => [...text.matchAll(EMAIL)].map((m) => ({ kind: 'email' as const, value: m[0] })),
  isDegraded: () => degraded,
});

const thread = {
  channel_id: 'C1',
  thread: [{ user_id: 'U01MIRA2Q', text: 'Dana Whitfield at Northwind Traders needs this; cc mira.patel@example.com' }],
};
const input = {
  'llm.data': thread,
  'llm.categories': ['needs_reply', 'fyi'],
  'llm.pii_fields': { thread: 'content' },
};

const promptOf = (adapter: LLMAdapter): string =>
  ((adapter.complete as ReturnType<typeof vi.fn>).mock.calls[0]![1] as LLMMessage[])
    .map((message) => message.content).join('\n');

describe('executeLLM — a content tag matched against the host\'s known values', () => {
  it('the model sees aliases for the known names, orgs and emails; the answer comes back real', async () => {
    const adapter = fakeAdapter('{"category":"needs_reply","confidence":0.9,"reasoning":"pii.Person1 is waiting"}');
    const result = await executeLLM(manifest, input, {
      config, adapters: () => adapter, quota: createQuotaTracker(), tabProbe: noTabs,
      piiKnownValues: () => sourceOf(),
    });
    const prompt = promptOf(adapter);
    for (const raw of ['Dana Whitfield', 'Northwind Traders', 'mira.patel@example.com']) {
      expect(prompt).not.toContain(raw);
    }
    expect(prompt).toContain('pii.Person1');
    expect(result).toMatchObject({ category: 'needs_reply', reasoning: 'Dana Whitfield is waiting' });
  });

  it('without a host source the tagged content reaches the model as before', async () => {
    const adapter = fakeAdapter('{"category":"fyi","confidence":0.5,"reasoning":"ok"}');
    await executeLLM(manifest, input, {
      config, adapters: () => adapter, quota: createQuotaTracker(), tabProbe: noTabs,
    });
    expect(promptOf(adapter)).toContain('Dana Whitfield at Northwind Traders');
  });

  it('⛔ a degraded source calls no model', async () => {
    const adapter = fakeAdapter('{"category":"fyi","confidence":0.5,"reasoning":"ok"}');
    await expect(executeLLM(manifest, input, {
      config, adapters: () => adapter, quota: createQuotaTracker(), tabProbe: noTabs,
      piiKnownValues: () => sourceOf(true),
    })).rejects.toBeInstanceOf(PiiKnownValuesUnavailableError);
    expect(adapter.complete).not.toHaveBeenCalled();
  });

  it('two builds of one request alias identically — the preapproval review compares them', () => {
    const one = prepareLLMInput(manifest, input, () => sourceOf());
    const two = prepareLLMInput(manifest, input, () => sourceOf());
    expect(one.input).toEqual(two.input);
    expect(JSON.stringify(one.input)).not.toContain('Dana Whitfield');
  });
});
