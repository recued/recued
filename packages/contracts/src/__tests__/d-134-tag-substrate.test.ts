/** D-134 Phase 1 — tag substrate contracts tests.
 *
 *  Covers the four exported entry points:
 *    - `parseEnrichmentTag` — namespace/value split, whitespace strict
 *    - `assertEnrichmentTagShape` — open-vocabulary shape validator
 *    - `deriveStandardEnrichmentTags` — auto-derive from definition
 *    - `collectEnrichmentTags` — author + auto-derived merge, deduped
 *    - `computeHousekeepingMetaTags` — full meta-tag set including
 *       `surface:` and core-task `extraTags`
 *    - `assertRegistryTagShapes` — registry-wide validator
 *
 *  Spec: `docs/d-134-spec.md` §A.2 / §A.3. */

import { describe, expect, it } from 'vitest';

import {
  RECOMMENDED_TAG_NAMESPACES,
  parseEnrichmentTag,
  assertEnrichmentTagShape,
  assertRegistryTagShapes,
  deriveStandardEnrichmentTags,
  collectEnrichmentTags,
  computeHousekeepingMetaTags,
  type EnrichmentDefinition,
  type EnrichmentTag,
  type RecommendedTagNamespace,
} from '../index.js';

const FAKE_PER_RECORD_DEF: EnrichmentDefinition = {
  shape: 'per_record',
  valid_scopes: ['mail'],
  value_schema: () => ({ ok: false, issues: ['stub'] }),
  policy: 'dependent',
  producer_kind: 'housekeeping',
  temporal_class: 'stable_truth',
  identity_aggregation: 'scenario',
  lifecycle_policy: 'forward_only',
  // D-136 P3 follow-up — §A.14.2 required field on every EnrichmentDefinition.
  compression_class: 'derived',
  name: 'Fake',
  description: 'A test definition',
  user_value: 'Use this for tests.',
  tags: ['platform:hubspot', 'department:sales'],
};

const FAKE_DERIVED_ENTITY_DEF: EnrichmentDefinition = {
  shape: 'derived_entity',
  value_schema: () => ({ ok: false, issues: ['stub'] }),
  policy: 'independent',
  producer_kind: 'housekeeping',
  temporal_class: 'stable_truth',
  identity_aggregation: 'scenario',
  lifecycle_policy: 'forward_only',
  compression_class: 'derived',
  name: 'Fake-DE',
  description: 'A test derived-entity definition',
  user_value: 'Use this for tests.',
};

const FAKE_CONNECTION_TRIO_DEF: EnrichmentDefinition = {
  shape: 'per_record',
  valid_scopes: ['connection.api', 'connection.mcp', 'connection.notification'],
  value_schema: () => ({ ok: false, issues: ['stub'] }),
  policy: 'aggregate',
  aggregates_from: ['memory'],
  producer_kind: 'housekeeping',
  temporal_class: 'aggregate_window',
  identity_aggregation: 'scenario',
  lifecycle_policy: 'recompute_on_drift',
  as_of_field: 'computed_at',
  aggregate_window_axis: 'ingestion_time',
  inputFingerprintComposition: 'aggregate_window_fold',
  compression_class: 'derived',
  name: 'Fake-Trio',
  description: 'Connection-spanning test definition',
  user_value: 'Use this for tests.',
};

describe('D-134 tag substrate — RECOMMENDED_TAG_NAMESPACES', () => {
  it('contains the eight conventional namespaces', () => {
    expect(RECOMMENDED_TAG_NAMESPACES).toEqual([
      'surface',
      'domain',
      'policy',
      'shape',
      'kind',
      'platform',
      'industry',
      'department',
    ]);
  });

  it('typed as RecommendedTagNamespace literal union', () => {
    const platform: RecommendedTagNamespace = 'platform';
    const department: RecommendedTagNamespace = 'department';
    expect(platform).toBe('platform');
    expect(department).toBe('department');
  });
});

