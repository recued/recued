/** D-157 P1 slice 3 — engine pause/resume mechanism.
 *
 *  Slice 3 builds the engine's capability to PAUSE on a preflight
 *  approval gate (when an `ingredientExecutor` throws
 *  `PreflightRequiredSignal`) and RESUME a paused run from a
 *  checkpoint past the gate. The gateway raising the signal on a real
 *  `'ask'` verdict + the `notification.ask` flow are slice 4; tests
 *  here raise the signal from a fixture executor.
 *
 *  Spec: D-157 § N.3 / A.2 / I-4 / I-6 / I-7 / TR-5.
 */

import { describe, it, expect } from 'vitest';
import {
  executeRecipe,
  loopAskedBeforeAnyItemRan,
  resumeFromApproval,
  type ExecutionContext,
  type IngredientExecutor,
} from '@recued/engine';
import {
  hashForeachCheckpointSource,
  PreflightRequiredSignal,
  isPreflightRequiredSignal,
} from '@recued/contracts';
import type { NamespaceStores, RecipeDefinition, RecipeStep } from '@recued/contracts';

const METADATA = {
  name: 'D-157 P1 Pause/Resume',
  description: 'Engine pause/resume mechanism',
  author: 'test',
  supported_platforms: ['test'],
};

const baseStores = (): NamespaceStores => ({
  vault: {},
  config: {},
  context: { entity_id: 'case-42' },
  meta: {},
  step: {},
});

const noopExec: IngredientExecutor = async () => null;

const makeRecipe = (steps: RecipeStep[], extras?: Partial<RecipeDefinition>): RecipeDefinition => ({
  recipe_id: 'd-157-p1-pause-resume',
  version: 1,
  ttl: 300,
  metadata: METADATA,
  variables: {},
  prefetch_steps: [],
  steps,
  output: { sidebar: [] },
  ...extras,
});

const makeCtx = (
  recipe: RecipeDefinition,
  ingredientExecutor: IngredientExecutor = noopExec,
  stores: NamespaceStores = baseStores(),
): ExecutionContext => ({ recipe, stores, ingredientExecutor });

const asSteps = (s: Array<Record<string, unknown>>): RecipeStep[] => s as unknown as RecipeStep[];

// Four-step recipe. The first two are pure transforms (head), then a
// `set` transform building the gated ingredient's input as a real
// object (so refs inside it resolve before reaching the executor), and
// the gated ingredient itself uses a string-ref `input` so the engine's
// `runIngredient` resolves the whole payload (see step-runner.ts —
// resolution applies to whole-input string refs only; object-shaped
// inputs pass through raw to the dispatch layer, which our fixture
// executor doesn't simulate). The D-159 fidelity test uses the same
// shape for the same reason.
const headSteps = asSteps([
  { id: 's1', transform: 'concat', values: ['hello', '-', '{{context.entity_id}}'] },
  { id: 's2', transform: 'concat', values: ['{{step.s1}}', '-after'] },
  {
    id: 'dispatch_payload',
    transform: 'set',
    source: { who: '{{step.s2}}' },
    field: 'tag',
    value: 'p3',
  },
]);
const tailSteps = asSteps([
  { id: 'gated_call', ingredient: 'gated-action', input: '{{step.dispatch_payload}}' },
  { id: 's4', transform: 'concat', values: ['done:', '{{step.gated_call.echo}}'] },
]);
const fullSteps: RecipeStep[] = [...headSteps, ...tailSteps];

describe('D-157 P1 slice 3 — PreflightRequiredSignal contract', () => {
  it('isPreflightRequiredSignal recognises instances and name-only shapes', () => {
    const live = new PreflightRequiredSignal('detail');
    expect(isPreflightRequiredSignal(live)).toBe(true);
    expect(live.name).toBe('PreflightRequiredSignal');
    expect(live.message).toBe('detail');

    // Cross-realm safety — a serialized/reconstructed object that
    // carries the marker name still matches (vs. `instanceof` which
    // fails when realms / bundles differ). This is why the guard is
    // name-based.
    const reconstituted = { name: 'PreflightRequiredSignal', message: 'fake' };
    expect(isPreflightRequiredSignal(reconstituted)).toBe(true);

    // Non-matching shapes
    expect(isPreflightRequiredSignal(new Error('oops'))).toBe(false);
    expect(isPreflightRequiredSignal({ name: 'OtherError' })).toBe(false);
    expect(isPreflightRequiredSignal(null)).toBe(false);
    expect(isPreflightRequiredSignal(undefined)).toBe(false);
    expect(isPreflightRequiredSignal('string')).toBe(false);
  });
});

describe('D-157 P1 slice 3 — engine pause (I-4)', () => {
  it('paused run returns awaiting_approval and ends the execution', async () => {
    const calls: string[] = [];
    const gatingExec: IngredientExecutor = async (slug) => {
      calls.push(slug);
      if (slug === 'gated-action') throw new PreflightRequiredSignal();
      return null;
    };
    const ctx = makeCtx(makeRecipe(fullSteps), gatingExec);
    const result = await executeRecipe(ctx);

    expect(result.success).toBe(false);
    expect(result.errors).toEqual([]);
    expect(result.awaiting_approval).toBeDefined();
    expect(result.awaiting_approval!.gated_step_id).toBe('gated_call');
    // step_state carries pre-gate step OUTPUTS, and never a step after the gate.
    expect(result.awaiting_approval!.step_state).toHaveProperty('s1');
    expect(result.awaiting_approval!.step_state).toHaveProperty('s2');
    expect(result.awaiting_approval!.step_state).toHaveProperty('dispatch_payload');
    expect(result.awaiting_approval!.step_state).not.toHaveProperty('s4');
    // ⚠ THE GATED STEP NOW CARRIES ITS RESOLVED INPUT, and this assertion was
    // INVERTED deliberately — it previously read `.not.toHaveProperty`.
    //
    // That was true only of the simple-form branch. The catalog branch has
    // captured `{ input: resolvedArgs }` here since the D-173 capstone, because
    // without it a HOLD's checkpoint has no record of what the step was about
    // to run with and the Reception Inbox renders an empty prefill. Every
    // kernel op lowers to the simple-form branch, so the MAJORITY path was the
    // one missing it — `d-192-e3`'s held commitment proposal offered the owner
    // edit fields for `counterparty_contact_id` / `statement` while showing no
    // values in them.
    //
    // Surfacing them is settled: `InboxItem.args` is contracted as "concrete
    // values — what the held op will dispatch", `InboxItem.preview` is the
    // field carrying the I-3 redaction obligation, and the owner ruled that the
    // list lays out full detail because no one can know in advance which fields
    // a given business needs in order to approve.
    //
    // What is recorded is an INPUT, never an output: the step has not run, and
    // on resume it re-runs and overwrites this transient capture. Resume is
    // driven by `gated_step_id` via `findIndex`, NOT by step_state presence, so
    // the extra key cannot cause a step to be skipped.
    expect(result.awaiting_approval!.step_state).toHaveProperty('gated_call');
    expect(result.awaiting_approval!.step_state.gated_call).toEqual({
      input: { who: 'hello-case-42-after', tag: 'p3' },
    });
    // The gating ingredient was reached exactly once; no step after it ran
    expect(calls).toEqual(['gated-action']);
    // step logs: only pre-gate steps logged (the gated step threw before
    // a StepLog was produced, the post-gate step never ran)
    expect(result.steps.map((s) => s.id)).toEqual(['s1', 's2', 'dispatch_payload']);
  });

  it('paused step_state is a structured clone — mutating it does not touch ctx.stores.step', async () => {
    const gatingExec: IngredientExecutor = async (slug) => {
      if (slug === 'gated-action') throw new PreflightRequiredSignal();
      return null;
    };
    const ctx = makeCtx(makeRecipe(fullSteps), gatingExec);
    const result = await executeRecipe(ctx);

    expect(result.awaiting_approval).toBeDefined();
    // Mutate the snapshot — ctx.stores.step must remain intact for
    // the host to read directly if it wants to.
    (result.awaiting_approval!.step_state as Record<string, unknown>).s1 = 'mutated';
    expect((ctx.stores.step as Record<string, unknown>).s1).not.toBe('mutated');
  });

  it('a gate on the first sequential step yields empty step_state', async () => {
    const oneStep = asSteps([{ id: 'gated_first', ingredient: 'gated-action' }]);
    const gatingExec: IngredientExecutor = async () => {
      throw new PreflightRequiredSignal();
    };
    const ctx = makeCtx(makeRecipe(oneStep), gatingExec);
    const result = await executeRecipe(ctx);

    expect(result.awaiting_approval).toBeDefined();
    expect(result.awaiting_approval!.gated_step_id).toBe('gated_first');
    expect(result.awaiting_approval!.step_state).toEqual({});
  });
});

