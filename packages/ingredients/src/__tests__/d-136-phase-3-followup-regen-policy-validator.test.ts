/** D-136 P3 follow-up — `regen_policy` ingredient-validator gate.
 *
 *  Tests the `validateRegenPolicy` section validator wired into the
 *  main `validateIngredient` pipeline. Two angles:
 *
 *  1. Synthetic manifest cases — explicit good / bad inputs.
 *  The real-corpus ai-* fixtures moved to backend/server/src/kernel-manifests.ts
 *  during the kernel/community separation. Kernel-side tests pin their
 *  presence and regen_policy blocks there.
 *
 *  Spec: `docs/d-136-spec.md` §A.4 + audit §27.2. */

import { describe, it, expect } from 'vitest';

import { validateIngredient } from '../validate.js';

const baseAiManifest = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  slug: 'ai-test-fixture',
  name: 'AI Test Fixture',
  description: 'Synthetic AI ingredient for validator tests.',
  author: 'recued-core',
  kind: 'ai',
  version: 1,
  category: 'ai',
  risk_tier: 'read',
  input: { 'llm.data': null },
  output: { result: 'result' },
  ...overrides,
});

describe('D-136 P3 follow-up — regen_policy validator (synthetic)', () => {
  it('passes when an ai-* manifest omits the block (defaults apply downstream)', () => {
    const result = validateIngredient(baseAiManifest());
    const regenIssues = result.issues.filter((i) => i.code.startsWith('regen_policy_'));
    expect(regenIssues).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('passes when an ai-* manifest declares a well-formed block', () => {
    const result = validateIngredient(
      baseAiManifest({
        regen_policy: {
          input_invariants: ['pii_hash_salt'],
          determinism: 'temperature_zero',
          dedup_key: ['source_record_hash', 'producer_version_hash'],
          regen_triggers: ['source_change', 'producer_change', 'manual'],
        },
      }),
    );
    const regenIssues = result.issues.filter((i) => i.code.startsWith('regen_policy_'));
    expect(regenIssues).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('rejects a non-ai manifest declaring regen_policy with regen_policy_unsupported_kind', () => {
    const httpManifest: Record<string, unknown> = {
      slug: 'fetch-something',
      name: 'Fetch Something',
      description: 'Synthetic HTTP ingredient.',
      author: 'recued-core',
      kind: 'http',
      version: 1,
      category: 'data',
      risk_tier: 'read',
      input: { url: 'https://api.example.com/v1/get', method: 'GET' },
      output: { id: 'data.id' },
      regen_policy: {
        input_invariants: ['pii_hash_salt'],
        determinism: 'temperature_zero',
        dedup_key: ['source_record_hash', 'producer_version_hash'],
        regen_triggers: ['source_change', 'producer_change', 'manual'],
      },
    };
    const result = validateIngredient(httpManifest);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'regen_policy_unsupported_kind')).toBe(true);
  });

  it('rejects an unknown determinism with regen_policy_determinism_invalid', () => {
    const result = validateIngredient(
      baseAiManifest({
        regen_policy: {
          input_invariants: ['pii_hash_salt'],
          determinism: 'high_temperature',
          dedup_key: ['source_record_hash', 'producer_version_hash'],
          regen_triggers: ['source_change', 'producer_change', 'manual'],
        },
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'regen_policy_determinism_invalid')).toBe(true);
  });

  it('rejects an unknown trigger with regen_policy_regen_trigger_unknown', () => {
    const result = validateIngredient(
      baseAiManifest({
        regen_policy: {
          input_invariants: ['pii_hash_salt'],
          determinism: 'temperature_zero',
          dedup_key: ['source_record_hash', 'producer_version_hash'],
          regen_triggers: ['source_change', 'phase_of_moon', 'manual'],
        },
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'regen_policy_regen_trigger_unknown')).toBe(true);
  });

  it('rejects an empty input_invariants array with regen_policy_input_invariants_empty', () => {
    const result = validateIngredient(
      baseAiManifest({
        regen_policy: {
          input_invariants: [],
          determinism: 'temperature_zero',
          dedup_key: ['source_record_hash', 'producer_version_hash'],
          regen_triggers: ['source_change', 'producer_change', 'manual'],
        },
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'regen_policy_input_invariants_empty')).toBe(true);
  });

  it('rejects an unknown input_invariant with regen_policy_input_invariant_unknown', () => {
    const result = validateIngredient(
      baseAiManifest({
        regen_policy: {
          input_invariants: ['pii_hash_salt', 'magic_secret'],
          determinism: 'temperature_zero',
          dedup_key: ['source_record_hash', 'producer_version_hash'],
          regen_triggers: ['source_change', 'producer_change', 'manual'],
        },
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'regen_policy_input_invariant_unknown')).toBe(true);
  });

  it('rejects an empty dedup_key array with regen_policy_dedup_key_empty', () => {
    const result = validateIngredient(
      baseAiManifest({
        regen_policy: {
          input_invariants: ['pii_hash_salt'],
          determinism: 'temperature_zero',
          dedup_key: [],
          regen_triggers: ['source_change', 'producer_change', 'manual'],
        },
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'regen_policy_dedup_key_empty')).toBe(true);
  });

  it('accepts open-vocabulary dedup_key entries (template_hash / style_hash / target_lang)', () => {
    const result = validateIngredient(
      baseAiManifest({
        regen_policy: {
          input_invariants: ['pii_hash_salt'],
          determinism: 'accept_noise_floor',
          dedup_key: ['source_record_hash', 'producer_version_hash', 'template_hash', 'style_hash'],
          regen_triggers: ['source_change', 'template_change', 'style_change', 'producer_change', 'manual'],
        },
      }),
    );
    expect(result.valid).toBe(true);
  });

  it('rejects a non-object regen_policy with regen_policy_invalid_shape', () => {
    const result = validateIngredient(
      baseAiManifest({ regen_policy: 'temperature_zero' }),
    );
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'regen_policy_invalid_shape')).toBe(true);
  });
});
