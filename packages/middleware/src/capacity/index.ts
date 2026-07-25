/** D-145 PB1 — capacity_spec engine barrel.
 *
 *  Public surface consumed by PB1.7 composer + future PB3
 *  orchestrator. Pure types + closed-list constants live in
 *  `@recued/contracts`; this barrel exports the engine-side
 *  walker / cache / probes / emitters / counters. */

export { walkCapacities, createEmptyCounters } from './walker.js';
export type { WalkCapacitiesArgs } from './walker.js';

export { createCapacityCache } from './cache.js';
export type { CreateCapacityCacheOptions } from './cache.js';

export { createCapacityInvalidationSource } from './invalidation-source.js';

export {
  createCapacityProbeRegistry,
  composeConnectionActivenessProbe,
  type CapacityProbeDeps,
} from './probes/index.js';
export type {
  BridgeStateProbe,
  IngredientRegistryProbe,
  PermissionRegistryProbe,
  ConnectionHealthProbe,
  SourceEnablementProbe,
  ConnectionActivenessProbe,
  QuotaHeadroomProbe,
  WarehouseRefResolver,
} from './probes/index.js';

export { createCapacityAuditEmitter } from './audit.js';
export type { AuditLogAdapter } from './audit.js';

export {
  createNoopTransparencyEmitter,
  createCapturingTransparencyEmitter,
} from './transparency.js';

export {
  CAPACITY_REMEDIATION_FALLBACK_COPY,
  CAPACITY_REMEDIATION_DEFAULT_VISIBILITY,
} from './remediations.js';

export type {
  CapacityCounters,
  CapacityCountersSnapshot,
  CapacityWalkContext,
  CapacityProbe,
  CapacityProbeRegistry,
  CapacityCache,
  CapacityCacheRow,
  CapacityAuditEmitter,
  CapacityTransparencyEmitter,
} from './types.js';
