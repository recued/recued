/** D-172 follow-on — per-element batch media. Each `llm.data[i]` carries its
 *  OWN media on a reserved `content_parts` field: one model call over the
 *  collection, results keyed back by `llm.id_field`, media interleaved + labeled
 *  by id, the bytes stripped from the JSON text / PII alias pass / carry-through
 *  output. Covers the union modality demand + warn, the fail-closed cases, the
 *  per-call media cap, and the single-mode + text-only-batch regressions. */
import { describe, it, expect, vi } from 'vitest';
import { executeLLM, resolveLLMModelId } from '../executor.js';
import { createQuotaTracker } from '../quota.js';
import type {
  ContentPart, LLMAdapter, LLMCompletionOptions, LLMConfig, LLMMessage, LLMSlot, WebChatTab,
} from '../types.js';
import type { IngredientManifest } from '@recued/contracts';

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

const ZERO_USAGE = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

/** A fake adapter that records the messages it was handed, returning canned
 *  responses in order. */
const recordingAdapter = (
  responses: string[],
): LLMAdapter & { lastMessages: () => LLMMessage[] } => {
  let i = 0;
  const complete = vi.fn(async (_slot: LLMSlot, _messages: LLMMessage[], _options: LLMCompletionOptions) => {
    if (i >= responses.length) throw new Error(`No more canned responses (requested ${i + 1})`);
    return { text: responses[i++]!, usage: ZERO_USAGE };
  });
  return {
    provider: 'openai',
    complete,
    lastMessages: () => complete.mock.calls[0]?.[1] as LLMMessage[],
  };
};

const noTabs = async (): Promise<Set<WebChatTab>> => new Set();
const makeDeps = (adapter: LLMAdapter, config: LLMConfig) => ({
  config,
  adapters: () => adapter,
  quota: createQuotaTracker(),
  tabProbe: noTabs,
});

const visionConfig: LLMConfig = {
  slot_1: { provider: 'openai', model: 'gpt-vision', api_key: 'sk', speed: 'fast', supports_json: true, modalities: { image: true } },
};
const audioVisionConfig: LLMConfig = {
  slot_1: { provider: 'openai', model: 'gpt-omni', api_key: 'sk', speed: 'fast', supports_json: true, modalities: { image: true, audio: true } },
};
const textOnlyConfig: LLMConfig = {
  slot_1: { provider: 'openai', model: 'gpt', api_key: 'sk', speed: 'fast', supports_json: true },
};

const img = (data = 'AAAA'): ContentPart => ({ type: 'image', source: { kind: 'base64', media_type: 'image/png', data } });
const aud = (data = 'BBBB'): ContentPart => ({ type: 'audio', source: { kind: 'base64', media_type: 'audio/wav', data } });

const userMessage = (msgs: LLMMessage[]): LLMMessage => msgs.find((m) => m.role === 'user')!;
const userText = (msgs: LLMMessage[]): string => msgs.map((m) => m.content).join('\n');
const textPartsText = (msg: LLMMessage): string =>
  (msg.content_parts ?? []).filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text).join('\n');
const imageParts = (msg: LLMMessage): ContentPart[] => (msg.content_parts ?? []).filter((p) => p.type === 'image');

const classifyEntries = (ids: string[]): string =>
  JSON.stringify(ids.map((id, k) => ({ record_id: id, category: k % 2 === 0 ? 'a' : 'b', confidence: 0.9, reasoning: `r${k}` })));

const batchInput = (data: Record<string, unknown>[], over: Record<string, unknown> = {}): Record<string, unknown> => ({
  'llm.data': data,
  'llm.id_field': 'record_id',
  'llm.categories': ['a', 'b'],
  ...over,
});

describe('D-172 per-element batch media — happy path', () => {
  it('runs N media-bearing elements in one call and keys results back by id_field', async () => {
    const data = [
      { record_id: 'r1', text: 'first', content_parts: [img('IMG1')] },
      { record_id: 'r2', text: 'second', content_parts: [img('IMG2')] },
    ];
    const adapter = recordingAdapter([classifyEntries(['r1', 'r2'])]);

    const result = await executeLLM(manifest, batchInput(data), makeDeps(adapter, visionConfig)) as Record<string, unknown>[];

    // one model call; per-element results merged + keyed by id
    expect(adapter.complete).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ record_id: 'r1', text: 'first', category: 'a', confidence: 0.9, reasoning: 'r0' });
    expect(result[1]).toMatchObject({ record_id: 'r2', text: 'second', category: 'b', confidence: 0.9, reasoning: 'r1' });

    // media is stripped from the output rows (no base64 echoed back)
    expect(result[0]!.content_parts).toBeUndefined();
    expect(result[1]!.content_parts).toBeUndefined();

    // media attached to the user turn as labeled blocks, in input order
    const user = userMessage(adapter.lastMessages());
    expect(imageParts(user)).toEqual([img('IMG1'), img('IMG2')]);
    const markers = textPartsText(user);
    expect(markers).toContain('record_id="r1"');
    expect(markers).toContain('record_id="r2"');

    // the JSON the model reads (string content) carries NO base64 — media is
    // out of the text path entirely
    const text = userText(adapter.lastMessages());
    expect(text).not.toContain('IMG1');
    expect(text).not.toContain('IMG2');
    expect(text).not.toContain('content_parts');
  });

  it('attaches media only for elements that declare it; text-only elements ride the JSON', async () => {
    const data = [
      { record_id: 'r1', text: 'has image', content_parts: [img('ONLY')] },
      { record_id: 'r2', text: 'no media' },
    ];
    const adapter = recordingAdapter([classifyEntries(['r1', 'r2'])]);

    const result = await executeLLM(manifest, batchInput(data), makeDeps(adapter, visionConfig)) as Record<string, unknown>[];

    expect(result).toHaveLength(2);
    const user = userMessage(adapter.lastMessages());
    expect(imageParts(user)).toEqual([img('ONLY')]);
    // only r1 has a media marker
    const markers = textPartsText(user);
    expect(markers).toContain('record_id="r1"');
    expect(markers).not.toContain('record_id="r2"');
  });
});

