/** D-137 P3 § A.5 Pattern 4 + § A.6 — `findRecipeFallback` tests.
 *
 *  Covers topic-overlap ranking, registration-order tie-break,
 *  min_overlap floor, empty-input handling, Tier 1 / Tier 3
 *  filtering. */

import type { ToolEntry } from '@recued/contracts';
import { describe, expect, it } from 'vitest';
import { findRecipeFallback } from '../recipe-fallback.js';

const entry = (
  name: string,
  tier: 1 | 2 | 3,
  topic_tags: string[],
): ToolEntry => ({
  name,
  tier,
  description: `desc for ${name}`,
  arg_schema: { type: 'object' },
  topic_tags,
  classification: 'unknown',
  concurrency_safe: false,
});

describe('D-137 P3 § A.5 Pattern 4 — recipe fallback resolver', () => {
  it('returns null on empty intent_tags', () => {
    const result = findRecipeFallback(
      [entry('p/r1', 2, ['digest', 'weekly'])],
      { intent_tags: new Set<string>() },
    );
    expect(result).toBeNull();
  });

  it('returns null when no Tier 2 entry meets min_overlap', () => {
    const result = findRecipeFallback(
      [entry('p/r1', 2, ['unrelated'])],
      { intent_tags: new Set(['digest']) },
    );
    expect(result).toBeNull();
  });

  it('picks the Tier 2 entry with the highest topic overlap', () => {
    const result = findRecipeFallback(
      [
        entry('p/single-match', 2, ['digest']),
        entry('p/double-match', 2, ['digest', 'weekly']),
        entry('p/no-match', 2, ['other']),
      ],
      { intent_tags: new Set(['digest', 'weekly']) },
    );
    expect(result?.recipe_name).toBe('p/double-match');
    expect(result?.topic_match_count).toBe(2);
    expect(result?.matched_topics).toEqual(['digest', 'weekly']);
  });

  it('first-registered wins on tied overlap (deterministic + PB17 ordering invariant)', () => {
    const result = findRecipeFallback(
      [
        entry('p/first', 2, ['digest']),
        entry('p/second', 2, ['digest']),
      ],
      { intent_tags: new Set(['digest']) },
    );
    expect(result?.recipe_name).toBe('p/first');
  });

  it('ignores Tier 1 entries (the failed scope-search produced them)', () => {
    const result = findRecipeFallback(
      [
        entry('contact.search', 1, ['contact', 'lookup']),
        entry('p/recipe', 2, ['contact', 'lookup']),
      ],
      { intent_tags: new Set(['contact', 'lookup']) },
    );
    expect(result?.recipe_name).toBe('p/recipe');
  });

  it('ignores Tier 3 entries (passthrough to external MCP)', () => {
    const result = findRecipeFallback(
      [
        entry('exa.search', 3, ['search', 'web']),
        entry('p/recipe', 2, ['search', 'web']),
      ],
      { intent_tags: new Set(['search']) },
    );
    expect(result?.recipe_name).toBe('p/recipe');
  });

  it('min_overlap = 2 requires two-tag match', () => {
    const result = findRecipeFallback(
      [
        entry('p/single', 2, ['digest']),
        entry('p/double', 2, ['digest', 'weekly']),
      ],
      { intent_tags: new Set(['digest', 'weekly']), min_overlap: 2 },
    );
    expect(result?.recipe_name).toBe('p/double');
  });

  it('min_overlap < 1 collapses to null (degenerate)', () => {
    const result = findRecipeFallback(
      [entry('p/r', 2, ['digest'])],
      { intent_tags: new Set(['digest']), min_overlap: 0 },
    );
    expect(result).toBeNull();
  });
});
