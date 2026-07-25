/** D-128 Phase 4 — Vendor-entity registry tests.
 *
 *  Covers:
 *  - `CONNECTION_VENDOR_ENTITIES` ships empty at D-128.
 *  - `getVendorEntityForScope` / `getVendorEntityByVendorEntity`
 *    semantics across registered + unregistered + closed-list scopes.
 *  - `assertConnectionVendorEntityShape` rejects malformed entries.
 *  - `assertConnectionVendorRegistry` catches duplicate scopes.
 *  - `buildConnectionVendorEntity` factory round-trips + throws.
 *  - The three reserved cross-vendor topics
 *    (`deal_health_score`, `deal_velocity_signal`,
 *    `engagement_score_per_contact`) are registered with platform-
 *    reference `valid_scopes` and accept canonical values. */

import { describe, expect, it } from 'vitest';

import {
  CONNECTION_VENDOR_ENTITIES,
  ENRICHMENT_REGISTRY,
  assertConnectionVendorEntityShape,
  assertConnectionVendorEntityValid,
  assertConnectionVendorRegistry,
  buildConnectionVendorEntity,
  composeVendorEntityScope,
  enrichmentTopicsForScope,
  getEnrichmentDefinition,
  getVendorEntityByVendorEntity,
  getVendorEntityForScope,
  isPlatformReferenceScope,
  listRegisteredVendors,
  type ConnectionVendorEntity,
  type DealHealthScoreValue,
  type DealVelocitySignalValue,
  type EngagementScorePerContactValue,
  type EnrichmentScope,
} from '../index.js';

// ────────────────────────────────────────────────────────────────
// Empty default registry
// ────────────────────────────────────────────────────────────────

