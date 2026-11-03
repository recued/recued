import { describe, expect, it } from 'vitest';
import { assertEntitySchemaIngredientShape, entitySchemaIngredientFindings, type EntitySchemaIngredientInput } from '@recued/contracts';
import { vendorEntityFieldChoices, vendorEntityMetaField } from '../vendor-entity-authoring.js';
import { vendorEntitySchemaOrigins } from '../vendor-entity-issues.js';
import { validateComposition } from '../validators.js';
const body = (): any => ({ schema_version: 1, slug: 'vendor-api', catalog_kind: 'official',
  ingredients: [{ slug: 'vendor-api', kind: 'http', http: { base: 'https://api.example.com' }, entities: { 'person.profile': { fields: [
    { maps_to: 'id', field_path: 'Id', type: 'string', source_operation: 'person.read' },
    { maps_to: 'email', field_path: 'emailAddresses[0].value', type: 'string', optional: true, pii: 'email' },
  ] } } }], operations: ['person.read', 'person.list'].map(op => ({ op, ingredient: 'vendor-api', risk: 'read', approval: 'never', bind: { kind: 'rest', method: 'GET', path_template: '/people' } })),
});
const artifacts = (source: any) => { const result = validateComposition(source); if (!result.decomposed || !('entity_schemas' in result.decomposed)) throw new Error('Expected entity schemas.'); return result.decomposed.entity_schemas!; };
describe('shared HTTP entity metadata and canonical findings', () => {
  it('offers warehouse and privacy vocabularies while keeping paths open and canonical CRM suggestions compatible', () => {
    expect(vendorEntityFieldChoices('type', {}, undefined)).toEqual(['string', 'number', 'boolean', 'datetime', 'json']);
    expect(vendorEntityFieldChoices('field_path', {}, undefined)).toEqual([]);
    expect(vendorEntityFieldChoices('type', { maps_to: 'name' }, 'contact')).toEqual(['string']);
    expect(vendorEntityFieldChoices('maps_to', { type: 'number' }, 'deal', ['amount'])).toContain('probability');
    expect(vendorEntityFieldChoices('maps_to', { type: 'number' }, 'deal', ['amount'])).not.toContain('name');
    expect(vendorEntityFieldChoices('date_granularity', { type: 'string' }, undefined)).toEqual([]);
    expect(vendorEntityFieldChoices('date_granularity', { type: 'datetime' }, undefined)).toEqual(['date', 'datetime']);
  });
  it('preserves the exact compiler projection, optionality defaults, privacy and author-only metadata boundary', () => {
    const source = body(), fields = source.ingredients[0].entities['person.profile'].fields;
    Object.assign(fields[1], { label: 'Email address', description: 'Primary email', source: 'manual', applies: 'response' });
    const schema = artifacts(source)[0]!; expect(schema.meta_fields![1]).toEqual({ key: 'email', type: 'string', description: 'Primary email', label: 'Email address', required: false, source_path: 'emailAddresses[0].value', privacy: 'email' });
    expect(schema.meta_fields![0]!.required).toBe(true); expect(schema.meta_fields![1]).not.toHaveProperty('source'); expect(schema.meta_fields![1]).not.toHaveProperty('applies');
    fields[1].optional = 'authored legacy value'; expect(artifacts(source)[0]!.meta_fields![1]!.required).toBe(false);
    expect(JSON.stringify(vendorEntityMetaField(fields[1]))).toBe(JSON.stringify(artifacts(source)[0]!.meta_fields![1]));
  });
  it('retains legacy shape messages and order while supplying structured field paths without parsing text', () => {
    const schema = artifacts(body())[0]! as EntitySchemaIngredientInput; schema.entity_id = 'invalid id'; schema.meta_fields![0]!.type = 'strng' as never; schema.meta_fields![1]!.privacy = 'emial' as never;
    const before = assertEntitySchemaIngredientShape(schema), findings = entitySchemaIngredientFindings(schema);
    expect(findings.map(row => row.message)).toEqual(before); expect(findings[0]!.path).toBeUndefined();
    expect(findings.filter(row => row.path).map(row => row.path)).toEqual([['meta_fields', 0, 'type'], ['meta_fields', 1, 'privacy']]);
    expect(before).toContain('meta_fields[0].type must be one of string / number / boolean / datetime / json');
    const source = body(); source.ingredients[0].entities['person.profile'].fields[0].field_path = "$['Due Date']"; expect(validateComposition(source).valid).toBe(true);
  });
  it('relocates only exact emitted HTTP fields and withholds overwritten/ambiguous projections', () => {
    const source = body(), schema = artifacts(source)[0]!, map = vendorEntitySchemaOrigins(source, [schema]); expect(map.get(0)).toBe('ingredients[0].entities["person.profile"]');
    expect(vendorEntitySchemaOrigins(source, [{ ...schema, meta_fields: [] }]).size).toBe(0);
    expect(vendorEntitySchemaOrigins(source, [schema, schema]).size).toBe(0);
    source.ingredients.push(structuredClone(source.ingredients[0])); source.ingredients[1].slug = 'other'; expect(vendorEntitySchemaOrigins(source, [schema]).size).toBe(0);
  });
  it('preserves CRM portability warnings, type errors and open vendor extra mappings', () => {
    const source = body(), entity = source.ingredients[0].entities['person.profile']; entity.crm_alias = 'contact';
    expect(validateComposition(source).valid).toBe(true); expect(validateComposition(source).issues.some(row => row.code === 'composition_entity_crm_alias_missing_required')).toBe(true);
    entity.fields[1].type = 'number'; const result = validateComposition(source); expect(result.valid).toBe(false);
    expect(result.issues.find(row => row.code === 'composition_entity_field_crm_alias_type_mismatch')?.path).toBe('ingredients[0].entities["person.profile"].fields[1].type');
    entity.fields[1].maps_to = 'vendor_amount'; expect(validateComposition(source).valid).toBe(true); expect(validateComposition(source).issues.some(row => row.code === 'composition_entity_field_crm_alias_noncanonical')).toBe(true);
  });
  it('locates raw generated type/privacy failures at the authored field without changing error identity or multiplicity', () => {
    const source = body(), fields = source.ingredients[0].entities['person.profile'].fields; fields[0].type = 'strng'; fields[1].pii = 'emial'; const schemas = artifacts(source), result = validateComposition(source);
    const canonical = entitySchemaIngredientFindings(schemas[0]!).map(row => row.message), located = result.issues.filter(row => row.code === 'entity_schema_invalid');
    expect(located.map(row => row.message)).toEqual(canonical); expect(located.map(row => row.path)).toEqual(['ingredients[0].entities["person.profile"].fields[0].type', 'ingredients[0].entities["person.profile"].fields[1].pii']);
    expect(located.every(row => row.severity === 'error')).toBe(true);
  });
});
