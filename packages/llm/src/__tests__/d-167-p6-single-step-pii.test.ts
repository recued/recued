/** D-167 P6.0 + P6.1 -- executeLLM single-step ai-* PII aliasing. */

import { describe, expect, it, vi } from 'vitest';

import type { IngredientManifest, WebChatTab } from '@recued/contracts';
import { executeLLM } from '../executor.js';
import { createQuotaTracker } from '../quota.js';
import type { LLMAdapter, LLMConfig, LLMMessage } from '../types.js';

const baseManifest: IngredientManifest = {
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
  slot_2: {
    provider: 'anthropic',
    model: 'claude-quality',
    api_key: 'sk-2',
    supports_thinking: true,
    supports_search: true,
  },
};

const ZERO_USAGE = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

const fakeAdapter = (responses: string[]): LLMAdapter => {
  let i = 0;
  return {
    provider: 'anthropic',
    complete: vi.fn(async () => {
      if (i >= responses.length) throw new Error(`No more canned responses (requested ${i + 1})`);
      return { text: responses[i++], usage: ZERO_USAGE };
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

const classifyInput = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  'llm.data': { sender: 'alice@acme.com' },
  'llm.categories': ['x'],
  ...overrides,
});

const firstMessages = (adapter: LLMAdapter): LLMMessage[] =>
  (adapter.complete as ReturnType<typeof vi.fn>).mock.calls[0]![1] as LLMMessage[];

const messagesText = (adapter: LLMAdapter): string =>
  firstMessages(adapter).map((message) => message.content).join('\n');

describe('D-167 P6.0 executeLLM single-step pii_fields', () => {
  it('aliases llm.data before the model call and restores aliases in contracted output', async () => {
    const adapter = fakeAdapter([
      '{"category":"x","confidence":0.9,"reasoning":"m1@d1.invalid is fine"}',
    ]);

    const result = await executeLLM(
      baseManifest,
      classifyInput({ 'llm.pii_fields': { sender: 'email' } }),
      makeDeps(adapter),
    );

    const prompt = messagesText(adapter);
    expect(prompt).toContain('m1@d1.invalid');
    expect(prompt).not.toContain('alice@acme.com');
    expect(result).toEqual({
      category: 'x',
      confidence: 0.9,
      reasoning: 'alice@acme.com is fine',
    });
  });

  it('leaves the prompt unchanged when llm.pii_fields is absent', async () => {
    const adapter = fakeAdapter([
      '{"category":"x","confidence":0.9,"reasoning":"raw"}',
    ]);

    await executeLLM(baseManifest, classifyInput(), makeDeps(adapter));

    const prompt = messagesText(adapter);
    expect(prompt).toContain('alice@acme.com');
    expect(prompt).not.toContain('m1@d1.invalid');
  });

  it('accepts an empty llm.pii_fields object as a valid no-op', async () => {
    const adapter = fakeAdapter([
      '{"category":"x","confidence":0.9,"reasoning":"raw"}',
    ]);

    const result = await executeLLM(
      baseManifest,
      classifyInput({ 'llm.pii_fields': {} }),
      makeDeps(adapter),
    );

    expect(messagesText(adapter)).toContain('alice@acme.com');
    expect(result).toEqual({ category: 'x', confidence: 0.9, reasoning: 'raw' });
  });

  it('treats a missing tagged path as best-effort and still calls the model', async () => {
    const adapter = fakeAdapter([
      '{"category":"x","confidence":0.9,"reasoning":"ok"}',
    ]);

    const result = await executeLLM(
      baseManifest,
      classifyInput({
        'llm.data': { other: 'v' },
        'llm.pii_fields': { sender: 'email' },
      }),
      makeDeps(adapter),
    );

    expect(adapter.complete).toHaveBeenCalledTimes(1);
    expect(messagesText(adapter)).toContain('"other": "v"');
    expect(messagesText(adapter)).not.toContain('m1@d1.invalid');
    expect(result).toEqual({ category: 'x', confidence: 0.9, reasoning: 'ok' });
  });

  it.each([
    [
      'ai-prompt',
      { ...baseManifest, slug: 'ai-prompt' },
      { 'llm.prompt': 'Classify alice@acme.com', 'llm.pii_fields': { sender: 'email' } },
    ],
    [
      'ai-compare',
      { ...baseManifest, slug: 'ai-compare' },
      {
        'llm.data_a': { sender: 'alice@acme.com' },
        'llm.data_b': { sender: 'bob@acme.com' },
        'llm.pii_fields': { sender: 'email' },
      },
    ],
  ])('fails closed for non-llm.data slug %s', async (_name, manifest, input) => {
    const adapter = fakeAdapter([]);

    await expect(executeLLM(
      manifest,
      input,
      makeDeps(adapter),
    )).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });

    expect(adapter.complete).toHaveBeenCalledTimes(0);
  });

  it('aliases each batch element before egress and restores each carried-through result (P6.1)', async () => {
    const adapter = fakeAdapter([
      JSON.stringify([
        { record_id: 'r1', category: 'x', confidence: 0.9, reasoning: 'm1@d1.invalid noted' },
        { record_id: 'r2', category: 'y', confidence: 0.8, reasoning: 'ok' },
      ]),
    ]);

    const result = await executeLLM(
      baseManifest,
      {
        'llm.data': [
          { record_id: 'r1', sender: 'alice@acme.com' },
          { record_id: 'r2', sender: 'bob@acme.com' },
        ],
        'llm.id_field': 'record_id',
        'llm.categories': ['x', 'y'],
        'llm.pii_fields': { sender: 'email' },
      },
      makeDeps(adapter),
    );

    // The list-wide identifier pass shares one ledger, so the two emails take
    // m1 / m2 against a single d1 domain row — and neither raw email egresses.
    const prompt = messagesText(adapter);
    expect(prompt).toContain('m1@d1.invalid');
    expect(prompt).toContain('m2@d1.invalid');
    expect(prompt).not.toContain('alice@acme.com');
    expect(prompt).not.toContain('bob@acme.com');

    // The untagged id_field stays real; each element's carried-through sender +
    // any alias the model echoed in its result is restored on the way out.
    expect(result).toEqual([
      { record_id: 'r1', sender: 'alice@acme.com', category: 'x', confidence: 0.9, reasoning: 'alice@acme.com noted' },
      { record_id: 'r2', sender: 'bob@acme.com', category: 'y', confidence: 0.8, reasoning: 'ok' },
    ]);
  });

  it('short-circuits an empty batch to [] when llm.pii_fields is a valid declaration', async () => {
    const adapter = fakeAdapter([]);

    const result = await executeLLM(
      baseManifest,
      {
        'llm.data': [],
        'llm.id_field': 'record_id',
        'llm.categories': ['x'],
        'llm.pii_fields': { sender: 'email' },
      },
      makeDeps(adapter),
    );

    expect(result).toEqual([]);
    expect(adapter.complete).toHaveBeenCalledTimes(0);
  });

  it('still short-circuits an empty batch to [] when llm.pii_fields is absent', async () => {
    const adapter = fakeAdapter([]);

    const result = await executeLLM(
      baseManifest,
      {
        'llm.data': [],
        'llm.id_field': 'record_id',
        'llm.categories': ['x'],
      },
      makeDeps(adapter),
    );

    expect(result).toEqual([]);
    expect(adapter.complete).toHaveBeenCalledTimes(0);
  });

  it('fails closed on a malformed llm.pii_fields declaration before model egress', async () => {
    const adapter = fakeAdapter([]);

    await expect(executeLLM(
      baseManifest,
      classifyInput({ 'llm.pii_fields': { sender: 'bogus-kind' } }),
      makeDeps(adapter),
    )).rejects.toThrow(/sender/);

    expect(adapter.complete).toHaveBeenCalledTimes(0);
  });
});

