/** D-247 slice 3 — THE DRIVE TEST, and the only one that proves the change.
 *
 *  ⛔⛔ THE UNIT TESTS BESIDE THIS FILE PROVE THE PREDICATE IS CORRECT AND
 *  NOTHING ABOUT WHETHER THE GATE CALLS IT. D-247 exists partly because
 *  `buildRecipeOpDependencyIndex` was written, tested, and called by nothing;
 *  a coverage predicate with no consumer would be the same artefact. This runs
 *  the real `handleExecute` with a real revoked op, so removing
 *  `&& !coveredByRecipeGrant` from the per-call gate turns it red.
 *
 *  It also pins the KERNEL SIMPLE-FORM path specifically. `deriveRecipeCapability`
 *  records an ingredient step's canonical op only when an `OpResolver` maps it,
 *  so a bare kernel step contributes its SLUG and no op id — while the gate
 *  derives `core.data.form-response.get` from that same slug. If the coverage
 *  union that closes this gap is removed, the recipe half-runs: exactly the
 *  failure D-247 exists to remove, reintroduced by the mechanism meant to bound
 *  it. A catalog-op test would not notice. */

import { createInMemoryStore } from '@recued/cache';
import type {
  Commit, ExecutionSource, FormResponse, IngredientManifest, RecipeDefinition,
} from '@recued/contracts';
import { createCommitStore, createInMemoryCollection } from '@recued/storage';
import { describe, expect, it, vi } from 'vitest';

import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import { createManifestRegistry } from '../manifest-loader.js';
import type { OpAdmissionGate } from '../op-admission-gate.js';
import { createRecipeStore } from '../recipe-store.js';

const SLUG = 'form-response-get';
const OP_ID = 'core.data.form-response.get';
const RECIPE_ID = 'd247-coverage-drive';
const PUBLISHER = 'test';                       // resolved from `metadata.author`
const GRANT_KEY = `recipe.${PUBLISHER}/${RECIPE_ID}`;

/** The OWNER's chat source — no `contract_id`, therefore no snapshot, therefore
 *  the arm D-247 adds is the only one that can answer. */
const OWNER: ExecutionSource = {
  channel: 'chat', actor: 'user_self', chat_session_id: 's1', user_id: 'owner',
};

const RESPONSE: FormResponse = {
  _id: 'sub-1', _collection: 'form_response', submission_id: 'sub-1',
  endpoint_id: 'ep-1', form_definition_id: 'def-1',
  definition_snapshot: { fields: [{ name: 'brief' }] },
  values: { brief: 'answer' }, visitor: { email: 'v@example.com' },
  submitted_at: 1_000, accepted_at: 2_000, updated_at: 2_000,
  origin_actor: 'anonymous', origin_surface: 'system',
  lifecycle_state: 'received', state_changed_at: 0, metadata: {},
};

const MANIFEST: IngredientManifest = {
  slug: SLUG, name: 'Fetch form response', description: 'D-247 coverage drive.',
  author: 'recued', kind: 'storage', category: 'data', risk_tier: 'read', version: 1,
  input: { submission_id: null }, output: { record: 'record' },
};

const RECIPE: RecipeDefinition = {
  recipe_id: RECIPE_ID, version: 1, ttl: 300,
  metadata: {
    name: 'D-247 coverage drive', description: 'A granted recipe over a revoked op.',
    author: PUBLISHER, supported_platforms: ['test'], tags: ['test'],
  },
  variables: {}, prefetch_steps: [],
  // A BARE kernel step: no `operation`, so the closure sees only the slug.
  steps: [{ id: 'response', ingredient: SLUG, input: { submission_id: 'sub-1' } }],
  output: { sidebar: [] },
};

