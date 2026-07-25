/** D-118 Phase 4 — checker registry public surface. */

export {
  CheckerParamError,
  runCheck,
  type CheckerContext,
} from './dispatcher.js';
export {
  defaultKill0,
  defaultReadText,
  defaultSpawnWithTimeout,
  defaultStat,
  defaultTcpConnect,
  defaultWhichBinary,
  withDefaults,
} from './process.js';
export type {
  CheckerKindModule,
  CheckerSpawnFn,
  CheckerTcpConnectFn,
} from './types.js';
export { TCP_CONNECT_TIMEOUT_MS } from './tcp-open.js';
