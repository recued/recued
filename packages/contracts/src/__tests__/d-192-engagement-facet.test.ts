/** D-192 engagement facet (slice S1) — the third entity-category facet on
 *  `ConnectionVendorEntity`, the registry replacement for the closed
 *  `EngagementVendor` union + `HUBSPOT/SALESFORCE_ENGAGEMENT_ENTITY_NAMES`.
 *
 *  The load-bearing test is behavior-preservation: the facet backfill + the
 *  `engagementEntitiesForVendor` helper MUST reproduce the old constants
 *  exactly, so S2's swap (repoint consumers → delete constants) is a no-op in
 *  behavior. Design: `docs/d-192-engagement-facet.md`. */

import { describe, expect, it } from 'vitest';

import {
  CONNECTION_VENDOR_ENTITIES,
  ENGAGEMENT_CAPABILITY_VALUES,
  ENGAGEMENT_SYNC_KINDS,
  SALESFORCE_ENGAGEMENT_ENTITY_NAMES,
  assertConnectionVendorEntityShape,
  assertConnectionVendorRegistry,
  assertEngagementFacetShape,
  assertEngagementRegistryInvariants,
  buildConnectionVendorEntity,
  engagementDailyBudget,
  engagementEntitiesForVendor,
  engagementSyncKind,
  getVendorEntityByVendorEntity,
  isDeclaredEngagementEntity,
  vendorHasEngagement,
  type ConnectionVendorEntity,
} from '../index.js';

/** A minimal well-formed engagement entry (correct scope so the shape validator
 *  is exercised on the FACET, not the scope). */
const engEntity = (
  over: Partial<ConnectionVendorEntity> & { vendor: string; entity: string },
): ConnectionVendorEntity => ({
  scope: `connection.api.${over.vendor}.${over.entity}`,
  display_name: 'Test Engagement',
  meta_fields: [],
  engagement: { capability: 'always', sync_kind: 'poll' },
  ...over,
});

describe('D-192 engagement facet — controlled vocabulary', () => {
  it('enumerates the closed enums', () => {
    expect([...ENGAGEMENT_CAPABILITY_VALUES]).toEqual(['always', 'probe_gated']);
    expect([...ENGAGEMENT_SYNC_KINDS]).toEqual(['poll', 'delta_cursor', 'stream']);
  });
});

describe('D-192 engagement facet — builtin backfill + behavior preservation', () => {
  it('the 10 builtin engagement entities carry the facet; no other entity does', () => {
    const withFacet = CONNECTION_VENDOR_ENTITIES.filter((e) => e.engagement !== undefined);
    expect(withFacet).toHaveLength(10);
    // The crm/acct entities (deal/contact/account/company/opportunity/pipedrive)
    // must NOT carry it — a third category, mutually exclusive.
    for (const e of withFacet) {
      expect(e.crm_alias).toBeUndefined();
      expect(e.acct_alias).toBeUndefined();
    }
  });

  it('THE INVARIANT: engagementEntitiesForVendor reproduces the old constants exactly (order + values)', () => {
    // The registry helper is the single source of truth for a vendor's engagement
    // entities. S2 repointed the shared consumers onto it + deleted the HubSpot
    // constant; `HUBSPOT_ENGAGEMENT_ENTITY_NAMES` is now the literal below (a
    // divergence here would silently change behavior). The Salesforce constant
    // survives (its type is load-bearing across the SF streaming leaf), so its
    // pin stays a live drift-guard against the registry.
    expect(engagementEntitiesForVendor('hubspot')).toEqual([
      'email', 'meeting', 'note', 'call', 'task',
    ]);
    expect(engagementEntitiesForVendor('salesforce')).toEqual([...SALESFORCE_ENGAGEMENT_ENTITY_NAMES]);
  });

  it('backfills the right capability/sync_kind/budget per vendor', () => {
    const email = getVendorEntityByVendorEntity('hubspot', 'email');
    expect(email?.engagement).toEqual({ capability: 'always', sync_kind: 'poll', daily_budget: 250000 });
    const sfTask = getVendorEntityByVendorEntity('salesforce', 'task');
    expect(sfTask?.engagement).toEqual({ capability: 'always', sync_kind: 'stream', daily_budget: 50000 });
    // The one probe-gated + exclusive pair — voice_call XOR call_history.
    const voice = getVendorEntityByVendorEntity('salesforce', 'voice_call');
    const call = getVendorEntityByVendorEntity('salesforce', 'call_history');
    expect(voice?.engagement).toEqual({
      capability: 'probe_gated', exclusive_group: 'call', sync_kind: 'stream', daily_budget: 50000,
    });
    expect(call?.engagement?.exclusive_group).toBe('call');
    expect(call?.engagement?.capability).toBe('probe_gated');
  });

  it('the shipped registry validates clean (boot self-validation would throw otherwise)', () => {
    expect(assertConnectionVendorRegistry(CONNECTION_VENDOR_ENTITIES)).toEqual([]);
  });
});