describe('D-157 P1 slice 3 — engine resume (I-6, TR-5)', () => {
  it('resumes from gated_step_id with seeded step.* — no pre-gate step re-runs', async () => {
    // Pause phase: gate on `gated_call`.
    const pauseCalls: string[] = [];
    const pauseCtx = makeCtx(
      makeRecipe(fullSteps),
      async (slug) => {
        pauseCalls.push(slug);
        if (slug === 'gated-action') throw new PreflightRequiredSignal();
        return null;
      },
    );
    const paused = await executeRecipe(pauseCtx);
    expect(paused.awaiting_approval).toBeDefined();

    // Resume phase: a different executor that dispatches successfully.
    // It receives the RESOLVED dispatch_payload (the engine resolves
    // whole-input string refs in `runIngredient`) and echoes a value
    // a downstream step can verify.
    const resumeCalls: Array<{ slug: string; input: unknown }> = [];
    const resumeExec: IngredientExecutor = async (slug, input) => {
      resumeCalls.push({ slug, input });
      return { echo: (input as Record<string, unknown>)?.who ?? 'unknown' };
    };
    // Host's job: seed step.* from the checkpoint, set resumeFrom.
    const resumeStores = baseStores();
    (resumeStores.step as Record<string, unknown>) = structuredClone(
      paused.awaiting_approval!.step_state,
    );
    const resumeCtx: ExecutionContext = {
      recipe: makeRecipe(fullSteps),
      stores: resumeStores,
      ingredientExecutor: resumeExec,
      resumeFrom: { gated_step_id: paused.awaiting_approval!.gated_step_id },
    };
    const resumed = await executeRecipe(resumeCtx);

    expect(resumed.success).toBe(true);
    expect(resumed.errors).toEqual([]);
    expect(resumed.awaiting_approval).toBeUndefined();
    // The gated ingredient call dispatched exactly once on resume
    // (TR-5 — pre-gate steps did NOT re-run).
    expect(resumeCalls).toHaveLength(1);
    expect(resumeCalls[0].slug).toBe('gated-action');
    // The resolved dispatch_payload reaches the executor — proving the
    // seeded pre-gate step outputs are visible to refs on resume.
    expect(resumeCalls[0].input).toEqual({ who: 'hello-case-42-after', tag: 'p3' });
    // Step logs on resume start at the gated step — pre-gate steps
    // aren't in the resumed run's `steps` array.
    expect(resumed.steps.map((s) => s.id)).toEqual(['gated_call', 's4']);
    // The seeded step outputs are still present in stores after resume.
    expect((resumeCtx.stores.step as Record<string, unknown>).s1).toBe('hello-case-42');
    expect((resumeCtx.stores.step as Record<string, unknown>).s2).toBe('hello-case-42-after');
    expect((resumeCtx.stores.step as Record<string, unknown>).s4).toBe('done:hello-case-42-after');
  });

  it('D-177 P3 — seeds preflight_session_grant on the gated step only, and only when resumeFrom carries it', async () => {
    // Pause once to capture a real checkpoint shape.
    const pauseCtx = makeCtx(makeRecipe(fullSteps), async (slug) => {
      if (slug === 'gated-action') throw new PreflightRequiredSignal();
      return null;
    });
    const paused = await executeRecipe(pauseCtx);
    expect(paused.awaiting_approval).toBeDefined();

    const offer = { ttl_ms: 3_600_000, max_uses: 5, risk_tier: 'write' };
    const resumeWith = async (sessionGrant?: typeof offer) => {
      const metas: Array<{ slug: string; meta: unknown }> = [];
      const stores = baseStores();
      (stores.step as Record<string, unknown>) = structuredClone(
        paused.awaiting_approval!.step_state,
      );
      const ctx: ExecutionContext = {
        recipe: makeRecipe(fullSteps),
        stores,
        ingredientExecutor: async (slug, input, _out, _opts, meta) => {
          metas.push({ slug, meta });
          return { echo: (input as Record<string, unknown>)?.who ?? 'unknown' };
        },
        resumeFrom: {
          gated_step_id: paused.awaiting_approval!.gated_step_id,
          ...(sessionGrant !== undefined ? { session_grant: sessionGrant } : {}),
        },
      };
      const result = await executeRecipe(ctx);
      expect(result.success).toBe(true);
      return metas;
    };

    // allow_session resume: the gated step's StepMeta carries the mint
    // instruction alongside the resume-grant marker (the engine is the
    // SOLE writer — `buildStepMeta` never copies it from recipe JSON).
    const withGrant = await resumeWith(offer);
    expect(withGrant).toHaveLength(1);
    const gatedMeta = withGrant[0].meta as Record<string, unknown>;
    expect(withGrant[0].slug).toBe('gated-action');
    expect(gatedMeta.preflight_admitted).toBe(true);
    expect(gatedMeta.preflight_session_grant).toEqual(offer);

    // Plain-approve resume: byte-identical to pre-P3 — no marker.
    const withoutGrant = await resumeWith();
    expect(withoutGrant).toHaveLength(1);
    const plainMeta = withoutGrant[0].meta as Record<string, unknown>;
    expect(plainMeta.preflight_admitted).toBe(true);
    expect(plainMeta).not.toHaveProperty('preflight_session_grant');
  });

  it('faithful re-instantiation: full run = head-paused + resumed (I-6)', async () => {
    // Full run with the gated call succeeding.
    const successExec: IngredientExecutor = async (slug, input) => {
      if (slug === 'gated-action') {
        return { echo: (input as Record<string, unknown>)?.who ?? 'unknown' };
      }
      return null;
    };
    const fullCtx = makeCtx(makeRecipe(fullSteps), successExec);
    const full = await executeRecipe(fullCtx);
    expect(full.success).toBe(true);

    // Paused run: gate the same step.
    const pausedCtx = makeCtx(
      makeRecipe(fullSteps),
      async (slug) => {
        if (slug === 'gated-action') throw new PreflightRequiredSignal();
        return null;
      },
    );
    const paused = await executeRecipe(pausedCtx);

    // Resume past the gate.
    const resumeStores = baseStores();
    (resumeStores.step as Record<string, unknown>) = structuredClone(
      paused.awaiting_approval!.step_state,
    );
    const resumeCtx: ExecutionContext = {
      recipe: makeRecipe(fullSteps),
      stores: resumeStores,
      ingredientExecutor: successExec,
      resumeFrom: { gated_step_id: paused.awaiting_approval!.gated_step_id },
    };
    const resumed = await executeRecipe(resumeCtx);

    // The final step.* state after (head + resume) equals the full
    // run's final step.* state. This is the D-159 I-6 contract.
    expect(resumeCtx.stores.step).toEqual(fullCtx.stores.step);
  });

  it('CHECKPOINT_STEP_NOT_FOUND when resumeFrom names a step not in the recipe', async () => {
    const ctx: ExecutionContext = {
      recipe: makeRecipe(fullSteps),
      stores: baseStores(),
      ingredientExecutor: noopExec,
      resumeFrom: { gated_step_id: 'ghost_step' },
    };
    const result = await executeRecipe(ctx);

    expect(result.success).toBe(false);
    expect(result.awaiting_approval).toBeUndefined();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('CHECKPOINT_STEP_NOT_FOUND');
    expect(result.errors[0].severity).toBe('fatal');
    expect(result.errors[0].details).toMatchObject({ gated_step_id: 'ghost_step' });
    expect(result.steps).toEqual([]);
  });

  it('resume skips prefetch (TR-5 — no step before the gate runs twice)', async () => {
    let prefetchCalls = 0;
    const prefetchExec: IngredientExecutor = async (slug) => {
      if (slug === 'prefetch-read') prefetchCalls++;
      if (slug === 'gated-action') {
        return { echo: 'ok' };
      }
      return null;
    };

    const recipeWithPrefetch = makeRecipe(
      asSteps([
        { id: 'gated_call', ingredient: 'gated-action' },
      ]),
      {
        prefetch_steps: [
          { id: 'pre', ingredient: 'prefetch-read' },
        ] as unknown as RecipeDefinition['prefetch_steps'],
      },
    );

    // Resume from `gated_call` — prefetch must NOT re-run.
    const resumeStores = baseStores();
    (resumeStores.step as Record<string, unknown>).pre = { cached: true };
    const ctx: ExecutionContext = {
      recipe: recipeWithPrefetch,
      stores: resumeStores,
      ingredientExecutor: prefetchExec,
      resumeFrom: { gated_step_id: 'gated_call' },
    };
    const result = await executeRecipe(ctx);

    expect(result.success).toBe(true);
    expect(prefetchCalls).toBe(0); // prefetch skipped on resume
    // The seeded prefetch output is still visible.
    expect((ctx.stores.step as Record<string, unknown>).pre).toEqual({ cached: true });
  });
});