const harness = (recipeGranted: boolean) => {
  const manifests = createManifestRegistry('/nonexistent');
  manifests.register(MANIFEST);
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(RECIPE);
  const formResponseGet = vi.fn(async () => ({ record: RESPONSE }));
  // ⛔ THE OP IS REVOKED. Every direct call to it must stay refused.
  const isOpGranted = vi.fn((_s: ExecutionSource, opId: string | undefined) => opId !== OP_ID);
  const isOwnerRecipeGranted = vi.fn(
    (_s: ExecutionSource, key: string | undefined) => recipeGranted && key === GRANT_KEY,
  );
  const opAdmissionGate: OpAdmissionGate = {
    isFrozenByPause: () => false, isOpGranted, isOwnerRecipeGranted,
    // The OWNER's chat drives this suite — that is the whole point of it.
    isOwnerGoverned: () => true,
  };
  const activities: Array<{ action: string; target: string; detail?: string }> = [];
  const auditLog = {
    logActivity: async (a: { action: string; target: string; detail?: string }) => {
      activities.push(a);
    },
  } as unknown as ExecuteHandlerDeps['auditLog'];
  const deps: ExecuteHandlerDeps = {
    auditLog,
    recipeStore,
    executorConfig: {
      manifests, cacheStore: createInMemoryStore(), instanceId: 'pair-1',
      kernelDispatchers: { formResponseGet },
    },
    baseVault: {}, instanceId: 'pair-1',
    commitStore: createCommitStore(createInMemoryCollection<Commit>()),
    opAdmissionGate,
  };
  return { deps, formResponseGet, isOpGranted, isOwnerRecipeGranted, activities };
};

const run = (deps: ExecuteHandlerDeps) =>
  handleExecute(deps, {
    recipe_id: RECIPE_ID, trigger_source: 'chat', execution_source: OWNER,
  });

describe('D-247 — a granted recipe runs its revoked op; an ungranted one does not', () => {
  it('WITHOUT the recipe grant the step is refused (today’s behaviour, unchanged)', async () => {
    const h = harness(false);
    const result = await run(h.deps);
    expect(result.success).toBe(false);
    // Assert the REASON, not the verdict: a failure for any other cause would
    // satisfy `success === false` while proving nothing about the access axis.
    expect(JSON.stringify(result.errors)).toContain('not granted');
    expect(h.formResponseGet).not.toHaveBeenCalled();
  });

  it('WITH the recipe grant the SAME revoked op runs — the per-call gate reads coverage', async () => {
    // ⛔ THIS IS THE MUTATION TARGET. Remove `&& !coveredByRecipeGrant` from the
    // op-admission gate and this goes red while every unit test stays green.
    const h = harness(true);
    const result = await run(h.deps);
    expect(result.success).toBe(true);
    expect(h.formResponseGet).toHaveBeenCalledTimes(1);
  });

  it('coverage does NOT turn the op grant on — the revoke still answers "no"', async () => {
    // D3: ON widens, OFF retracts nothing. Nothing may write a grant row here,
    // and the direct-call axis must remain exactly as revoked as it was.
    const h = harness(true);
    await run(h.deps);
    expect(h.isOpGranted).toHaveBeenCalled();
    expect(h.isOpGranted.mock.results.some((r) => r.value === false)).toBe(true);
  });

  it('asks the OWNER arm with the key formed from metadata.author', async () => {
    // Pins the seed/predicate shared address: a key formed two ways is a grant
    // that writes to one address and reads from another.
    const h = harness(true);
    await run(h.deps);
    expect(h.isOwnerRecipeGranted).toHaveBeenCalledWith(OWNER, GRANT_KEY);
  });
});

