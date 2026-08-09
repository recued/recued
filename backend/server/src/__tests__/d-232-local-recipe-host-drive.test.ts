/** D-232 — the HOST half of gateway-routed local recipe invocation, driven.
 *
 * `packages/engine`'s `d-232-local-recipe-routing.test.ts` proves the GATEWAY
 * routes local vs remote against a stub invoker. That leaves the half this file
 * exists for: whether the server actually wires one, and what the nested run
 * inherits when it does.
 *
 * ⛔ WHY EVERY TEST HERE ENTERS AT `handleExecute`. This feature has produced
 * the same failure four times — a seam that exists, is typed, is tested, and is
 * never reached (the semi-live harness that recorded the outbound call instead
 * of making it; `recipe.invoke` wired to a `compose_noop` stub; a fire point
 * wrapping one of two exit paths). A test that builds its own `ExecutionContext`
 * and hands it a `localRecipeInvoker` proves the engine's contract over again
 * and says nothing about the host. So the recipes here are registered in a real
 * recipe store, the catalog is a real manifest in a real registry, and the only
 * entry point is the one the wire uses.
 *
 * ⛔ AND THE PROPERTY UNDER TEST IS NOT "DID B RUN". It is whether B ran under
 * A's CONTRACT. An invoker that drops the caller's `execution_source` /
 * `contract_snapshot` still runs B, still returns a value, still looks right
 * from the outside — and has quietly laundered a nested run out of the gate
 * that authorized the outer one. Two tests below pin that: one reads the
 * contract off B's own audit row, the other proves the inherited contract still
 * BITES (a tool outside `allowed_tools` is denied to the callee too).
 *
 * ── MUTATION RECORD (2026-08-06) ────────────────────────────────────
 * Each host guard was removed in turn and this file re-run, because a green
 * suite says nothing until you have seen what reddens it:
 *
 *   drop `execution_source` + `contract_snapshot` → 2 red (carried, enforced)
 *   `heldRecipes` seeded empty instead of with this run's recipe → 2 red
 *   drop `held_recipes` into the nested run → ⛔ THE WORKER DIES:
 *       `ERR_WORKER_OUT_OF_MEMORY`. A → B → A → B … is genuinely unbounded —
 *       the Gateway's `MAX_DISPATCH_DEPTH` bites only where a commit store is
 *       wired, and nothing else stops it. The tell is the test COUNT vanishing
 *       from the summary, not a red line.
 *   nested failure not propagated → 4 red
 *   reachability admits everything → 1 red (only after the assertion was
 *       strengthened to the REASON — `success: false` alone could not tell a
 *       refusal from a dispatch that hit `recipe_not_found` inside the callee,
 *       and passed against the mutant)
 *   no `localRecipeInvoker` at all → 8 of 9 red
 */
import { beforeEach, describe, expect, it } from 'vitest';

import type {
  ContractSnapshot,
  ExecutionSource,
  IngredientManifest,
  RecipeDefinition,
} from '@recued/contracts';

import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore, type RecipeStore } from '../recipe-store.js';
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import type { AuditEntry } from '@recued/storage';

const CATALOG = 'd232-fixture-catalog';
/** A second catalog, installed and resolvable but deliberately ABSENT from the
 *  contract's `allowed_tools`. It exists so a nested run can be shown meeting a
 *  restriction that belongs to the CALLER's contract. */
const RESTRICTED = 'd232-restricted-catalog';
const CALLER = 'd232-caller';
const CALLEE = 'd232-callee';
const GRANDCHILD = 'd232-grandchild';
const MISSING = 'd232-not-installed';

/** The fixture catalog. Four `mcp` bindings, and NOT ONE OF THEM names a
 *  connection — that absence IS the local route (`isLocalRecipeInvocation`).
 *  `read_call` admits under a contracted ceiling, `write_call` is floored to
 *  `ask` by risk, `self_call` closes a loop, and `missing_call` names a recipe
 *  that was never installed. Registered twice, under two slugs, so one of them
 *  can sit outside the contract's `allowed_tools`. */
