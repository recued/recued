/** D-136 Phase 2 — `computeProducerVersionHash` helper.
 *
 *  Locks the canonical composition `(producer_code_hash, model_id,
 *  prompt_template_hash, adapter_version, consumed_ingredients_versions)`
 *  → `'fnv1a:<8-char-hex>'`. Tests cover:
 *    - same inputs → same hash (deterministic)
 *    - any single field change flips the hash
 *    - `consumed_ingredients_versions` order does not matter
 *    - shape: `'fnv1a:<8 lowercase hex chars>'`
 *
 *  Spec: `docs/d-136-spec.md` §A.3 + P2 phase plan. */

import { describe, expect, it } from 'vitest';

import { computeProducerVersionHash, type ProducerVersionHashInput } from '../index.js';

const baseInput: ProducerVersionHashInput = {
  producer_code_hash: 'a1b2c3d4',
  model_id: 'gpt-4o-mini',
  prompt_template_hash: 'deadbeef',
  adapter_version: '@recued/llm@1.0.0',
  consumed_ingredients_versions: [
    { slug: 'ai-classify', version: '1' },
    { slug: 'enrichment-list', version: '2' },
  ],
};

describe('D-136 §A.3 — computeProducerVersionHash shape', () => {
  it('returns a self-describing fnv1a:<8-hex> string', () => {
    const hash = computeProducerVersionHash(baseInput);
    expect(hash).toMatch(/^fnv1a:[0-9a-f]{8}$/);
  });
});

describe('D-136 §A.3 — determinism', () => {
  it('returns the same hash on repeat invocation with the same input', () => {
    expect(computeProducerVersionHash(baseInput)).toBe(
      computeProducerVersionHash(baseInput),
    );
  });

  it('returns the same hash when consumed_ingredients_versions are reordered', () => {
    // Sort-invariance: the composer sorts before hashing so input
    // ordering doesn't leak into the hash.
    const reordered: ProducerVersionHashInput = {
      ...baseInput,
      consumed_ingredients_versions: [...baseInput.consumed_ingredients_versions].reverse(),
    };
    expect(computeProducerVersionHash(reordered)).toBe(
      computeProducerVersionHash(baseInput),
    );
  });
});

describe('D-136 §A.3 — sensitivity', () => {
  it('changes when producer_code_hash differs', () => {
    const a = computeProducerVersionHash(baseInput);
    const b = computeProducerVersionHash({
      ...baseInput,
      producer_code_hash: 'a1b2c3d5', // last byte flipped
    });
    expect(a).not.toBe(b);
  });

  it('changes when model_id differs (cross-pool BYOK invalidation)', () => {
    const a = computeProducerVersionHash(baseInput);
    const b = computeProducerVersionHash({
      ...baseInput,
      model_id: 'claude-haiku-4-5',
    });
    expect(a).not.toBe(b);
  });

  it('changes when prompt_template_hash differs', () => {
    const a = computeProducerVersionHash(baseInput);
    const b = computeProducerVersionHash({
      ...baseInput,
      prompt_template_hash: 'cafebabe',
    });
    expect(a).not.toBe(b);
  });

  it('changes when adapter_version differs', () => {
    const a = computeProducerVersionHash(baseInput);
    const b = computeProducerVersionHash({
      ...baseInput,
      adapter_version: '@recued/llm@1.0.1',
    });
    expect(a).not.toBe(b);
  });

  it('changes when a consumed ingredient version bumps', () => {
    const a = computeProducerVersionHash(baseInput);
    const b = computeProducerVersionHash({
      ...baseInput,
      consumed_ingredients_versions: [
        { slug: 'ai-classify', version: '2' }, // bump
        { slug: 'enrichment-list', version: '2' },
      ],
    });
    expect(a).not.toBe(b);
  });

  it('changes when an ingredient slug is added', () => {
    const a = computeProducerVersionHash(baseInput);
    const b = computeProducerVersionHash({
      ...baseInput,
      consumed_ingredients_versions: [
        ...baseInput.consumed_ingredients_versions,
        { slug: 'ai-extract', version: '1' },
      ],
    });
    expect(a).not.toBe(b);
  });
});

describe('D-136 §A.3 — deterministic-producer degenerate case', () => {
  it('handles empty model / prompt / adapter / ingredients (deterministic producer)', () => {
    const deterministic: ProducerVersionHashInput = {
      producer_code_hash: 'feedface',
      model_id: '',
      prompt_template_hash: '',
      adapter_version: '',
      consumed_ingredients_versions: [],
    };
    const hash = computeProducerVersionHash(deterministic);
    expect(hash).toMatch(/^fnv1a:[0-9a-f]{8}$/);
    // Stable across calls.
    expect(computeProducerVersionHash(deterministic)).toBe(hash);
  });
});
