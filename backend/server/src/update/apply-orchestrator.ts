/** D-178 slice 4 — the apply/rollback ORCHESTRATOR (spec § Update machinery).
 *
 *  Ties the slice-3 spine (ledger + state machine + boot-failure counter) to
 *  the slice-3b mechanics (download / verify / swap / snapshot) into the
 *  two-phase apply, the rollback, and the on-boot commit/auto-revert decision.
 *
 *  Everything is driven through injected ports so the whole flow is unit-
 *  testable without a network, a clock, a real binary, or a process restart.
 *  The actual supervisor restart, the readiness probe, and the data-dir paths
 *  are wired in slice 4b (compose-listeners + the boot sequence).
 *
 *  The in-flight lock is DERIVED from the ledger (the durable source of truth
 *  that survives the restart the `boot` phase straddles): an `apply_started`
 *  with no later terminal entry for the same release is still in flight.
 */

import {
  decideRollback,
  shouldAutoRevert,
} from './apply-state-machine.js';
import type { UpdateLedger, UpdateLedgerEntry, UpdateLedgerKind } from './update-ledger.js';
import type { BootFailureCounter } from './boot-failure-counter.js';
import type { VerifyArtifactInput, VerifyArtifactResult } from './binary-apply-executor.js';
import type { WebclientApplyIdentity, WebclientSyncEffect } from './webclient-sync.js';
import type {
  ManualRollbackJournalInput,
  ManualRollbackPhase,
  ManualRollbackRecovery,
} from './manual-rollback-journal.js';

export interface ApplyContext {
  releaseIdentity: string;
  fromVersion: string;
  toVersion: string;
  channel: 'stable' | 'edge';
  migration: boolean;
  artifact: { url: string; sha256: string; sig: string };
  /** D-178 S1 rev 2 item 4 — the native addon the target binary was built
   *  against, staged + verified + swapped AS A SET with the exe.
   *
   *  ⛔ The PAIRING REQUIREMENT is enforced upstream in `resolveForApply`, which
   *  refuses an exe-without-addon release as `no-artifact` before any ledger
   *  entry exists. Here it is data: present → stage it; absent/null → swap the
   *  exe alone, which is correct for a genuinely sidecar-free release and is the
   *  shape every pre-item-4 caller and harness passes. A NEW caller that reaches
   *  `runApply` without going through `resolveForApply` owns that check itself. */
  libArtifact?: { url: string; sha256: string; sig: string } | null;
  /** D-152 § A.16 — the arch-neutral webclient bundle archive for this release,
   *  when the manifest carries one. Best-effort synced to RECUED_WEBCLIENT_DIR
   *  before the restart handoff (it touches no database, so it stays OUT of the
   *  drain rather than adding its download to the downtime) so the self-updated
   *  server serves a matched `/webclient/*`. Null/absent for a binaries-only
   *  release. */
  webclientArtifact?: { url: string; sha256: string; sig: string } | null;
  /** `auto` (housekeeping) defers when not quiesced; `manual` proceeds. */
  trigger: 'auto' | 'manual';
  /** The id to open this operation with, RESERVED by the caller.
   *
   *  ⛔ RESERVED, NOT REPORTED AFTERWARDS. The `apply_started` entry's id IS the
   *  receipt — `resolveUpdateOperationOutcome` looks the operation up by it — and
   *  it used to be minted in here, which meant a caller could only learn it by
   *  being handed the entry. The rpc answers `applying` and returns before any of
   *  this runs, so the one caller that most needs the receipt (one that will not
   *  be listening when the run ends) was the one that could not have it. A caller
   *  that supplies the id can hand it to its user at acceptance.
   *
   *  Absent → minted here, as before (the CLI and every harness). */
  operationId?: string;
  /** This manual apply is taking a release this install is NOT in the staged
   *  rollout cohort for.
   *
   *  ⛔ RECORDED BECAUSE THE SPEC CALLS THE BYPASS "an EXPLICIT, confirmed,
   *  AUDITED act" and only the first two were ever built. `trigger: 'manual'`
   *  alone cannot distinguish "took a release meant for them" from "jumped the
   *  queue", so the ledger could not answer afterwards which releases a fleet had
   *  actually opted into early. The CALLER supplies it — cohort membership lives
   *  in the resolution, not in the orchestrator.
   *
   *  ⚠ An `auto` apply can never set this: `auto_apply_eligible` already requires
   *  cohort membership, so an out-of-cohort automatic apply is a contradiction. */
  rolloutBypass?: {
    rolloutPct: number;
    /** The CALLER reported that it confirmed the bypass with a human.
     *
     *  ⚠ RECORDED AS AN ASSERTION, because that is all it can be — nothing on
     *  this side can prove a human was asked. Its ABSENCE is not "unconfirmed":
     *  every client older than the field confirms in its own UI and has no way
     *  to say so, so the detail line says nothing at all rather than accusing
     *  them. */
    clientConfirmed?: boolean;
  };
}

