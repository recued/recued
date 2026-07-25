/** Module-level singleton for the background-services registry.
 *
 *  Holds every long-lived lifecycle service that cmdServe spins up
 *  (periodic timers, schedulers, future emitter-shaped services).
 *  Exported so any module that owns such a service can `import
 *  { backgroundServices } from '.../background-services-instance.js'`
 *  and register itself via the same registry the lifecycle drain +
 *  fallback shutdown stop pathways consume.
 *
 *  Why a singleton instead of a per-cmdServe construction:
 *    - The DDNS update poller (D-148 § A.14) and any future
 *      lifecycle service want to live in their own module and
 *      self-register without threading the registry as a dep
 *      through every composer in bin.ts.
 *    - cmdServe is the only call site that runs in production; the
 *      module loads exactly once per process, so the singleton
 *      identity matches the cmdServe-scoped instance pattern.
 *
 *  Testing note: tests that want isolation construct their own
 *  registry via `createBackgroundServiceRegistry()` from
 *  `wire-background-services.js`. Production code uses this singleton
 *  for register / stop interop. */

import {
  createBackgroundServiceRegistry,
  type BackgroundServiceRegistry,
} from './wire-background-services.js';

export const backgroundServices: BackgroundServiceRegistry = createBackgroundServiceRegistry();