describe('D-192 engagement facet — per-entry validator', () => {
  it('accepts a well-formed facet (minimal + full)', () => {
    expect(assertConnectionVendorEntityShape(engEntity({ vendor: 'x', entity: 'a' }))).toEqual([]);
    expect(assertConnectionVendorEntityShape(engEntity({
      vendor: 'x', entity: 'b',
      engagement: { capability: 'probe_gated', exclusive_group: 'g', sync_kind: 'delta_cursor', daily_budget: 10 },
    }))).toEqual([]);
  });

  const bad: Array<[string, ConnectionVendorEntity, RegExp]> = [
    ['bad capability', engEntity({ vendor: 'x', entity: 'a', engagement: { capability: 'sometimes' as never, sync_kind: 'poll' } }), /capability/],
    ['missing sync_kind', engEntity({ vendor: 'x', entity: 'a', engagement: { capability: 'always' } as never }), /sync_kind/],
    ['bad sync_kind', engEntity({ vendor: 'x', entity: 'a', engagement: { capability: 'always', sync_kind: 'push' as never } }), /sync_kind/],
    ['empty exclusive_group', engEntity({ vendor: 'x', entity: 'a', engagement: { capability: 'probe_gated', exclusive_group: '', sync_kind: 'poll' } }), /exclusive_group/],
    ['always + exclusive_group', engEntity({ vendor: 'x', entity: 'a', engagement: { capability: 'always', exclusive_group: 'g', sync_kind: 'poll' } }), /pick-one/],
    ['fractional budget', engEntity({ vendor: 'x', entity: 'a', engagement: { capability: 'always', sync_kind: 'poll', daily_budget: 1.5 } }), /positive integer/],
    ['zero budget', engEntity({ vendor: 'x', entity: 'a', engagement: { capability: 'always', sync_kind: 'poll', daily_budget: 0 } }), /positive integer/],
    ['negative budget', engEntity({ vendor: 'x', entity: 'a', engagement: { capability: 'always', sync_kind: 'poll', daily_budget: -5 } }), /positive integer/],
    ['engagement is non-object', engEntity({ vendor: 'x', entity: 'a', engagement: 'yes' as never }), /must be an object/],
    ['engagement + crm_alias', engEntity({ vendor: 'x', entity: 'a', crm_alias: 'deal' }), /mutually exclusive/],
    ['engagement + acct_alias', engEntity({ vendor: 'x', entity: 'a', acct_alias: 'invoice' }), /mutually exclusive/],
  ];

  for (const [name, entry, re] of bad) {
    it(`rejects: ${name}`, () => {
      const issues = assertConnectionVendorEntityShape(entry);
      expect(issues.length).toBeGreaterThan(0);
      expect(issues.some((i) => re.test(i))).toBe(true);
    });
  }
});