describe('D-157 P1 slice 3 — runForeach interaction', () => {
  it('resumes at the exact gated item and returns one whole approved foreach result', async () => {
    const pauseCalls: string[] = [];
    const gatingExec: IngredientExecutor = async (slug, input) => {
      const item = String(input.name);
      pauseCalls.push(item);
      // A data-dependent gate can arise after an earlier item already crossed
      // the boundary. That completed prefix must never dispatch again.
      if (item === 'b' && slug === 'gated-action') {
        throw new PreflightRequiredSignal();
      }
      return { sent: item };
    };

    const foreachRecipe = makeRecipe(
      asSteps([
        {
          id: 's_setup',
          transform: 'set',
          source: { items: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] },
          field: 'noop',
          value: null,
        },
        {
          id: 'fan',
          ingredient: 'gated-action',
          foreach: '{{step.s_setup.items}}',
          input: '{{item}}',
        },
      ]),
    );
    const ctx = makeCtx(foreachRecipe, gatingExec);
    const result = await executeRecipe(ctx);

    expect(result.success).toBe(false);
    expect(result.awaiting_approval).toBeDefined();
    expect(result.awaiting_approval!.gated_step_id).toBe('fan');
    expect(pauseCalls).toEqual(['a', 'b']);
    expect(result.awaiting_approval!.foreach_progress).toEqual({
      step_id: 'fan',
      next_index: 1,
      source_length: 3,
      source_hash: hashForeachCheckpointSource([
        { name: 'a' }, { name: 'b' }, { name: 'c' },
      ]),
      results: [{ ok: true, result: { sent: 'a' }, item: { name: 'a' } }],
    });
    expect(result.awaiting_approval!.step_state).toHaveProperty('fan');
    expect(result.awaiting_approval!.step_state.fan).toEqual({ sent: 'a' });
    // The foreach `item` binding was cleaned up by the finally block
    // even on a re-throw (the finally restores `prevItem`/deletes the
    // binding regardless of how the loop exits).
    expect((ctx.stores as { item?: unknown }).item).toBeUndefined();

    const resumedCalls: Array<{ item: string; admitted: boolean | undefined }> = [];
    const resumeStores = baseStores();
    resumeStores.step = structuredClone(result.awaiting_approval!.step_state);
    const resumed = await executeRecipe({
      recipe: foreachRecipe,
      stores: resumeStores,
      ingredientExecutor: async (_slug, input, _output, _options, meta) => {
        const item = String(input.name);
        resumedCalls.push({ item, admitted: meta?.preflight_admitted });
        return { sent: item };
      },
      resumeFrom: {
        gated_step_id: 'fan',
        foreach_progress: result.awaiting_approval!.foreach_progress!,
      },
    });

    expect(resumed.success).toBe(true);
    // `a` is checkpointed; only b+c dispatch after approval. The one approval
    // covers that bounded foreach operation, so both remaining calls carry the
    // step-scoped admission marker.
    expect(resumedCalls).toEqual([
      { item: 'b', admitted: true },
      { item: 'c', admitted: true },
    ]);
    expect(resumed.steps).toHaveLength(1);
    expect(resumed.steps[0]!.result).toEqual([
      { ok: true, result: { sent: 'a' }, item: { name: 'a' } },
      { ok: true, result: { sent: 'b' }, item: { name: 'b' } },
      { ok: true, result: { sent: 'c' }, item: { name: 'c' } },
    ]);
  });

  it('spends a chunked approval on one foreach item and re-holds the next item', async () => {
    const items = [{ name: 'a' }, { name: 'b' }];
    const foreachRecipe = makeRecipe(asSteps([{
      id: 'fan',
      ingredient: 'gated-action',
      foreach: '{{config.items}}',
      input: '{{item}}',
    }]));
    const stores = baseStores();
    stores.config = { items };
    const calls: Array<{ item: string; admitted: boolean | undefined }> = [];
    const resumed = await executeRecipe({
      recipe: foreachRecipe,
      stores,
      ingredientExecutor: async (_slug, input, _output, _options, meta) => {
        const item = String(input.name);
        calls.push({ item, admitted: meta?.preflight_admitted });
        if (meta?.preflight_admitted !== true) {
          throw new PreflightRequiredSignal('next chunk needs its own bound', {
            egress_bound: { requests: 4, total_bytes: 32 },
          });
        }
        return { sent: item };
      },
      resumeFrom: {
        gated_step_id: 'fan',
        egress_bound: { requests: 4, total_bytes: 32 },
        foreach_progress: {
          step_id: 'fan',
          next_index: 0,
          source_length: items.length,
          source_hash: hashForeachCheckpointSource(items),
          results: [],
        },
      },
    });

    expect(resumed.success).toBe(false);
    expect(calls).toEqual([
      { item: 'a', admitted: true },
      { item: 'b', admitted: undefined },
    ]);
    expect(resumed.awaiting_approval?.foreach_progress).toEqual({
      step_id: 'fan',
      next_index: 1,
      source_length: 2,
      source_hash: hashForeachCheckpointSource(items),
      results: [{ ok: true, result: { sent: 'a' }, item: { name: 'a' } }],
    });
    expect(resumed.awaiting_approval?.egress_bound).toEqual({
      requests: 4,
      total_bytes: 32,
    });
  });

  it('fails closed when a resumed foreach checkpoint lacks or mismatches item progress', async () => {
    const foreachRecipe = makeRecipe(asSteps([
      {
        id: 'fan',
        ingredient: 'gated-action',
        foreach: '{{config.items}}',
        input: '{{item}}',
      },
    ]));
    for (const foreach_progress of [
      undefined,
      {
        step_id: 'fan',
        next_index: 1,
        source_length: 2,
        source_hash: hashForeachCheckpointSource([
          { name: 'a' }, { name: 'b' },
        ]),
        results: [{ ok: true, result: { sent: 'different' }, item: { name: 'x' } }],
      },
      {
        step_id: 'fan',
        next_index: 1,
        source_length: 2,
        source_hash: hashForeachCheckpointSource([
          { name: 'a' }, { name: 'changed-after-gate' },
        ]),
        results: [{ ok: true, result: { sent: 'a' }, item: { name: 'a' } }],
      },
    ]) {
      let calls = 0;
      const stores = baseStores();
      stores.config = { items: [{ name: 'a' }, { name: 'b' }] };
      const resumed = await executeRecipe({
        recipe: foreachRecipe,
        stores,
        ingredientExecutor: async () => {
          calls += 1;
          return null;
        },
        resumeFrom: {
          gated_step_id: 'fan',
          ...(foreach_progress !== undefined ? { foreach_progress } : {}),
        },
      });

      expect(resumed.success).toBe(false);
      expect(resumed.errors[0]).toMatchObject({
        code: 'RECIPE_VALIDATION_FAILED',
        details: {
          reason: foreach_progress === undefined
            ? 'checkpoint_foreach_progress_missing'
            : 'checkpoint_foreach_progress_mismatch',
        },
      });
      expect(calls).toBe(0);
    }
  });
});

