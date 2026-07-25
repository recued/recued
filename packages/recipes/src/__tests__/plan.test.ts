import { describe, it, expect } from 'vitest';
import { planExecution, isPlanCurrent } from '../plan.js';
import { hashRecipe } from '../canonical.js';

// ────────────────────────────────────────────────────────────────
// Fixture — realistic recipe with mixed step kinds
// ────────────────────────────────────────────────────────────────

const sampleRecipe = {
  recipe_id: 'detect-deal-risk-hubspot',
  version: 1,
  ttl: 300,
  metadata: {
    name: 'Deal Risk',
    description: 'A test recipe fixture for the execution plan builder.',
    author: 'recued-core',
    supported_platforms: ['hubspot'],
    tags: ['test', 'plan', 'fixture'],
  },
  variables: { verbose: false },
  prefetch_steps: [
    { id: 'deal', ingredient: 'deal-reader-hubspot', input: {} },
    { id: 'contacts', ingredient: 'contacts-reader-hubspot', input: {} },
  ],
  steps: [
    { id: 'days_since', transform: 'date_diff',
      from: '{{step.deal.created_at}}', to: 'now', unit: 'days' },
    { id: 'enough_data', guard: '{{step.contacts}} is_not_empty' },
    { id: 'ai_summary', ingredient: 'ai-summarize',
      input: { 'llm.data': '{{step.days_since}}' },
      skip_when: '{{config.verbose}} equal false' },
  ],
  output: {
    sidebar: [
      { type: 'summary', source: 'step.days_since' },
      { type: 'ai_analysis', source: 'step.ai_summary.summary' },
    ],
  },
};

// ────────────────────────────────────────────────────────────────