export interface ApplyOrchestratorPorts {
  ledger: UpdateLedger;
  /** Mirror every ledger transition outward (D-257).
   *
   *  ⛔ THE LEDGER IS THE PHASE SOURCE, so this hangs off the one place that
   *  writes it rather than a second enum kept in step by hand. `apply_started` /
   *  `apply_staged` / `apply_committed` / `rolled_back` already describe the run
   *  exactly, and a parallel progress vocabulary would drift the first time a
   *  phase was added here and not there.
   *
   *  Optional and BEST EFFORT: an apply must not fail because nobody was
   *  listening, so the caller wraps its own throw. */
  notifyLedger?: (entry: UpdateLedgerEntry) => void;
  bootFailureCounter: BootFailureCounter;
  /** Download the artifact to the staging path. */
  download: (url: string, destPath: string) => Promise<void>;
  /** Fail-closed artifact verification (binary-apply-executor.verifyArtifactFile). */
  verifyArtifact: (input: VerifyArtifactInput) => VerifyArtifactResult;
  /** Move the verified staged file into place, preserving recued.old.
   *
   *  `swapSidecar` says whether THIS apply staged a native addon too (i.e.
   *  `ctx.libArtifact` was present and its download+verify passed). It is
   *  explicit rather than inferred from the staged file's existence on disk: a
   *  leftover staged addon from an earlier aborted apply would otherwise be
   *  swapped in silently, pairing a fresh exe with a stale addon. */
  preserveAndSwap: (swapSidecar: boolean) => void;
  /** Swap recued.old back — including the preserved addon when one exists. */
  rollbackSwap: () => void;
  /** Best-effort staged-temp cleanup (binary AND staged addon). */
  discardStaged: () => void;
  /** D-178 thin launcher — persist the verified artifact's detached signature
   *  beside the STAGED binary so `preserveAndSwap` carries it into place and the
   *  `:managed` launcher can re-verify before exec (I-2 second verification).
   *  Optional: absent on harnesses / channels that don't need the sidecar (the
   *  binary self-update verifies at apply time regardless). */
  persistStagedSig?: (sig: string) => void;
  /** D-178 item 6 — the same, for the native addon. The thin launcher
   *  re-verifies BOTH before exec: a tampered `.node` is dlopen'd into the
   *  server's address space, so checking only the exe would leave the easier
   *  attack on a compromised volume entirely unguarded. */
  persistStagedLibSig?: (sig: string) => void;
  /** Take the pre-migration SQLite snapshot (mechanism c). */
  takeSnapshot: () => Promise<void>;
  /** Realm-scoped snapshot identity persisted on `apply_started`, so a sibling
   *  database sharing the ledger directory cannot mistake this apply for its own. */
  snapshotRef?: string;
  /** Durably bind the host generation and this realm's snapshot to the exact
   *  transition before the shared executable is swapped. */
  recordGenerationTransition?: (input: {
    fromVersion: string;
    toVersion: string;
    migration: boolean;
  }) => void;
  /** Restore the pre-migration snapshot over the live db. */
  restoreSnapshot: () => void;
  /** Existence predicates (recued.old / snapshot) for the rollback decision. */
  hasPreviousBinary: () => boolean;
  hasSnapshot: () => boolean;
  /** Live free bytes on the data volume (statfs probe). Returns null when the
   *  probe is unsupported (exotic filesystem) → the storage preflight gates OPEN,
   *  matching the archive subsystem's degrade. Absent (harness) → preflight
   *  skipped. Wired from `storage/disk-free.osFreeBytes` in release-config. */
  freeBytes?: () => number | null;
  /** Current SQLite file size in bytes — the pre-migration snapshot copies ~this
   *  much onto the SAME data volume, so it's added to the required headroom for a
   *  migrating apply. Absent → treated as 0 (non-migrating applies don't snapshot). */
  dbSizeBytes?: () => number;
  /** Free-space headroom (artifact download — the manifest declares no size — plus
   *  working slack) required ON TOP of the snapshot need. Defaults to
   *  `UPDATE_MIN_FREE_HEADROOM_BYTES`; overridable per-install via
   *  `RECUED_UPDATE_MIN_FREE_BYTES`. */
  minFreeHeadroomBytes?: number;
  /** Live free bytes on the ARTIFACT/staging volume (the download lands beside the
   *  binary, which on the `binary` channel may be a different filesystem than the
   *  data volume). null/absent → folded into the data-volume check. */
  artifactVolumeFreeBytes?: () => number | null;
  /** Whether the artifact/staging volume is the SAME filesystem as the data volume.
   *  Same (docker-thin / one-mount installs) → artifact + snapshot needs are summed
   *  against one pool; distinct → each need is checked on its own volume. Absent →
   *  treated as same (conservative: sum). */
  sameVolumeAsData?: () => boolean;
  /** True when no active runs + scheduler paused (I-5). */
  isQuiesced: () => boolean;
  /** Hand off to the supervisor for a restart (exit with the restart code). */
  /** Hand off to the supervisor. `onDrained` — when the wiring supports it —
   *  runs AFTER the restart drain has quiesced writers and closed the database,
   *  and before the process exits. That is the only window in a live server where
   *  the database FILE can be replaced safely, and it is how `performAutoRevert`
   *  restores a snapshot without a handle open. Mirrors the archive runtime's
   *  `requestRestart(onDrained)` (archive-runtime.ts), which does the same swap
   *  under the same precondition. */
  requestRestart: (onDrained?: (drainOk: boolean) => void | Promise<void>) => void;
  /** Take the cross-process update lease, or THROW if another live process holds
   *  it. Closes the check-then-append race between reading the ledger for an
   *  in-flight release and writing `apply_started` — `jsonl-ledger`'s append is a
   *  bare `appendFileSync` and claims nothing, so two processes could both pass
   *  and then write the same fixed `.staged` / `.old` paths.
   *
   *  Re-entrant within a process, so a CLI already holding it across resolve and
   *  download can call straight through here. Omitted → no exclusion (unit tests
   *  and old compositions), which is the pre-existing behaviour, not a new risk. */
  acquireUpdateLease?: (operation: string) => { release: () => void };
  /** Version reported by the executable currently occupying the shared live
   *  path. Several realms may keep older processes alive after another realm
   *  updates that path; the host-wide lease serializes writes but cannot make a
   *  stale process's `fromVersion` true. A wired probe therefore fails closed
   *  before either apply or rollback mutates `.old`. */
  installedVersion?: () => string | null;
  /** Does THIS process hold the realm database OPEN right now?
   *
   *  ⛔ It gates the ONE operation that is not handle-safe: replacing the db file
   *  for a `restore-snapshot` rollback. A binary swap is an atomic rename and is
   *  fine with handles open; overwriting the database is not — the live handle
   *  keeps serving the unlinked inode and accepts writes that then vanish.
   *  Fails CLOSED: an unwired port reads as "open", so a caller that forgets to
   *  answer gets the refusal, never the data loss. */
  holdsDatabaseOpen?: () => boolean;
  /** ⛔ Will that handoff actually bring the process back? `native` and `dev`
   *  exit and STAY DOWN. Absent → treated as un-supervised (fail closed): a
   *  harness that does not wire this must not be told an update is safe. */
  supervisorWillRespawn?: () => boolean;
  /** D-152 § A.16 — best-effort webclient bundle sync (download + verify +
   *  atomic extract to RECUED_WEBCLIENT_DIR). Optional: absent on the baked
   *  docker channel (bakes its own webclient), harnesses, or when no webclient
   *  dir resolves. Logs + swallows internally; NEVER blocks the binary apply. */
  /** Sync the version-matched webclient bundle and report the exact filesystem
   *  mutation it made. A boolean cannot describe first-install creation or a
   *  failed download that nevertheless parked the prior backup. */
  syncWebclient?: (
    artifact: { url: string; sha256: string; sig: string },
    identity: WebclientApplyIdentity,
  ) => Promise<WebclientSyncEffect>;
  /** Undo exactly the mutation reported by this apply's sync attempt. Returns
   * false when the durable journal still needs pre-open recovery. */
  undoWebclient?: (effect: WebclientSyncEffect, identity: WebclientApplyIdentity) => boolean;
  /** Boot-time recovery for a UI promotion that survived only as
   * `apply_started`. Returns false on a malformed/mismatched journal so the
   * ledger operation remains open for another recovery attempt. */
  recoverAbortedWebclient?: (identity: WebclientApplyIdentity) => boolean;
  /** Clear the promotion journal once a staged release commits or is physically
   * reverted. */
  clearWebclientApplyJournal?: () => void;
  /** Drop the generation parked behind `recued.old` by the swap.
   *
   *  ⛔ CALLED AT THE BOOT-TIME COMMIT, which is when the two-phase apply is
   *  finally over. Dropping it at the swap covered a failed SWAP and not a failed
   *  BOOT: in between, an auto-revert consumes `recued.old` and the parked
   *  generation is what puts a rollback target back. */
  dropApplyAside?: () => void;
  /** Remove the outer-supervisor revert journal after boot has repaired a lost
   *  terminal ledger append. Optional outside disk-backed compositions. */
  dropRevertJournal?: () => void;
  /** True only when the durable supervisor journal says its exact previous
   *  binary hash is now live. Version equality alone is insufficient: a
   *  launcher may merely fall back to `recued.old` without completing a swap. */
  revertJournalMatchesCurrent?: (releaseIdentity: string) => boolean;
  /** Journal an owner rollback before either its snapshot or binary is changed. */
  beginManualRollbackJournal?: (input: ManualRollbackJournalInput) => void;
  /** Advance the durable witness after each physical half commits. */
  markManualRollbackPhase?: (
    operationId: string,
    phase: Exclude<ManualRollbackPhase, 'prepared'>,
  ) => void;
  /** Inspect a journal left across process death. */
  inspectManualRollbackJournal?: () => ManualRollbackRecovery | null;
  /** Undo a prepared manual rollback after its write-ahead terminal could not be
   * made durable. Production restores the retained current database generation
   * before this function returns; optional only for storage-free test doubles. */
  abortManualRollbackJournal?: () => void;
  /** Remove it only after a terminal receipt is durable. */
  dropManualRollbackJournal?: () => void;
  newEntryId: () => string;
  now: () => number;
  /** The pinned, embedded trusted release pubkey. Empty → not-configured. */
  trustedPubkey: string;
  /** The staging path the download lands at + the artifact is verified at. */
  stagedPath: string;
  /** D-178 S1 rev 2 item 4 — the staging path for the native addon, beside its
   *  live location so the swap is a same-filesystem rename. Absent → this
   *  install has no managed sidecar and `ctx.libArtifact` is ignored. */
  stagedLibPath?: string;
}

export type ApplyResult =
  | { status: 'restarting'; operationId: string }
  | { status: 'deferred'; reason: string }
  | { status: 'busy' }
  | { status: 'not-configured' }
  | { status: 'insufficient-storage'; detail: string }
  | { status: 'download-failed'; detail: string }
  | { status: 'verify-failed'; detail: string }
  | { status: 'stage-failed'; detail: string };

export type RollbackResult =
  | {
      status: 'rolled-back';
      restored_snapshot: boolean;
      operationId: string;
      /** The rollback direction is durably committed in the ledger, but a
       * physical swap/phase write failed. Pre-open recovery will finish it before
       * the database is opened. */
      recovery_pending?: boolean;
    }
  | { status: 'refused'; reason: string }
  | { status: 'busy' };

