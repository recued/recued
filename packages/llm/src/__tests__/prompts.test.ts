import { describe, it, expect } from 'vitest';
import {
  buildContractedPrompt, buildUncontractedPrompt, isContractedSlug, CONTRACTED_SLUGS,
} from '../prompts.js';
import { LLMError } from '../types.js';

describe('isContractedSlug', () => {
  it('recognizes all 9 contracted slugs', () => {
    expect(CONTRACTED_SLUGS.size).toBe(9);
    for (const slug of [
      'ai-classify', 'ai-score', 'ai-extract', 'ai-summarize', 'ai-sentiment',
      'ai-compare', 'ai-generate', 'ai-translate', 'ai-rewrite',
    ]) {
      expect(isContractedSlug(slug)).toBe(true);
    }
  });

  it('rejects ai-prompt and unknown slugs', () => {
    expect(isContractedSlug('ai-prompt')).toBe(false);
    expect(isContractedSlug('ai-made-up')).toBe(false);
  });
});

describe('buildContractedPrompt', () => {
  it('throws for non-contracted slug', () => {
    expect(() => buildContractedPrompt('ai-prompt', {})).toThrow(LLMError);
  });

  it('throws when required field missing', () => {
    expect(() => buildContractedPrompt('ai-classify', { 'llm.categories': ['a', 'b'] }))
      .toThrow(/llm\.data/);
  });

  it('ai-classify builds system + user with categories and data', () => {
    const messages = buildContractedPrompt('ai-classify', {
      'llm.data': 'hello world',
      'llm.categories': ['greeting', 'question'],
    });
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('classifier');
    expect(messages[0].content).toContain('JSON');
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toContain('greeting');
    expect(messages[1].content).toContain('hello world');
  });

  it('ai-classify includes context when provided', () => {
    const messages = buildContractedPrompt('ai-classify', {
      'llm.data': 'x',
      'llm.categories': ['a'],
      'llm.context': 'important context',
    });
    expect(messages[1].content).toContain('important context');
  });

  it('ai-score includes criteria and defaults scale', () => {
    const messages = buildContractedPrompt('ai-score', {
      'llm.data': 'product',
      'llm.criteria': ['quality', 'value'],
    });
    expect(messages[0].content).toContain('scoring');
    expect(messages[1].content).toContain('0-10');
    expect(messages[1].content).toContain('quality');
  });

  it('ai-extract builds with dynamic field list', () => {
    const messages = buildContractedPrompt('ai-extract', {
      'llm.data': { foo: 1 },
      'llm.fields': ['name', 'email'],
    });
    expect(messages[0].content).toContain('extractor');
    expect(messages[0].content).toContain('name');
    expect(messages[0].content).toContain('email');
  });

  // ⛔ ai-extract accepted llm.context and never read it: the producers that steer
  // extraction with it (role, company, related_threads, topic_cluster) sent the model
  // none of it.
  it('ai-extract puts llm.context between the fields and the data, in both modes', () => {
    const single = buildContractedPrompt('ai-extract', {
      'llm.data': { body: 'Thanks — Dana' },
      'llm.fields': ['title'],
      'llm.context': 'Only a title the signature names.',
    });
    expect(single[1].content).toBe(
      'Fields: ["title"]\n\nContext:\nOnly a title the signature names.\n\nData:\n{\n  "body": "Thanks — Dana"\n}',
    );
    const batch = buildContractedPrompt('ai-extract', {
      'llm.data': [{ id: 'r1', body: 'x' }],
      'llm.id_field': 'id',
      'llm.fields': ['title'],
      'llm.context': 'Only a title the signature names.',
    });
    expect(batch[1].content).toMatch(/^Fields: \["title"\]\n\nContext:\nOnly a title the signature names\.\n\nRecords:\n/);
  });

  it('ai-summarize honors max_length and focus', () => {
    const messages = buildContractedPrompt('ai-summarize', {
      'llm.data': 'long text',
      'llm.max_length': 50,
      'llm.focus': 'risks',
    });
    expect(messages[0].content).toContain('50');
    expect(messages[0].content).toContain('risks');
  });

  it('ai-sentiment returns 2 messages', () => {
    const messages = buildContractedPrompt('ai-sentiment', { 'llm.data': 'great!' });
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toContain('sentiment');
  });

  it('ai-compare includes both data_a and data_b', () => {
    const messages = buildContractedPrompt('ai-compare', {
      'llm.data_a': { name: 'Alice' },
      'llm.data_b': { name: 'Bob' },
    });
    expect(messages[1].content).toContain('Alice');
    expect(messages[1].content).toContain('Bob');
  });

  it('ai-compare includes dimensions when provided', () => {
    const messages = buildContractedPrompt('ai-compare', {
      'llm.data_a': 'a',
      'llm.data_b': 'b',
      'llm.dimensions': ['price', 'quality'],
    });
    expect(messages[0].content).toContain('price');
  });

  it('ai-generate requires template_type, defaults tone', () => {
    const messages = buildContractedPrompt('ai-generate', {
      'llm.data': 'source',
      'llm.template_type': 'email',
    });
    expect(messages[0].content).toContain('email');
    expect(messages[0].content).toContain('neutral');
  });

  it('ai-translate enforces target_language', () => {
    expect(() => buildContractedPrompt('ai-translate', { 'llm.data': 'hi' }))
      .toThrow(/target_language/);
  });

  it('ai-translate builds with target language', () => {
    const messages = buildContractedPrompt('ai-translate', {
      'llm.data': 'hello',
      'llm.target_language': 'French',
    });
    expect(messages[0].content).toContain('French');
  });

  it('ai-rewrite requires style', () => {
    const messages = buildContractedPrompt('ai-rewrite', {
      'llm.data': 'text',
      'llm.style': 'formal',
    });
    expect(messages[0].content).toContain('formal');
  });

  it('all contracted prompts end with JSON-only suffix', () => {
    const inputs: Record<string, Record<string, unknown>> = {
      'ai-classify':  { 'llm.data': 'x', 'llm.categories': ['a'] },
      'ai-score':     { 'llm.data': 'x', 'llm.criteria': ['a'] },
      'ai-extract':   { 'llm.data': 'x', 'llm.fields': ['a'] },
      'ai-summarize': { 'llm.data': 'x' },
      'ai-sentiment': { 'llm.data': 'x' },
      'ai-compare':   { 'llm.data_a': 'x', 'llm.data_b': 'y' },
      'ai-generate':  { 'llm.data': 'x', 'llm.template_type': 'tweet' },
      'ai-translate': { 'llm.data': 'x', 'llm.target_language': 'es' },
      'ai-rewrite':   { 'llm.data': 'x', 'llm.style': 'casual' },
    };
    for (const [slug, input] of Object.entries(inputs)) {
      const messages = buildContractedPrompt(slug, input);
      expect(messages[0].content).toMatch(/Respond with ONLY a valid JSON object/);
    }
  });
});

