/** D-172 P5 / A.10 — ContentPart renderers + multimodal adapter rendering. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  hasCacheBreakpoint,
  hasNonTextPart,
  joinTextParts,
  toAnthropicContent,
  toGoogleParts,
  toOpenAIContent,
} from '../adapters/content-parts.js';
import { createAnthropicAdapter } from '../adapters/anthropic.js';
import { createOpenAIAdapter } from '../adapters/openai.js';
import { createGoogleAdapter } from '../adapters/google.js';
import {
  LLMError,
  requiredModalities,
  supportsModalities,
  hasModalityDemand,
} from '../types.js';
import type { ContentPart, LLMMessage, LLMSlot } from '../types.js';

const IMG: ContentPart = { type: 'image', source: { kind: 'base64', media_type: 'image/png', data: 'AAAA' } };
const AUDIO: ContentPart = { type: 'audio', source: { kind: 'base64', media_type: 'audio/wav', data: 'BBBB' } };
const DOC: ContentPart = { type: 'document', source: { kind: 'base64', media_type: 'application/pdf', data: 'CCCC' } };
const TXT: ContentPart = { type: 'text', text: 'describe this' };

// ─── Pure renderers ──────────────────────────────────────────────────────────

describe('toAnthropicContent', () => {
  it('renders text + image(base64) + document blocks', () => {
    const out = toAnthropicContent([TXT, IMG, DOC]) as Array<Record<string, any>>;
    expect(out[0]).toEqual({ type: 'text', text: 'describe this' });
    expect(out[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
    expect(out[2]).toEqual({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'CCCC' } });
  });

  it('renders an image url source as a url block', () => {
    const out = toAnthropicContent([
      { type: 'image', source: { kind: 'url', media_type: 'image/jpeg', data: 'https://x/y.jpg' } },
    ]) as Array<Record<string, any>>;
    expect(out[0]).toEqual({ type: 'image', source: { type: 'url', url: 'https://x/y.jpg' } });
  });

  it('throws AI_MODALITY_UNSUPPORTED on audio (Anthropic has no audio block)', () => {
    expect(() => toAnthropicContent([AUDIO])).toThrowError(LLMError);
    try {
      toAnthropicContent([AUDIO]);
    } catch (e) {
      expect((e as LLMError).code).toBe('AI_MODALITY_UNSUPPORTED');
    }
  });
});

describe('toGoogleParts', () => {
  it('renders text as {text} and media as inlineData(base64)', () => {
    const out = toGoogleParts([TXT, IMG, AUDIO, DOC]) as Array<Record<string, any>>;
    expect(out[0]).toEqual({ text: 'describe this' });
    expect(out[1]).toEqual({ inlineData: { mimeType: 'image/png', data: 'AAAA' } });
    expect(out[2]).toEqual({ inlineData: { mimeType: 'audio/wav', data: 'BBBB' } });
    expect(out[3]).toEqual({ inlineData: { mimeType: 'application/pdf', data: 'CCCC' } });
  });

  it('renders a url source as fileData', () => {
    const out = toGoogleParts([
      { type: 'image', source: { kind: 'url', media_type: 'image/jpeg', data: 'gs://b/x.jpg' } },
    ]) as Array<Record<string, any>>;
    expect(out[0]).toEqual({ fileData: { mimeType: 'image/jpeg', fileUri: 'gs://b/x.jpg' } });
  });
});

describe('toOpenAIContent', () => {
  it('renders image as a base64 data-uri image_url', () => {
    const out = toOpenAIContent([IMG]) as Array<Record<string, any>>;
    expect(out[0]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } });
  });

  it('passes an image url through unchanged', () => {
    const out = toOpenAIContent([
      { type: 'image', source: { kind: 'url', media_type: 'image/jpeg', data: 'https://x/y.jpg' } },
    ]) as Array<Record<string, any>>;
    expect(out[0]).toEqual({ type: 'image_url', image_url: { url: 'https://x/y.jpg' } });
  });

  it('renders audio as input_audio with a bare format string', () => {
    const wav = toOpenAIContent([AUDIO]) as Array<Record<string, any>>;
    expect(wav[0]).toEqual({ type: 'input_audio', input_audio: { data: 'BBBB', format: 'wav' } });
    const mp3 = toOpenAIContent([
      { type: 'audio', source: { kind: 'base64', media_type: 'audio/mpeg', data: 'ZZ' } },
    ]) as Array<Record<string, any>>;
    expect(mp3[0].input_audio.format).toBe('mp3');
  });

  it('renders a document as a file part with a data-uri file_data', () => {
    const out = toOpenAIContent([DOC]) as Array<Record<string, any>>;
    expect(out[0]).toEqual({ type: 'file', file: { file_data: 'data:application/pdf;base64,CCCC' } });
  });

  it('throws on a url-kind audio source (OpenAI input_audio is base64-only)', () => {
    expect(() =>
      toOpenAIContent([{ type: 'audio', source: { kind: 'url', media_type: 'audio/wav', data: 'http://x' } }]),
    ).toThrowError(LLMError);
  });
});

// ─── Modality helpers ────────────────────────────────────────────────────────

describe('modality helpers', () => {
  it('requiredModalities flips a flag per non-text part, ignores text', () => {
    expect(requiredModalities([TXT])).toEqual({});
    expect(requiredModalities([TXT, IMG])).toEqual({ image: true });
    expect(requiredModalities([IMG, AUDIO, DOC])).toEqual({ image: true, audio: true, document: true });
  });

  it('supportsModalities treats absent flags as false (text-only default)', () => {
    expect(supportsModalities(undefined, { image: true })).toBe(false);
    expect(supportsModalities({ image: true }, { image: true })).toBe(true);
    expect(supportsModalities({ image: true }, { image: true, audio: true })).toBe(false);
    expect(supportsModalities({ image: true, audio: true, document: true }, { document: true })).toBe(true);
    expect(supportsModalities({}, {})).toBe(true);
  });

  it('hasModalityDemand is true iff at least one modality is required', () => {
    expect(hasModalityDemand({})).toBe(false);
    expect(hasModalityDemand({ image: false })).toBe(false);
    expect(hasModalityDemand({ audio: true })).toBe(true);
  });
});

// ─── Adapter integration (multimodal turns hit the wire correctly) ───────────

const mockFetch = (response: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(response), { status, headers: { 'content-type': 'application/json' } }));

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const options = { model: 'm', max_tokens: 100, timeout_ms: 5000 };
const multimodalMsgs: LLMMessage[] = [
  { role: 'system', content: 'You are a summarizer.' },
  { role: 'user', content: 'fallback text', content_parts: [{ type: 'text', text: 'summarize' }, IMG] },
];

describe('adapter multimodal rendering', () => {
  it('Anthropic: a content_parts user message becomes a block array; system stays text', async () => {
    fetchMock.mockImplementationOnce(mockFetch({ content: [{ type: 'text', text: 'ok' }] }));
    const slot: LLMSlot = { provider: 'anthropic', model: 'm', api_key: 'k' };
    await createAnthropicAdapter().complete(slot, multimodalMsgs, options);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.system).toBe('You are a summarizer.');
    expect(body.messages).toHaveLength(1);
    expect(Array.isArray(body.messages[0].content)).toBe(true);
    expect(body.messages[0].content[0]).toEqual({ type: 'text', text: 'summarize' });
    expect(body.messages[0].content[1].type).toBe('image');
  });

  it('Google: a content_parts user message renders inlineData parts', async () => {
    fetchMock.mockImplementationOnce(mockFetch({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
    const slot: LLMSlot = { provider: 'google', model: 'm', api_key: 'k' };
    await createGoogleAdapter().complete(slot, multimodalMsgs, options);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.system_instruction.parts[0].text).toBe('You are a summarizer.');
    expect(body.contents[0].parts[0]).toEqual({ text: 'summarize' });
    expect(body.contents[0].parts[1]).toEqual({ inlineData: { mimeType: 'image/png', data: 'AAAA' } });
  });

  it('OpenAI: a content_parts user message renders an image_url part', async () => {
    fetchMock.mockImplementationOnce(mockFetch({ choices: [{ message: { content: 'ok' } }] }));
    const slot: LLMSlot = { provider: 'openai', model: 'm', api_key: 'k' };
    await createOpenAIAdapter().complete(slot, multimodalMsgs, options);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.messages[0]).toEqual({ role: 'system', content: 'You are a summarizer.' });
    expect(body.messages[1].content[0]).toEqual({ type: 'text', text: 'summarize' });
    expect(body.messages[1].content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } });
  });

  it('text-only messages keep a string content (additive back-compat)', async () => {
    fetchMock.mockImplementationOnce(mockFetch({ choices: [{ message: { content: 'ok' } }] }));
    const slot: LLMSlot = { provider: 'openai', model: 'm', api_key: 'k' };
    await createOpenAIAdapter().complete(slot, [{ role: 'user', content: 'plain' }], options);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.messages[0]).toEqual({ role: 'user', content: 'plain' });
  });
});

// ─── D-164 prompt-cache restructure — text-part predicates + render matrix ───

describe('D-164 content-part predicates', () => {
  it('hasNonTextPart is true iff a non-text part is present', () => {
    expect(hasNonTextPart([TXT])).toBe(false);
    expect(hasNonTextPart([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe(false);
    expect(hasNonTextPart([TXT, IMG])).toBe(true);
  });

  it('hasCacheBreakpoint is true iff a text part carries cache_breakpoint', () => {
    expect(hasCacheBreakpoint([TXT])).toBe(false);
    expect(hasCacheBreakpoint([{ type: 'text', text: 'a', cache_breakpoint: true }])).toBe(true);
    expect(hasCacheBreakpoint([IMG, { type: 'text', text: 'b' }])).toBe(false);
  });

  it('joinTextParts concatenates text with no separator; the cache split round-trips', () => {
    expect(joinTextParts([{ type: 'text', text: 'BASE' }, { type: 'text', text: ' EXTRA' }])).toBe('BASE EXTRA');
    const prefix = '{"available_tools":[],"commitment_context":[]';
    const suffix = ',"chat_tail":[],"user_message":"q"}';
    expect(joinTextParts([
      { type: 'text', text: prefix, cache_breakpoint: true },
      { type: 'text', text: suffix },
    ])).toBe(prefix + suffix);
  });

  it('joinTextParts skips a stray non-text part (defensive — callers pass all-text)', () => {
    expect(joinTextParts([{ type: 'text', text: 'a' }, IMG, { type: 'text', text: 'b' }])).toBe('ab');
  });
});

describe('toAnthropicContent — cache_control emission', () => {
  it('emits exactly one cache_control on the breakpoint block, none elsewhere', () => {
    const out = toAnthropicContent([
      { type: 'text', text: 'CATALOG', cache_breakpoint: true },
      { type: 'text', text: 'PER-TURN' },
    ]) as Array<Record<string, unknown>>;
    expect(out[0]).toEqual({ type: 'text', text: 'CATALOG', cache_control: { type: 'ephemeral' } });
    expect(out[1]).toEqual({ type: 'text', text: 'PER-TURN' });
    expect(out.filter((b) => b.cache_control !== undefined)).toHaveLength(1);
  });

  it('omits cache_control entirely when no block is marked', () => {
    const out = toAnthropicContent([TXT]) as Array<Record<string, unknown>>;
    expect(out[0].cache_control).toBeUndefined();
  });
});

// HIGH-severity regression guard: an all-text ADDITIVE content_parts (a base text
// part + an appended note) must NEVER collapse to `m.content` — every provider
// must receive the FULL joined text.
const ADDITIVE_MSG: LLMMessage = {
  role: 'user',
  content: 'BASE',
  content_parts: [{ type: 'text', text: 'BASE' }, { type: 'text', text: ' EXTRA' }],
};
// The D-164 cache split: stable prefix block (cache_breakpoint) + per-turn block;
// the two concatenate byte-identically to `content`.
const CACHE_PREFIX = '{"available_tools":[],"commitment_context":[]';
const CACHE_BODY = CACHE_PREFIX + ',"chat_tail":[],"user_message":"q"}';
const CACHE_SPLIT_MSG: LLMMessage = {
  role: 'user',
  content: CACHE_BODY,
  content_parts: [
    { type: 'text', text: CACHE_PREFIX, cache_breakpoint: true },
    { type: 'text', text: CACHE_BODY.slice(CACHE_PREFIX.length) },
  ],
};

describe('D-164 adapter render matrix', () => {
  it('Anthropic: additive all-text content_parts send the FULL joined text (no drop)', async () => {
    fetchMock.mockImplementationOnce(mockFetch({ content: [{ type: 'text', text: 'ok' }] }));
    await createAnthropicAdapter().complete({ provider: 'anthropic', model: 'm', api_key: 'k' }, [ADDITIVE_MSG], options);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.messages[0]).toEqual({ role: 'user', content: 'BASE EXTRA' });
  });

  it('OpenAI: additive all-text content_parts send the FULL joined text (no drop)', async () => {
    fetchMock.mockImplementationOnce(mockFetch({ choices: [{ message: { content: 'ok' } }] }));
    await createOpenAIAdapter().complete({ provider: 'openai', model: 'm', api_key: 'k' }, [ADDITIVE_MSG], options);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.messages[0]).toEqual({ role: 'user', content: 'BASE EXTRA' });
  });

  it('Google: additive all-text content_parts send the FULL joined text (no drop)', async () => {
    fetchMock.mockImplementationOnce(mockFetch({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
    await createGoogleAdapter().complete({ provider: 'google', model: 'm', api_key: 'k' }, [ADDITIVE_MSG], options);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.contents[0].parts).toEqual([{ text: 'BASE EXTRA' }]);
  });

  it('Anthropic: a cache-split turn renders a block array with ONE cache_control on block 0', async () => {
    fetchMock.mockImplementationOnce(mockFetch({ content: [{ type: 'text', text: 'ok' }] }));
    await createAnthropicAdapter().complete({ provider: 'anthropic', model: 'm', api_key: 'k' }, [CACHE_SPLIT_MSG], options);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    const content = body.messages[0].content as Array<Record<string, unknown>>;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]).toEqual({ type: 'text', text: CACHE_PREFIX, cache_control: { type: 'ephemeral' } });
    expect(content[1].cache_control).toBeUndefined();
    expect(content.filter((b) => b.cache_control !== undefined)).toHaveLength(1);
    expect(content.map((b) => b.text).join('')).toBe(CACHE_BODY);
  });

  it('OpenAI: a cache-split turn collapses to the byte-identical plain string (today wire)', async () => {
    fetchMock.mockImplementationOnce(mockFetch({ choices: [{ message: { content: 'ok' } }] }));
    await createOpenAIAdapter().complete({ provider: 'openai', model: 'm', api_key: 'k' }, [CACHE_SPLIT_MSG], options);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.messages[0]).toEqual({ role: 'user', content: CACHE_BODY });
  });

  it('Google: a cache-split turn collapses to a single { text } part = the body', async () => {
    fetchMock.mockImplementationOnce(mockFetch({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
    await createGoogleAdapter().complete({ provider: 'google', model: 'm', api_key: 'k' }, [CACHE_SPLIT_MSG], options);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.contents[0].parts).toEqual([{ text: CACHE_BODY }]);
  });
});