describe('D-172 per-element batch media — modality demand (union)', () => {
  it('routes a mixed image+audio batch to a model that covers BOTH modalities', async () => {
    const data = [
      { record_id: 'r1', text: 'a', content_parts: [img()] },
      { record_id: 'r2', text: 'b', content_parts: [aud()] },
    ];
    const adapter = recordingAdapter([classifyEntries(['r1', 'r2'])]);

    const result = await executeLLM(manifest, batchInput(data), makeDeps(adapter, audioVisionConfig));

    expect(result).toHaveLength(2);
    expect(adapter.complete).toHaveBeenCalledTimes(1);
  });

  it('an image-only model WARNS on a batch that ALSO needs audio (union, not any-of)', async () => {
    const data = [
      { record_id: 'r1', text: 'a', content_parts: [img()] },
      { record_id: 'r2', text: 'b', content_parts: [aud()] },
    ];
    const adapter = recordingAdapter([]);

    await expect(executeLLM(manifest, batchInput(data), makeDeps(adapter, visionConfig)))
      .rejects.toMatchObject({ code: 'AI_MODALITY_UNSUPPORTED' });
    expect(adapter.complete).not.toHaveBeenCalled();
  });

  it('warns when no configured model can see the media at all', async () => {
    const data = [{ record_id: 'r1', text: 'a', content_parts: [img()] }];
    const adapter = recordingAdapter([]);

    await expect(executeLLM(manifest, batchInput(data), makeDeps(adapter, textOnlyConfig)))
      .rejects.toMatchObject({ code: 'AI_MODALITY_UNSUPPORTED' });
    expect(adapter.complete).not.toHaveBeenCalled();
  });
});

describe('D-172 per-element batch media — fail closed (I-6)', () => {
  it('rejects when an element content_parts is not an array', async () => {
    const adapter = recordingAdapter([]);
    await expect(executeLLM(
      manifest,
      batchInput([{ record_id: 'r1', text: 'a', content_parts: 'oops' }]),
      makeDeps(adapter, visionConfig),
    )).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
    expect(adapter.complete).not.toHaveBeenCalled();
  });

  it('rejects when an element media part is missing its source fields', async () => {
    const adapter = recordingAdapter([]);
    await expect(executeLLM(
      manifest,
      batchInput([{ record_id: 'r1', text: 'a', content_parts: [{ type: 'image', source: { kind: 'base64' } }] }]),
      makeDeps(adapter, visionConfig),
    )).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
    expect(adapter.complete).not.toHaveBeenCalled();
  });

  it('still rejects TOP-LEVEL llm.content_parts in batch mode (per-element is the path)', async () => {
    const adapter = recordingAdapter([]);
    await expect(executeLLM(
      manifest,
      batchInput([{ record_id: 'r1', text: 'a' }], { 'llm.content_parts': [img()] }),
      makeDeps(adapter, visionConfig),
    )).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
    expect(adapter.complete).not.toHaveBeenCalled();
  });
});

describe('D-172 per-element batch media — no Recued media-count ceiling', () => {
  it('does NOT reject a large media batch — the provider window governs (spec §A.5/Q5)', async () => {
    // 30 media-bearing elements: no Recued constant cap rejects this. A model
    // that can't fit it surfaces the PROVIDER's own error, exactly like a single
    // oversized image in single mode.
    const ids = Array.from({ length: 30 }, (_, k) => `r${k}`);
    const data = ids.map((id, k) => ({ record_id: id, text: `t${k}`, content_parts: [img(`IMG${k}`)] }));
    const adapter = recordingAdapter([classifyEntries(ids)]);

    const result = await executeLLM(manifest, batchInput(data), makeDeps(adapter, visionConfig));
    expect(result).toHaveLength(30);
    expect(adapter.complete).toHaveBeenCalledTimes(1);
  });
});