export type BootDecision =
  | { action: 'commit'; releaseIdentity: string }
  | { action: 'auto-revert'; releaseIdentity: string; reason: string }
  | { action: 'revert-complete'; releaseIdentity: string }
  | { action: 'staging-aborted'; releaseIdentity: string }
  | { action: 'webclient-recovery-failed'; releaseIdentity: string; reason: string }
  | { action: 'continue' };

const TERMINAL_KINDS: ReadonlySet<UpdateLedgerKind> = new Set<UpdateLedgerKind>([
  'apply_committed',
  'apply_reverted',
  'rolled_back',
]);

export interface InFlightApply {
  /** The `apply_started` entry of the unterminated apply. */
  entry: UpdateLedgerEntry;
  /** Whether it reached `apply_staged` (the binary was actually swapped in). */
  staged: boolean;
}

/** The still-in-flight apply, or null. Tracks ALL unterminated `apply_started`
 *  entries (not just the most recent) so an older unresolved apply can't be
 *  masked by a later apply that started AND terminated — masking it would let a
 *  third apply proceed and clobber `recued.old`. Returns the most-recent
 *  unterminated one (which is what a fresh apply / boot must reconcile). */
const deriveInFlight = (ledger: UpdateLedger): InFlightApply | null => {
  const pending: InFlightApply[] = [];
  for (const e of ledger.readAll()) {
    if (e.kind === 'apply_started') {
      pending.push({ entry: e, staged: false });
    } else if (e.kind === 'apply_staged') {
      const m = pending.find((p) => p.entry.release_identity === e.release_identity);
      if (m) m.staged = true;
    } else if (TERMINAL_KINDS.has(e.kind)) {
      const idx = pending.findIndex((p) => p.entry.release_identity === e.release_identity);
      if (idx >= 0) pending.splice(idx, 1);
    }
  }
  return pending.length > 0 ? pending[pending.length - 1] : null;
};

/** The still-in-flight apply WITH its phase.
 *
 *  ⛔ EXPORTED BECAUSE `staged` IS THE WHOLE DISTINCTION FOR A STOPPED SERVER.
 *  "In flight" means two different things: to a RUNNING server it means an apply
 *  is executing in this process — refuse. To the CLI, which has already proved no
 *  server holds the realm, an unterminated entry that reached `apply_staged`
 *  means the binary was swapped in and the process exited awaiting a first boot
 *  that never went healthy. Nothing is running; that state is RECOVERABLE, and
 *  on an unsupervised install the CLI is the only thing that can recover it. */
export const deriveInFlightApply = (ledger: UpdateLedger): InFlightApply | null =>
  deriveInFlight(ledger);

/** The release id of the still-in-flight apply, or null (the host-wide lock). */
export const deriveInFlightRelease = (ledger: UpdateLedger): string | null =>
  deriveInFlight(ledger)?.entry.release_identity ?? null;

/** The `apply_started` entry of the still-in-flight apply (carries the staged
 *  release's versions + `migration` flag), or null. The on-boot auto-revert
 *  path reads it to drive the snapshot-restore decision + the terminal entry. */
export const deriveInFlightEntry = (ledger: UpdateLedger): UpdateLedgerEntry | null =>
  deriveInFlight(ledger)?.entry ?? null;

export type UpdateOperationOutcome =
  | { status: 'unknown' }
  | {
      status:
        | 'waiting_for_restart'
        | 'completed'
        | 'reverted'
        | 'closed_unresolved';
      operation: 'update' | 'rollback';
    };

export type UpdateOperationClosureOutcome =
  | UpdateOperationOutcome
  | {
      status: 'refused';
      reason: 'operation_in_flight';
    };

const receiptOperationEntry = (
  entries: readonly UpdateLedgerEntry[],
  operationId: string,
): { entry: UpdateLedgerEntry; index: number } | null => {
  const index = entries.findIndex((entry) => entry.id === operationId);
  return index < 0 ? null : { entry: entries[index]!, index };
};

const reservationFor = (
  entries: readonly UpdateLedgerEntry[],
  operationId: string,
): UpdateLedgerEntry | null => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (
      entry.kind === 'operation_reserved'
      && entry.reserved_operation_id === operationId
    ) return entry;
  }
  return null;
};

// Liveness witness for reservations created by this exact process. A PID in
// the durable row is useful forensic data but is not a process identity: the OS
// can reuse it after a crash. Boot recovery therefore protects only receipts
// present in this in-memory set; a same-numbered predecessor is still settled.
const currentProcessReservations = new Set<string>();

/** Put the caller's receipt in the append-only ledger before manifest
 * resolution performs its first await. The reservation is not an apply lock and
 * cannot authorize a swap; it only makes `update.operation_status` answerable. */
export const reserveUpdateOperationReceipt = (
  ports: ApplyOrchestratorPorts,
  operationId: string,
  operation: 'update' | 'rollback',
  currentVersion: string,
  channel: 'stable' | 'edge',
  ownerPid: number = process.pid,
): void => {
  const entries = ports.ledger.readAll();
  if (
    receiptOperationEntry(entries, operationId) !== null
    || reservationFor(entries, operationId) !== null
  ) throw new Error('operation receipt is already in use');
  ports.ledger.append({
    id: `reservation:${operationId}`,
    kind: 'operation_reserved',
    at: ports.now(),
    from_version: currentVersion,
    to_version: currentVersion,
    channel,
    trigger: 'manual',
    release_identity: `${channel}:${currentVersion}`,
    reserved_operation_id: operationId,
    reserved_operation: operation,
    reservation_process_id: ownerPid,
  });
  currentProcessReservations.add(operationId);
};

/** Settle a reservation only when no real operation row took ownership of the
 * receipt. This is intentionally idempotent: normal RPC refusals and boot-time
 * abandoned-reservation recovery may race to describe the same end state. */
export const refuseReservedUpdateOperation = (
  ports: ApplyOrchestratorPorts,
  operationId: string,
  detail: string,
): boolean => {
  const entries = ports.ledger.readAll();
  if (receiptOperationEntry(entries, operationId) !== null) {
    currentProcessReservations.delete(operationId);
    return false;
  }
  if (entries.some((entry) =>
    entry.kind === 'operation_refused'
    && entry.reserved_operation_id === operationId)) {
    currentProcessReservations.delete(operationId);
    return false;
  }
  const reservation = reservationFor(entries, operationId);
  if (!reservation) {
    currentProcessReservations.delete(operationId);
    return false;
  }
  ports.ledger.append({
    ...reservation,
    id: `refused:${operationId}`,
    kind: 'operation_refused',
    at: ports.now(),
    detail,
  });
  currentProcessReservations.delete(operationId);
  return true;
};

/** Close reservations left by a predecessor process. A reservation owned by
 * this PID may be inside `resolveForApply` right now and is never touched. */
export const reconcileAbandonedUpdateReservations = (
  ports: ApplyOrchestratorPorts,
  currentPid: number = process.pid,
): number => {
  const entries = ports.ledger.readAll();
  const receipts = new Set(
    entries
      .filter((entry) =>
        entry.kind === 'operation_reserved'
        && (
          entry.reservation_process_id !== currentPid
          || !currentProcessReservations.has(entry.reserved_operation_id ?? '')
        ))
      .map((entry) => entry.reserved_operation_id)
      .filter((value): value is string => typeof value === 'string' && value.length > 0),
  );
  let settled = 0;
  for (const receipt of receipts) {
    if (refuseReservedUpdateOperation(
      ports,
      receipt,
      'the server restarted before this reserved update reached apply_started',
    )) settled += 1;
  }
  return settled;
};

/** Resolve one server-issued ledger receipt without exposing its release,
 * versions, timestamps, or diagnostic detail. Apply receipts are the
 * `apply_started` row and settle at their first terminal row. Rollback receipts
 * are written before the restart, so the running version must independently
 * prove that the restored binary actually booted. */
