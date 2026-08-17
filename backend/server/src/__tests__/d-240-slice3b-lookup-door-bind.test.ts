/** D-240 slice 3b — binding a read-only LOOKUP recipe to an endpoint.
 *
 *  The claim under test is a REUSE claim: `bindReceptionLookupDoor` is a thin
 *  composition over `bindReceptionDoor`, so every rule that makes a reception
 *  door safe applies to the viewback door without anyone re-deriving it. A test
 *  that only checked "a row was written" would prove the composition compiles,
 *  not that it inherited anything. */

import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import type { ContractDefinition, RecipeDefinition } from '@recued/contracts';

import {
  bindReceptionLookupDoor,
  resolveReceptionLookupDoorContractId,
  unbindReceptionLookupDoor,
} from '../reception-lookup-door-bind.js';
import {
  createReceptionLookupRecipePairStore,
  type ReceptionLookupRecipePairStore,
} from '../storage/reception-lookup-recipe-pair-store.js';
import type { ContractDefinitionStore } from '../storage/contract-definition-store.js';
import type { ContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';

const NOW = () => 1_000;
const EP = 'ep-lookup-1';

/** A recipe that RENDERS — which every lookup recipe does, since rendering the
 *  visitor's page is its entire job. */
const renderingRecipe = (steps: Record<string, unknown>[]): RecipeDefinition =>
  ({
    prefetch_steps: [],
    steps,
    output: { render: [{ type: 'text', source: 'step.status' }] },
  }) as unknown as RecipeDefinition;

const harness = (opts: { readonly opRisk?: Record<string, string> } = {}) => {
  const defs = new Map<string, ContractDefinition>();
  const grants: string[] = [];
  let n = 0;
  const definitionStore = {
    mint: (i: Record<string, unknown>) => {
      const d = {
        contract_id: `c${++n}`, status: 'active', minted_at: NOW(), ...i,
      } as unknown as ContractDefinition;
      defs.set(d.contract_id, d);
      return d;
    },
    get: (id: string) => defs.get(id) ?? null,
    revoke: (id: string) => {
      const d = defs.get(id);
      if (!d) return null;
      const r = { ...d, revoked_at: NOW() } as ContractDefinition;
      defs.set(id, r);
      return r;
    },
  } as unknown as ContractDefinitionStore;
  const grantEntryStore = {
    set: (_c: string, k: string) => { grants.push(k); },
  } as unknown as ContractGrantEntryStore;

  // ⚠ The REAL store on an in-memory database, not a fake. The rollback
  // behaviour below is a property of what the table actually does with an
  // upsert, and a Map would agree with any implementation.
  const lookupPairStore: ReceptionLookupRecipePairStore =
    createReceptionLookupRecipePairStore(new Database(':memory:'));

  const recipes = new Map<string, RecipeDefinition>();
  return {
    definitionStore,
    grantEntryStore,
    lookupPairStore,
    defs,
    grants,
    recipes,
    now: NOW,
    resolveConfig: () => ({}),
    resolveRecipe: (id: string) => recipes.get(id) ?? null,
    hashRecipe: (r: RecipeDefinition) => `h:${JSON.stringify(r).length}`,
    resolveIngredientKind: () => 'http',
    resolveOpKinds: () => new Map<string, string>(),
    ...(opts.opRisk === undefined
      ? {}
      : { resolveOpRisk: (op: string) => opts.opRisk![op] }),
  };
};

const bind = (
  h: ReturnType<typeof harness>,
  steps: Record<string, unknown>[],
  over: { readonly recipeId?: string; readonly confirmed?: boolean } = {},
) => {
  const recipeId = over.recipeId ?? 'lookup-recipe';
  h.recipes.set(recipeId, renderingRecipe(steps));
  return bindReceptionLookupDoor(
    {
      endpointId: EP,
      recipeId,
      mintedBy: 'owner',
      ...(over.confirmed === undefined ? {} : { confirmed: over.confirmed }),
    },
    h,
  );
};

describe('D-240 § D12 — the lookup door inherits the reception door rules', () => {
  it('⛔⛔ §3c FIRES FOR FREE: a lookup recipe that WRITES is refused', () => {
    // THE REUSE CLAIM, and the reason it is not decorative. `respondsWith`
    // returns `renders` whenever the recipe produces `output.render` — which a
    // lookup recipe does by definition — so every viewback door is a RESPONDING
    // door, and a responding door that writes either holds (returning no output,
    // so the visitor gets a blank page) or fires a side effect for a stranger
    // refreshing a status page. A bespoke bind is exactly where this would have
    // been forgotten.
    const h = harness({ opRisk: { 'core.work-entity.task.create': 'write' } });
    const out = bind(h, [
      { id: 'status', op: 'core.work-entity.task.get' },
      { id: 'save', op: 'core.work-entity.task.create' },
    ]);

    expect(out.kind).toBe('refused');
    if (out.kind !== 'refused') throw new Error('unreachable');
    expect(out.refusal).toMatchObject({
      reason: 'write_on_responding_door',
      op: 'core.work-entity.task.create',
      responds: 'renders',
    });
  });

  it('⚠ and a READ-ONLY lookup recipe binds — the fence is targeted', () => {
    // The permitting case: without it the refusal above would pass on a bind
    // that refused every recipe, which is a viewback feature that never works.
    const h = harness({ opRisk: { 'core.work-entity.task.get': 'read' } });
    const out = bind(h, [{ id: 'status', op: 'core.work-entity.task.get' }], { confirmed: true });

    expect(out.kind).toBe('bound');
    if (out.kind !== 'bound') throw new Error('unreachable');
    expect(out.contract_id).toBe('c1');
    expect(resolveReceptionLookupDoorContractId(EP, h)).toBe('c1');
  });

  it('⛔ §5.1f FIRES FOR FREE TOO: a first bind ASKS before granting the public anything', () => {
    // Widening asks; narrowing is silent. A fresh door widens from nothing, so
    // the owner is shown what the public would be able to do — and NOTHING is
    // written until they confirm. Inherited from `bindReceptionDoor` with no
    // consent code in the lookup path at all.
    const h = harness({ opRisk: { 'core.work-entity.task.get': 'read' } });
    const asked = bind(h, [{ id: 'status', op: 'core.work-entity.task.get' }]);

    expect(asked.kind).toBe('needs_consent');
    if (asked.kind !== 'needs_consent') throw new Error('unreachable');
    expect(asked.added.length).toBeGreaterThan(0);
    // ⛔ And the row is GONE — an unconfirmed bind must leave no trace.
    expect(h.lookupPairStore.findByEndpoint(EP)).toBeNull();
  });

  it('⛔ an op whose risk cannot be resolved AT ALL is refused, not admitted', () => {
    // `!== 'read'` catches `undefined` too — a fence that admits what it cannot
    // classify is decoration.
    const h = harness();
    const out = bind(h, [{ id: 'mystery', op: 'vendor.unknown.thing' }]);
    expect(out.kind).toBe('refused');
  });
});

describe('D-240 § D12 — a refusal leaves NOTHING behind', () => {
  it('⛔⛔ a refused bind on a fresh endpoint stores no row', () => {
    // A bound recipe with a null contract is NOT inert — it is a pair the runner
    // would find, and the only thing stopping it would be the anonymous
    // `PUBLIC_CONTRACT_ID` floor. Leaning on the fail-closed floor to do the work
    // of an explicit refusal is the D-207 slice 1b "revoke that doesn't revoke"
    // hazard.
    const h = harness({ opRisk: { 'core.work-entity.task.create': 'write' } });
    expect(bind(h, [{ id: 'save', op: 'core.work-entity.task.create' }]).kind).toBe('refused');
    expect(h.lookupPairStore.findByEndpoint(EP)).toBeNull();
  });

  it('⛔⛔ a refused RE-bind restores the recipe that was already working', () => {
    // The harder half: rolling back by DELETING would silently unbind a door
    // that was live, so a typo in a re-bind would take the feature down.
    const h = harness({
      opRisk: { 'core.work-entity.task.get': 'read', 'core.work-entity.task.create': 'write' },
    });
    expect(bind(h, [{ id: 'status', op: 'core.work-entity.task.get' }], { confirmed: true }).kind)
      .toBe('bound');

    const before = h.lookupPairStore.findByEndpoint(EP);
    expect(bind(h, [{ id: 'save', op: 'core.work-entity.task.create' }], {
      recipeId: 'bad-recipe',
    }).kind).toBe('refused');

    const after = h.lookupPairStore.findByEndpoint(EP);
    expect(after?.recipe_id).toBe(before?.recipe_id);
    expect(after?.recipe_hash).toBe(before?.recipe_hash);
    expect(after?.contract_id).toBe(before?.contract_id);
  });

  it('a missing recipe is `recipe_not_found`, distinct from a refusal', () => {
    // Different repairs: one is "pick a different recipe", the other is "fix
    // this one". Nothing about the recipe was judged, because there was none.
    const h = harness();
    const out = bindReceptionLookupDoor(
      { endpointId: EP, recipeId: 'nope', mintedBy: 'owner' },
      h,
    );
    expect(out.kind).toBe('recipe_not_found');
    expect(h.lookupPairStore.findByEndpoint(EP)).toBeNull();
  });
});

describe('D-240 § D12 — unbind shuts the door', () => {
  it('revokes the contract AND drops the row', () => {
    const h = harness({ opRisk: { 'core.work-entity.task.get': 'read' } });
    const bound = bind(h, [{ id: 'status', op: 'core.work-entity.task.get' }], { confirmed: true });
    if (bound.kind !== 'bound') throw new Error('unreachable');

    unbindReceptionLookupDoor(EP, h);

    expect(h.defs.get(bound.contract_id)).toMatchObject({ revoked_at: NOW() });
    expect(h.lookupPairStore.findByEndpoint(EP)).toBeNull();
    expect(resolveReceptionLookupDoorContractId(EP, h)).toBeNull();
  });
});

describe('D-240 — the lookup pair store', () => {
  const store = () => createReceptionLookupRecipePairStore(new Database(':memory:'));

  it('⛔⛔ an upsert PRESERVES `contract_id` — the bind needs it to RETIRE the old door', () => {
    // ⚠ I wrote this test the other way round first, asserting the upsert
    // cleared it, on a comment I had written and not checked. Clearing it would
    // make every re-bind look like a FIRST bind: the consent diff would have
    // nothing to compare against so it would always ask, and
    // `bindReceptionDoor`'s retire step is gated on an existing contract — so
    // the previous door would never be revoked. A live contract granting the
    // public authority, with no row pointing at it.
    const s = store();
    s.upsert({ endpoint_id: EP, recipe_id: 'r1', recipe_hash: 'h1', now: 1 });
    s.setContractId({ endpoint_id: EP, contract_id: 'c-old' });

    s.upsert({ endpoint_id: EP, recipe_id: 'r2', recipe_hash: 'h2', now: 2 });
    expect(s.findByEndpoint(EP)).toMatchObject({
      recipe_id: 'r2', recipe_hash: 'h2', contract_id: 'c-old',
    });
  });

  it('⚠ and the BIND is what replaces it — the old contract is revoked, not orphaned', () => {
    // The other half of the invariant above, driven through the real bind: the
    // preserved id is what the retire step consumes.
    const h = harness({
      opRisk: { 'core.work-entity.task.get': 'read', 'core.work-entity.note.get': 'read' },
    });
    const first = bind(h, [{ id: 'a', op: 'core.work-entity.task.get' }], { confirmed: true });
    if (first.kind !== 'bound') throw new Error('unreachable');

    // ⚠ A DIFFERENT op, not a second step on the same one. My first attempt
    // re-bound a recipe whose closure was identical and asserted a new contract
    // — the bind correctly returned `unchanged` with the SAME id, because
    // nothing about the door's AUTHORITY had moved. That early return is the
    // case that keeps the consent surface trustworthy, and a re-mint test has to
    // actually change the closure to reach the retire path.
    const second = bind(
      h,
      [{ id: 'a', op: 'core.work-entity.task.get' }, { id: 'b', op: 'core.work-entity.note.get' }],
      { recipeId: 'lookup-recipe-2', confirmed: true },
    );
    if (second.kind !== 'bound') throw new Error('unreachable');

    expect(second.contract_id).not.toBe(first.contract_id);
    expect(h.defs.get(first.contract_id)).toMatchObject({ revoked_at: NOW() });
  });

  it('⚠ linking a contract does NOT move `updated_at`', () => {
    // Inherited from `reception-intake-recipe-pair-store`, which records the
    // incident: it is the BINDING's concurrency token, and moving it on a
    // contract link made the bind rpc conflict with ITSELF — the door minted and
    // the owner told it failed.
    const s = store();
    const created = s.upsert({ endpoint_id: EP, recipe_id: 'r1', recipe_hash: 'h1', now: 7 });
    s.setContractId({ endpoint_id: EP, contract_id: 'c1' });
    expect(s.findByEndpoint(EP)?.updated_at).toBe(created.updated_at);
  });

  it('clear reports whether anything was there', () => {
    const s = store();
    expect(s.clear(EP)).toBe(false);
    s.upsert({ endpoint_id: EP, recipe_id: 'r1', recipe_hash: 'h1', now: 1 });
    expect(s.clear(EP)).toBe(true);
    expect(s.findByEndpoint(EP)).toBeNull();
  });

  it('refuses blank ids rather than storing them', () => {
    const s = store();
    expect(() => s.upsert({ endpoint_id: '  ', recipe_id: 'r', recipe_hash: 'h', now: 1 }))
      .toThrow(/endpoint_id must be non-empty/);
    expect(() => s.upsert({ endpoint_id: EP, recipe_id: '', recipe_hash: 'h', now: 1 }))
      .toThrow(/recipe_id must be non-empty/);
  });
});

describe('D-240 § D12 — the runner is REACHABLE from production composition', () => {
  it('⛔⛔ `wire-reception-substrate` CONSTRUCTS the runner and hands it to the port', () => {
    // THE FINDING THIS GUARDS. Slice 3b built the pair store, the bind and the
    // runner; slice 3b's second commit taught the HANDLER to call an optional
    // `runLookupRecipe`. Nothing ever constructed it, so
    // `createReceptionLookupRecipeRunner` existed only at its own declaration and
    // every viewback silently rendered the substrate status — typechecked,
    // tested, unreachable.
    //
    // ⚠ The route suite could not see it: it injects a synthetic callback, so it
    // proved the handler's BRANCH and never the WIRING. Two stubs from opposite
    // sides of one boundary, and the join never ran.
    //
    // ⇒ A source-level assertion, because the composition passes the seam
    // through a conditional SPREAD that TypeScript cannot check.
    const composer = readFileSync(
      new URL('../composition/bin/wire-reception-substrate.ts', import.meta.url),
      'utf8',
    );
    expect(composer).toContain('createReceptionLookupRecipeRunner');
    expect(composer).toContain('createReceptionLookupRecipePairStore');
    // and the seam actually reaches the port deps
    expect(composer).toMatch(/runReceptionLookupRecipe\s*\?\s*\{\s*runReceptionLookupRecipe\s*\}/);
  });

  it('⚠ and the port READS the key the composer writes — one name, two sides', () => {
    // A renamed key on either side is silent: the port's dep is optional and the
    // composer's spread is conditional, so neither end fails to compile.
    const port = readFileSync(
      new URL('../ports/reception/handler.ts', import.meta.url),
      'utf8',
    );
    expect(port).toContain('deps.runReceptionLookupRecipe');
  });
});
