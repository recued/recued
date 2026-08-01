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

import type { ReleaseCheckResponse } from '@recued/contracts';

import type { NotificationBlock, NotificationMessage } from '@recued/notification';

import type { UpdateApplyDeps } from '../update-handler.js';
import { runReleaseCheck, type ReleaseCheckDeps } from './release-check.js';
import type { DistributionChannel, UpdateModeStore } from './update-mode-store.js';

export interface UpdateAutoApplyEntry {
  /** The CHECK (`runReleaseCheck` bound to the booted release deps). Required —
   *  it is what the task always has, on every supported platform.
   *
   *  ⚠ This entry used to be published only when `applyDeps` existed, which
   *  meant `docker-baked` and `source` — the two channels that DEFAULT to
   *  `notify` — registered no periodic task at all and so never checked. The
   *  check is the required half; apply is the optional one. */
  runCheck: () => Promise<ReleaseCheckResponse>;
  /** Apply orchestrator deps (ports + `resolveForApply`). Shared with the manual
   *  `update.apply` rpc — same ledger lock, same I-2 verify boundary. ABSENT on
   *  a delegated channel (no self-apply path exists there). */
  applyDeps?: UpdateApplyDeps;
  /** Read / record the available version already reported to the owner, so a
   *  daily check doesn't re-announce the same release forever. */
  readLastReported: () => string | null;
  writeLastReported: (version: string) => void;
  /** D-158 — push an available release to the owner's channels. Absent when the
   *  boot composed no notification block. */
  notifyOwner?: (message: NotificationMessage) => Promise<void>;
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
  /** Publish from `composeListeners`. `undefined` on an UNSUPPORTED PLATFORM
   *  (no release deps at all) clears any prior entry. A delegated channel still
   *  publishes — it has a check, just no apply. */
  publish(entry: UpdateAutoApplyEntry | undefined): void;
  /** Consume from `composeHousekeepingScheduler`. */
  consume(): UpdateAutoApplyEntry | undefined;
}

export interface BuildUpdateReleaseEntryInputs {
  /** Absent only on an unsupported platform. */
  releaseCheckDeps: ReleaseCheckDeps | undefined;
  /** Absent on a delegated channel (`docker-baked` / `source`). */
  applyDeps: UpdateApplyDeps | undefined;
  modeStore: UpdateModeStore;
  channel: DistributionChannel;
  envMode?: string;
  bindBusySignal: (isEngineBusy: () => boolean) => void;
  /** The composed D-158 block, when this boot has one. */
  notificationBlock?: Pick<NotificationBlock, 'notify'>;
}

/** Build the registry entry from the booted release deps.
 *
 *  🔑 EXTRACTED FROM THE COMPOSITION CLOSURE ON PURPOSE. This decision — which
 *  installs get a periodic release task at all — lived inline in
 *  `composeListeners`, where no test could reach it, and it was wrong: it
 *  required `applyDeps`, so the delegated channels got no task. Logic that
 *  decides whether a subsystem exists does not belong somewhere unreachable. */
export const buildUpdateReleaseEntry = (
  inputs: BuildUpdateReleaseEntryInputs,
): UpdateAutoApplyEntry | undefined => {
  const deps = inputs.releaseCheckDeps;
  if (!deps) return undefined;
  return {
    runCheck: () => runReleaseCheck(deps),
    readLastReported: () => deps.loadState().last_reported_version ?? null,
    // Read-modify-write AFTER the check has run, so this composes over the
    // anti-replay sequence the check itself may have just advanced.
    writeLastReported: (version) => deps.saveState({ ...deps.loadState(), last_reported_version: version }),
    ...(inputs.applyDeps ? { applyDeps: inputs.applyDeps } : {}),
    // Bound here rather than passed as a closure from the composer so the block
    // is reached the same way on every boot path, and so the wiring test can
    // see whether it was wired at all.
    ...(inputs.notificationBlock
      ? { notifyOwner: (message: NotificationMessage) => inputs.notificationBlock!.notify(message) }
      : {}),
    modeStore: inputs.modeStore,
    channel: inputs.channel,
    ...(inputs.envMode !== undefined ? { envMode: inputs.envMode } : {}),
    bindBusySignal: inputs.bindBusySignal,
  };
};

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
