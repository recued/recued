/** D-165 op-identity binding — backend connection-drift E2E regression.
 *
 *  The crown-jewel regression for the op-identity binding fix (commit
 *  107afcf9). The engine-side gate is unit-tested in
 *  `packages/engine/src/__tests__/d-165-op-identity-binding.test.ts`; the
 *  resumer's `buildResumeInputs` threading is covered by the D-157
 *  server-wiring resume tests. This file proves the WHOLE backend path:
 *
 *    pause (catalog `ask`) → `Checkpoint.approved_target` write
 *      → resume → `resume_from.approved_target` thread
 *      → `StepMeta.preflight_approved_target`
 *      → catalog gate re-verification against the re-resolved triple.
 *
 *  THE GAP it guards: preflight RESUME used to be POSITION-only — the
 *  catalog gate honored `preflight_admitted` (set by matching the gated
 *  step id) WITHOUT re-verifying the resolved (ingredient, operation,
 *  connection) still matched what the user approved. A step whose
 *  `connection` is a `{{config.*}}` ref can resolve to a DIFFERENT
 *  connection on resume (config drifted while paused, or the recipe was
 *  re-authored at the same step id), so an approval for connection A
 *  could silently admit a now-resolved B. The fix re-asks on any drift
 *  (fail closed); these tests assert the re-ask end-to-end.
 *
 *  Mutation-sensitivity: revert the fix to position-only and the drift
 *  cases (1, 3) flip — the resumed call would DISPATCH against the
 *  drifted connection (one `connection_gateway` success row + a fetch)
 *  instead of minting a fresh checkpoint carrying the drifted identity.
 *  The positive control (2) admits a MATCHING resume, proving the re-ask
 *  is drift-specific and not a harness that always re-asks.
 *
 *  Coverage layers: tests 1-2 drive the execute-handler resume BOUNDARY
 *  directly — `handleExecute` with the same `internal.resume_from` inputs
 *  the resumer threads — to pin the handler contract (re-verify the
 *  resolved triple; never trust the gated-step position alone). NOTE the
 *  production `createPreflightResumer` replays the FROZEN
 *  `anchor.config_snapshot`, so a literal "config changed while paused"
 *  drift cannot reach the gate THROUGH the resumer — the binding is
 *  defence-in-depth the handler/gate must enforce regardless. The
 *  connection-independent drift that DOES reach the real resumer is recipe
 *  re-authoring, which test 3 drives end-to-end through it.
 *
 *  Spec: docs/d-165-spec.md § Runtime flow / Invariants 1 + 5; the gate
 *  is `packages/engine/src/catalog-gateway.ts` (`catalogTargetMatches`).
 */

import type {
  Checkpoint,
  ConnectionOperationProfile,
  ConnectionRow,
  IngredientManifest,
  OperationSpec,
  RecipeDefinition,
} from '@recued/contracts';
import type { ConnectionAdapterStore } from '@recued/ingredients';
import type { PreflightAskContext } from '@recued/gateway';
import {
  createAuditLogStore,
  createInMemoryCollection,
  type ActivityEntry,
  type AuditEntry,
  type AuditLogStore,
  type CheckpointStore,
} from '@recued/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  handleExecute,
  type ExecuteHandlerDeps,
} from '../execute-handler.js';
import { createPreflightResumer } from '../preflight-resumer.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { createInMemoryConnectionOperationProfileStore } from '../connection-operation-profile.js';

const CATALOG_SLUG = 'pub/cat';
// `OP_KEY` is the operation map KEY the recipe step names (`input.operation`);
// `OP_ID` is the declared `OperationSpec.operation_id` the gate resolves it to
// and stamps on the approved-target triple.
const OP_KEY = 'x';
const OP_ID = 'pub/cat.x';
const GATED_STEP = 'gated_write';
const CONN_A = 'conn-a'; // the connection the user approves at pause
const CONN_B = 'conn-b'; // the drifted connection the resume re-resolves to

const GRANTED: ConnectionOperationProfile = { allowed_operations: [OP_KEY] };

/** Catalog-form fixture: a non-empty `operations` map routes the call
 *  through the D-165 gateway. `kind: 'connection'` + a `surfaces.api` REST
 *  binding so an ADMIT dispatches over the binding through the connection
 *  adapter (mocked fetch) — that lets the positive control observe a real
 *  dispatch. The operation is `write` so the gate resolves `ask` against a
 *  profile that grants it (write is never auto-admitted, Inv 3); the
 *  manifest's static `risk_tier` is read and is deliberately NOT the policy
 *  source (Inv 1). */
