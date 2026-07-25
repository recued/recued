/** D-116 Phase 6 — validateProbeManifest.
 *
 *  Ensures only vault refs appear in probe input + expected_field is
 *  declared in manifest.output. */

import { describe, it, expect } from 'vitest';
import type { IngredientManifest } from '@recued/contracts';
import { validateProbeManifest } from '../validate-probe.js';

const baseManifest: IngredientManifest = {
  slug: 'test-ingredient',
  name: 'Test',
  description: 'Test ingredient for probe validation',
  author: 'recued-core',
  kind: 'http',
  category: 'data',
  risk_tier: 'read',
  input: { url: null, 'header.authorization': null },
  output: { deal_id: 'deal_id', name: 'name' },
};

describe('validateProbeManifest — no probe declared', () => {
  it('returns no issues when probe is absent', () => {
    expect(validateProbeManifest(baseManifest)).toEqual([]);
  });

  it('ignores inherited probe declarations', () => {
    const manifest = Object.assign(
      Object.create({
        probe: {
          input: { url: '{{config.region}}' },
          expected_field: 'deal_id',
        },
      }),
      baseManifest,
    ) as IngredientManifest;

    expect(validateProbeManifest(manifest)).toEqual([]);
  });
});

describe('validateProbeManifest — refs', () => {
  it('accepts a probe whose input only references {{vault.*}}', () => {
    const manifest: IngredientManifest = {
      ...baseManifest,
      probe: {
        input: {
          url: 'https://api.example.com/self',
          'header.authorization': 'Bearer {{vault.api_token}}',
        },
        expected_field: 'deal_id',
      },
    };
    expect(validateProbeManifest(manifest)).toEqual([]);
  });

  it('rejects a probe whose input references {{config.*}}', () => {
    const manifest: IngredientManifest = {
      ...baseManifest,
      probe: {
        input: { url: 'https://api.example.com/{{config.region}}/self' },
        expected_field: 'deal_id',
      },
    };
    const issues = validateProbeManifest(manifest);
    expect(issues.some((i) => i.code === 'probe_input_invalid_ref')).toBe(true);
  });

  it('rejects a probe whose input references {{step.*}}', () => {
    const manifest: IngredientManifest = {
      ...baseManifest,
      probe: {
        input: { url: '{{step.someStep}}' },
        expected_field: 'deal_id',
      },
    };
    const issues = validateProbeManifest(manifest);
    expect(issues.some((i) => i.code === 'probe_input_invalid_ref')).toBe(true);
  });
});

describe('validateProbeManifest — expected_field', () => {
  it('rejects a probe whose expected_field is not declared in output', () => {
    const manifest: IngredientManifest = {
      ...baseManifest,
      probe: {
        input: { url: 'https://api.example.com/{{vault.base}}/self' },
        expected_field: 'not_declared',
      },
    };
    const issues = validateProbeManifest(manifest);
    expect(issues.some((i) => i.code === 'probe_expected_field_undeclared')).toBe(true);
  });

  it('does not accept output fields inherited through the prototype chain', () => {
    const output = Object.create({ proto_field: 'proto_field' }) as IngredientManifest['output'];
    const manifest: IngredientManifest = {
      ...baseManifest,
      output,
      probe: {
        input: { url: 'https://api.example.com/{{vault.base}}/self' },
        expected_field: 'proto_field',
      },
    };

    const issues = validateProbeManifest(manifest);

    expect(issues.some((i) => i.code === 'probe_expected_field_undeclared')).toBe(true);
  });

  it('rejects an empty expected_field', () => {
    const manifest: IngredientManifest = {
      ...baseManifest,
      probe: {
        input: { url: 'https://api.example.com/{{vault.base}}/self' },
        expected_field: '',
      },
    };
    const issues = validateProbeManifest(manifest);
    expect(issues.some((i) => i.code === 'probe_expected_field_required')).toBe(true);
  });
});

describe('validateProbeManifest — input shape', () => {
  it('rejects a probe whose input is null / array', () => {
    const m1 = { ...baseManifest, probe: { input: null as unknown as Record<string, unknown>, expected_field: 'deal_id' } };
    const m2 = { ...baseManifest, probe: { input: [] as unknown as Record<string, unknown>, expected_field: 'deal_id' } };
    expect(validateProbeManifest(m1).some((i) => i.code === 'probe_input_required')).toBe(true);
    expect(validateProbeManifest(m2).some((i) => i.code === 'probe_input_required')).toBe(true);
  });
});