export const resolveUpdateOperationOutcome = (
  ledger: UpdateLedger,
  operationId: string,
  currentVersion: string,
): UpdateOperationOutcome => {
  const entries = ledger.readAll();
  const found = receiptOperationEntry(entries, operationId);
  const operationIndex = found?.index ?? -1;
  const operation = found?.entry ?? null;

  if (operation?.kind === 'rolled_back') {
    return {
      status: currentVersion === operation.from_version
        ? 'completed'
        : 'waiting_for_restart',
      operation: 'rollback',
    };
  }
  if (operation?.kind === 'apply_started') {
    for (let index = operationIndex + 1; index < entries.length; index += 1) {
      const candidate = entries[index]!;
      if (candidate.release_identity !== operation.release_identity) continue;
      if (candidate.kind === 'apply_committed') {
        return { status: 'completed', operation: 'update' };
      }
      if (
        candidate.kind === 'apply_reverted'
        || candidate.kind === 'rolled_back'
      ) {
        return { status: 'reverted', operation: 'update' };
      }
    }
    // A healthy target boot can be serving during the narrow interval before
    // its commit row is appended. Its build-stamped version is still
    // server-authoritative proof of the exact staged target.
    return {
      status: currentVersion === operation.to_version
        ? 'completed'
        : 'waiting_for_restart',
      operation: 'update',
    };
  }
  if (operation?.kind === 'operation_refused') {
    return {
      status: 'reverted',
      operation: operation.reserved_operation === 'rollback' ? 'rollback' : 'update',
    };
  }

  const reservation = reservationFor(entries, operationId);
  if (reservation) {
    const refused = entries.some((entry) =>
      entry.kind === 'operation_refused'
      && entry.reserved_operation_id === operationId);
    return {
      status: refused ? 'reverted' : 'waiting_for_restart',
      operation: reservation.reserved_operation === 'rollback' ? 'rollback' : 'update',
    };
  }

  // A closure is considered only when no real operation row can resolve the
  // receipt. Scan newest-first so a future format can supersede an older
  // closure without mutating this append-only ledger.
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const candidate = entries[index]!;
    if (
      candidate.kind === 'operation_closed'
      && candidate.closed_operation_id === operationId
      && (
        candidate.closed_operation === 'update'
        || candidate.closed_operation === 'rollback'
      )
    ) {
      return {
        status: 'closed_unresolved',
        operation: candidate.closed_operation,
      };
    }
  }
  return { status: 'unknown' };
};

/** Durably retire an unknown receipt without claiming its outcome. The exact
 * receipt is re-resolved synchronously before append, and an unrelated
 * in-flight release transition refuses closure. The append-only marker makes
 * the decision survive reloads, reconnects, tabs, and database restores. */
export const closeUnresolvedUpdateOperation = (
  ports: ApplyOrchestratorPorts,
  operationId: string,
  expectedOperation: 'update' | 'rollback',
  currentVersion: string,
  channel: 'stable' | 'edge',
): UpdateOperationClosureOutcome => {
  const resolved = resolveUpdateOperationOutcome(
    ports.ledger,
    operationId,
    currentVersion,
  );
  if (resolved.status !== 'unknown') return resolved;
  if (deriveInFlightRelease(ports.ledger) !== null) {
    return { status: 'refused', reason: 'operation_in_flight' };
  }
  ports.ledger.append({
    id: ports.newEntryId(),
    kind: 'operation_closed',
    at: ports.now(),
    from_version: currentVersion,
    to_version: currentVersion,
    channel,
    trigger: 'manual',
    release_identity: `${channel}:${currentVersion}`,
    closed_operation_id: operationId,
    closed_operation: expectedOperation,
    detail: 'owner closed an unresolved operation receipt without asserting its outcome',
  });
  return {
    status: 'closed_unresolved',
    operation: expectedOperation,
  };
};

/** The CURRENTLY-applied release, derived from the last `apply_committed` entry
 *  — the rollback context for `update.rollback`. `from_version` is the version
 *  the rollback would restore (what `recued.old` holds); `migration` flags
 *  whether the committed apply migrated the schema (the snapshot-restore guard).
 *  Returns null when no apply has ever committed (a fresh install has nothing to
 *  roll back to). */
export const deriveCommittedRelease = (ledger: UpdateLedger): RollbackContext | null => {
  let committed: UpdateLedgerEntry | null = null;
  for (const e of ledger.readAll()) {
    if (e.kind === 'apply_committed') committed = e;
    // A later rollback of that same release retires it as the rollback target
    // (you can't roll back twice past the same `recued.old`).
    else if (e.kind === 'rolled_back' && committed && e.release_identity === committed.release_identity) {
      committed = null;
    }
  }
  if (!committed) return null;
  return {
    releaseIdentity: committed.release_identity,
    fromVersion: committed.from_version,
    toVersion: committed.to_version,
    channel: committed.channel,
    appliedMigration: committed.migration ?? false,
  };
};

const appendEntry = (
  ports: ApplyOrchestratorPorts,
  kind: UpdateLedgerKind,
  ctx: Pick<ApplyContext, 'releaseIdentity' | 'fromVersion' | 'toVersion' | 'channel' | 'migration'>,
  extra: Partial<UpdateLedgerEntry> = {},
): UpdateLedgerEntry => {
  const entry: UpdateLedgerEntry = {
    id: ports.newEntryId(),
    kind,
    at: ports.now(),
    from_version: ctx.fromVersion,
    to_version: ctx.toVersion,
    channel: ctx.channel,
    trigger: extra.trigger ?? 'auto',
    release_identity: ctx.releaseIdentity,
    migration: ctx.migration,
    ...extra,
  };
  ports.ledger.append(entry);
  // Best effort by contract — see `notifyLedger`. A broadcast that throws must
  // not abort an apply that has already changed the disk.
  try { ports.notifyLedger?.(entry); } catch { /* nobody listening is not a failure */ }
  return entry;
};

/** Default free-space headroom for a self-update: covers the streamed artifact
 *  download (the signed manifest declares no artifact byte size) + working slack,
 *  ADDED to the pre-migration snapshot's ~db-file-size need for a migrating apply.
 *  Overridable per-install via the `minFreeHeadroomBytes` port (wired from
 *  `RECUED_UPDATE_MIN_FREE_BYTES`). 256 MiB comfortably covers the static binary
 *  on the small VPS targets without wedging updates on a tight box. */
export const UPDATE_MIN_FREE_HEADROOM_BYTES = 256 * 1024 * 1024;

const mib = (bytes: number): string => `${Math.ceil(bytes / (1024 * 1024))} MiB`;

/** Fail-closed storage preflight (spec § Update machinery): refuse a self-update
 *  UP FRONT when the data volume can't fit the artifact download + (for a
 *  migrating release) the pre-migration SQLite snapshot — both land on the same
 *  volume, and co-locating the binary there concentrates the pressure. A clean
 *  refusal beats an ENOSPC halfway through the download or the keyed
 *  `VACUUM INTO` snapshot.
 *  Gates OPEN when the probe is unwired / unsupported (null) so an exotic
 *  filesystem can't wedge updates — the natural-ENOSPC fail-closed catches in
 *  `runApply` still protect the apply if the estimate is wrong. Mirrors the
 *  archive subsystem's statfs preflight (`archive-handler` / `archive-runtime`). */
const checkStorageHeadroom = (
  ports: ApplyOrchestratorPorts,
  migration: boolean,
): { ok: true } | { ok: false; detail: string } => {
  const dataFree = ports.freeBytes?.();
  // Primary (data-volume) probe unavailable / unwired → gate OPEN: an unprobe-able
  // filesystem must never wedge updates (the natural-ENOSPC catches in runApply
  // still fail safe). Same degrade as the archive subsystem.
  if (dataFree === undefined || dataFree === null) return { ok: true };
  const headroom = ports.minFreeHeadroomBytes ?? UPDATE_MIN_FREE_HEADROOM_BYTES;
  const snapshotNeed = migration ? (ports.dbSizeBytes?.() ?? 0) : 0;
  const artifactFree = ports.artifactVolumeFreeBytes?.();
  const distinctVolumes =
    artifactFree !== undefined && artifactFree !== null && ports.sameVolumeAsData?.() === false;
  if (distinctVolumes) {
    // The artifact downloads to a DIFFERENT filesystem than the snapshot — check
    // each need against the volume that actually bears it.
    if (artifactFree < headroom) {
      return { ok: false, detail: `binary volume has ${mib(artifactFree)} free; the update artifact needs ~${mib(headroom)}` };
    }
    if (dataFree < snapshotNeed) {
      return { ok: false, detail: `data volume has ${mib(dataFree)} free; the pre-migration snapshot needs ~${mib(snapshotNeed)}` };
    }
    return { ok: true };
  }
  // One pool (same volume, or the artifact volume is unprobe-able) — require the
  // combined artifact + snapshot need against the data volume.
  const need = headroom + snapshotNeed;
  if (dataFree < need) {
    return {
      ok: false,
      detail:
        `data volume has ${mib(dataFree)} free; this ${migration ? 'migrating ' : ''}update needs ~${mib(need)} ` +
        `(artifact + ${migration ? `pre-migration snapshot ${mib(snapshotNeed)} + ` : ''}headroom ${mib(headroom)})`,
    };
  }
  return { ok: true };
};

