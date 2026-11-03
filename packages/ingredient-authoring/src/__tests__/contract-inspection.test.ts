import { describe, expect, it } from 'vitest';
import { validateIngredient, graphqlOperationKind } from '@recued/ingredients';
import { responseSchemaEntries } from '../response-schema-authoring.js';
import { graphqlIssueLocations } from '../graphql-authoring.js';
import { compositionAuthoringChoices, compositionBindingFields } from '../composition-authoring.js';
import { validateComposition } from '../validators.js';
const body = (): any => ({ schema_version: 1, slug: 'contracts-api', catalog_kind: 'official',
  ingredients: [{ slug: 'contracts-api', kind: 'http', http: { base: 'https://api.example.com' } }],
  operations: ['item.list', 'item.get'].map(op => ({ op, ingredient: 'contracts-api', risk: 'read', approval: 'never',
    bind: { kind: 'graphql', operation_type: 'query', endpoint_path: '/graphql', query: 'query { items { id } }' } })),
});
describe('shared descriptive response contracts', () => {
  it('walks literal properties/items, preserves open policy and requiredness, and never resolves refs, branches or tuple items', () => {
    const result = responseSchemaEntries({ type: 'object', required: ['a.b'], properties: { 'a.b': { type: 'array', items: { type: 'object', properties: { id: true } } },
      ref: { $ref: '#/$defs/a', allOf: [{ properties: { invented: { type: 'string' } } }] }, tuple: { items: [{ type: 'string' }] } } });
    expect(result.entries.map(row => row.path)).toEqual([[], ['a.b'], ['a.b', null], ['a.b', null, 'id'], ['ref'], ['tuple']]);
    expect(result.entries[1]!.required).toBe(true); expect(result.entries[2]!.required).toBe(false); expect(result.entries[3]!.constraints.boolean_schema).toBe(true);
    expect(result.entries[0]!.constraints.additionalProperties).toContain('not closed'); expect(result.entries[4]!.limitations.join(' ')).toMatch(/\$ref.*allOf/);
    expect(result.entries[5]!.limitations.join(' ')).toContain('Tuple'); expect(result.complete).toBe(false); expect(result.limited).toBe(false);
  });
  it('refuses deep, cyclic and unsupported metadata without turning it into a response validation rule', () => {
    const cyclic: any = { type: 'array' }; cyclic.items = cyclic; expect(responseSchemaEntries(cyclic).complete).toBe(false);
    const root: any = {}; let next = root; for (let i = 0; i < 30; i++) { next.items = {}; next = next.items; }
    expect(responseSchemaEntries(root).limited).toBe(true); expect(responseSchemaEntries({ contains: { type: 'string' } }).complete).toBe(false);
    expect(responseSchemaEntries({ type: 'object', required: [1], properties: { value: {} } }).entries[1]!.required).toBe(false);
    const source = body(), baseline = validateComposition(source);
    for (const response of [null, false, { $ref: '#/nowhere', properties: { data: { pattern: '(a+)+$' } } }, { required: [42] }]) {
      source.operations[0].response_schema = response;
      expect(validateComposition(source).issues).toEqual(baseline.issues);
    }
  });
});
describe('shared scope and GraphQL source assistance', () => {
  it('preserves canonical scope shape code, message and multiplicity while locating only the first malformed item', () => {
    const source = body(); source.operations[0].required_scopes = ['unknown:any', 'unknown:any']; expect(validateComposition(source).valid).toBe(true);
    source.operations[0].required_scopes = ['valid', null, false]; const issues = validateComposition(source).issues.filter(row => row.code === 'composition_operation_required_scopes_shape');
    expect(issues).toEqual([{ severity: 'error', code: 'composition_operation_required_scopes_shape', path: 'operations[0].required_scopes[1]', message: 'required_scopes must be a string array when present' }]);
    source.operations[0].required_scopes = false; expect(validateComposition(source).issues.find(row => row.code === issues[0]!.code)?.path).toBe('operations[0].required_scopes');
  });
  it('uses the existing first-keyword classifier and suggests only dispatchable HTTP kinds while leaving subscriptions invalid', () => {
    for (const [text, expected] of [['\ufeff ,#comment\r\n,mutation Write { x }', 'mutation'], ['{ x }', 'query'], ['subscription Live { x }', 'subscription'],
      ['fragment F on T { x } query { x }', 'unknown'], ['"description" mutation { x }', 'unknown'], ['mutationLog { x }', 'unknown'], ['query Q { x } mutation M { x }', 'query']]) expect(graphqlOperationKind(text!)).toBe(expected);
    expect(compositionAuthoringChoices('binding', 'operation_type', 'http', 'graphql').map(row => row.value)).toEqual(['query', 'mutation']);
    expect(compositionBindingFields('http', 'graphql').find(row => row.key === 'result_data_path')?.required).toBe(false);
    const source = body(); source.operations[0].bind.operation_type = 'subscription'; source.operations[0].bind.query = 'subscription { items { id } }';
    expect(validateComposition(source).issues.some(row => row.code === 'CATALOG_BINDING_INVALID' && row.path === 'operations[0].bind.operation_type')).toBe(true);
  });
  it('projects existing catalog errors through exact bindings without changing severity, code, message, count or ordering', () => {
    const source = body(); source.operations[0].bind.query = 'mutation Update { change { id } }'; source.operations[0].bind.result_data_path = 'data..items';
    const result = validateComposition(source), artifacts = result.decomposed; if (!artifacts || !('catalog' in artifacts)) throw new Error('Expected catalog.');
    const relevant = (issues: typeof result.issues) => issues.filter(row => ['CATALOG_BINDING_INVALID', 'CATALOG_BINDING_RISK_MISMATCH'].includes(row.code));
    const canonical = relevant(validateIngredient(artifacts.catalog).issues), projected = relevant(result.issues);
    expect(projected.map(({ path, ...issue }) => issue)).toEqual(canonical.map(({ path, ...issue }) => issue));
    expect(projected.map(row => row.path)).toEqual(['operations[0].bind.result_data_path', 'operations[0].bind.operation_type', 'operations[0].risk']);
  });
  it('withholds source projections for overwritten operations, copied bindings, dotted legacy collisions and mismatched lowered risk', () => {
    const source = body(), row = source.operations[0], executes = { [row.op]: row.bind }, specs = { [row.op]: { risk_tier: row.risk } };
    expect(graphqlIssueLocations([row, { ...row }], executes, specs).size).toBe(0);
    expect(graphqlIssueLocations([row], { [row.op]: { ...row.bind } }, specs).size).toBe(0);
    const map = graphqlIssueLocations([row], executes, { [row.op]: { risk_tier: 'write' } }); expect(map.has(JSON.stringify(['CATALOG_BINDING_RISK_MISMATCH', 'operations.' + row.op + '.risk_tier']))).toBe(false);
    const collision = graphqlIssueLocations([row], { ...executes, [row.op + '.query']: null }, specs);
    expect(collision.has(JSON.stringify(['CATALOG_BINDING_INVALID', 'surfaces.api.executes.' + row.op + '.query']))).toBe(false);
    expect(collision.has(JSON.stringify(['CATALOG_BINDING_INVALID', 'surfaces.api.executes.' + row.op + '.operation_type']))).toBe(true);
  });
});
