/** D-145 PB3 — engine primitive registry.
 *
 *  Per § B.1 + § B.1.3. Composes the 10 typed primitive instances
 *  into a single registry the orchestrator looks up by primitive
 *  name. Substitutability for benchmark fixtures: callers (tests +
 *  PC3 fixtures) build a registry with mock primitives by passing
 *  their own factory implementations.
 *
 *  The registry is the substrate gate that pins the closed
 *  primitive list — drift requires a substrate D-spec change. The
 *  PB3 ratchet test asserts every key in `RECUED_PRIMITIVES` has a
 *  registry entry and vice versa.
 *
 *  Spec: § B.1 + § B.1.3. */

import {
  RECUED_PRIMITIVES,
  type RecuedPrimitive,
} from '@recued/contracts';

import {
  createCapacitySpecPrimitive,
  type CapacitySpecPrimitiveDeps,
  type CapacitySpecPrimitiveInput,
  type CapacitySpecPrimitiveOutput,
} from './capacity-spec.js';
import {
  createDataFetchPrimitive,
  type DataFetchPrimitiveDeps,
  type DataFetchPrimitiveInput,
  type DataFetchPrimitiveOutput,
} from './data-fetch.js';
import {
  createMemoryRecallPrimitive,
  type MemoryRecallPrimitiveDeps,
  type MemoryRecallPrimitiveInput,
  type MemoryRecallPrimitiveOutput,
} from './memory-recall.js';
import {
  createMemoryWritePrimitive,
  type MemoryWritePrimitiveDeps,
  type MemoryWritePrimitiveInput,
  type MemoryWritePrimitiveOutput,
} from './memory-write.js';
import {
  createEnrichmentLookupPrimitive,
  type EnrichmentLookupPrimitiveDeps,
  type EnrichmentLookupPrimitiveInput,
  type EnrichmentLookupPrimitiveOutput,
} from './enrichment-lookup.js';
import {
  createAISynthesizePrimitive,
  type AISynthesizePrimitiveDeps,
  type AISynthesizePrimitiveInput,
  type AISynthesizePrimitiveOutput,
} from './ai-synthesize.js';
import {
  createBridgeDispatchPrimitive,
  type BridgeDispatchPrimitiveDeps,
  type BridgeDispatchPrimitiveInput,
  type BridgeDispatchPrimitiveOutput,
} from './bridge-dispatch.js';
import {
  createRecipeInvokePrimitive,
  type RecipeInvokePrimitiveDeps,
  type RecipeInvokePrimitiveInput,
  type RecipeInvokePrimitiveOutput,
} from './recipe-invoke.js';
import {
  createApprovalRequestPrimitive,
  type ApprovalRequestPrimitiveDeps,
  type ApprovalRequestPrimitiveInput,
  type ApprovalRequestPrimitiveOutput,
} from './approval-request.js';
import {
  createProvenanceLinkPrimitive,
  type ProvenanceLinkPrimitiveDeps,
  type ProvenanceLinkPrimitiveInput,
  type ProvenanceLinkPrimitiveOutput,
} from './provenance-link.js';

import type { EnginePrimitive } from './types.js';

// ── PrimitiveIO — typed input/output map per primitive ──────────────

/** Per-primitive typed input + output bindings. PB3 keeps the closed
 *  list aligned with `RECUED_PRIMITIVES`; the orchestrator uses this
 *  map to type-check per-primitive call sites. */
export interface PrimitiveIOMap {
  capacity_spec: { in: CapacitySpecPrimitiveInput; out: CapacitySpecPrimitiveOutput };
  'data.fetch': { in: DataFetchPrimitiveInput; out: DataFetchPrimitiveOutput };
  'memory.recall': { in: MemoryRecallPrimitiveInput; out: MemoryRecallPrimitiveOutput };
  'memory.write': { in: MemoryWritePrimitiveInput; out: MemoryWritePrimitiveOutput };
  'enrichment.lookup': { in: EnrichmentLookupPrimitiveInput; out: EnrichmentLookupPrimitiveOutput };
  'ai.synthesize': { in: AISynthesizePrimitiveInput; out: AISynthesizePrimitiveOutput };
  'bridge.dispatch': { in: BridgeDispatchPrimitiveInput; out: BridgeDispatchPrimitiveOutput };
  'recipe.invoke': { in: RecipeInvokePrimitiveInput; out: RecipeInvokePrimitiveOutput };
  'approval.request': { in: ApprovalRequestPrimitiveInput; out: ApprovalRequestPrimitiveOutput };
  'provenance.link': { in: ProvenanceLinkPrimitiveInput; out: ProvenanceLinkPrimitiveOutput };
}

