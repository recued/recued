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
import { dirname, join } from 'node:path';
import {
  WEBCLIENT_ABSENT_MARKER,
  WEBCLIENT_APPLY_ASIDE,
} from './webclient-sync.js';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { discardResponseBody, fetchOriginPinned } from '@recued/ingredients';
import { verify } from '@recued/release';
import { fsyncDir, fsyncFile } from '../durable-fs.js';

/** Detached-signature sidecar suffix written beside the binary on the volume so
 *  the D-178 thin `:managed` launcher can RE-VERIFY before exec (I-2 second
 *  verification — defense in depth against a tampered volume). The launcher
 *  duplicates this constant (`launcher/managed-launcher.ts` — it imports nothing
 *  from the server bundle, I-9); keep the two in lockstep. */
export const SIG_SIDECAR_SUFFIX = '.minisig';

const sigPathOf = (path: string): string => `${path}${SIG_SIDECAR_SUFFIX}`;

/** Move `from`'s detached signature to sit beside `to`.
 *
 *  ⛔ A MISSING SOURCE MUST NOT DELETE THE DESTINATION. Payload and signature are
 *  two atomic renames, so process death can leave the outgoing payload at `from`
 *  while its still-correct signature remains beside `to`. Recovery first moves
 *  that payload back to `to`; deleting `to`'s signature here then turns a
 *  recoverable split pair into an unsigned live binary. A stale destination is
 *  harmless — verification rejects it — while deleting a valid one bricks the
 *  managed launcher before server-side recovery can run.
 *
 *  Errors are transactional: the managed launcher
 *  refuses a binary/addon whose signature is missing, so suppressing a failed
 *  signature rename converts a successful file swap into a guaranteed boot
 *  failure. Callers unwind the whole generation on a throw. */
const moveSigBeside = (from: string, to: string): void => {
  const fromSig = sigPathOf(from);
  const toSig = sigPathOf(to);
  if (existsSync(fromSig)) {
    if (existsSync(toSig)) rmSync(toSig);
    renameSync(fromSig, toSig);
  }
};

/** Persist the verified artifact's detached signature beside the STAGED binary
 *  so `preserveAndSwap` moves it into place atomically with the swap. Only the
 *  thin launcher consumes it; the binary channel writes it harmlessly. */
export const writeStagedSig = (stagedPath: string, sig: string): void => {
  const path = sigPathOf(stagedPath);
  writeFileSync(path, sig, 'utf8');
  fsyncFile(path);
  fsyncDir(dirname(path));
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

/** Ceiling on a downloaded update artifact.
 *
 *  ⛔⛔ WAS 128 MiB, AND EVERY BINARY WE SHIP WAS BIGGER THAN THAT. Measured
 *  against the live stable feed on 2026-08-27:
 *
 *      macos-arm64    139,920,256   over
 *      linux-arm64    141,626,496   over
 *      linux-x64      145,558,720   over
 *      windows-x64    109,505,536   under
 *
 *  Three of four platforms could therefore never self-update: the download
 *  refused its own release as too large before a byte was written, surfacing as
 *  `download-failed`. That is the SERVER's in-app apply too, not just the CLI —
 *  same executor, same constant. Found by driving a real 26.8.24 binary at the
 *  real feed; no test could see it, because every test injects `download`.
 *
 *  🔑 THIS IS A RESOURCE GUARD, NOT A TRUST BOUNDARY, which is what makes the
 *  headroom cheap. Nothing is executed on the strength of having been
 *  downloaded — `verifyArtifactFile` checks sha256 AND the detached minisign
 *  signature against the pinned key before anything moves into place. The cap
 *  only bounds how much disk a hostile or broken endpoint can make us spend, and
 *  `UPDATE_MIN_FREE_HEADROOM_BYTES` is the real protection there.
 *
 *  512 MiB is ~3.5x the largest artifact today. The SEA grows with Node itself
 *  plus the bundled recipes, so pick headroom in multiples, not megabytes —
 *  and `release-build.mjs` now refuses to PUBLISH an artifact above this, so
 *  the two can no longer drift apart silently. */
export const UPDATE_ARTIFACT_MAX_BYTES = 512 * 1024 * 1024;
export const UPDATE_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

export interface UpdateDownloadOptions {
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
}

export class UpdateArtifactTooLargeError extends Error {
  constructor(
    public readonly maxBytes: number,
    public readonly observedBytes?: number,
  ) {
    super(
      observedBytes === undefined
        ? `update artifact exceeds ${maxBytes}-byte limit`
        : `update artifact reached ${observedBytes} bytes (limit ${maxBytes})`,
    );
    this.name = 'UpdateArtifactTooLargeError';
  }
}

export const defaultDownload = async (
  url: string,
  destPath: string,
  options: UpdateDownloadOptions = {},
): Promise<void> => {
  const maxBytes = options.maxBytes ?? UPDATE_ARTIFACT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? UPDATE_DOWNLOAD_TIMEOUT_MS;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError('update artifact limit must be a positive safe integer');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('update download timeout must be a positive safe integer');
  }

  const origin = new URL(url).origin;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response | undefined;
  try {
    res = await fetchOriginPinned(
      options.fetchImpl ?? globalThis.fetch,
      url,
      { signal: controller.signal },
      origin,
    );
    if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);

    const declaredRaw = res.headers.get('content-length');
    if (declaredRaw !== null && /^\d+$/.test(declaredRaw.trim())) {
      const declared = Number(declaredRaw);
      if (Number.isSafeInteger(declared) && declared > maxBytes) {
        throw new UpdateArtifactTooLargeError(maxBytes, declared);
      }
    }

    let received = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
        received += chunk.byteLength;
        if (received > maxBytes) {
          callback(new UpdateArtifactTooLargeError(maxBytes, received));
          return;
        }
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
      limiter,
      createWriteStream(destPath),
    );
  } finally {
    if (res !== undefined) discardResponseBody(res);
    clearTimeout(timer);
  }
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
/** D-178 S1 rev 2 item 4 — the native sidecar's paths for one apply.
 *
 *  ⛔ The exe and its addon MUST move together. A new binary against the old
 *  `.node` is an N-API ABI mismatch that fails at the first database open —
 *  i.e. at boot, past the swap, where the only remaining safety net is the
 *  boot-failure counter. That net only works if the revert restores BOTH, which
 *  is why the old pair is preserved as a SET before either moves. */
