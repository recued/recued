/**
 * D-167 P4 — engine per-run PII ledger lifecycle + ownership guard.
 *
 * `executeRecipe` mints ONE run-local `PiiLedgerStore` (when the caller hasn't
 * supplied one) and threads it into every `TransformContext` so a `pii-protect`
 * step and a later `pii-restore` step share the same ledger within one run.
 *
 * OWNERSHIP GUARD: executeRecipe disposes ONLY a store it minted itself. A
 * minted store is `dispose()`d when the run resolves — so the real PII it held
 * is dropped, not left reachable — across the no-budget path, the budget-race
 * path (run completes), AND the budget-TIMEOUT path (budget wins while a step is
 * in flight: D-259 waits for cancellation cleanup before finalizing, then
 * disposes at inner-settle). A caller-supplied
 * store is NEVER disposed by the engine — it belongs to the caller, who disposes
 * it once itself. The guard is an ownership boundary only: it does NOT relax the
 * no-cross-run-sharing rule (a supplied store must still be per-run, since output
 * restore resolves against the store's whole alias namespace), it just stops the
 * engine tearing down — or, for a wrongly-shared store, clobbering mid-flight —
 * state it did not create.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeRecipe } from '../execute.js';
import type { ExecutionContext, IngredientExecutor } from '../types.js';
import type { RecipeDefinition } from '@recued/contracts';
import {
  createPiiLedgerStore,
  getFallbackPiiLedgerStore,
  _resetPiiLedgerState,
  type PiiLedgerStore,
} from '@recued/transforms';

// Observe the engine-MINTED store's disposal. executeRecipe mints its own store
// via `createPiiLedgerStore()` (the internal object never escapes the run), so to
// assert "the engine disposed the store it owns" we wrap that factory and count
// dispose() calls on the stores it hands back. Gated by `trackMinted` so the
// supplied-store tests below — which also create stores through this factory for
// their own spies — never touch the minted counter; the rest of @recued/transforms
// is the real implementation (pii-protect / pii-restore still run for real).
const mintHooks = vi.hoisted(() => ({
  trackMinted: false,
  disposeCount: 0,
}));
vi.mock('@recued/transforms', async (importActual) => {
  const actual = await importActual<typeof import('@recued/transforms')>();
  return {
    ...actual,
    createPiiLedgerStore: () => {
      const store = actual.createPiiLedgerStore();
      const realDispose = store.dispose; // closure over the store's maps — no `this`
      store.dispose = () => {
        if (mintHooks.trackMinted) mintHooks.disposeCount += 1;
        realDispose();
      };
      return store;
    },
  };
});

// Reset the minted-store observation hooks before EVERY test (top-level, so it
// is order-proof — no test can inherit `trackMinted` left true by another). Only
// the minted-disposal tests opt in, by setting `trackMinted = true` themselves;
// every other test runs with the wrapper inert.
beforeEach(() => {
  mintHooks.trackMinted = false;
  mintHooks.disposeCount = 0;
});

// The PII-bearing object is fed in via the `context` store (recipe `variables`
// only accept scalar / string[] hints, not arbitrary nested objects).
const RAW = { from: 'alice@acme.com', note: 'call Alice Smith' };

/** A recipe that protects a tagged object then restores it in a later step. */
const piiRecipe = (budget_ms?: number): RecipeDefinition => ({
  recipe_id: 'pii-roundtrip',
  version: 1,
  ttl: 300,
  metadata: {
    name: 'PII round-trip',
    description: 'protect then restore',
    author: 'test',
    supported_platforms: [],
    ...(budget_ms !== undefined ? { budget_ms } : {}),
  },
  variables: {},
  prefetch_steps: [],
  steps: [
    {
      id: 'protect',
      transform: 'pii-protect',
      data: '{{context.raw}}',
      fields: [
        { path: 'from', kind: 'email' },
        { path: 'note', kind: 'content' },
      ],
    },
    {
      id: 'restore',
      transform: 'pii-restore',
      data: '{{step.protect.aliased}}',
      ledger_handle: '{{step.protect.ledger_handle}}',
    },
  ],
  output: { sidebar: [] },
});

const makeCtx = (recipe: RecipeDefinition, piiLedgerStore?: PiiLedgerStore): ExecutionContext => ({
  recipe,
  stores: { vault: {}, config: {}, context: { raw: structuredClone(RAW) }, meta: {}, step: {} },
  ingredientExecutor: async () => null,
  ...(piiLedgerStore ? { piiLedgerStore } : {}),
});

