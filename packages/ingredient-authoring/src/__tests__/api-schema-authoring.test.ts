import { describe, expect, it } from 'vitest';
import { OPENAPI_ABSENT_REASONS } from '@recued/contracts';
import { validateIngredient } from '@recued/ingredients/validate';
import { apiSchemaFields, apiSchemaIssueLocations, openApiDocumentParameters } from '../api-schema-authoring.js';
import { validateComposition } from '../validators.js';

const body = (): any => ({ schema_version: 1, slug: 'schema-api', catalog_kind: 'official',
  ingredients: [{ slug: 'schema-api', kind: 'http', http: { base: 'https://api.example.com',
    openapi_source: { url: 'https://docs.example.com/spec', sha256: 'a'.repeat(64), path_alias: { doc_base: '/api' } } } }],
  operations: [{ op: 'item.read', ingredient: 'schema-api', risk: 'read', approval: 'never', args: ['owner', 'project'],
    bind: { kind: 'rest', method: 'GET', path_template: '/{{owner}}/{{project}}', openapi_path: '/{project.slug}',
      openapi_path_param_expansions: { 'project.slug': ['owner', 'project'] } } }],
});
describe('shared API schema authoring metadata and source projection', () => {
  it('shares closed reasons while leaving URLs, digests and path values authored and OpenAPI aliases scoped to that schema kind', () => {
    expect(apiSchemaFields('absent').find(field => field.key === 'reason')!.values!.map(row => row.value)).toEqual(OPENAPI_ABSENT_REASONS);
    for (const pin of ['graphql_schema_source', 'google_discovery_source']) expect(apiSchemaFields('source', pin).map(field => field.key)).toEqual(['url', 'sha256']);
    expect(apiSchemaFields('source', 'openapi_source').map(field => field.key)).toContain('path_alias');
    expect(apiSchemaFields('source', 'openapi_source').every(field => !field.values)).toBe(true);
    expect(apiSchemaFields('alias').every(field => !field.required && !field.values)).toBe(true);
  });
  it('projects existing schema and binding findings without changing canonical decisions, messages, severity, order or multiplicity', () => {
    const source = body(), schema = source.ingredients[0].http.openapi_source, bind = source.operations[0].bind;
    schema.url = 'http://example.com/spec'; schema.sha256 = 'BAD'; schema.path_alias = [{ doc_base: '/api' }, { wire_prefix: '/v1', strip_suffix: 'json' }];
    bind.openapi_absent = { reason: 'unknown', evidence: 'http://example.com/docs', extra: true };
    bind.openapi_path_param_expansions = { 'project.slug': ['invalid-name'] };
    const result = validateComposition(source), artifacts = result.decomposed;
    if (!artifacts || !('catalog' in artifacts)) throw new Error('Expected a catalog.');
    const canonical = validateIngredient(artifacts.catalog), relevant = (issues: typeof canonical.issues) => issues.filter(issue => ['CATALOG_SURFACE_INVALID', 'CATALOG_BINDING_INVALID'].includes(issue.code));
    expect(relevant(result.issues).map(({ path, ...issue }) => issue)).toEqual(relevant(canonical.issues).map(({ path, ...issue }) => issue));
    expect(result.valid).toBe(canonical.valid);
    expect(relevant(result.issues).map(issue => issue.path)).toContain('operations[0].bind.openapi_path_param_expansions["project.slug"]');
    expect(relevant(result.issues).map(issue => issue.path)).toContain('ingredients[0].http.openapi_source.path_alias[1].strip_suffix');
    expect(relevant(result.issues).map(issue => issue.path)).toContain('operations[0].bind.openapi_absent.reason');
  });
  it('requires exact retained lowering identity and unique names rather than guessing source from catalog messages', () => {
    const source = body(), pin = source.ingredients[0].http.openapi_source, binding = source.operations[0].bind;
    const api = { openapi_source: pin, executes: { 'item.read': binding } };
    expect(apiSchemaIssueLocations(source, api).get(JSON.stringify(['CATALOG_BINDING_INVALID', 'surfaces.api.executes.item.read.openapi_path']))).toBe('operations[0].bind.openapi_path');
    expect(apiSchemaIssueLocations(source, structuredClone(api)).size).toBe(0);
    source.operations.push(structuredClone(source.operations[0]));
    expect([...apiSchemaIssueLocations(source, api).values()].some(path => path.startsWith('operations'))).toBe(false);
    source.ingredients.push(structuredClone(source.ingredients[0])); expect(apiSchemaIssueLocations(source, api).size).toBe(0);
  });
  it('retains accepted unknown pin/alias keys and the existing HTTPS and digest format rules', () => {
    const source = body(), pin = source.ingredients[0].http.openapi_source;
    pin.extra = true; pin.path_alias = { doc_bsae: '/api' };
    expect(validateComposition(source).valid).toBe(true);
    for (const url of ['https://example.com/spec', 'http://localhost/spec', 'http://127.0.0.1/spec', 'http://[::1]/spec']) {
      pin.url = url; expect(validateComposition(source).valid, url).toBe(true);
    }
    pin.url = 'https://example.com/spec'; pin.sha256 = 'A'.repeat(64);
    expect(validateComposition(source).issues).toContainEqual(expect.objectContaining({ code: 'CATALOG_SURFACE_INVALID', path: 'ingredients[0].http.openapi_source.sha256' }));
  });
  it('withholds ambiguous projections when dotted operation and document-parameter names collide in a legacy catalog path', () => {
    const source = body(), binding = source.operations[0].bind;
    binding.openapi_path_param_expansions = { 'doc.openapi_path': ['owner'] };
    source.operations.push({ ...structuredClone(source.operations[0]), op: 'item.read.openapi_path_param_expansions.doc', bind: { ...structuredClone(binding), openapi_path: 'invalid' } });
    const api = { executes: Object.fromEntries(source.operations.map((row: any) => [row.op, row.bind])) };
    const key = JSON.stringify(['CATALOG_BINDING_INVALID', 'surfaces.api.executes.item.read.openapi_path_param_expansions.doc.openapi_path']);
    expect(apiSchemaIssueLocations(source, api).has(key)).toBe(false);
  });
  it('extracts only complete bounded parameter spellings from the locally authored document path', () => {
    expect(openApiDocumentParameters('/{project-slug}/items/{item.id}')).toEqual(['project-slug', 'item.id']);
    for (const path of ['/{{wire}}', '/{unterminated', '/{invalid name}', 'https://example.com/{id}', '/'.repeat(20_001), null,
      '/' + Array.from({ length: 101 }, (_, index) => '{p' + index + '}').join('/')]) expect(openApiDocumentParameters(path)).toEqual([]);
  });
});
