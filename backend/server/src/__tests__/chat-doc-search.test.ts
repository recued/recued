/** Searching the shipped documentation from `tools.search`.
 *
 *  The model carries one line of persona — "You are Recued." — and no product
 *  knowledge at all. Recued is private, so a "how do I connect my mail" question
 *  is not something a model gets right 90% of the time and occasionally fumbles;
 *  it is something it cannot know, and will improvise. That is the failure this
 *  addresses, and it is a different shape from the one the prompt log warns
 *  about (a calculator replacing a step already mostly right).
 *
 *  ⚠ THE MOVED FAILURE IS THE ONE TO WATCH. Every intervention that made the
 *  model's job easier has moved the failure rather than removed it
 *  (chat-prompt-optimization-log 2026-08-28h), and the obvious move here is a
 *  model that answers a DO request by quoting the manual. The cap, the ordering
 *  and the guidance copy are all aimed at that, and are asserted below.
 */

import { describe, expect, it } from 'vitest';

import {
  DOC_MATCH_LIMIT,
  DOC_MATCHES_GUIDANCE,
  searchDocIndex,
} from '../chat-doc-search.js';
import { CHAT_DOC_CHUNKS } from '../chat-doc-search.js';

describe('the shipped doc corpus', () => {
  it('is chunked into answer-sized sections, not whole pages', () => {
    expect(CHAT_DOC_CHUNKS.length).toBeGreaterThan(100);
    // A section that is really a page is not an answer — and the generator
    // truncates, so nothing should be near unbounded.
    for (const chunk of CHAT_DOC_CHUNKS) {
      expect(chunk.body.length).toBeLessThanOrEqual(1801);
      expect(chunk.body.length).toBeGreaterThan(0);
    }
  });

  it('gives every section a citable url and a stable id', () => {
    const ids = new Set<string>();
    for (const chunk of CHAT_DOC_CHUNKS) {
      expect(chunk.url.startsWith('https://recued.com/docs/')).toBe(true);
      // ⛔ Duplicate ids would make a citation ambiguous and make the
      // deterministic tie-break meaningless.
      expect(ids.has(chunk.id)).toBe(false);
      ids.add(chunk.id);
    }
  });

  it('carries no frontmatter leakage into a body', () => {
    // A body starting with `---` means the parser missed the frontmatter and
    // the model would be shown YAML as prose.
    for (const chunk of CHAT_DOC_CHUNKS) {
      expect(chunk.body.startsWith('---')).toBe(false);
    }
  });
});

describe('searchDocIndex', () => {
  it('finds the section that answers a real setup question', () => {
    const hits = searchDocIndex('how do I connect my mail');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((h) => h.title).join(' | ').toLowerCase()).toContain('connect');
  });

  it('ranks the heading above a passing mention in prose', () => {
    // Heading +3 / grouping +2 / body +1 — the same shape `scoreToolEntry`
    // uses, so a query cannot rank a doc and a tool by two different rules.
    const hits = searchDocIndex('pairing', 5, [
      { id: 'a', doc: 'A', section: 'Unrelated', eyebrow: '', url: 'u', body: 'mentions pairing once' },
      { id: 'b', doc: 'B', section: 'Pairing a device', eyebrow: '', url: 'u', body: 'x' },
    ]);
    expect(hits[0]?.id).toBe('b');
  });

  /** ⛔ THE CAP IS THE POINT, not a default. Doc hits share a packet with the
   *  tool matches that let the model actually do the thing. */
  it('never returns more than the cap, however many match', () => {
    const many = Array.from({ length: 40 }, (_v, i) => ({
      id: `d${i}`, doc: 'Doc', section: 'Connections', eyebrow: '',
      url: 'u', body: 'connections connections',
    }));
    expect(searchDocIndex('connections', 99, many)).toHaveLength(DOC_MATCH_LIMIT);
  });

  it('breaks ties on id so the result is deterministic', () => {
    const twins = ['b', 'a', 'c'].map((id) => ({
      id, doc: 'D', section: 'Same', eyebrow: '', url: 'u', body: 'same',
    }));
    expect(searchDocIndex('same', 3, twins).map((h) => h.id)).toEqual(['a', 'b', 'c']);
  });

  it('returns nothing for a query with no usable terms', () => {
    expect(searchDocIndex('a')).toEqual([]);
    expect(searchDocIndex('')).toEqual([]);
  });
});

describe('the guidance that ships with a doc hit', () => {
  /** ⛔ WITHOUT THIS LABEL a doc arrives in the same shape as a tool definition
   *  and reads as something to call. */
  it('says these are not tools', () => {
    expect(DOC_MATCHES_GUIDANCE).toContain('not tools');
  });

  /** ⛔ AND THE MOVED FAILURE, NAMED. The predictable regression is a model
   *  that answers "connect my mail" by reciting the manual instead of using the
   *  connection tools. */
  it('tells the model to act rather than recite when the ask is a DO', () => {
    expect(DOC_MATCHES_GUIDANCE).toContain('do it with the tools');
  });

  it('asks for the url, so an answer is checkable', () => {
    expect(DOC_MATCHES_GUIDANCE).toContain('url');
  });
});