describe('D-167 P4 — engine per-run PII ledger lifecycle', () => {
  it('protect→restore round-trips within one run (engine mints + threads the store)', async () => {
    const ctx = makeCtx(piiRecipe());
    const result = await executeRecipe(ctx);
    expect(result.success).toBe(true);

    const protect = ctx.stores.step.protect as { aliased: Record<string, string>; ledger_handle: string };
    expect(protect.aliased.from).toBe('m1@d1.invalid'); // really aliased mid-run
    expect(typeof protect.ledger_handle).toBe('string');

    const restore = ctx.stores.step.restore as { restored: Record<string, string> };
    expect(restore.restored.from).toBe('alice@acme.com'); // bridged via the SAME run-local ledger
    expect(restore.restored.note).toBe('call Alice Smith');
  });

  it('never reaches the process-singleton fallback on the engine recipe path (the engine always threads a per-run store)', async () => {
    // `getFallbackPiiLedgerStore` is a process singleton that is NOT per-run-scoped
    // — its ledgers persist for the process lifetime — so a recipe reaching it
    // would bleed real PII across runs. The engine always threads a per-run store
    // (executeRecipe → createTransformContext.piiLedgerStore → both step-runner
    // sites), so `resolveStore` in the pii transforms never falls back. Lock that
    // in: after a real protect→restore run, a FRESH fallback must not know any
    // alias the run minted. (If the engine ever dropped the store threading, the
    // transform would fall back and this singleton would capture the run's alias.)
    _resetPiiLedgerState(); // drop any prior singleton + zero storeSeq → deterministic

    const ctx = makeCtx(piiRecipe());
    const result = await executeRecipe(ctx);
    expect(result.success).toBe(true);

    const aliasToken = (ctx.stores.step.protect as { aliased: Record<string, string> }).aliased.from;
    expect(aliasToken).toBe('m1@d1.invalid'); // sanity: the run really aliased the email

    // The fallback was never instantiated during the run, so a fresh one has an
    // EMPTY alias namespace: restoreAll short-circuits to the SAME reference and
    // the alias passes through un-restored. Had the engine fallen back, this
    // singleton would map the alias → 'alice@acme.com' and rewrite the probe.
    const fallback = getFallbackPiiLedgerStore();
    const probe = { token: aliasToken };
    expect(fallback.restoreAll(probe)).toBe(probe);
    expect(fallback.restoreAll({ token: aliasToken }).token).toBe(aliasToken);
  });

  it('does NOT dispose a caller-supplied store — the caller owns its lifecycle', async () => {
    const base = createPiiLedgerStore();
    let createCount = 0;
    let disposeCount = 0;
    const handles: string[] = [];
    const spy: PiiLedgerStore = {
      create() {
        createCount += 1;
        const made = base.create();
        handles.push(made.handle);
        return made;
      },
      get: (h) => base.get(h),
      restoreAll: base.restoreAll,
      serialize: base.serialize,
      dispose() {
        disposeCount += 1;
        base.dispose();
      },
    };

    const ctx = makeCtx(piiRecipe(), spy);
    await executeRecipe(ctx);

    expect(createCount).toBe(1); // the single pii-protect step minted one ledger
    expect(disposeCount).toBe(0); // the engine never disposes a store it didn't mint
    // the ledger is still intact — it's the caller's to dispose, not the engine's
    expect(base.get(handles[0])).toBeDefined();
    // and when the OWNER (the caller) disposes, the real PII is dropped
    spy.dispose();
    expect(disposeCount).toBe(1);
    expect(base.get(handles[0])).toBeUndefined();
  });

  it('reuses a caller-supplied store rather than minting its own', async () => {
    const base = createPiiLedgerStore();
    let createCount = 0;
    const spy: PiiLedgerStore = {
      create() { createCount += 1; return base.create(); },
      get: (h) => base.get(h),
      restoreAll: base.restoreAll,
      serialize: base.serialize,
      dispose() { base.dispose(); },
    };
    const ctx = makeCtx(piiRecipe(), spy);
    const result = await executeRecipe(ctx);
    expect(result.success).toBe(true);
    // protect used the supplied store (not an internally-minted one)
    expect(createCount).toBe(1);
  });

  it('budget-path (budget_ms set, run completes) round-trips; caller-supplied store left intact for the caller', async () => {
    const base = createPiiLedgerStore();
    let disposeCount = 0;
    const handles: string[] = [];
    const spy: PiiLedgerStore = {
      create() { const m = base.create(); handles.push(m.handle); return m; },
      get: (h) => base.get(h),
      restoreAll: base.restoreAll,
      serialize: base.serialize,
      dispose() { disposeCount += 1; base.dispose(); },
    };
    // Generous budget so the run wins the race and resolves normally. The store
    // is caller-supplied, so the engine round-trips against it but never disposes
    // it — that's the caller's job (the ownership guard).
    const ctx = makeCtx(piiRecipe(60_000), spy);
    const result = await executeRecipe(ctx);
    expect(result.success).toBe(true);

    const restore = ctx.stores.step.restore as { restored: Record<string, string> };
    expect(restore.restored.from).toBe('alice@acme.com');
    expect(disposeCount).toBe(0); // engine does not dispose a store it didn't mint
    expect(base.get(handles[0])).toBeDefined();
  });

  it('budget TIMEOUT waits for cancellation settlement and never disposes a caller-supplied store', async () => {
    // The budget expires while the ingredient is in flight. The deliberately
    // uncooperative test ingredient settles later; D-259 keeps the run pending
    // until that boundary is clean, then the post-call abort check halts before
    // `pii-restore`. The caller-owned ledger remains the caller's to dispose.
    let gateSettled = false;
    const gate = new Promise<void>((resolve) => {
      setTimeout(() => {
        gateSettled = true;
        resolve();
      }, 75);
    });
    let disposeCount = 0;
    const base = createPiiLedgerStore();
    const handles: string[] = [];
    const spy: PiiLedgerStore = {
      create() { const m = base.create(); handles.push(m.handle); return m; },
      get: (h) => base.get(h),
      restoreAll: base.restoreAll,
      serialize: base.serialize,
      dispose() { disposeCount += 1; base.dispose(); },
    };

    const recipe: RecipeDefinition = {
      recipe_id: 'pii-budget-timeout',
      version: 1,
      ttl: 300,
      metadata: { name: 'pii budget timeout', description: 'gated', author: 'test', supported_platforms: [], budget_ms: 25 },
      variables: {},
      prefetch_steps: [],
      steps: [
        { id: 'protect', transform: 'pii-protect', data: '{{context.raw}}', fields: [{ path: 'from', kind: 'email' }] },
        { id: 'slow', ingredient: 'slow-step', input: {} },
        { id: 'restore', transform: 'pii-restore', data: '{{step.protect.aliased}}', ledger_handle: '{{step.protect.ledger_handle}}' },
      ],
      output: { sidebar: [] },
    };
    const ingredientExecutor: IngredientExecutor = async (slug) => {
      if (slug === 'slow-step') { await gate; return {}; }
      return null;
    };
    const ctx: ExecutionContext = {
      recipe,
      stores: { vault: {}, config: {}, context: { raw: { from: 'alice@acme.com' } }, meta: {}, step: {} },
      ingredientExecutor,
      piiLedgerStore: spy,
    };

    const result = await executeRecipe(ctx);
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('RECIPE_BUDGET_EXCEEDED');
    expect(gateSettled).toBe(true); // executeRecipe awaited inner cleanup
    expect(disposeCount).toBe(0);
    expect(ctx.stores.step.restore).toBeUndefined();
    expect(base.get(handles[0])).toBeDefined();
  });

  it('fails closed on a malformed pii-protect tag BEFORE the AI step runs (no leak)', async () => {
    // D-167 safe-feature rule: a malformed tag must not silently pass raw PII to
    // the LLM. pii-protect throws → TRANSFORM_ERROR → the loop halts on the
    // protect step, so the downstream AI ingredient is never invoked.
    const recipe: RecipeDefinition = {
      recipe_id: 'pii-fail-closed',
      version: 1,
      ttl: 300,
      metadata: { name: 'PII fail closed', description: 'bad tag stops the AI step', author: 'test', supported_platforms: [] },
      variables: {},
      prefetch_steps: [],
      steps: [
        { id: 'protect', transform: 'pii-protect', data: '{{context.raw}}', fields: [{ path: 'from', kind: 'not_a_kind' }] },
        { id: 'ai', ingredient: 'ai-classify', input: { 'llm.data': '{{step.protect.aliased}}', 'llm.categories': ['ok'] } },
      ],
      output: { sidebar: [{ type: 'ai_analysis', source: 'step.ai' }] },
    };
    const calls: string[] = [];
    const ingredientExecutor: IngredientExecutor = async (slug) => { calls.push(slug); return { ok: true }; };
    const ctx: ExecutionContext = {
      recipe,
      stores: { vault: {}, config: {}, context: { raw: structuredClone(RAW) }, meta: {}, step: {} },
      ingredientExecutor,
    };

    const result = await executeRecipe(ctx);

    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ code: 'TRANSFORM_ERROR', source: { step_id: 'protect' } });
    expect(result.steps.map((s) => s.id)).toEqual(['protect']); // halted on protect
    expect(ctx.stores.step.protect).toBeNull();
    expect(ctx.stores.step.ai).toBeUndefined(); // AI step never produced output
    expect(calls).toEqual([]); // and the AI ingredient was never invoked — no leak
  });
});

