/** D-118 Phase 6 — service dispatcher public surface. */

export {
  createServiceDispatcher,
  ServiceDispatcherError,
} from './dispatcher.js';
export { defaultSpawnInvoke } from './spawn-invoke.js';
export {
  InvokeInputInvalidError,
  resolveInvokeArgv,
  resolveInvokeEnv,
  validateInvokeInputs,
} from './invoke-refs.js';
export type {
  BundleStartSpec,
  BundleStopSpec,
  ConfigFieldSchema,
  DispatcherServiceStatus,
  ExposeSpec,
  InvokeFieldSchema,
  InvokeOpSpec,
  InvokeSpawnResult,
  ServiceBundleResolver,
  ServiceDispatcher,
  ServiceDispatcherDeps,
  ServiceInstanceBundle,
  ServiceLogReader,
  SpawnInvokeFn,
  SpawnInvokeOpts,
} from './types.js';