const catalogManifest = (): IngredientManifest =>
  ({
    slug: CATALOG_SLUG,
    name: 'Catalog Writer',
    description: 'Catalog-form fixture for D-165 op-identity drift tests.',
    author: 'pub',
    kind: 'connection',
    category: 'action',
    risk_tier: 'read',
    version: 1,
    input: { operation: null, args: null },
    output: { ok: 'ok' },
    operations: {
      [OP_KEY]: { operation_id: OP_ID, risk_tier: 'write' },
    } satisfies Record<string, OperationSpec>,
    surfaces: {
      api: {
        transport: 'rest',
        default_base_url: 'https://example.test',
        auth: { kind: 'none' },
        executes: {
          [OP_KEY]: { kind: 'rest', method: 'POST', path_template: '/catalog' },
        },
      },
    },
  }) as IngredientManifest;

/** Recipe whose single gated step targets the catalog ingredient with a
 *  `{{config.*}}` connection — the live drift surface. */
const driftRecipe = (recipe_id = 'd-165-op-identity-drift'): RecipeDefinition =>
  ({
    recipe_id,
    version: 1,
    ttl: 60,
    metadata: {
      name: recipe_id,
      description: 'Catalog write gated on a {{config.*}} connection.',
      author: 'test',
      supported_platforms: ['test'],
      tags: ['test', 'preflight', 'd-165'],
    },
    variables: { conn: CONN_A },
    prefetch_steps: [],
    steps: [
      {
        id: GATED_STEP,
        ingredient: CATALOG_SLUG,
        connection: '{{config.conn}}',
        input: { operation: OP_KEY },
      },
    ],
    output: { sidebar: [] },
  }) as RecipeDefinition;

/** Minimal mocked `fetch` Response. Uses a real `Headers` so the
 *  connection-api handler's `responseHeadersToObject` (which iterates with
 *  `forEach`) works, not just `.get`. */
const jsonResponse = (body: unknown) =>
  ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as Response;

/** Minimal connection store: returns a base_url'd `api` row for any requested
 *  name so the catalog's REST surface binding (`/catalog` against
 *  'https://example.test') resolves through the connection-api handler to the
 *  mocked global fetch. */
const connectionRowStore = (): ConnectionAdapterStore => ({
  get: (kind, name) =>
    kind === 'api'
      ? ({
          pk: `api:${name}`,
          kind: 'api',
          name,
          display_name: name,
          config_json: JSON.stringify({ base_url: 'https://example.test' }),
          auth_ciphertext: '',
          enrolled_at: 0,
          updated_at: 0,
        } as ConnectionRow)
      : null,
});

/** In-memory checkpoint store that records every write so the test can
 *  count + inspect the pause checkpoint vs. the re-ask checkpoint. */
const checkpointStore = (): CheckpointStore & {
  written: Map<string, Checkpoint>;
  write: ReturnType<typeof vi.fn>;
} => {
  const written = new Map<string, Checkpoint>();
  const store = {
    written,
    write: vi.fn(async (checkpoint: Checkpoint) => {
      written.set(checkpoint.checkpoint_id, checkpoint);
    }),
    get: vi.fn(async (id: string) => written.get(id) ?? null),
    delete: vi.fn(async (id: string) => {
      written.delete(id);
    }),
    listByRun: vi.fn(async (run_id: string) =>
      [...written.values()].filter((c) => c.run_id === run_id),
    ),
    list: vi.fn(async () => [...written.values()]),
    size: vi.fn(async () => written.size),
  };
  return store as unknown as CheckpointStore & typeof store;
};

const auditLog = (): AuditLogStore =>
  createAuditLogStore(
    createInMemoryCollection<AuditEntry>(),
    createInMemoryCollection<ActivityEntry>(),
  );

const gatewayRows = async (log: AuditLogStore): Promise<ActivityEntry[]> =>
  (await log.listActivities()).filter((a) => a.action === 'connection_gateway');

interface Harness {
  deps: ExecuteHandlerDeps;
  recipeStore: ReturnType<typeof createRecipeStore>;
  log: AuditLogStore;
  checkpoints: ReturnType<typeof checkpointStore>;
}

