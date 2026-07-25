/** D-118 Phase 5 — supervisor public surface. */

export { createSupervisor, type Supervisor } from './supervisor.js';
export {
  applyReconcileDecision,
  decideReconcile,
  reconcileAll,
  type ReconcileContext,
  type ReconcileDecision,
  type ReconcileOutcome,
} from './reconcile.js';
export {
  createHealthLoop,
  createHealthLoopRegistry,
  type HealthLoop,
  type HealthLoopContext,
  type HealthLoopRegistry,
} from './health-loop.js';
export { defaultSpawnProcess } from './process.js';
export type {
  CheckSpec,
  RunCheckFn,
  ServiceEventEmitter,
  ServiceInstanceSpec,
  SpawnOpts,
  SpawnProcessFn,
  SpawnedProcess,
  StartOutcome,
  StartSpec,
  StopOutcome,
  StopSpec,
  SupervisorContext,
  TimerSeams,
  VaultResolveFn,
} from './types.js';
export {
  redactArgvForAudit,
  resolveArgv,
  resolveArgvValue,
  resolveEnv,
  resolveEnvValue,
} from './refs.js';