describe('D-247 D13 — the coverage ledger', () => {
  it('writes ONE row naming the op and the covering recipe', async () => {
    // ⛔ Emitted at the ADMISSION POINT, which is the only place both step kinds
    // pass through. This step is a BARE KERNEL ingredient — it never reaches
    // `runCatalogOperation`, so a ledger built on the `connection_gateway` row
    // would record nothing here and the owner's "why did this fire" question
    // would have no answer for half of every covered run.
    const h = harness(true);
    await run(h.deps);
    const rows = h.activities.filter((a) => a.action === 'recipe_coverage_admission');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.target).toBe(OP_ID);
    expect(JSON.parse(rows[0]!.detail!)).toMatchObject({
      granting_recipe: GRANT_KEY,
      recipe_id: RECIPE_ID,
    });
  });

  it('writes NOTHING when the op holds its own grant', async () => {
    // "Show me every op that ran ONLY because a recipe covered it" — an op with
    // its own grant is not an answer to that question, and writing it would make
    // the aggregate lie in the direction that reads as more usage.
    const h = harness(true);
    h.isOpGranted.mockImplementation(() => true);
    await run(h.deps);
    expect(h.activities.filter((a) => a.action === 'recipe_coverage_admission')).toHaveLength(0);
  });

  it('writes NOTHING when the run holds no recipe grant', async () => {
    const h = harness(false);
    await run(h.deps);
    expect(h.activities.filter((a) => a.action === 'recipe_coverage_admission')).toHaveLength(0);
  });
});

/** ⛔⛔ CODEX REVIEW FINDING 1 — the exchange carrier.
 *
 *  `recued/run-ingredient` dispatches `ingredient: '{{config.ingredient_slug}}'`,
 *  which `deriveRecipeCapability` refuses as `dynamic_dispatch`, so its closure is
 *  EMPTY. Deriving coverage from the carrier's own body therefore answers "no" for
 *  every op — and a granted recipe's exchange delivery would be refused at the
 *  per-call gate the moment its op was directly revoked, while the static walk
 *  (which uses `coversStepsOverride`) still said yes. Three layers, two answers. */
describe('D-247 — INHERITED coverage is not re-derived from the carrier body', () => {
  /** ⛔ THE RECIPE MUST HAVE AN UNDERIVABLE CLOSURE, or this test is VACUOUS —
   *  the first version used the ordinary fixture, whose closure derives fine, so
   *  it passed with the inherited branch mutated out. `{{config.*}}` in the
   *  `ingredient` field is what makes `deriveRecipeCapability` refuse
   *  (`dynamic_dispatch`), which is exactly the real carrier's shape. */
  const CARRIER_ID = 'd247-carrier-drive';
  const CARRIER: RecipeDefinition = {
    ...RECIPE,
    recipe_id: CARRIER_ID,
    variables: { ingredient_slug: null } as never,
    steps: [{
      id: 'call',
      ingredient: '{{config.ingredient_slug}}',
      input: { submission_id: 'sub-1' },
    } as never],
  };

  it('admits a revoked op on a host-inherited grant, with NO derivable closure', async () => {
    const h = harness(false);            // no OWNER grant — the host supplies it
    h.deps.recipeStore.register(CARRIER);
    const result = await handleExecute(h.deps, {
      recipe_id: CARRIER_ID,
      trigger_source: 'chat',
      execution_source: OWNER,
      config: { ingredient_slug: SLUG },
    }, {
      // The inheritance arm: only the host sets this, and only from a coverage it
      // already resolved for the PARENT run.
      granted_by_recipe: 'recued-core/some-granted-parent',
    } as never);
    expect(result.success).toBe(true);
    expect(h.formResponseGet).toHaveBeenCalledTimes(1);
    // …and the owner arm was never consulted: the grant did not come from there.
    expect(h.isOwnerRecipeGranted).not.toHaveBeenCalled();
  });

  it('the same carrier WITHOUT the inherited grant is refused', async () => {
    // Proves the admit above comes from inheritance and not from the templated
    // step slipping past the gate on its own.
    const h = harness(false);
    h.deps.recipeStore.register(CARRIER);
    const result = await handleExecute(h.deps, {
      recipe_id: CARRIER_ID, trigger_source: 'chat', execution_source: OWNER,
      config: { ingredient_slug: SLUG },
    }, {} as never);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.errors)).toContain('not granted');
  });

  it('still refuses when NOTHING granted the run — inheritance is not a bypass', async () => {
    const h = harness(false);
    const result = await handleExecute(h.deps, {
      recipe_id: RECIPE_ID, trigger_source: 'chat', execution_source: OWNER,
    }, {} as never);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.errors)).toContain('not granted');
  });
});
