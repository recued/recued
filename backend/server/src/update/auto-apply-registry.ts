/** D-178 P1 — cmdServe-scoped bridge for the auto-apply-on-idle wiring.
 *
 *  Two boot phases that don't share a call tree have to reconverge:
 *    - `composeListeners` (start-listener-exposure-runtime) builds the apply
 *      orchestrator deps + the mode store and owns the `isQuiesced` port it
 *      handed `buildApplyOrchestratorDeps` (built BEFORE the engine-busy signal
 *      exists). It `publish`es the entry here.
 *    - `composeHousekeepingScheduler` (start-post-listener-runtime, later) owns
 *      the `EngineBusySignal`. It `consume`s the entry to register the
 *      `update-auto-apply` task and calls `bindBusySignal` to back the
 *      `isQuiesced` port with the real signal — replacing the `() => true`
 *      placeholder slice 4b shipped.
 *
 *  Same rationale as `housekeeping-scheduler-instance.ts`'s singleton: a
 *  cmdServe-scoped, process-once handle is the honest tool for two composers
 *  that only reconverge at the top of the boot. Tests get isolation via
 *  `createUpdateAutoApplyRegistry()`; production uses the default singleton. */

import type { UpdateApplyDeps } from '../update-handler.js';
import type { DistributionChannel, UpdateModeStore } from './update-mode-store.js';

export interface UpdateAutoApplyEntry {
  /** Apply orchestrator deps (ports + `resolveForApply`). Shared with the manual
   *  `update.apply` rpc — same ledger lock, same I-2 verify boundary. */
  applyDeps: UpdateApplyDeps;
  /** Apply-policy store + channel + raw env mode, for the effective-mode gate. */
  modeStore: UpdateModeStore;
  channel: DistributionChannel;
  envMode?: string;
  /** Back the orchestrator's `isQuiesced` port with the real engine-busy signal.
   *  Called once by the housekeeping composer after the signal is constructed.
   *  Until called, `isQuiesced` is fail-closed (defers the auto path). */
  bindBusySignal: (isEngineBusy: () => boolean) => void;
}

export interface UpdateAutoApplyRegistry {
  /** Publish from `composeListeners`. `undefined` on a delegated channel /
   *  unsupported platform (no self-apply path) clears any prior entry. */
  publish(entry: UpdateAutoApplyEntry | undefined): void;
  /** Consume from `composeHousekeepingScheduler`. */
  consume(): UpdateAutoApplyEntry | undefined;
}

export const createUpdateAutoApplyRegistry = (): UpdateAutoApplyRegistry => {
  let entry: UpdateAutoApplyEntry | undefined;
  return {
    publish(next) {
      entry = next;
    },
    consume() {
      return entry;
    },
  };
};

export const updateAutoApplyRegistry: UpdateAutoApplyRegistry =
  createUpdateAutoApplyRegistry();