const catalogManifest = (slug: string = CATALOG): IngredientManifest => ({
  slug,
  name: 'D-232 fixture catalog',
  description: 'Local-recipe bindings for the D-232 host drive.',
  author: 'recued-core',
  version: 1,
  kind: 'connection',
  category: 'action',
  risk_tier: 'read',
  input: {},
  output: {},
  operations: {
    read_call: { operation_id: `${slug}.read_call`, risk_tier: 'read', groups: ['g'] },
    write_call: { operation_id: `${slug}.write_call`, risk_tier: 'write', groups: ['g'] },
    self_call: { operation_id: `${slug}.self_call`, risk_tier: 'read', groups: ['g'] },
    missing_call: { operation_id: `${slug}.missing_call`, risk_tier: 'read', groups: ['g'] },
  },
  surfaces: {
    api: {
      transport: 'rest',
      default_base_url: 'https://fixture.invalid',
      auth: { kind: 'none' },
      executes: {
        read_call: { kind: 'mcp', tool: `recued-core/${CALLEE}` },
        write_call: { kind: 'mcp', tool: `recued-core/${GRANDCHILD}` },
        self_call: { kind: 'mcp', tool: `recued-core/${CALLER}` },
        missing_call: { kind: 'mcp', tool: `recued-core/${MISSING}` },
      },
    },
  },
} as unknown as IngredientManifest);

/** A recipe with one catalog step, rendering whatever that step produced —
 *  `ExecuteResponse.steps[]` carries no values (the response builder projects
 *  them away), so `output.render` is the only way to see what the invoke
 *  returned.
 *
 *  ⚠ It declares `note` because a NESTED run is subject to the same
 *  declared-variable boundary as any wire caller: the op's args land as the
 *  callee's `config`, and an undeclared key refuses the run
 *  ("config key not declared by this recipe … (wire)"). Found by this fixture
 *  omitting it. That is the correct posture — an op's declared args and the
 *  callee's declared variables are the same contract seen from two sides — but
 *  it means a binding whose args drift from its target's variables fails at
 *  dispatch, not at install. */
const invokingRecipe = (
  recipe_id: string,
  operation: string,
  catalog: string = CATALOG,
): RecipeDefinition => ({
  recipe_id,
  version: 1,
  ttl: 0,
  metadata: {
    name: recipe_id,
    description: 'D-232 host-drive fixture.',
    author: 'recued-core',
    supported_platforms: ['test'],
    tags: ['test', 'd-232'],
  },
  variables: { note: { label: 'note', type: 'string' } },
  prefetch_steps: [],
  steps: [{ id: 'invoke', ingredient: catalog, input: { operation, args: { note: 'hello' } } }],
  output: { render: [{ type: 'json', source: 'step.invoke', label: 'nested' }] },
} as unknown as RecipeDefinition);

/** A transform-only callee. Nothing it does can fail for an environmental
 *  reason, so a failure here is the invoke path's. */
const leafRecipe = (recipe_id: string): RecipeDefinition => ({
  recipe_id,
  version: 1,
  ttl: 0,
  metadata: {
    name: recipe_id,
    description: 'D-232 host-drive leaf.',
    author: 'recued-core',
    supported_platforms: ['test'],
    tags: ['test', 'd-232'],
  },
  variables: { note: { label: 'note', type: 'string' } },
  prefetch_steps: [],
  steps: [
    { id: 'echo', transform: 'template', template: `${recipe_id}:{{config.note}}` },
  ],
  output: { render: [{ type: 'json', source: 'step.echo', label: 'echo' }] },
} as unknown as RecipeDefinition);

/** A callee that FAILS, on purpose and with a message. */
const failingLeafRecipe = (recipe_id: string): RecipeDefinition => ({
  ...leafRecipe(recipe_id),
  steps: [
    { id: 'boom', transform: 'template', template: 'd232 callee refused', fail_on: 'true equal true' },
  ],
} as unknown as RecipeDefinition);

const MCP_SOURCE: ExecutionSource = {
  channel: 'mcp',
  actor: 'contracted_user',
  agent_id: 'agent_peer',
  tool_call_id: 'tc_1',
  mcp_token_id: 'tok_peer',
  contract_id: 'ct_peer_alice',
};

const CONTRACT: ContractSnapshot = {
  contract_id: 'ct_peer_alice',
  contract_version: '1',
  allowed_tools: [CATALOG, CALLER, CALLEE, GRANDCHILD],
  approval_required: [],
  scope_restrictions: [],
  resolved_at: 1_900_000_000_000,
};

interface Env {
  deps: ExecuteHandlerDeps;
  recipeStore: RecipeStore;
  audit: AuditEntry[];
}

const buildEnv = (recipes: readonly RecipeDefinition[]): Env => {
  const recipeStore = createRecipeStore('/nonexistent-d232-host-drive');
  for (const r of recipes) recipeStore.register(r);
  const manifests = createManifestRegistry('/nonexistent-d232-host-drive');
  manifests.register(catalogManifest());
  manifests.register(catalogManifest(RESTRICTED));
  const audit: AuditEntry[] = [];
  return {
    recipeStore,
    audit,
    deps: {
      recipeStore,
      executorConfig: { manifests },
      baseVault: {},
      instanceId: 'd232-host-drive',
      // The audit log is the SINK this file observes through, not a stub of
      // anything on the path: `handleExecute` writes one anchor per run with the
      // run's `execution_source` + `contract_snapshot`, so B's row is the
      // system's own record of who B ran as.
      auditLog: {
        append: (entry: AuditEntry) => { audit.push(entry); return Promise.resolve(); },
      } as unknown as ExecuteHandlerDeps['auditLog'],
    },
  };
};