/** Download → verify → request restart, with the snapshot + swap handed to the
 *  restart's post-drain callback (the only window in a live server where writers
 *  have stopped, so the pre-migration snapshot is not missing everything written
 *  after it). The `commit` half happens on the next boot
 *  (`evaluatePendingApplyOnBoot`). Idempotent against the ledger-derived lock:
 *  a second concurrent apply (any release) is refused while one is in flight.
 *
 *  ⚠ `restarting` IS THE ACCEPTANCE, NOT THE COMMIT. The callback runs after this
 *  resolves; its ledger terminal is what says whether the release was staged, and
 *  `resolveUpdateOperationOutcome` reads it back as `reverted` for a receipt
 *  checked after the reconnect. The CLI, which has a person reading stdout,
 *  waits for the callback instead (`cli-context/update.ts`). */
export const runApply = async (ports: ApplyOrchestratorPorts, ctx: ApplyContext): Promise<ApplyResult> => {
  if (!ports.trustedPubkey) return { status: 'not-configured' };
  // ⛔ THE LEASE COMES BEFORE THE LEDGER READ. The in-flight check below and the
  // `apply_started` append further down are two separate operations on a file
  // that claims nothing, so without exclusion two processes both pass the check
  // and both proceed onto the same `.staged` / `.old` paths. Taking the lease
  // first is what makes the pair indivisible.
  let lease: { release: () => void } | null = null;
  try {
    lease = ports.acquireUpdateLease?.('apply') ?? null;
  } catch {
    // Another live process is already updating this install.
    return { status: 'busy' };
  }
  // ⛔⛔⛔ THE SWAP NOW HAPPENS AFTER THIS FUNCTION RETURNS, SO THE LEASE HAS TO
  // OUTLIVE IT. Moving the snapshot + swap into the restart drain put the only
  // step that writes the binary OUTSIDE the scope that excludes other writers:
  // this returned `restarting`, the `finally` released, and the commit ran
  // seconds later holding nothing. The ledger still refused another APPLY (the
  // in-flight entry), but `install.sh` reads the lease and not the ledger — so an
  // installer run in that gap could rename over the same files mid-swap, which is
  // the pair-from-two-releases outcome the lease exists to prevent.
  //
  // ⇒ Ownership is HANDED to the commit when one is scheduled, and released when
  // it finishes. A wiring that never runs the callback leaks the file until the
  // process exits — at which point a dead holder reclaims — and every wiring is
  // pinned to run it (`update-commit-in-drain.test.ts`).
  let leaseHeldByCommit = false;
  const claimLeaseForCommit = (): (() => void) => {
    leaseHeldByCommit = true;
    return () => lease?.release();
  };
  try {
    return await runApplyLeased(ports, ctx, claimLeaseForCommit);
  } finally {
    // Every path that did NOT schedule a commit releases here: a refusal, a
    // failed download, a failed verify. The scheduled ones release when the
    // commit ends, because that is where the disk work moved to.
    //
    // ⛔ NOT `return` INSIDE A `finally`, WHICH IS WHY THIS IS AN `if` AROUND THE
    // RELEASE RATHER THAN AN EARLY EXIT. A bare `return` there DISCARDS the value
    // the `try` was returning — the compiler caught it, and it would have turned
    // every accepted apply into `undefined` at the rpc.
    if (!leaseHeldByCommit) lease?.release();
  }
};

