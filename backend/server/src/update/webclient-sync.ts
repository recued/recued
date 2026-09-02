/** D-178 + D-152 § A.16 — webclient bundle self-sync for the self-updating
 *  server (`:managed` docker-thin + the binary channel).
 *
 *  The baked `:vX.Y.Z` image bakes a version-matched webclient (RECUED_WEBCLIENT_DIR
 *  → /opt/recued/webclient) and never self-updates. The self-updating channels
 *  swap the server binary in place, so their webclient must travel WITH the signed
 *  release and be re-extracted on apply — else it goes stale (Dockerfile.managed).
 *  This is that extraction step: given the manifest's `webclient` artifact, it
 *  downloads the signed archive, verifies it (the SAME minisign + sha256 gate the
 *  binary uses), unpacks it (per-file sha256), and ATOMICALLY replaces
 *  RECUED_WEBCLIENT_DIR so the self-updated server serves a matched `/webclient/*`.
 *
 *  NON-FATAL by construction: the binary update is the critical path. A failure
 *  here leaves the PRIOR bundle in place (the D-152 loader re-verifies the
 *  directory on the next boot → serves the old bundle or goes dormant, never
 *  broken), so `runApply` treats it as best-effort and never blocks the restart.
 *  Apply owns promotion; the shared rollback transaction restores the displaced
 *  bundle with the executable when a staged release is reverted.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import {
  WEBCLIENT_BUNDLE_MANIFEST_FILENAME,
  verifyWebclientBundle,
  type WebclientBundleManifest,
} from '@recued/contracts';
import { unpackWebclientArchive } from '@recued/release';
import type { VerifyArtifactInput, VerifyArtifactResult } from './binary-apply-executor.js';
import { fsyncDir, writeFileAtomicSync } from '../durable-fs.js';

/** Hard bound on the webclient download so a stalled connection can NEVER wedge
 *  the apply: `runApply` awaits this sync before requesting the restart, and the
 *  default `fetch`-based download has no timeout of its own. A timeout turns an
 *  unbounded hang into a caught rejection so the binary path can proceed. */
export const DEFAULT_WEBCLIENT_DOWNLOAD_TIMEOUT_MS = 60_000;

/** Where the bundle displaced by the PREVIOUS successful sync waits while this
 *  apply is still abortable. Distinct from `.old`, which always names the
 *  bundle displaced by the sync that just ran. */
export const WEBCLIENT_APPLY_ASIDE = '.apply-aside';
/** A promoted bundle parked while its abort is made crash-idempotent. It stays
 * until the apply journal is durably cleared, so retrying recovery can never
 * mistake the restored live bundle for the candidate and roll back twice. */
export const WEBCLIENT_ABORT_ASIDE = '.abort-aside';
/** A real `.old` directory whose marker means the displaced generation was
 * absent. Encoding absence in the same rename chain as a real bundle makes a
 * first-install promotion recoverable after process restart, when the in-memory
 * sync descriptor is gone. */
export const WEBCLIENT_ABSENT_MARKER = '.recued-absent';
/** Durable witness for a webclient mutation that happened before the binary
 * swap. The ledger alone cannot describe it: a process can die after promoting
 * the UI but before `apply_staged` is appended. */
export const WEBCLIENT_APPLY_JOURNAL_SUFFIX = '.apply-journal.json';

export interface WebclientApplyIdentity {
  releaseIdentity: string;
  operationId: string;
}

export interface WebclientApplyJournal extends WebclientApplyIdentity {
  schema: 1;
  effect: Exclude<WebclientSyncEffect, 'none'>;
}

