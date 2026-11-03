import { describe, expect, it } from 'vitest';
import { validateIngredient } from '@recued/ingredients/validate';
import { restStaticRequestProblems, restMergeQueryProblems } from '@recued/ingredients/rest-request-policy';
import { restRequestFields, restBodyAuthNames, restMergeQueryNames } from '../rest-request-authoring.js';
import { validateComposition, validatePack } from '../validators.js';

const body = (): any => ({ schema_version: 1, slug: 'request-api', catalog_kind: 'official',
  ingredients: [{ slug: 'request-api', kind: 'http', http: { base: 'https://api.example.com' } }],
  operations: [{ op: 'item.create', ingredient: 'request-api', risk: 'write', approval: 'always', bind: { kind: 'rest', method: 'POST', path_template: '/items',
    static_query: { fields: 'id,name' }, merge_query: ['fields'], static_body: { mode: 'fixed' } } }],
});
const pack = (): any => ({ manifest_version: 2, publisher: 'recued-core', connection_requirements: [{ vendor: 'example_api', api_base: 'https://api.example.com', auth: { type: 'body_field', field_names: ['client_id', 'secret'] } }] });
describe('shared REST request authoring', () => {
  it('uses declared query names only when the complete map has string values and bounded names', () => {
    expect(restMergeQueryNames({ fields: 'name', 'literal.key': 'fixed' })).toEqual(['fields', 'literal.key']);
    for (const value of [null, [], { fields: 42 }, { '': 'value' }, Object.fromEntries(Array.from({ length: 101 }, (_, i) => ['key' + i, 'value']))]) expect(restMergeQueryNames(value)).toEqual([]);
    expect(restRequestFields().map(field => field.key)).toEqual(expect.arrayContaining(['static_body', 'merge_query', 'auth_body_fields']));
  });
  it('uses one valid body-field descriptor with exact base and explicit connection agreement', () => {
    expect(restBodyAuthNames(pack(), 'example-api', 'https://api.example.com')).toEqual([{ name: 'client_id', requirement: 0, field: 0 }, { name: 'secret', requirement: 0, field: 1 }]);
    for (const [connection, base] of [['other', 'https://api.example.com'], ['example_api', 'https://other.example.com'], ['example_api', 'https://api.example.com/v2']]) expect(restBodyAuthNames(pack(), connection, base)).toEqual([]);
    for (const mutate of [
      (p: any) => { p.publisher = 'community-author'; }, (p: any) => { p.manifest_version = 1; },
      (p: any) => { p.connection_requirements.push(structuredClone(p.connection_requirements[0])); },
      (p: any) => { p.connection_requirements[0].auth.field_names = ['secret', 'secret']; },
      (p: any) => { p.connection_requirements[0].auth.field_names = ['constructor']; },
      (p: any) => { p.connection_requirements[0].auth.type = 'none'; },
    ]) { const source = pack(); mutate(source); expect(restBodyAuthNames(source, 'example_api', 'https://api.example.com')).toEqual([]); }
  });
  it('retains catalog findings and messages while placing them on the authored request field or list item', () => {
    const source = body(); expect(validateComposition(source).valid).toBe(true);
    source.operations[0].bind.static_body.mode = 42; source.operations[0].bind.merge_query = ['feilds', 'feilds'];
    const result = validateComposition(source), artifacts = result.decomposed;
    if (!artifacts || !('catalog' in artifacts)) throw new Error('Expected a lowered catalog.');
    const catalog = validateIngredient(artifacts.catalog);
    const relevant = (issues: typeof result.issues) => issues.filter(issue => issue.code === 'CATALOG_BINDING_INVALID');
    expect(relevant(result.issues).map(({ path, reference_span, ...issue }) => issue)).toEqual(relevant(catalog.issues).map(({ path, reference_span, ...issue }) => issue));
    expect(relevant(result.issues).map(issue => issue.path)).toEqual(['operations[0].bind.static_body.mode', 'operations[0].bind.merge_query[0]', 'operations[0].bind.merge_query[1]']);
  });
  it('locates literal dotted body keys and protected headers as keys without rewriting their values', () => {
    const source = body(), bind = source.operations[0].bind; bind.static_body = { 'person.name': 'fixed' }; bind.static_headers = { aUtHoRiZaTiOn: 'fixed' };
    const result = validateComposition(source), issues = result.issues.filter(issue => issue.code === 'CATALOG_BINDING_INVALID');
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'operations[0].bind.static_body["person.name"]', reference_span: { target: 'key', offset: 0, length: 11 } }),
      expect.objectContaining({ path: 'operations[0].bind.static_headers.aUtHoRiZaTiOn', reference_span: { target: 'key', offset: 0, length: 13 } }),
    ]));
    expect(bind.static_body['person.name']).toBe('fixed'); expect(bind.static_headers.aUtHoRiZaTiOn).toBe('fixed');
  });
  it('keeps existing shape issue counts, merge duplicates and body-method semantics', () => {
    expect(restMergeQueryProblems({ static_query: { fields: 'id' }, merge_query: ['fields', 'fields'] }, 'item.create')).toEqual([]);
    const shape = restMergeQueryProblems({ static_query: {}, merge_query: ['missing', 42, 'other'] }, 'item.create');
    expect(shape).toHaveLength(1); expect(shape[0]!.path).toEqual(['merge_query', 1]);
    expect(restMergeQueryProblems({ static_query: {}, merge_query: Array(1) }, 'item.create')).toEqual([expect.objectContaining({ path: ['merge_query', 0] })]);
    expect(restStaticRequestProblems({ method: 'GET', static_body: {} }, 'item.read')).toEqual([expect.objectContaining({ path: ['static_body'], message: "rest binding for 'item.read' static_body requires a body-carrying method (POST/PUT/PATCH), got GET" })]);
    // Body-auth opt-ins retain their existing validation posture; this batch supplies source help only.
    const source = body(); source.operations[0].bind.auth_body_fields = ['unresolved']; expect(validateComposition(source).valid).toBe(true);
  });
  it('keeps authored composition indices when install normalization lifts typed and legacy recipe references', () => {
    const source: any = { manifest_version: 2, artifact_type: 'pack', slug: 'request-pack', publisher: 'recued-core', version: 1,
      name: 'Request pack', description: 'A request authoring fixture with mixed recipe references.', requires: ['install_bulk_pack'],
      recipes: [{ slug: 'legacy-recipe', version: 1 }], contents: [{ type: 'composition', composition: body() }, { type: 'recipe', slug: 'typed-recipe', version: 1 }] };
    expect(validatePack(source).valid).toBe(true);
    source.contents[0].composition.operations[0].bind.merge_query = ['feilds'];
    const issues = validatePack(source).issues.filter(issue => issue.code === 'CATALOG_BINDING_INVALID');
    expect(issues).toHaveLength(1); expect(issues[0]!.path).toBe('contents[0].composition.operations[0].bind.merge_query[0]');
  });
});
