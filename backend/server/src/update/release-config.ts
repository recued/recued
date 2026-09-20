/** D-178 slice 2 — boot-time assembly of the `update.check` orchestrator deps.
 *
 *  Pulls together the frozen trusted release pubkey (the integrity boundary),
 *  the manifest URL, this install's platform/channel/version, and the
 *  SQLite-backed rollout-salt + anti-replay state into a `ReleaseCheckDeps`.
 *  An EMPTY trusted pubkey (no signing identity wired yet — pre-GA) is the
 *  honest default: the orchestrator short-circuits to `not-configured` and
 *  nothing is fetched.
 */

import type Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { arch, platform as osPlatform } from 'node:os';
import { dirname, join } from 'node:path';
import { assertReleaseKeyValid, type ChannelName, type Platform } from '@recued/release';
import { resolveForApply, type ReleaseCheckDeps } from './release-check.js';
import {
  deriveCommittedRelease,
  type ApplyOrchestratorPorts,
} from './apply-orchestrator.js';
import {
  dropApplyAside,
  defaultDownload,
  discardStaged,
  preserveAndSwap,
  restoreSnapshot,
  rollbackCandidatePaths,
  rollbackSwap,
  sidecarPathsFor,
  takeSnapshot,
  verifyArtifactFile,
  writeStagedSig,
} from './binary-apply-executor.js';
import { acquireUpdateLease, updateLeasePathFor } from './update-lease.js';
import { copyClosedDatabaseForSnapshot, copyDatabaseForSnapshot } from '../open-database.js';
import { createBootFailureCounter, BOOT_FAILURE_COUNTER_FILE } from './boot-failure-counter.js';
import { createReleaseStateStore } from './release-state-store.js';
import { createUpdateLedger, UPDATE_LEDGER_FILE } from './update-ledger.js';
import { createUpdateModeStore, type DistributionChannel } from './update-mode-store.js';
import {
  clearWebclientApplyJournal,
  recoverAbortedWebclientSync,
  syncWebclientBundle,
  undoWebclientSync,
  type WebclientApplyIdentity,
  type WebclientSyncEffect,
} from './webclient-sync.js';
import { resolveWebclientBundleDir } from '../webclient-bundle-loader.js';
import { osFreeBytes } from '../storage/disk-free.js';
import {
  dropRevertJournal,
  revertJournalMatchesCurrent,
} from './supervised-boot-failure.js';
// ⛔ MOVED TO A LEAF, RE-EXPORTED HERE. See `install-paths.ts`: this module pulls
// `open-database`, which loads the native addon at module init, and the recovery
// for a MISSING addon needs these paths without paying that.
import {
  resolveDistributionChannel,
  resolveUpdateBinaryPath,
  SELF_APPLY_CHANNELS,
} from './install-paths.js';
import {
  advanceHostSequenceFloor,
  hostSequenceFloorPathFor,
  readHostSequenceFloor,
} from './host-sequence-floor.js';

export { resolveDistributionChannel, resolveUpdateBinaryPath };
import type { UpdateApplyDeps, UpdateModeDeps } from '../update-handler.js';
import { makeBoundedOriginHttpFetcher } from '../bounded-origin-http-fetcher.js';

/** The frozen trusted release public key (minisign format). Re-exported from
 *  the dependency-free `trusted-release-pubkey.ts` so the thin-image launcher
 *  embeds the SAME constant without importing the server graph. EMPTY pre-GA →
 *  `update.check` resolves `not-configured`. */
export { TRUSTED_RELEASE_PUBKEY } from './trusted-release-pubkey.js';
import { TRUSTED_RELEASE_PUBKEY } from './trusted-release-pubkey.js';
import { runningAsPackagedBinary } from '../packaged-binary.js';
import {
  realmSnapshotPath,
  writeRealmSnapshotMetadata,
  writeReleaseGenerationTransition,
} from './realm-generation-snapshot.js';
import {
  beginManualRollbackJournal,
  dropManualRollbackJournal,
  inspectManualRollbackJournal,
  manualRollbackJournalTarget,
  markManualRollbackPhase,
} from './manual-rollback-journal.js';
import { recoverManualRollbackBeforeOpen } from './manual-rollback-recovery.js';

