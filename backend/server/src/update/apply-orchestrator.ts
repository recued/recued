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

export interface ApplyContext {
  releaseIdentity: string;
  fromVersion: string;
  toVersion: string;
  channel: 'stable' | 'edge';
  migration: boolean;
  artifact: { url: string; sha256: string; sig: string };
  /** D-152 § A.16 — the arch-neutral webclient bundle archive for this release,
   *  when the manifest carries one. Best-effort synced to RECUED_WEBCLIENT_DIR
   *  after the binary swap so the self-updated server serves a matched
   *  `/webclient/*`. Null/absent for a binaries-only release. */
  webclientArtifact?: { url: string; sha256: string; sig: string } | null;
  /** `auto` (housekeeping) defers when not quiesced; `manual` proceeds. */
  trigger: 'auto' | 'manual';
}

export interface ApplyOrchestratorPorts {
  ledger: UpdateLedger;
  bootFailureCounter: BootFailureCounter;
  /** Download the artifact to the staging path. */
  download: (url: string, destPath: string) => Promise<void>;
  /** Fail-closed artifact verification (binary-apply-executor.verifyArtifactFile). */
  verifyArtifact: (input: VerifyArtifactInput) => VerifyArtifactResult;
  /** Move the verified staged file into place, preserving recued.old. */
  preserveAndSwap: () => void;
  /** Swap recued.old back. */
  rollbackSwap: () => void;
  /** Best-effort staged-temp cleanup. */
  discardStaged: () => void;
  /** D-178 thin launcher — persist the verified artifact's detached signature
   *  beside the STAGED binary so `preserveAndSwap` carries it into place and the
   *  `:managed` launcher can re-verify before exec (I-2 second verification).
   *  Optional: absent on harnesses / channels that don't need the sidecar (the
   *  binary self-update verifies at apply time regardless). */
  persistStagedSig?: (sig: string) => void;
  /** Take the pre-migration SQLite snapshot (mechanism c). */
  takeSnapshot: () => Promise<void>;
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
  requestRestart: () => void;
  /** D-152 § A.16 — best-effort webclient bundle sync (download + verify +
   *  atomic extract to RECUED_WEBCLIENT_DIR). Optional: absent on the baked
   *  docker channel (bakes its own webclient), harnesses, or when no webclient
   *  dir resolves. Logs + swallows internally; NEVER blocks the binary apply. */
  syncWebclient?: (artifact: { url: string; sha256: string; sig: string }) => Promise<void>;
  newEntryId: () => string;
  now: () => number;
  /** The pinned, embedded trusted release pubkey. Empty → not-configured. */
  trustedPubkey: string;
  /** The staging path the download lands at + the artifact is verified at. */
  stagedPath: string;
}

export type ApplyResult =
  | { status: 'restarting' }
  | { status: 'deferred'; reason: string }
  | { status: 'busy' }
  | { status: 'not-configured' }
  | { status: 'insufficient-storage'; detail: string }
  | { status: 'download-failed'; detail: string }
  | { status: 'verify-failed'; detail: string }
  | { status: 'stage-failed'; detail: string };

export type RollbackResult =
  | { status: 'rolled-back'; restored_snapshot: boolean }
  | { status: 'refused'; reason: string }
  | { status: 'busy' };

export type BootDecision =
  | { action: 'commit'; releaseIdentity: string }
  | { action: 'auto-revert'; releaseIdentity: string; reason: string }
  | { action: 'staging-aborted'; releaseIdentity: string }
  | { action: 'continue' };

const TERMINAL_KINDS: ReadonlySet<UpdateLedgerKind> = new Set<UpdateLedgerKind>([
  'apply_committed',
  'apply_reverted',
  'rolled_back',
]);