export interface SidecarPaths {
  /** Verified staged addon, on the same filesystem as `livePath`. */
  stagedPath: string;
  /** Where the running binary looks: `<binDir>/lib/better_sqlite3.node`. */
  livePath: string;
  /** Preserved previous addon, the rollback target. */
  oldPath: string;
}

/** Persistence barriers for a multi-file payload transition. Injectable only so
 * tests can observe the on-disk state at each barrier; production always uses
 * the shared durable-fs primitives. */
export interface SwapDurability {
  fsyncFile: (path: string) => void;
  fsyncDir: (path: string) => void;
}

const DEFAULT_SWAP_DURABILITY: SwapDurability = { fsyncFile, fsyncDir };

const swapDirectories = (binaryPath: string, sidecar?: SidecarPaths): string[] =>
  [...new Set([
    dirname(binaryPath),
    ...(sidecar ? [dirname(sidecar.livePath)] : []),
  ])];

const syncSwapDirectories = (
  binaryPath: string,
  sidecar?: SidecarPaths,
  durability: SwapDurability = DEFAULT_SWAP_DURABILITY,
): void => {
  for (const dir of swapDirectories(binaryPath, sidecar)) durability.fsyncDir(dir);
};

/** The addon sidecar paths for a binary, honouring the same
 *  `RECUED_NATIVE_BINDING` override `open-database.ts` reads — the file the NEXT
 *  boot resolves is the one a swap or a revert has to aim at.
 *
 *  ⛔ ONE DEFINITION ON THE SERVER SIDE. The apply builds its SWAP targets from
 *  this and the supervised boot-failure revert builds its RESTORE targets from
 *  it, so a revert can never aim at a different file than the apply replaced. It
 *  was two hand-written copies, and the supervised one silently ignored
 *  `RECUED_NATIVE_BINDING` — on an install that sets it, the revert restored an
 *  addon nothing loads and left the live one from the abandoned release.
 *
 *  ⚠ `managed-launcher.ts` keeps its own copy ON PURPOSE: it is the frozen image
 *  launcher and may not import the server bundle. That pair stays in lockstep by
 *  the comment on `ADDON_RELATIVE_PATH`, which names this function. */
export const sidecarPathsFor = (
  binaryPath: string,
  env: NodeJS.ProcessEnv,
): SidecarPaths => {
  // ⚠ `??` WAS WRONG HERE, AND EMPTY IS THE VALUE A UNIT FILE ACTUALLY PRODUCES
  // (`Environment=RECUED_NATIVE_BINDING=`). An empty string is not nullish, so it
  // survived as the path and every swap target became `.staged` / `.old` in the
  // process's working directory.
  const override = env.RECUED_NATIVE_BINDING?.trim();
  const livePath = override || join(dirname(binaryPath), 'lib', 'better_sqlite3.node');
  return { stagedPath: `${livePath}.staged`, livePath, oldPath: `${livePath}.old` };
};

/** Every file whose bytes (or deliberate absence) define the previous install
 * generation consumed by `rollbackSwap`. Manual-rollback recovery journals this
 * exact list before its write-ahead commit so a later boot never feeds an
 * unwitnessed executable, addon, or detached signature into the destructive
 * rename transaction. Keep this next to `sigPathOf`: callers must not grow a
 * second hand-written definition of the rollback candidate set. */
export const rollbackCandidatePaths = (
  oldPath: string,
  sidecar?: SidecarPaths,
): string[] => [
  oldPath,
  sigPathOf(oldPath),
  ...(sidecar ? [sidecar.oldPath, sigPathOf(sidecar.oldPath)] : []),
];

/** The pre-migration snapshot's filename inside the realm's data dir. One name,
 *  because the apply WRITES it and two separate recovery paths READ it. */
/** Where the generation BEHIND the one an apply displaces waits.
 *
 *  ⛔⛔ ITS LIFETIME IS THE OPERATION, NOT THE SWAP — and getting that wrong is
 *  the residual this closes. The aside used to be dropped as soon as the rename
 *  succeeded, which covered a failed SWAP and not a failed BOOT: the two-phase
 *  apply commits on the next healthy start, so between the swap and that start
 *  the operation is still abortable. An auto-revert in that window consumes
 *  `recued.old` to put the previous release back and left it with NO rollback
 *  target — the same loss, one phase later.
 *
 *  ⇒ It now survives the restart. `dropApplyAside` runs at the boot-time COMMIT;
 *  `rollbackSwap` PROMOTES it when the revert consumes `recued.old` instead.
 *
 *  ⚠ Distinct from `.rollback-aside`, which belongs to `rollbackSwap` itself and
 *  is what `reconcileInterruptedPairSwap` keys crash recovery on. */
export const APPLY_ASIDE_SUFFIX = '.apply-aside';
const asideOf = (p: string): string => `${p}${APPLY_ASIDE_SUFFIX}`;

/** Drop the parked generation. Called at the boot-time commit, when the release
 *  that displaced it has proven it starts and the pre-apply state is finally
 *  unreachable. Best-effort: a leftover is swept by the next apply's own stash. */
