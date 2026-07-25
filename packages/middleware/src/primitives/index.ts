/** D-145 PB3 — engine primitive substrate barrel.
 *
 *  Public surface consumed by the orchestrator + tests +
 *  benchmark fixtures. The 10 primitive factories ship from this
 *  barrel; the registry composes them into a typed lookup.
 *
 *  Per § B.1 + § B.1.3. */

export {
  buildPrimitiveCall,
  projectAdapterDetailForAudit,
  projectErrorClass,
  resolveMintCallId,
  resolveNow,
  type EnginePrimitive,
  type PrimitiveExecuteContext,
  type PrimitiveExecuteResult,
  type BuildPrimitiveCallArgs,
} from './types.js';

export {
  createCapacitySpecPrimitive,
  type CapacitySpecPrimitiveDeps,
  type CapacitySpecPrimitiveInput,
  type CapacitySpecPrimitiveOutput,
} from './capacity-spec.js';

export {
  createDataFetchPrimitive,
  DATA_FETCH_COLLECTIONS,
  DATA_FETCH_COLLECTION_SET,
  type DataFetchCollection,
  type DataFetchPrimitiveDeps,
  type DataFetchPrimitiveInput,
  type DataFetchPrimitiveOutput,
  type WarehouseFetchAdapter,
  type WarehouseFetchRequest,
  type WarehouseFetchResult,
} from './data-fetch.js';

export {
  createMemoryRecallPrimitive,
  MEMORY_RECALL_AXES,
  MEMORY_RECALL_AXIS_SET,
  type MemoryRecallAxis,
  type MemoryRecallAdapter,
  type MemoryRecallRequest,
  type MemoryRecallResult,
  type MemoryRecallEntry,
  type MemoryRecallPrimitiveDeps,
  type MemoryRecallPrimitiveInput,
  type MemoryRecallPrimitiveOutput,
} from './memory-recall.js';

export {
  createMemoryWritePrimitive,
  type MemoryWriteAdapter,
  type MemoryWriteRequest,
  type MemoryWriteResult,
  type MemoryWritePrimitiveDeps,
  type MemoryWritePrimitiveInput,
  type MemoryWritePrimitiveOutput,
} from './memory-write.js';

export {
  createEnrichmentLookupPrimitive,
  type EnrichmentLookupAdapter,
  type EnrichmentLookupRequest,
  type EnrichmentLookupResult,
  type EnrichmentRow,
  type EnrichmentLookupPrimitiveDeps,
  type EnrichmentLookupPrimitiveInput,
  type EnrichmentLookupPrimitiveOutput,
} from './enrichment-lookup.js';

export {
  createAISynthesizePrimitive,
  AI_POOL_POLICIES,
  AI_POOL_POLICY_SET,
  type AIPoolPolicy,
  type AISynthesizeAdapter,
  type AISynthesizeRequest,
  type AISynthesizeResult,
  type AISynthesizeEvent,
  type AISynthesizePrimitiveDeps,
  type AISynthesizePrimitiveInput,
  type AISynthesizePrimitiveOutput,
} from './ai-synthesize.js';

export {
  createBridgeDispatchPrimitive,
  type BridgeCommandAdapter,
  type BridgeCommand,
  type BridgeCommandResult,
  type BridgeDispatchPrimitiveDeps,
  type BridgeDispatchPrimitiveInput,
  type BridgeDispatchPrimitiveOutput,
} from './bridge-dispatch.js';

export {
  createRecipeInvokePrimitive,
  type RecipeInvokeAdapter,
  type RecipeInvokeRequest,
  type RecipeInvokeResult,
  type RecipeInvokePrimitiveDeps,
  type RecipeInvokePrimitiveInput,
  type RecipeInvokePrimitiveOutput,
} from './recipe-invoke.js';

export {
  createApprovalRequestPrimitive,
  APPROVAL_DECISIONS,
  APPROVAL_DECISION_SET,
  type ApprovalDecision,
  type ApprovalAdapter,
  type ApprovalRequest,
  type ApprovalResponse,
  type ApprovalRequestPrimitiveDeps,
  type ApprovalRequestPrimitiveInput,
  type ApprovalRequestPrimitiveOutput,
} from './approval-request.js';

export {
  createProvenanceLinkPrimitive,
  type ProvenanceLinkAdapter,
  type ProvenanceLinkRequest,
  type ProvenanceLinkResult,
  type ProvenanceLinkPrimitiveDeps,
  type ProvenanceLinkPrimitiveInput,
  type ProvenanceLinkPrimitiveOutput,
} from './provenance-link.js';

export {
  createPrimitiveRegistry,
  type PrimitiveRegistry,
  type PrimitiveRegistryDeps,
  type PrimitiveIOMap,
} from './registry.js';