/** 617fc33fb's fourth regression. The resume marker (`ctx.resumeFrom`) stays set
 *  for the whole resumed run, and the foreach guards it added read the
 *  checkpoint's progress for EVERY foreach the run reaches — so a foreach after
 *  the gated one compared itself against the gated step's progress and refused.
 *  A resumed run that approved one fan-out could never reach a second. */
describe('D-157 P1 slice 3 — foreach resume guards apply to the gated step only', () => {
  const stores = (): NamespaceStores => ({
    vault: {}, config: { items: [{ n: 'a' }, { n: 'b' }], more: [{ n: 'x' }, { n: 'y' }] }, context: {}, meta: {}, step: {},
  });
  /** Pauses ONCE, on the named item of the named step; answers otherwise. */
  const pausingOn = (stepId: string, itemName: string): { exec: IngredientExecutor; calls: string[] } => {
    const calls: string[] = [];
    let paused = false;
    const exec: IngredientExecutor = async (slug, input) => {
      const item = (input as { n?: string }).n ?? '?';
      calls.push(`${slug}:${item}`);
      if (!paused && slug === stepId && item === itemName) {
        paused = true;
        throw new PreflightRequiredSignal(`pause at ${item}`);
      }
      return { sent: item };
    };
    return { exec, calls };
  };
  const twoFanOuts = makeRecipe(asSteps([
    { id: 'first', ingredient: 'first', foreach: '{{config.items}}', input: '{{item}}' },
    { id: 'second', ingredient: 'second', foreach: '{{config.more}}', input: '{{item}}' },
  ]));
  // The host's derivation, not a hand-built one: what the pause carried is
  // what the resume gets (see `resumeFromApproval`).
  const resume = (recipe: RecipeDefinition, paused: Awaited<ReturnType<typeof executeRecipe>>, exec: IngredientExecutor) => {
    const { step_state, ...resumeFrom } = resumeFromApproval(paused.awaiting_approval!);
    const s = stores();
    s.step = step_state;
    return executeRecipe({ recipe, stores: s, ingredientExecutor: exec, resumeFrom });
  };

  it('resumeFromApproval carries every field the pause names — item progress, the egress bound, the identity triple, an EMPTY connection name', () => {
    const derived = resumeFromApproval({
      gated_step_id: 'fan', step_state: { s1: 'x' },
      foreach_progress: { step_id: 'fan', next_index: 1, source_length: 2, source_hash: 'h'.repeat(64), results: [{ ok: true, result: 1, item: 'a' }] },
      egress_bound: { requests: 3, total_bytes: 4096 },
      ingredient_slug: 'records', operation_id: 'doc.create', connection_name: '',
    });
    expect(derived).toEqual({
      gated_step_id: 'fan', step_state: { s1: 'x' },
      foreach_progress: { step_id: 'fan', next_index: 1, source_length: 2, source_hash: 'h'.repeat(64), results: [{ ok: true, result: 1, item: 'a' }] },
      egress_bound: { requests: 3, total_bytes: 4096 },
      approved_target: { ingredient_slug: 'records', operation_id: 'doc.create', connection_name: '' },
    });
    // A bare pause keeps an empty target: the gate reads that as "ask again".
    expect(resumeFromApproval({ gated_step_id: 's', step_state: {} })).toEqual({ gated_step_id: 's', step_state: {}, approved_target: {} });
  });

  it('a foreach AFTER the gated foreach runs from item zero instead of refusing against the gated step’s progress', async () => {
    const { exec, calls } = pausingOn('first', 'b');
    const paused = await executeRecipe({ recipe: twoFanOuts, stores: stores(), ingredientExecutor: exec });
    expect(paused.awaiting_approval).toMatchObject({ gated_step_id: 'first', foreach_progress: { next_index: 1 } });
    const resumed = await resume(twoFanOuts, paused, exec);
    expect(resumed.errors).toEqual([]);
    expect(resumed.success).toBe(true);
    // The gated fan-out resumed at its second item; the second fan-out ran whole.
    expect(calls).toEqual(['first:a', 'first:b', 'first:b', 'second:x', 'second:y']);
    expect(resumed.steps.find((log) => log.id === 'second')?.result).toEqual([
      { ok: true, result: { sent: 'x' }, item: { n: 'x' } },
      { ok: true, result: { sent: 'y' }, item: { n: 'y' } },
    ]);
  });

  it('a foreach after a gated PLAIN step still runs whole', async () => {
    const recipe = makeRecipe(asSteps([
      { id: 'solo', ingredient: 'solo', input: { n: 'solo' } },
      { id: 'second', ingredient: 'second', foreach: '{{config.more}}', input: '{{item}}' },
    ]));
    const { exec, calls } = pausingOn('solo', 'solo');
    const paused = await executeRecipe({ recipe, stores: stores(), ingredientExecutor: exec });
    expect(paused.awaiting_approval?.gated_step_id).toBe('solo');
    expect(paused.awaiting_approval?.foreach_progress).toBeUndefined();
    const resumed = await resume(recipe, paused, exec);
    expect(resumed.errors).toEqual([]);
    expect(calls).toEqual(['solo:solo', 'solo:solo', 'second:x', 'second:y']);
  });

  it('the gated foreach itself keeps its guards: a second pause in the same fan-out carries fresh progress, and a stale checkpoint still refuses', async () => {
    // Pause on both items of `first`, one per run: the second segment's
    // progress must describe item two, not replay item one.
    let pauses = 0;
    const exec: IngredientExecutor = async (slug, input) => {
      const item = (input as { n?: string }).n ?? '?';
      if (slug === 'first' && pauses < 2 && item === (pauses === 0 ? 'a' : 'b')) {
        pauses += 1;
        throw new PreflightRequiredSignal(`pause at ${item}`);
      }
      return { sent: item };
    };
    const paused = await executeRecipe({ recipe: twoFanOuts, stores: stores(), ingredientExecutor: exec });
    expect(paused.awaiting_approval?.foreach_progress).toMatchObject({ step_id: 'first', next_index: 0, results: [] });
    const pausedAgain = await resume(twoFanOuts, paused, exec);
    expect(pausedAgain.awaiting_approval?.foreach_progress).toMatchObject({ step_id: 'first', next_index: 1 });
    expect(pausedAgain.awaiting_approval?.foreach_progress?.results).toHaveLength(1);
    const done = await resume(twoFanOuts, pausedAgain, exec);
    expect(done.errors).toEqual([]);
    expect(done.success).toBe(true);
    // And the gated step's own guard is untouched: progress for another step is a mismatch.
    const s = stores();
    const foreign = await executeRecipe({
      recipe: twoFanOuts, stores: s, ingredientExecutor: exec,
      resumeFrom: { gated_step_id: 'second', foreach_progress: { ...pausedAgain.awaiting_approval!.foreach_progress! } },
    });
    expect(foreign.errors[0]).toMatchObject({ details: { reason: 'checkpoint_foreach_progress_mismatch' } });
  });
});

