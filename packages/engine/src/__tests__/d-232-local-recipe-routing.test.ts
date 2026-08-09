/** D-232 — the gateway ROUTES local vs remote; a recipe never declares which.
 *
 * The design: an `mcp` binding names a recipe, and whether the call leaves the
 * process is decided by whether a connection resolved. Connection present ⇒ a
 * peer's server over JSON-RPC. Connection absent ⇒ this one, in-process.
 *
 * ⛔ WHY THESE ARE GATEWAY TESTS AND NOT UNIT TESTS OF THE GUARD. The guard is
 * proved separately in `d-232-local-recipe-cycle.test.ts` against its own pure
 * functions — which proves the RULE and nothing about whether anything calls
 * it. Every assertion here drives the real `runCatalogOperation`, because the
 * failure this file exists to catch is the branch never being reached at all:
 * a routing predicate that returns false always looks exactly like a codebase
 * with no local recipes in it.
 */
import { describe, expect, it } from 'vitest';

import type {
  ConnectionOperationProfile,
  IngredientManifest,
  OperationSpec,
} from '@recued/contracts';

import { runCatalogOperation } from '../catalog-gateway.js';
import { NestedRunNotCompletedError, RecipeCycleError } from '../local-recipe-cycle.js';
import type {
  ExecutionContext,
  IngredientExecutor,
  LocalRecipeInvokeCall,
} from '../types.js';

const OP: OperationSpec = {
  operation_id: 'pub/cat.call',
  risk_tier: 'read',
  groups: ['g'],
};

/** An `mcp` binding naming a recipe — the shape the peer packs already ship. */
const mcpManifest = (tool = 'recued-core/target-recipe'): IngredientManifest => ({
  slug: 'pub/cat',
  name: 'Catalog',
  description: '',
  author: 'pub',
  kind: 'connection',
  category: 'action',
  risk_tier: 'read',
  input: {},
  output: {},
  operations: { call: OP },
  surfaces: {
    api: {
      transport: 'rest',
      default_base_url: 'https://api.example.com',
      auth: { kind: 'none' },
      executes: { call: { kind: 'mcp', tool } },
    },
  },
} as unknown as IngredientManifest);

/** Same op, a REST binding. Guards the other half of the predicate: a
 *  connectionless rest op is a misconfiguration, not a local call. */
const restManifest = (): IngredientManifest => {
  const m = mcpManifest() as any;
  m.surfaces.api.executes.call = { kind: 'rest', method: 'GET', path_template: '/x' };
  return m as IngredientManifest;
};

const profile = (): ConnectionOperationProfile => ({ allowed_operations: ['call'] });

const harness = (opts: {
  held?: ReadonlySet<string>;
  invoker?: ExecutionContext['localRecipeInvoker'];
  omitInvoker?: boolean;
  /** ⛔ Absent DENIES — so every test that expects a dispatch must opt in,
   *  which is itself the proof that the default is off. */
  reachable?: boolean;
} = {}) => {
  const invoked: LocalRecipeInvokeCall[] = [];
  const remote: { slug: string; input: Record<string, unknown> }[] = [];
  const ingredientExecutor: IngredientExecutor = async (slug, input) => {
    remote.push({ slug, input: input as Record<string, unknown> });
    return { ok: true, via: 'remote' };
  };
  const ctx: ExecutionContext = {
    recipe: { recipe_id: 'caller' } as any,
    stores: {} as any,
    ingredientExecutor,
    execution_source: {
      channel: 'chat',
      actor: 'contracted_user',
      chat_session_id: 's1',
      user_id: 'u1',
      contract_id: 'k1',
    } as any,
    connectionProfileResolver: () => profile(),
    localRecipeReachabilityResolver: () => opts.reachable !== false,
    ...(opts.held ? { heldRecipes: opts.held } : {}),
    ...(opts.omitInvoker ? {} : {
      localRecipeInvoker: opts.invoker ?? (async (call) => {
        invoked.push(call);
        return { ok: true, via: 'local' };
      }),
    }),
  };
  return { ctx, invoked, remote };
};

const call = (
  ctx: ExecutionContext,
  manifest: IngredientManifest,
  connectionName: string,
) => runCatalogOperation(
  ctx, manifest, 'pub/cat',
  { operation: 'call', args: { note: 'hello' } },
  connectionName, undefined, undefined, undefined,
);

