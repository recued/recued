/** D-162 P1 -- batch array parsing and contracted batch validation. */

import { describe, expect, it } from 'vitest';

import {
  extractJSONArray,
  parseContractedBatch,
  parseContractedOutput,
  parseJSONArray,
} from '../parse.js';

describe('D-162 P1 extractJSONArray', () => {
  it('extracts a bare array', () => {
    expect(extractJSONArray('[{"id":"r1"}]')).toBe('[{"id":"r1"}]');
  });

  it('strips a json code fence around an array', () => {
    expect(extractJSONArray('```json\n[{"id":"r1"}]\n```')).toBe('[{"id":"r1"}]');
  });

  it('extracts an array after leading prose', () => {
    expect(extractJSONArray('Here is the batch result: [{"id":"r1"}]')).toBe('[{"id":"r1"}]');
  });

  it('extracts an array from a fenced response with a preamble', () => {
    const raw = 'Sure, here is the JSON:\n```json\n[{"id":"r1"}]\n```';
    expect(extractJSONArray(raw)).toBe('[{"id":"r1"}]');
  });

  it('rejects an object-wrapped array', () => {
    expect(extractJSONArray('{"results":[{"id":"r1"}]}')).toBeNull();
  });

  it('returns null when no array opens', () => {
    expect(extractJSONArray('{"id":"r1"}')).toBeNull();
    expect(extractJSONArray('no array here')).toBeNull();
  });

  it('ignores brackets inside JSON string values while scanning', () => {
    const raw = 'Result: [{"id":"r1","text":"literal [ and ] plus escaped \\"quote\\""}] trailing';
    expect(extractJSONArray(raw)).toBe('[{"id":"r1","text":"literal [ and ] plus escaped \\"quote\\""}]');
  });
});

describe('D-162 P1 parseJSONArray', () => {
  it('accepts an array of objects', () => {
    expect(parseJSONArray('[{"id":"r1"},{"id":"r2","ok":true}]')).toEqual([
      { id: 'r1' },
      { id: 'r2', ok: true },
    ]);
  });

  it('returns null for an object', () => {
    expect(parseJSONArray('{"id":"r1"}')).toBeNull();
  });

  it('returns null for a primitive', () => {
    expect(parseJSONArray('42')).toBeNull();
  });

  it.each([
    ['primitive', '[{"id":"r1"}, 1]'],
    ['null', '[{"id":"r1"}, null]'],
    ['array', '[{"id":"r1"}, []]'],
  ])('returns null for an array with a %s element', (_name, raw) => {
    expect(parseJSONArray(raw)).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseJSONArray('[{"id": }]')).toBeNull();
  });
});

describe('D-162 P1 parseContractedBatch', () => {
  it('builds a Map keyed by id_field and strips id_field from result fields', () => {
    const parsed = parseContractedBatch('ai-classify', JSON.stringify([
      {
        message_id: 'm1',
        category: 'support',
        confidence: 1.5,
        reasoning: 'Question about support.',
      },
      {
        message_id: 'm2',
        category: 'sales',
        confidence: 0.6,
        reasoning: 'Pricing intent.',
      },
    ]), 'message_id');

    expect(parsed).toBeInstanceOf(Map);
    expect(parsed?.get('m1')).toEqual({
      category: 'support',
      confidence: 1,
      reasoning: 'Question about support.',
    });
    expect(parsed?.get('m1')).not.toHaveProperty('message_id');
    expect(parsed?.get('m2')).toEqual({
      category: 'sales',
      confidence: 0.6,
      reasoning: 'Pricing intent.',
    });
  });

  it('reuses the slug validator for each entry result shape', () => {
    expect(parseContractedBatch('ai-classify', JSON.stringify([
      {
        id: 'r1',
        category: 'support',
        confidence: 'high',
        reasoning: 'Bad confidence type.',
      },
    ]), 'id')).toBeNull();
  });

  it('passes ai-extract entries through without fixed result-field validation', () => {
    const parsed = parseContractedBatch('ai-extract', JSON.stringify([
      {
        row_id: 'r1',
        arbitrary: 123,
        nested: { ok: true },
        missing: null,
      },
    ]), 'row_id');

    expect(parsed?.get('r1')).toEqual({
      arbitrary: 123,
      nested: { ok: true },
      missing: null,
    });
  });

  it('returns null for a non-array response', () => {
    expect(parseContractedBatch('ai-classify', '{"id":"r1"}', 'id')).toBeNull();
  });

  it.each([
    ['missing', [{ category: 'support', confidence: 0.8, reasoning: 'No id.' }]],
    ['empty', [{ id: '', category: 'support', confidence: 0.8, reasoning: 'Empty id.' }]],
  ])('returns null when an entry has a %s id_field', (_name, entries) => {
    expect(parseContractedBatch('ai-classify', JSON.stringify(entries), 'id')).toBeNull();
  });

  it('returns null for a duplicate id across the response', () => {
    expect(parseContractedBatch('ai-classify', JSON.stringify([
      { id: 'r1', category: 'support', confidence: 0.8, reasoning: 'First.' },
      { id: 'r1', category: 'sales', confidence: 0.7, reasoning: 'Second.' },
    ]), 'id')).toBeNull();
  });

  it('supports numeric id values', () => {
    const parsed = parseContractedBatch('ai-classify', JSON.stringify([
      { id: 42, category: 'support', confidence: 0.8, reasoning: 'Numeric id.' },
    ]), 'id');

    expect(parsed?.get(42)).toEqual({
      category: 'support',
      confidence: 0.8,
      reasoning: 'Numeric id.',
    });
  });
});

describe('D-162 P1 I-1 parseContractedOutput regression checks', () => {
  it('still accepts a well-formed single-mode contracted object', () => {
    expect(parseContractedOutput('ai-classify', JSON.stringify({
      category: 'greeting',
      confidence: 0.9,
      reasoning: 'Says hello.',
    }))).toEqual({
      category: 'greeting',
      confidence: 0.9,
      reasoning: 'Says hello.',
    });
  });

  it('still rejects a malformed single-mode contracted object', () => {
    expect(parseContractedOutput('ai-summarize', JSON.stringify({
      summary: 'Short',
      key_points: [1, 2],
    }))).toBeNull();
  });
});
