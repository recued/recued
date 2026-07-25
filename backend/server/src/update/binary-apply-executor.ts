/** D-178 slice 3b — the binary apply MECHANICS (spec § Update machinery,
 *  "Apply, per channel" + "Two-phase apply").
 *
 *  The on-disk half of a binary self-update: download the artifact to a temp
 *  file on the SAME filesystem (so the swap is an atomic rename, not a
 *  cross-device copy), verify it FAIL-CLOSED before any byte moves into place
 *  (I-2 — sha256 fast-fail + the detached minisign signature against the pinned
 *  key), preserve the running binary as `recued.old`, then atomically rename
 *  the verified artifact into place. Rollback swaps `recued.old` back. The
 *  pre-migration SQLite snapshot (mechanism c) + its restore live here too.
 *
 *  This module performs IO but stays orchestration-free: the apply state
 *  machine (apply-state-machine.ts) + the cross-restart orchestrator (slice 4)
 *  decide WHEN to call these; here we only do the file work, each step
 *  individually testable. `download` is injected so tests don't hit the
 *  network and so the streaming policy stays swappable. Verification reuses
 *  `@recued/release` — the SAME frozen minisign boundary the manifest check
 *  uses (I-2 is one implementation, not two).
 */

import { createHash } from 'node:crypto';
import { chmodSync, createWriteStream, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { verify } from '@recued/release';
import { fsyncDir, fsyncFile } from '../durable-fs.js';

/** Detached-signature sidecar suffix written beside the binary on the volume so
 *  the D-178 thin `:managed` launcher can RE-VERIFY before exec (I-2 second
 *  verification — defense in depth against a tampered volume). The launcher
 *  duplicates this constant (`launcher/managed-launcher.ts` — it imports nothing
 *  from the server bundle, I-9); keep the two in lockstep. */
export const SIG_SIDECAR_SUFFIX = '.minisig';

const sigPathOf = (path: string): string => `${path}${SIG_SIDECAR_SUFFIX}`;

/** Persist the verified artifact's detached signature beside the STAGED binary
 *  so `preserveAndSwap` moves it into place atomically with the swap. Only the
 *  thin launcher consumes it; the binary channel writes it harmlessly. */
export const writeStagedSig = (stagedPath: string, sig: string): void => {
  writeFileSync(sigPathOf(stagedPath), sig, 'utf8');
};

/** Stream a URL to `destPath`. Injected in tests; the default uses the global
 *  `fetch` + a streamed write so a large artifact never fully buffers in RAM.
 *
 *  CONTRACT (slice-4 orchestrator): `destPath` MUST be a temp STAGING path on
 *  the same filesystem as the live binary, NEVER the live binary path — bytes
 *  land before verification, so writing over the running binary would defeat
 *  I-2. On a transport failure partial bytes may remain; call `discardStaged`
 *  in a `finally`. */
export type DownloadFn = (url: string, destPath: string) => Promise<void>;

export const defaultDownload: DownloadFn = async (url, destPath) => {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(destPath));
};

export interface VerifyArtifactInput {
  filePath: string;
  /** Expected SHA-256 (hex) from the signed manifest — fast-fail convenience. */
  sha256: string;
  /** Detached minisign signature over the artifact bytes. */
  sig: string;
  /** The pinned, embedded trusted release pubkey (minisign format). */
  trustedPubkey: string;
}

export type VerifyArtifactResult = { ok: true } | { ok: false; reason: string };

/** Fail-closed artifact verification (I-2): the sha256 is a fast-fail that
 *  travels with the signed manifest; the detached minisign signature against
 *  the PINNED key is the actual trust boundary (a checksum alone is never
 *  sufficient — whoever tampers the artifact can tamper its manifest checksum).
 *  Both must pass; an empty pinned key fails closed. */