const runApplyLeased = async (
  ports: ApplyOrchestratorPorts,
  ctx: ApplyContext,
  /** Hand the update lease to the deferred commit — see `runApply`. */
  claimLeaseForCommit: () => () => void,
): Promise<ApplyResult> => {
  if (deriveInFlightRelease(ports.ledger) !== null) return { status: 'busy' };
  if (ports.installedVersion) {
    let installed: string | null = null;
    try { installed = ports.installedVersion(); } catch { /* handled below */ }
    if (installed !== ctx.fromVersion) {
      return {
        status: 'deferred',
        reason: installed === null
          ? 'the executable currently installed on this host could not be identified; restart or repair the install before applying'
          : `the shared executable is already ${installed}, while this realm is still running ${ctx.fromVersion}; restart this realm before applying`,
      };
    }
  }
  // I-5: auto-apply only from quiesce; manual proceeds (caller forces quiesce).
  if (ctx.trigger === 'auto' && !ports.isQuiesced()) {
    return { status: 'deferred', reason: 'waiting for idle (no active runs, scheduler paused)' };
  }
  // ⛔⛔ REFUSE AN APPLY NOTHING WOULD RESTART. Apply ends by exiting for the
  // supervisor to respawn us; under `native` or `dev` there is no supervisor, so
  // the server stages the binary, exits, and stays down. Reported on macOS
  // 2026-08-31: Settings → Updates sat on "Waiting for server…" forever while
  // Account → Servers said "can't reach your server". The update itself was fine
  // — it commits on the next healthy boot — but nothing was going to boot.
  //
  // 🔑 D-188 ALREADY DECIDED THIS for the Restart button, which is the same
  // handoff: "gated on the supervisor because an un-supervised restart just exits
  // the process and stays down — a footgun." Apply was never gated.
  //
  // ⚠ Refused BEFORE the ledger entry and BEFORE the ~144 MB download, so it
  // costs nothing and leaves no in-flight lock to release. `deferred` rather than
  // a new status: it already means "a before-restart refusal that left the install
  // untouched" and older webclients render it today — a new union member would
  // reach clients that cannot name it.
  if (ports.supervisorWillRespawn?.() !== true) {
    return {
      status: 'deferred',
      reason:
        'this server is not supervised, so it would not come back from the restart '
        + 'the update ends with — run it under a respawning supervisor, or stop it and '
        + 'use `recued update apply`',
    };
  }
  // Storage preflight — refuse BEFORE touching the ledger (no in-flight entry to
  // release) when the data volume can't fit the artifact + (if migrating) the
  // snapshot. A clean up-front refusal beats an ENOSPC mid-download / mid-backup.
  const storage = checkStorageHeadroom(ports, ctx.migration);
  if (!storage.ok) return { status: 'insufficient-storage', detail: storage.detail };

  const operation = appendEntry(
    ports,
    'apply_started',
    ctx,
    {
      ...(ctx.operationId === undefined ? {} : { id: ctx.operationId }),
      trigger: ctx.trigger,
      ...(ports.snapshotRef === undefined ? {} : { snapshot_ref: ports.snapshotRef }),
      // The audited half of the staged-rollout bypass. Written on the entry that
      // OPENS the operation, so the record exists even if the apply then fails.
      ...(ctx.rolloutBypass !== undefined
        ? {
            detail:
              `staged-rollout bypass: install is outside the ${ctx.rolloutBypass.rolloutPct}% cohort`
              + (ctx.rolloutBypass.clientConfirmed === true ? ' (confirmed by the client)' : ''),
          }
        : {}),
    },
  );

  try {
    await ports.download(ctx.artifact.url, ports.stagedPath);
  } catch (err) {
    ports.discardStaged();
    const detail = err instanceof Error ? err.message : 'download error';
    appendEntry(ports, 'apply_reverted', ctx, { trigger: ctx.trigger, detail: `download: ${detail}` });
    return { status: 'download-failed', detail };
  }

  const v = ports.verifyArtifact({
    filePath: ports.stagedPath,
    sha256: ctx.artifact.sha256,
    sig: ctx.artifact.sig,
    trustedPubkey: ports.trustedPubkey,
  });
  if (!v.ok) {
    ports.discardStaged();
    appendEntry(ports, 'apply_reverted', ctx, { trigger: ctx.trigger, detail: `verify: ${v.reason}` });
    return { status: 'verify-failed', detail: v.reason };
  }

  // Persist the verified signature beside the staged binary (best-effort) so
  // `preserveAndSwap` carries it into place for the thin launcher's re-verify.
  // After verify (the bytes are trusted), before the swap.
  try {
    ports.persistStagedSig?.(ctx.artifact.sig);
  } catch {
    /* best-effort — the binary self-update path verified at apply time already */
  }

  // D-178 S1 rev 2 item 4 — stage the native addon through the SAME gate as the
  // exe. Not best-effort and not a lesser artifact: it is loaded into the
  // server's own address space at the first database open, so an unverified one
  // is arbitrary code execution with the binary's full privileges. It gets its
  // own signature check against the same pinned key.
  //
  // Downloaded AFTER the exe so the cheap failure (a missing/renamed URL) is hit
  // before we have committed anything, and BEFORE the snapshot + swap so a
  // failure here still costs nothing but a discarded temp file.
  const swapSidecar = Boolean(ctx.libArtifact && ports.stagedLibPath);
  if (ctx.libArtifact && ports.stagedLibPath) {
    try {
      await ports.download(ctx.libArtifact.url, ports.stagedLibPath);
    } catch (err) {
      ports.discardStaged();
      const detail = err instanceof Error ? err.message : 'download error';
      appendEntry(ports, 'apply_reverted', ctx, { trigger: ctx.trigger, detail: `download (native addon): ${detail}` });
      return { status: 'download-failed', detail: `native addon: ${detail}` };
    }
    const lv = ports.verifyArtifact({
      filePath: ports.stagedLibPath,
      sha256: ctx.libArtifact.sha256,
      sig: ctx.libArtifact.sig,
      trustedPubkey: ports.trustedPubkey,
    });
    if (!lv.ok) {
      ports.discardStaged();
      appendEntry(ports, 'apply_reverted', ctx, { trigger: ctx.trigger, detail: `verify (native addon): ${lv.reason}` });
      return { status: 'verify-failed', detail: `native addon: ${lv.reason}` };
    }
    // Persist the addon's verified signature beside it so `preserveAndSwap`
    // carries it onto the volume for the launcher's re-verify. After verify
    // (the bytes are trusted), before the swap — same rule as the exe's.
    try {
      ports.persistStagedLibSig?.(ctx.libArtifact.sig);
    } catch {
      /* best-effort — the apply-time verify above already gated these bytes */
    }
  }

  // D-152 § A.16 — best-effort: sync the version-matched webclient bundle to
  // RECUED_WEBCLIENT_DIR so the self-updated server serves a matched
  // `/webclient/*`. A webclient failure leaves the live bundle in place (the
  // D-152 loader re-verifies on boot), so this must NEVER block the binary path.
  //
  // ⚠ IT STAYS OUT HERE, WHILE THE SERVER IS STILL SERVING, AND THAT IS A
  // DELIBERATE TRADE. It is a ~30 MB download with a 60 s timeout and it touches
  // no database, so moving it inside the drain would add its whole duration to
  // the DOWNTIME. Its exact disk effect is carried into the commit callback so
  // every ordinary abort below can restore the prior bundle state precisely.
  //
  // ⛔⛔ AND WHETHER IT ACTUALLY PROMOTED IS RECORDED, because every pre-commit
  // failure below now has to undo it. The comment above used to close by calling
  // the resulting pairing "cosmetic": a new UI in front of a restored old server.
  // It is not. `min_supported` exists precisely because that direction breaks —
  // the release config records that a server predating 26.8.12 does not read the
  // WS bearer from the subprotocol the current client sends, and 401s the
  // handshake, so "the webclient cannot talk to it at all". Old-client-on-new-
  // server is the safe direction; this is the other one.
  //
  // ⚠ TRACKED, NOT INFERRED FROM `<dir>.old` EXISTING. That backup survives a
  // SUCCESSFUL apply until the next sync clears it, so an apply that never synced
  // would find one and "restore" the generation before the running server's UI.
  let webclientEffect: WebclientSyncEffect = 'none';
  const webclientIdentity: WebclientApplyIdentity = {
    releaseIdentity: ctx.releaseIdentity,
    operationId: operation.id,
  };
  if (ctx.webclientArtifact && ports.syncWebclient) {
    try {
      webclientEffect = await ports.syncWebclient(ctx.webclientArtifact, webclientIdentity);
    } catch {
      /* best-effort — the port logs internally; the binary update is unaffected */
    }
  }
  /** Undo the bundle promotion. Every abort below reaches this; a commit does
   * not. A failed undo does not keep the apply lock open: its terminal carries a
   * durable recovery bit and the journal retains the exact filesystem effect. */
  const unpromoteWebclient = (): boolean => {
    if (webclientEffect === 'none') return true;
    try {
      const restored = ports.undoWebclient?.(webclientEffect, webclientIdentity) === true;
      if (restored) webclientEffect = 'none';
      return restored;
    } catch {
      return false;
    }
  };

  // ⛔⛔⛔ THE SNAPSHOT + SWAP HAPPEN INSIDE THE RESTART DRAIN, NOT HERE. They used
  // to run right here, minutes before `requestRestart` — and the server went on
  // SERVING across that whole gap. So every write the old release accepted
  // between the snapshot and the drain was absent from the snapshot, and a later
  // rollback silently discarded them. `decideRollback` tells the owner it is
  // losing "post-update writes since the migration"; what it actually took was
  // PRE-migration writes their own, still-current release had already committed.
  //
  // 🔑 THE QUIESCE CHECK IS NOT A FENCE AND WAS NEVER GOING TO BE ONE. `isQuiesced`
  // is sampled once, and only for `auto` triggers — a manual apply skips it
  // entirely (the caller forces quiesce). Even for `auto` it is a glance, not an
  // admission barrier: `compose-lifecycle` says the drain's `await_inflight` step
  // exists precisely "closing the check→restart admission window the apply-path
  // quiesce check left open". Only the drain actually stops writers.
  //
  // ⇒ So the commit moves to the one moment that is quiet by construction: after
  // the drain has stopped admissions, awaited in-flight runs and CLOSED the
  // database. That is the same window `performAutoRevert` and the archive
  // runtime's staged-restore commit already use, reached through the same
  // `requestRestart(onDrained)` port, which has always taken this callback.
  const commitStagedRelease = async (drainOk: boolean): Promise<void> => {
   try {
    // ⛔ NOT QUIESCED MEANS A WRITER MAY STILL HOLD THE DATABASE. Change nothing:
    // the staged binary is discarded and the operation is terminated as failed,
    // so the install is left exactly as it was rather than swapping in a release
    // whose snapshot we could not take.
    //
    // ⚠ THE TWO CALLERS FAIL THIS FOR DIFFERENT REASONS AND THE WORDING COVERS
    // BOTH: a live server's restart drain did not complete, or the CLI found a
    // server that had started on the realm while the artifact was downloading.
    // Each says which on its own surface; the ledger records the fact.
    if (!drainOk) {
      ports.discardStaged();
      const webclientRecovered = unpromoteWebclient();
      appendEntry(ports, 'apply_reverted', ctx, {
        trigger: ctx.trigger,
        detail: 'stage: the realm was not quiesced at commit time, so the database may still be '
          + 'open — nothing was swapped'
          + (webclientRecovered ? '' : '; webclient recovery remains pending before the next serve'),
        ...(!webclientRecovered ? { webclient_recovery_pending: true } : {}),
      });
      return;
    }
    // A failure here must RELEASE the lock (append a terminal) — otherwise the
    // `apply_started` above wedges every future apply. The pre-migration snapshot
    // goes BEFORE the swap so a later rollback can restore it (mechanism c), and
    // so a failed snapshot leaves the binary untouched.
    try {
      if (ctx.migration) {
        await ports.takeSnapshot();
        appendEntry(ports, 'snapshot_taken', ctx, { trigger: ctx.trigger });
      }
      ports.recordGenerationTransition?.({
        fromVersion: ctx.fromVersion,
        toVersion: ctx.toVersion,
        migration: ctx.migration,
      });
      ports.preserveAndSwap(swapSidecar);
    } catch (err) {
      ports.discardStaged();
      const webclientRecovered = unpromoteWebclient();
      const detail = err instanceof Error ? err.message : 'stage error';
      appendEntry(ports, 'apply_reverted', ctx, {
        trigger: ctx.trigger,
        detail: `stage: ${detail}`
          + (webclientRecovered ? '' : '; webclient recovery remains pending before the next serve'),
        ...(!webclientRecovered ? { webclient_recovery_pending: true } : {}),
      });
      return;
    }
    appendEntry(ports, 'apply_staged', ctx, { trigger: ctx.trigger });
   } catch (err) {
    // ⛔ NEVER REJECT INTO THE DRAIN. `compose-lifecycle` awaits this callback
    // and routes a rejection to `exit(1)` rather than the restart handoff — so
    // the one thing left unguarded above, a failing LEDGER WRITE, would cost the
    // RESTART itself and not merely the record of it. The disk work has its own
    // handling; this is the outer promise that must not take the handoff down.
    // A ledger entry that could not be written is reconciled on the next boot,
    // which reads the DISK first for exactly this reason.
    console.error('[update] the apply commit failed inside the restart drain', err);
   }
  };

  // ⛔ THE OUTCOME IS THE LEDGER, NOT THIS RETURN VALUE. D-257 already made the
  // apply asynchronous — the rpc answers `applying` and the real status rides
  // `update.progress`, which mirrors exactly the entries the commit appends. So
  // `restarting` here means "accepted, and the restart will commit it", and a
  // commit that fails is reported the same way every other post-return failure
  // already is. The one caller that needs the commit to have HAPPENED before it
  // returns is the CLI, which is why its `requestRestart` runs the callback
  // inline and waits for it (`cli-context/update.ts`).
  const releaseLeaseAfterCommit = claimLeaseForCommit();
  ports.requestRestart(async (drainOk) => {
    try {
      await commitStagedRelease(drainOk);
    } finally {
      releaseLeaseAfterCommit();
    }
  });
  return { status: 'restarting', operationId: operation.id };
};