const setup = (
  recipe: RecipeDefinition,
  profileSeed: Record<string, ConnectionOperationProfile>,
): Harness => {
  const registry = createManifestRegistry('/nonexistent');
  registry.register(catalogManifest());
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(recipe);
  const log = auditLog();
  const checkpoints = checkpointStore();
  const deps: ExecuteHandlerDeps = {
    recipeStore,
    executorConfig: {
      manifests: registry,
      // D-165 RUNTIME — the catalog dispatches over its `surfaces.api` REST
      // binding through the connection adapter; wire a minimal store (one
      // base_url'd row per requested name) + a no-auth api handler so an
      // admitted resume actually reaches `fetch` (mocked above).
      connectionStore: connectionRowStore(),
      connectionApi: {
        decodeAuth: async () => ({ type: 'none' }),
        persistAuth: async () => {},
        fetchImpl: fetchMock as unknown as typeof fetch,
      },
    },
    baseVault: {},
    instanceId: 'server-test-1',
    auditLog: log,
    checkpointStore: checkpoints,
    connectionOperationProfiles:
      createInMemoryConnectionOperationProfileStore(profileSeed),
  };
  return { deps, recipeStore, log, checkpoints };
};

const pause = (deps: ExecuteHandlerDeps, recipe_id: string, conn: string) =>
  handleExecute(deps, {
    recipe_id,
    trigger_source: 'manual',
    config: { conn },
  });

/** Resume at the execute-handler boundary with the same `internal` inputs
 *  `PreflightResumer.buildResumeInputs` threads — the consumed checkpoint's
 *  `step_state` + `approved_target` on `internal.resume_from`, the paused
 *  anchor's `run_id` re-issued. The ONE divergence is `config`: the
 *  production resumer replays the FROZEN `anchor.config_snapshot`, whereas
 *  here the caller chooses `conn` so the gated step re-resolves a different
 *  connection on resume — inducing the drift directly to pin the handler's
 *  re-verification contract (test 3 covers the realistic drift through the
 *  real resumer). */
const resumeDirect = (
  deps: ExecuteHandlerDeps,
  checkpoint: Checkpoint,
  conn: string,
) =>
  handleExecute(
    deps,
    { recipe_id: checkpoint.recipe_id, trigger_source: 'manual', config: { conn } },
    {
      run_id: checkpoint.run_id,
      resume_from: {
        // `resumeDirect` only ever resumes a GATED checkpoint (gated_step_id is
        // set when the checkpoint is written), so assert it non-null exactly as
        // the production `buildResumeInputs` does behind the `isCheckpoint` guard.
        gated_step_id: checkpoint.gated_step_id!,
        step_state: checkpoint.step_state,
        ...(checkpoint.approved_target !== undefined
          ? { approved_target: checkpoint.approved_target }
          : {}),
      },
    },
  );

