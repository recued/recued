/** ⛔⛔ `handleExecute` RUNS STRICT, AND A RAW-ENGINE DRIVE WILL TELL YOU IT DOES NOT.
 *
 *  `handleExecute` accepts an inline `request.recipe` — a full body — behind only
 *  a shape check. Several rules live ONLY in the recipe validator:
 *  `vault_ref_in_recipe` (`{{vault.*}}` is ingredient-only) and the `read_memory`
 *  / `read_audit` staged-trust disclosures. It looks, from the handler, as though
 *  none of them run on that path.
 *
 *  They do. The composition root sets `strict: true`
 *  (`execute-handler.ts:5386`), and `executeRecipe` short-circuits on any
 *  error-severity finding before touching the ingredient executor
 *  (`packages/engine/src/execute.ts:246`, `if (ctx.strict)`). Every caller —
 *  owner, delegated mcp token, reception door — gets `RECIPE_VALIDATION_FAILED`.
 *
 *  ⛔⛔ THE TRAP, WHICH COST A WHOLE INVESTIGATION. Driving `executeRecipe`
 *  DIRECTLY resolves the vault ref and puts the secret in `stores.step`, because
 *  a hand-built `ExecutionContext` does not set `strict`. That drive is what a
 *  `packages/engine` test harness naturally produces, it looks like proof, and it
 *  is measuring a configuration no caller uses. A finding was written and had to
 *  be withdrawn on exactly this.
 *
 *  🔑 SO THIS FILE ASSERTS THROUGH `handleExecute`, NOT `executeRecipe` — the
 *  composition root is the only level at which the question has an answer. The
 *  same lesson the tree already records for hand-wired harnesses generally.
 *
 *  ⚠ A raw-engine caller inside the server is still unvalidated by construction.
 *  That is in-process code, not a reachable surface, and `strict` is the seam
 *  that keeps it that way — which is what makes it worth pinning here. */

import { describe, it, expect } from 'vitest';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import { STDIO_MCP_TOKEN_ID, type ExecutionSource, type RecipeDefinition } from '@recued/contracts';

/** A transform reading the vault. It DISPATCHES NOTHING, so the D-165 policy
 *  overlay — whose guarantee is stated per dispatch — never sees it. The
 *  validator is the only rule that applies, which is the point. */
const vaultReadingRecipe = (): RecipeDefinition => ({
  recipe_id: 'inline-vault-probe',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'Inline vault probe',
    description: 'A transform reading the vault — a step no dispatch gate sees.',
    author: 'test',
    supported_platforms: ['test'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [{ id: 'leak', transform: 'default', value: '{{vault.api_key}}', fallback: 'none' }],
  output: { sidebar: [] },
} as unknown as RecipeDefinition);

const cleanRecipe = (): RecipeDefinition => ({
  ...vaultReadingRecipe(),
  recipe_id: 'inline-clean-probe',
  steps: [{ id: 'ok', transform: 'default', value: 'literal', fallback: 'none' }],
} as unknown as RecipeDefinition);

const SOURCES: ReadonlyArray<readonly [string, ExecutionSource | undefined]> = [
  ['owner over rpc', { channel: 'user', actor: 'user_self', user_id: 'local', client_token_id: 'c1' } as ExecutionSource],
  ["owner's own stdio mcp", { channel: 'mcp', actor: 'contracted_user', mcp_token_id: STDIO_MCP_TOKEN_ID } as unknown as ExecutionSource],
  ['a DELEGATED mcp token', { channel: 'mcp', actor: 'contracted_user', mcp_token_id: 'door_bearer_abc' } as unknown as ExecutionSource],
  ['no execution_source', undefined],
];

const deps = (): ExecuteHandlerDeps => ({
  recipeStore: createRecipeStore('/nonexistent'),
  executorConfig: { manifests: createManifestRegistry('/nonexistent') },
  baseVault: { api_key: 'sk-SECRET-VALUE' },
} as unknown as ExecuteHandlerDeps);

const runInline = (recipe: RecipeDefinition, execution_source?: ExecutionSource) =>
  handleExecute(deps(), { recipe, ...(execution_source ? { execution_source } : {}) } as never);

describe('an inline recipe is validated for every caller', () => {
  for (const [label, source] of SOURCES) {
    it(`refuses a vault-reading inline recipe — ${label}`, async () => {
      const result = await runInline(vaultReadingRecipe(), source);
      expect(result.success).toBe(false);
      // `handleExecute` is called with `as never` above (the request carries an
      // inline body), so the result's error shape is not inferred here. Narrowed
      // to the two fields asserted, which the runtime output confirms.
      const first = result.errors[0] as { code?: string; message?: string } | undefined;
      expect(first?.code).toBe('RECIPE_VALIDATION_FAILED');
      expect(first?.message).toContain('vault_ref_in_recipe');
      // ⛔ AND THE SECRET NEVER REACHED A STEP. Refusing before the executor is
      //   the property; an error code with the value already computed would not
      //   be one.
      expect(JSON.stringify(result)).not.toContain('sk-SECRET-VALUE');
      expect(result.steps).toEqual([]);
    });
  }

  it('a contract-bearing source with no snapshot is refused EARLIER still', async () => {
    // 🔑 A DIFFERENT AND STRONGER GATE, worth separating rather than folding in.
    //   A reception door carries a `contract_id`, and D-153 P2.C requires a
    //   matching `contract_snapshot` on every contract-scoped commit — so the
    //   run is refused before validation is even reached. Folding this into the
    //   loop above would have hidden which gate was doing the work.
    await expect(runInline(
      vaultReadingRecipe(),
      { channel: 'reception', actor: 'anonymous', contract_id: 'ctr_door_1' } as unknown as ExecutionSource,
    )).rejects.toThrow(/contract/i);
  });

  it('CONTROL: a clean inline recipe still runs', async () => {
    // ⛔ Without this, a handler that refused every inline recipe would satisfy
    //   all five assertions above.
    const result = await runInline(cleanRecipe(), SOURCES[2]![1]);
    expect(result.success).toBe(true);
  });

  it('MUTATION: the refusal comes from `strict`, not from the recipe shape', async () => {
    // ⚠ Pins WHY the assertions above hold. `executeRecipe` validates only under
    //   `ctx.strict` (`packages/engine/src/execute.ts:246`); the same recipe
    //   driven without it resolves the vault ref. That drive is what a
    //   packages/engine harness produces by default, and it is what made this
    //   look like an exposure.
    const { executeRecipe } = await import('@recued/engine');
    const stores = {
      vault: { api_key: 'sk-SECRET-VALUE' }, config: {}, context: {}, meta: {}, step: {},
    };
    await executeRecipe({
      recipe: vaultReadingRecipe(),
      stores,
      ingredientExecutor: () => Promise.resolve(null),
    } as never);
    // Not strict → no validation → the ref resolved. This is the configuration
    // NO caller uses, asserted so the contrast is on the record.
    expect((stores as { step: Record<string, unknown> }).step.leak).toBe('sk-SECRET-VALUE');
  });
});
