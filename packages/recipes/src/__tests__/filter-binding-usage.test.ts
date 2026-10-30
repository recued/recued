import { describe, expect, it } from 'vitest';
import { validateRecipe } from '../validate.js';
import { qualityPrecheck } from '../quality-precheck.js';

const recipe = () => ({ recipe_id: 'filter-usage', version: 1, ttl: 0,
  metadata: { name: 'Filter usage', author: 'local', supported_platforms: [] },
  variables: { 'status.code': { label: 'Status', type: 'text' }, cursor: '', unused: 'unused' },
  prefetch_steps: [], steps: [{ id: 'rows', transform: 'coalesce', values: [{ rows: [] }] }],
  output: { render: [{ type: 'filter', source: 'step.rows', fields: ['status.code'], hidden: ['cursor'], submit: 'Run' }] } });
const unused = (r: unknown) => ({
  canonical: validateRecipe(r).issues.filter(issue => issue.code === 'unused_variable').map(issue => issue.path),
  precheck: qualityPrecheck(r as Record<string, unknown>).filter(issue => issue.check === 'unused_variable').map(issue => issue.detail),
});

describe('filter binding variable usage', () => {
  it('counts literal visible and hidden bindings in both validators while retaining real unused variables', () => {
    const result = unused(recipe());
    expect(result.canonical).toEqual(['variables.unused']);
    expect(result.precheck).toEqual(["variable 'unused' declared but never referenced"]);
  });
  it('uses the active output container and ignores payload and overridden sidebar bindings', () => {
    const r = recipe(), filter = r.output.render;
    Object.assign(r.output, { sidebar: filter }); Object.assign(r.steps[0], { payload: { type: 'filter', fields: ['status.code'], hidden: ['cursor'], submit: 'Run' } });
    r.output.render = [];
    expect(unused(r).canonical).toEqual(['variables.status.code', 'variables.cursor', 'variables.unused']);
    expect(unused(r).precheck).toHaveLength(3);
    delete (r.output as { render?: unknown }).render;
    expect(unused(r).canonical).toEqual(['variables.unused']); expect(unused(r).precheck).toHaveLength(1);
    Object.assign(r.output, { render: null });
    expect(unused(r).canonical).toHaveLength(3); expect(unused(r).precheck).toHaveLength(3);
  });
});
