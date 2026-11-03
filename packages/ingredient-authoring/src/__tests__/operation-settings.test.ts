import { describe, expect, it } from 'vitest';
import { validateIngredient } from '@recued/ingredients/validate';
import { operationPolicyFields, operationPolicyValues, operationApprovalReasonValid, operationPolicyIssueLocations } from '../operation-policies.js';
import { validateComposition } from '../validators.js';

const body = (): any => ({ schema_version: 1, slug: 'settings-api', catalog_kind: 'official',
  ingredients: [{ slug: 'settings-api', kind: 'http', http: { base: 'https://api.example.com' } }],
  operations: [{ op: 'item.read', ingredient: 'settings-api', risk: 'read', approval: 'never', bind: { kind: 'rest', method: 'GET', path_template: '/items' }, timeout_ms: 45000, cache_ttl_ms: 0 }],
});
describe('shared operation execution settings', () => {
  it('keeps timing and reason choices open, exposes explicit cost booleans and shares the reason grammar', () => {
    expect(operationPolicyValues('spends_per_call')).toEqual([true, false]);
    for (const key of ['timeout_ms', 'cache_ttl_ms', 'approval_reason'] as const) expect(operationPolicyValues(key)).toEqual([]);
    expect(operationPolicyFields().filter(field => ['timeout_ms', 'cache_ttl_ms', 'spends_per_call', 'approval_reason'].includes(field.key)).map(field => [field.key, field.type, field.required])).toEqual([
      ['timeout_ms', 'number', false], ['cache_ttl_ms', 'number', false], ['spends_per_call', 'boolean', false], ['approval_reason', 'string', false],
    ]);
    for (const value of ['abc', 'custom_reason_2', 'a'.repeat(64)]) expect(operationApprovalReasonValid(value)).toBe(true);
    for (const value of ['', 'ab', 'Upper_case', '2reason', 'a'.repeat(65), null, false, {}]) expect(operationApprovalReasonValid(value)).toBe(false);
  });
  it('locates existing timing/cache catalog decisions without changing severity, messages or multiplicity', () => {
    const source = body(); expect(validateComposition(source).valid).toBe(true); source.operations[0].timeout_ms = -1; source.operations[0].cache_ttl_ms = 90000000;
    const result = validateComposition(source), artifacts = result.decomposed;
    if (!artifacts || !('catalog' in artifacts)) throw new Error('Expected a catalog.');
    const relevant = (issues: typeof result.issues) => issues.filter(issue => ['CATALOG_TIMEOUT_INVALID', 'CATALOG_CACHE_TTL_OUTLIER'].includes(issue.code));
    const emitted = relevant(validateIngredient(artifacts.catalog).issues), located = relevant(result.issues);
    expect(located.map(({ path, ...issue }) => issue)).toEqual(emitted.map(({ path, ...issue }) => issue));
    expect(located.map(issue => issue.path)).toEqual(['operations[0].timeout_ms', 'operations[0].cache_ttl_ms']);
    expect(located.map(issue => issue.severity)).toEqual(['error', 'warn']);
  });
  it('uses exact operation identity and declines ambiguous or mismatching lowerings', () => {
    const operations = [{ op: 'quoted.[name]', risk: 'read', timeout_ms: -1, cache_ttl_ms: -1 }], lowered = { 'quoted.[name]': { risk_tier: 'read', timeout_ms: -1, cache_ttl_ms: -1 } };
    const locations = operationPolicyIssueLocations(operations, lowered);
    expect(locations.get(JSON.stringify(['CATALOG_TIMEOUT_INVALID', 'operations.quoted.[name].timeout_ms']))).toBe('operations[0].timeout_ms');
    expect(operationPolicyIssueLocations([...operations, ...operations], lowered).size).toBe(0);
    expect(operationPolicyIssueLocations(operations, { 'quoted.[name]': { ...lowered['quoted.[name]'], timeout_ms: 42 } }).size).toBe(0);
  });
  it('locates unknown literal setting keys while preserving values and canonical reason/cost admission', () => {
    const source = body(); source.operations[0]['timout.ms'] = 45000; source.operations[0].spends_per_call = 'true'; source.operations[0].approval_reason = 'Bad reason';
    const issues = validateComposition(source).issues;
    expect(issues).toContainEqual(expect.objectContaining({ code: 'composition_operation_unknown_key', path: 'operations[0]["timout.ms"]', reference_span: { target: 'key', offset: 0, length: 9 } }));
    expect(issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['composition_operation_spends_per_call_invalid', 'composition_operation_approval_reason_invalid']));
    expect(source.operations[0]['timout.ms']).toBe(45000);
  });
  it('retains the existing plain-wrapper lowering and its timing-validation posture', () => {
    const source = body(); delete source.catalog_kind; source.operations[0].timeout_ms = -1; source.operations[0].cache_ttl_ms = -1;
    const result = validateComposition(source); expect(result.valid).toBe(true);
    expect(result.decomposed && 'ingredient' in result.decomposed).toBe(true);
    expect(operationPolicyFields('rest').find(field => field.key === 'timeout_ms')!.description).toContain('Plain 1x1 API wrappers do not carry');
  });
});