const withTimeout = async <T>(p: Promise<T>, ms: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export interface WebclientSyncDeps {
  /** Download the archive URL to `destPath` (reuse the binary path's `defaultDownload`). */
  download: (url: string, destPath: string) => Promise<void>;
  /** Hard timeout for the download (default `DEFAULT_WEBCLIENT_DOWNLOAD_TIMEOUT_MS`).
   *  Bounds the ONLY step that can hang; the rest is local sync I/O. */
  downloadTimeoutMs?: number;
  /** Fail-closed minisign + sha256 verify (reuse `verifyArtifactFile`). */
  verifyArtifact: (input: VerifyArtifactInput) => VerifyArtifactResult;
  /** The pinned trusted release pubkey. Empty → skip (can't verify → won't write). */
  trustedPubkey: string;
  /** RECUED_WEBCLIENT_DIR (via `resolveWebclientBundleDir`). Undefined → skip. */
  targetDir: string | undefined;
  /** Scratch path for the downloaded archive — on the SAME filesystem as
   *  `targetDir` so the atomic rename swap works (a sibling temp file). */
  stagingPath: string;
  /** Identity of the `apply_started` ledger entry that owns this promotion.
   * Required whenever a target directory is configured: without it a crash
   * could leave a newer UI in front of the old binary with no durable recovery
   * witness. */
  applyIdentity?: WebclientApplyIdentity;
  /** Structured log sink (best-effort observability). */
  log?: (level: 'info' | 'warn', message: string) => void;
}

/** Exact filesystem mutation made by one sync attempt. The apply orchestrator
 *  carries this descriptor until its binary transaction either stages or
 *  aborts, so an abort can undo first-install promotion and pre-download backup
 *  parking just as precisely as a replacement. */
export type WebclientSyncEffect =
  | 'none'
  | 'backup-parked'
  | 'bundle-replaced'
  | 'bundle-created';

export type WebclientSyncResult =
  | { ok: true; version: string; effect: WebclientSyncEffect }
  | { ok: false; reason: string; effect: WebclientSyncEffect };

const safeRm = (p: string): void => {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
};

export const webclientApplyJournalPath = (targetDir: string): string =>
  `${targetDir}${WEBCLIENT_APPLY_JOURNAL_SUFFIX}`;

const isEffect = (value: unknown): value is Exclude<WebclientSyncEffect, 'none'> =>
  value === 'backup-parked' || value === 'bundle-replaced' || value === 'bundle-created';

export const readWebclientApplyJournal = (
  targetDir: string | undefined,
): WebclientApplyJournal | null => {
  if (!targetDir) return null;
  try {
    const value = JSON.parse(readFileSync(webclientApplyJournalPath(targetDir), 'utf8')) as Partial<WebclientApplyJournal>;
    if (
      value.schema !== 1
      || typeof value.releaseIdentity !== 'string'
      || value.releaseIdentity.length === 0
      || typeof value.operationId !== 'string'
      || value.operationId.length === 0
      || !isEffect(value.effect)
    ) return null;
    return value as WebclientApplyJournal;
  } catch {
    return null;
  }
};

const writeWebclientApplyJournal = (
  targetDir: string,
  identity: WebclientApplyIdentity,
  effect: Exclude<WebclientSyncEffect, 'none'>,
): void => {
  writeFileAtomicSync(
    webclientApplyJournalPath(targetDir),
    `${JSON.stringify({ schema: 1, ...identity, effect })}\n`,
  );
  fsyncDir(dirname(targetDir));
};

export const clearWebclientApplyJournal = (
  targetDir: string | undefined,
  expected?: WebclientApplyIdentity,
): boolean => {
  if (!targetDir) return false;
  const path = webclientApplyJournalPath(targetDir);
  if (!existsSync(path)) return false;
  if (expected) {
    const current = readWebclientApplyJournal(targetDir);
    if (
      !current
      || current.releaseIdentity !== expected.releaseIdentity
      || current.operationId !== expected.operationId
    ) return false;
  }
  try {
    rmSync(path, { force: true });
    fsyncDir(dirname(targetDir));
    return true;
  } catch {
    return false;
  }
};

/** Download → verify → unpack → atomically extract the webclient archive to
 *  `targetDir`. Never throws — every failure returns `{ ok: false, reason }`
 *  (the caller treats a non-ok result as a best-effort miss). */
export const syncWebclientBundle = async (
  deps: WebclientSyncDeps,
  artifact: { url: string; sha256: string; sig: string },
): Promise<WebclientSyncResult> => {
  const log = deps.log ?? ((): void => {});
  if (!deps.targetDir) {
    log('warn', 'webclient sync skipped: no webclient dir resolved (RECUED_WEBCLIENT_DIR / CAS root)');
    return { ok: false, reason: 'no_target_dir', effect: 'none' };
  }
  if (!deps.trustedPubkey) {
    log('warn', 'webclient sync skipped: no trusted release key');
    return { ok: false, reason: 'not_configured', effect: 'none' };
  }
  if (!deps.applyIdentity?.releaseIdentity || !deps.applyIdentity.operationId) {
    log('warn', 'webclient sync skipped: no durable apply identity');
    return { ok: false, reason: 'journal_identity_required', effect: 'none' };
  }
  if (existsSync(webclientApplyJournalPath(deps.targetDir))) {
    log('warn', 'webclient sync skipped: a prior apply journal still needs recovery');
    return { ok: false, reason: 'journal_in_flight', effect: 'none' };
  }

  let effect: WebclientSyncEffect = 'none';

  // A completed abort may leave only its disposable candidate aside if cleanup
  // itself was interrupted after the journal commit point. It belongs to no
  // active operation once the journal is absent and must not shadow this sync.
  safeRm(`${deps.targetDir}${WEBCLIENT_ABORT_ASIDE}`);
  if (existsSync(`${deps.targetDir}${WEBCLIENT_ABORT_ASIDE}`)) {
    log('warn', 'webclient sync skipped: an abandoned abort candidate could not be removed');
    return { ok: false, reason: 'abort_cleanup_failed', effect: 'none' };
  }

  // ⛔⛔ RETIRE ANY STALE ASIDE, THEN PARK THE PRIOR BACKUP. It used to leave
  // the previous generation directly at `<targetDir>.old`, so a failed sync made
  // the later binary rollback put the wrong UI generation back:
  //
  //     R1 backup, R2 live UI, R3 sync FAILS  ->  rollback R3->R2
  //     gave an R2 server with an R1 UI.
  //
  // The aside makes both outcomes explicit. A successful promotion writes the
  // bundle it displaced to `.old`; a failed attempt reports `backup-parked`, so
  // abort recovery rebuilds `.old` without touching the still-correct live R2 UI.
  if (deps.targetDir !== undefined) {
    // ⛔⛔ SET ASIDE, NOT DELETED — the same generational loss the binary swap
    // had. Clearing the backup here means an apply that syncs successfully and
    // then ABORTS (a failed drain, a failed snapshot) restores the previous
    // bundle over the live one and leaves the release BEFORE it with no rollback
    // UI at all: the server is healthy on R2 and its R1 backup is gone, removed
    // by a run that changed nothing else.
    //
    // ⚠ CLEARED AT THE START OF THE NEXT SYNC, not at commit. That keeps at most
    // ONE aside on disk without needing a commit-time hook the sync does not
    // have — the same self-limiting shape `.old` itself already uses.
    safeRm(`${deps.targetDir}${WEBCLIENT_APPLY_ASIDE}`);
    try {
      if (existsSync(`${deps.targetDir}.old`)) {
        // Journal BEFORE rename. If the process dies on either side of it,
        // recovery can distinguish the states from `.old` / `.apply-aside`.
        writeWebclientApplyJournal(deps.targetDir, deps.applyIdentity, 'backup-parked');
        renameSync(`${deps.targetDir}.old`, `${deps.targetDir}${WEBCLIENT_APPLY_ASIDE}`);
        effect = 'backup-parked';
      }
    } catch (err) {
      // The parked generation is still the live release's rollback target.
      // Losing it for a best-effort UI refresh is never acceptable; leave the
      // current bundle and backup untouched and let the binary update proceed.
      clearWebclientApplyJournal(deps.targetDir, deps.applyIdentity);
      log('warn', `webclient sync: could not park prior backup — ${err instanceof Error ? err.message : 'error'}`);
      return { ok: false, reason: 'backup_park_failed', effect: 'none' };
    }
  }

  // 1. Download the signed archive — hard-bounded so a stalled connection can't
  //    wedge the caller (which awaits this before the restart). A timeout rejects
  //    (caught below), never hangs. The download is the ONLY step that can block;
  //    unpack + the atomic extract below are local sync I/O.
  try {
    await withTimeout(
      deps.download(artifact.url, deps.stagingPath),
      deps.downloadTimeoutMs ?? DEFAULT_WEBCLIENT_DOWNLOAD_TIMEOUT_MS,
      'webclient download',
    );
  } catch (err) {
    safeRm(deps.stagingPath);
    log('warn', `webclient sync: download failed — ${err instanceof Error ? err.message : 'error'}`);
    return { ok: false, reason: 'download_failed', effect };
  }

  // 2. Verify — the SAME minisign + sha256 gate the binary artifact passes.
  const v = deps.verifyArtifact({
    filePath: deps.stagingPath,
    sha256: artifact.sha256,
    sig: artifact.sig,
    trustedPubkey: deps.trustedPubkey,
  });
  if (!v.ok) {
    safeRm(deps.stagingPath);
    log('warn', `webclient sync: verify failed — ${v.reason}`);
    return { ok: false, reason: `verify_failed:${v.reason}`, effect };
  }

  // 3. Unpack — per-file sha256 over the now-verified archive bytes.
  let archiveText: string;
  try {
    archiveText = readFileSync(deps.stagingPath, 'utf8');
  } catch {
    safeRm(deps.stagingPath);
    log('warn', 'webclient sync: staged archive unreadable');
    return { ok: false, reason: 'staged_unreadable', effect };
  }
  safeRm(deps.stagingPath); // done with the download regardless of the outcome below
  const unpacked = unpackWebclientArchive(archiveText);
  if (!unpacked.ok) {
    log('warn', `webclient sync: archive invalid — ${unpacked.reason}`);
    return { ok: false, reason: `unpack_failed:${unpacked.reason}`, effect };
  }

  // The outer signed archive authenticates transport, but the directory loader
  // trusts the inner manifest as its served-file allowlist. Verify that manifest
  // one-to-one against the unpacked bytes BEFORE any live filesystem mutation.
  const innerManifestFile = unpacked.files.find(
    (file) => file.path === WEBCLIENT_BUNDLE_MANIFEST_FILENAME,
  );
  let innerManifest: WebclientBundleManifest | null = null;
  try {
    innerManifest = innerManifestFile
      ? JSON.parse(Buffer.from(innerManifestFile.bytes).toString('utf8')) as WebclientBundleManifest
      : null;
  } catch {
    innerManifest = null;
  }
  const servedFiles = unpacked.files
    .filter((file) => file.path !== WEBCLIENT_BUNDLE_MANIFEST_FILENAME)
    .map((file) => ({
      path: file.path,
      bytes: file.bytes,
      sha256: createHash('sha256').update(file.bytes).digest('hex'),
    }));
  let innerVerified = null;
  try {
    innerVerified = innerManifest && Array.isArray(innerManifest.files)
      ? verifyWebclientBundle(innerManifest, servedFiles)
      : null;
  } catch {
    innerVerified = null;
  }
  if (!innerVerified?.ok) {
    const detail = innerVerified && !innerVerified.ok
      ? innerVerified.issues.map((issue) => issue.code).join(',')
      : 'missing_or_malformed_manifest';
    log('warn', `webclient sync: inner manifest invalid — ${detail}`);
    return { ok: false, reason: `inner_manifest_invalid:${detail}`, effect };
  }

  // 4. Atomic extract: write into a fresh sibling temp dir, then rename it over
  //    `targetDir` (moving any prior bundle aside first, restoring it if the
  //    final rename fails — the install is never left webclient-less on error).
  const parent = dirname(deps.targetDir);
  let tmpDir: string | null = null;
  try {
    mkdirSync(parent, { recursive: true });
    tmpDir = mkdtempSync(join(parent, '.webclient-sync-'));
    const root = tmpDir;
    for (const f of unpacked.files) {
      const abs = join(root, f.path);
      // Defense-in-depth: `unpackWebclientArchive` already rejects traversal, but
      // re-check containment at the write boundary before touching the fs.
      if (abs !== root && !abs.startsWith(root + sep)) {
        throw new Error(`unsafe path escaped the bundle root: ${f.path}`);
      }
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, f.bytes);
    }
    // Replace via move-aside: rename the prior bundle to `.old`, then the new one
    // in. Replacing a non-empty dir isn't atomic (rename(2) can't overwrite one),
    // so there is a microsecond gap where the target is absent — a crash there
    // leaves it missing, which the loader reads as "no bundle" (dormant/404, safe,
    // NOT broken) and the next apply re-syncs a fresh dir. Accepted (bounded +
    // self-healing); the alternative (leave the old in place) can't be atomic either.
    const backup = `${deps.targetDir}.old`;
    safeRm(backup);   // already cleared at entry; belt-and-braces against a retry
    const targetExisted = existsSync(deps.targetDir);
    const priorEffect = effect;
    const promotionEffect = targetExisted ? 'bundle-replaced' : 'bundle-created';
    // Journal BEFORE the first mutation of the live generation. This closes the
    // kill window between moving the old target and promoting the new one.
    writeWebclientApplyJournal(deps.targetDir, deps.applyIdentity, promotionEffect);
    let moved = false;
    if (targetExisted) {
      renameSync(deps.targetDir, backup);
      moved = true;
    } else {
      // A rollback target can be "there was no bundle". Persist that as a tiny
      // sentinel generation before promotion so an auto-revert after restart
      // removes the newly-created UI instead of leaving it ahead of the server.
      mkdirSync(backup, { recursive: true });
      writeFileAtomicSync(join(backup, WEBCLIENT_ABSENT_MARKER), '1\n');
      fsyncDir(parent);
    }
    try {
      renameSync(tmpDir, deps.targetDir);
      fsyncDir(parent);
    } catch (err) {
      if (moved && !existsSync(deps.targetDir)) renameSync(backup, deps.targetDir); // restore
      if (!moved) safeRm(backup);
      effect = priorEffect;
      if (priorEffect === 'none') clearWebclientApplyJournal(deps.targetDir, deps.applyIdentity);
      else writeWebclientApplyJournal(deps.targetDir, deps.applyIdentity, priorEffect);
      throw err;
    }
    tmpDir = null; // renamed into place — no longer ours to clean up
    effect = promotionEffect;
    // ⛔⛔ THE PREVIOUS BUNDLE IS KEPT, NOT DELETED. It used to be removed the
    // instant the new one landed, and the binary rollback has no webclient
    // awareness at all — so reverting to the previous SERVER left the NEWER UI
    // in place, talking to it. `<targetDir>.old` is now the revert target,
    // exactly as `recued.old` is for the executable, and the `safeRm(backup)`
    // above still clears a STALE one at the start of the next apply, so at most
    // one generation is ever kept.
  } catch (err) {
    if (tmpDir) safeRm(tmpDir);
    const journal = readWebclientApplyJournal(deps.targetDir);
    if (
      journal
      && journal.releaseIdentity === deps.applyIdentity.releaseIdentity
      && journal.operationId === deps.applyIdentity.operationId
      && undoWebclientSync(deps.targetDir, journal.effect, deps.applyIdentity)
    ) {
      effect = 'none';
    }
    log('warn', `webclient sync: extract failed — ${err instanceof Error ? err.message : 'error'}`);
    return { ok: false, reason: 'extract_failed', effect };
  }

  log('info', `webclient sync: extracted ${unpacked.files.length} file(s) (v${unpacked.version}) → ${deps.targetDir}`);
  return { ok: true, version: unpacked.version, effect };
};