export const verifyArtifactFile = (input: VerifyArtifactInput): VerifyArtifactResult => {
  if (!input.trustedPubkey) return { ok: false, reason: 'no trusted release key' };
  if (!existsSync(input.filePath)) return { ok: false, reason: 'artifact missing' };
  // Read ONCE — hashing and verifying must cover the SAME bytes. Two separate
  // reads would open a TOCTOU where the sha256 matches bytes A while the
  // signature is valid for bytes B swapped in between.
  let buf: Buffer;
  try {
    buf = readFileSync(input.filePath);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'read error' };
  }
  if (createHash('sha256').update(buf).digest('hex') !== input.sha256) {
    return { ok: false, reason: 'sha256 mismatch' };
  }
  const v = verify({ content: buf, signatureText: input.sig, publicKeyText: input.trustedPubkey });
  return v.ok ? { ok: true } : { ok: false, reason: v.reason ?? 'signature verification failed' };
};

/** Preserve the running binary as `oldPath`, then move the (already-verified)
 *  `stagedPath` into `binaryPath`. Order is rename-old-then-move-new (Windows
 *  can't overwrite a running image's name in place; POSIX is fine either way).
 *
 *  CONTRACT (slice-4 orchestrator): `stagedPath` MUST be a same-filesystem,
 *  ALREADY-VERIFIED (`verifyArtifactFile → ok`) temp file beside the target —
 *  never the live binary path. `download → verifyArtifactFile(ok) →
 *  preserveAndSwap` is an indivisible gate.
 *
 *  Crash-safety: the move is wrapped so a failure of the second rename can
 *  never leave `binaryPath` empty — the preserved `recued.old` is renamed back.
 *  A cross-device staged file fails the move while the current binary is still
 *  intact (we only renamed it aside, then restore it). */
export const preserveAndSwap = (stagedPath: string, binaryPath: string, oldPath: string): void => {
  // Make the staged file executable BEFORE it goes live (a post-swap chmod
  // failure would otherwise install a non-executable binary).
  try {
    chmodSync(stagedPath, 0o755);
  } catch {
    /* best-effort; Windows ignores the mode */
  }
  const binSig = sigPathOf(binaryPath);
  const oldSig = sigPathOf(oldPath);
  const stagedSig = sigPathOf(stagedPath);

  // Preserve the OUTGOING binary AND its signature as the `recued.old` pair
  // FIRST — together, before the staged binary goes live. This guarantees the
  // rollback target is always a VERIFIED pair: a crash anywhere in the
  // subsequent staged-swap window leaves `recued.old` + `recued.old.minisig`
  // intact, so the launcher's re-verify can always fall back rather than brick.
  const preserved = existsSync(binaryPath);
  if (preserved) {
    if (existsSync(oldPath)) rmSync(oldPath); // drop a stale prior-apply backup
    if (existsSync(oldSig)) rmSync(oldSig);
    renameSync(binaryPath, oldPath);
    if (existsSync(binSig)) {
      try {
        renameSync(binSig, oldSig);
      } catch {
        /* best-effort — the old binary still reverts; verify may fall through */
      }
    }
  }
  try {
    renameSync(stagedPath, binaryPath);
  } catch (err) {
    // Recover: never leave the install without a working binary (restore the
    // preserved pair).
    if (preserved && !existsSync(binaryPath) && existsSync(oldPath)) {
      renameSync(oldPath, binaryPath);
      if (existsSync(oldSig)) {
        try {
          renameSync(oldSig, binSig);
        } catch {
          /* best-effort */
        }
      }
    }
    throw err;
  }
  // Move the verified staged signature into place beside the now-live binary.
  if (existsSync(stagedSig)) {
    try {
      renameSync(stagedSig, binSig);
    } catch {
      /* best-effort */
    }
  }
};

/** Swap `recued.old` back into `binaryPath` (rollback's binary half) via an
 *  atomic same-fs rename (replaces the destination; never leaves it empty).
 *  Throws if there is no preserved previous binary — the caller's
 *  `decideRollback` MUST have returned a non-`refuse` action first. */
