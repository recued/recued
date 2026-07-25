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
  type ExecutionContext,
  type IngredientExecutor,
} from '@recued/engine';
import {
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
  it('a preflight signal inside a foreach iteration propagates to the pause path', async () => {
    let iterationsRun = 0;
    const calls: string[] = [];
    const gatingExec: IngredientExecutor = async (slug) => {
      calls.push(slug);
      iterationsRun++;
      // Gate on the second iteration only.
      if (iterationsRun === 2 && slug === 'gated-action') {
        throw new PreflightRequiredSignal();
      }
      return { ok: true };
    };

    const foreachRecipe = makeRecipe(
      asSteps([
        {
          id: 's_setup',
          transform: 'set',
          source: { items: ['a', 'b', 'c'] },
          field: 'noop',
          value: null,
        },
        {
          id: 'fan',
          ingredient: 'gated-action',
          foreach: '{{step.s_setup.items}}',
          input: { item: '{{item}}' },
        },
      ]),
    );
    const ctx = makeCtx(foreachRecipe, gatingExec);
    const result = await executeRecipe(ctx);

    expect(result.success).toBe(false);
    expect(result.awaiting_approval).toBeDefined();
    expect(result.awaiting_approval!.gated_step_id).toBe('fan');
    // The foreach iteration that threw aborted the loop — the third
    // iteration did not run.
    expect(iterationsRun).toBe(2);
    expect(calls).toEqual(['gated-action', 'gated-action']);
    // Observed artifact (DOCUMENTED LIMITATION): each foreach iteration's
    // inner `runStep` writes to `ctx.stores.step.<step_id>` under the
    // SAME step id, so `step.fan` carries the last-completed iteration's
    // raw result at pause time (here: iteration 1's `{ ok: true }`) — NOT
    // the array-of-results shape `runForeach` produces on a clean exit.
    // On resume the foreach re-runs from scratch (gated_step_id === 'fan'
    // is matched by `findIndex`, not by step_state presence); the
    // pre-gate iteration's executor call therefore re-dispatches —
    // partial side effects double-fire. The mid-foreach gate at
    // iteration granularity is out of slice 3's scope (the spec talks
    // about step-level gates); flagged for a later refinement.
    expect(result.awaiting_approval!.step_state).toHaveProperty('fan');
    expect(result.awaiting_approval!.step_state.fan).toEqual({ ok: true });
    // The foreach `item` binding was cleaned up by the finally block
    // even on a re-throw (the finally restores `prevItem`/deletes the
    // binding regardless of how the loop exits).
    expect((ctx.stores as { item?: unknown }).item).toBeUndefined();
  });
});