describe('D-128 P4 — CONNECTION_VENDOR_ENTITIES default', () => {
  it('passes the registry-level shape check (D-129 P2 populated)', () => {
    expect(assertConnectionVendorRegistry(CONNECTION_VENDOR_ENTITIES)).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// Lookup helpers
// ────────────────────────────────────────────────────────────────

const sampleEntry: ConnectionVendorEntity = buildConnectionVendorEntity({
  vendor: 'hubspot',
  entity: 'deal',
  display_name: 'HubSpot Deal',
  meta_fields: [
    { key: 'name', type: 'string', description: 'Deal name as shown in HubSpot.' },
    { key: 'amount', type: 'number', description: 'Deal amount in USD.' },
    { key: 'key_dates.close_date', type: 'date_ms', description: 'Expected close date.' },
  ],
});

describe('D-128 P4 — getVendorEntityForScope', () => {
  it('returns null on closed-list scopes', () => {
    expect(getVendorEntityForScope('mail')).toBeNull();
    expect(getVendorEntityForScope('contact')).toBeNull();
    expect(getVendorEntityForScope('connection.api')).toBeNull();
  });

  it('returns null on unregistered platform-reference scopes', () => {
    expect(
      getVendorEntityForScope('connection.api.unknownvendor.foo' as EnrichmentScope, [sampleEntry]),
    ).toBeNull();
  });

  it('returns the matching entry from a custom registry', () => {
    const found = getVendorEntityForScope(sampleEntry.scope, [sampleEntry]);
    expect(found).toBe(sampleEntry);
  });

  it('round-trips through composeVendorEntityScope', () => {
    const scope = composeVendorEntityScope('hubspot', 'deal');
    expect(getVendorEntityForScope(scope, [sampleEntry])).toBe(sampleEntry);
  });
});

describe('D-128 P4 — getVendorEntityByVendorEntity', () => {
  it('returns the matching entry by (vendor, entity)', () => {
    expect(getVendorEntityByVendorEntity('hubspot', 'deal', [sampleEntry])).toBe(sampleEntry);
  });

  it('returns null for unregistered combinations', () => {
    expect(getVendorEntityByVendorEntity('hubspot', 'contact', [sampleEntry])).toBeNull();
    expect(getVendorEntityByVendorEntity('salesforce', 'deal', [sampleEntry])).toBeNull();
  });
});

describe('D-128 P4 — listRegisteredVendors collapses duplicates', () => {
  it('returns each vendor once across multiple entity entries', () => {
    const dealEntry = sampleEntry;
    const contactEntry = buildConnectionVendorEntity({
      vendor: 'hubspot',
      entity: 'contact',
      display_name: 'HubSpot Contact',
      meta_fields: [
        { key: 'name', type: 'string', description: 'Contact full name.' },
      ],
    });
    const sfEntry = buildConnectionVendorEntity({
      vendor: 'salesforce',
      entity: 'opportunity',
      display_name: 'Salesforce Opportunity',
      meta_fields: [
        { key: 'name', type: 'string', description: 'Opportunity name.' },
      ],
    });
    expect(listRegisteredVendors([dealEntry, contactEntry, sfEntry])).toEqual([
      'hubspot', 'salesforce',
    ]);
  });
});

// ────────────────────────────────────────────────────────────────
// Shape validation
// ────────────────────────────────────────────────────────────────

describe('D-128 P4 — assertConnectionVendorEntityShape', () => {
  it('passes a well-formed entry', () => {
    expect(assertConnectionVendorEntityShape(sampleEntry)).toEqual([]);
  });

  it('rejects non-object entries', () => {
    expect(assertConnectionVendorEntityShape(null)).toEqual(['expected object']);
    expect(assertConnectionVendorEntityShape('hubspot.deal')).toEqual(['expected object']);
    expect(assertConnectionVendorEntityShape([sampleEntry])).toEqual(['expected object']);
  });

  it('rejects vendor / entity that don\'t match the identifier regex', () => {
    const bad = { ...sampleEntry, vendor: 'HubSpot' };
    const issues = assertConnectionVendorEntityShape(bad);
    expect(issues.some((i) => i.includes("'vendor'"))).toBe(true);
  });

  it('rejects scope-vs-(vendor, entity) mismatches', () => {
    const bad: ConnectionVendorEntity = {
      vendor: 'hubspot',
      entity: 'deal',
      scope: 'connection.api.salesforce.opportunity', // mismatched
      display_name: 'x',
      meta_fields: [],
    };
    const issues = assertConnectionVendorEntityShape(bad);
    expect(issues.some((i) => i.includes('does not match composeVendorEntityScope'))).toBe(true);
  });

  it('rejects malformed meta_field types', () => {
    const bad: unknown = {
      ...sampleEntry,
      meta_fields: [{ key: 'name', type: 'unknown_type', description: 'x' }],
    };
    const issues = assertConnectionVendorEntityShape(bad);
    expect(issues.some((i) => i.includes('meta_fields[0].type'))).toBe(true);
  });

  it('accepts a valid date_granularity on a date_ms field but rejects a bad value / wrong type (G2)', () => {
    const good: unknown = {
      ...sampleEntry,
      meta_fields: [{ key: 'closed', type: 'date_ms', date_granularity: 'date', description: 'x' }],
    };
    expect(assertConnectionVendorEntityShape(good)).toEqual([]);

    const badValue: unknown = {
      ...sampleEntry,
      meta_fields: [{ key: 'closed', type: 'date_ms', date_granularity: 'day', description: 'x' }],
    };
    expect(assertConnectionVendorEntityShape(badValue).some((i) => i.includes("date_granularity must be 'date' or 'datetime'"))).toBe(true);

    const wrongType: unknown = {
      ...sampleEntry,
      meta_fields: [{ key: 'amount', type: 'number', date_granularity: 'date', description: 'x' }],
    };
    expect(assertConnectionVendorEntityShape(wrongType).some((i) => i.includes("date_granularity is only valid on a 'date_ms' field"))).toBe(true);
  });

  it('rejects duplicate meta_field keys', () => {
    const bad = buildableInputWithDup();
    const issues = assertConnectionVendorEntityShape(bad);
    expect(issues.some((i) => i.includes('duplicates an earlier entry'))).toBe(true);
  });

  it('accepts dotted meta_field keys (nested fields)', () => {
    const ok: ConnectionVendorEntity = {
      vendor: 'hubspot',
      entity: 'deal',
      scope: 'connection.api.hubspot.deal',
      display_name: 'HubSpot Deal',
      meta_fields: [
        { key: 'key_dates.close_date', type: 'date_ms', description: 'x' },
      ],
    };
    expect(assertConnectionVendorEntityShape(ok)).toEqual([]);
  });
});

const buildableInputWithDup = (): unknown => ({
  vendor: 'hubspot',
  entity: 'deal',
  scope: 'connection.api.hubspot.deal',
  display_name: 'HubSpot Deal',
  meta_fields: [
    { key: 'name', type: 'string', description: 'first' },
    { key: 'name', type: 'string', description: 'second' },
  ],
});

describe('D-128 P4 — assertConnectionVendorRegistry', () => {
  it('catches duplicate scopes across entries', () => {
    const a = sampleEntry;
    const b: ConnectionVendorEntity = { ...sampleEntry };
    const issues = assertConnectionVendorRegistry([a, b]);
    expect(issues.some((i) => i.includes('duplicate scope'))).toBe(true);
  });

  it('returns empty when registry is well-formed', () => {
    const a = sampleEntry;
    const b = buildConnectionVendorEntity({
      vendor: 'hubspot',
      entity: 'contact',
      display_name: 'HubSpot Contact',
      meta_fields: [{ key: 'email', type: 'string', description: 'x' }],
    });
    expect(assertConnectionVendorRegistry([a, b])).toEqual([]);
  });
});

describe('D-128 P4 — buildConnectionVendorEntity factory', () => {
  it('stamps the scope from vendor + entity', () => {
    expect(sampleEntry.scope).toBe('connection.api.hubspot.deal');
    expect(isPlatformReferenceScope(sampleEntry.scope)).toBe(true);
  });

  it('throws on a malformed input via assertConnectionVendorEntityValid', () => {
    expect(() =>
      buildConnectionVendorEntity({
        vendor: 'BAD',
        entity: 'deal',
        display_name: 'x',
        meta_fields: [],
      }),
    ).toThrow();
  });

  it('assertConnectionVendorEntityValid throws with all issues joined', () => {
    const bad: ConnectionVendorEntity = {
      vendor: 'hubspot',
      entity: 'deal',
      scope: 'connection.api.hubspot.contact', // mismatched
      display_name: '',
      meta_fields: [],
    };
    expect(() => assertConnectionVendorEntityValid(bad)).toThrow();
  });
});

// ────────────────────────────────────────────────────────────────
// Reserved topics — registry shape
// ────────────────────────────────────────────────────────────────

describe('D-128 P4 — reserved cross-vendor topics in ENRICHMENT_REGISTRY', () => {
  it('registers deal_health_score with platform-reference valid_scopes', () => {
    const def = getEnrichmentDefinition('deal_health_score');
    expect(def.shape).toBe('per_record');
    expect(def.policy).toBe('dependent');
    expect(def.producer_kind).toBe('housekeeping');
    // D-136 P1: emits_confidence revoked — deal_health_score is time_bound
    // (deal state moves), so PSI conflates real-world drift with model drift.
    expect(def.emits_confidence).toBeUndefined();
    expect(def.default_trust_state).toBe('manual');
    expect(def.valid_scopes).toContain('connection.api.hubspot.deal');
    expect(def.valid_scopes).toContain('connection.api.salesforce.opportunity');
  });

  it('registers deal_velocity_signal with aggregate policy + platform-reference valid_scopes', () => {
    const def = getEnrichmentDefinition('deal_velocity_signal');
    expect(def.shape).toBe('per_record');
    expect(def.policy).toBe('aggregate');
    expect(def.aggregates_from).toContain('connection.api.hubspot.deal');
    expect(def.recompute_cadence).toBe('24h');
    expect(def.valid_scopes).toContain('connection.api.hubspot.deal');
  });

  it('registers engagement_score_per_contact with mail + calendar + platform-reference aggregates_from', () => {
    const def = getEnrichmentDefinition('engagement_score_per_contact');
    expect(def.shape).toBe('per_record');
    expect(def.policy).toBe('aggregate');
    expect(def.aggregates_from).toEqual(
      expect.arrayContaining([
        'mail',
        'calendar',
        'connection.api.hubspot.contact',
        'connection.api.salesforce.contact',
      ]),
    );
  });

  it('enrichmentTopicsForScope surfaces deal_health_score on hubspot.deal scope', () => {
    const topics = enrichmentTopicsForScope('connection.api.hubspot.deal' as EnrichmentScope);
    expect(topics).toContain('deal_health_score');
    expect(topics).toContain('deal_velocity_signal');
  });

  it('enrichmentTopicsForScope returns empty for an unregistered platform-reference scope', () => {
    const topics = enrichmentTopicsForScope('connection.api.unknown.foo' as EnrichmentScope);
    expect(topics).toEqual([]);
  });

  it('all three reserved topics show up in ENRICHMENT_REGISTRY', () => {
    expect(ENRICHMENT_REGISTRY).toHaveProperty('deal_health_score');
    expect(ENRICHMENT_REGISTRY).toHaveProperty('deal_velocity_signal');
    expect(ENRICHMENT_REGISTRY).toHaveProperty('engagement_score_per_contact');
  });
});

// ────────────────────────────────────────────────────────────────
// Reserved topics — value schemas
// ────────────────────────────────────────────────────────────────

describe('D-128 P4 — reserved-topic value schemas', () => {
  it('DealHealthScore accepts a canonical value', () => {
    const def = getEnrichmentDefinition('deal_health_score');
    const value: DealHealthScoreValue = {
      score: 72,
      signals: ['email engagement', 'recent activity'],
      reasoning: 'Steady touch + meeting next week',
    };
    const result = def.value_schema(value);
    expect(result.ok).toBe(true);
  });

  it('DealHealthScore rejects out-of-range score', () => {
    const def = getEnrichmentDefinition('deal_health_score');
    const result = def.value_schema({ score: 150, signals: [], reasoning: 'x', confidence: 0.5 });
    expect(result.ok).toBe(false);
  });

  // D-136 P1: confidence field stripped from DealHealthScoreValue —
  // time_bound topics don't carry PSI-eligible confidence. The
  // "rejects out-of-range confidence" test was retired with the field.

  it('DealVelocitySignal accepts a canonical value', () => {
    const def = getEnrichmentDefinition('deal_velocity_signal');
    const value: DealVelocitySignalValue = {
      velocity: 'stalling',
      recent_activity_count: 1,
      days_in_stage: 47,
      cursor_at: 1730294400000,
    };
    const result = def.value_schema(value);
    expect(result.ok).toBe(true);
  });

  it('DealVelocitySignal rejects an unknown velocity literal', () => {
    const def = getEnrichmentDefinition('deal_velocity_signal');
    const result = def.value_schema({
      velocity: 'sprinting',
      recent_activity_count: 0,
      days_in_stage: 0,
      cursor_at: 0,
    });
    expect(result.ok).toBe(false);
  });

  it('EngagementScorePerContact accepts a canonical value', () => {
    const def = getEnrichmentDefinition('engagement_score_per_contact');
    const value: EngagementScorePerContactValue = {
      score: 88,
      last_meaningful_touch: 1730294400000,
      signal_breakdown: { hubspot: 40, local: 35, recency: 13 },
      trajectory: 'rising',
      cursor_at: 1730294400000,
    };
    const result = def.value_schema(value);
    expect(result.ok).toBe(true);
  });

  it('EngagementScorePerContact rejects negative score', () => {
    const def = getEnrichmentDefinition('engagement_score_per_contact');
    const result = def.value_schema({
      score: -1,
      last_meaningful_touch: 0,
      cursor_at: 0,
    });
    expect(result.ok).toBe(false);
  });
});
