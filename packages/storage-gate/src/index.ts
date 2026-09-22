/** @recued/storage-gate — pressure-aware write gate for gated surfaces.
 *
 *  Phase A wiring point. Each surface (vault, account_store, shared_store,
 *  cache, audit, schedules) owns an instance; the gate tells it when a
 *  proposed write should succeed and fires state-change events the
 *  rest of the system listens on (heartbeat envelope, audit log, logger). */

export { createStorageGate } from './gate.js';
export type { CreateGateOptions } from './gate.js';

export {
  MAX_RESERVE_FRACTION,
  MIN_RESERVE_BYTES,
} from './types.js';

export type {
  CanWriteOptions,
  GateConfig,
  GateInfo,
  StateChangeEvent,
  StateChangeListener,
  StorageGate,
  StorageState,
  WriteCheck,
} from './types.js';

export {
  canonicalJson,
  estimateSize,
  estimateTotalSize,
  utf8ByteLength,
} from './estimate.js';
