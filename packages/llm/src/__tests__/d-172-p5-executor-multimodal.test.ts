/** D-172 P5 — executeLLM consuming llm.content_parts: attach to the user
 *  turn, derive the modality demand, route to a capable model, warn when none. */
import { describe, it, expect, vi } from 'vitest';
import { executeLLM } from '../executor.js';
import { createQuotaTracker } from '../quota.js';
import type { LLMAdapter, LLMCompletionOptions, LLMConfig, LLMMessage, LLMSlot, WebChatTab } from '../types.js';
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
const okJson = '{"category":"a","confidence":0.9,"reasoning":"x"}';

/** A fake adapter that records the messages it was handed. */
const recordingAdapter = (): LLMAdapter & { lastMessages: () => LLMMessage[] } => {
  const complete = vi.fn(async (_slot: LLMSlot, _messages: LLMMessage[], _options: LLMCompletionOptions) => ({
    text: okJson,
    usage: ZERO_USAGE,
  }));
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

const imagePart = { type: 'image', source: { kind: 'base64', media_type: 'image/png', data: 'AAAA' } };

const visionConfig: LLMConfig = {
  slot_1: { provider: 'openai', model: 'gpt-vision', api_key: 'sk', speed: 'fast', supports_json: true, modalities: { image: true } },
};
const textOnlyConfig: LLMConfig = {
  slot_1: { provider: 'openai', model: 'gpt', api_key: 'sk', speed: 'fast', supports_json: true },
};

describe('executeLLM — multimodal (llm.content_parts)', () => {
  it('attaches media to the user turn (lead text + image part) and routes to the vision slot', async () => {
    const adapter = recordingAdapter();
    const result = await executeLLM(
      manifest,
      { 'llm.data': '[image attached]', 'llm.categories': ['a', 'b'], 'llm.content_parts': [imagePart] },
      makeDeps(adapter, visionConfig),
    );
    expect(result).toEqual({ category: 'a', confidence: 0.9, reasoning: 'x' });
    const msgs = adapter.lastMessages();
    const user = msgs.find((m) => m.role === 'user')!;
    expect(user.content_parts).toBeDefined();
    expect(user.content_parts![0]).toMatchObject({ type: 'text' }); // contracted instruction
    expect(user.content_parts![user.content_parts!.length - 1]).toEqual(imagePart);
    // additive: the string content is preserved
    expect(typeof user.content).toBe('string');
  });

  it('surfaces AI_MODALITY_UNSUPPORTED (warn) when no source is modality-capable; adapter not called', async () => {
    const adapter = recordingAdapter();
    await expect(
      executeLLM(
        manifest,
        { 'llm.data': '[image]', 'llm.categories': ['a'], 'llm.content_parts': [imagePart] },
        makeDeps(adapter, textOnlyConfig),
      ),
    ).rejects.toMatchObject({
      code: 'AI_MODALITY_UNSUPPORTED',
      // ⛔ It names the way out, because the product has one: Test connection
      // proves a model can see pictures. "Choose a model that supports it" sent
      // the owner — and a chat model relaying it — after a setting no screen had.
      message: 'None of your AI models has shown it can see pictures. '
        + 'In Settings → AI / Models, press Test connection on a model that can: '
        + 'Recued shows it a test picture and remembers that it can see.',
    });
    expect(adapter.complete).not.toHaveBeenCalled();
  });

  it('rejects TOP-LEVEL content_parts in batch mode (per-element media is the path)', async () => {
    const adapter = recordingAdapter();
    await expect(
      executeLLM(
        manifest,
        {
          'llm.data': [{ id: '1', text: 'x' }],
          'llm.id_field': 'id',
          'llm.categories': ['a'],
          'llm.content_parts': [imagePart],
        },
        makeDeps(adapter, visionConfig),
      ),
    ).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
    expect(adapter.complete).not.toHaveBeenCalled();
  });

  it('fails closed on a malformed content_parts declaration (never silently drops media)', async () => {
    const adapter = recordingAdapter();
    await expect(
      executeLLM(
        manifest,
        { 'llm.data': 'x', 'llm.categories': ['a'], 'llm.content_parts': [{ type: 'image', source: { kind: 'base64' } }] },
        makeDeps(adapter, visionConfig),
      ),
    ).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID' });
    expect(adapter.complete).not.toHaveBeenCalled();
  });

  it('text-only call (no content_parts) is unaffected — no modality filtering', async () => {
    const adapter = recordingAdapter();
    const result = await executeLLM(
      manifest,
      { 'llm.data': 'hello', 'llm.categories': ['a'] },
      makeDeps(adapter, textOnlyConfig),
    );
    expect(result).toEqual({ category: 'a', confidence: 0.9, reasoning: 'x' });
    const user = adapter.lastMessages().find((m) => m.role === 'user')!;
    expect(user.content_parts).toBeUndefined();
  });

  it('content_parts that are ALL text impose no modality demand (text-only model serves it)', async () => {
    // Regression for the P3 fold: a text-only content_parts list must NOT
    // raise AI_MODALITY_UNSUPPORTED — it behaves like the plain text path.
    const adapter = recordingAdapter();
    const result = await executeLLM(
      manifest,
      { 'llm.data': 'hello', 'llm.categories': ['a'], 'llm.content_parts': [{ type: 'text', text: 'extra note' }] },
      makeDeps(adapter, textOnlyConfig),
    );
    expect(result).toEqual({ category: 'a', confidence: 0.9, reasoning: 'x' });
    expect(adapter.complete).toHaveBeenCalledTimes(1);
  });
});

// D-164 — attachContentParts must MERGE media onto an existing content_parts
// (the prompt-cache split) rather than rebuild from `content`, or a future
// multimodal chat turn would silently lose the cache breakpoint.
describe('executeLLM — attachContentParts preserves the D-164 cache split', () => {
  // An UNcontracted slug routes through buildUncontractedPrompt, which honours
  // `llm.cache_prefix` and produces the prefix/suffix content_parts split.
  const uncontracted: IngredientManifest = {
    slug: 'ai-prompt',
    name: 'Prompt',
    description: 'escape hatch',
    author: 'recued',
    kind: 'ai',
    category: 'ai',
    risk_tier: 'read',
    input: {},
    output: {},
  };
  const PREFIX = '{"available_tools":[],"commitment_context":[]';
  const BODY = `${PREFIX},"chat_tail":[],"user_message":"q"}`;

  it('appends media AFTER the split blocks; the cache_breakpoint block survives', async () => {
    const adapter = recordingAdapter();
    await executeLLM(
      uncontracted,
      { 'llm.prompt': BODY, 'llm.cache_prefix': PREFIX, 'llm.content_parts': [imagePart] },
      makeDeps(adapter, visionConfig),
    );
    const user = adapter.lastMessages().find((m) => m.role === 'user')!;
    expect(user.content_parts).toHaveLength(3);
    expect(user.content_parts![0]).toMatchObject({ type: 'text', text: PREFIX, cache_breakpoint: true });
    expect(user.content_parts![1]).toMatchObject({ type: 'text', text: BODY.slice(PREFIX.length) });
    expect(user.content_parts![2]).toEqual(imagePart);
  });
});
