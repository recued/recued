/** D-145 PB3 — registry substitutability tests.
 *
 *  Per § B.1.3 — primitive isolation invariant. The registry MUST
 *  let callers swap any primitive with a mock for benchmark fixtures
 *  + per-tier composition tests without touching primitive code. */

import { describe, it, expect } from 'vitest';

import {
  RECUED_PRIMITIVES,
  type RecuedPrimitive,
} from '@recued/contracts';

import {
  buildPrimitiveCall,
  createPrimitiveRegistry,
  type EnginePrimitive,
  type PrimitiveExecuteContext,
  type PrimitiveExecuteResult,
  type PrimitiveIOMap,
  type PrimitiveRegistryDeps,
} from '../primitives/index.js';
import * as capacity from '../capacity/index.js';

const buildStubDeps = (): PrimitiveRegistryDeps => {
  const invalidationSource = capacity.createCapacityInvalidationSource();
  const cache = capacity.createCapacityCache({ invalidationSource });
  const registry = capacity.createCapacityProbeRegistry({
    bridgeStateProbe: { getOnline: () => true, getLoggedIn: () => true },
    ingredientRegistryProbe: {
      isInstalled: () => true,
      getBumpedAt: () => 0,
      getSelectorTtlMs: () => 7 * 24 * 60 * 60 * 1000,
    },
    permissionRegistryProbe: { hasPermission: () => true },
    connectionHealthProbe: { isHealthy: () => true },
    sourceEnablementProbe: { hasEnabledSource: () => true },
    quotaHeadroomProbe: { hasHeadroom: () => true },
    warehouseRefResolver: { resolve: () => true },
  });
  return {
    capacity_spec: {
      registry,
      cache,
      walkContext: {
        audit_emitter: capacity.createCapacityAuditEmitter({ logActivity() {} }),
        transparency_emitter: capacity.createNoopTransparencyEmitter(),
      },
    },
    'data.fetch': { adapter: { fetch: async () => ({ rows: [] }) } },
    'memory.recall': { adapter: { recall: async () => ({ entries: [], total_count: 0 }) } },
    'memory.write': {
      adapter: { write: async () => ({ memory_id: 'm', provenance_edges_written: 0 }) },
    },
    'enrichment.lookup': { adapter: { lookup: async () => ({ rows: [], total_count: 0 }) } },
    'ai.synthesize': {
      adapter: {
        synthesize: async () => ({
          response: '',
          events: [],
          provider: 'p',
          model_id: 'm',
        }),
      },
    },
    'bridge.dispatch': { adapter: { dispatch: async () => ({ success: true }) } },
    'recipe.invoke': { adapter: { invoke: async () => ({ success: true }) } },
    'approval.request': {
      adapter: { request: async () => ({ decision: 'approved', responded_at: 0 }) },
    },
    'provenance.link': {
      adapter: { link: async () => ({ ok: true, edges_written: 0 }) },
    },
  };
};

const baseCtx: PrimitiveExecuteContext = {
  run_id: 'r',
  now: () => 1000,
  mint_call_id: () => 'c',
};

describe('createPrimitiveRegistry', () => {
  it('exposes every primitive in the closed list', () => {
    const reg = createPrimitiveRegistry(buildStubDeps());
    for (const name of RECUED_PRIMITIVES) {
      const prim = reg.get(name);
      expect(prim.primitive).toBe(name);
    }
  });

  it('registeredPrimitives returns the canonical 10-name list in declaration order', () => {
    const reg = createPrimitiveRegistry(buildStubDeps());
    expect(reg.registeredPrimitives()).toEqual([...RECUED_PRIMITIVES]);
  });

  it('override swaps in a mock primitive', async () => {
    const reg = createPrimitiveRegistry(buildStubDeps());
    let called = false;
    const mock: EnginePrimitive<unknown, unknown> = {
      primitive: 'memory.recall',
      async execute(_input, ctx): Promise<PrimitiveExecuteResult<unknown>> {
        called = true;
        return {
          result: { entries: [{ id: 'mock' }], total_count: 1 },
          call: buildPrimitiveCall({
            primitive: 'memory.recall',
            call_id: 'mock-c',
            args_summary: 'mock',
            outcome_summary: 'mock',
            status: 'ok',
            started_at: 1000,
            duration_ms: 0,
          }),
        };
      },
    };
    reg.override('memory.recall', mock as EnginePrimitive<PrimitiveIOMap['memory.recall']['in'], PrimitiveIOMap['memory.recall']['out']>);
    const prim = reg.get('memory.recall');
    const result = await prim.execute({}, baseCtx);
    expect(called).toBe(true);
    expect(result.call.call_id).toBe('mock-c');
  });

  it('resetOverrides reverts to canonical instances', async () => {
    const reg = createPrimitiveRegistry(buildStubDeps());
    const mock: EnginePrimitive<unknown, unknown> = {
      primitive: 'data.fetch',
      async execute(): Promise<PrimitiveExecuteResult<unknown>> {
        return {
          result: { rows: ['mock'] },
          call: buildPrimitiveCall({
            primitive: 'data.fetch',
            call_id: 'mock',
            args_summary: 'mock',
            outcome_summary: 'mock',
            status: 'ok',
            started_at: 1000,
            duration_ms: 0,
          }),
        };
      },
    };
    reg.override('data.fetch', mock as EnginePrimitive<PrimitiveIOMap['data.fetch']['in'], PrimitiveIOMap['data.fetch']['out']>);
    const prim = reg.get('data.fetch');
    expect((await prim.execute({ collection: 'mail' }, baseCtx)).result.rows).toEqual(['mock']);

    reg.resetOverrides();
    const reverted = reg.get('data.fetch');
    expect((await reverted.execute({ collection: 'mail' }, baseCtx)).result.rows).toEqual([]);
  });

  it('per-primitive overrides do not bleed across primitives', () => {
    const reg = createPrimitiveRegistry(buildStubDeps());
    const mock: EnginePrimitive<unknown, unknown> = {
      primitive: 'memory.recall',
      async execute(): Promise<PrimitiveExecuteResult<unknown>> {
        return {
          result: { entries: [], total_count: 0 },
          call: buildPrimitiveCall({
            primitive: 'memory.recall',
            call_id: 'mock',
            args_summary: 'mock',
            outcome_summary: 'mock',
            status: 'ok',
            started_at: 0,
            duration_ms: 0,
          }),
        };
      },
    };
    reg.override(
      'memory.recall',
      mock as EnginePrimitive<PrimitiveIOMap['memory.recall']['in'], PrimitiveIOMap['memory.recall']['out']>,
    );
    expect(reg.get('memory.recall').primitive).toBe('memory.recall');
    expect(reg.get('data.fetch').primitive).toBe('data.fetch');
    expect(reg.get('ai.synthesize').primitive).toBe('ai.synthesize');
  });
});