describe('planExecution — basics', () => {
  const plan = planExecution(sampleRecipe);

  it('includes a recipe_hash matching hashRecipe output', () => {
    expect(plan.recipe_hash).toBe(hashRecipe(sampleRecipe));
    expect(plan.recipe_hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('prefetch_batch mirrors declared order', () => {
    expect(plan.prefetch_batch.map((s) => s.id)).toEqual(['deal', 'contacts']);
  });

  it('sequential_order mirrors declared order', () => {
    expect(plan.sequential_order.map((s) => s.id)).toEqual([
      'days_since', 'enough_data', 'ai_summary',
    ]);
  });

  it('every prefetch step is marked phase "prefetch"', () => {
    for (const s of plan.prefetch_batch) expect(s.phase).toBe('prefetch');
  });

  it('every sequential step is marked phase "sequential"', () => {
    for (const s of plan.sequential_order) expect(s.phase).toBe('sequential');
  });

  it('assigns correct declared index per phase', () => {
    expect(plan.prefetch_batch[0]).toMatchObject({ id: 'deal', index: 0 });
    expect(plan.prefetch_batch[1]).toMatchObject({ id: 'contacts', index: 1 });
    expect(plan.sequential_order[0]).toMatchObject({ id: 'days_since', index: 0 });
    expect(plan.sequential_order[1]).toMatchObject({ id: 'enough_data', index: 1 });
    expect(plan.sequential_order[2]).toMatchObject({ id: 'ai_summary', index: 2 });
  });

  it('discriminates step kind (ingredient/transform/guard)', () => {
    expect(plan.prefetch_batch[0].kind).toBe('ingredient');
    expect(plan.sequential_order[0].kind).toBe('transform');
    expect(plan.sequential_order[1].kind).toBe('guard');
    expect(plan.sequential_order[2].kind).toBe('ingredient');
  });

  it('populates depends_on from graph', () => {
    // days_since references {{step.deal}}
    expect(plan.sequential_order[0].depends_on).toEqual(['deal']);
    // enough_data references {{step.contacts}}
    expect(plan.sequential_order[1].depends_on).toEqual(['contacts']);
    // ai_summary references {{step.days_since}}
    expect(plan.sequential_order[2].depends_on).toEqual(['days_since']);
  });

  it('populates depended_by (reverse edges) for each node', () => {
    const byId = (id: string) =>
      [...plan.prefetch_batch, ...plan.sequential_order].find((s) => s.id === id);
    expect(byId('deal')?.depended_by).toEqual(['days_since']);
    expect(byId('contacts')?.depended_by).toEqual(['enough_data']);
    expect(byId('days_since')?.depended_by).toEqual(['ai_summary']);
  });

  it('extracts output_sources from output.sidebar', () => {
    expect(plan.output_sources).toEqual(['ai_summary', 'days_since']);
  });

  it('extracts output_sources from canonical output.render', () => {
    const renderRecipe = {
      ...sampleRecipe,
      output: {
        render: [
          { type: 'summary', source: 'step.days_since' },
          { type: 'ai_analysis', source: 'step.ai_summary.summary' },
        ],
      },
    };
    expect(planExecution(renderRecipe).output_sources).toEqual(['ai_summary', 'days_since']);
  });
});

// ────────────────────────────────────────────────────────────────
// Edge cases
// ────────────────────────────────────────────────────────────────

describe('planExecution — edge cases', () => {
  it('null input → empty plan with hash of null', () => {
    const plan = planExecution(null);
    expect(plan.prefetch_batch).toEqual([]);
    expect(plan.sequential_order).toEqual([]);
    expect(plan.output_sources).toEqual([]);
    expect(plan.recipe_hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('empty object → empty plan', () => {
    const plan = planExecution({});
    expect(plan.prefetch_batch).toEqual([]);
    expect(plan.sequential_order).toEqual([]);
    expect(plan.output_sources).toEqual([]);
  });

  it('recipe with no output → empty output_sources', () => {
    const plan = planExecution({
      steps: [{ id: 'a', transform: 'template', template: 'x' }],
    });
    expect(plan.output_sources).toEqual([]);
  });

  it('output section with non-step source is skipped', () => {
    const plan = planExecution({
      steps: [{ id: 'a', transform: 'template', template: 'x' }],
      output: {
        sidebar: [
          { type: 'text', source: 'config.title' },
          { type: 'summary', source: 'step.a' },
        ],
      },
    });
    expect(plan.output_sources).toEqual(['a']);
  });

  it('output source "step.X.deep.path" collapses to first segment', () => {
    const plan = planExecution({
      steps: [{ id: 'nested', transform: 'template', template: 'x' }],
      output: {
        sidebar: [{ type: 'summary', source: 'step.nested.deep.field' }],
      },
    });
    expect(plan.output_sources).toEqual(['nested']);
  });

  it('step with no discriminator is marked kind "unknown"', () => {
    const plan = planExecution({
      steps: [{ id: 'broken' } as unknown],
    });
    expect(plan.sequential_order[0].kind).toBe('unknown');
  });

  it('inherited discriminator fields do not determine step kind', () => {
    const step = Object.assign(
      Object.create({ ingredient: 'proto-reader' }),
      { id: 'broken' },
    ) as Record<string, unknown>;

    const plan = planExecution({ steps: [step] });

    expect(plan.sequential_order[0]).toMatchObject({
      id: 'broken',
      kind: 'unknown',
    });
  });

  it('inherited recipe step arrays and output sidebar are ignored', () => {
    const recipe = Object.create({
      steps: [{ id: 'proto_step', transform: 'template', template: 'x' }],
      output: { sidebar: [{ type: 'summary', source: 'step.proto_step' }] },
    }) as Record<string, unknown>;

    const plan = planExecution(recipe);

    expect(plan.sequential_order).toEqual([]);
    expect(plan.output_sources).toEqual([]);
  });

  it('malformed steps (not objects) are silently dropped from plan', () => {
    const plan = planExecution({
      prefetch_steps: [null, { id: 'good', ingredient: 'x' }],
      steps: ['bad', { id: 'seq', transform: 'template', template: 'x' }],
    });
    expect(plan.prefetch_batch.map((s) => s.id)).toEqual(['good']);
    expect(plan.sequential_order.map((s) => s.id)).toEqual(['seq']);
  });

  it('deduplicates output_sources across multiple sections', () => {
    const plan = planExecution({
      steps: [{ id: 'a', transform: 'template', template: 'x' }],
      output: {
        sidebar: [
          { type: 'summary', source: 'step.a' },
          { type: 'text', source: 'step.a' },
          { type: 'summary', source: 'step.a.detail' },
        ],
      },
    });
    expect(plan.output_sources).toEqual(['a']);
  });

  it('sorts output_sources for determinism', () => {
    const plan = planExecution({
      steps: [
        { id: 'zebra', transform: 'template', template: 'x' },
        { id: 'alpha', transform: 'template', template: 'x' },
      ],
      output: {
        sidebar: [
          { type: 'summary', source: 'step.zebra' },
          { type: 'summary', source: 'step.alpha' },
        ],
      },
    });
    expect(plan.output_sources).toEqual(['alpha', 'zebra']);
  });
});

// ────────────────────────────────────────────────────────────────
// isPlanCurrent
// ────────────────────────────────────────────────────────────────

describe('isPlanCurrent', () => {
  it('true when recipe has not changed', () => {
    const plan = planExecution(sampleRecipe);
    expect(isPlanCurrent(plan, sampleRecipe)).toBe(true);
  });

  it('true when recipe keys are reordered (canonical form is stable)', () => {
    const plan = planExecution(sampleRecipe);
    const reordered = {
      version: 1,
      recipe_id: sampleRecipe.recipe_id,
      ttl: sampleRecipe.ttl,
      steps: sampleRecipe.steps,
      output: sampleRecipe.output,
      metadata: sampleRecipe.metadata,
      variables: sampleRecipe.variables,
      prefetch_steps: sampleRecipe.prefetch_steps,
    };
    expect(isPlanCurrent(plan, reordered)).toBe(true);
  });

  it('false when recipe content changes', () => {
    const plan = planExecution(sampleRecipe);
    const modified = { ...sampleRecipe, ttl: 600 };
    expect(isPlanCurrent(plan, modified)).toBe(false);
  });

  it('false when a step is added', () => {
    const plan = planExecution(sampleRecipe);
    const modified = {
      ...sampleRecipe,
      steps: [
        ...sampleRecipe.steps,
        { id: 'new_step', transform: 'template', template: 'added' },
      ],
    };
    expect(isPlanCurrent(plan, modified)).toBe(false);
  });
});