describe('D-201 Slice 10N — a gated step a restart stopped after it returned', () => {
  const pausedAtGate = async () => {
    const paused = await executeRecipe(makeCtx(makeRecipe(fullSteps), async (slug) => {
      if (slug === 'gated-action') throw new PreflightRequiredSignal();
      return null;
    }));
    expect(paused.awaiting_approval).toBeDefined();
    return paused;
  };
  const resumeWith = (
    paused: Awaited<ReturnType<typeof executeRecipe>>,
    replayed: { value: unknown } | undefined,
    steps: RecipeStep[] = fullSteps,
  ) => {
    const calls: string[] = [];
    const stores = baseStores();
    (stores.step as Record<string, unknown>) = structuredClone(paused.awaiting_approval!.step_state);
    const ctx: ExecutionContext = {
      recipe: makeRecipe(steps),
      stores,
      ingredientExecutor: async (slug) => { calls.push(slug); return { echo: 'sent again' }; },
      resumeFrom: {
        gated_step_id: 'gated_call',
        ...(replayed !== undefined ? { replayed_result: replayed } : {}),
      },
    };
    return { calls, stores, run: executeRecipe(ctx) };
  };

  it('the recorded value stands in for the call: nothing is sent, and the run goes on from it', async () => {
    const { calls, stores, run } = resumeWith(await pausedAtGate(), { value: { echo: 'kept' } });
    const resumed = await run;
    expect(resumed.errors).toEqual([]);
    expect(resumed.success).toBe(true);
    expect(calls).toEqual([]);
    expect(resumed.steps.map((s) => s.id)).toEqual(['gated_call', 's4']);
    expect((stores.step as Record<string, unknown>).gated_call).toEqual({ echo: 'kept' });
    expect((stores.step as Record<string, unknown>).s4).toBe('done:kept');
  });

  it('without one, the approved call is made, as before', async () => {
    const { calls, run } = resumeWith(await pausedAtGate(), undefined);
    expect((await run).success).toBe(true);
    expect(calls).toEqual(['gated-action']);
  });

  it("the step's own stop_when and fail_on still read the recorded value", async () => {
    const stopping = [
      ...headSteps,
      ...asSteps([
        { id: 'gated_call', ingredient: 'gated-action', input: '{{step.dispatch_payload}}', stop_when: '{{step.gated_call.echo}} equal kept' },
        { id: 's4', transform: 'concat', values: ['done:', '{{step.gated_call.echo}}'] },
      ]),
    ];
    const stopped = resumeWith(await pausedAtGate(), { value: { echo: 'kept' } }, stopping);
    const result = await stopped.run;
    expect(result.success).toBe(true);
    expect(result.stopped).toMatchObject({ step_id: 'gated_call' });
    expect(result.steps.map((s) => s.id)).toEqual(['gated_call']);
    const failing = [
      ...headSteps,
      ...asSteps([
        { id: 'gated_call', ingredient: 'gated-action', input: '{{step.dispatch_payload}}', fail_on: '{{step.gated_call.echo}} equal kept' },
        { id: 's4', transform: 'concat', values: ['done:', '{{step.gated_call.echo}}'] },
      ]),
    ];
    const failed = await resumeWith(await pausedAtGate(), { value: { echo: 'kept' } }, failing).run;
    expect(failed.success).toBe(false);
    expect(failed.errors[0]).toMatchObject({ code: 'RECIPE_FAIL_ON_TRIGGERED' });
    expect(stopped.calls).toEqual([]);
  });

  it('a null value stands in too, distinct from no value', async () => {
    const { calls, stores, run } = resumeWith(await pausedAtGate(), { value: null });
    await run;
    expect(calls).toEqual([]);
    expect((stores.step as Record<string, unknown>).gated_call).toBeNull();
  });

  // D-201 Slice 10BH — a loop resumed mid-way is refused; one asked for from its
  // first item that finished stands in (below).
  it('a foreach step resumed mid-way is refused rather than run: a value cannot stand in for its items', async () => {
    const fan = asSteps([
      { id: 'fan', ingredient: 'gated-action', foreach: '{{config.items}}', input: '{{item}}' },
    ]);
    const calls: string[] = [];
    const stores = baseStores();
    (stores.config as Record<string, unknown>) = { items: ['a', 'b'] };
    const result = await executeRecipe({
      recipe: makeRecipe(fan),
      stores,
      ingredientExecutor: async (slug) => { calls.push(slug); return null; },
      resumeFrom: {
        gated_step_id: 'fan',
        foreach_progress: {
          step_id: 'fan', next_index: 1, source_length: 2,
          source_hash: hashForeachCheckpointSource(['a', 'b']), results: [{ ok: true, result: null, item: 'a' }],
        },
        replayed_result: { value: [] },
      },
    }).catch((error: unknown) => error);
    expect(calls).toEqual([]);
    expect(String(result)).toMatch(/foreach: a recorded value cannot stand in/);
  });

  it('D-201 Slice 10BH — a loop asked for from its first item that finished stands in as it came out: no item runs again', async () => {
    const fan = asSteps([
      { id: 'fan', ingredient: 'gated-action', foreach: '{{config.items}}', input: '{{item}}' },
      { id: 'after', ingredient: 'after-action', input: '{{step.fan}}' },
    ]);
    const calls: Array<{ slug: string; input: unknown }> = [];
    const stores = baseStores();
    (stores.config as Record<string, unknown>) = { items: ['a', 'b'] };
    const kept = [{ ok: true, result: { done: 'a' }, item: 'a' }, { ok: false, error: 'gone', item: 'b' }];
    const result = await executeRecipe({
      recipe: makeRecipe(fan),
      stores,
      ingredientExecutor: async (slug, input) => { calls.push({ slug, input }); return null; },
      resumeFrom: {
        gated_step_id: 'fan',
        foreach_progress: {
          step_id: 'fan', next_index: 0, source_length: 2,
          source_hash: hashForeachCheckpointSource(['a', 'b']), results: [],
        },
        replayed_result: { value: kept },
      },
    });
    expect(result.success).toBe(true);
    // Only the step after it ran, reading the loop as it came out.
    expect(calls.map((call) => call.slug)).toEqual(['after-action']);
    expect((stores.step as Record<string, unknown>).fan).toEqual(kept);
    // Bound to an egress budget, it is still refused.
    const bound = await executeRecipe({
      recipe: makeRecipe(fan),
      stores: (() => { const fresh = baseStores(); (fresh.config as Record<string, unknown>) = { items: ['a', 'b'] }; return fresh; })(),
      ingredientExecutor: async () => null,
      resumeFrom: { gated_step_id: 'fan', egress_bound: { requests: 1, total_bytes: 10 }, replayed_result: { value: kept } },
    }).catch((error: unknown) => error);
    expect(String(bound)).toMatch(/foreach: a recorded value cannot stand in/);
  });
});