export const rollbackSwap = (oldPath: string, binaryPath: string): void => {
  if (!existsSync(oldPath)) throw new Error('rollbackSwap: no recued.old to restore');
  // POSIX rename replaces the destination atomically; on Windows the target
  // name must be free, so drop the (to-be-replaced) current binary first there.
  if (process.platform === 'win32' && existsSync(binaryPath)) rmSync(binaryPath);
  renameSync(oldPath, binaryPath);
  try {
    chmodSync(binaryPath, 0o755);
  } catch {
    /* best-effort */
  }
  // Restore the previous binary's signature sidecar too (best-effort), so a
  // post-rollback launcher re-verify pairs the restored binary with its own sig.
  const binSig = sigPathOf(binaryPath);
  const oldSig = sigPathOf(oldPath);
  try {
    if (existsSync(oldSig)) {
      if (process.platform === 'win32' && existsSync(binSig)) rmSync(binSig);
      renameSync(oldSig, binSig);
    } else if (existsSync(binSig)) {
      rmSync(binSig); // no sig for the restored binary — drop the stale one
    }
  } catch {
    /* best-effort */
  }
};

/** Copy the SQLite file to `snapshotPath` before a migrating boot (mechanism c).
 *  Injected `backup` does the consistent copy (`VACUUM INTO` in production); CAS
 *  is content-addressed + append-only so it is NOT snapshotted. */
export type DbBackupFn = (snapshotPath: string) => Promise<void>;

export const takeSnapshot = async (backup: DbBackupFn, snapshotPath: string): Promise<void> => {
  await backup(snapshotPath);
};

/** Restore a pre-migration snapshot over the live db path (rollback's data half —
 *  accepts loss of post-update writes). Throws if the snapshot is gone.
 *
 *  The live DB runs in WAL mode (`journal_mode = WAL`), so `-wal` / `-shm`
 *  sidecars sit beside it, and after a failed migrating boot they hold
 *  POST-migration frames. So: copy the snapshot to a same-dir temp (fsynced),
 *  delete the sidecars, then atomically rename the temp over the main file
 *  (fsyncing the dir). Crash-consistency, walked:
 *   - The dangerous state — an old-schema main file paired with a migrated WAL
 *     (SQLite would replay the WAL → corruption) — NEVER occurs: the sidecars are
 *     removed before the main file is swapped, and a sidecar unlink that fails for
 *     any reason OTHER than "already absent" is FATAL (we throw before the rename,
 *     leaving the current DB intact for a retry).
 *   - The one residual crash window (between sidecar removal and the rename)
 *     leaves the current migrated main file minus any *uncheckpointed* WAL tail —
 *     a valid, openable database (the rollback simply didn't complete and is
 *     retried), never a torn or corrupt file. */
export const restoreSnapshot = (snapshotPath: string, dbPath: string, copyFile: (from: string, to: string) => void): void => {
  if (!existsSync(snapshotPath)) throw new Error('restoreSnapshot: snapshot missing');
  const staged = `${dbPath}.restoring`;
  copyFile(snapshotPath, staged);
  fsyncFile(staged);
  // Drop the live WAL/SHM/journal sidecars BEFORE swapping the main file in. A
  // missing sidecar (non-WAL / already checkpointed) is fine and skipped; any
  // OTHER unlink failure is FATAL — proceeding would strand a migrated WAL beside
  // the old-schema main file, the exact corruption this guards against.
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try {
      rmSync(`${dbPath}${suffix}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  renameSync(staged, dbPath);
  fsyncDir(dirname(dbPath));
};

/** Best-effort temp-file cleanup after a failed/aborted stage. */
export const discardStaged = (stagedPath: string): void => {
  try {
    if (existsSync(stagedPath) && statSync(stagedPath).isFile()) rmSync(stagedPath);
  } catch {
    /* nothing to clean */
  }
  try {
    const stagedSig = sigPathOf(stagedPath);
    if (existsSync(stagedSig) && statSync(stagedSig).isFile()) rmSync(stagedSig);
  } catch {
    /* nothing to clean */
  }
};