// ── PrimitiveRegistry — closed-list lookup ──────────────────────────

export interface PrimitiveRegistry {
  get<K extends RecuedPrimitive>(
    primitive: K,
  ): EnginePrimitive<PrimitiveIOMap[K]['in'], PrimitiveIOMap[K]['out']>;
  /** Test escape hatch: substitute a primitive in-place. PC3 fixtures
   *  + benchmark mocks use this without touching primitive code. */
  override<K extends RecuedPrimitive>(
    primitive: K,
    instance: EnginePrimitive<PrimitiveIOMap[K]['in'], PrimitiveIOMap[K]['out']>,
  ): void;
  /** Test escape hatch: revert all overrides to the dep-bundle defaults. */
  resetOverrides(): void;
  /** Closed-list audit — returns the registered primitive names in
   *  declaration order. PB3 ratchet asserts === RECUED_PRIMITIVES. */
  registeredPrimitives(): RecuedPrimitive[];
}

// ── PrimitiveRegistryDeps — every primitive's dep bundle ────────────

export interface PrimitiveRegistryDeps {
  capacity_spec: CapacitySpecPrimitiveDeps;
  'data.fetch': DataFetchPrimitiveDeps;
  'memory.recall': MemoryRecallPrimitiveDeps;
  'memory.write': MemoryWritePrimitiveDeps;
  'enrichment.lookup': EnrichmentLookupPrimitiveDeps;
  'ai.synthesize': AISynthesizePrimitiveDeps;
  'bridge.dispatch': BridgeDispatchPrimitiveDeps;
  'recipe.invoke': RecipeInvokePrimitiveDeps;
  'approval.request': ApprovalRequestPrimitiveDeps;
  'provenance.link': ProvenanceLinkPrimitiveDeps;
}

export const createPrimitiveRegistry = (deps: PrimitiveRegistryDeps): PrimitiveRegistry => {
  // Build canonical instances once. Overrides go in a parallel map
  // so `resetOverrides()` reverts to canonical without rebuilding.
  const canonical: { [K in RecuedPrimitive]: EnginePrimitive<PrimitiveIOMap[K]['in'], PrimitiveIOMap[K]['out']> } = {
    capacity_spec: createCapacitySpecPrimitive(deps.capacity_spec),
    'data.fetch': createDataFetchPrimitive(deps['data.fetch']),
    'memory.recall': createMemoryRecallPrimitive(deps['memory.recall']),
    'memory.write': createMemoryWritePrimitive(deps['memory.write']),
    'enrichment.lookup': createEnrichmentLookupPrimitive(deps['enrichment.lookup']),
    'ai.synthesize': createAISynthesizePrimitive(deps['ai.synthesize']),
    'bridge.dispatch': createBridgeDispatchPrimitive(deps['bridge.dispatch']),
    'recipe.invoke': createRecipeInvokePrimitive(deps['recipe.invoke']),
    'approval.request': createApprovalRequestPrimitive(deps['approval.request']),
    'provenance.link': createProvenanceLinkPrimitive(deps['provenance.link']),
  };

  const overrides = new Map<RecuedPrimitive, EnginePrimitive<unknown, unknown>>();

  return {
    get<K extends RecuedPrimitive>(
      primitive: K,
    ): EnginePrimitive<PrimitiveIOMap[K]['in'], PrimitiveIOMap[K]['out']> {
      const overridden = overrides.get(primitive);
      if (overridden) {
        return overridden as EnginePrimitive<PrimitiveIOMap[K]['in'], PrimitiveIOMap[K]['out']>;
      }
      return canonical[primitive];
    },
    override<K extends RecuedPrimitive>(
      primitive: K,
      instance: EnginePrimitive<PrimitiveIOMap[K]['in'], PrimitiveIOMap[K]['out']>,
    ): void {
      overrides.set(primitive, instance as EnginePrimitive<unknown, unknown>);
    },
    resetOverrides(): void {
      overrides.clear();
    },
    registeredPrimitives(): RecuedPrimitive[] {
      return [...RECUED_PRIMITIVES];
    },
  };
};
