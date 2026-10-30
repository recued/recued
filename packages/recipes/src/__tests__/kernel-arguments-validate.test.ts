import { describe, expect, it } from 'vitest';
import { validateRecipe } from '../validate.js';
import { parseCsvInspectInput, parseCsvTransformInput } from '@recued/contracts';
const recipe = (step: Record<string, unknown>) => ({ recipe_id: 'typed-kernel', version: 1, ttl: 0,
  metadata: { name: 'Typed kernel', author: 'local', supported_platforms: [] }, variables: { source: 'file:example', operation: 'filter', key: 'source' },
  steps: [{ id: 'result', ...step }] as Record<string, unknown>[], prefetch_steps: [], output: { render: [{ type: 'json', source: 'step.result' }] } });
const findings = (body: unknown) => validateRecipe(body).issues.filter(issue => issue.code.startsWith('kernel_argument_'));
describe('explicit kernel argument admission', () => {
  it('rejects missing required arguments and wrong literal types in every step phase', () => {
    for (const group of ['steps', 'prefetch_steps', 'trigger_steps']) for (const args of [{}, { source: 42 }, null]) {
      const body = recipe({ op: 'core.storage.csv.inspect', args }); Object.assign(body, { steps: [], [group]: [{ id: 'result', op: 'core.storage.csv.inspect', args }] });
      expect(findings(body).map(issue => [issue.code, issue.path])).toEqual([[args === null || 'source' in args ? 'kernel_argument_type' : 'kernel_argument_required', args === null ? `${group}[0].args` : `${group}[0].args.source`]]);
    }
  });
  it('checks literal enum choices, nested types, ranges and declared array bounds', () => {
    const body = recipe({ op: 'core.storage.csv.transform', args: { source: 'file:example', operation: 'sort', by: [{ column: 'amount', direction: 'sideways' }], offset: -1, limit: 'many' } });
    expect(findings(body).map(issue => [issue.code, issue.path])).toEqual([
      ['kernel_argument_enum', 'steps[0].args.by[0].direction'], ['kernel_argument_range', 'steps[0].args.offset'], ['kernel_argument_type', 'steps[0].args.limit'],
    ]);
    body.steps[0] = { id: 'result', op: 'core.storage.csv.transform', args: { source: 'file:example', operation: 'filter', conditions: [] } };
    expect(findings(body).map(issue => issue.code)).toEqual(['kernel_argument_items']);
  });
  it('defers reference values and dynamic variant keys while still checking known literal fields', () => {
    const dynamic = recipe({ op: 'core.storage.csv.transform', args: { source: '{{config.source}}', operation: '{{config.operation}}', conditions: '{{config.conditions}}' } });
    expect(findings(dynamic)).toEqual([]);
    dynamic.steps[0] = { id: 'result', op: 'core.storage.csv.inspect', args: { '{{config.key}}': 'file:example' } }; expect(findings(dynamic)).toEqual([]);
    dynamic.steps[0] = { id: 'result', op: 'core.storage.csv.inspect', args: { source: '{{config.source}}', preview_rows: false } };
    expect(findings(dynamic).map(issue => issue.path)).toEqual(['steps[0].args.preview_rows']);
  });
  it('closes only explicit argument objects and preserves legacy hint-only declarations and opaque payloads', () => {
    expect(findings(recipe({ op: 'core.storage.csv.inspect', args: { source: 'file:example', surce: 'other' } })).map(issue => issue.code)).toEqual(['kernel_argument_unknown']);
    expect(findings(recipe({ op: 'core.ai.classify', args: { 'llm.id_field': 42 } }))).toEqual([]);
    expect(findings(recipe({ transform: 'template', template: 'ready', payload: { op: 'core.storage.csv.inspect', args: { source: 42 } } }))).toEqual([]);
  });
  it('accepts representative literal inputs that the runtime CSV parsers also admit', () => {
    const inspect = { source: 'file:example', preview_rows: 0 };
    const transform = { source: 'file:example', operation: 'filter', conditions: [{ column: 'status', operator: 'eq', value: 'open' }] };
    expect(() => parseCsvInspectInput(inspect)).not.toThrow(); expect(() => parseCsvTransformInput(transform)).not.toThrow();
    expect(findings(recipe({ op: 'core.storage.csv.inspect', args: inspect }))).toEqual([]);
    expect(findings(recipe({ op: 'core.storage.csv.transform', args: transform }))).toEqual([]);
  });
});