export interface RollbackContext {
  releaseIdentity: string;
  fromVersion: string;
  toVersion: string;
  channel: 'stable' | 'edge';
  /** The CURRENTLY-applied release migrated the schema (drives the guard). */
  appliedMigration: boolean;
  /** Caller-reserved receipt. Absent for CLI and legacy callers. */
  operationId?: string;
}

/** Roll back the current release (owner action — never consults the manifest,
 *  I-10). Refused while an apply is in flight (I-6) and per `decideRollback`. */
export const runRollback = (ports: ApplyOrchestratorPorts, ctx: RollbackContext): RollbackResult => {
  // ⛔ THE LEASE COMES FIRST, BEFORE THE LEDGER READ. This used to check the
  // ledger and only then acquire, and never re-read afterwards — so an
  // `apply_started` written by another process DURING the acquisition was
  // invisible and the rollback proceeded anyway. Demonstrated by inserting that
  // entry mid-acquire: the rollback still returned `rolled-back`. Ordering it
  // this way makes the read and the decision one indivisible step, which is the
  // same reason `runApply` acquires before its own check.
  let lease: { release: () => void } | null = null;
  try {
    lease = ports.acquireUpdateLease?.('rollback') ?? null;
  } catch {
    return { status: 'busy' };
  }
  try {
    return runRollbackLeased(ports, ctx);
  } finally {
    lease?.release();
  }
};

