import { describe, expect, it, vi } from 'vitest';
import type { RecipeDefinition, StepMeta } from '@recued/contracts';
import { PreflightRequiredSignal } from '@recued/contracts';
import { executeRecipe } from '../execute.js';
import { resumeFromApproval } from '../resume-from-approval.js';
import type { ExecutionContext } from '../types.js';

const recipe = (overrides: Partial<RecipeDefinition> = {}): RecipeDefinition => ({
  recipe_id: 'reviewed', version: 1, ttl: 300,
  metadata: { name: 'Reviewed', description: '', author: 'test', supported_platforms: [] },
  variables: {}, prefetch_steps: [], steps: [], output: { sidebar: [] }, ...overrides,
});
const context = (definition: RecipeDefinition): ExecutionContext => ({
  recipe: definition, stores: { vault: {}, config: {}, context: {}, meta: {}, step: {} },
  ingredientExecutor: async () => ({}),
  preapprovalAddressing: {
    recipe_path: [{ kind: 'recipe', recipe_id: 'reviewed', publisher_id: 'test', definition_hash: 'sha256:reviewed' }],
    phase: 'sequential', iteration_indices: [],
  },
});

describe('D-261 actual runner occurrence and qualification boundary', () => {
  it('resumes the exact ordinary watcher hold before claiming, preserving prior watcher outputs', async () => {
    const definition = recipe({ auto_run: { interval_ms: 60_000 }, trigger_steps: [
      { id: 'first', ingredient: 'first' }, { id: 'gate', ingredient: 'watch' },
    ], prefetch_steps: [{ id: 'prefetch', ingredient: 'read' }], steps: [{ id: 'send', ingredient: 'send' }] });
    const calls: string[] = [];
    let claims = 0;
    const run = (resume?: NonNullable<Awaited<ReturnType<typeof executeRecipe>>['awaiting_approval']>) => {
      const ctx = context(definition); delete ctx.preapprovalAddressing;
      if (resume) { ctx.resumeFrom = resumeFromApproval(resume); ctx.stores.step = structuredClone(resume.step_state); }
      ctx.afterTriggerQualification = async () => { claims++; expect(ctx.stores.trigger?.first).toEqual({ cursor: 42 }); };
      ctx.ingredientExecutor = async (slug, _in, _out, _options, meta) => {
        if (slug === 'watch' && !meta?.preflight_admitted) throw new PreflightRequiredSignal('Review this poll.');
        calls.push(slug); if (slug !== 'watch') expect(meta?.preflight_admitted).toBeUndefined();
        return { should_run: true, cursor: 42 };
      };
      return executeRecipe(ctx);
    };
    const held = await run();
    expect(held.awaiting_approval).toMatchObject({ gated_step_id: 'gate', execution_phase: 'trigger', trigger_state: { first: { cursor: 42 } } });
    expect(claims).toBe(0); expect(calls).toEqual(['first']);
    expect((await run(held.awaiting_approval)).success).toBe(true);
    expect(calls).toEqual(['first', 'watch', 'read', 'send']); expect(claims).toBe(1);
  });

  it('resumes parallel prefetch holds without repeating completed reads, including an optional gated read', async () => {
    const definition = recipe({ prefetch_steps: [
      { id: 'a', ingredient: 'a', optional: true }, { id: 'b', ingredient: 'b' }, { id: 'c', ingredient: 'c' },
    ], steps: [{ id: 'send', ingredient: 'send' }] });
    const calls: string[] = [];
    let claims = 0;
    const run = (resume?: NonNullable<Awaited<ReturnType<typeof executeRecipe>>['awaiting_approval']>) => {
      const ctx = context(definition); delete ctx.preapprovalAddressing;
      if (resume) { ctx.resumeFrom = resumeFromApproval(resume); ctx.stores.step = structuredClone(resume.step_state); }
      ctx.afterTriggerQualification = async () => { claims++; };
      ctx.ingredientExecutor = async (slug, _in, _out, _options, meta) => {
        if (['a', 'c'].includes(slug) && !meta?.preflight_admitted) throw new PreflightRequiredSignal('Review this read.');
        calls.push(slug); return { value: slug };
      };
      return executeRecipe(ctx);
    };
    const first = await run();
    expect(first.awaiting_approval).toMatchObject({ gated_step_id: 'a', execution_phase: 'prefetch', prefetch_completed: ['b'] });
    const second = await run(first.awaiting_approval);
    expect(second.awaiting_approval).toMatchObject({ gated_step_id: 'c', execution_phase: 'prefetch', prefetch_completed: ['b', 'a'] });
    const done = await run(second.awaiting_approval); expect(done.success).toBe(true);
    expect(calls).toEqual(['b', 'a', 'c', 'send']); expect(claims).toBe(1);
  });

  it('does not transfer a watcher approval to a sequential step with the same id', async () => {
    const ctx = context(recipe({ auto_run: { interval_ms: 60_000 },
      trigger_steps: [{ id: 'same', ingredient: 'watch' }], steps: [{ id: 'same', ingredient: 'send' }] }));
    ctx.resumeFrom = { gated_step_id: 'same', execution_phase: 'trigger' };
    ctx.ingredientExecutor = async (_slug, _in, _out, _options, meta) => {
      if (!meta?.preflight_admitted) throw new PreflightRequiredSignal(); return { should_run: true };
    };
    const held = await executeRecipe(ctx);
    expect(held.awaiting_approval).toBeDefined();
    expect(held.awaiting_approval?.execution_phase).toBeUndefined();
  });

  it('installs a newly claimed host run into the actual engine context before prefetch', async () => {
    const ctx = context(recipe({ auto_run: { interval_ms: 60_000 },
      trigger_steps: [{ id: 'qualify', ingredient: 'watch' }],
      prefetch_steps: [{ id: 'fetch', ingredient: 'read' }], steps: [{ id: 'send', ingredient: 'send' }],
    }));
    const addressing = ctx.preapprovalAddressing!;
    delete ctx.preapprovalAddressing;
    const order: string[] = [];
    const paths: Array<StepMeta['invocation_path']> = [];
    ctx.ingredientExecutor = async (slug, _input, _output, options, meta) => {
      order.push(slug); paths.push(meta?.invocation_path);
      if (slug !== 'watch') expect(options?.cache).toBe('fresh');
      return { should_run: true };
    };
    ctx.afterTriggerQualification = async () => {
      order.push('claim');
      return { preapprovalAddressing: addressing, reviewedExecution: {
        invoke: async (call, dispatch) => { order.push(`member:${call.slug}`); return dispatch(); },
        catalogApproved: async () => false, delegate: async (_call, dispatch) => dispatch(),
      } };
    };
    expect((await executeRecipe(ctx)).success).toBe(true);
    expect(order).toEqual(['watch', 'claim', 'member:read', 'read', 'member:send', 'send']);
    expect(paths[0]).toBeUndefined();
    expect(paths.slice(1).map(path => path?.[1])).toEqual([
      { kind: 'step', phase: 'prefetch', step_id: 'fetch' }, { kind: 'step', phase: 'sequential', step_id: 'send' },
    ]);
  });
  it('claims only after qualification and before any prefetch or sequential call', async () => {
    const ctx = context(recipe({ auto_run: { interval_ms: 60_000 },
      trigger_steps: [{ id: 'qualify', ingredient: 'watch' }],
      prefetch_steps: [{ id: 'fetch', ingredient: 'read' }],
      steps: [{ id: 'send', ingredient: 'send' }],
    }));
    const calls: Array<{ slug: string; meta?: StepMeta; cache?: string }> = [];
    const order: string[] = [];
    ctx.ingredientExecutor = async (slug, _input, _output, options, meta) => {
      order.push(slug); calls.push({ slug, meta, cache: options?.cache });
      return { should_run: true };
    };
    ctx.afterTriggerQualification = async () => { order.push('claim'); };
    expect((await executeRecipe(ctx)).success).toBe(true);
    expect(order).toEqual(['watch', 'claim', 'read', 'send']);
    expect(calls.map(({ meta }) => meta?.invocation_path?.[1])).toEqual([
      { kind: 'step', phase: 'trigger', step_id: 'qualify' },
      { kind: 'step', phase: 'prefetch', step_id: 'fetch' },
      { kind: 'step', phase: 'sequential', step_id: 'send' },
    ]);
    expect(calls.every(({ cache }) => cache === 'fresh')).toBe(true);
    expect(ctx.preapprovalAddressing?.phase).toBe('sequential');
  });

  it('does not consume an occurrence on a nonqualifying watch tick', async () => {
    const ctx = context(recipe({ auto_run: { interval_ms: 60_000 },
      trigger_steps: [{ id: 'qualify', ingredient: 'watch' }],
      prefetch_steps: [{ id: 'fetch', ingredient: 'read' }],
    }));
    const claim = vi.fn(async () => {});
    const invoke = vi.fn(async () => ({ should_run: false }));
    ctx.afterTriggerQualification = claim;
    ctx.ingredientExecutor = invoke;
    expect((await executeRecipe(ctx)).trigger_skipped).toBe(true);
    expect(claim).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('fails before dispatch if the qualified occurrence loses its claim', async () => {
    const ctx = context(recipe({ prefetch_steps: [{ id: 'fetch', ingredient: 'read' }] }));
    const invoke = vi.fn(async () => ({}));
    ctx.ingredientExecutor = invoke;
    ctx.afterTriggerQualification = async () => { throw new Error('PREAPPROVAL_ALREADY_CLAIMED'); };
    await expect(executeRecipe(ctx)).rejects.toThrow('PREAPPROVAL_ALREADY_CLAIMED');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('gives identical foreach arguments distinct occurrences and restores the enclosing path on errors', async () => {
    const ctx = context(recipe({ steps: [
      { id: 'each', ingredient: 'send', foreach: '{{config.targets}}', input: { to: '{{item}}' } },
      { id: 'after', ingredient: 'read' },
    ] }));
    ctx.stores.config.targets = ['same', 'same'];
    const paths: Array<StepMeta['invocation_path']> = [];
    ctx.ingredientExecutor = async (_slug, _input, _output, _options, meta) => {
      paths.push(meta?.invocation_path);
      if (paths.length === 1) throw new Error('first iteration fails');
      return {};
    };
    await executeRecipe(ctx);
    expect(paths.map((path) => path?.slice(1))).toEqual([
      [{ kind: 'step', phase: 'sequential', step_id: 'each' }, { kind: 'iteration', index: 0 }],
      [{ kind: 'step', phase: 'sequential', step_id: 'each' }, { kind: 'iteration', index: 1 }],
      [{ kind: 'step', phase: 'sequential', step_id: 'after' }],
    ]);
    expect(ctx.preapprovalAddressing?.iteration_indices).toEqual([]);
  });

  it('does not trust a public context value to confer host addressing', async () => {
    const ctx = context(recipe({ steps: [{ id: 'read', ingredient: 'read', cache: 'any' }] }));
    delete ctx.preapprovalAddressing;
    ctx.stores.context.preapprovalAddressing = { recipe_path: [], phase: 'sequential', iteration_indices: [] };
    const invoke = vi.fn(async () => ({}));
    ctx.ingredientExecutor = invoke;
    await executeRecipe(ctx);
    const call = invoke.mock.calls[0] as unknown as Parameters<ExecutionContext['ingredientExecutor']>;
    expect(call[3]?.cache).toBe('any');
    expect(call[4]?.invocation_path).toBeUndefined();
  });
});
