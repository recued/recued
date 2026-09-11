import { describe, expect, it } from 'vitest';
import type { RecipeDefinition, RecipeStep } from '@recued/contracts';
import { simulateRecipe } from '../recipe-simulation.js';

const recipe = (steps: RecipeStep[], overrides: Partial<RecipeDefinition> = {}): RecipeDefinition => ({
  recipe_id: 'simulation', version: 1, ttl: 0,
  metadata: { name: 'Simulation', description: '', author: '', supported_platforms: [] },
  variables: {}, prefetch_steps: [], output: { render: [] }, steps, ...overrides,
});

describe('Kitchen simulation with the real step engine', () => {
  it('bounds accumulated trace data even when every individual step is small enough', async () => {
    const definition = recipe(Array.from({ length: 15 }, (_, index) => ({
      id: `copy${index}`, transform: 'coalesce', values: ['{{config.payload}}', index],
    })));
    await expect(simulateRecipe(definition, { config: { payload: 'x'.repeat(900_000) } }))
      .rejects.toThrow('Sample results exceed 2 MB');
  });
  it('bounds repeated prefetch inputs and mocked loop traces', async () => {
    const payload = 'x'.repeat(700_000);
    await expect(simulateRecipe(recipe([], {
      prefetch_steps: ['a', 'b', 'c'].map(id => ({ id, ingredient: 'read', input: { payload: '{{config.payload}}' } })),
    }), { config: { payload }, mocks: { a: { result: [] }, b: { result: [] }, c: { result: [] } } }))
      .rejects.toThrow('Sample results exceed 2 MB');
    const result = await simulateRecipe(recipe([
      { id: 'loop', op: 'core.records.create', args: { payload: '{{config.payload}}' }, foreach: '{{config.items}}' },
    ]), { config: { payload, items: [1, 2, 3, 4] }, mocks: { loop: { result: true } } });
    expect(result.status).toBe('failed');
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(2_000_000);
  });
  it('limits repeated mock outputs before a loop retains all its results', async () => {
    const result = await simulateRecipe(recipe([
      { id: 'loop', op: 'core.records.list', args: {}, foreach: '{{config.items}}' },
    ]), { config: { items: Array.from({ length: 20 }, (_, index) => index) },
      mocks: { loop: { result: 'x'.repeat(700_000) } } });
    expect(result.status).toBe('failed');
    expect(JSON.stringify(result.steps[0].output)).toContain('Sample results exceed 2 MB');
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(2_000_000);
  });
  it('populates recipe metadata before resolving inputs', async () => {
    const result = await simulateRecipe(recipe([
      { id: 'info', transform: 'coalesce', values: ['{{meta.recipe_id}}', 'missing'] },
      { id: 'name', transform: 'coalesce', values: ['{{meta.name}}', 'missing'] },
    ]), {});
    expect(result.steps.map(step => step.output)).toEqual(['simulation', 'Simulation']);
  });
  it('finishes independent prefetch calls even when another prefetch fails', async () => {
    const result = await simulateRecipe(recipe([{ id: 'later', transform: 'count', input: [] }], {
      prefetch_steps: [
        { id: 'missing', ingredient: 'read', input: {} },
        { id: 'available', ingredient: 'read', input: {} },
      ],
    }), { mocks: { available: { result: [42] } } });
    expect(result.status).toBe('failed');
    expect(result.steps.map(step => step.status)).toEqual(['failed', 'passed', 'blocked']);
    expect(result.steps[1].output).toEqual([42]);
  });
  it('honors cancellation during the last step yield', async () => {
    const controller = new AbortController();
    const pending = simulateRecipe(recipe([{ id: 'last', transform: 'count', input: [] }]), {}, controller.signal);
    setTimeout(() => controller.abort(), 0);
    await expect(pending).rejects.toThrow();
  });
  it('distinguishes an optional mocked failure from an omitted fixture', async () => {
    const definition = recipe([{ id: 'fallback', transform: 'coalesce', values: ['{{step.read}}', 'fallback'] }], {
      prefetch_steps: [{ id: 'read', ingredient: 'external-read', input: {}, optional: true }],
    });
    const failedRead = await simulateRecipe(definition, { mocks: { read: { error: 'Offline' } } });
    expect(failedRead.status).toBe('passed');
    expect(failedRead.steps[1].output).toBe('fallback');
    expect((await simulateRecipe(definition, {})).status).toBe('failed');
  });
  it('mocks external reads and writes while executing dependent transforms and conditions', async () => {
    const result = await simulateRecipe(recipe([
      { id: 'read', op: 'core.records.list', args: {} },
      { id: 'filter', transform: 'filter', array: '{{step.read}}', field: 'amount', operator: 'greater', value: 10 },
      { id: 'write', op: 'core.records.create', args: { rows: '{{step.filter}}' } },
      { id: 'skip', transform: 'count', input: '{{step.read}}', skip_when: '{{step.filter}} is_empty' },
    ]), { mocks: { read: { result: [{ amount: 5 }, { amount: 20 }] }, write: { result: { id: 'mock' } } } });
    expect(result.status).toBe('passed');
    expect(result.steps[1].output).toEqual([{ amount: 20 }]);
    expect(result.steps[2]).toMatchObject({ mocked: true, input: { rows: [{ amount: 20 }] }, output: { id: 'mock' } });
    expect(result.steps[3]).toMatchObject({ status: 'passed', output: 2 });
  });
  it('reports missing fixtures and blocks dependent steps, including direct catalog ingredients', async () => {
    const result = await simulateRecipe(recipe([
      { id: 'catalog', ingredient: 'catalog-fetch', input: { operation: 'send' } },
      { id: 'later', transform: 'count', input: [] },
    ]), {});
    expect(result.status).toBe('failed');
    expect(result.steps[0].message).toContain('Supply a mock result');
    expect(result.steps[1].status).toBe('blocked');
  });
  it('preserves item templates inside map and project', async () => {
    const result = await simulateRecipe(recipe([
      { id: 'project', transform: 'map', array: [{ amount: 2 }, { amount: 3 }], expression: { value: '{{item.amount}}', label: '{{config.label}}' } },
    ], { variables: { label: 'Amount' } }), {});
    expect(result.steps[0].output).toEqual([{ value: 2, label: 'Amount' }, { value: 3, label: 'Amount' }]);
  });
  it('honors trigger qualification and the trigger namespace', async () => {
    const definition = recipe([{ id: 'copy', transform: 'coalesce', values: ['{{trigger.gate.value}}'] }], {
      auto_run: { interval_ms: 1000 }, trigger_steps: [{ id: 'gate', ingredient: 'watch', input: {} }],
    });
    const gated = await simulateRecipe(definition, { mocks: { gate: { result: { should_run: false } } } });
    expect(gated.status).toBe('gated'); expect(gated.steps[1].status).toBe('blocked');
    const passed = await simulateRecipe(definition, { mocks: { gate: { result: { should_run: true, value: 42 } } } });
    expect(passed.steps[1].output).toBe(42);
  });
  it('evaluates foreach with per-item fixtures and reports partial failure', async () => {
    const definition = recipe([{ id: 'write', op: 'core.records.create', args: { value: '{{item.id}}' }, foreach: '{{config.items}}' }], {
      variables: { items: null },
    });
    const result = await simulateRecipe(definition, {
      config: { items: [{ id: 'a' }, { id: 'b' }] },
      mocks: { write: { iterations: [{ id: 'new-a' }] } },
    });
    expect(result.status).toBe('failed');
    expect(result.steps[0].input).toEqual([{ value: 'a' }, { value: 'b' }]);
    expect(result.steps[0].output).toEqual(expect.arrayContaining([expect.objectContaining({ ok: false })]));
  });
  it('does not run waits without fixtures and supports cancellation', async () => {
    const result = await simulateRecipe(recipe([{ id: 'wait', transform: 'wait', ms: 60000 }]), {});
    expect(result.status).toBe('failed');
    const controller = new AbortController(); controller.abort();
    await expect(simulateRecipe(recipe([{ id: 'x', transform: 'count', input: [] }]), {}, controller.signal)).rejects.toThrow();
  });

  it('bounds sample loops so tests can be cancelled between steps', async () => {
    const result = await simulateRecipe(recipe([
      { id: 'write', op: 'core.records.create', args: {}, foreach: '{{config.items}}' },
    ]), { config: { items: Array.from({ length: 1001 }, (_, id) => id) }, mocks: { write: { result: true } } });
    expect(result.status).toBe('failed');
    expect(result.steps[0].message).toContain('1,000 items');
  });
  it('shows skipped branches and guard failures', async () => {
    const result = await simulateRecipe(recipe([
      { id: 'skip', op: 'core.records.delete', args: {}, skip_when: '{{config.enabled}} equal false' },
      { id: 'guard', guard: '{{config.enabled}} equal false' },
    ], { variables: { enabled: false } }), {});
    expect(result.steps[0].status).toBe('skipped');
    expect(result.steps[1].status).toBe('failed');
  });
});
