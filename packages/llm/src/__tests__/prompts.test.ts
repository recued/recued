import { describe, it, expect } from 'vitest';
import {
  buildContractedPrompt, buildUncontractedPrompt, isContractedSlug, CONTRACTED_SLUGS,
  topLevelArrayElementEnds,
} from '../prompts.js';
import { LLMError } from '../types.js';
import { toAnthropicContent } from '../adapters/content-parts.js';

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

// D-347 slice C follow-up (2026-11-08) — a second Anthropic breakpoint after the last of the turn's calls.
describe('buildUncontractedPrompt — the rounds\' array as a second breakpoint (llm.cache_rolling_field)', () => {
  const PREFIX = '{"available_tools":[],"commitment_context":[]';
  // A value with brackets, braces, quotes and an escape in it, and a nested array of objects.
  const calls = [
    { tool_name: 'a', result: { note: 'a ] } " [ { \\ end' } },
    { tool_name: 'b', result: { nested: { deep: [1, { x: 2 }], prior_tool_calls: [{ no: 1 }] } } },
    { tool_name: 'c', result: { ok: true } },
  ];
  const bodyOf = (n: number, extra: Record<string, unknown> = {}) => `${PREFIX},${JSON.stringify({
    chat_tail: [], user_message: 'q', ...(n >= 0 ? { prior_tool_calls: calls.slice(0, n) } : {}), pii_notice: 'x', ...extra,
  }).slice(1)}`;
  const userOf = (body: string, field: unknown = 'prior_tool_calls') => buildUncontractedPrompt({
    'llm.prompt': body, 'llm.cache_prefix': PREFIX, 'llm.cache_rolling_field': field })[0]!;
  const texts = (user: ReturnType<typeof userOf>) => user.content_parts!.map((p) => (p.type === 'text' ? p.text : ''));
  const marked = (user: ReturnType<typeof userOf>) => user.content_parts!.filter((p) => p.type === 'text' && p.cache_breakpoint).length;

  it('cuts after each call, marks the last as a second breakpoint, and the blocks join back to the body', () => {
    const body = bodyOf(3);
    const user = userOf(body);
    expect(user.content).toBe(body);
    expect(texts(user).join('')).toBe(body);
    expect(texts(user)[0]).toBe(PREFIX);
    // prefix, three blocks each ending with a call, and the rest.
    expect(texts(user)).toHaveLength(5);
    for (const [i, call] of calls.entries()) expect(texts(user)[i + 1]!.endsWith(JSON.stringify(call))).toBe(true);
    expect(user.content_parts![3]).toMatchObject({ cache_breakpoint: true });
    expect(marked(user)).toBe(2);
    expect(toAnthropicContent(user.content_parts!).filter((b) => (b as { cache_control?: unknown }).cache_control)).toHaveLength(2);
  });

  it('the next round, holding the same calls and more, has a block boundary where this round wrote its cache', () => {
    const first = userOf(bodyOf(1));
    const second = userOf(bodyOf(3));
    const written = texts(first).slice(0, 2).join('');
    const boundaries = texts(second).map((_, i, all) => all.slice(0, i + 1).join(''));
    expect(boundaries).toContain(written);
  });

  it('leaves the one cut when the field is not named, absent from the body, or empty', () => {
    for (const user of [userOf(bodyOf(3), null), userOf(bodyOf(-1)), userOf(bodyOf(0)), userOf(bodyOf(3), 'nothing_here')]) {
      expect(texts(user)).toHaveLength(2);
      expect(marked(user)).toBe(1);
    }
  });

  it('reads no key of that name deeper in the body, nor one inside a string', () => {
    const body = bodyOf(-1, { note: '"prior_tool_calls":[{"x":1}]', inner: { prior_tool_calls: [{ y: 2 }] } });
    expect(texts(userOf(body))).toHaveLength(2);
  });

  it('keeps the last 19 call boundaries, the earlier calls merged into the first block', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ tool_name: `t${String(i)}`, result: { i } }));
    const body = `${PREFIX},${JSON.stringify({ user_message: 'q', prior_tool_calls: many }).slice(1)}`;
    const user = userOf(body);
    expect(texts(user)).toHaveLength(1 + 19 + 1);
    expect(texts(user).join('')).toBe(body);
    expect(texts(user)[19]!.endsWith(JSON.stringify(many[29]))).toBe(true);
  });
});

describe('topLevelArrayElementEnds', () => {
  it('finds where each element of a top-level array ends, and nothing in a body that does not scan', () => {
    const json = '{"a":"[x]","list":[{"k":"}"},[1,2],{"n":{"m":[3]}}],"z":1}';
    const ends = topLevelArrayElementEnds(json, 'list');
    const open = json.indexOf('"list":[') + '"list":['.length;
    expect(ends.map((end, i) => json.slice(i === 0 ? open : ends[i - 1]! + 1, end))).toEqual(['{"k":"}"}', '[1,2]', '{"n":{"m":[3]}}']);
    expect(topLevelArrayElementEnds('{"list":[{"k":1}', 'list')).toEqual([]);
    expect(topLevelArrayElementEnds('{"list":"not an array"}', 'list')).toEqual([]);
    expect(topLevelArrayElementEnds('{"other":[{"k":1}]}', 'list')).toEqual([]);
  });
});