const run = (env: Env, recipe_id: string) => handleExecute(env.deps, {
  recipe_id,
  execution_source: MCP_SOURCE,
  contract_snapshot: CONTRACT,
  trigger_source: 'mcp',
});

/** Every audit anchor written for one recipe. A run writes exactly one, so this
 *  doubles as "how many times did it run" — the only way to see a cycle guard
 *  that fired one hop too late. */
const rowsFor = (env: Env, recipe_id: string): AuditEntry[] =>
  env.audit.filter((e) => e.recipe_id === recipe_id);

const errorText = (res: { errors: readonly unknown[] }): string => JSON.stringify(res.errors);

describe('D-232 host drive — a recipe invokes a local recipe through the real handler', () => {
  let env: Env;

  beforeEach(() => {
    env = buildEnv([
      invokingRecipe(CALLER, 'read_call'),
      leafRecipe(CALLEE),
      leafRecipe(GRANDCHILD),
    ]);
  });

  it('✅ the callee RUNS in-process, and its result is the calling step\'s value', async () => {
    const res = await run(env, CALLER);
    expect(res.success, errorText(res)).toBe(true);

    // The nested ExecuteResponse itself is the step value — not an MCP
    // envelope. That is what makes the gateway's paused-run guard reachable:
    // it reads `awaiting_approval` / `success` off the TOP level.
    const nested = res.output.render[0]?.data as { recipe_id?: string; success?: boolean };
    expect(nested?.recipe_id).toBe(CALLEE);
    expect(nested?.success).toBe(true);

    // Two runs, two audit anchors, two run ids — the callee gets its OWN audit
    // identity rather than writing into the caller's.
    expect(rowsFor(env, CALLER)).toHaveLength(1);
    expect(rowsFor(env, CALLEE)).toHaveLength(1);
    expect(rowsFor(env, CALLEE)[0]!.run_id).not.toBe(rowsFor(env, CALLER)[0]!.run_id);
  });

  it("✅ the callee's args arrive as config.* — the op's args, not the caller's", async () => {
    const res = await run(env, CALLER);
    const nested = res.output.render[0]?.data as {
      output?: { render?: { data?: unknown }[] };
    };
    expect(nested?.output?.render?.[0]?.data).toBe(`${CALLEE}:hello`);
  });

  it('✅✅ the callee runs under the CALLER\'S CONTRACT — read off its own audit row', async () => {
    // ⛔ The assertion that matters. An invoker that minted a fresh source (or
    // simply omitted the snapshot, which is the version that compiles) would
    // pass every other test in this file: B runs, B returns, A succeeds. What
    // it would have done is let a recipe launder a nested run out of the gate
    // that authorized the outer one.
    await run(env, CALLER);
    const calleeRow = rowsFor(env, CALLEE)[0]!;
    expect(calleeRow.contract_snapshot?.contract_id).toBe(CONTRACT.contract_id);
    expect(calleeRow.execution_source).toEqual(MCP_SOURCE);
    // Same contract as the caller's row, not merely a contract.
    expect(calleeRow.contract_snapshot)
      .toEqual(rowsFor(env, CALLER)[0]!.contract_snapshot);
  });

  it('✅✅ and the inherited contract BITES — a tool outside it is DENIED to the callee', async () => {
    // The audit row proves the contract was CARRIED. This proves it is
    // ENFORCED, and it is the one assertion here that a dropped inheritance
    // turns GREEN: the per-call admission probe runs only for a policy-gated
    // channel, i.e. only when the nested run has an `execution_source` at all.
    // Inherit ⇒ the callee's step on a catalog outside `allowed_tools` is
    // denied. Drop the source + snapshot from the invoker's request ⇒ no probe,
    // the same step admits, and the callee succeeds.
    //
    // ⚠ NOT provable via the trust ceiling, which was this test's first shape:
    // a nested run with NO source is not treated as the owner, so its write
    // still hits the `ask` floor and the run fails either way. "Fails both
    // ways" is not enforcement — it is a test that cannot see the difference.
    env = buildEnv([
      invokingRecipe(CALLER, 'read_call'),
      invokingRecipe(CALLEE, 'read_call', RESTRICTED),
      leafRecipe(GRANDCHILD),
    ]);
    const res = await run(env, CALLER);
    expect(res.success).toBe(false);
    // Assert the REASON, not merely a failure: the denial names the caller's
    // contract and the tool that is outside it.
    expect(errorText(res)).toContain('tool_not_in_contract');
    expect(errorText(res)).toContain(RESTRICTED);
    expect(errorText(res)).toContain(CALLEE);
    // The grandchild sits on the far side of the denied step.
    expect(rowsFor(env, GRANDCHILD), 'the denied step dispatched anyway').toHaveLength(0);
  });

  it('✅ a nested run is not PRIVILEGED either — its write still meets the approval floor', async () => {
    // Separate from the contract question and worth its own line: the local arm
    // dispatches through the same gate as any other op, so a `write` inside the
    // callee is floored to `ask` exactly as it would be at the top level. A
    // nested run is not a way to get a quieter one.
    env = buildEnv([
      invokingRecipe(CALLER, 'read_call'),
      invokingRecipe(CALLEE, 'write_call'),
      leafRecipe(GRANDCHILD),
    ]);
    const res = await run(env, CALLER);
    expect(res.success).toBe(false);
    expect(errorText(res)).toContain(CALLEE);
    expect(rowsFor(env, GRANDCHILD), 'the held write dispatched anyway').toHaveLength(0);
  });

  it('⛔ a callee that FAILS fails the calling step — never a value that flows on', async () => {
    // The remote arm classifies a peer's tool error as a step failure
    // (`mcp_tool_error`). The local arm must not be more forgiving than the
    // wire: a `success:false` response is a well-formed object, and returning
    // it as the step's value would let the caller run on and report success.
    env = buildEnv([invokingRecipe(CALLER, 'read_call'), failingLeafRecipe(CALLEE)]);
    const res = await run(env, CALLER);
    expect(res.success).toBe(false);
    expect(errorText(res)).toContain(CALLEE);
    expect(rowsFor(env, CALLEE), 'the callee never ran').toHaveLength(1);
  });

  it('⛔⛔ A → A is REFUSED at the first hop — the root seed, which nothing else covers', async () => {
    // `heldRecipes` is seeded with the running recipe at the one place a run
    // starts. Without the seed the guard is a SENDER-only guard: the first hop
    // is admitted, the caller re-enters itself, and only the second hop
    // refuses. Both shapes fail the run — the difference is visible ONLY in how
    // many times the recipe ran, which is why this asserts on the row count.
    env = buildEnv([invokingRecipe(CALLER, 'self_call')]);
    const res = await run(env, CALLER);
    expect(res.success).toBe(false);
    expect(errorText(res)).toContain('cycle');
    expect(rowsFor(env, CALLER), 'it re-entered itself before refusing').toHaveLength(1);
  });

  it('⛔⛔ A → B → A is REFUSED — the widened stack reached the nested run', async () => {
    // The gateway hands the invoker `held_recipes` widened with the callee; the
    // host must thread it into the nested run's own `heldRecipes`. Without
    // that, B starts with a fresh stack and A → B → A walks straight through —
    // and keeps walking: the mutation run died `ERR_WORKER_OUT_OF_MEMORY`, not
    // at some depth ceiling, because the only bound on this loop is this set.
    env = buildEnv([
      invokingRecipe(CALLER, 'read_call'),
      invokingRecipe(CALLEE, 'self_call'),
    ]);
    const res = await run(env, CALLER);
    expect(res.success).toBe(false);
    expect(errorText(res)).toContain('cycle');
    expect(rowsFor(env, CALLER), 'the loop closed and ran the caller again').toHaveLength(1);
    expect(rowsFor(env, CALLEE)).toHaveLength(1);
  });

  it('⛔ a binding naming a recipe this server does not have is DENIED, not dispatched', async () => {
    // The reachability resolver's whole content: a binding must name a recipe
    // that exists here. Asserted as a REFUSAL rather than as "nothing ran" —
    // the latter passes whether the call was denied or dispatched into a
    // no-op.
    env = buildEnv([invokingRecipe(CALLER, 'missing_call')]);
    const res = await run(env, CALLER);
    expect(res.success).toBe(false);
    // ⛔ ASSERT THE REASON. `success: false` alone cannot tell a REFUSAL from a
    // dispatch that went ahead and hit `recipe_not_found` inside the nested
    // run — both fail the step, and the weaker assertion passed happily with
    // the resolver mutated to admit everything.
    expect(errorText(res)).toContain('operation_not_granted');
    expect(errorText(res)).not.toContain('recipe_not_found');
    expect(rowsFor(env, MISSING)).toHaveLength(0);
  });
});
