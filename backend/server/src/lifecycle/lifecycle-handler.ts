/** Lifecycle rpc handlers (Phase C).
 *
 *  Three rpc methods, one `makeLifecycleHandlers` slice on the
 *  existing `composeHandlers` shape. Adds:
 *    - `server.requestShutdown` — graceful drain + exit 0 intent.
 *    - `server.getLifecycleState` — live snapshot.
 *    - `server.resetCrashLoop` — admin clears counters + kill switch.
 *
 *  `server.requestRestart` stays in `bootstrap-handler.ts` but is
 *  rewired by Phase C commit 11 to delegate into the same `Lifecycle`
 *  surface (drain with intent=restart). This module doesn't own it so
 *  the existing `makeBootstrapHandlers` slice registration continues
 *  to cover it — adding another registration here would collide.
 */

import type {
  HandlerSlice,
  LifecycleStatus,
  ServerRpcRegistry,
} from '@recued/contracts';
import type { WsClient } from '../ws-server.js';
import type { DrainIntent } from '@recued/contracts';
import type {
  DrainOptions,
  DrainOrchestrator,
  DrainResult,
} from './drain-orchestrator.js';
import type { CrashLoopDetector, CrashLoopResetResult } from './crash-loop.js';

export interface LifecycleHandlerDeps {
  /** Snapshot builder — returns the current `LifecycleStatus`. This
   *  is a thunk so the handler sees live state on every call without
   *  threading the store + machine + supervisor individually. */
  getSnapshot: () => LifecycleStatus;
  /** Drain orchestrator — called by `requestShutdown` AND (via
   *  bootstrap-handler rewire) by `requestRestart`. Kept here so the
   *  handler can report `accepted: false` when a drain is already
   *  in-flight. */
  drain: DrainOrchestrator;
  /** Full lifecycle drain entry point. This must be
   *  `Lifecycle.requestDrain` so clean-shutdown persistence and terminal state
   *  transitions cannot be bypassed. */
  requestDrain: (opts: DrainOptions) => Promise<DrainResult>;
  /** Supervisor handoff — called after drain resolves to exit with
   *  the mode-appropriate code. */
  onDrainComplete: (intent: DrainIntent, reason: string) => void;
  /** Crash-loop detector — drives `resetCrashLoop`. */
  crashLoop: CrashLoopDetector;
}

export const handleRequestShutdown = (
  deps: LifecycleHandlerDeps,
  args: { reason: string; drain_timeout_s?: number },
): { accepted: boolean } => {
  if (deps.drain.state.active) {
    return { accepted: false };
  }
  const timeoutMs = args.drain_timeout_s !== undefined
    ? Math.max(1000, args.drain_timeout_s * 1000)
    : undefined;
  // Fire-and-forget. Caller's ws will close when the drain reaches
  // the close_ws step; they get `{ accepted: true }` first.
  void deps.requestDrain({
    reason: args.reason || 'rpc',
    intent: 'shutdown',
    timeoutMs,
  })
    .then((result) => {
      deps.onDrainComplete(result.intent, result.reason);
    })
    .catch(() => {
      // Fire-and-forget RPC handoff: the lifecycle/drain implementation owns
      // structured error logging. Never create an unhandled rejection here.
    });
  return { accepted: true };
};

export const handleGetLifecycleState = (
  deps: Pick<LifecycleHandlerDeps, 'getSnapshot'>,
): LifecycleStatus => deps.getSnapshot();

export const handleResetCrashLoop = (
  deps: Pick<LifecycleHandlerDeps, 'crashLoop'>,
): {
  ok: true;
  cleared: {
    restart_count: boolean;
    last_crash: boolean;
    crash_halt: boolean;
  };
} => {
  const result: CrashLoopResetResult = deps.crashLoop.reset();
  return {
    ok: true,
    cleared: {
      restart_count: result.restart_count_cleared,
      last_crash: result.last_crash_cleared,
      crash_halt: result.crash_halt_released,
    },
  };
};

// ────────────────────────────────────────────────────────────────
// Handler slice — composeHandlers factory
// ────────────────────────────────────────────────────────────────

export type LifecycleMethods =
  | 'server.requestShutdown'
  | 'server.getLifecycleState'
  | 'server.resetCrashLoop';

export const makeLifecycleHandlers = (
  deps: LifecycleHandlerDeps | undefined,
): HandlerSlice<ServerRpcRegistry, LifecycleMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: [
      'server.requestShutdown',
      'server.getLifecycleState',
      'server.resetCrashLoop',
    ],
    handlers: {
      'server.requestShutdown': async (args) =>
        handleRequestShutdown(deps, args),
      'server.getLifecycleState': async () =>
        handleGetLifecycleState(deps),
      'server.resetCrashLoop': async () =>
        handleResetCrashLoop(deps),
    },
  };
};