describe('D-232 — the gateway routes local vs remote', () => {
  it('✅ NO connection ⇒ in-process, and the invoker gets the binding\'s recipe', () => {
    const { ctx, invoked, remote } = harness({ reachable: true });
    return call(ctx, mcpManifest(), '').then((result) => {
      expect(invoked, 'the local branch was never reached').toHaveLength(1);
      expect(invoked[0]!.recipe_id).toBe('target-recipe');
      expect(invoked[0]!.args).toMatchObject({ note: 'hello' });
      expect(remote, 'it went out over the wire anyway').toEqual([]);
      expect(result).toMatchObject({ via: 'local' });
    });
  });

  it('✅ a connection ⇒ REMOTE — the local branch must not capture peer traffic', () => {
    // The regression that would matter most: if the predicate ignored the
    // connection, every peer call in the repo would silently start executing
    // locally against a recipe of the same name.
    const { ctx, invoked, remote } = harness();
    return call(ctx, mcpManifest(), 'peer-alice').then(() => {
      expect(invoked, 'a peer call was executed locally').toEqual([]);
      expect(remote).toHaveLength(1);
      expect(remote[0]!.input).toMatchObject({ connection_kind: 'mcp', connection: 'peer-alice' });
    });
  });

  it('⛔ a connectionless REST op is still an error, not a local call', () => {
    // Only `mcp` bindings name a tool, and only a tool name can be a recipe. A
    // rest op with no connection is a misconfiguration and must keep failing —
    // widening the predicate to "no connection" alone would turn every one of
    // those into a silent local dispatch.
    // ⚠ Asserted as a REFUSAL, not as `invoked === []` in both arms — that
    // shape passes whether the call succeeds or fails and cannot tell "routed
    // remote correctly" from "routed local and the stub returned nothing".
    const { ctx, invoked } = harness({ reachable: true });
    return call(ctx, restManifest(), '').then(
      () => { throw new Error('a connectionless rest op was admitted'); },
      (e: Error) => {
        expect(e.message).toContain('no_connection_profile');
        expect(invoked).toEqual([]);
      },
    );
  });

  it('⛔ ABSENT reachability DENIES — Invariant 3, operations default OFF', () => {
    // The claim the synthesis comment makes. Without this, a host that never
    // opted in would acquire recipe-to-recipe dispatch by upgrading, and the
    // only evidence would be that it started working.
    const { ctx, invoked } = harness({ reachable: false });
    return call(ctx, mcpManifest(), '').then(
      () => { throw new Error('an unreachable local recipe was dispatched'); },
      (e: Error) => {
        expect(e.message).toMatch(/denied|not_granted|no_connection_profile/);
        expect(invoked).toEqual([]);
      },
    );
  });

  it('⛔ fails CLOSED with no invoker — never silently remote', () => {
    const { ctx, remote } = harness({ omitInvoker: true, reachable: true });
    return call(ctx, mcpManifest(), '').then(
      () => { throw new Error('expected a refusal'); },
      (e: Error) => {
        expect(e.message).toContain('localRecipeInvoker');
        expect(remote, 'it fell through to the wire').toEqual([]);
      },
    );
  });

  it('⛔⛔ REFUSES A CYCLE at the gateway, and does not dispatch', () => {
    // The guard's real call site. `target-recipe` is already on the stack, so
    // this is A → B → A arriving through the actual routing path.
    const { ctx, invoked, remote } = harness({
      reachable: true,
      held: new Set(['caller', 'target-recipe']),
    });
    return call(ctx, mcpManifest(), '').then(
      () => { throw new Error('the cycle was dispatched'); },
      (e: unknown) => {
        expect(e).toBeInstanceOf(RecipeCycleError);
        expect((e as RecipeCycleError).target_recipe_id).toBe('target-recipe');
        expect(invoked, 'it ran the recipe before refusing').toEqual([]);
        expect(remote).toEqual([]);
      },
    );
  });

  it('⛔⛔ a nested run that PAUSED is refused, never returned as a step value', () => {
    // The bug the owner spotted: the gateway is per op-step and single-valued,
    // but a recipe's outcome is three-valued. `executeRecipe` RETURNS on a hold
    // rather than throwing, so the paused shape below would become this step's
    // value, the caller would run on, and — both `errors` arrays being empty —
    // it would report SUCCESS for work that never happened.
    const paused = {
      success: false,
      errors: [],
      output: {},
      awaiting_approval: { gated_step_id: 'send', step_state: {} },
    };
    const { ctx } = harness({ reachable: true, invoker: async () => paused });
    return call(ctx, mcpManifest(), '').then(
      () => { throw new Error('a paused nested run was returned as a result'); },
      (e: unknown) => {
        expect(e).toBeInstanceOf(NestedRunNotCompletedError);
        expect((e as NestedRunNotCompletedError).gated_step_id).toBe('send');
      },
    );
  });

  it('⛔ `success:false` with NO errors is the same hazard, also refused', () => {
    const { ctx } = harness({
      reachable: true,
      invoker: async () => ({ success: false, errors: [], output: {} }),
    });
    return call(ctx, mcpManifest(), '').then(
      () => { throw new Error('a silent failure was returned as a result'); },
      (e: unknown) => { expect(e).toBeInstanceOf(NestedRunNotCompletedError); },
    );
  });

  it('⛔ hands the invoker the WIDENED stack, or the guard covers one hop only', () => {
    // If the target is not added to the set passed down, the nested run starts
    // with the parent's stack and A → B → A is admitted at the second hop. The
    // guard would then protect exactly the depth-1 case and nothing else, while
    // every test above still passed.
    const { ctx, invoked } = harness({ reachable: true, held: new Set(['caller']) });
    return call(ctx, mcpManifest(), '').then(() => {
      expect(invoked).toHaveLength(1);
      expect([...invoked[0]!.held_recipes].sort()).toEqual(['caller', 'target-recipe']);
    });
  });
});