export const dropApplyAside = (
  oldPath: string,
  sidecar?: SidecarPaths,
  webclientDir?: string,
): void => {
  // ⚠ TAKES THE SAME `oldPath` `preserveAndSwap` WAS GIVEN, rather than deriving
  // it from the binary path. A second derivation of where `recued.old` lives is
  // how the update lease once came to guard the wrong file.
  const paths = [
    oldPath,
    sigPathOf(oldPath),
    ...(sidecar ? [sidecar.oldPath, sigPathOf(sidecar.oldPath)] : []),
  ];
  for (const p of paths) {
    try { rmSync(asideOf(p), { force: true }); } catch { /* already gone */ }
  }
  syncSwapDirectories(oldPath, sidecar);
  if (webclientDir) {
    try { rmSync(`${webclientDir}${WEBCLIENT_APPLY_ASIDE}`, { recursive: true, force: true }); } catch { /* gone */ }
  }
};

export const preserveAndSwap = (
  stagedPath: string,
  binaryPath: string,
  oldPath: string,
  sidecar?: SidecarPaths,
  durability: SwapDurability = DEFAULT_SWAP_DURABILITY,
): void => {
  // Make the staged file executable BEFORE it goes live (a post-swap chmod
  // failure would otherwise install a non-executable binary).
  try {
    chmodSync(stagedPath, 0o755);
  } catch {
    /* best-effort; Windows ignores the mode */
  }
  const binSig = sigPathOf(binaryPath);
  const oldSig = sigPathOf(oldPath);

  // ⛔ THE VERIFIED STAGING SET MUST REACH STABLE STORAGE BEFORE ANY LIVE NAME
  // moves. Closing a stream makes bytes visible to this process; it does not make
  // them survive power loss. File fsyncs protect the bytes, and the directory
  // barrier protects the staged names the following renames consume.
  for (const path of [
    stagedPath,
    sigPathOf(stagedPath),
    ...(sidecar ? [sidecar.stagedPath, sigPathOf(sidecar.stagedPath)] : []),
  ]) {
    if (existsSync(path)) durability.fsyncFile(path);
  }
  syncSwapDirectories(binaryPath, sidecar, durability);

  // Preserve the OUTGOING binary AND its signature as the `recued.old` pair
  // FIRST — together, before the staged binary goes live. This guarantees the
  // rollback target is always a VERIFIED pair: a crash anywhere in the
  // subsequent staged-swap window leaves `recued.old` + `recued.old.minisig`
  // intact, so the launcher's re-verify can always fall back rather than brick.
  // ⛔⛔ THE COMPENSATION IS DECLARED BEFORE THE FIRST DESTRUCTIVE MOVE, NOT
  // AFTER IT. `restorePreserved` used to be defined BELOW this whole block, so a
  // throw while preserving the addon — after the live executable had already been
  // renamed away — left NO LIVE EXECUTABLE AT ALL and nothing to put it back.
  // Reproduced by fault injection at the addon rename. The flags are mutable and
  // set only once each move has actually succeeded, so the closure always
  // describes what is really on disk rather than what was intended.
  let preserved = false;
  let preservedBinSig = false;
  let preservedSidecar = false;
  let preservedSidecarSig = false;

  /** Put the preserved set back exactly as it was. Used by BOTH failure
   *  branches below — a partial swap must never be left on disk. */
  // ⛔⛔ THE PRIOR GENERATION IS SET ASIDE, NOT DELETED. This dropped the existing
  // `recued.old` before the staged rename, and the compensation below restores
  // the LIVE binary without restoring what used to be behind it — so a FAILED
  // apply left the install on its current release with NO ROLLBACK TARGET AT
  // ALL. Probed directly: after a failed R3 swap, `{live: R2,
  // rollbackTargetExists: false}`. The safety net was removed by the run that
  // most needed it to survive.
  //
  // ⚠ A DISTINCT SUFFIX FROM `.rollback-aside`. That one belongs to
  // `rollbackSwap`, and `reconcileInterruptedPairSwap` keys its crash recovery on
  // it; reusing the name would make an interrupted APPLY look like an interrupted
  // ROLLBACK to the one thing that has to tell them apart.
  const stashPriorGeneration = (path: string): boolean => {
    if (!existsSync(path)) return false;
    const aside = asideOf(path);
    if (existsSync(aside)) rmSync(aside, { force: true });
    // This generation is still the current release's rollback target. If it
    // cannot be parked, deleting it lets an apply that has not committed erase
    // the only known-good generation. Throw so the caller's compensation puts
    // every earlier move back.
    renameSync(path, aside);
    return true;
  };
  const stashed: string[] = [];
  const restoreStashed = (): void => {
    for (const path of stashed) {
      const aside = asideOf(path);
      try {
        if (existsSync(aside) && !existsSync(path)) renameSync(aside, path);
      } catch { /* best-effort — the live pair is already consistent */ }
    }
  };

  const restorePreserved = (): void => {
    let restoreError: unknown;
    try {
      if (preserved && !existsSync(binaryPath) && existsSync(oldPath)) {
        renameSync(oldPath, binaryPath);
        if (preservedBinSig) moveSigBeside(oldPath, binaryPath);
      }
    } catch (error) { restoreError = error; }
    try {
      if (sidecar && preservedSidecar && !existsSync(sidecar.livePath) && existsSync(sidecar.oldPath)) {
        renameSync(sidecar.oldPath, sidecar.livePath);
        if (preservedSidecarSig) moveSigBeside(sidecar.oldPath, sidecar.livePath);
      }
    } catch (error) { restoreError ??= error; }
    // ⛔ LAST, AND ONLY AFTER THE LIVE PAIR IS BACK. The rollback target is the
    // second thing to restore, never the first: putting it back over a slot the
    // live restore still needs would trade the safety net for the install.
    restoreStashed();
    if (restoreError !== undefined) throw restoreError;
  };

  // Preserve the outgoing pair — executable first, then the ADDON, both inside
  // one compensated window.
  // The addon and both detached signatures are NOT best-effort: a rollback that
  // restores the old exe next to the NEW addon is an ABI mismatch, while a lost
  // signature makes the managed launcher refuse the otherwise-restored pair.
  try {
    if (existsSync(binaryPath)) {
      if (stashPriorGeneration(oldPath)) stashed.push(oldPath);
      if (stashPriorGeneration(oldSig)) stashed.push(oldSig);
      renameSync(binaryPath, oldPath);
      preserved = true;
      if (existsSync(binSig)) {
        moveSigBeside(binaryPath, oldPath);
        preservedBinSig = true;
      }
    }
    if (sidecar && existsSync(sidecar.livePath)) {
      if (stashPriorGeneration(sidecar.oldPath)) stashed.push(sidecar.oldPath);
      const sidecarOldSig = sigPathOf(sidecar.oldPath);
      if (stashPriorGeneration(sidecarOldSig)) stashed.push(sidecarOldSig);
      renameSync(sidecar.livePath, sidecar.oldPath);
      preservedSidecar = true;
      // The addon carries its OWN detached signature on the volume: the thin
      // launcher re-verifies it before exec (I-2), because a tampered `.node` is
      // dlopen'd straight into the server's address space.
      if (existsSync(sigPathOf(sidecar.livePath))) {
        moveSigBeside(sidecar.livePath, sidecar.oldPath);
        preservedSidecarSig = true;
      }
    }
    // The outgoing executable/addon, their signatures, and the generation parked
    // behind `.old` are now the durable recovery point. A later power loss may
    // choose this state or a subsequent fully-barriered one, never an unrecorded
    // collection of rename intentions.
    syncSwapDirectories(binaryPath, sidecar, durability);
  } catch (err) {
    try { restorePreserved(); } finally {
      syncSwapDirectories(binaryPath, sidecar, durability);
    }
    throw err;
  }

  try {
    renameSync(stagedPath, binaryPath);
    moveSigBeside(stagedPath, binaryPath);
    durability.fsyncDir(dirname(binaryPath));
  } catch (err) {
    // Recover: never leave the install without a working binary.
    try { rmSync(binaryPath, { force: true }); } catch { /* restore below */ }
    try { rmSync(binSig, { force: true }); } catch { /* restore below */ }
    try { restorePreserved(); } finally {
      syncSwapDirectories(binaryPath, sidecar, durability);
    }
    throw err;
  }

  // The addon goes live AFTER the binary. Ordering matters and this is the safe
  // one: a crash between the two leaves a NEW exe with NO addon, which fails
  // loudly at the first database open and trips the boot-failure counter into
  // an auto-revert. The reverse order would leave the OLD exe running against a
  // NEW addon — a working-looking process on a mismatched ABI.
  if (sidecar) {
    try {
      renameSync(sidecar.stagedPath, sidecar.livePath);
      moveSigBeside(sidecar.stagedPath, sidecar.livePath);
      durability.fsyncDir(dirname(sidecar.livePath));
    } catch (err) {
      // Undo the binary swap too. Half an apply is the one state with no owner:
      // the boot-health gate cannot see it until the next boot, and by then the
      // staged file is gone.
      if (existsSync(binaryPath) && preserved) {
        try {
          rmSync(binaryPath);
        } catch { /* fall through to the restore attempt */ }
      }
      try { rmSync(binSig, { force: true }); } catch { /* restore below */ }
      if (existsSync(sidecar.livePath) && preservedSidecar) {
        try { rmSync(sidecar.livePath, { force: true }); } catch { /* restore below */ }
      }
      try { rmSync(sigPathOf(sidecar.livePath), { force: true }); } catch { /* restore below */ }
      try { restorePreserved(); } finally {
        syncSwapDirectories(binaryPath, sidecar, durability);
      }
      throw err;
    }
  }
  // ⛔⛔ THE ASIDE IS *NOT* DROPPED HERE, AND THAT IS THE POINT. The swap
  // succeeding does not make the pre-apply state unreachable: this is a TWO-PHASE
  // apply and it commits on the next healthy boot, so until then an auto-revert
  // can still consume `recued.old` to put the previous release back — and would
  // leave it with no rollback target, the same loss one phase later.
  //
  // ⇒ `dropApplyAside` runs at the boot-time commit; `rollbackSwap` promotes the
  // aside when a revert consumes `recued.old` instead. At most one generation is
  // still kept once either has run.
};