// D-201 Slice 10BN (10BM findings 1 and 3) — a loop that finished stands in as
// `runForeach` returned it. Down a plain step's path its items' `skip_when`
// and `fail_on` were read once with no item: a filter on its items read it as
// skipped, its value null, and a per-item `fail_on` failed the run.
describe('D-201 Slice 10BN — a replayed loop stands in as it came out', () => {
  const kept = [
    { ok: true, result: { done: 'a' }, item: { id: 'a', should_notify: true } },
    { ok: true, skipped: true, result: null, item: { id: 'b', should_notify: false } },
    { ok: false, error: 'gone', item: { id: 'c', should_notify: true } },
  ];
  const items = kept.map((entry) => entry.item);
  const askedAtTheFirst = {
    step_id: 'fan', next_index: 0, source_length: items.length,
    source_hash: hashForeachCheckpointSource(items), results: [],
  };
  const replayTheLoop = async (fan: Record<string, unknown>, progress: unknown = askedAtTheFirst) => {
    const steps = asSteps([
      { id: 'fan', ingredient: 'gated-action', foreach: '{{config.items}}', input: '{{item}}', ...fan },
      // The closure-watcher's shape: a step that loops over the loop's results.
      { id: 'after', ingredient: 'after-action', foreach: '{{step.fan}}', input: '{{item.item.id}}' },
    ]);
    const calls: Array<{ slug: string; input: unknown }> = [];
    const stores = baseStores();
    (stores.config as Record<string, unknown>) = { items };
    const result = await executeRecipe({
      recipe: makeRecipe(steps),
      stores,
      ingredientExecutor: async (slug, input) => { calls.push({ slug, input }); return { sent: input }; },
      resumeFrom: {
        gated_step_id: 'fan',
        ...(progress !== undefined ? { foreach_progress: progress as never } : {}),
        replayed_result: { value: kept },
      },
    });
    return { result, calls, stores };
  };

  it('an approved loop with a filter on its items: not skipped, its value as it came out, and the loop over it runs', async () => {
    const { result, calls, stores } = await replayTheLoop({ skip_when: '{{item.should_notify}} not_equal true' });
    // Before 10BN: skipped, its value null, and "foreach expected array, got null".
    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);
    expect(result.steps.find((s) => s.id === 'fan')).toMatchObject({
      skipped: false, result: kept, error: null, foreach: { items: 3, failed: 1 },
    });
    expect((stores.step as Record<string, unknown>).fan).toEqual(kept);
    // Nothing of the loop is sent again; the loop after it runs once per entry.
    expect(calls.map((call) => call.slug)).toEqual(['after-action', 'after-action', 'after-action']);
    expect(result.steps.find((s) => s.id === 'after')).toMatchObject({ foreach: { items: 3, failed: 0 } });
  });

  it('a per-step filter reading the other way now is not read again either: the loop ran', async () => {
    const { result, calls } = await replayTheLoop({ skip_when: '{{config.leave_the_fan}} is_null' });
    expect(result.success).toBe(true);
    expect(calls.map((call) => call.slug)).toEqual(['after-action', 'after-action', 'after-action']);
  });

  it('an approved loop with a per-item fail_on: not failed again with no item', async () => {
    const { result, calls } = await replayTheLoop({ fail_on: '{{item}} is_empty' });
    // Before 10BN: RECIPE_FAIL_ON_TRIGGERED, read over the whole value.
    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);
    expect(calls.map((call) => call.slug)).toEqual(['after-action', 'after-action', 'after-action']);
  });

  it("its stop_when reads the whole value once, as after the loop: the run ends there", async () => {
    const { result, calls } = await replayTheLoop({ stop_when: '{{step.fan}} is_not_empty' });
    expect(result.success).toBe(true);
    expect(result.stopped).toMatchObject({ step_id: 'fan' });
    expect(calls).toEqual([]);
  });

  it('a loop whose filter skipped the items before its ask stands in, as one asked for from its first item that ran', async () => {
    const skippedFirst = {
      step_id: 'fan', next_index: 1, source_length: items.length, source_hash: hashForeachCheckpointSource(items),
      results: [{ ok: true, skipped: true, result: null, item: items[0] }],
    };
    const { result, calls } = await replayTheLoop({ skip_when: '{{item.id}} equal x' }, skippedFirst);
    // Before 10BN: refused, read as resumed mid-way.
    expect(result.success).toBe(true);
    expect(calls.map((call) => call.slug)).toEqual(['after-action', 'after-action', 'after-action']);
    // One an item of which ran before the ask is still refused.
    const ranFirst = { ...skippedFirst, results: [{ ok: true, result: { done: 'a' }, item: items[0] }] };
    await expect(replayTheLoop({}, ranFirst)).rejects.toThrow(/foreach: a recorded value cannot stand in/);
  });

  it('a later loop that replays is not filtered or failed again: it stands in as it came out', async () => {
    const steps = [
      ...headSteps,
      ...asSteps([
        { id: 'gated_call', ingredient: 'gated-action', input: '{{step.dispatch_payload}}' },
        {
          id: 'later_fan', ingredient: 'fan-action', foreach: '{{config.items}}', input: '{{item}}',
          skip_when: '{{item.should_notify}} not_equal true', fail_on: '{{item}} is_empty',
        },
        { id: 'last', ingredient: 'last-action', foreach: '{{step.later_fan}}', input: '{{item.item.id}}' },
      ]),
    ];
    const calls: string[] = [];
    const stores = baseStores();
    (stores.config as Record<string, unknown>) = { items };
    (stores.step as Record<string, unknown>) = { s1: 'hello-x', s2: 'hello-x-after', dispatch_payload: { who: 'hello-x-after', tag: 'p3' } };
    const result = await executeRecipe({
      recipe: makeRecipe(steps),
      stores,
      ingredientExecutor: async (slug) => { calls.push(slug); return { sent: slug }; },
      resumeFrom: {
        gated_step_id: 'gated_call',
        replayed_result: { value: { echo: 'kept' } },
        replayed_steps: [{ step_id: 'later_fan', skipped: false, value: kept }],
      },
    });
    // Before 10BN: its per-item fail_on, read with no item, failed the run.
    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);
    expect((stores.step as Record<string, unknown>).later_fan).toEqual(kept);
    expect(calls).toEqual(['last-action', 'last-action', 'last-action']);
  });
});

