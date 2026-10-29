import { describe, expect, it } from 'vitest';
import { validateRecipe } from '../validate.js';
import { referenceLocations } from '../validate/reference-locations.js';

const recipe = (template: string) => ({ recipe_id: 'reference-locations', version: 1, ttl: 0,
  metadata: { name: 'Reference locations', description: 'Check local source references.', author: 'test', supported_platforms: [] },
  prefetch_steps: [], steps: [{ id: 'render', transform: 'template', template }], requires: [], variables: {}, output: { render: [{ type: 'text', source: 'step.render' }] } });
describe('canonical reference locations', () => {
  it('locates repeated references in decoded UTF-16 strings without merging occurrences', () => {
    const value = '🌍 "quoted"\n{{config.missing:currency}} / {{config.missing}}';
    const issues = validateRecipe(recipe(value)).issues.filter(issue => issue.code === 'undeclared_variable_ref');
    expect(issues).toHaveLength(2);
    expect(issues.map(issue => issue.path)).toEqual(['steps[0].template', 'steps[0].template']);
    expect(issues.map(issue => value.slice(issue.reference_span!.offset, issue.reference_span!.offset + issue.reference_span!.length)))
      .toEqual(['{{config.missing:currency}}', '{{config.missing}}']);
    expect(issues[0]!.reference_span!.offset).toBe(value.indexOf('{{'));
    expect(issues[0]!.reference_span!.target).toBe('value');
  });
  it('locates array values and quoted dictionary keys using unambiguous paths', () => {
    const body = recipe('hi'), payload = { 'odd.key': ['prefix {{step.absent}}'], '{{vault.token}}': 'literal' };
    const result = validateRecipe({ ...body, steps: [{ ...body.steps[0], payload }] });
    expect(result.issues.find(issue => issue.code === 'undeclared_step_ref')).toMatchObject({
      path: 'steps[0].payload["odd.key"][0]', reference_span: { offset: 7, length: 15, target: 'value' },
    });
    expect(result.issues.find(issue => issue.code === 'vault_ref_in_recipe')).toMatchObject({
      path: 'steps[0].payload["{{vault.token}}"]', reference_span: { offset: 0, length: 15, target: 'key' },
    });
  });
  it('retains prose exclusion and places unknown namespace errors at their actual use', () => {
    const body = recipe('{{unknown.value}}');
    body.metadata = { ...body.metadata, ...{ readme: '{{config.prose}} and {{step.missing}}' } };
    const result = validateRecipe(body);
    expect(result.issues.some(issue => issue.code === 'undeclared_variable_ref' || issue.code === 'undeclared_step_ref')).toBe(false);
    expect(result.issues.find(issue => issue.code === 'unknown_namespace')).toMatchObject({ path: 'steps[0].template', reference_span: { offset: 0, length: 17, target: 'value' } });
  });
  it('locates enrichment errors with email-shaped identifiers through the shared scanner', () => {
    const value = 'Read {{data.enrichment.contact.bob@example.com.not_a_topic}}';
    const issues = validateRecipe(recipe(value)).issues.filter(issue => issue.reference_span);
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue.path).toBe('steps[0].template');
      expect(value.slice(issue.reference_span!.offset, issue.reference_span!.offset + issue.reference_span!.length)).toBe('{{data.enrichment.contact.bob@example.com.not_a_topic}}');
    }
  });
  it('locates the first forward dependency at the offending string while retaining the edge count', () => {
    const body = recipe('{{step.later}} and {{step.later}}');
    body.steps.push({ id: 'later', transform: 'template', template: 'later' });
    const issues = validateRecipe(body).issues.filter(issue => issue.code === 'forward_step_ref');
    expect(issues).toHaveLength(1); expect(issues[0]).toMatchObject({ path: 'steps[0].template', reference_span: { offset: 0, length: 14, target: 'value' } });
  });
  it('declines a range crossing JSON string boundaries instead of attributing it to another value', () => {
    const value = { left: '{{', right: '{{config.missing}}' }, serialized = JSON.stringify(value), locate = referenceLocations(value, serialized);
    const start = serialized.indexOf('{{'), end = serialized.lastIndexOf('}}') + 2;
    expect(locate(start, end - start)).toBeUndefined();
    const actual = serialized.lastIndexOf('{{'); expect(locate(actual, 18)).toMatchObject({ path: 'right', reference_span: { target: 'value' } });
  });
  it('bounds paths before repeating a large ancestor key across many reference findings', () => {
    const body = recipe('hi'), payload = { ['x'.repeat(100_000)]: Array.from({ length: 1000 }, () => '{{config.missing}}') };
    const issues = validateRecipe({ ...body, steps: [{ ...body.steps[0], payload }] }).issues.filter(issue => issue.code === 'undeclared_variable_ref');
    expect(issues).toHaveLength(1000); expect(issues.every(issue => issue.path === 'steps[0].payload' && issue.reference_span === undefined)).toBe(true);
  });
});