const fetchMock = vi.fn();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(jsonResponse({ ok: 'yes' }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('D-165 op-identity binding — backend connection-drift E2E', () => {
  it('re-asks with a fresh checkpoint carrying the drifted connection when the resumed config resolves a different one', async () => {
    const recipe = driftRecipe();
    const { deps, log, checkpoints } = setup(recipe, {
      [CONN_A]: GRANTED,
      [CONN_B]: GRANTED,
    });

    // ── PAUSE on conn-a — the user is approving a write against conn-a.
    const paused = await pause(deps, recipe.recipe_id, CONN_A);
    expect(paused.success).toBe(false);
    expect(checkpoints.write).toHaveBeenCalledTimes(1);
    const cp1 = checkpoints.write.mock.calls[0]?.[0] as Checkpoint;
    expect(cp1.approved_target).toEqual({
      ingredient_slug: CATALOG_SLUG,
      operation_id: OP_ID,
      connection_name: CONN_A,
    });
    const anchor1 = await log.get(cp1.run_id);
    expect(anchor1?.commit_status).toBe('awaiting_approval');
    expect(anchor1?.checkpoint_id).toBe(cp1.checkpoint_id);

    // ── RESUME at the handler boundary with the gated step re-resolving
    //    a DIFFERENT connection (conn-b) than the approval named (conn-a).
    //    The handler must re-verify the resolved triple — never trust the
    //    gated-step position — and re-ask rather than dispatch conn-b.
    const resumed = await resumeDirect(deps, cp1, CONN_B);

    // A SECOND checkpoint, carrying the DRIFTED identity (the gate
    // re-raised with the current connection, not the stale approval).
    expect(checkpoints.write).toHaveBeenCalledTimes(2);
    const cp2 = checkpoints.write.mock.calls[1]?.[0] as Checkpoint;
    expect(cp2.checkpoint_id).not.toBe(cp1.checkpoint_id);
    expect(cp2.run_id).toBe(cp1.run_id); // same execution-request anchor
    expect(cp2.approved_target).toEqual({
      ingredient_slug: CATALOG_SLUG,
      operation_id: OP_ID,
      connection_name: CONN_B,
    });

    // A clean pause, not a dispatch failure.
    expect(resumed.success).toBe(false);
    expect(resumed.errors).toEqual([]);

    // The run anchor is re-pinned to the fresh checkpoint, still awaiting.
    const anchor2 = await log.get(cp1.run_id);
    expect(anchor2?.commit_status).toBe('awaiting_approval');
    expect(anchor2?.checkpoint_id).toBe(cp2.checkpoint_id);

    // 0 dispatch: the catalog op never executed — no gateway audit row,
    // and fetch (the only real side-effect path) was never reached.
    expect(await gatewayRows(log)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('admits and dispatches once when the resumed connection matches the approved identity (drift-specificity control)', async () => {
    const recipe = driftRecipe();
    const { deps, log, checkpoints } = setup(recipe, { [CONN_A]: GRANTED });

    const paused = await pause(deps, recipe.recipe_id, CONN_A);
    expect(paused.success).toBe(false);
    const cp1 = checkpoints.write.mock.calls[0]?.[0] as Checkpoint;

    // ── RESUME with the SAME connection — the full triple matches, so
    //    the prior approval is honored and the call executes once.
    const resumed = await resumeDirect(deps, cp1, CONN_A);

    expect(resumed.success).toBe(true);
    // No re-ask: the pause checkpoint is the only one written.
    expect(checkpoints.write).toHaveBeenCalledTimes(1);

    // Dispatch happened exactly once: one connection_gateway success row
    // against conn-a + one fetch.
    const rows = await gatewayRows(log);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.target).toBe(CONN_A);
    const detail = JSON.parse(rows[0]?.detail ?? '{}') as {
      outcome: string;
      operation_id: string;
    };
    expect(detail.outcome).toBe('success');
    expect(detail.operation_id).toBe(OP_ID);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The anchor transitioned to terminal success.
    const anchor = await log.get(cp1.run_id);
    expect(anchor?.commit_status).toBe('succeeded');
  });

  it('re-asks end-to-end through createPreflightResumer when the re-authored recipe resolves a different connection', async () => {
    const recipe = driftRecipe();
    const { deps, recipeStore, log, checkpoints } = setup(recipe, {
      [CONN_A]: GRANTED,
      [CONN_B]: GRANTED,
    });

    // ── PAUSE on conn-a, then drive the resume through the REAL resumer
    //    (decide → buildResumeInputs → handleExecute) — the production
    //    path the D-158 on_answer handler invokes.
    const paused = await pause(deps, recipe.recipe_id, CONN_A);
    expect(paused.success).toBe(false);
    const cp1 = checkpoints.write.mock.calls[0]?.[0] as Checkpoint;
    expect(cp1.approved_target?.connection_name).toBe(CONN_A);

    // The recipe is re-authored while paused: the SAME gated step now
    // binds conn-b directly. `recipeStore.get` re-fetches the current
    // recipe at resume, so the resumed gated step resolves conn-b — the
    // connection-independent drift the frozen config_snapshot can't mask.
    const reauthored = driftRecipe();
    (reauthored.steps[0] as { connection?: string }).connection = CONN_B;
    recipeStore.register(reauthored);

    const resumer = createPreflightResumer({
      getExecuteDeps: () => deps,
      auditLog: log,
    });
    const context: PreflightAskContext = {
      recipe_id: recipe.recipe_id,
      gated_step_id: GATED_STEP,
    };
    await resumer.resumeRun(cp1, context);

    // Re-ask end-to-end: a fresh checkpoint under the same anchor,
    // carrying the re-authored connection.
    expect(checkpoints.write).toHaveBeenCalledTimes(2);
    const cp2 = checkpoints.write.mock.calls[1]?.[0] as Checkpoint;
    expect(cp2.checkpoint_id).not.toBe(cp1.checkpoint_id);
    expect(cp2.run_id).toBe(cp1.run_id);
    // The full re-authored triple, not just the connection — proving the
    // production resumer path carries the current identity end-to-end.
    expect(cp2.approved_target).toEqual({
      ingredient_slug: CATALOG_SLUG,
      operation_id: OP_ID,
      connection_name: CONN_B,
    });

    const anchor = await log.get(cp1.run_id);
    expect(anchor?.commit_status).toBe('awaiting_approval');
    expect(anchor?.checkpoint_id).toBe(cp2.checkpoint_id);

    // 0 dispatch through the whole resumer path.
    expect(await gatewayRows(log)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