// D-201 Slice 10BU (10BS finding 2) — the approved step skipped before the stop
// (at the answer) stays skipped, as a later step's recorded skip does: a loop
// was replayed as one that ran, its `stop_when` read over the null the skip
// left, and a plain step's filter was read again over what had changed since.
describe('D-201 Slice 10BU — an approved step skipped before the stop stays skipped', () => {
  const runSkipped = async (gated: Record<string, unknown>, config: Record<string, unknown> = {}) => {
    const steps = asSteps([
      { id: 'fan', ingredient: 'gated-action', input: 'x', ...gated },
      { id: 'after', ingredient: 'after-action', input: 'y' },
    ]);
    const calls: string[] = [];
    const stores = baseStores();
    (stores.config as Record<string, unknown>) = { items: ['a', 'b'], ...config };
    const result = await executeRecipe({
      recipe: makeRecipe(steps),
      stores,
      ingredientExecutor: async (slug) => { calls.push(slug); return { sent: slug }; },
      resumeFrom: { gated_step_id: 'fan', replayed_result: { value: null, skipped: true } },
    });
    return { result, calls, stores };
  };

  it('a loop skipped as a whole, its stop_when reading it as empty: skipped, unread, and the run goes on', async () => {
    const { result, calls } = await runSkipped({
      foreach: '{{config.items}}', input: '{{item}}',
      skip_when: '{{config.charge}} is_null', stop_when: '{{step.fan}} is_empty',
    });
    // Before 10BU: replayed as a loop that ran, its stop_when ended the run.
    expect(result.success).toBe(true);
    expect(result.stopped).toBeUndefined();
    expect(result.steps.find((s) => s.id === 'fan')).toMatchObject({ skipped: true, result: null });
    expect(calls).toEqual(['after-action']);
  });

  it("a plain step whose filter reads the other way now: still skipped, as it was", async () => {
    const { result, calls } = await runSkipped(
      { skip_when: '{{config.charge}} is_null', stop_when: '{{step.fan}} is_null' },
      { charge: 'ch_now_there' },
    );
    // Before 10BU: its filter read again, its null stood in as a step that ran,
    // and its stop_when ended the run.
    expect(result.success).toBe(true);
    expect(result.stopped).toBeUndefined();
    expect(result.steps.find((s) => s.id === 'fan')).toMatchObject({ skipped: true, result: null });
    expect(calls).toEqual(['after-action']);
  });
});

// D-201 Slice 10BZ (10BX finding 6, the review's gaps) — a plain approved step
// that ran stands in with its value, its filter unread: read again over what
// had changed since, it was skipped, and the steps after it read null. One that
// returned null ran, and is no skip.
describe('D-201 Slice 10BZ — an approved step that ran stands in with its value, its filter unread', () => {
  const runReplayed = async (gated: Record<string, unknown>, value: unknown) => {
    const steps = asSteps([
      { id: 'fan', ingredient: 'gated-action', input: 'x', ...gated },
      { id: 'after', ingredient: 'after-action', input: '{{step.fan}}' },
    ]);
    const calls: Array<{ slug: string; input: Record<string, unknown> }> = [];
    const result = await executeRecipe({
      recipe: makeRecipe(steps),
      stores: baseStores(),
      ingredientExecutor: async (slug, input) => { calls.push({ slug, input }); return { sent: slug }; },
      resumeFrom: { gated_step_id: 'fan', replayed_result: { value } },
    });
    return { result, calls };
  };

  it('its filter reading true now: it stands in with what it returned, and the step after reads that', async () => {
    const { result, calls } = await runReplayed({ skip_when: '{{config.charge}} is_null' }, { id: 7 });
    // Before 10BZ: skipped, its value null, and the step after read nothing.
    expect(result.success).toBe(true);
    expect(result.steps.find((s) => s.id === 'fan')).toMatchObject({ skipped: false, result: { id: 7 } });
    expect(calls).toEqual([{ slug: 'after-action', input: expect.objectContaining({ id: 7 }) }]);
  });

  it('one that returned null ran: not skipped, and its stop_when is read', async () => {
    const { result, calls } = await runReplayed({ stop_when: '{{step.fan}} is_null' }, null);
    expect(result.success).toBe(true);
    expect(result.steps.find((s) => s.id === 'fan')).toMatchObject({ skipped: false, result: null });
    expect(result.stopped).toMatchObject({ step_id: 'fan' });
    expect(calls).toEqual([]);
  });
});

