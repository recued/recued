/** D-145 § A.7.8 (Amended 2026-05-26) — tunable_params substrate.
 *
 *  Covers:
 *    - Discriminated `EnrichmentTunableParamSpec` shape (number / enum
 *      variants).
 *    - Key shape validator (`ENRICHMENT_TUNABLE_PARAM_KEY_RE`).
 *    - Closed-list `EnrichmentTunableParamUnit` membership.
 *    - `validateEnrichmentDeclaration` integration: optional field,
 *      bounds / enum / type / ui_label / ui_help / unit checks all
 *      surface `enrichment_tunable_params_invalid` issues.
 *    - `computeProducerVersionHash` backward-compat + tunable_params_hash
 *      slot: absent / empty hash → byte-stable with pre-amendment input
 *      shape; non-empty hash flips the composed result. */

import { describe, expect, it } from 'vitest';

import {
  ENRICHMENT_TUNABLE_PARAM_KEY_RE,
  ENRICHMENT_TUNABLE_PARAM_UNITS,
  computeProducerVersionHash,
  isEnrichmentTunableParamUnit,
  validateEnrichmentDeclaration,
  type EnrichmentDeclaration,
  type EnrichmentTunableParamSpec,
  type ProducerVersionHashInput,
} from '../index.js';

// ────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────

const baseDecl: EnrichmentDeclaration = {
  topic: 'tunable_params_test_topic',
  operates_on: ['data.project'],
  event_time_field: null,
  window: null,
  producer_kind: 'housekeeping',
  temporal_class: 'snapshot',
  identity_aggregation: 'scenario',
  sample_floor: 1,
  confidence_kind: 'none',
  coverage: 'computed',
  source_degradation_reasons: [],
  privacy_class: 'user_inferable',
  mcp_exposed_default: false,
  invalidation_triggers: ['data.project.updated'],
  benchmark_scenarios: ['scn_tunable_params_test'],
  return_shape: '{ project: REF<project>, value: number }',
  suggest_directive: null,
  concurrency_safe: true,
};

const numericSpec: EnrichmentTunableParamSpec = {
  kind: 'number',
  default: 14,
  min: 1,
  max: 730,
  unit: 'days',
  ui_label: 'Stall threshold',
  ui_help: 'Days of inactivity before the project is flagged stalled.',
};

const enumSpec: EnrichmentTunableParamSpec = {
  kind: 'enum',
  default: 'balanced',
  enum_values: ['conservative', 'balanced', 'aggressive'],
  ui_label: 'Sensitivity',
  ui_help: 'How quickly the producer flags a degradation.',
};

const baseHashInput: ProducerVersionHashInput = {
  producer_code_hash: 'fnv1a:11111111',
  model_id: '',
  prompt_template_hash: '',
  adapter_version: '',
  consumed_ingredients_versions: [],
};

// ────────────────────────────────────────────────────────────────
// Closed-list constants + key regex
// ────────────────────────────────────────────────────────────────

describe('ENRICHMENT_TUNABLE_PARAM_UNITS', () => {
  it('exposes the canonical closed list', () => {
    expect([...ENRICHMENT_TUNABLE_PARAM_UNITS].sort()).toEqual([
      'count',
      'days',
      'hours',
      'percent',
      'ratio',
    ]);
  });

  it('isEnrichmentTunableParamUnit accepts every member', () => {
    for (const unit of ENRICHMENT_TUNABLE_PARAM_UNITS) {
      expect(isEnrichmentTunableParamUnit(unit)).toBe(true);
    }
  });

  it('isEnrichmentTunableParamUnit rejects non-members', () => {
    expect(isEnrichmentTunableParamUnit('weeks')).toBe(false);
    expect(isEnrichmentTunableParamUnit('')).toBe(false);
    expect(isEnrichmentTunableParamUnit(null)).toBe(false);
    expect(isEnrichmentTunableParamUnit(undefined)).toBe(false);
    expect(isEnrichmentTunableParamUnit(42)).toBe(false);
  });
});