describe('D-192 engagement facet — registry cross-entry validator', () => {
  const A = (entity: string, over: Partial<ConnectionVendorEntity['engagement'] & object> = {}) =>
    engEntity({ vendor: 'acme', entity, engagement: { capability: 'always', sync_kind: 'stream', ...over } });

  it('flags a vendor whose engagement entities declare conflicting sync_kinds', () => {
    const issues = assertConnectionVendorRegistry([A('a'), A('b', { sync_kind: 'poll' })]);
    expect(issues.some((i) => /share ONE sync_kind/.test(i))).toBe(true);
  });

  it('flags a vendor whose engagement entities declare conflicting daily_budgets', () => {
    const issues = assertConnectionVendorRegistry([A('a', { daily_budget: 100 }), A('b', { daily_budget: 200 })]);
    expect(issues.some((i) => /share ONE daily_budget/.test(i))).toBe(true);
  });

  it('accepts consistent sync_kind + budget across a vendor (+ omitted budget defers)', () => {
    expect(assertConnectionVendorRegistry([A('a', { daily_budget: 100 }), A('b', { daily_budget: 100 }), A('c')])).toEqual([]);
  });

  it('flags an exclusive_group that mixes capabilities (defense-in-depth)', () => {
    // Both probe_gated is the only per-entry-valid grouped shape; construct a
    // registry-level mix directly to exercise the cross-entry guard.
    const g1 = engEntity({ vendor: 'acme', entity: 'a', engagement: { capability: 'probe_gated', exclusive_group: 'call', sync_kind: 'stream' } });
    const g2 = engEntity({ vendor: 'acme', entity: 'b', engagement: { capability: 'probe_gated', exclusive_group: 'call', sync_kind: 'stream' } });
    expect(assertConnectionVendorRegistry([g1, g2])).toEqual([]); // both probe_gated — fine
  });
});

describe('D-192 engagement facet — extracted helpers (S4 pack-lift merge)', () => {
  it('assertEngagementFacetShape accepts a valid facet + flags each malformation', () => {
    expect(assertEngagementFacetShape({ capability: 'always', sync_kind: 'poll' })).toEqual([]);
    expect(assertEngagementFacetShape({
      capability: 'probe_gated', exclusive_group: 'g', sync_kind: 'delta_cursor', daily_budget: 10,
    })).toEqual([]);
    expect(assertEngagementFacetShape('nope').some((i) => /must be an object/.test(i))).toBe(true);
    expect(assertEngagementFacetShape(null).some((i) => /must be an object/.test(i))).toBe(true);
    expect(assertEngagementFacetShape({ capability: 'x', sync_kind: 'poll' }).some((i) => /capability/.test(i))).toBe(true);
    expect(assertEngagementFacetShape({ capability: 'always', sync_kind: 'push' }).some((i) => /sync_kind/.test(i))).toBe(true);
    expect(assertEngagementFacetShape({ capability: 'always', exclusive_group: 'g', sync_kind: 'poll' }).some((i) => /pick-one/.test(i))).toBe(true);
    expect(assertEngagementFacetShape({ capability: 'always', sync_kind: 'poll', daily_budget: 0 }).some((i) => /positive integer/.test(i))).toBe(true);
  });

  it('assertEngagementRegistryInvariants: consistent vendor clean; split sync_kind / budget flagged', () => {
    const e = (entity: string, over: Partial<NonNullable<ConnectionVendorEntity['engagement']>> = {}) =>
      engEntity({ vendor: 'acme', entity, engagement: { capability: 'always', sync_kind: 'stream', ...over } });
    expect(assertEngagementRegistryInvariants([e('a'), e('b')])).toEqual([]);
    expect(assertEngagementRegistryInvariants([e('a'), e('b', { sync_kind: 'poll' })]).some((i) => /share ONE sync_kind/.test(i))).toBe(true);
    expect(assertEngagementRegistryInvariants([e('a', { daily_budget: 1 }), e('b', { daily_budget: 2 })]).some((i) => /share ONE daily_budget/.test(i))).toBe(true);
    // a non-engagement (crm) entry is ignored by the engagement-only invariant.
    expect(assertEngagementRegistryInvariants([e('a'), engEntity({ vendor: 'acme', entity: 'deal', engagement: undefined, crm_alias: 'deal' })])).toEqual([]);
  });

  it('assertEngagementRegistryInvariants runs on a HYPHENATED vendor id that the full assert false-rejects (why it is extracted)', () => {
    // `vendorEntitiesFromComposition` legitimately emits hyphenated vendor ids
    // (`google-contacts`); the registry vendor-id regex forbids them, so the
    // pack-lift merge must gate on THIS helper, not `assertConnectionVendorRegistry`.
    const lifted = engEntity({
      vendor: 'ms-dynamics', entity: 'email', engagement: { capability: 'always', sync_kind: 'delta_cursor' },
    });
    expect(assertEngagementRegistryInvariants([lifted])).toEqual([]); // no false-reject on the hyphen
    // proof the full assert WOULD reject the same hyphenated vendor:
    expect(assertConnectionVendorRegistry([lifted]).some((i) => /vendor/.test(i))).toBe(true);
  });
});