describe('D-172 per-element batch media — media only (no text parts)', () => {
  it('rejects a text part in per-element media (would bypass PII aliasing)', async () => {
    // A text content part is provider-visible text; allowing it inside the
    // reserved media key would egress UNALIASED (stripped before the PII pass).
    // Per-record text belongs in the record's own fields, which alias normally.
    const adapter = recordingAdapter([]);
    await expect(executeLLM(
      manifest,
      batchInput([{ record_id: 'r1', text: 'a', content_parts: [{ type: 'text', text: 'sneaky' }, img()] }]),
      makeDeps(adapter, visionConfig),
    )).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
    expect(adapter.complete).not.toHaveBeenCalled();
  });
});

describe('D-172 per-element batch media — PII round-trip', () => {
  it('aliases element text, restores it, and still attaches the (un-aliased) media', async () => {
    const data = [
      { record_id: 'r1', sender: 'alice@acme.com', content_parts: [img('IMG1')] },
      { record_id: 'r2', sender: 'bob@acme.com', content_parts: [img('IMG2')] },
    ];
    const adapter = recordingAdapter([JSON.stringify([
      { record_id: 'r1', category: 'a', confidence: 0.9, reasoning: 'm1@d1.invalid noted' },
      { record_id: 'r2', category: 'b', confidence: 0.8, reasoning: 'ok' },
    ])]);

    const result = await executeLLM(
      manifest,
      batchInput(data, { 'llm.pii_fields': { sender: 'email' } }),
      makeDeps(adapter, visionConfig),
    ) as Record<string, unknown>[];

    // alias egressed in the text; the raw email never did
    const text = userText(adapter.lastMessages());
    expect(text).toContain('m1@d1.invalid');
    expect(text).not.toContain('alice@acme.com');

    // output restored to the raw email; media stripped from the row
    expect(result[0]).toMatchObject({ record_id: 'r1', sender: 'alice@acme.com', category: 'a', reasoning: 'alice@acme.com noted' });
    expect(result[0]!.content_parts).toBeUndefined();

    // media bytes were never PII-aliased — they ride through verbatim
    expect(imageParts(userMessage(adapter.lastMessages()))).toEqual([img('IMG1'), img('IMG2')]);
  });
});

describe('D-172 per-element batch media — dedup probe routes by modality', () => {
  // free pool: a text-only entry FIRST (round-robin cursor 0 picks it for a
  // text call) + a vision entry. Proves the probe applies the batch media
  // modality demand: a media batch must skip the text-only entry to the vision
  // one so the producer dedup key matches the model the real call would use.
  const probeConfig: LLMConfig = {
    free_pool: [
      { id: 'text-only', type: 'api', provider: 'openai-compatible', model: 'text-model', api_key: 'k', speed: 'fast', supports_json: true, enabled: true },
      { id: 'vision', type: 'api', provider: 'openai-compatible', model: 'vision-model', api_key: 'k', speed: 'fast', supports_json: true, enabled: true, modalities: { image: true } },
    ],
  };
  const probeDeps = () => ({ config: probeConfig, quota: createQuotaTracker(), tabProbe: noTabs });

  it('routes the probe to the vision model for a per-element media batch', async () => {
    const data = [{ record_id: 'r1', text: 'a', content_parts: [img()] }];
    const id = await resolveLLMModelId(manifest, batchInput(data), probeDeps());
    expect(id).toBe('openai-compatible:vision-model');
  });

  it('routes the probe to the text model for a text-only batch (unchanged)', async () => {
    const data = [{ record_id: 'r1', text: 'a' }, { record_id: 'r2', text: 'b' }];
    const id = await resolveLLMModelId(manifest, batchInput(data), probeDeps());
    expect(id).toBe('openai-compatible:text-model');
  });
});

describe('D-172 per-element batch media — regressions', () => {
  it('a batch with NO per-element media keeps a plain string user turn (text-only model serves it)', async () => {
    const data = [{ record_id: 'r1', text: 'a' }, { record_id: 'r2', text: 'b' }];
    const adapter = recordingAdapter([classifyEntries(['r1', 'r2'])]);

    const result = await executeLLM(manifest, batchInput(data), makeDeps(adapter, textOnlyConfig)) as Record<string, unknown>[];

    expect(result).toHaveLength(2);
    const user = userMessage(adapter.lastMessages());
    expect(user.content_parts).toBeUndefined();
    expect(typeof user.content).toBe('string');
    expect(adapter.complete).toHaveBeenCalledTimes(1);
  });

  it('single-mode content_parts (non-batch) is unchanged — attaches + routes to the vision slot', async () => {
    const adapter = recordingAdapter(['{"category":"a","confidence":0.9,"reasoning":"x"}']);

    const result = await executeLLM(
      manifest,
      { 'llm.data': '[image attached]', 'llm.categories': ['a', 'b'], 'llm.content_parts': [img('SINGLE')] },
      makeDeps(adapter, visionConfig),
    );

    expect(result).toEqual({ category: 'a', confidence: 0.9, reasoning: 'x' });
    expect(imageParts(userMessage(adapter.lastMessages()))).toEqual([img('SINGLE')]);
  });
});