interface InFlightApply {
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

/** The release id of the still-in-flight apply, or null (the host-wide lock). */
export const deriveInFlightRelease = (ledger: UpdateLedger): string | null =>
  deriveInFlight(ledger)?.entry.release_identity ?? null;

/** The `apply_started` entry of the still-in-flight apply (carries the staged
 *  release's versions + `migration` flag), or null. The on-boot auto-revert
 *  path reads it to drive the snapshot-restore decision + the terminal entry. */
export const deriveInFlightEntry = (ledger: UpdateLedger): UpdateLedgerEntry | null =>
  deriveInFlight(ledger)?.entry ?? null;

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
): void => {
  ports.ledger.append({
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
  });
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

/** Stage → swap → request restart. The `commit` half happens on the next boot
 *  (`evaluatePendingApplyOnBoot`). Idempotent against the ledger-derived lock:
 *  a second concurrent apply (any release) is refused while one is in flight. */
export const runApply = async (ports: ApplyOrchestratorPorts, ctx: ApplyContext): Promise<ApplyResult> => {
  if (!ports.trustedPubkey) return { status: 'not-configured' };
  if (deriveInFlightRelease(ports.ledger) !== null) return { status: 'busy' };
  // I-5: auto-apply only from quiesce; manual proceeds (caller forces quiesce).
  if (ctx.trigger === 'auto' && !ports.isQuiesced()) {
    return { status: 'deferred', reason: 'waiting for idle (no active runs, scheduler paused)' };
  }
  // Storage preflight — refuse BEFORE touching the ledger (no in-flight entry to
  // release) when the data volume can't fit the artifact + (if migrating) the
  // snapshot. A clean up-front refusal beats an ENOSPC mid-download / mid-backup.
  const storage = checkStorageHeadroom(ports, ctx.migration);
  if (!storage.ok) return { status: 'insufficient-storage', detail: storage.detail };

  appendEntry(ports, 'apply_started', ctx, { trigger: ctx.trigger });

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

  // Snapshot (if migrating) + swap. A failure here must RELEASE the lock
  // (append a terminal) — otherwise the `apply_started` above wedges every
  // future apply. The pre-migration snapshot goes BEFORE the swap so a later
  // rollback can restore it (mechanism c).
  try {
    if (ctx.migration) {
      await ports.takeSnapshot();
      appendEntry(ports, 'snapshot_taken', ctx, { trigger: ctx.trigger });
    }
    ports.preserveAndSwap();
  } catch (err) {
    ports.discardStaged();
    const detail = err instanceof Error ? err.message : 'stage error';
    appendEntry(ports, 'apply_reverted', ctx, { trigger: ctx.trigger, detail: `stage: ${detail}` });
    return { status: 'stage-failed', detail };
  }

  appendEntry(ports, 'apply_staged', ctx, { trigger: ctx.trigger });

  // D-152 § A.16 — best-effort: sync the version-matched webclient bundle to
  // RECUED_WEBCLIENT_DIR so the self-updated server serves a matched
  // `/webclient/*`. The binary is already staged; a webclient failure leaves the
  // prior bundle (the D-152 loader re-verifies on boot), so this must NEVER throw
  // past here or block the restart.
  if (ctx.webclientArtifact && ports.syncWebclient) {
    try {
      await ports.syncWebclient(ctx.webclientArtifact);
    } catch {
      /* best-effort — the port logs internally; the binary update is unaffected */
    }
  }

  ports.requestRestart();
  return { status: 'restarting' };
};

export interface RollbackContext {
  releaseIdentity: string;
  fromVersion: string;
  toVersion: string;
  channel: 'stable' | 'edge';
  /** The CURRENTLY-applied release migrated the schema (drives the guard). */
  appliedMigration: boolean;
}

/** Roll back the current release (owner action — never consults the manifest,
 *  I-10). Refused while an apply is in flight (I-6) and per `decideRollback`. */
export const runRollback = (ports: ApplyOrchestratorPorts, ctx: RollbackContext): RollbackResult => {
  if (deriveInFlightRelease(ports.ledger) !== null) return { status: 'busy' };
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
  const restoredSnapshot = decision.action === 'restore-snapshot';
  if (restoredSnapshot) ports.restoreSnapshot();
  ports.rollbackSwap();
  appendEntry(
    ports,
    'rolled_back',
    { releaseIdentity: ctx.releaseIdentity, fromVersion: ctx.fromVersion, toVersion: ctx.toVersion, channel: ctx.channel, migration: ctx.appliedMigration },
    { trigger: 'manual', detail: decision.reason },
  );
  ports.requestRestart();
  return { status: 'rolled-back', restored_snapshot: restoredSnapshot };
};

/** On boot, decide the fate of a staged-but-uncommitted apply (the `boot` phase
 *  of stage→boot→commit). `readinessOk` is the lifecycle readiness probe result;
 *  `currentReleaseIdentity` is what THIS booted binary reports. */
export const evaluatePendingApplyOnBoot = (
  ports: ApplyOrchestratorPorts,
  args: { readinessOk: boolean; currentReleaseIdentity: string },
): BootDecision => {
  const inFlight = deriveInFlight(ports.ledger);
  if (inFlight === null) {
    // Nothing in flight — a normal boot. Clear any stale counter.
    ports.bootFailureCounter.reset();
    return { action: 'continue' };
  }
  const release = inFlight.entry.release_identity;

  // Started but NEVER staged: a crash between `apply_started` and the swap. The
  // live binary was never touched, so this is a staging abort, NOT a boot-health
  // failure — release the lock + discard the staged temp rather than counting
  // boots against a binary that never ran.
  if (!inFlight.staged) {
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