describe('D-134 tag substrate — parseEnrichmentTag', () => {
  it('splits valid <namespace>:<value> tags', () => {
    expect(parseEnrichmentTag('platform:hubspot')).toEqual({
      namespace: 'platform',
      value: 'hubspot',
    });
    expect(parseEnrichmentTag('department:hr')).toEqual({
      namespace: 'department',
      value: 'hr',
    });
  });

  it('accepts colons in the value half', () => {
    expect(parseEnrichmentTag('use_case:bounce-vector:v2')).toEqual({
      namespace: 'use_case',
      value: 'bounce-vector:v2',
    });
  });

  it('rejects strings with no separator', () => {
    expect(parseEnrichmentTag('hubspot')).toBeNull();
  });

  it('rejects empty namespace half', () => {
    expect(parseEnrichmentTag(':hubspot')).toBeNull();
  });

  it('rejects empty value half', () => {
    expect(parseEnrichmentTag('platform:')).toBeNull();
  });

  it('rejects whitespace bordering the separator', () => {
    expect(parseEnrichmentTag('platform :hubspot')).toBeNull();
    expect(parseEnrichmentTag('platform: hubspot')).toBeNull();
    expect(parseEnrichmentTag(' platform:hubspot')).toBeNull();
    expect(parseEnrichmentTag('platform:hubspot ')).toBeNull();
  });

  it('rejects empty strings', () => {
    expect(parseEnrichmentTag('')).toBeNull();
  });

  it('rejects non-string input via type guard runtime', () => {
    expect(parseEnrichmentTag(undefined as unknown as string)).toBeNull();
  });
});

describe('D-134 tag substrate — assertEnrichmentTagShape', () => {
  it('returns empty array for valid tags', () => {
    expect(assertEnrichmentTagShape('platform:hubspot')).toEqual([]);
    expect(assertEnrichmentTagShape('department:hr')).toEqual([]);
    expect(assertEnrichmentTagShape('industry:saas')).toEqual([]);
  });

  it('returns one issue for malformed tags', () => {
    const issues = assertEnrichmentTagShape('hubspot');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('<namespace>:<value>');
  });

  it('flags non-string inputs', () => {
    expect(assertEnrichmentTagShape(42 as unknown as string)).toEqual(['tag must be a string']);
    expect(assertEnrichmentTagShape({} as unknown as string)).toEqual(['tag must be a string']);
  });

  it('flags empty strings', () => {
    expect(assertEnrichmentTagShape('')).toEqual(['tag is empty']);
  });
});

describe('D-134 tag substrate — deriveStandardEnrichmentTags', () => {
  it('derives domain / policy / shape / kind for Shape A definition', () => {
    const tags = deriveStandardEnrichmentTags(FAKE_PER_RECORD_DEF);
    expect(tags).toEqual([
      'domain:mail',
      'policy:dependent',
      'shape:per_record',
      'kind:housekeeping',
    ]);
  });

  it('omits domain for Shape B (no valid_scopes)', () => {
    const tags = deriveStandardEnrichmentTags(FAKE_DERIVED_ENTITY_DEF);
    expect(tags).toEqual([
      'policy:independent',
      'shape:derived_entity',
      'kind:housekeeping',
    ]);
  });

  it('collapses connection.* trio into single domain:connection tag', () => {
    const tags = deriveStandardEnrichmentTags(FAKE_CONNECTION_TRIO_DEF);
    expect(tags).toEqual([
      'domain:connection',
      'policy:aggregate',
      'shape:per_record',
      'kind:housekeeping',
    ]);
  });

  it('does NOT include surface: tag (instance-only)', () => {
    const tags = deriveStandardEnrichmentTags(FAKE_PER_RECORD_DEF);
    expect(tags.some((t) => t.startsWith('surface:'))).toBe(false);
  });

  it('returns multiple domain tags when valid_scopes spans collections', () => {
    const def: EnrichmentDefinition = {
      ...FAKE_PER_RECORD_DEF,
      valid_scopes: ['mail', 'calendar'],
    };
    const tags = deriveStandardEnrichmentTags(def);
    expect(tags).toContain('domain:mail');
    expect(tags).toContain('domain:calendar');
  });

  it('sorts multi-domain output alphabetically for stability', () => {
    const def: EnrichmentDefinition = {
      ...FAKE_PER_RECORD_DEF,
      valid_scopes: ['mail', 'contact', 'calendar'],
    };
    const tags = deriveStandardEnrichmentTags(def);
    const domainTags = tags.filter((t) => t.startsWith('domain:'));
    expect(domainTags).toEqual(['domain:calendar', 'domain:contact', 'domain:mail']);
  });
});

