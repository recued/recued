/** Vault-state fan-out bus.
 *
 *  `KeyManager.onStateChange` is a SINGLE construction-time callback
 *  (`key-manager.ts`), but several subsystems need to react to vault
 *  lock/unlock transitions — the autonomous-executor coordinator
 *  (pause-while-locked / resume-on-unlock) today, a client-broadcast
 *  surface later. This is the one multi-subscriber seam wired into that
 *  callback: `createKeyManager({ onStateChange: bus.emit })` at compose
 *  time, and any number of `bus.subscribe(...)` consumers downstream.
 *
 *  Deliberately tiny + synchronous: `emit` runs inside `KeyManager`'s
 *  `transition()` (itself called from `lock()` / `unlock()`), so a
 *  listener must NOT block — fire-and-forget any async work. A throwing
 *  listener is isolated so one broken consumer can't wedge a vault
 *  transition (or the other listeners). */

export type VaultState = 'uninitialized' | 'locked' | 'unlocked';

export type VaultStateListener = (next: VaultState, prev: VaultState) => void;

export interface VaultStateBus {
  /** Wired into `KeyManagerOptions.onStateChange`. Fans the transition
   *  to every subscriber; listener exceptions are swallowed. */
  emit(next: VaultState, prev: VaultState): void;
  /** Register a listener. Returns an unsubscribe handle. */
  subscribe(listener: VaultStateListener): () => void;
}

export const createVaultStateBus = (): VaultStateBus => {
  const listeners = new Set<VaultStateListener>();
  return {
    emit(next, prev) {
      for (const listener of listeners) {
        try {
          listener(next, prev);
        } catch {
          // A broken listener is a consumer bug, never a reason to wedge
          // a KeyManager state transition.
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};