describe('buildUncontractedPrompt', () => {
  it('throws when llm.prompt is missing', () => {
    expect(() => buildUncontractedPrompt({})).toThrow(LLMError);
  });

  it('builds with system + user when both provided', () => {
    const messages = buildUncontractedPrompt({
      'llm.system_prompt': 'You are helpful.',
      'llm.prompt': 'Hi',
    });
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
  });

  it('omits system when not provided', () => {
    const messages = buildUncontractedPrompt({ 'llm.prompt': 'Hi' });
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
  });
});

describe('buildUncontractedPrompt — D-164 cache split (llm.cache_prefix)', () => {
  const PREFIX = '{"available_tools":[],"commitment_context":[]';
  const BODY = `${PREFIX},"chat_tail":[],"user_message":"q"}`;

  it('splits the user turn into a cache_breakpoint prefix block + a per-turn block', () => {
    const messages = buildUncontractedPrompt({
      'llm.system_prompt': 'SYS',
      'llm.prompt': BODY,
      'llm.cache_prefix': PREFIX,
    });
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: 'system', content: 'SYS' });
    const user = messages[1];
    expect(user.role).toBe('user');
    // `content` stays the FULL body (the plain-string wire for non-Anthropic).
    expect(user.content).toBe(BODY);
    expect(user.content_parts).toEqual([
      { type: 'text', text: PREFIX, cache_breakpoint: true },
      { type: 'text', text: BODY.slice(PREFIX.length) },
    ]);
    // byte-identity: the two blocks concatenate back to the body.
    expect(user.content_parts!.map((p) => (p.type === 'text' ? p.text : '')).join('')).toBe(BODY);
  });

  it.each([
    ['absent', undefined],
    ['empty string', ''],
    ['non-string', 123],
    ['not a prefix of the body', '{"different":1}'],
    ['equal to the whole body (no per-turn suffix)', BODY],
  ])('fails open to a plain-string turn when cache_prefix is %s', (_label, prefix) => {
    const input: Record<string, unknown> = { 'llm.prompt': BODY };
    if (prefix !== undefined) input['llm.cache_prefix'] = prefix;
    const messages = buildUncontractedPrompt(input);
    const user = messages[messages.length - 1];
    expect(user.role).toBe('user');
    expect(user.content).toBe(BODY);
    expect(user.content_parts).toBeUndefined();
  });
});
