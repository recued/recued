import { describe, it, expect } from 'vitest';
import { buildStepGraph, findForwardReferences } from '../graph.js';
import { validateRecipe } from '../validate.js';

// ────────────────────────────────────────────────────────────────
// buildStepGraph
// ────────────────────────────────────────────────────────────────

describe('buildStepGraph — basics', () => {
  it('empty recipe → empty graph', () => {
    const g = buildStepGraph({});
    expect(g).toEqual({ nodes: {}, prefetch_ids: [], sequential_order: [] });
  });

  it('null / array / non-object → empty graph', () => {
    expect(buildStepGraph(null).nodes).toEqual({});
    expect(buildStepGraph([]).nodes).toEqual({});
    expect(buildStepGraph('string').nodes).toEqual({});
  });

  it('declares prefetch and sequential nodes with phase + index', () => {
    const g = buildStepGraph({
      prefetch_steps: [
        { id: 'a', ingredient: 'x', input: {} },
        { id: 'b', ingredient: 'y', input: {} },
      ],
      steps: [
        { id: 'c', transform: 'template', template: 'hi' },
        { id: 'd', transform: 'template', template: '{{step.c}}' },
      ],
    });
    expect(g.prefetch_ids).toEqual(['a', 'b']);
    expect(g.sequential_order).toEqual(['c', 'd']);
    expect(g.nodes.a).toMatchObject({ phase: 'prefetch', index: 0, depends_on: [] });
    expect(g.nodes.c).toMatchObject({ phase: 'sequential', index: 0, depends_on: [] });
    expect(g.nodes.d).toMatchObject({ phase: 'sequential', index: 1, depends_on: ['c'] });
  });

  it('dedupes depends_on for multi-reference to same step', () => {
    const g = buildStepGraph({
      prefetch_steps: [{ id: 'src', ingredient: 'x', input: {} }],
      steps: [
        { id: 'use', transform: 'template', template: '{{step.src}} and {{step.src}}' },
      ],
    });
    expect(g.nodes.use.depends_on).toEqual(['src']);
  });

  it('extracts refs from deeply nested fields', () => {
    const g = buildStepGraph({
      prefetch_steps: [
        { id: 'deal', ingredient: 'deal-reader', input: {} },
        { id: 'contacts', ingredient: 'contacts-reader', input: {} },
      ],
      steps: [
        { id: 'filtered', transform: 'filter',
          array: '{{step.contacts}}', field: 'x', operator: 'equal',
          value: '{{step.deal.amount}}' },
      ],
    });
    expect(g.nodes.filtered.depends_on).toEqual(['contacts', 'deal']);
  });

  it('ignores refs in the step\'s own id field', () => {
    // If someone wrote { id: 'step.x' }, the id shouldn't be parsed as a ref
    // (the id field is excluded before serialization)
    const g = buildStepGraph({
      prefetch_steps: [{ id: 'src', ingredient: 'x', input: {} }],
      steps: [{ id: 'self', transform: 'template', template: 'plain' }],
    });
    expect(g.nodes.self.depends_on).toEqual([]);
  });

  it('ignores path segments and format hints in refs', () => {
    const g = buildStepGraph({
      prefetch_steps: [{ id: 'deal', ingredient: 'x', input: {} }],
      steps: [
        { id: 'use', transform: 'template',
          template: '{{step.deal.nested.field:currency}}' },
      ],
    });
    expect(g.nodes.use.depends_on).toEqual(['deal']);
  });

  it('drops references to unknown step ids', () => {
    const g = buildStepGraph({
      steps: [
        { id: 'a', transform: 'template', template: '{{step.nonexistent}}' },
      ],
    });
    expect(g.nodes.a.depends_on).toEqual([]);
  });

  it('drops self-references from depends_on', () => {
    const g = buildStepGraph({
      steps: [
        { id: 'recursive', transform: 'template', template: '{{step.recursive.something}}' },
      ],
    });
    expect(g.nodes.recursive.depends_on).toEqual([]);
  });

  it('populates depended_by (reverse edges) sorted', () => {
    const g = buildStepGraph({
      prefetch_steps: [{ id: 'src', ingredient: 'x', input: {} }],
      steps: [
        { id: 'b', transform: 'template', template: '{{step.src}}' },
        { id: 'a', transform: 'template', template: '{{step.src}}' },
      ],
    });
    expect(g.nodes.src.depended_by).toEqual(['a', 'b']);
  });

  it('malformed steps (not objects) are silently skipped', () => {
    const g = buildStepGraph({
      prefetch_steps: [null, 'bad', { id: 'good', ingredient: 'x' }],
      steps: [undefined, { id: 'seq', transform: 'template', template: '{{step.good}}' }],
    });
    expect(Object.keys(g.nodes).sort()).toEqual(['good', 'seq']);
  });

  it('ignores inherited top-level step arrays', () => {
    const recipe = Object.create({
      prefetch_steps: [{ id: 'proto_prefetch', ingredient: 'x' }],
      steps: [{ id: 'proto_step', transform: 'template', template: 'x' }],
    }) as Record<string, unknown>;

    const g = buildStepGraph(recipe);

    expect(g.prefetch_ids).toEqual([]);
    expect(g.sequential_order).toEqual([]);
    expect(g.nodes).toEqual({});
  });

  it('ignores inherited step ids', () => {
    const inheritedIdStep = Object.assign(
      Object.create({ id: 'proto_id' }),
      { transform: 'template', template: 'x' },
    ) as Record<string, unknown>;

    const g = buildStepGraph({ steps: [inheritedIdStep] });

    expect(g.sequential_order).toEqual([]);
    expect(g.nodes).toEqual({});
  });

  it('duplicate ids keep the first declaration', () => {
    const g = buildStepGraph({
      steps: [
        { id: 'dupe', transform: 'template', template: 'first' },
        { id: 'dupe', transform: 'template', template: 'second' },
      ],
    });
    expect(g.sequential_order).toEqual(['dupe']);
  });

  it('keeps prototype-shaped step ids as declared own nodes', () => {
    const g = buildStepGraph({
      steps: [
        { id: '__proto__', transform: 'template', template: 'seed' },
        { id: 'constructor', transform: 'template', template: '{{step.__proto__}}' },
        { id: 'use', transform: 'template', template: '{{step.constructor}}' },
      ],
    });

    expect(Object.keys(g.nodes).sort()).toEqual(['__proto__', 'constructor', 'use']);
    expect(Object.prototype.hasOwnProperty.call(g.nodes, '__proto__')).toBe(true);
    expect(g.nodes['constructor'].depends_on).toEqual(['__proto__']);
    expect(g.nodes.use.depends_on).toEqual(['constructor']);
    expect(({} as Record<string, unknown>).seed).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// findForwardReferences
// ────────────────────────────────────────────────────────────────

describe('findForwardReferences', () => {
  it('valid backward-only recipe → no forward refs', () => {
    const g = buildStepGraph({
      prefetch_steps: [{ id: 'p1', ingredient: 'x', input: {} }],
      steps: [
        { id: 's1', transform: 'template', template: '{{step.p1}}' },
        { id: 's2', transform: 'template', template: '{{step.s1}}' },
        { id: 's3', transform: 'template', template: '{{step.s1}} {{step.s2}}' },
      ],
    });
    expect(findForwardReferences(g)).toEqual([]);
  });

  it('sequential step referencing later sequential step → forward ref', () => {
    const g = buildStepGraph({
      steps: [
        { id: 'early', transform: 'template', template: '{{step.later}}' },
        { id: 'later', transform: 'template', template: 'value' },
      ],
    });
    const forwards = findForwardReferences(g);
    expect(forwards.length).toBe(1);
    expect(forwards[0]).toMatchObject({
      from: 'early', to: 'later', from_index: 0, to_index: 1,
    });
  });

  it('prefetch step referencing another prefetch step → forward ref', () => {
    const g = buildStepGraph({
      prefetch_steps: [
        { id: 'a', ingredient: 'x', input: { fromB: '{{step.b}}' } },
        { id: 'b', ingredient: 'y', input: {} },
      ],
    });
    const forwards = findForwardReferences(g);
    expect(forwards.length).toBe(1);
    expect(forwards[0]).toMatchObject({ from: 'a', to: 'b' });
  });

  it('prefetch step referencing sequential step → forward ref', () => {
    const g = buildStepGraph({
      prefetch_steps: [
        { id: 'p', ingredient: 'x', input: { seq: '{{step.s}}' } },
      ],
      steps: [
        { id: 's', transform: 'template', template: 'value' },
      ],
    });
    const forwards = findForwardReferences(g);
    expect(forwards.length).toBe(1);
    expect(forwards[0]).toMatchObject({ from: 'p', to: 's' });
  });

  it('sequential step referencing prefetch step → NOT a forward ref', () => {
    const g = buildStepGraph({
      prefetch_steps: [{ id: 'deal', ingredient: 'x', input: {} }],
      steps: [
        { id: 's', transform: 'template', template: '{{step.deal.name}}' },
      ],
    });
    expect(findForwardReferences(g)).toEqual([]);
  });

  it('sequential step referencing earlier sequential step → NOT a forward ref', () => {
    const g = buildStepGraph({
      steps: [
        { id: 'first', transform: 'template', template: 'x' },
        { id: 'second', transform: 'template', template: '{{step.first}}' },
      ],
    });
    expect(findForwardReferences(g)).toEqual([]);
  });

  it('multiple forward refs sorted deterministically', () => {
    const g = buildStepGraph({
      steps: [
        { id: 's0', transform: 'template', template: '{{step.s2}} and {{step.s3}}' },
        { id: 's1', transform: 'template', template: '{{step.s2}}' },
        { id: 's2', transform: 'template', template: 'value' },
        { id: 's3', transform: 'template', template: 'other' },
      ],
    });
    const forwards = findForwardReferences(g);
    expect(forwards.length).toBe(3);
    expect(forwards.map((f) => `${f.from}→${f.to}`)).toEqual([
      's0→s2',
      's0→s3',
      's1→s2',
    ]);
  });

  it('prefetch forward refs sort before sequential forward refs', () => {
    const g = buildStepGraph({
      prefetch_steps: [
        { id: 'p1', ingredient: 'x', input: { other: '{{step.p2}}' } },
        { id: 'p2', ingredient: 'y', input: {} },
      ],
      steps: [
        { id: 'early', transform: 'template', template: '{{step.late}}' },
        { id: 'late', transform: 'template', template: 'value' },
      ],
    });
    const forwards = findForwardReferences(g);
    expect(forwards.length).toBe(2);
    expect(forwards[0]).toMatchObject({ from: 'p1', to: 'p2' });
    expect(forwards[1]).toMatchObject({ from: 'early', to: 'late' });
  });
});

// ────────────────────────────────────────────────────────────────
// Validator integration
// ────────────────────────────────────────────────────────────────

describe('validator: forward_step_ref integration', () => {
  const base = {
    recipe_id: 'test-recipe-hubspot',
    version: 1,
    ttl: 300,
    metadata: {
      name: 'Test Recipe',
      description: 'A minimal recipe for forward ref tests that is long enough.',
      author: 'test-suite',
      supported_platforms: ['hubspot'],
      variant_group: 'test-recipe',
      tags: ['test', 'fixture', 'forward'],
    },
    variables: {},
  };

  it('sequential forward ref → forward_step_ref error', () => {
    const recipe = {
      ...base,
      prefetch_steps: [{ id: 'data', ingredient: 'x-reader', input: {} }],
      steps: [
        { id: 'early', transform: 'template', template: '{{step.later}}' },
        { id: 'later', transform: 'template', template: '{{step.data}}' },
      ],
      output: { sidebar: [{ type: 'summary', source: 'step.early' }] },
    };
    const result = validateRecipe(recipe);
    const errors = result.issues.filter((i) => i.code === 'forward_step_ref');
    expect(errors.length).toBe(1);
    expect(errors[0].message).toMatch(/declared later/);
    expect(errors[0].path).toBe('steps[0]');
    expect(result.valid).toBe(false);
  });

  it('prefetch-to-prefetch ref → forward_step_ref error', () => {
    const recipe = {
      ...base,
      prefetch_steps: [
        { id: 'a', ingredient: 'x-reader', input: { fromB: '{{step.b}}' } },
        { id: 'b', ingredient: 'y-reader', input: {} },
      ],
      steps: [
        { id: 'use', transform: 'template', template: '{{step.a}} {{step.b}}' },
      ],
      output: { sidebar: [{ type: 'summary', source: 'step.use' }] },
    };
    const result = validateRecipe(recipe);
    const errors = result.issues.filter((i) => i.code === 'forward_step_ref');
    expect(errors.length).toBe(1);
    expect(errors[0].message).toMatch(/prefetch/i);
    expect(errors[0].path).toBe('prefetch_steps[0]');
  });

  it('prefetch referencing a sequential step → forward_step_ref error', () => {
    const recipe = {
      ...base,
      prefetch_steps: [
        { id: 'p', ingredient: 'x-reader', input: { seq: '{{step.s}}' } },
      ],
      steps: [
        { id: 's', transform: 'template', template: 'value' },
      ],
      output: { sidebar: [{ type: 'summary', source: 'step.s' }] },
    };
    const result = validateRecipe(recipe);
    const errors = result.issues.filter((i) => i.code === 'forward_step_ref');
    expect(errors.length).toBe(1);
    expect(errors[0].path).toBe('prefetch_steps[0]');
  });

  it('valid ordering (sequential → earlier seq or prefetch) → no forward_step_ref', () => {
    const recipe = {
      ...base,
      prefetch_steps: [{ id: 'deal', ingredient: 'x-reader', input: {} }],
      steps: [
        { id: 's1', transform: 'template', template: '{{step.deal.name}}' },
        { id: 's2', transform: 'template', template: '{{step.s1}}' },
      ],
      output: { sidebar: [{ type: 'summary', source: 'step.s2' }] },
    };
    const result = validateRecipe(recipe);
    expect(result.issues.filter((i) => i.code === 'forward_step_ref').length).toBe(0);
  });
});
