import { describe, expect, it } from 'vitest';
import { assertEngagementFacetShape, engagementFacetFindings } from '@recued/contracts';
import { vendorEntitySchemaOrigins } from '../vendor-entity-issues.js';
import { vendorEntityMetaField } from '../vendor-entity-authoring.js';
describe('Shared engagement finding and ownership contracts', () => {
  it('keeps legacy acceptance, message ordering and shape findings while exposing structured locations', () => {
    const input = { capability: 'always', sync_kind: 'invalid', exclusive_group: '', daily_budget: 0, extra: 'retained' };
    const findings = engagementFacetFindings(input);
    expect(findings.map(row => row.path)).toEqual([['sync_kind'], ['exclusive_group'], ['exclusive_group'], ['daily_budget']]);
    expect(findings.map(row => row.message)).toEqual(assertEngagementFacetShape(input));
    expect(findings[0]!.message).toBe('engagement.sync_kind must be one of poll / delta_cursor / stream (got "invalid")');
    expect(assertEngagementFacetShape({ capability: 'always', sync_kind: 'poll', extra: 'allowed' })).toEqual([]);
    expect(engagementFacetFindings(null)).toEqual([{ message: "field 'engagement' must be an object when present" }]);
  });
  it('withholds a source join whose emitted activity facet differs from its authored owner', () => {
    const field = { maps_to: 'id', field_path: 'Id', type: 'string' as const }, engagement = { capability: 'always' as const, sync_kind: 'poll' as const };
    const body = { slug: 'vendor', ingredients: [{ kind: 'http', entities: { email: { fields: [field], engagement } } }] };
    const schema: any = { ingredient_id: 'vendor', entity_id: 'email', meta_fields: [vendorEntityMetaField(field)], engagement };
    expect(vendorEntitySchemaOrigins(body, [schema]).get(0)).toBe('ingredients[0].entities.email');
    expect(vendorEntitySchemaOrigins(body, [{ ...schema, engagement: { ...engagement, sync_kind: 'stream' } }])).toEqual(new Map());
  });
});