describe('D-201 Slice 10BN — loopAskedBeforeAnyItemRan', () => {
  const progress = (next_index: number, results: unknown[]) =>
    ({ step_id: 'fan', next_index, source_length: 3, source_hash: 'h', results }) as never;
  it('no item reached, or each one before the ask skipped by its own filter', () => {
    expect(loopAskedBeforeAnyItemRan(progress(0, []))).toBe(true);
    expect(loopAskedBeforeAnyItemRan(progress(2, [
      { ok: true, skipped: true, result: null, item: 'a' },
      { ok: true, skipped: true, result: null, item: 'b' },
    ]))).toBe(true);
  });
  it('an item that ran, or failed, before the ask: resumed mid-way', () => {
    expect(loopAskedBeforeAnyItemRan(progress(1, [{ ok: true, result: 'x', item: 'a' }]))).toBe(false);
    expect(loopAskedBeforeAnyItemRan(progress(1, [{ ok: false, error: 'gone', item: 'a' }]))).toBe(false);
    expect(loopAskedBeforeAnyItemRan(progress(1, [{ ok: false, skipped: true, error: 'gone', item: 'a' }]))).toBe(false);
    expect(loopAskedBeforeAnyItemRan(progress(2, [
      { ok: true, skipped: true, result: null, item: 'a' },
      { ok: true, result: 'x', item: 'b' },
    ]))).toBe(false);
  });
  it('a progress whose index does not match its results is not read as one', () => {
    expect(loopAskedBeforeAnyItemRan(progress(1, []))).toBe(false);
    expect(loopAskedBeforeAnyItemRan(progress(0, [{ ok: true, skipped: true, result: null, item: 'a' }]))).toBe(false);
  });
});

// D-201 Slice 10R (10Q finding 1) — the resume starts at the gated step's
// checkpoint, so each step after it that the stopped run had finished stands in
// as it came out; the run goes on from the first that had not.
describe('D-201 Slice 10R — the steps after it that had finished, too', () => {
  const laterSteps = asSteps([
    { id: 'create', ingredient: 'create-action', input: '{{step.gated_call.echo}}' },
    { id: 'fan', ingredient: 'fan-action', foreach: '{{config.items}}', input: '{{item}}' },
    { id: 'tail', transform: 'concat', values: ['made:', '{{step.create.id}}'] },
    { id: 'last', ingredient: 'last-action', input: '{{step.tail}}' },
  ]);
  const resumeFrom = (steps: RecipeStep[], replayedSteps: ReadonlyArray<{ step_id: string; skipped: boolean; value?: unknown }>) => {
    const calls: Array<{ slug: string; input: unknown }> = [];
    const stores = baseStores();
    (stores.config as Record<string, unknown>) = { items: ['a', 'b'] };
    (stores.step as Record<string, unknown>) = { s1: 'hello-x', s2: 'hello-x-after', dispatch_payload: { who: 'hello-x-after', tag: 'p3' } };
    const ctx: ExecutionContext = {
      recipe: makeRecipe(steps),
      stores,
      ingredientExecutor: async (slug, input) => { calls.push({ slug, input }); return { sent: slug }; },
      resumeFrom: {
        gated_step_id: 'gated_call',
        replayed_result: { value: { echo: 'kept' } },
        replayed_steps: replayedSteps,
      },
    };
    return { calls, stores, run: executeRecipe(ctx) };
  };

  it('each finished step stands in as it came out, a loop whole; the run sends only what had not started', async () => {
    const fanned = [{ ok: true, result: { sent: 'a' } }, { ok: true, result: { sent: 'b' } }];
    const { calls, stores, run } = resumeFrom([...headSteps, ...tailSteps.slice(0, 1), ...laterSteps], [
      { step_id: 'create', skipped: false, value: { id: 'deal-2' } },
      { step_id: 'fan', skipped: false, value: fanned },
    ]);
    const resumed = await run;
    expect(resumed.errors).toEqual([]);
    expect(resumed.success).toBe(true);
    // Neither the create nor any item of the loop is sent again.
    expect(calls.map((call) => call.slug)).toEqual(['last-action']);
    expect(resumed.steps.map((s) => s.id)).toEqual(['gated_call', 'create', 'fan', 'tail', 'last']);
    const step = stores.step as Record<string, unknown>;
    expect(step.create).toEqual({ id: 'deal-2' });
    expect(step.fan).toEqual(fanned);
    // What runs after reads the replayed values.
    expect(step.tail).toBe('made:deal-2');
    expect(step.last).toEqual({ sent: 'last-action' });
  });

  it("a replayed step's skip_when is not asked again: one that ran stands in, one that was skipped stays skipped", async () => {
    const steps = [
      ...headSteps,
      ...tailSteps.slice(0, 1),
      ...asSteps([
        // Both conditions now read the other way from when the stopped run met them.
        { id: 'create', ingredient: 'create-action', input: 'x', skip_when: '{{step.s1}} is_not_empty' },
        { id: 'notify', ingredient: 'notify-action', input: 'x', skip_when: '{{step.s1}} is_empty' },
        { id: 'tail', transform: 'concat', values: ['made:', '{{step.create.id}}'] },
      ]),
    ];
    const { calls, stores, run } = resumeFrom(steps, [
      { step_id: 'create', skipped: false, value: { id: 'deal-2' } },
      { step_id: 'notify', skipped: true },
    ]);
    const resumed = await run;
    expect(resumed.success).toBe(true);
    expect(calls).toEqual([]);
    expect(resumed.steps.find((s) => s.id === 'create')).toMatchObject({ skipped: false, result: { id: 'deal-2' } });
    expect(resumed.steps.find((s) => s.id === 'notify')).toMatchObject({ skipped: true, result: null });
    expect((stores.step as Record<string, unknown>).tail).toBe('made:deal-2');
  });

  it("a replayed step's stop_when still reads its value: the run ends there", async () => {
    const steps = [
      ...headSteps,
      ...tailSteps.slice(0, 1),
      ...asSteps([
        { id: 'create', ingredient: 'create-action', input: 'x', stop_when: '{{step.create.id}} equal deal-2' },
        { id: 'last', ingredient: 'last-action', input: 'x' },
      ]),
    ];
    const { calls, run } = resumeFrom(steps, [{ step_id: 'create', skipped: false, value: { id: 'deal-2' } }]);
    const resumed = await run;
    expect(resumed.success).toBe(true);
    expect(resumed.stopped).toMatchObject({ step_id: 'create' });
    expect(calls).toEqual([]);
  });

  it('an entry naming the gated step itself is ignored: its own replayed value governs it', async () => {
    const { calls, stores, run } = resumeFrom([...headSteps, ...tailSteps], [
      { step_id: 'gated_call', skipped: true },
    ]);
    const resumed = await run;
    expect(resumed.success).toBe(true);
    expect(calls).toEqual([]);
    expect((stores.step as Record<string, unknown>).gated_call).toEqual({ echo: 'kept' });
    expect((stores.step as Record<string, unknown>).s4).toBe('done:kept');
  });
});