/** Put back the bundle state displaced by the current release, if one is parked
 *  at `<dir>.old` or `<dir>.apply-aside`. Returns whether anything was moved.
 *
 *  ⛔⛔ ONLY THE CALLER KNOWS WHETHER THIS IS THE RIGHT THING TO DO, and calling
 *  it on a hunch is worse than not calling it at all. `<dir>.old` SURVIVES a
 *  successful apply — `syncWebclientBundle` clears it at the start of the NEXT
 *  sync, not at the end of its own — so its mere presence does not mean "this
 *  operation displaced it". A normal `<dir>.old` restore therefore belongs only
 *  to a confirmed binary rollback. The aside-only shape is different: a failed
 *  sync parked the older backup but never replaced live, so recovery rebuilds
 *  only the rollback chain and deliberately leaves live untouched.
 *
 *  ⚠ BEST-EFFORT BY DESIGN. Both callers reach here having already settled the
 *  part that decides whether the install boots; a bundle that fails to move back
 *  leaves a visible UI mismatch, which is worth logging and is not worth
 *  unwinding a good binary state for. */
export const restoreWebclientBundle = (webclientDir: string | undefined): boolean => {
  if (webclientDir === undefined || webclientDir === '') return false;
  const backup = `${webclientDir}.old`;
  const aside = `${webclientDir}${WEBCLIENT_APPLY_ASIDE}`;
  try {
    // A sync mutates before promotion when it parks the prior `.old`. If the
    // download or verification then fails, a later binary rollback must leave
    // the still-correct live bundle alone and only rebuild the rollback chain.
    if (!existsSync(backup)) {
      if (!existsSync(aside)) return false;
      renameSync(aside, backup);
      fsyncDir(dirname(webclientDir));
      return true;
    }
    if (existsSync(webclientDir)) rmSync(webclientDir, { recursive: true, force: true });
    if (existsSync(join(backup, WEBCLIENT_ABSENT_MARKER))) {
      // The previous release served no bundle. Consuming this rollback target
      // means restoring absence, not promoting the sentinel directory live.
      rmSync(backup, { recursive: true, force: true });
    } else {
      renameSync(backup, webclientDir);
    }
    // ⛔ AND PUT THE GENERATION BEHIND IT BACK. `.old` has just been consumed to
    // restore the live bundle, so without this the install ends up on its
    // previous release with NO rollback UI — the same generational loss the
    // binary swap had, reached from the other side. The sync parked it precisely
    // so this restore could complete the undo rather than half of it.
    try {
      if (existsSync(aside) && !existsSync(backup)) renameSync(aside, backup);
    } catch { /* best-effort — the live bundle is already correct */ }
    fsyncDir(dirname(webclientDir));
    return true;
  } catch {
    return false;
  }
};