/** Release feed root (overridable for staging via `RECUED_RELEASE_MANIFEST_URL`,
 *  which pins a FULL url and bypasses the per-channel derivation below). */
export const RELEASE_BASE_URL = 'https://releases.recued.com';

/** The manifest is served at a PER-CHANNEL path, and the bytes at every path are
 *  IDENTICAL — one signature, one `sequence`, every channel inside it. The split
 *  is not a content split; it exists so the CDN's own request counts can tell a
 *  stable fleet from an edge one.
 *
 *  Why it has to be a path: `stage-gates.md` §2 ① counts weekly-active servers as
 *  requests to this url, and §2a divides by the check cadence to get servers —
 *  7 req/server/week on stable (24h), 28 on edge (6h). A single flat
 *  `/manifest.json` merges both fleets into one number that no divisor can split,
 *  so the population estimate carries a 4× error bar. Path-splitting moves the
 *  division into Cloudflare's path breakdown, where it costs nothing.
 *
 *  ⚠ This must be settled BEFORE launch. The mix is only recoverable for traffic
 *  that arrives after the split — servers that check against a flat path are
 *  merged forever, and no later change repairs that cohort.
 *
 *  The flat `DEFAULT_MANIFEST_URL` stays published as a compat path (below). */
export const manifestUrlFor = (baseUrl: string, channel: ChannelName): string =>
  `${baseUrl.replace(/\/+$/, '')}/${channel}/manifest.json`;

/** LEGACY flat manifest location — still published, no longer the default the
 *  server derives. Nothing should fetch this after the split; traffic on it is a
 *  DIAGNOSTIC (an un-migrated consumer — a stale runbook, a hand-rolled script),
 *  not a fallback anyone is expected to use. Watch it, don't rely on it. */
export const DEFAULT_MANIFEST_URL = `${RELEASE_BASE_URL}/manifest.json`;

/** Map the Node runtime's os/arch to a release `Platform` triple, or null on an
 *  unsupported target (a check on such a host resolves to up-to-date — no
 *  artifact will match). */
export const detectPlatform = (): Platform | null => {
  const a = arch();
  const archPart = a === 'x64' ? 'x64' : a === 'arm64' ? 'arm64' : null;
  if (!archPart) return null;
  switch (osPlatform()) {
    case 'linux': return `linux-${archPart}` as Platform;
    case 'darwin': return `macos-${archPart}` as Platform;
    case 'win32': return `windows-${archPart}` as Platform;
    default: return null;
  }
};

/** ⛔ TWO NAMES FOR ONE POLICY. The installer selects a channel with
 *  `RECUED_CHANNEL` and the runtime read only `RECUED_UPDATE_CHANNEL`, so an
 *  owner who installed from `edge` got a server that checked `stable` — and
 *  neither name was persisted by the generated service, so even the matching one
 *  did not survive a reboot. `RECUED_UPDATE_CHANNEL` stays authoritative (it is
 *  the more specific name and existing installs may set it), with the installer's
 *  variable as the fallback, and the units now stamp what was chosen. */
const resolveChannel = (env: NodeJS.ProcessEnv): ChannelName =>
  (env.RECUED_UPDATE_CHANNEL ?? env.RECUED_CHANNEL) === 'edge' ? 'edge' : 'stable';

/** Parse `RECUED_LAUNCHER_VERSION` to a non-negative integer, or undefined when
 *  unset / malformed (no launcher → the resolve skips the `launcher-outdated`
 *  gate rather than spuriously tripping it). */
const parseLauncherVersion = (raw: string | undefined): number | undefined => {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
};

/** Parse `RECUED_UPDATE_MIN_FREE_BYTES` (a non-negative integer byte count) — the
 *  per-install override for the self-update storage preflight headroom; undefined
 *  when unset / malformed → the orchestrator's `UPDATE_MIN_FREE_HEADROOM_BYTES`
 *  default applies. */