describe('D-167 P6.1 — single-step batch PII', () => {
  it('aliases a tagged-PII id_field and round-trips the carry-through in alias space', async () => {
    // id_field IS the tagged email. After aliasing, the id is m1/m2@d1.invalid;
    // because the aliased list is swapped into the executor input, the D-162
    // carry-through (mergeBatchResult, which matches on the id_field VALUE) runs
    // entirely in alias space, then finishPii restores the senders last.
    const adapter = fakeAdapter([
      JSON.stringify([
        { sender: 'm1@d1.invalid', category: 'x', confidence: 0.9, reasoning: 'first' },
        { sender: 'm2@d1.invalid', category: 'y', confidence: 0.8, reasoning: 'second' },
      ]),
    ]);

    const result = await executeLLM(
      baseManifest,
      {
        'llm.data': [{ sender: 'alice@acme.com' }, { sender: 'bob@acme.com' }],
        'llm.id_field': 'sender',
        'llm.categories': ['x', 'y'],
        'llm.pii_fields': { sender: 'email' },
      },
      makeDeps(adapter),
    );

    const prompt = messagesText(adapter);
    expect(prompt).toContain('m1@d1.invalid');
    expect(prompt).toContain('m2@d1.invalid');
    expect(prompt).not.toContain('alice@acme.com');
    expect(prompt).not.toContain('bob@acme.com');

    expect(result).toEqual([
      { sender: 'alice@acme.com', category: 'x', confidence: 0.9, reasoning: 'first' },
      { sender: 'bob@acme.com', category: 'y', confidence: 0.8, reasoning: 'second' },
    ]);
  });

  it('aliases a content field against the same element\'s structured email and restores it', async () => {
    // Within an element, the identifier pass (owner -> m1@d1) populates the ledger
    // before that element's content scan, which completes the same-domain mention
    // in notes (bob -> m2@d1). finishPii then restores the carried-through fields
    // AND the model's echo. (This test is same-element; cross-element completion —
    // a content mention anchored by a DIFFERENT batch element's identifier — also
    // works, since aliasFieldsBatch runs the identifier pass list-wide over one
    // shared ledger before any content scan. See the aliasFieldsBatch substrate
    // test "completes a cross-element email …" in d-167-p4-pii-transforms.test.ts.)
    const adapter = fakeAdapter([
      JSON.stringify([
        { rid: 'r1', category: 'x', confidence: 0.9, reasoning: 'see m2@d1.invalid' },
      ]),
    ]);

    const result = await executeLLM(
      baseManifest,
      {
        'llm.data': [{ rid: 'r1', owner: 'alice@acme.com', notes: 'CC bob@acme.com here' }],
        'llm.id_field': 'rid',
        'llm.categories': ['x'],
        'llm.pii_fields': { owner: 'email', notes: 'content' },
      },
      makeDeps(adapter),
    );

    const prompt = messagesText(adapter);
    expect(prompt).toContain('m1@d1.invalid');   // owner (structured)
    expect(prompt).toContain('m2@d1.invalid');   // bob (content, same-element completion)
    expect(prompt).not.toContain('alice@acme.com');
    expect(prompt).not.toContain('bob@acme.com');

    expect((result as Record<string, unknown>[])[0]).toMatchObject({
      rid: 'r1',
      owner: 'alice@acme.com',
      notes: 'CC bob@acme.com here',
      reasoning: 'see bob@acme.com',
    });
  });

  it('collapses identical real values across elements to one alias number', async () => {
    const adapter = fakeAdapter([
      JSON.stringify([
        { k: 'a', category: 'x', confidence: 0.9, reasoning: 'r' },
        { k: 'b', category: 'x', confidence: 0.9, reasoning: 'r' },
      ]),
    ]);

    const result = await executeLLM(
      baseManifest,
      {
        'llm.data': [
          { k: 'a', sender: 'alice@acme.com' },
          { k: 'b', sender: 'alice@acme.com' },
        ],
        'llm.id_field': 'k',
        'llm.categories': ['x'],
        'llm.pii_fields': { sender: 'email' },
      },
      makeDeps(adapter),
    );

    const prompt = messagesText(adapter);
    const occurrences = prompt.split('m1@d1.invalid').length - 1;
    expect(occurrences).toBe(2);                 // both elements share the one alias
    expect(prompt).not.toContain('m2@d1.invalid');
    expect(prompt).not.toContain('alice@acme.com');

    expect(result).toEqual([
      { k: 'a', sender: 'alice@acme.com', category: 'x', confidence: 0.9, reasoning: 'r' },
      { k: 'b', sender: 'alice@acme.com', category: 'x', confidence: 0.9, reasoning: 'r' },
    ]);
  });

  it('rejects fail-closed when a normalizing-kind id_field collapses two raw values to one alias', async () => {
    // A NORMALIZING kind (email lowercases) maps two distinct raw id_field values
    // to one canonical -> one alias -> the N.2 duplicate-id check rejects the batch
    // fail-closed. Stricter than un-aliased D-162 (which treats them as distinct),
    // but never a leak. (Codex review MED.)
    const adapter = fakeAdapter([]);

    await expect(executeLLM(
      baseManifest,
      {
        'llm.data': [{ email: 'Alice@Acme.com' }, { email: 'alice@acme.com' }],
        'llm.id_field': 'email',
        'llm.categories': ['x'],
        'llm.pii_fields': { email: 'email' },
      },
      makeDeps(adapter),
    )).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });

    expect(adapter.complete).toHaveBeenCalledTimes(0);
  });

  it.each([
    ['empty batch', [] as unknown[]],
    ['non-empty batch', [{ record_id: 'r1', sender: 'alice@acme.com' }]],
  ])('fails closed on a malformed declaration for a %s before egress', async (_name, data) => {
    // Proves normalizePiiFields is hoisted ABOVE the empty-batch short-circuit:
    // the empty case must throw, not return [].
    const adapter = fakeAdapter([]);

    await expect(executeLLM(
      baseManifest,
      {
        'llm.data': data,
        'llm.id_field': 'record_id',
        'llm.categories': ['x'],
        'llm.pii_fields': { sender: 'bogus-kind' },
      },
      makeDeps(adapter),
    )).rejects.toThrow(/sender/);

    expect(adapter.complete).toHaveBeenCalledTimes(0);
  });

  it('does not mutate the caller\'s llm.data array or its elements', async () => {
    const adapter = fakeAdapter([
      JSON.stringify([{ record_id: 'r1', category: 'x', confidence: 0.9, reasoning: 'm1@d1.invalid' }]),
    ]);
    const data = [{ record_id: 'r1', sender: 'alice@acme.com' }];
    const snapshot = structuredClone(data);

    await executeLLM(
      baseManifest,
      {
        'llm.data': data,
        'llm.id_field': 'record_id',
        'llm.categories': ['x'],
        'llm.pii_fields': { sender: 'email' },
      },
      makeDeps(adapter),
    );

    expect(data).toEqual(snapshot);   // aliasFieldsBatch deep-clones; input is reassigned
  });
});
