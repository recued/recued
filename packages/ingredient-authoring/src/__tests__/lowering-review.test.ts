import { describe, expect, it } from 'vitest';
import { compositionLoweringDecision, decomposeComposition } from '../decomposer.js';
import type { CompositionIngredient, IngredientEntity } from '@recued/contracts';
const wrapper = (): CompositionIngredient => ({ schema_version: 1, slug: 'preview-api', ingredients: [{ slug: 'api', kind: 'http', http: { base: 'https://example.com' } }],
  operations: [{ op: 'item.read', ingredient: 'api', risk: 'read', approval: 'never', args: [], bind: { kind: 'rest', method: 'GET', path_template: '/items' } }] });
describe('compiler lowering decisions for offline review', () => {
  it('shares the exact wrapper/catalog branch and preserves generated policy and grant declarations', () => {
    const source = wrapper(), first = decomposeComposition[1]!(source);
    expect(compositionLoweringDecision(source).kind).toBe('ingredient'); expect(first.catalog).toBeUndefined(); expect(first.ingredient?.input).toMatchObject({ method: 'GET', path: '/items' });
    source.catalog_kind = 'official'; const catalog = decomposeComposition[1]!(source);
    expect(compositionLoweringDecision(source)).toMatchObject({ kind: 'catalog', code: 'catalog_kind', source_path: ['catalog_kind'] });
    expect(catalog.catalog?.operations?.['item.read']?.approval).toBe('never'); expect(catalog.operation_groups?.length).toBeGreaterThan(0); expect(catalog.default_grants?.length).toBeGreaterThan(0);
  });
  it('identifies the existing explicit catalog, operation-count and template boundaries in compiler order', () => {
    const source = wrapper(); source.force_catalog_lowering = true;
    expect(compositionLoweringDecision(source).code).toBe('forced_catalog'); source.force_catalog_lowering = false;
    source.operations.push({ ...source.operations[0]!, op: 'item.other' }); expect(compositionLoweringDecision(source).code).toBe('operation_count'); source.operations.pop();
    source.recipe_templates = [{ template: 'notify-on-event', trigger: { entity: 'item' }, operation: 'item.read' }];
    expect(compositionLoweringDecision(source).code).toBe('recipe_templates'); expect(decomposeComposition[1]!(source).recipes).toHaveLength(1);
  });
  it('uses normalized entity count and does not let aliasing change the one-entity wrapper boundary', () => {
    const source = wrapper(), entity: IngredientEntity = { fields: [{ maps_to: 'id', field_path: 'id', type: 'string', source_operation: 'item.read' }] };
    source.ingredients[0]!.entities = { Item: structuredClone(entity), item: structuredClone(entity) };
    expect(compositionLoweringDecision(source).kind).toBe('ingredient'); source.ingredients[0]!.entities!.other = structuredClone(entity);
    expect(compositionLoweringDecision(source).code).toBe('entity_count'); expect(decomposeComposition[1]!(source).catalog).toBeDefined();
  });
  it('preserves unsupported simple-binding refusal instead of inventing a catalog fallback', () => {
    const source = wrapper(); source.operations[0]!.bind = { kind: 'graphql', operation_type: 'query', query: '{ viewer { id } }', endpoint_path: '/graphql' };
    expect(compositionLoweringDecision(source).kind).toBe('ingredient'); expect(() => decomposeComposition[1]!(source)).toThrow('requires a rest or mcp binding');
  });
});