const parseMinFreeBytes = (raw: string | undefined): number | undefined => {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
};

/** Distribution channel (I-8 — baked at build). Until the build stamps it,
 *  read `RECUED_DISTRIBUTION_CHANNEL` and default to `binary` (the GA channel);
 *  an unrecognized value also falls back to `binary`. */


/** Build the apply-policy deps for the `update.mode` / `update.set_mode` rpc. */
export const buildUpdateModeDeps = (db: Database.Database, env: NodeJS.ProcessEnv = process.env): UpdateModeDeps => ({
  store: createUpdateModeStore(db),
  channel: resolveDistributionChannel(env),
  envMode: env.RECUED_SELF_UPDATE,
});

export interface BuildReleaseCheckDepsOptions {
  db: Database.Database;
  currentVersion: string;
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to the build-time pinned `TRUSTED_RELEASE_PUBKEY`. */
  trustedPubkey?: string;
  /** Override the URL fetcher (tests). Defaults to the global `fetch`. */
  fetchText?: (url: string) => Promise<string>;
}

/** The update-check User-Agent — the ONLY thing this fetch says about itself.
 *
 *  `recued/<version> (<platform>; <distribution-channel>)`
 *
 *  Every field is already computed for the check itself, so nothing new is
 *  collected and no extra request is made: this is what the REQUIRED request can
 *  carry, and nothing else. There is no id, no install token, no salt, no
 *  counter — two servers on the same version / platform / channel emit BYTE-
 *  IDENTICAL requests and are indistinguishable in the log, which is the
 *  property that keeps this inside `stage-gates.md` §2's identifier-free rule and
 *  anti-drift signal ⑦ (which forbids a PER-INSTANCE identifier — a version
 *  shared by every server on it is not one).
 *
 *  What it buys, all as aggregate counts in Cloudflare zone analytics:
 *    - version adoption: the v(N) cohort growing while v(N-1) drains;
 *    - release HEALTH — the signal a bare count cannot give. A version whose
 *      cohort stops checking after apply is a version that bricked its servers.
 *      Local boot-failure auto-revert (`boot-failure-counter.ts`) already
 *      handles the incident per-server; this is how the FLEET-wide shape of it
 *      becomes visible at all;
 *    - platform + distribution mix: what to build for, and which install path
 *      people actually use (binary vs docker-thin vs source).
 *
 *  ⚠ Deliberately absent: anything per-instance, anything about the user, and
 *  any field that would make the string unique. If a future field cannot be
 *  shared by thousands of servers at once, it does not belong here. */
export const updateCheckUserAgent = (
  version: string,
  platform: Platform,
  distributionChannel: DistributionChannel,
): string => `recued/${version} (${platform}; ${distributionChannel})`;

export const RELEASE_METADATA_TIMEOUT_MS = 30_000;
export const RELEASE_METADATA_MAX_BYTES = 1024 * 1024;