describe('D-134 tag substrate — collectEnrichmentTags', () => {
  it('merges author tags first, then auto-derived', () => {
    const tags = collectEnrichmentTags(FAKE_PER_RECORD_DEF);
    expect(tags).toEqual([
      'platform:hubspot',
      'department:sales',
      'domain:mail',
      'policy:dependent',
      'shape:per_record',
      'kind:housekeeping',
    ]);
  });

  it('dedupes when author tag duplicates an auto-derived one', () => {
    const def: EnrichmentDefinition = {
      ...FAKE_PER_RECORD_DEF,
      tags: ['policy:dependent', 'platform:hubspot'],
    };
    const tags = collectEnrichmentTags(def);
    expect(tags.filter((t) => t === 'policy:dependent')).toHaveLength(1);
    expect(tags[0]).toBe('policy:dependent'); // author tag first
  });

  it('returns auto-derived only when def.tags omitted', () => {
    const def: EnrichmentDefinition = { ...FAKE_PER_RECORD_DEF, tags: undefined };
    const tags = collectEnrichmentTags(def);
    expect(tags).toEqual([
      'domain:mail',
      'policy:dependent',
      'shape:per_record',
      'kind:housekeeping',
    ]);
  });
});

describe('D-134 tag substrate — computeHousekeepingMetaTags', () => {
  it('stamps surface:ai when isAiSurface=true', () => {
    const tags = computeHousekeepingMetaTags({
      def: FAKE_PER_RECORD_DEF,
      isAiSurface: true,
    });
    expect(tags).toContain('surface:ai');
    expect(tags).not.toContain('surface:deterministic');
  });

  it('stamps surface:deterministic when isAiSurface=false', () => {
    const tags = computeHousekeepingMetaTags({
      def: FAKE_PER_RECORD_DEF,
      isAiSurface: false,
    });
    expect(tags).toContain('surface:deterministic');
    expect(tags).not.toContain('surface:ai');
  });

  it('omits surface: when isAiSurface is undefined', () => {
    const tags = computeHousekeepingMetaTags({
      def: FAKE_PER_RECORD_DEF,
    });
    expect(tags.some((t) => t.startsWith('surface:'))).toBe(false);
  });

  it('honours extraTags first in the stable order', () => {
    const tags = computeHousekeepingMetaTags({
      extraTags: ['kind:core', 'domain:audit', 'surface:deterministic'],
    });
    expect(tags).toEqual(['kind:core', 'domain:audit', 'surface:deterministic']);
  });

  it('extraTags + def + surface compose in expected order', () => {
    const tags = computeHousekeepingMetaTags({
      extraTags: ['platform:internal'],
      def: FAKE_PER_RECORD_DEF,
      isAiSurface: true,
    });
    expect(tags).toEqual([
      'platform:internal',     // extraTags first
      'platform:hubspot',      // def.tags
      'department:sales',
      'domain:mail',           // auto-derived
      'policy:dependent',
      'shape:per_record',
      'kind:housekeeping',
      'surface:ai',            // surface stamp last
    ]);
  });

  it('dedupes across extraTags / def.tags / auto-derived / surface', () => {
    const tags = computeHousekeepingMetaTags({
      extraTags: ['domain:mail' as EnrichmentTag, 'platform:hubspot' as EnrichmentTag],
      def: FAKE_PER_RECORD_DEF,
      isAiSurface: true,
    });
    expect(tags.filter((t) => t === 'domain:mail')).toHaveLength(1);
    expect(tags.filter((t) => t === 'platform:hubspot')).toHaveLength(1);
  });
});

describe('D-134 tag substrate — assertRegistryTagShapes', () => {
  it('the live ENRICHMENT_REGISTRY passes shape validation', () => {
    // Pre-D-134 entries have no `tags` field — validator returns [].
    // Post-D-134 P3 backfill, every author-declared tag must conform.
    expect(assertRegistryTagShapes()).toEqual([]);
  });
});
