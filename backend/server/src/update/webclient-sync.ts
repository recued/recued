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
 *  The launcher never touches the webclient dir — the SERVER owns this.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { unpackWebclientArchive } from '@recued/release';
import type { VerifyArtifactInput, VerifyArtifactResult } from './binary-apply-executor.js';

/** Hard bound on the webclient download so a stalled connection can NEVER wedge
 *  the apply: `runApply` awaits this sync AFTER the binary swap + before the
 *  restart, and the default `fetch`-based download has no timeout of its own —
 *  an unbounded hang there (unlike a thrown error) is not caught by the caller's
 *  try/catch and would strand the staged binary un-restarted. A timeout turns a
 *  hang into a caught rejection so the restart always proceeds (best-effort). */
export const DEFAULT_WEBCLIENT_DOWNLOAD_TIMEOUT_MS = 60_000;

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
  /** Structured log sink (best-effort observability). */
  log?: (level: 'info' | 'warn', message: string) => void;
}

export type WebclientSyncResult = { ok: true; version: string } | { ok: false; reason: string };

const safeRm = (p: string): void => {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
    /* best-effort */
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
    return { ok: false, reason: 'no_target_dir' };
  }
  if (!deps.trustedPubkey) {
    log('warn', 'webclient sync skipped: no trusted release key');
    return { ok: false, reason: 'not_configured' };
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
    return { ok: false, reason: 'download_failed' };
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
    return { ok: false, reason: `verify_failed:${v.reason}` };
  }

  // 3. Unpack — per-file sha256 over the now-verified archive bytes.
  let archiveText: string;
  try {
    archiveText = readFileSync(deps.stagingPath, 'utf8');
  } catch {
    safeRm(deps.stagingPath);
    log('warn', 'webclient sync: staged archive unreadable');
    return { ok: false, reason: 'staged_unreadable' };
  }
  safeRm(deps.stagingPath); // done with the download regardless of the outcome below
  const unpacked = unpackWebclientArchive(archiveText);
  if (!unpacked.ok) {
    log('warn', `webclient sync: archive invalid — ${unpacked.reason}`);
    return { ok: false, reason: `unpack_failed:${unpacked.reason}` };
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
    safeRm(backup);
    let moved = false;
    if (existsSync(deps.targetDir)) {
      renameSync(deps.targetDir, backup);
      moved = true;
    }
    try {
      renameSync(tmpDir, deps.targetDir);
    } catch (err) {
      if (moved && !existsSync(deps.targetDir)) renameSync(backup, deps.targetDir); // restore
      throw err;
    }
    tmpDir = null; // renamed into place — no longer ours to clean up
    safeRm(backup);
  } catch (err) {
    if (tmpDir) safeRm(tmpDir);
    log('warn', `webclient sync: extract failed — ${err instanceof Error ? err.message : 'error'}`);
    return { ok: false, reason: 'extract_failed' };
  }

  log('info', `webclient sync: extracted ${unpacked.files.length} file(s) (v${unpacked.version}) → ${deps.targetDir}`);
  return { ok: true, version: unpacked.version };
};