describe('D-167 P4 — engine-MINTED store IS disposed (ownership guard does not leak owned PII)', () => {
  // These lock in the other half of the guard: the engine MUST still dispose a
  // store it minted itself, on every timing path. Deleting either gated
  // `dispose()` (a real-PII retention regression) drops the counts below to 0,
  // and moving the budget-path dispose from inner-settle to race-resolve flips
  // the deferral assertion — so the suite catches both mutations. (The top-level
  // `beforeEach` resets `mintHooks` before each test; these opt in to counting.)

  it('no-budget path: disposes the engine-minted store exactly once on settle', async () => {
    mintHooks.trackMinted = true;
    const ctx = makeCtx(piiRecipe()); // no supplied store → the engine mints + owns it
    const result = await executeRecipe(ctx);
    expect(result.success).toBe(true);
    // round-trip still works (the wrapped store delegates to the real one)
    const restore = ctx.stores.step.restore as { restored: Record<string, string> };
    expect(restore.restored.from).toBe('alice@acme.com');
    // and the OWNED store was disposed once — dropping the no-budget
    // `if (ownsStore) piiStore?.dispose()` would leave this at 0.
    expect(mintHooks.disposeCount).toBe(1);
  });

  it('budget-complete path: disposes the engine-minted store once on inner-settle', async () => {
    mintHooks.trackMinted = true;
    // Generous budget so the run wins the race and resolves normally.
    const ctx = makeCtx(piiRecipe(60_000));
    const result = await executeRecipe(ctx);
    expect(result.success).toBe(true);
    expect(mintHooks.disposeCount).toBe(1);
  });

  it('budget-TIMEOUT path: awaits inner settlement, then disposes the minted store exactly once', async () => {
    mintHooks.trackMinted = true;
    let gateSettled = false;
    const gate = new Promise<void>((resolve) => {
      setTimeout(() => {
        gateSettled = true;
        resolve();
      }, 75);
    });

    const recipe: RecipeDefinition = {
      recipe_id: 'pii-budget-timeout-minted',
      version: 1,
      ttl: 300,
      metadata: { name: 'pii budget timeout minted', description: 'gated', author: 'test', supported_platforms: [], budget_ms: 25 },
      variables: {},
      prefetch_steps: [],
      steps: [
        { id: 'protect', transform: 'pii-protect', data: '{{context.raw}}', fields: [{ path: 'from', kind: 'email' }] },
        { id: 'slow', ingredient: 'slow-step', input: {} },
        { id: 'restore', transform: 'pii-restore', data: '{{step.protect.aliased}}', ledger_handle: '{{step.protect.ledger_handle}}' },
      ],
      output: { sidebar: [] },
    };
    const ingredientExecutor: IngredientExecutor = async (slug) => {
      if (slug === 'slow-step') { await gate; return {}; }
      return null;
    };
    const ctx: ExecutionContext = {
      recipe,
      stores: { vault: {}, config: {}, context: { raw: { from: 'alice@acme.com' } }, meta: {}, step: {} },
      ingredientExecutor,
    }; // no supplied store → the engine mints + owns it

    const result = await executeRecipe(ctx);
    expect(result.success).toBe(false);
    expect(result.errors[0].code).toBe('RECIPE_BUDGET_EXCEEDED');
    expect(gateSettled).toBe(true); // cancellation boundary settled first
    expect(mintHooks.disposeCount).toBe(1);
    expect(ctx.stores.step.restore).toBeUndefined();
    expect(mintHooks.disposeCount).toBe(1); // disposed exactly once, on inner-settle
  });
});
