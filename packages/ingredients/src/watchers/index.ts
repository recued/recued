/** D-115 Phase 6 — pure watcher evaluators consumed by the server's
 *  `createWatcherDispatcher` composition
 *  (`backend/server/src/watchers/index.ts`) so trigger-step
 *  semantics stay deterministic regardless of caller. */

export {
  evaluateTimeWatcher,
  type TimeWatcherArgs,
  type TimeWatcherOutput,
} from './time.js';

export {
  evaluateHttpWatcher,
  type HttpWatcherArgs,
  type HttpWatcherOutput,
  type HttpWatcherDeps,
} from './http.js';
