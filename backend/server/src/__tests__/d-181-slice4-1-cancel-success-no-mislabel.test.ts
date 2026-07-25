// D-181 §7c — the run's owner-control termination label is derived from the
// AUTHORITATIVE engine outcome, not a run-level registry marker.
//
// Root fix for the cancel-marker family: `cancel()` no longer writes a run-level
// `cancelled_before_dispatch` marker (a queued-call cancel doesn't always
// terminate the run — an OPTIONAL prefetch/foreach cancel is swallowed and the
// run keeps running). The handler now derives the label via `deriveRunTermination`:
//   - `killed` — the registry's kill marker, always honored (even on a late-
//     finishing success).
//   - `cancelled_before_dispatch` — ONLY when the run FAILED carrying the engine's
//     `slot_cancelled` step-error marker (a gated call's queued slot was dropped).
// So a swallowed cancel that lets the run succeed / pause / fail-for-another-reason
// is never mislabelled cancelled.
//
// Handler-integration tests: a stub registry supplies the kill marker; a fake lane
// governor that rejects `acquire` produces a real `slot_cancelled` step error.

import { describe, it, expect } from 'vitest';
import type {
  ExecutionSource,
  IngredientManifest,
  LaneGovernor,
  RecipeDefinition,
} from '@recued/contracts';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import type { InFlightRegistry, RunTermination } from '../execution/in-flight-registry.js';

const OWNER_SOURCE: ExecutionSource = {
  channel: 'user',
  actor: 'user_self',
  user_id: 'u1',
  client_token_id: 'tok-web',
};

/** A single template transform — succeeds with no manifests / IO. */
const SUCCEEDS: RecipeDefinition = {
  recipe_id: 'cancel-mislabel-succeeds',
  version: 1,
  ttl: 60,
  metadata: { name: 's', description: 'd', author: 'test', supported_platforms: ['test'] },
  variables: {},
  prefetch_steps: [],
  steps: [{ id: 'only', transform: 'template', template: 'ok' }],
  output: { sidebar: [] },
} as unknown as RecipeDefinition;

/** A template step whose `fail_on` fires after it runs → deterministic failure
 *  with an ORDINARY error (no `slot_cancelled` marker). */
const FAILS: RecipeDefinition = {
  recipe_id: 'cancel-mislabel-fails',
  version: 1,
  ttl: 60,
  metadata: { name: 'f', description: 'd', author: 'test', supported_platforms: ['test'] },
  variables: {},
  prefetch_steps: [],
  steps: [{ id: 'boom', transform: 'template', template: 'x', fail_on: '{{step.boom}} equal x' }],
  output: { sidebar: [] },
} as unknown as RecipeDefinition;

/** One gated ingredient step — its lane `acquire` is rejected by the fake
 *  governor below, producing a real `slot_cancelled` step error. */
const GATED: RecipeDefinition = {
  recipe_id: 'cancel-mislabel-gated',
  version: 1,
  ttl: 60,
  metadata: { name: 'g', description: 'd', author: 'test', supported_platforms: ['test'] },
  variables: {},
  prefetch_steps: [],
  steps: [{ id: 'gated', ingredient: 'some-gated-op', input: {} }],
  output: { sidebar: [] },
} as unknown as RecipeDefinition;

/** A stub registry: `takeTermination` hands back the injected kill marker (the
 *  ONLY marker the registry writes now — `cancel()` writes none). */
const stubRegistry = (termination: RunTermination | undefined): InFlightRegistry =>
  ({
    registerRun: () => {},
    completeRun: () => {},
    takeTermination: () => termination,
    isActive: () => false,
    attachSubprocess: () => 'child_0',
    detachSubprocess: () => {},
    markStalled: () => {},
  }) as unknown as InFlightRegistry;

/** A lane governor whose `acquire` rejects as if the queued slot was cancelled. */
const rejectingGovernor: LaneGovernor = {
  acquire: async () => {
    const err = new Error('slot cancelled') as Error & { code: string };
    err.code = 'slot_cancelled';
    throw err;
  },
};

/** A minimal read-tier http manifest so the GATED recipe's ingredient passes
 *  strict validation (so execution reaches the governor, which then rejects). A
 *  read op draws no approval ask; `http` → the gated `external-io` lane. */
const GATED_MANIFEST: IngredientManifest = {
  slug: 'some-gated-op',
  name: 'Some Gated Op',
  description: 'Read-tier http fixture whose lane acquire is cancelled.',
  author: 'test',
  kind: 'http',
  category: 'data',
  risk_tier: 'read',
  version: 1,
  input: {},
  output: {},
} as unknown as IngredientManifest;

const makeDeps = (
  recipe: RecipeDefinition,
  inFlightRegistry: InFlightRegistry,
  laneGovernor?: LaneGovernor,
): ExecuteHandlerDeps => {
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(recipe);
  const manifests = createManifestRegistry('/nonexistent');
  manifests.register(GATED_MANIFEST);
  return {
    recipeStore,
    executorConfig: { manifests },
    baseVault: {},
    inFlightRegistry,
    ...(laneGovernor ? { laneGovernor } : {}),
  };
};

describe('D-181 §7c — run_terminated derived from the real outcome, never mislabels', () => {
  it('a SUCCESSFUL run with a `killed` marker IS stamped (a deliberate kill is honored even if the run finished first)', async () => {
    // A kill firing when only transforms/guards remain isn't observed by the
    // gated-call abort check, so the run can complete `success: true` — but the
    // owner's `execution.kill` is deliberate and must not be silently discarded.
    const deps = makeDeps(SUCCEEDS, stubRegistry('killed'));
    const result = await handleExecute(deps, {
      recipe_id: 'cancel-mislabel-succeeds',
      execution_source: OWNER_SOURCE,
    });
    expect(result.success).toBe(true);
    expect(result.run_terminated).toBe('killed');
  });

  it('a FAILED run with a `killed` marker IS stamped killed', async () => {
    const deps = makeDeps(FAILS, stubRegistry('killed'));
    const result = await handleExecute(deps, {
      recipe_id: 'cancel-mislabel-fails',
      execution_source: OWNER_SOURCE,
    });
    expect(result.success).toBe(false);
    expect(result.run_terminated).toBe('killed');
  });

  it('a run FAILED by a cancelled gated call (slot_cancelled error, NO kill marker) is stamped cancelled_before_dispatch', async () => {
    const deps = makeDeps(GATED, stubRegistry(undefined), rejectingGovernor);
    const result = await handleExecute(deps, {
      recipe_id: 'cancel-mislabel-gated',
      execution_source: OWNER_SOURCE,
    });
    expect(result.success).toBe(false);
    expect(result.run_terminated).toBe('cancelled_before_dispatch');
  });

  it('a run that FAILED for an UNRELATED reason (no slot_cancelled, no kill) is NOT mislabelled (residual-a fix)', async () => {
    const deps = makeDeps(FAILS, stubRegistry(undefined));
    const result = await handleExecute(deps, {
      recipe_id: 'cancel-mislabel-fails',
      execution_source: OWNER_SOURCE,
    });
    expect(result.success).toBe(false);
    expect(result.run_terminated).toBeUndefined();
  });

  it('a successful run with NO marker stays a normal success', async () => {
    const deps = makeDeps(SUCCEEDS, stubRegistry(undefined));
    const result = await handleExecute(deps, {
      recipe_id: 'cancel-mislabel-succeeds',
      execution_source: OWNER_SOURCE,
    });
    expect(result.success).toBe(true);
    expect(result.run_terminated).toBeUndefined();
  });
});
