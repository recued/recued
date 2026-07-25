/** D-162 P0 -- batch-mode contract surface for contracted ai-* slugs. */

import { describe, expect, it } from 'vitest';

import {
  AI_RESULT_FIELDS,
  BATCH_CAPABLE_AI_SLUGS,
  BATCH_CAPABLE_AI_SLUG_SET,
  isAIBatchMode,
  isBatchCapableAISlug,
} from '../ai-batch.js';

describe('D-162 P0 batch-capable ai slug contract', () => {
  const expectedBatchSlugs = [
    'ai-classify',
    'ai-score',
    'ai-extract',
    'ai-summarize',
    'ai-sentiment',
    'ai-generate',
    'ai-translate',
    'ai-rewrite',
  ];

  it('contains exactly the eight batch-capable contracted ai slugs', () => {
    expect(BATCH_CAPABLE_AI_SLUGS).toEqual(expectedBatchSlugs);
    expect(BATCH_CAPABLE_AI_SLUGS).toHaveLength(8);
    expect(BATCH_CAPABLE_AI_SLUGS).not.toContain('ai-compare');
    expect(BATCH_CAPABLE_AI_SLUGS).not.toContain('ai-prompt');
  });

  it('keeps the membership set in lockstep with the slug list', () => {
    expect(BATCH_CAPABLE_AI_SLUG_SET.size).toBe(BATCH_CAPABLE_AI_SLUGS.length);
    expect(BATCH_CAPABLE_AI_SLUG_SET).toEqual(new Set(expectedBatchSlugs));
  });

  it('recognizes only batch-capable ai slugs', () => {
    for (const slug of expectedBatchSlugs) {
      expect(isBatchCapableAISlug(slug)).toBe(true);
    }

    expect(isBatchCapableAISlug('ai-compare')).toBe(false);
    expect(isBatchCapableAISlug('ai-prompt')).toBe(false);
    expect(isBatchCapableAISlug('ai-made-up')).toBe(false);
  });
});

describe('D-162 P0 AI_RESULT_FIELDS', () => {
  it('matches the fixed-result-field slugs from the N.4 table', () => {
    expect(AI_RESULT_FIELDS).toEqual({
      'ai-classify': ['category', 'confidence', 'reasoning'],
      'ai-score': ['score', 'breakdown', 'reasoning'],
      'ai-summarize': ['summary', 'key_points'],
      'ai-sentiment': ['sentiment', 'score', 'signals'],
      'ai-generate': ['content'],
      'ai-translate': ['translated', 'source_language', 'confidence'],
      'ai-rewrite': ['rewritten'],
    });
  });

  it('omits ai-extract because its result fields come from llm.fields', () => {
    expect(Object.keys(AI_RESULT_FIELDS)).not.toContain('ai-extract');
    expect('ai-extract' in AI_RESULT_FIELDS).toBe(false);
  });
});

describe('D-162 P0 isAIBatchMode', () => {
  it('is true when llm.id_field is a non-empty string and llm.data is an array', () => {
    expect(isAIBatchMode({
      'llm.id_field': 'record_id',
      'llm.data': [{ record_id: 'a' }],
    })).toBe(true);
  });

  it.each([
    [
      'missing id_field',
      { 'llm.data': [{ record_id: 'a' }] },
    ],
    [
      'empty-string id_field',
      { 'llm.id_field': '', 'llm.data': [{ record_id: 'a' }] },
    ],
    [
      'non-string id_field',
      { 'llm.id_field': 42, 'llm.data': [{ record_id: 'a' }] },
    ],
    [
      'non-array llm.data',
      { 'llm.id_field': 'record_id', 'llm.data': { record_id: 'a' } },
    ],
  ])('is false for %s', (_name, input) => {
    expect(isAIBatchMode(input)).toBe(false);
  });
});
