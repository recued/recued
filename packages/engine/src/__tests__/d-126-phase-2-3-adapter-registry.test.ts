/** D-126 Phase 2.3 — `createAdapterRegistry` runtime wiring.
 *
 *  Covers:
 *    - Factory returns one entry per `IngredientKind` (closed-set
 *      Record — TypeScript would refuse a missing kind, but assert
 *      runtime shape too as a belt-and-suspenders).
 *    - Provided per-kind adapters are returned as-is (identity).
 *    - Unsupported kinds (caller didn't pass an adapter) get a
 *      placeholder that throws `INGREDIENT_ADAPTER_ALL_FAILED` with
 *      the kind on `details.kind` and a kind-named diagnostic in the
 *      message.
 *    - `connection` defaults to the same kind-named `unsupported(...)`
 *      placeholder as every other slot — D-125 P3 shipped.
 *    - Callers can override `connection` for tests / custom
 *      connection-kind harnesses. */

import { describe, expect, it } from 'vitest';
import { INGREDIENT_KINDS, type IngredientKind } from '@recued/contracts';
import type { Adapter, ResolvedCall } from '@recued/ingredients';
import { createAdapterRegistry } from '../adapters/registry.js';

const stubResolved = (slug = 'stub'): ResolvedCall => ({
  slug,
  risk_tier: 'read',
  input: {},
  output: {},
});

describe('D-126 Phase 2.3 — createAdapterRegistry membership', () => {
  it('returns one entry per IngredientKind (closed-set)', () => {
    const registry = createAdapterRegistry({});
    const registryKeys = new Set(Object.keys(registry));
    const kindKeys = new Set<string>([...INGREDIENT_KINDS]);
    expect(registryKeys).toEqual(kindKeys);
  });

  it('every entry is a callable Adapter', () => {
    const registry = createAdapterRegistry({});
    for (const kind of INGREDIENT_KINDS) {
      expect(typeof registry[kind]).toBe('function');
    }
  });
});

describe('D-126 Phase 2.3 — caller-supplied adapters', () => {
  it('returns provided adapters as-is (identity)', () => {
    const myHttp: Adapter = async () => 'http';
    const myAi: Adapter = async () => 'ai';
    const registry = createAdapterRegistry({ http: myHttp, ai: myAi });
    expect(registry.http).toBe(myHttp);
    expect(registry.ai).toBe(myAi);
  });

  it('unsupplied kinds get an INGREDIENT_ADAPTER_ALL_FAILED placeholder', async () => {
    const registry = createAdapterRegistry({ http: async () => 'ok' });
    // dom not supplied → placeholder.
    await expect(registry.dom(stubResolved('any'))).rejects.toMatchObject({
      code: 'INGREDIENT_ADAPTER_ALL_FAILED',
      details: { kind: 'dom' },
    });
  });

  it('placeholder error message names the kind for triage', async () => {
    const registry = createAdapterRegistry({});
    // D-182 — `cli` joins the unsupported-placeholder set: cli ops execute via
    // the per-kind handler registry, never this legacy adapter table.
    const kinds: readonly IngredientKind[] = ['http', 'dom', 'ai', 'chat', 'mcp', 'service', 'storage', 'cli'];
    for (const kind of kinds) {
      await expect(registry[kind](stubResolved(`any-${kind}`))).rejects.toMatchObject({
        code: 'INGREDIENT_ADAPTER_ALL_FAILED',
        message: expect.stringContaining(`'${kind}'`),
      });
    }
  });
});

describe('D-126 Phase 2.3 — connection slot', () => {
  // ⛔ The default is the SAME kind-named `unsupported(...)` as every other
  // slot — NOT a "not yet implemented" placeholder. D-125 P3 shipped
  // `createConnectionAdapter` and both server boot sites wire it whenever
  // `connectionStore` is present, so the only way to land on the default is an
  // unwired store. The old placeholder said "connection adapter ships in
  // D-125 P3" and carried `KIND_NOT_YET_IMPLEMENTED`, whose user-facing text
  // is "…has not shipped yet. Update Recued" — pointing the operator at an
  // upgrade that could never fix an unwired store. A stale diagnostic is worse
  // than a generic one: it sends the reader somewhere real and wrong.
  it('defaults to the kind-named unsupported placeholder, not a NOT_YET_IMPLEMENTED one', async () => {
    const registry = createAdapterRegistry({});
    await expect(registry.connection(stubResolved('any-connection'))).rejects.toMatchObject({
      code: 'INGREDIENT_ADAPTER_ALL_FAILED',
      details: { kind: 'connection' },
    });
  });

  it('the default names the real condition — an unwired store, not a missing feature', async () => {
    const registry = createAdapterRegistry({});
    const err = await registry.connection(stubResolved('any-connection')).catch((e: unknown) => e);
    const message = (err as { message?: string }).message ?? '';
    expect(message).toContain('connection');
    expect(message).toContain('wired');
    // The stale claims must not come back in any form.
    expect(message).not.toMatch(/D-125|not yet|ships in|shipped/i);
    expect(err).not.toMatchObject({ code: 'KIND_NOT_YET_IMPLEMENTED' });
  });

  it('caller can override connection (test / custom harness)', () => {
    const myConn: Adapter = async () => 'custom';
    const registry = createAdapterRegistry({ connection: myConn });
    expect(registry.connection).toBe(myConn);
  });
});