/** Undo exactly one pre-commit sync attempt. This differs from a later release
 * rollback: a first-install promotion has no `.old`, so its undo must REMOVE the
 * created live bundle, while a failed download may have parked only an older
 * backup and must not touch the live bundle at all. */
export const undoWebclientSync = (
  targetDir: string | undefined,
  effect: WebclientSyncEffect,
  expected?: WebclientApplyIdentity,
): boolean => {
  if (!targetDir || effect === 'none') return false;
  const backup = `${targetDir}.old`;
  const aside = `${targetDir}${WEBCLIENT_APPLY_ASIDE}`;
  const abortAside = `${targetDir}${WEBCLIENT_ABORT_ASIDE}`;
  const journalPath = webclientApplyJournalPath(targetDir);
  try {
    if (expected) {
      const current = readWebclientApplyJournal(targetDir);
      if (
        !current
        || current.releaseIdentity !== expected.releaseIdentity
        || current.operationId !== expected.operationId
        || current.effect !== effect
      ) return false;
    }

    const clearOwnedJournal = (): boolean => {
      const cleared = clearWebclientApplyJournal(targetDir, expected);
      return cleared || !existsSync(journalPath);
    };

    switch (effect) {
      case 'backup-parked':
        if (!existsSync(backup) && existsSync(aside)) renameSync(aside, backup);
        fsyncDir(dirname(targetDir));
        return clearOwnedJournal();
      case 'bundle-replaced':
        // Park the promoted candidate instead of deleting it. The parked path is
        // the durable phase witness: until the journal is gone, a retry knows the
        // live directory is already the restored generation and must not consume
        // `<target>.old` a second time.
        if (!existsSync(abortAside)) {
          if (existsSync(backup) && existsSync(targetDir)) {
            renameSync(targetDir, abortAside);
            fsyncDir(dirname(targetDir));
          } else {
            mkdirSync(abortAside, { recursive: true });
            writeFileAtomicSync(join(abortAside, WEBCLIENT_ABSENT_MARKER), '1\n');
            fsyncDir(dirname(targetDir));
          }
        }
        if (!existsSync(targetDir) && existsSync(backup)) {
          renameSync(backup, targetDir);
          fsyncDir(dirname(targetDir));
        }
        if (!existsSync(targetDir)) return false;
        if (existsSync(aside) && !existsSync(backup)) {
          renameSync(aside, backup);
          fsyncDir(dirname(targetDir));
        }
        fsyncDir(dirname(targetDir));
        if (!clearOwnedJournal()) return false;
        safeRm(abortAside);
        fsyncDir(dirname(targetDir));
        return true;
      case 'bundle-created':
        if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
        // Remove only this operation's absence sentinel. On a recovery retry,
        // `backup` may already be the real generation restored from `aside`;
        // deleting it again would lose one generation after a journal-unlink
        // failure. An empty directory is the crash window after mkdir and before
        // the sentinel marker write; a real webclient generation is never empty.
        const backupIsAbsence = existsSync(join(backup, WEBCLIENT_ABSENT_MARKER))
          || (existsSync(backup) && readdirSync(backup).length === 0);
        if (backupIsAbsence) safeRm(backup);
        if (backupIsAbsence && existsSync(backup)) return false;
        if (existsSync(aside) && !existsSync(backup)) renameSync(aside, backup);
        fsyncDir(dirname(targetDir));
        return clearOwnedJournal();
    }
  } catch {
    return false;
  }
};

/** Recover a pre-swap promotion after process death. A journal for another
 * operation is never consumed: that is evidence of a different unresolved
 * transaction and must remain available for diagnosis/recovery. */
export const recoverAbortedWebclientSync = (
  targetDir: string | undefined,
  expected: WebclientApplyIdentity,
): boolean => {
  if (!targetDir) return true;
  const journalPath = webclientApplyJournalPath(targetDir);
  if (!existsSync(journalPath)) return true;
  const journal = readWebclientApplyJournal(targetDir);
  if (
    !journal
    || journal.releaseIdentity !== expected.releaseIdentity
    || journal.operationId !== expected.operationId
  ) return false;
  return undoWebclientSync(targetDir, journal.effect, expected);
};