/** Swap `recued.old` back into `binaryPath` (rollback's binary half) via an
 *  atomic same-fs rename (replaces the destination; never leaves it empty).
 *  Throws if there is no preserved previous binary — the caller's
 *  `decideRollback` MUST have returned a non-`refuse` action first. */
export const rollbackSwap = (
  oldPath: string,
  binaryPath: string,
  sidecar?: SidecarPaths,
  /** The unpacked webclient bundle directory, when this install serves one.
   *
   *  ⛔ REVERTED WITH THE BINARY, because an apply REPLACES it. Without this a
   *  rollback returned the server to the previous release and left the NEWER UI
   *  in front of it — a pairing nothing tests and neither half expects. */
  webclientDir?: string,
  durability: SwapDurability = DEFAULT_SWAP_DURABILITY,
): void => {
  if (!existsSync(oldPath)) throw new Error('rollbackSwap: no recued.old to restore');

  // ⛔⛔ A TWO-FILE SWAP NEEDS A TRANSACTION, NOT A SEQUENCE. This used to rename
  // the old exe into place and THEN the old addon, with nothing between them: a
  // failure at the addon left the OLD executable paired with the NEW addon —
  // exactly the ABI mismatch the note below warns about, produced by the very
  // operation meant to escape it. The revert "succeeded" and the server still
  // could not open its database.
  //
  // 🔑 AND IT CANNOT BE FIXED BY REORDERING. Both renames OVERWRITE their
  // destination, so by the time either has run the file it replaced is gone and
  // there is nothing to put back. The current pair has to be moved ASIDE first;
  // only then is every step reversible.
  //
  // ⚠ Moving the current pair aside also makes the Windows dance unnecessary:
  // the destination name is already free, so the `rmSync` that used to DELETE
  // the live binary before renaming over it is gone with it.
  const exeAside = `${binaryPath}.rollback-aside`;
  const addonAside = sidecar ? `${sidecar.livePath}.rollback-aside` : null;
  let asideExe = false;
  let asideExeSig = false;
  let asideAddon = false;
  let asideAddonSig = false;
  let restoredExe = false;
  let restoredExeSig = false;
  let restoredAddon = false;
  let restoredAddonSig = false;

  // The live and rollback candidates may have arrived in an older build that did
  // not barrier its swap. Make every byte we are about to use as a recovery source
  // durable before opening this transaction's rename window.
  for (const path of [
    binaryPath,
    sigPathOf(binaryPath),
    ...rollbackCandidatePaths(oldPath, sidecar),
    ...(sidecar
      ? [sidecar.livePath, sigPathOf(sidecar.livePath)]
      : []),
  ]) {
    if (existsSync(path)) durability.fsyncFile(path);
  }
  syncSwapDirectories(binaryPath, sidecar, durability);

  /** Put everything back exactly as it was, innermost step first. */
  const unwind = (): void => {
    try {
      if (restoredAddon && sidecar) {
        renameSync(sidecar.livePath, sidecar.oldPath);
        if (restoredAddonSig) moveSigBeside(sidecar.livePath, sidecar.oldPath);
      }
      if (restoredExe) {
        renameSync(binaryPath, oldPath);
        if (restoredExeSig) moveSigBeside(binaryPath, oldPath);
      }
      if (asideAddon && sidecar && addonAside) {
        renameSync(addonAside, sidecar.livePath);
        if (asideAddonSig) moveSigBeside(addonAside, sidecar.livePath);
      }
      if (asideExe) {
        renameSync(exeAside, binaryPath);
        if (asideExeSig) moveSigBeside(exeAside, binaryPath);
      }
    } catch {
      /* best-effort: an unwind that cannot finish must not mask the real error */
    }
  };

  // ⚠ A STALE ASIDE FROM AN INTERRUPTED RUN WOULD BLOCK THE RENAME ON WINDOWS,
  // where the destination name must be free. Dropping it is safe: an aside only
  // ever holds a copy of what was live at the time, and if we are here the live
  // pair is whatever is at `binaryPath` now — the leftover describes a state that
  // no longer exists.
  try { if (existsSync(exeAside)) rmSync(exeAside, { force: true }); } catch { /* best-effort */ }
  try { if (existsSync(sigPathOf(exeAside))) rmSync(sigPathOf(exeAside), { force: true }); } catch { /* best-effort */ }
  try {
    if (addonAside && existsSync(addonAside)) rmSync(addonAside, { force: true });
  } catch { /* best-effort */ }
  try {
    if (addonAside && existsSync(sigPathOf(addonAside))) rmSync(sigPathOf(addonAside), { force: true });
  } catch { /* best-effort */ }

  try {
    if (existsSync(binaryPath)) {
      renameSync(binaryPath, exeAside);
      asideExe = true;
      const hadSignature = existsSync(sigPathOf(binaryPath));
      moveSigBeside(binaryPath, exeAside);
      asideExeSig = hadSignature;
    }
    // ⛔⛔ ONLY DISPLACE THE ADDON IF THERE IS ONE TO PUT BACK. This moved the live
    // addon aside unconditionally and then restored the old one ONLY when a `.old`
    // addon existed — so on an install that has a live addon and no preserved one,
    // the rollback moved the only copy aside, restored nothing, and DELETED the
    // aside at commit. The reverted exe was left with no addon at all and died at
    // its first database open.
    //
    // ⚠ THAT SHAPE IS REACHABLE, NOT THEORETICAL: `install.sh` places
    // `lib/better_sqlite3.node` with no `.old`, and an apply of a release whose
    // manifest carries no sidecar passes `undefined` to `preserveAndSwap`, which
    // therefore preserves none. A rollback of THAT apply is exactly this case.
    // The comment at the call site already claimed the executor "no-ops when no
    // preserved addon exists" — it is true now.
    const hasOldAddon = sidecar !== undefined && existsSync(sidecar.oldPath);
    if (sidecar && addonAside && hasOldAddon && existsSync(sidecar.livePath)) {
      renameSync(sidecar.livePath, addonAside);
      asideAddon = true;
      const hadSignature = existsSync(sigPathOf(sidecar.livePath));
      moveSigBeside(sidecar.livePath, addonAside);
      asideAddonSig = hadSignature;
    }

    // The rollback-asides are the journal that lets early boot finish this exact
    // direction after process death. Persist them before consuming `.old`.
    syncSwapDirectories(binaryPath, sidecar, durability);

    renameSync(oldPath, binaryPath);
    restoredExe = true;
    try {
      chmodSync(binaryPath, 0o755);
    } catch {
      /* best-effort */
    }
    // The previous binary's signature follows it, so a post-rollback launcher
    // re-verify pairs the restored binary with its own sig.
    const hadOldSignature = existsSync(sigPathOf(oldPath));
    moveSigBeside(oldPath, binaryPath);
    restoredExeSig = hadOldSignature;

    // ⛔ Restore the ADDON the old binary was built against. NOT best-effort: the
    // whole point of a rollback is a working install, and the restored exe paired
    // with the NEW addon is the same ABI mismatch that triggered the rollback.
    if (sidecar && hasOldAddon) {
      renameSync(sidecar.oldPath, sidecar.livePath);
      restoredAddon = true;
      const hadOldSignature = existsSync(sigPathOf(sidecar.oldPath));
      moveSigBeside(sidecar.oldPath, sidecar.livePath);
      restoredAddonSig = hadOldSignature;
    }
    syncSwapDirectories(binaryPath, sidecar, durability);
  } catch (err) {
    try { unwind(); } finally {
      syncSwapDirectories(binaryPath, sidecar, durability);
    }
    throw err;
  }

  // ⚠ BEST-EFFORT, AND DELIBERATELY OUTSIDE THE TRANSACTION ABOVE. The binary
  // pair is what makes a server bootable; the UI is not. A bundle that fails to
  // revert leaves a newer webclient in front of an older server — wrong, and
  // worth logging — but unwinding a COMPLETED binary rollback because of it
  // would trade a cosmetic mismatch for an unbootable install. The loader
  // re-verifies on boot and a missing bundle reads as "no bundle" (a 404),
  // which is safe.
  restoreWebclientBundle(webclientDir);

  // ⛔⛔ AND THE GENERATION BEHIND THE ONE WE JUST RESTORED TAKES ITS PLACE.
  // `recued.old` has been CONSUMED to put the previous release back, so without
  // this the install ends up on that release with no rollback target at all —
  // the loss `preserveAndSwap` now parks an aside to prevent, arriving one phase
  // later through the revert instead of through a failed swap.
  //
  // ⚠ A NO-OP AFTER A COMMITTED RELEASE, which is what makes it safe on the
  // owner-driven rollback path too: the boot-time commit drops the aside, so a
  // rollback of a release that has actually started finds nothing parked.
  for (const [live, sig] of [[oldPath, sigPathOf(oldPath)] as const,
    ...(sidecar ? [[sidecar.oldPath, sigPathOf(sidecar.oldPath)] as const] : [])]) {
    for (const dest of [live, sig]) {
      try {
        const parked = asideOf(dest);
        if (existsSync(parked) && !existsSync(dest)) renameSync(parked, dest);
      } catch { /* best-effort — the live pair is already correct */ }
    }
  }

  // Committed. The pair that was rolled back is no longer needed; dropping it
  // last means every earlier failure still had something to unwind to.
  try { if (asideExe) rmSync(exeAside, { force: true }); } catch { /* best-effort */ }
  try { if (asideExe) rmSync(sigPathOf(exeAside), { force: true }); } catch { /* best-effort */ }
  try { if (asideAddon && addonAside) rmSync(addonAside, { force: true }); } catch { /* best-effort */ }
  try { if (asideAddon && addonAside) rmSync(sigPathOf(addonAside), { force: true }); } catch { /* best-effort */ }
  syncSwapDirectories(binaryPath, sidecar, durability);
};