describe('ENRICHMENT_TUNABLE_PARAM_KEY_RE', () => {
  it('accepts lowercase snake_case keys', () => {
    expect(ENRICHMENT_TUNABLE_PARAM_KEY_RE.test('stall_window_days')).toBe(true);
    expect(ENRICHMENT_TUNABLE_PARAM_KEY_RE.test('sensitivity')).toBe(true);
    expect(ENRICHMENT_TUNABLE_PARAM_KEY_RE.test('a')).toBe(true);
    expect(ENRICHMENT_TUNABLE_PARAM_KEY_RE.test('k1')).toBe(true);
  });

  it('rejects uppercase, leading digit, hyphens, spaces', () => {
    expect(ENRICHMENT_TUNABLE_PARAM_KEY_RE.test('StallWindow')).toBe(false);
    expect(ENRICHMENT_TUNABLE_PARAM_KEY_RE.test('1_day')).toBe(false);
    expect(ENRICHMENT_TUNABLE_PARAM_KEY_RE.test('stall-window')).toBe(false);
    expect(ENRICHMENT_TUNABLE_PARAM_KEY_RE.test('stall window')).toBe(false);
    expect(ENRICHMENT_TUNABLE_PARAM_KEY_RE.test('')).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// validateEnrichmentDeclaration — tunable_params optional
// ────────────────────────────────────────────────────────────────

describe('validateEnrichmentDeclaration — tunable_params absent', () => {
  it('passes when tunable_params is omitted (optional field)', () => {
    expect(validateEnrichmentDeclaration(baseDecl)).toEqual([]);
  });

  it('passes when tunable_params is an empty object', () => {
    expect(
      validateEnrichmentDeclaration({ ...baseDecl, tunable_params: {} }),
    ).toEqual([]);
  });
});

describe('validateEnrichmentDeclaration — tunable_params kind: number', () => {
  it('accepts a valid numeric spec', () => {
    expect(
      validateEnrichmentDeclaration({
        ...baseDecl,
        tunable_params: { stall_window_days: numericSpec },
      }),
    ).toEqual([]);
  });

  it('accepts default at the lower boundary', () => {
    expect(
      validateEnrichmentDeclaration({
        ...baseDecl,
        tunable_params: { x: { ...numericSpec, default: 1, min: 1, max: 730 } },
      }),
    ).toEqual([]);
  });

  it('accepts default at the upper boundary', () => {
    expect(
      validateEnrichmentDeclaration({
        ...baseDecl,
        tunable_params: { x: { ...numericSpec, default: 730, min: 1, max: 730 } },
      }),
    ).toEqual([]);
  });

  it('rejects default below min', () => {
    const issues = validateEnrichmentDeclaration({
      ...baseDecl,
      tunable_params: { x: { ...numericSpec, default: 0, min: 1, max: 730 } },
    });
    expect(issues.length).toBe(1);
    expect(issues[0]).toMatch(/enrichment_tunable_params_invalid/);
    expect(issues[0]).toMatch(/default .* must lie within \[min=1, max=730\]/);
  });

  it('rejects default above max', () => {
    const issues = validateEnrichmentDeclaration({
      ...baseDecl,
      tunable_params: { x: { ...numericSpec, default: 1000, min: 1, max: 730 } },
    });
    expect(issues.length).toBe(1);
    expect(issues[0]).toMatch(/default .* must lie within \[min=1, max=730\]/);
  });

  it('rejects min > max (inverted bounds)', () => {
    const issues = validateEnrichmentDeclaration({
      ...baseDecl,
      tunable_params: { x: { ...numericSpec, default: 50, min: 100, max: 50 } },
    });
    // Two issues: bounds inverted + default outside [min, max].
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues.some((m) => /min .* > max/.test(m))).toBe(true);
  });

  it('rejects non-finite default', () => {
    const issues = validateEnrichmentDeclaration({
      ...baseDecl,
      tunable_params: { x: { ...numericSpec, default: Number.NaN } },
    });
    expect(issues.some((m) => /default.*finite number/.test(m))).toBe(true);
  });

  it('rejects missing min/max on number kind', () => {
    const issues = validateEnrichmentDeclaration({
      ...baseDecl,
      tunable_params: {
        x: {
          kind: 'number',
          default: 14,
          ui_label: 'X',
          ui_help: 'X help',
        } as EnrichmentTunableParamSpec,
      },
    });
    expect(issues.some((m) => /\.min'.*finite number/.test(m))).toBe(true);
    expect(issues.some((m) => /\.max'.*finite number/.test(m))).toBe(true);
  });
});

describe('validateEnrichmentDeclaration — tunable_params kind: enum', () => {
  it('accepts a valid enum spec', () => {
    expect(
      validateEnrichmentDeclaration({
        ...baseDecl,
        tunable_params: { sensitivity: enumSpec },
      }),
    ).toEqual([]);
  });

  it('rejects default not in enum_values', () => {
    const issues = validateEnrichmentDeclaration({
      ...baseDecl,
      tunable_params: {
        sensitivity: {
          ...enumSpec,
          default: 'wild',
        },
      },
    });
    expect(issues.length).toBe(1);
    expect(issues[0]).toMatch(/default 'wild' must be a member of enum_values/);
  });

  it('rejects empty enum_values', () => {
    const issues = validateEnrichmentDeclaration({
      ...baseDecl,
      tunable_params: {
        sensitivity: {
          ...enumSpec,
          enum_values: [],
        },
      },
    });
    expect(issues.some((m) => /enum_values.*non-empty array/.test(m))).toBe(true);
  });

  it('rejects enum_values entries that are not non-empty strings', () => {
    const issues = validateEnrichmentDeclaration({
      ...baseDecl,
      tunable_params: {
        sensitivity: {
          ...enumSpec,
          enum_values: ['ok', ''],
        },
      },
    });
    expect(issues.some((m) => /enum_values.*non-empty strings/.test(m))).toBe(true);
  });

  it('rejects non-string default on enum kind', () => {
    const issues = validateEnrichmentDeclaration({
      ...baseDecl,
      tunable_params: {
        sensitivity: {
          ...enumSpec,
          default: 1 as unknown as string,
        },
      },
    });
    expect(issues.some((m) => /default.*non-empty string when kind === 'enum'/.test(m))).toBe(true);
  });
});

describe('validateEnrichmentDeclaration — shared tunable param checks', () => {
  it('rejects malformed param key (uppercase)', () => {
    const issues = validateEnrichmentDeclaration({
      ...baseDecl,
      tunable_params: { StallWindow: numericSpec },
    });
    expect(issues.some((m) => /key must match/.test(m))).toBe(true);
  });

  it('rejects malformed param key (hyphen)', () => {
    const issues = validateEnrichmentDeclaration({
      ...baseDecl,
      tunable_params: { 'stall-window': numericSpec },
    });
    expect(issues.some((m) => /key must match/.test(m))).toBe(true);
  });

  it('rejects empty ui_label', () => {
    const issues = validateEnrichmentDeclaration({
      ...baseDecl,
      tunable_params: { x: { ...numericSpec, ui_label: '   ' } },
    });
    expect(issues.some((m) => /ui_label.*non-empty string/.test(m))).toBe(true);
  });

  it('rejects empty ui_help', () => {
    const issues = validateEnrichmentDeclaration({
      ...baseDecl,
      tunable_params: { x: { ...numericSpec, ui_help: '' } },
    });
    expect(issues.some((m) => /ui_help.*non-empty string/.test(m))).toBe(true);
  });

  it('rejects unrecognized unit', () => {
    const issues = validateEnrichmentDeclaration({
      ...baseDecl,
      tunable_params: {
        x: { ...numericSpec, unit: 'weeks' as 'days' },
      },
    });
    expect(issues.some((m) => /unit.*must be one of/.test(m))).toBe(true);
  });

  it('accepts spec with unit omitted (unit is optional)', () => {
    const { unit: _unit, ...withoutUnit } = numericSpec;
    void _unit;
    expect(
      validateEnrichmentDeclaration({
        ...baseDecl,
        tunable_params: { x: withoutUnit as EnrichmentTunableParamSpec },
      }),
    ).toEqual([]);
  });

  it('rejects unknown kind discriminator', () => {
    const issues = validateEnrichmentDeclaration({
      ...baseDecl,
      tunable_params: {
        x: {
          kind: 'string' as 'number',
          default: 'hello' as unknown as number,
          min: 0,
          max: 10,
          ui_label: 'X',
          ui_help: 'help',
        },
      },
    });
    expect(issues.some((m) => /kind' must be 'number' or 'enum'/.test(m))).toBe(true);
  });

  it('rejects non-object tunable_params value', () => {
    const issues = validateEnrichmentDeclaration({
      ...baseDecl,
      tunable_params: 'bad' as unknown as Record<string, EnrichmentTunableParamSpec>,
    });
    expect(issues.some((m) => /tunable_params' must be a plain object/.test(m))).toBe(true);
  });

  it('aggregates issues across multiple invalid specs', () => {
    const issues = validateEnrichmentDeclaration({
      ...baseDecl,
      tunable_params: {
        '1bad': numericSpec,
        ok_param: { ...numericSpec, default: 9999 },
        another: { ...enumSpec, default: 'missing' },
      },
    });
    expect(issues.length).toBeGreaterThanOrEqual(3);
  });
});

// ────────────────────────────────────────────────────────────────
// computeProducerVersionHash — tunable_params_hash slot
// ────────────────────────────────────────────────────────────────

describe('computeProducerVersionHash — tunable_params_hash backward compat', () => {
  it('absent tunable_params_hash matches pre-amendment 5-field composition byte-for-byte', () => {
    const without = computeProducerVersionHash(baseHashInput);
    const withEmpty = computeProducerVersionHash({
      ...baseHashInput,
      tunable_params_hash: '',
    });
    expect(without).toBe(withEmpty);
  });

  it('non-empty tunable_params_hash flips the composed hash', () => {
    const baseline = computeProducerVersionHash(baseHashInput);
    const tuned = computeProducerVersionHash({
      ...baseHashInput,
      tunable_params_hash: 'fnv1a:cafebabe',
    });
    expect(tuned).not.toBe(baseline);
  });

  it('two different tunable_params_hash values produce different composed hashes', () => {
    const a = computeProducerVersionHash({
      ...baseHashInput,
      tunable_params_hash: 'fnv1a:aaaaaaaa',
    });
    const b = computeProducerVersionHash({
      ...baseHashInput,
      tunable_params_hash: 'fnv1a:bbbbbbbb',
    });
    expect(a).not.toBe(b);
  });

  it('same tunable_params_hash produces identical composed hashes (determinism)', () => {
    const a = computeProducerVersionHash({
      ...baseHashInput,
      tunable_params_hash: 'fnv1a:deadbeef',
    });
    const b = computeProducerVersionHash({
      ...baseHashInput,
      tunable_params_hash: 'fnv1a:deadbeef',
    });
    expect(a).toBe(b);
  });

  it('still returns the canonical fnv1a:<8-hex> shape', () => {
    const hash = computeProducerVersionHash({
      ...baseHashInput,
      tunable_params_hash: 'fnv1a:12345678',
    });
    expect(hash).toMatch(/^fnv1a:[0-9a-f]{8}$/);
  });
});
