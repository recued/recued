import type { BridgeIdempotencyScope } from '../idempotency/cache.js';
import { runBridgeModeConvergence } from './bridge-mode-convergence.js';
import { DEFAULT_BRIDGE_MODE, type SidePanelBridgeMode, type SidePanelStore } from './store/local-store.js';

/** One owner per mount read or invalidation sequence. Its retries share that
 * owner; neither a reply nor a delayed retry may outlive it or its pairing. */
export const createBridgeModeRefresh = (deps: {
  store: SidePanelStore;
  getScope(): BridgeIdempotencyScope | null;
  read(): Promise<unknown>;
  delay(ms: number): Promise<void>;
  attempts: number;
  retryMs: number;
}) => {
  let generation = 0;
  const begin = (): (() => boolean) => {
    const request = ++generation;
    const scope = deps.getScope();
    return () => {
      const live = deps.getScope();
      return request === generation && deps.store.getState().pair.paired
        && scope !== null && live !== null
        && scope.server_public_key === live.server_public_key && scope.token_id === live.token_id;
    };
  };
  const refresh = async (current: () => boolean): Promise<boolean> => {
    if (!current()) return true;
    try {
      const reply = await deps.read() as
        | { ok: true; modes: SidePanelBridgeMode | null }
        | { ok: false; error: string }
        | null
        | undefined;
      // A retired read has nothing left to converge. In particular, its
      // failure cannot fail-close the newer sequence's successful mode.
      if (!current()) return true;
      if (reply?.ok === true) {
        deps.store.applyBridgeMode(reply.modes ?? DEFAULT_BRIDGE_MODE);
        return true;
      }
      return false;
    } catch {
      return !current();
    }
  };
  return {
    invalidate(): void {
      generation++;
      // Storage may still be reading the replacement pair. The prior mode
      // is already retired, even if that read subsequently fails or hangs.
      deps.store.applyBridgeMode(DEFAULT_BRIDGE_MODE);
    },
    refresh(): Promise<boolean> {
      return refresh(begin());
    },
    converge(): Promise<void> {
      const current = begin();
      return runBridgeModeConvergence({
        isCurrent: current,
        refresh: () => refresh(current),
        failClosed: () => deps.store.applyBridgeMode(DEFAULT_BRIDGE_MODE),
        delay: deps.delay,
        attempts: deps.attempts,
        retryMs: deps.retryMs,
      });
    },
  };
};