/** Finish a `rollbackSwap` that a KILL or a power loss interrupted.
 *
 *  ⛔⛔⛔ THE SWAP IS EXCEPTION-SAFE AND WAS NOT PROCESS-DEATH SAFE. It unwinds in
 *  memory, and a SIGKILL takes the unwind with it. The window that matters is
 *  between the two restores: the executable has become `recued.old`'s content,
 *  `recued.old` is therefore CONSUMED, and the addon is still parked in its
 *  aside — so the next start execs an old binary with NO addon, dies at the first
 *  database open, and has nothing left to revert to. `decideLaunch` then degrades
 *  to "keep trying the only verified binary", forever.
 *
 *  🔑 NO MARKER: THE ASIDES ARE THE JOURNAL. `rollbackSwap` displaces the live
 *  pair to STABLE, self-describing names beside the originals, and their presence
 *  is what says a rollback started. Everything else the recovery needs — which
 *  half finished — is answerable by looking: `recued.old` gone means the exe half
 *  committed; a missing live addon means the addon half did not. A marker would
 *  be a SECOND source of truth that can disagree with the disk, and this
 *  subsystem already settled that question the other way once
 *  (`evaluatePendingApplyOnBoot`: "THE LEDGER IS NOT THE ONLY WITNESS... RECONCILE
 *  AGAINST THE DISK FIRST"). The archive runtime keeps a real journal because its
 *  files are NOT self-describing — different problem, different answer.
 *
 *  ⚠ IT ONLY EVER FINISHES, NEVER UNWINDS. The asides exist because a rollback
 *  was in progress, and a rollback is what a failing install needed; there is no
 *  second direction to choose between. That is precisely why no phase has to be
 *  recorded.
 *
 *  Idempotent, and a no-op on a healthy install (two `existsSync` calls). */