const makeFetchText =
  (userAgent: string) => {
    const fetchMetadata = makeBoundedOriginHttpFetcher({
      timeoutMs: RELEASE_METADATA_TIMEOUT_MS,
      maxResponseBytes: RELEASE_METADATA_MAX_BYTES,
    });
    return async (url: string): Promise<string> => {
      const res = await fetchMetadata(url, {
        headers: { 'user-agent': userAgent },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    };
  };

/** Re-exported from `install-paths.ts`, where it moved so `bin.ts` can ask
 *  before the native-addon module graph loads. One definition, unchanged
 *  importers — same arrangement as the two resolvers above. */
export { SELF_APPLY_CHANNELS };

export interface BuildApplyOrchestratorOptions {
  db: Database.Database;
  releaseCheckDeps: ReleaseCheckDeps;
  /** Hand off to the supervisor for a restart (the lifecycle drain → handoff). */
  /** Hand off to the supervisor. An `onDrained` callback, when the composition
   *  supports one, runs after the drain has closed the database and before exit —
   *  the only safe window to replace the database file. See the port docs in
   *  apply-orchestrator.ts. */
  requestRestart: (onDrained?: (drainOk: boolean) => void | Promise<void>) => void;
  /** Override the "am I the packaged SEA" probe. Production omits it; tests use
   *  it to drive both sides of the guard without having to be a SEA. */
  isPackagedBinary?: () => boolean;
  /** Does the CALLER hold the realm database open? The server does (it is
   *  serving from it); the CLI does not, once it has closed. Gates the one
   *  rollback shape that replaces the database file. Omitted → treated as open,
   *  because guessing "closed" is the answer that loses data. */
  holdsDatabaseOpen?: () => boolean;
  /** ⛔ Whether that handoff will actually bring the process back. Forwarded
   *  to the orchestrator, which refuses an apply that would exit and stay
   *  down. Absent → un-supervised (fail closed). */
  supervisorWillRespawn?: () => boolean;
  /** No active runs + scheduler paused — only consulted on `auto` triggers. */
  isQuiesced: () => boolean;
  env?: NodeJS.ProcessEnv;
  /** The live binary path (defaults to `process.execPath`). */
  binaryPath?: string;
  /** The data volume root for the ledger + snapshot (defaults to the db dir). */
  dataDir?: string;
  /** D-152 § A.16 — the CAS blob root, used to resolve the webclient bundle dir
   *  (`resolveWebclientBundleDir` — a `webclient` sibling of the CAS root, or the
   *  `RECUED_WEBCLIENT_DIR` override) so a self-update can extract the matched
   *  webclient there. Absent → no webclient self-sync (the `syncWebclient` port
   *  stays unwired; the binary update proceeds normally). */
  cacheBlobsRoot?: string;
}

/** Assemble the apply/rollback orchestrator deps from real disk-backed ports.
 *  Returns undefined on a delegated channel (docker-baked / source) — the
 *  handler then resolves `update.apply`/`update.rollback` to `not-applicable`.
 *  The ledger + snapshot live on the DATA VOLUME (survive a binary swap); the
 *  boot-failure counter + the staged/old binaries live BESIDE THE BINARY (same
 *  filesystem → atomic-rename swap; survive a snapshot restore). */
/** The executable an apply would replace, for a given environment.
 *
 *  ⛔ EXPORTED SO THERE IS ONE DERIVATION. The CLI needs it to locate the lease
 *  before it builds these deps, and a second copy of this expression is how the
 *  lease ended up guarding the wrong path in the first place. On `docker-thin`
 *  the server runs UNDER the launcher, so `process.execPath` is the Node runtime
 *  and the real target is the binary on the data volume. */


export const buildApplyOrchestratorDeps = (opts: BuildApplyOrchestratorOptions): UpdateApplyDeps | undefined => {
  const env = opts.env ?? process.env;
  const distributionChannel = resolveDistributionChannel(env);
  if (!SELF_APPLY_CHANNELS.has(distributionChannel)) return undefined;

  // ⛔⛔⛔ REFUSE TO SELF-UPDATE A NODE RUNTIME THAT IS NOT US. On the `binary`
  // channel the apply target below is `process.execPath` — the recued SEA only
  // when this process IS the SEA. From a source checkout, an npm install, or
  // Homebrew (whose formula "wraps the npm package — no standalone binary is
  // produced"), that path is the OWNER'S NODE, and an apply would rename a
  // downloaded recued release over their node executable.
  //
  // 🔑 THE RULE EXISTED, AT THE WRONG END. `cli-context/update.ts` has carried
  // this exact check for the CLI verb, with a comment saying the target "would be
  // the owner's node runtime" — while the server/web composition, which is the
  // path a single click and every AUTOMATIC apply take, had none. A rule enforced
  // at one caller instead of at the shared boundary is a rule the next caller
  // does not get. It lives here now, in the builder both paths go through.
  //
  // ⚠ THE CHANNEL CANNOT ANSWER THIS. `RECUED_DISTRIBUTION_CHANNEL` DEFAULTS to
  // `binary` when unset and no production package stamps it, so the channel
  // reports "packaged" on exactly the installs that are not. `node:sea` asks the
  // runtime; see `packaged-binary.ts`, whose own docstring names this hazard.
  //
  // Returning undefined resolves `update.apply` / `update.rollback` to
  // `not-applicable`, which is the honest answer: this install cannot update
  // itself in place, and the installer is how it moves.
  const isPackaged = opts.isPackagedBinary ?? runningAsPackagedBinary;
  if (
    distributionChannel === 'binary'
    && opts.binaryPath === undefined      // an explicit target is the caller's own business
    && !isPackaged()
  ) {
    return undefined;
  }

  // D-178 — the binary we self-update. On `docker-thin` the server runs UNDER
  // the launcher (the seed shim execs `node …/bin.js`), so `process.execPath` is
  // the Node runtime, NOT the binary on the data volume the launcher actually
  // verify-and-execs. Target `${RECUED_BIN_DIR}/recued` (`/data/bin/recued`) so
  // the swap + the boot-failure counter land where the launcher reads them.
  const binaryPath = opts.binaryPath ?? resolveUpdateBinaryPath(env);
  const binaryDir = dirname(binaryPath);
  const dataDir = opts.dataDir ?? dirname(opts.db.name);
  const oldPath = `${binaryPath}.old`;
  const stagedPath = `${binaryPath}.staged`;
  // D-178 S1 rev 2 item 4 — the native addon the SEA loads at its first database
  // open. Keyed off `binaryDir`, NOT `process.execPath`: on `docker-thin` the
  // seed boot runs under Node, so execPath is the Node runtime, but the file the
  // NEXT boot resolves is `dirname(<the binary we are swapping>)/lib/…`. Honour
  // the same `RECUED_NATIVE_BINDING` override `open-database.ts` reads, or the
  // update would swap a file the new binary never looks at.
  const sidecarPaths = sidecarPathsFor(binaryPath, env);
  const libStagedPath = sidecarPaths.stagedPath;
  const dbPath = opts.db.name;
  // Snapshot state belongs to the database, not merely its directory. Two
  // custom --db paths may be siblings and must never restore each other's bytes.
  const snapshotPath = realmSnapshotPath(dbPath);
  const manualRollbackTarget = manualRollbackJournalTarget({
    dataDir,
    dbPath,
    binaryPath,
    snapshotPath,
    previousBinaryPath: oldPath,
    previousGenerationPaths: rollbackCandidatePaths(oldPath, sidecarPaths),
  });
  // Per-install override for the self-update storage preflight (bytes); unset /
  // malformed → the orchestrator's UPDATE_MIN_FREE_HEADROOM_BYTES default applies.
  const minFreeOverride = parseMinFreeBytes(env.RECUED_UPDATE_MIN_FREE_BYTES);

  const ledger = createUpdateLedger(join(dataDir, UPDATE_LEDGER_FILE));
  const bootFailureCounter = createBootFailureCounter(join(binaryDir, BOOT_FAILURE_COUNTER_FILE));

  // D-152 § A.16 — the webclient bundle dir this self-update extracts to (the
  // SAME dir the boot loader reads). Absent (no CAS root + no override) → the
  // `syncWebclient` port stays unwired and the binary update proceeds normally.
  const webclientDir = resolveWebclientBundleDir(opts.cacheBlobsRoot, env.RECUED_WEBCLIENT_DIR);
  // Download scratch: a sibling of the bundle dir (same filesystem → the atomic
  // rename swap inside `syncWebclientBundle` works; never inside the dir, which
  // gets replaced).
  const webclientStagingPath = webclientDir ? `${webclientDir}.archive.staged` : '';

  const ports: ApplyOrchestratorPorts = {
    ledger,
    bootFailureCounter,
    // The addon stages into `<binDir>/lib/`, which need not exist yet on an
    // install predating the sidecar (or a docker-thin data volume seeded before
    // the lib was baked). Create it here rather than in `defaultDownload` — the
    // path composition is this module's job, and a `createWriteStream` into a
    // missing dir is an ENOENT that reads like a network failure.
    download: async (url, destPath) => {
      mkdirSync(dirname(destPath), { recursive: true });
      await defaultDownload(url, destPath);
    },
    verifyArtifact: verifyArtifactFile,
    preserveAndSwap: (swapSidecar) =>
      preserveAndSwap(stagedPath, binaryPath, oldPath, swapSidecar ? sidecarPaths : undefined),
    // Rollback ALWAYS passes the paths: the executor no-ops when no preserved
    // addon exists, and the addon that needs restoring was preserved by a
    // PREVIOUS apply — there is no `ctx` here to consult, and inferring "this
    // install has a sidecar" from anything else would skip the restore exactly
    // when it matters.
    rollbackSwap: () => {
      rollbackSwap(oldPath, binaryPath, sidecarPaths, webclientDir ?? undefined);
      clearWebclientApplyJournal(webclientDir ?? undefined);
    },
    // Same `oldPath` the swap was given — one derivation, so the drop can never
    // aim at a different file than the stash did.
    dropApplyAside: () => dropApplyAside(oldPath, sidecarPaths, webclientDir ?? undefined),
    clearWebclientApplyJournal: () => {
      clearWebclientApplyJournal(webclientDir ?? undefined);
    },
    dropRevertJournal: () => dropRevertJournal(binaryPath),
    revertJournalMatchesCurrent: (releaseIdentity) =>
      revertJournalMatchesCurrent(binaryPath, releaseIdentity),
    beginManualRollbackJournal: (input) =>
      beginManualRollbackJournal(manualRollbackTarget, oldPath, input),
    markManualRollbackPhase: (operationId, phase) =>
      markManualRollbackPhase(manualRollbackTarget, operationId, phase),
    inspectManualRollbackJournal: () =>
      inspectManualRollbackJournal(manualRollbackTarget),
    abortManualRollbackJournal: () => {
      const outcome = recoverManualRollbackBeforeOpen({
        target: manualRollbackTarget,
        ledger,
        restoreDatabase: (sourcePath, targetPath) =>
          restoreSnapshot(sourcePath, targetPath, (from, to) => copyFileSync(from, to)),
      });
      if (outcome.action === 'refused') {
        throw new Error(outcome.reason);
      }
    },
    dropManualRollbackJournal: () => dropManualRollbackJournal(manualRollbackTarget),
    discardStaged: () => {
      discardStaged(stagedPath);
      discardStaged(libStagedPath);
    },
    persistStagedSig: (sig) => writeStagedSig(stagedPath, sig),
    persistStagedLibSig: (sig) => writeStagedSig(libStagedPath, sig),
    // ⛔ THE SNAPSHOT IS TAKEN IN TWO DIFFERENT STATES, AND ONLY ONE OF THEM HAS A
    // CONNECTION. On a live server the apply commits inside the restart drain,
    // i.e. AFTER its `close_db` step — that is the point of the deferral, since a
    // snapshot taken while the server still accepted writes silently excluded
    // every one of them. `VACUUM INTO` needs the connection, so post-close the
    // faithful copy is the file itself. The CLI apply is the other state: it is
    // the only thing holding the realm, it does not serve, and its handle is
    // open, so it snapshots the way it always did.
    //
    // ⚠ ASKED, NOT ASSUMED. `db.open` is the fact; a flag threaded from the
    // caller would be a second copy of it, and the copy is what would go stale.
    takeSnapshot: () => takeSnapshot(
      (dest) => (opts.db.open
        ? copyDatabaseForSnapshot(opts.db, dest)
        : copyClosedDatabaseForSnapshot(dbPath, dest)),
      snapshotPath,
    ),
    snapshotRef: snapshotPath,
    recordGenerationTransition: ({ fromVersion, toVersion, migration }) => {
      const transition = {
        schema: 1 as const,
        from_version: fromVersion,
        to_version: toVersion,
        migration,
      };
      writeReleaseGenerationTransition(binaryPath, transition);
      // Only a migrating apply depends on a database snapshot. Record its exact
      // provenance before the binary swap so a later host-wide downgrade can
      // safely restore this realm before opening it.
      if (migration) writeRealmSnapshotMetadata(dbPath, transition);
    },
    restoreSnapshot: () => restoreSnapshot(snapshotPath, dbPath, (from, to) => copyFileSync(from, to)),
    hasPreviousBinary: () => existsSync(oldPath),
    hasSnapshot: () => existsSync(snapshotPath),
    // Storage preflight ports (covers BOTH self-apply channels — binary +
    // docker-thin — since this wiring builds the ports for both). statfs failure
    // gates the preflight OPEN rather than wedging updates on an exotic fs.
    freeBytes: () => {
      try {
        return osFreeBytes(dataDir);
      } catch {
        return null;
      }
    },
    artifactVolumeFreeBytes: () => {
      try {
        return osFreeBytes(binaryDir);
      } catch {
        return null;
      }
    },
    sameVolumeAsData: () => {
      try {
        return statSync(dataDir).dev === statSync(binaryDir).dev;
      } catch {
        return true; // can't tell → treat as one pool (conservative: sum the needs)
      }
    },
    dbSizeBytes: () => {
      try {
        // The consistent logical copy includes committed WAL pages, so include
        // the live -wal size in the estimate (conservative).
        const main = statSync(dbPath).size;
        let wal = 0;
        try {
          wal = statSync(`${dbPath}-wal`).size;
        } catch {
          /* no WAL sidecar */
        }
        return main + wal;
      } catch {
        return 0;
      }
    },
    ...(minFreeOverride !== undefined ? { minFreeHeadroomBytes: minFreeOverride } : {}),
    isQuiesced: opts.isQuiesced,
    requestRestart: opts.requestRestart,
    holdsDatabaseOpen: opts.holdsDatabaseOpen ?? (() => true),
    // ⛔ BESIDE THE BINARY, NOT THE REALM. See `updateLeasePathFor`: several
    // realms can share one executable, and the `.staged` / `.old` paths they race
    // are derived from IT, not from any realm.
    acquireUpdateLease: (operation) => acquireUpdateLease({
      leasePath: updateLeasePathFor(binaryPath),
      operation,
    }),
    installedVersion: () => {
      const probe = spawnSync(binaryPath, ['--version'], {
        encoding: 'utf8',
        timeout: 5_000,
        windowsHide: true,
      });
      if (probe.status !== 0 || probe.error) return null;
      const version = probe.stdout.trim().split(/\r?\n/, 1)[0]?.trim();
      return version || null;
    },
    ...(opts.supervisorWillRespawn !== undefined
      ? { supervisorWillRespawn: opts.supervisorWillRespawn }
      : {}),
    ...(webclientDir
      ? {
          // ⛔ THE EXACT EFFECT IS FORWARDED, NOT SWALLOWED. A failed sync can
          // still park a prior backup, while a first install creates rather than
          // replaces the live bundle; every pre-commit failure must undo exactly
          // the mutation this attempt made and nothing else.
          syncWebclient: async (
            artifact: { url: string; sha256: string; sig: string },
            identity: WebclientApplyIdentity,
          ): Promise<WebclientSyncEffect> => {
            const result = await syncWebclientBundle(
              {
                download: defaultDownload,
                verifyArtifact: verifyArtifactFile,
                trustedPubkey: opts.releaseCheckDeps.trustedPubkey,
                targetDir: webclientDir,
                stagingPath: webclientStagingPath,
                applyIdentity: identity,
                log: (level, message) =>
                  level === 'warn' ? console.warn(`[webclient] ${message}`) : console.log(`[webclient] ${message}`),
              },
              artifact,
            );
            return result.effect;
          },
          undoWebclient: (effect: WebclientSyncEffect, identity: WebclientApplyIdentity) => {
            const moved = undoWebclientSync(webclientDir, effect, identity);
            if (moved) console.log('[webclient] the staged update was abandoned — bundle state restored');
            else console.warn('[webclient] staged update recovery remains pending for the next pre-open boot');
            return moved;
          },
          recoverAbortedWebclient: (identity: WebclientApplyIdentity) => {
            const recovered = recoverAbortedWebclientSync(webclientDir, identity);
            if (recovered) console.log('[webclient] recovered an interrupted pre-swap bundle promotion');
            return recovered;
          },
        }
      : {}),
    newEntryId: () => randomUUID(),
    now: () => Date.now(),
    trustedPubkey: opts.releaseCheckDeps.trustedPubkey,
    stagedPath,
    stagedLibPath: libStagedPath,
  };

  return {
    ports,
    resolveForApply: () => resolveForApply(opts.releaseCheckDeps),
    rollbackContext: () => deriveCommittedRelease(ledger),
  };
};

/** Build the orchestrator deps. Returns undefined on an unsupported platform —
 *  the handler slice then drops and `update.check` yields `not_configured`. */
export const buildReleaseCheckDeps = (opts: BuildReleaseCheckDepsOptions): ReleaseCheckDeps | undefined => {
  const env = opts.env ?? process.env;
  // D-178 S3 — fail closed on a malformed pin. An EMPTY key is the honest
  // pre-GA posture (verifiers short-circuit to `not-configured`); a NON-EMPTY
  // but unparseable pin is a deploy mistake that would silently weaken
  // verification, so refuse to assemble rather than boot a half-trusted updater.
  assertReleaseKeyValid(opts.trustedPubkey ?? TRUSTED_RELEASE_PUBKEY);
  const platform = detectPlatform();
  if (!platform) return undefined;
  const store = createReleaseStateStore(opts.db);
  // D-178 I-9 — the thin `:managed` launcher reports its verification-contract
  // version via `RECUED_LAUNCHER_VERSION`; a manifest whose `min_launcher_version`
  // exceeds it resolves to `launcher-outdated` (the server stops applying, keeps
  // running, notifies recreate-from-digest). Absent (binary channel / no
  // launcher) → undefined → the resolve skips the launcher gate entirely.
  const launcherVersion = parseLauncherVersion(env.RECUED_LAUNCHER_VERSION);
  // One channel value feeds BOTH the fetch path and the in-manifest resolve, so
  // a server can never count itself as one fleet and update as the other.
  const channel = resolveChannel(env);
  // ONE derivation, handed to both floor ports below.
  const floorPath = hostSequenceFloorPathFor(dirname(resolveUpdateBinaryPath(env)));
  return {
    trustedPubkey: opts.trustedPubkey ?? TRUSTED_RELEASE_PUBKEY,
    // An explicit `RECUED_RELEASE_MANIFEST_URL` wins VERBATIM — a self-hoster or
    // staging feed pinned a full url and we do not append a channel segment to
    // it. Only the derived default is per-channel.
    manifestUrl: env.RECUED_RELEASE_MANIFEST_URL ?? manifestUrlFor(RELEASE_BASE_URL, channel),
    fetchText:
      opts.fetchText
      ?? makeFetchText(
        updateCheckUserAgent(opts.currentVersion, platform, resolveDistributionChannel(env)),
      ),
    channel,
    distributionChannel: resolveDistributionChannel(env),
    currentVersion: opts.currentVersion,
    platform,
    ...(launcherVersion !== undefined ? { launcherVersion } : {}),
    loadState: () => store.load(),
    saveState: (s) => store.save(s),
    // ⛔ THE INSTALL-WIDE FLOOR IS PART OF THE SAME INVARIANT. It lives beside the
    // binary (`<binaryDir>/.release-sequence`, written by install.sh after a
    // proven-good install) while this realm's lives in SQLite; neither could see
    // the other, so a manifest the installer had already refused as a replay was
    // still honoured here.
    //
    // ⛔⛔ AND IT IS WRITTEN, NOT ONLY READ. Reading a shared floor while
    // recording acceptance only per-realm is what let realm A accept 300 and
    // leave realm B free to accept a replayed 250 on the same executable. Both
    // ports address ONE file through one module — a second path expression here
    // is how the lease came to guard the wrong file.
    hostSequenceFloor: () => readHostSequenceFloor(floorPath),
    advanceHostSequenceFloor: (sequence) => { advanceHostSequenceFloor(floorPath, sequence); },
    now: () => Date.now(),
  };
};
