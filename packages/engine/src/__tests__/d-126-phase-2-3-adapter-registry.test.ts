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
 *    - `connection` defaults to `connectionPlaceholder` (single swap
 *      point for D-125 P3).
 *    - Callers can override `connection` for tests / custom
 *      connection-kind harnesses. */

import { describe, expect, it } from 'vitest';
import { INGREDIENT_KINDS, type IngredientKind } from '@recued/contracts';
import type { Adapter, ResolvedCall } from '@recued/ingredients';
import { createAdapterRegistry, connectionPlaceholder } from '../adapters/registry.js';

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
  it('defaults to connectionPlaceholder (single swap point for D-125 P3)', () => {
    const registry = createAdapterRegistry({});
    expect(registry.connection).toBe(connectionPlaceholder);
  });

  it('connectionPlaceholder throws KIND_NOT_YET_IMPLEMENTED', async () => {
    await expect(connectionPlaceholder(stubResolved('any-connection'))).rejects.toMatchObject({
      code: 'KIND_NOT_YET_IMPLEMENTED',
      kind: 'connection',
    });
  });

  it('caller can override connection (test / custom harness)', () => {
    const myConn: Adapter = async () => 'custom';
    const registry = createAdapterRegistry({ connection: myConn });
    expect(registry.connection).toBe(myConn);
  });
});