const runRollbackLeased = (ports: ApplyOrchestratorPorts, ctx: RollbackContext): RollbackResult => {
  // Read under the lease, so nothing can appear between here and the decision.
  if (deriveInFlightRelease(ports.ledger) !== null) return { status: 'busy' };
  if (ports.installedVersion) {
    let installed: string | null = null;
    try { installed = ports.installedVersion(); } catch { /* handled below */ }
    if (installed !== ctx.toVersion) {
      return {
        status: 'refused',
        reason: installed === null
          ? 'the executable currently installed on this host could not be identified; restart or repair the install before rolling back'
          : `the shared executable is ${installed}, while this realm's rollback record expects ${ctx.toVersion}; restart this realm before rolling back`,
      };
    }
  }
  // ⛔ A ROLLBACK ENDS IN A RESTART TOO. `runApply` refuses when nothing would
  // bring the server back; rollback had no such gate, so an unsupervised server
  // could roll back, exit, and stay down — the same failure, reached by the
  // button an owner presses precisely BECAUSE something is already wrong.
  if (ports.supervisorWillRespawn?.() !== true) {
    return {
      status: 'refused',
      reason:
        'this server is not supervised, so it would not come back from the restart a rollback '
        + 'ends with — run it under a respawning supervisor, or stop it and use '
        + '`recued update rollback`',
    };
  }
  const decision = decideRollback({
    appliedMigration: ctx.appliedMigration,
    hasPreviousBinary: ports.hasPreviousBinary(),
    hasSnapshot: ports.hasSnapshot(),
  });
  if (decision.action === 'refuse') return { status: 'refused', reason: decision.reason };

  // Restore the DB snapshot FIRST (the copy is the failure-prone step — disk
  // space / IO); if it throws, the binary is untouched so we stay on a
  // CONSISTENT current state rather than leaving an old binary on a migrated
  // DB. The binary swap (atomic rename) goes last.
  //
  // ⛔⛔⛔ KNOWN DEFECT, NOT YET FIXED (audit finding 1, 2026-08-31).
  // `restoreSnapshot` unlinks the -wal/-shm sidecars and renames a file over
  // `dbPath` — and EVERY caller holds that database OPEN: the `update.rollback`
  // rpc runs inside the live server, the CLI opens the db before calling
  // (cli-context/update.ts), and `performAutoRevert` runs post-listener while
  // the server is already serving.
  //
  // Reproduced directly with better-sqlite3: after the rename the still-open
  // handle keeps serving the UNLINKED inode, reports the pre-restore row count,
  // and ACCEPTS A WRITE that a fresh handle then cannot see. The caller is told
  // the write succeeded and it is gone.
  //
  // 🔑 THE CONTRACT ALREADY EXISTS NEXT DOOR. `commitStagedRestore`
  // (archive/archive-restore.ts) does the same file swap and states its
  // precondition: "the live db handle is already CLOSED (the restart drain's
  // `close_db` step did this)". Its `requestRestart` takes an
  // `onDrained(drainOk)` callback (archive-runtime.ts:263) and swaps only after
  // a complete drain; this path's `requestRestart` takes no callback and so
  // cannot defer anything.
  //
  // ⚠ WHY IT IS NOT A ONE-LINE FIX. Moving the restore after the drain moves the
  // binary swap after it too — the ordering above is load-bearing, a failed copy
  // must leave the binary untouched. That makes the rollback OUTCOME
  // asynchronous, the same shape D-257 gave `apply` (rpc returns `applying`,
  // terminal status rides `update.progress`), so the `rolled_back` ledger append
  // and this function's synchronous `operationId` return have to move with it.
  // A sequencing decision, not a patch.
  const restoredSnapshot = decision.action === 'restore-snapshot';
  // ⛔⛔ ONLY THIS ONE IS UNSAFE IN-PROCESS. `binary-swap` is an atomic rename and
  // runs fine under a live server; `restore-snapshot` REPLACES THE DATABASE FILE,
  // and doing that with a handle open leaves the process serving an unlinked
  // inode, accepting writes that no later reader can see (reproduced 2026-08-31).
  // Fails closed on an unwired port.
  if (restoredSnapshot && (ports.holdsDatabaseOpen?.() ?? true)) {
    return {
      status: 'refused',
      reason:
        'this rollback has to restore the pre-migration database snapshot, which cannot be done '
        + 'while the server is running — it would replace the database file underneath the open '
        + 'connection. Stop the server and run `recued update rollback`.',
    };
  }
  const operationId = ctx.operationId ?? ports.newEntryId();
  try {
    ports.beginManualRollbackJournal?.({
      operationId,
      releaseIdentity: ctx.releaseIdentity,
      fromVersion: ctx.fromVersion,
      toVersion: ctx.toVersion,
      channel: ctx.channel,
      migration: ctx.appliedMigration,
      restoredSnapshot,
    });
  } catch (err) {
    return {
      status: 'refused',
      reason: `could not durably journal the rollback before mutation: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (restoredSnapshot) {
    ports.restoreSnapshot();
    ports.markManualRollbackPhase?.(operationId, 'snapshot-restored');
  }
  // ⛔⛔ THE TERMINAL IS A WRITE-AHEAD COMMIT, NOT A POST-SWAP RECEIPT. The
  // binary this operation restores may be N-1 and know nothing about this
  // journal format. Writing `rolled_back` only after the swap left a power-loss
  // window in which N-1 booted and accepted writes while the only recovery code
  // lived in the binary that had just been replaced. Re-applying that newer
  // binary could then interpret the old journal as an aborted rollback and
  // restore its database undo OVER those post-rollback writes.
  //
  // The operation-status resolver already treats a rollback receipt as
  // `waiting_for_restart` until the running version proves the old generation;
  // make that contract physical. Once this append succeeds, recovery always
  // rolls the pair forward to the previous generation. If it fails, no binary
  // has moved and the retained undo is restored before we return.
  try {
    appendEntry(
      ports,
      'rolled_back',
      { releaseIdentity: ctx.releaseIdentity, fromVersion: ctx.fromVersion, toVersion: ctx.toVersion, channel: ctx.channel, migration: ctx.appliedMigration },
      {
        id: operationId,
        trigger: 'manual',
        detail: decision.reason,
      },
    );
  } catch (err) {
    let abortFailure: unknown;
    try {
      ports.abortManualRollbackJournal?.();
    } catch (abortErr) {
      abortFailure = abortErr;
    }
    return {
      status: 'refused',
      reason:
        `could not durably commit the rollback before swapping the binary: ${err instanceof Error ? err.message : String(err)}`
        + (abortFailure === undefined
          ? ''
          : `; the retained rollback journal still requires recovery: ${abortFailure instanceof Error ? abortFailure.message : String(abortFailure)}`),
    };
  }

  let recoveryPending = false;
  try {
    ports.rollbackSwap();
    ports.markManualRollbackPhase?.(operationId, 'pair-rolled-back');
  } catch {
    // The terminal above committed the direction before this failure. The
    // journal retains both exact generations, so pre-open recovery retries the
    // physical pair swap without ever guessing from database bytes. Restart a
    // supervised server immediately; the stopped CLI tells its owner to start it.
    recoveryPending = true;
  }
  if (!recoveryPending) {
    // Once the pair and receipt both exist, a failed unlink is harmless: boot
    // sees the terminal and retries only the cleanup.
    try { ports.dropManualRollbackJournal?.(); } catch { /* reconciled on boot */ }
  }
  ports.requestRestart();
  return {
    status: 'rolled-back',
    restored_snapshot: restoredSnapshot,
    operationId,
    ...(recoveryPending ? { recovery_pending: true } : {}),
  };
};

/** On boot, decide the fate of a staged-but-uncommitted apply (the `boot` phase
 *  of stage→boot→commit). `readinessOk` is the lifecycle readiness probe result;
 *  `currentReleaseIdentity` is what THIS booted binary reports. */
export const evaluatePendingApplyOnBoot = (
  ports: ApplyOrchestratorPorts,
  args: { readinessOk: boolean; currentReleaseIdentity: string; currentVersion?: string },
): BootDecision => {
  const inFlight = deriveInFlight(ports.ledger);
  if (inFlight === null) {
    // Nothing in flight — a normal boot. Clear any stale counter.
    ports.bootFailureCounter.reset();
    return { action: 'continue' };
  }
  const release = inFlight.entry.release_identity;

  // The outer supervisor performs the physical revert before it can append the
  // terminal. If that append is lost, this boot is already the known-good
  // `from_version`; swapping again would consume the newly-restored `.old` and
  // roll back TWO generations. The running version is independent disk evidence
  // that the revert completed, so repair only the ledger terminal.
  if (
    inFlight.staged
    && args.currentVersion === inFlight.entry.from_version
    && ports.revertJournalMatchesCurrent?.(release) === true
  ) {
    ports.bootFailureCounter.reset();
    return { action: 'revert-complete', releaseIdentity: release };
  }

  // Started but NEVER staged: a crash between `apply_started` and the swap. The
  // live binary was never touched, so this is a staging abort, NOT a boot-health
  // failure — release the lock + discard the staged temp rather than counting
  // boots against a binary that never ran.
  // ⛔⛔ THE LEDGER IS NOT THE ONLY WITNESS, AND IT IS NOT THE AUTHORITATIVE ONE.
  // The swap happens on disk BEFORE `apply_staged` is appended, so a ledger write
  // that fails — ENOSPC, a read-only volume, a kill between the two — leaves a
  // COMPLETED swap recorded as `apply_started` alone. Boot then read the missing
  // entry as "crashed before swapping", discarded the staged binary and wrote
  // `apply_reverted` for an apply that had in fact succeeded and was, at that
  // very moment, the binary doing the reading.
  //
  // 🔑 RECONCILE AGAINST THE DISK FIRST. `currentReleaseIdentity` is what THIS
  // RUNNING BINARY reports — it cannot be wrong about which binary it is. If it
  // already equals the in-flight target then the swap demonstrably happened,
  // whatever the ledger managed to record, and the honest repair is to write the
  // entry that was lost rather than to undo work that is already live.
  //
  // ⚠ Reordering the two appends alone would NOT fix this: writing
  // `apply_staged` before the swap would claim a swap that can still fail. Either
  // order has a window; only asking the disk closes it.
  if (!inFlight.staged && args.currentReleaseIdentity === release) {
    appendEntry(
      ports,
      'apply_staged',
      {
        releaseIdentity: release,
        fromVersion: inFlight.entry.from_version,
        toVersion: inFlight.entry.to_version,
        channel: inFlight.entry.channel,
        migration: inFlight.entry.migration ?? false,
      },
      {
        trigger: inFlight.entry.trigger ?? 'manual',
        detail: 'reconciled from disk: this binary IS the staged release, so the swap completed '
          + 'and only its ledger entry was lost',
      },
    );
    // Fall through to the readiness decision below, which is where a genuinely
    // staged apply is committed or reverted.
  } else if (!inFlight.staged) {
    const recovered = ports.recoverAbortedWebclient?.({
      releaseIdentity: release,
      operationId: inFlight.entry.id,
    }) ?? true;
    if (!recovered) {
      return {
        action: 'webclient-recovery-failed',
        releaseIdentity: release,
        reason: 'the durable webclient apply journal was malformed, belonged to another operation, or could not be restored',
      };
    }
    ports.discardStaged();
    appendEntry(
      ports,
      'apply_reverted',
      {
        releaseIdentity: release,
        fromVersion: inFlight.entry.from_version,
        toVersion: inFlight.entry.to_version,
        channel: inFlight.entry.channel,
        migration: inFlight.entry.migration ?? false,
      },
      { trigger: 'revert', detail: 'staging aborted (crash before swap)' },
    );
    ports.bootFailureCounter.reset();
    return { action: 'staging-aborted', releaseIdentity: release };
  }

  // Staged + we booted that release + it's healthy → commit.
  if (args.readinessOk && args.currentReleaseIdentity === release) {
    ports.bootFailureCounter.reset();
    return { action: 'commit', releaseIdentity: release };
  }
  // A failed/wrong boot of the staged-but-uncommitted binary — count it; trip
  // auto-revert at the threshold (signatures prove authenticity, not health).
  const count = ports.bootFailureCounter.increment(release);
  if (shouldAutoRevert(count)) {
    return { action: 'auto-revert', releaseIdentity: release, reason: `boot health failed ${count} times` };
  }
  return { action: 'continue' };
};