export interface InterruptedSwapRecovery {
  /** `none` — nothing was interrupted. `completed` — a half-done apply or
   *  rollback was repaired. `cleaned` — only stale rollback asides remained. */
  action: 'none' | 'completed' | 'cleaned';
}

export const reconcileInterruptedPairSwap = (
  oldPath: string,
  binaryPath: string,
  sidecar?: SidecarPaths,
): InterruptedSwapRecovery => {
  const exeAside = `${binaryPath}.rollback-aside`;
  const addonAside = sidecar ? `${sidecar.livePath}.rollback-aside` : null;
  const asideSeen = existsSync(exeAside)
    || existsSync(sigPathOf(exeAside))
    || (addonAside !== null && (existsSync(addonAside) || existsSync(sigPathOf(addonAside))));
  if (!asideSeen) {
    // `preserveAndSwap` is exception-safe, but SIGKILL/power loss takes its
    // in-memory compensation with it. A completed staged apply has BOTH live and
    // `.old`; the two shapes below therefore identify only an incomplete apply.
    const parkedPaths = [
      oldPath,
      sigPathOf(oldPath),
      ...(sidecar ? [sidecar.oldPath, sigPathOf(sidecar.oldPath)] : []),
    ];
    const applyAsideSeen = parkedPaths.some((path) => existsSync(asideOf(path)));
    const restoreParked = (path: string): boolean => {
      const parked = asideOf(path);
      if (!existsSync(parked) || existsSync(path)) return false;
      renameSync(parked, path);
      return true;
    };

    let repairedApply = false;
    if (!existsSync(binaryPath) && existsSync(oldPath)) {
      // Current was preserved but staged never landed. Abort the apply: restore
      // the outgoing pair, then return the generation behind it to `.old`.
      renameSync(oldPath, binaryPath);
      try { chmodSync(binaryPath, 0o755); } catch { /* best-effort */ }
      moveSigBeside(oldPath, binaryPath);
      if (sidecar && !existsSync(sidecar.livePath) && existsSync(sidecar.oldPath)) {
        renameSync(sidecar.oldPath, sidecar.livePath);
        moveSigBeside(sidecar.oldPath, sidecar.livePath);
      }
      for (const path of parkedPaths) restoreParked(path);
      repairedApply = true;
    } else if (
      existsSync(binaryPath)
      && !existsSync(oldPath)
      && applyAsideSeen
    ) {
      // The prior rollback target was parked, but current never moved. Restore
      // only the rollback chain; the live executable/addon are already right.
      for (const path of parkedPaths) repairedApply = restoreParked(path) || repairedApply;
    } else if (existsSync(binaryPath) && existsSync(oldPath) && applyAsideSeen) {
      // The staged executable landed, so both executable generations exist, but
      // the process may have died before the addon or detached signatures made
      // their final rename. Finish those remaining moves: aborting would require
      // replacing the executable that is currently running this recovery, which
      // is not legal on Windows and would discard an otherwise-complete apply.
      if (
        sidecar
        && !existsSync(sidecar.livePath)
        && existsSync(sidecar.oldPath)
        && existsSync(sidecar.stagedPath)
      ) {
        renameSync(sidecar.stagedPath, sidecar.livePath);
        moveSigBeside(sidecar.stagedPath, sidecar.livePath);
        repairedApply = true;
      }
      // These signatures are moved after their payloads in `preserveAndSwap`, so
      // each staged signature is itself an unambiguous interrupted-finalization
      // witness. Never infer from a missing signature: persistence is best-effort.
      const stagedBinaryPath = `${binaryPath}.staged`;
      if (existsSync(sigPathOf(stagedBinaryPath))) {
        moveSigBeside(stagedBinaryPath, binaryPath);
        repairedApply = true;
      }
      if (sidecar && existsSync(sigPathOf(sidecar.stagedPath))) {
        moveSigBeside(sidecar.stagedPath, sidecar.livePath);
        repairedApply = true;
      }
    }
    if (repairedApply) {
      syncSwapDirectories(binaryPath, sidecar);
      return { action: 'completed' };
    }
    return { action: 'none' };
  }

  let completed = false;
  // The executable half. `recued.old` still present + no live binary is the
  // crash between displacing the current pair and restoring the previous one.
  if (!existsSync(binaryPath) && existsSync(oldPath)) {
    renameSync(oldPath, binaryPath);
    try { chmodSync(binaryPath, 0o755); } catch { /* best-effort; Windows ignores it */ }
    moveSigBeside(oldPath, binaryPath);
    completed = true;
  }
  if (sidecar) {
    if (existsSync(sidecar.oldPath)) {
      // ⛔ THE PRESERVED ADDON MUST END UP LIVE, whichever half was interrupted.
      // A crash BEFORE the addon was displaced leaves the NEW addon live beside a
      // restored OLD exe — the ABI mismatch the rollback exists to escape — so
      // displace it here rather than assuming the live file is already right.
      if (existsSync(sidecar.livePath)) {
        try { if (addonAside !== null && existsSync(addonAside)) rmSync(addonAside, { force: true }); } catch { /* best-effort */ }
        if (addonAside !== null) renameSync(sidecar.livePath, addonAside);
        if (addonAside !== null) moveSigBeside(sidecar.livePath, addonAside);
      }
      renameSync(sidecar.oldPath, sidecar.livePath);
      moveSigBeside(sidecar.oldPath, sidecar.livePath);
      completed = true;
    } else if (!existsSync(sidecar.livePath) && addonAside !== null && existsSync(addonAside)) {
      // Nothing was preserved to restore, and the live one is parked: put it
      // back. An exe paired with the addon it was displaced beside is a guess,
      // but it is a guess that can OPEN A DATABASE, and no addon at all cannot.
      renameSync(addonAside, sidecar.livePath);
      moveSigBeside(addonAside, sidecar.livePath);
      completed = true;
    }
  }

  // A payload rename can commit immediately before its best-effort signature
  // move. The old-path signature then proves which detached signature belongs
  // beside the restored live payload; finish that move before rebuilding `.old`.
  if (existsSync(binaryPath) && !existsSync(oldPath) && existsSync(sigPathOf(oldPath))) {
    moveSigBeside(oldPath, binaryPath);
    completed = true;
  }
  if (
    sidecar
    && existsSync(sidecar.livePath)
    && !existsSync(sidecar.oldPath)
    && existsSync(sigPathOf(sidecar.oldPath))
  ) {
    moveSigBeside(sidecar.oldPath, sidecar.livePath);
    completed = true;
  }

  // A normal rollback promotes the generation the staged apply parked behind
  // `.old`. Process-death recovery has to reach the same committed state: leaving
  // only `.apply-aside` would make the restored release appear to have no rollback
  // target and a later retry could consume another generation.
  for (const path of [
    oldPath,
    sigPathOf(oldPath),
    ...(sidecar ? [sidecar.oldPath, sigPathOf(sidecar.oldPath)] : []),
  ]) {
    const parked = asideOf(path);
    try {
      if (existsSync(parked) && !existsSync(path)) {
        renameSync(parked, path);
        completed = true;
      }
    } catch { /* the live pair is already restored; retain the aside for retry */ }
  }

  for (const stale of [exeAside, addonAside]) {
    if (stale === null) continue;
    try { if (existsSync(stale)) rmSync(stale, { force: true }); } catch { /* best-effort */ }
    try { if (existsSync(sigPathOf(stale))) rmSync(sigPathOf(stale), { force: true }); } catch { /* best-effort */ }
  }
  syncSwapDirectories(binaryPath, sidecar);
  return { action: completed ? 'completed' : 'cleaned' };
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
/** ⛔⛔⛔ PRECONDITION: NO PROCESS MAY HOLD `dbPath` OPEN. The crash-consistency
 *  walk above reasons entirely about BYTES ON DISK and says nothing about open
 *  handles — but the rename below replaces the file underneath any live
 *  connection, which then keeps serving the unlinked inode and silently ACCEPTS
 *  WRITES that no later reader can see. Verified by reproduction 2026-08-31: the
 *  stale handle reported the pre-restore row count, took a write, and a fresh
 *  handle could not see it.
 *
 *  Every caller used to violate this. They no longer do, and the three of them
 *  satisfy it in three different ways because they are in three different
 *  situations — see `runRollback` (refuses in-process), `cli-context/update.ts`
 *  (closes first), and `performAutoRevert` (defers to pre-open boot). The
 *  sibling that always did it right is `commitStagedRestore`, which runs after
 *  the restart drain's `close_db` step. */
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

/** The marker that carries a snapshot restore across a restart, so it can run at
 *  a point in boot where NOTHING has opened the database yet.
 *
 *  It lives beside the db and CONTAINS the snapshot path, so the consumer needs
 *  only `dbPath` — which every boot path resolves before it opens anything. */
export const restorePendingMarkerPath = (dbPath: string): string => `${dbPath}.restore-pending`;

export const markSnapshotRestorePending = (dbPath: string, snapshotPath: string): void => {
  const marker = restorePendingMarkerPath(dbPath);
  writeFileSync(marker, `${snapshotPath}\n`, 'utf8');
  fsyncFile(marker);
  fsyncDir(dirname(marker));
};

/** Consume a pending restore. Call BEFORE opening the database.
 *
 *  ⛔ THE MARKER IS CLEARED LAST, AFTER the rename and its directory fsync, so a
 *  crash anywhere in the middle simply retries on the next boot — the restore is
 *  idempotent (it copies the same snapshot again). Returns whether it ran, so the
 *  caller can decide what to do next (the auto-revert path still owes a binary
 *  swap, which must not happen until the restore has actually succeeded).
 *
 *  A marker whose snapshot has gone is a state nothing can complete: it is
 *  cleared and reported rather than left to fail every future boot forever. */
export const consumePendingSnapshotRestore = (
  dbPath: string,
  copyFile: (from: string, to: string) => void,
  onProblem?: (message: string) => void,
): { restored: boolean; snapshotPath?: string } => {
  const marker = restorePendingMarkerPath(dbPath);
  if (!existsSync(marker)) return { restored: false };
  const snapshotPath = readFileSync(marker, 'utf8').trim();
  if (!snapshotPath || !existsSync(snapshotPath)) {
    onProblem?.(
      `a database rollback was pending but its snapshot (${snapshotPath || 'unrecorded'}) is gone; `
      + 'clearing the request and continuing on the current database',
    );
    rmSync(marker, { force: true });
    return { restored: false };
  }
  restoreSnapshot(snapshotPath, dbPath, copyFile);
  rmSync(marker, { force: true });
  return { restored: true, snapshotPath };
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