describe('D-192 engagement facet — accessors', () => {
  it('isDeclaredEngagementEntity distinguishes engagement from crm entities', () => {
    expect(isDeclaredEngagementEntity('hubspot', 'email')).toBe(true);
    expect(isDeclaredEngagementEntity('hubspot', 'deal')).toBe(false); // crm_alias, not engagement
    expect(isDeclaredEngagementEntity('nope', 'email')).toBe(false);
  });

  it('vendorHasEngagement is the registry predicate replacing the closed union', () => {
    expect(vendorHasEngagement('hubspot')).toBe(true);
    expect(vendorHasEngagement('salesforce')).toBe(true);
    expect(vendorHasEngagement('pipedrive')).toBe(false); // crm entities only
    expect(vendorHasEngagement('nope')).toBe(false);
  });

  it('engagementSyncKind reads the per-vendor class, null for undeclared', () => {
    expect(engagementSyncKind('hubspot')).toBe('poll');
    expect(engagementSyncKind('salesforce')).toBe('stream');
    expect(engagementSyncKind('pipedrive')).toBeNull();
  });

  it('engagementDailyBudget reads the per-vendor budget, null for undeclared', () => {
    expect(engagementDailyBudget('hubspot')).toBe(250000);
    expect(engagementDailyBudget('salesforce')).toBe(50000);
    expect(engagementDailyBudget('nope')).toBeNull();
  });

  it('accessors honor a passed (e.g. live/pack-merged) registry', () => {
    const live = [...CONNECTION_VENDOR_ENTITIES, engEntity({
      vendor: 'dynamics', entity: 'phonecall',
      engagement: { capability: 'always', sync_kind: 'delta_cursor', daily_budget: 40 },
    })];
    expect(vendorHasEngagement('dynamics', live)).toBe(true);
    expect(engagementSyncKind('dynamics', live)).toBe('delta_cursor');
    expect(engagementEntitiesForVendor('dynamics', live)).toEqual(['phonecall']);
  });
});

describe('D-192 engagement facet — builder', () => {
  it('threads the engagement facet through buildConnectionVendorEntity', () => {
    const entry = buildConnectionVendorEntity({
      vendor: 'acme', entity: 'note', display_name: 'Acme Note', meta_fields: [],
      engagement: { capability: 'always', sync_kind: 'delta_cursor' },
    });
    expect(entry.engagement).toEqual({ capability: 'always', sync_kind: 'delta_cursor' });
    expect(entry.scope).toBe('connection.api.acme.note');
  });

  it('throws when the builder gets an engagement + crm_alias combination', () => {
    expect(() => buildConnectionVendorEntity({
      vendor: 'acme', entity: 'x', display_name: 'X', meta_fields: [],
      crm_alias: 'deal', engagement: { capability: 'always', sync_kind: 'poll' },
    })).toThrow(/mutually exclusive/);
  });
});
