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
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, statSync } from 'node:fs';
import { arch, platform as osPlatform } from 'node:os';
import { dirname, join } from 'node:path';
import { assertReleaseKeyValid, type ChannelName, type Platform } from '@recued/release';
import { resolveForApply, type ReleaseCheckDeps } from './release-check.js';
import {
  deriveCommittedRelease,
  type ApplyOrchestratorPorts,
} from './apply-orchestrator.js';
import {
  defaultDownload,
  discardStaged,
  preserveAndSwap,
  restoreSnapshot,
  rollbackSwap,
  takeSnapshot,
  verifyArtifactFile,
  writeStagedSig,
} from './binary-apply-executor.js';
import { copyDatabaseForSnapshot } from '../open-database.js';
import { createBootFailureCounter, BOOT_FAILURE_COUNTER_FILE } from './boot-failure-counter.js';
import { createReleaseStateStore } from './release-state-store.js';
import { createUpdateLedger, UPDATE_LEDGER_FILE } from './update-ledger.js';
import { createUpdateModeStore, type DistributionChannel } from './update-mode-store.js';
import { syncWebclientBundle } from './webclient-sync.js';
import { resolveWebclientBundleDir } from '../webclient-bundle-loader.js';
import { osFreeBytes } from '../storage/disk-free.js';
import type { UpdateApplyDeps, UpdateModeDeps } from '../update-handler.js';

/** The frozen trusted release public key (minisign format). Re-exported from
 *  the dependency-free `trusted-release-pubkey.ts` so the thin-image launcher
 *  embeds the SAME constant without importing the server graph. EMPTY pre-GA →
 *  `update.check` resolves `not-configured`. */
export { TRUSTED_RELEASE_PUBKEY } from './trusted-release-pubkey.js';
import { TRUSTED_RELEASE_PUBKEY } from './trusted-release-pubkey.js';

/** Default manifest location (overridable for staging via env). */
export const DEFAULT_MANIFEST_URL = 'https://releases.recued.com/manifest.json';

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

const resolveChannel = (env: NodeJS.ProcessEnv): ChannelName =>
  env.RECUED_UPDATE_CHANNEL === 'edge' ? 'edge' : 'stable';

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
export const resolveDistributionChannel = (env: NodeJS.ProcessEnv): DistributionChannel => {
  switch (env.RECUED_DISTRIBUTION_CHANNEL) {
    case 'docker-baked': return 'docker-baked';
    case 'docker-thin': return 'docker-thin';
    case 'source': return 'source';
    default: return 'binary';
  }
};

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

const defaultFetchText = async (url: string): Promise<string> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
};

/** Channels whose binary lives on a writable volume and self-applies (I-8):
 *  `binary` (GA host binary) + `docker-thin` (the `:managed` self-updating
 *  image with the binary on the data volume). `docker-baked` (immutable image —
 *  the host re-pulls) and `source` (notify-only) DON'T self-apply a binary, so
 *  `update.apply` returns `not-applicable` there. */
export const SELF_APPLY_CHANNELS: ReadonlySet<DistributionChannel> = new Set<DistributionChannel>([
  'binary',
  'docker-thin',
]);

export interface BuildApplyOrchestratorOptions {
  db: Database.Database;
  releaseCheckDeps: ReleaseCheckDeps;
  /** Hand off to the supervisor for a restart (the lifecycle drain → handoff). */
  requestRestart: () => void;
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
export const buildApplyOrchestratorDeps = (opts: BuildApplyOrchestratorOptions): UpdateApplyDeps | undefined => {
  const env = opts.env ?? process.env;
  const distributionChannel = resolveDistributionChannel(env);
  if (!SELF_APPLY_CHANNELS.has(distributionChannel)) return undefined;

  // D-178 — the binary we self-update. On `docker-thin` the server runs UNDER
  // the launcher (the seed shim execs `node …/bin.js`), so `process.execPath` is
  // the Node runtime, NOT the binary on the data volume the launcher actually
  // verify-and-execs. Target `${RECUED_BIN_DIR}/recued` (`/data/bin/recued`) so
  // the swap + the boot-failure counter land where the launcher reads them.
  const binaryPath =
    opts.binaryPath ??
    (distributionChannel === 'docker-thin'
      ? join(env.RECUED_BIN_DIR ?? '/data/bin', 'recued')
      : process.execPath);
  const binaryDir = dirname(binaryPath);
  const dataDir = opts.dataDir ?? dirname(opts.db.name);
  const oldPath = `${binaryPath}.old`;
  const stagedPath = `${binaryPath}.staged`;
  const snapshotPath = join(dataDir, 'update-snapshot.db');
  const dbPath = opts.db.name;
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
    download: defaultDownload,
    verifyArtifact: verifyArtifactFile,
    preserveAndSwap: () => preserveAndSwap(stagedPath, binaryPath, oldPath),
    rollbackSwap: () => rollbackSwap(oldPath, binaryPath),
    discardStaged: () => discardStaged(stagedPath),
    persistStagedSig: (sig) => writeStagedSig(stagedPath, sig),
    takeSnapshot: () => takeSnapshot(
      (dest) => copyDatabaseForSnapshot(opts.db, dest),
      snapshotPath,
    ),
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
    ...(webclientDir
      ? {
          syncWebclient: async (artifact: { url: string; sha256: string; sig: string }): Promise<void> => {
            await syncWebclientBundle(
              {
                download: defaultDownload,
                verifyArtifact: verifyArtifactFile,
                trustedPubkey: opts.releaseCheckDeps.trustedPubkey,
                targetDir: webclientDir,
                stagingPath: webclientStagingPath,
                log: (level, message) =>
                  level === 'warn' ? console.warn(`[webclient] ${message}`) : console.log(`[webclient] ${message}`),
              },
              artifact,
            );
          },
        }
      : {}),
    newEntryId: () => randomUUID(),
    now: () => Date.now(),
    trustedPubkey: opts.releaseCheckDeps.trustedPubkey,
    stagedPath,
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
  return {
    trustedPubkey: opts.trustedPubkey ?? TRUSTED_RELEASE_PUBKEY,
    manifestUrl: env.RECUED_RELEASE_MANIFEST_URL ?? DEFAULT_MANIFEST_URL,
    fetchText: opts.fetchText ?? defaultFetchText,
    channel: resolveChannel(env),
    currentVersion: opts.currentVersion,
    platform,
    ...(launcherVersion !== undefined ? { launcherVersion } : {}),
    loadState: () => store.load(),
    saveState: (s) => store.save(s),
    now: () => Date.now(),
  };
};
