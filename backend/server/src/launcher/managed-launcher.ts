/** D-178 — the thin `:managed` image launcher (spec § Install paths "docker",
 *  § Update machinery "docker-thin", I-2 / I-6 / I-9).
 *
 *  The `:managed` image is a DUMB, FROZEN verify-and-exec loop. The server binary
 *  lives on the data volume at `/data/bin/recued` (self-applied by the running
 *  server's `update.apply`); this launcher is the baked entrypoint that, on every
 *  container (re)start, picks the binary, RE-VERIFIES its minisign signature
 *  against the pinned key (I-2 second verification — defense in depth against a
 *  tampered volume the server's apply-time verify can't cover after the fact),
 *  runs the boot-failure auto-revert (I-6 — a signed-but-bad release degrades to
 *  one noisy attempt, never an unattended crash loop), and execs it.
 *
 *  I-9 — the launcher NEVER self-updates and has NO update logic of its own: it
 *  fetches nothing, reads no manifest, makes no apply decision. Its only release-
 *  contract coupling is the embedded pinned pubkey + this `LAUNCHER_VERSION`,
 *  which it reports to the server (`RECUED_LAUNCHER_VERSION` env) so the SERVER's
 *  resolve can refuse to apply across a verification-contract break
 *  (`min_launcher_version` → `launcher-outdated`). The launcher is rebuilt only
 *  when that contract itself changes.
 *
 *  Frozen by construction: imports ONLY `@recued/release` (the same frozen
 *  minisign verifier the server + installer use) + node builtins — never the
 *  server bundle (the thing it launches, which changes every release).
 *
 *  ⛔⛔ AND THAT IS WHY THE REVERT IS NOT PERFORMED HERE. It used to be, and the
 *  copy drifted: this file swapped the binary pair while the server's own revert
 *  grew a pre-migration snapshot restore, a webclient restore, and a safety gate
 *  that refuses a revert onto a schema the failed release already migrated. The
 *  launcher cannot import that rule without importing the engine it exists to be
 *  independent of — so it does what the binary channel's supervising script does
 *  and RUNS the rule inside `recued.old`: `recued revert-release`. The DECISION
 *  stays here, where the signature evidence is.
 *
 *  The pure `decideLaunch` core is unit-tested; `runLauncher` is the thin IO loop
 *  (spawn + counter IO + the delegated revert). */

import { spawn as nodeSpawn } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { verify } from '@recued/release';

/** The launcher's verification-contract version. Reported to the server via
 *  `RECUED_LAUNCHER_VERSION`; the server's resolve refuses to apply a release
 *  whose `min_launcher_version` exceeds it (I-9). Bump ONLY when the verify
 *  contract changes (signature algorithm / sidecar shape) — never on ordinary
 *  releases (the whole point of I-9 is that old launchers keep launching new
 *  binaries). */
export const LAUNCHER_VERSION = 1;

/** The detached-signature sidecar suffix the apply path writes beside the binary
 *  on the volume (`recued` → `recued.minisig`, `recued.old` →
 *  `recued.old.minisig`). Kept in lockstep with `binary-apply-executor.ts`'s
 *  `SIG_SIDECAR_SUFFIX` — duplicated here deliberately so the launcher imports
 *  nothing from the server bundle (I-9 frozen). */
export const SIG_SIDECAR_SUFFIX = '.minisig';

/** D-178 item 6 — where the SEA binary loads its native addon from, RELATIVE to
 *  the directory holding the executable (`open-database.ts` resolves
 *  `dirname(process.execPath)/lib/better_sqlite3.node`). Duplicated here for the
 *  same I-9 reason as `SIG_SIDECAR_SUFFIX` — the launcher imports nothing from
 *  the server bundle — and pinned against the server's own derivation by
 *  `managed-launcher.test.ts`, because a silent drift here would seed and revert
 *  a file the binary never looks at. */
export const ADDON_RELATIVE_PATH = 'lib/better_sqlite3.node';

/** Suffix the apply path uses for the preserved previous copy of both the
 *  executable and the addon (`recued.old`, `…/better_sqlite3.node.old`).
 *  Lockstep with `release-config.ts`; see `ADDON_RELATIVE_PATH`. */
export const OLD_SUFFIX = '.old';

/** The addon path for a given binary path — the launcher's half of the agreement
 *  the SERVER side now makes in ONE place, `sidecarPathsFor`
 *  (`update/binary-apply-executor.ts`). Two copies, deliberately: this module is
 *  the frozen image launcher and may not import the server bundle.
 *
 *  ⚠ THEY ARE NOT IDENTICAL, AND THE DIFFERENCE IS INTENDED. The server side also
 *  honours `RECUED_NATIVE_BINDING`, because a server that reads its addon from an
 *  override has to SWAP and REVERT that same file. The launcher execs the binary
 *  rather than loading the addon, so it has no such override to respect. */
export const addonPathFor = (binaryPath: string): string =>
  join(dirname(binaryPath), ...ADDON_RELATIVE_PATH.split('/'));

/** Consecutive failed boots of the current uncommitted binary before the
 *  launcher reverts to `recued.old` (matches `apply-state-machine.BOOT_FAILURE_
 *  THRESHOLD`). */
export const BOOT_FAILURE_THRESHOLD = 3;

/** The boot-failure counter sidecar, beside the binary. Duplicated from
 *  `update/boot-failure-counter.ts` for the same I-9 reason as
 *  `ADDON_RELATIVE_PATH`, and pinned against it by `managed-launcher.test.ts`.
 *
 *  ⛔⛔ THE AGREEMENT IS NOW LOAD-BEARING ACROSS A PROCESS BOUNDARY. The launcher
 *  READS this file to count crashes; the revert that ends the crash loop happens
 *  inside `recued.old` (`revert-release`) and CLEARS it from there. If the two
 *  names ever drifted, the reset would clear a file nobody reads: the launcher
 *  would see the count still at the threshold, ask for the revert again, and loop
 *  — reverting forever over an install that is already fixed. */
export const BOOT_FAILURE_COUNTER_FILE = 'boot-failures.json';

/** Server exit-code contract under the `docker-thin` supervisor (standard codes —
 *  NOT the plain-`docker` `restart→1` remap). The launcher's loop branches on
 *  these, so they must match `lifecycle/supervisor.ts` `standardHandoff`. */
export const EXIT_CLEAN = 0;
export const EXIT_CRASH = 1;
export const EXIT_RESTART = 3;
export const EXIT_LOCK_HELD = 4;

// ────────────────────────────────────────────────────────────────
// Pure decision core
// ────────────────────────────────────────────────────────────────

export interface LaunchInput {
  /** The current binary exists on the volume. */
  currentExists: boolean;
  /** The current binary's signature verified against the pinned key (or no key
   *  is pinned — pre-GA — in which case the caller passes `true`). */
  currentVerified: boolean;
  /** A retained previous binary (`recued.old`) exists. */
  oldExists: boolean;
  /** The previous binary's signature verified. */
  oldVerified: boolean;
  /** Consecutive failed boots of the current binary (boot-failure counter). */
  failureCount: number;
  threshold: number;
}

export type LaunchDecision =
  | { action: 'exec-current' }
  | { action: 'revert-and-exec-old'; reason: string }
  | { action: 'refuse'; reason: string };

/** Decide which binary to launch (or to refuse). Precedence:
 *   1. Current healthy (exists + verified + under threshold) → run it.
 *   2. Current unhealthy but a verified previous binary exists → revert.
 *   3. No good fallback but current is at least runnable (exists + verified,
 *      only over-threshold) → run it as a LAST RESORT (nothing better than the
 *      binary that at least passes signature; the server will keep notifying).
 *   4. Nothing runnable → refuse (the container halts loudly rather than
 *      crash-looping an unverifiable binary). */
export const decideLaunch = (i: LaunchInput): LaunchDecision => {
  const currentRunnable = i.currentExists && i.currentVerified;
  const oldRunnable = i.oldExists && i.oldVerified;

  if (currentRunnable && i.failureCount < i.threshold) {
    return { action: 'exec-current' };
  }
  if (oldRunnable) {
    const reason = !i.currentExists
      ? 'current binary missing'
      : !i.currentVerified
        ? 'current binary failed signature verification'
        : `current binary failed ${i.failureCount} consecutive boots`;
    return { action: 'revert-and-exec-old', reason };
  }
  if (currentRunnable) {
    // Over threshold but signature-valid and no verified fallback — degrade to
    // "keep trying, keep notifying" rather than halting a verified binary.
    return { action: 'exec-current' };
  }
  return {
    action: 'refuse',
    reason: !i.currentExists
      ? 'no binary on the data volume'
      : 'current binary failed signature verification and no verified previous binary to fall back to',
  };
};

// ────────────────────────────────────────────────────────────────
// IO helpers (small, frozen)
// ────────────────────────────────────────────────────────────────

/** Verify a binary's detached signature sidecar against the pinned key. An
 *  EMPTY pinned key (pre-GA — no signing identity yet) returns `true`: the
 *  server itself runs unsigned pre-GA, so the launcher must not refuse to boot
 *  it. A missing sidecar under a real key returns `false` (can't verify → treat
 *  as untrusted). */
export const verifyBinarySignature = (binaryPath: string, pubkey: string): boolean => {
  if (!pubkey) return true; // pre-GA: nothing pinned to verify against
  if (!existsSync(binaryPath)) return false;
  const sigPath = `${binaryPath}${SIG_SIDECAR_SUFFIX}`;
  if (!existsSync(sigPath)) return false;
  try {
    const content = readFileSync(binaryPath);
    const signatureText = readFileSync(sigPath, 'utf8');
    return verify({ content, signatureText, publicKeyText: pubkey }).ok;
  } catch {
    return false;
  }
};

/** Repair the one split-pair shape the launcher must understand before it can
 * verify either candidate: `preserveAndSwap` renamed an outgoing payload to
 * `.old`, then the process died before renaming its detached signature.
 *
 * The server has a broader interrupted-swap reconciler, but it cannot run until
 * this launcher executes a verified binary. Moving a signature on disk SHAPE
 * alone would weaken I-2, so the stranded signature is adopted only after it
 * verifies the exact `.old` payload under the pinned key. */
export const repairInterruptedOutgoingSignatures = (
  currentPath: string,
  oldPath: string,
  currentAddonPath: string,
  pubkey: string,
): number => {
  if (!pubkey) return 0; // pre-GA already treats unsigned candidates as runnable
  let repaired = 0;
  const repairOne = (livePath: string, preservedPath: string): void => {
    const strandedSig = `${livePath}${SIG_SIDECAR_SUFFIX}`;
    const preservedSig = `${preservedPath}${SIG_SIDECAR_SUFFIX}`;
    if (
      existsSync(livePath)
      || !existsSync(preservedPath)
      || existsSync(preservedSig)
      || !existsSync(strandedSig)
    ) return;
    try {
      const verified = verify({
        content: readFileSync(preservedPath),
        signatureText: readFileSync(strandedSig, 'utf8'),
        publicKeyText: pubkey,
      });
      if (!verified.ok) return;
      renameSync(strandedSig, preservedSig);
      repaired += 1;
    } catch {
      // Leave both witnesses untouched. The ordinary verifier will fail closed.
    }
  };

  repairOne(currentPath, oldPath);
  repairOne(currentAddonPath, `${currentAddonPath}${OLD_SUFFIX}`);
  if (repaired > 0) {
    // Best-effort durability for the repair itself. Directory handles are not
    // portable to Windows, where the rename is still atomic and repeatable.
    try {
      const fd = openSync(dirname(currentPath), 'r');
      try { fsyncSync(fd); } finally { closeSync(fd); }
    } catch { /* best-effort */ }
  }
  return repaired;
};

/** D-178 item 6 — verify the WHOLE payload: the executable AND the native addon
 *  it dlopen's at its first database open.
 *
 *  ⛔ Verifying only the exe would leave the EASIER attack open. The launcher's
 *  re-verify exists because the data volume is mutable and outside the image's
 *  trust boundary (I-2, defense in depth); on such a volume, swapping
 *  `lib/better_sqlite3.node` gets arbitrary native code into the server's own
 *  address space with all of its privileges, without touching the one file that
 *  was being checked.
 *
 *  An install with NO addon at all verifies as far as the exe goes — that is a
 *  pre-sidecar volume, and refusing it would brick every existing docker-thin
 *  install on upgrade. A PRESENT addon must verify; a present-but-unsigned or
 *  present-and-tampered one does not.
 *
 *  ⚠ `addonPath` is passed EXPLICITLY rather than derived from `binaryPath`.
 *  Deriving looks right and is wrong for the rollback candidate: the old exe is
 *  `<binDir>/recued.old`, whose dirname is still `<binDir>`, so a derived path
 *  yields the LIVE addon — and the old payload would be pronounced verified
 *  against the very addon it is being rolled back away from. */
export const verifyPayloadSignature = (
  binaryPath: string,
  addonPath: string,
  pubkey: string,
): boolean => {
  if (!verifyBinarySignature(binaryPath, pubkey)) return false;
  if (!pubkey) return true;
  // Absent → nothing to verify (pre-sidecar volume). Present → must pass.
  if (!existsSync(addonPath)) return true;
  return verifyBinarySignature(addonPath, pubkey);
};

/** Read the boot-failure count off the sidecar JSON (release-agnostic — the
 *  launcher only needs "how many times has the current binary failed since the
 *  last reset"; the server re-keys + resets it on a healthy/committed boot). A
 *  missing / corrupt file reads as 0 (fail toward "give it a chance"). */
export const readFailureCount = (counterPath: string): number => {
  if (!existsSync(counterPath)) return 0;
  try {
    const o = JSON.parse(readFileSync(counterPath, 'utf8')) as { count?: unknown };
    return typeof o.count === 'number' && Number.isFinite(o.count) && o.count >= 0 ? o.count : 0;
  } catch {
    return 0;
  }
};

/** Increment the boot-failure count (preserving any `release_identity` the
 *  server keyed it with). Write-temp-then-rename so a crash mid-write can't tear
 *  the file. */
export const incrementFailureCount = (counterPath: string): number => {
  let prior: Record<string, unknown> = {};
  if (existsSync(counterPath)) {
    try {
      prior = JSON.parse(readFileSync(counterPath, 'utf8')) as Record<string, unknown>;
    } catch {
      prior = {};
    }
  }
  const cur = typeof prior.count === 'number' && Number.isFinite(prior.count) && prior.count >= 0 ? prior.count : 0;
  const next = { ...prior, count: cur + 1 };
  const tmp = `${counterPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(next), 'utf8');
  renameSync(tmp, counterPath);
  return cur + 1;
};

export const resetFailureCount = (counterPath: string): void => {
  if (existsSync(counterPath)) {
    try {
      rmSync(counterPath);
    } catch {
      /* best-effort */
    }
  }
};


/** First-boot seed: when the data volume has no binary yet, copy the baked
 *  initial binary (+ its sig sidecar) from the image into the volume so the
 *  launcher has something to verify-and-exec; the running server's self-update
 *  takes over from there. No-op when a binary already exists (the volume's copy,
 *  possibly self-updated past the baked one, always wins) or no seed is baked.
 *  Returns true iff it seeded. */
export const seedIfAbsent = (currentPath: string, binDir: string, seedBinaryPath: string | undefined): boolean => {
  if (!seedBinaryPath || existsSync(currentPath) || !existsSync(seedBinaryPath)) return false;
  mkdirSync(binDir, { recursive: true });
  copyFileSync(seedBinaryPath, currentPath);
  const seedSig = `${seedBinaryPath}${SIG_SIDECAR_SUFFIX}`;
  if (existsSync(seedSig)) copyFileSync(seedSig, `${currentPath}${SIG_SIDECAR_SUFFIX}`);

  // ⛔ The seed is the exe AND its addon. Seeding the exe alone produces a
  // volume that verifies, execs, and then dies at the first database open — on
  // FIRST BOOT, where there is no `.old` to revert to and the boot-failure
  // counter just burns its three attempts. The addon is baked beside the seed
  // exe in the image (`Dockerfile.managed`), the same relative layout the
  // running binary resolves.
  const seedAddon = join(dirname(seedBinaryPath), ...ADDON_RELATIVE_PATH.split('/'));
  if (existsSync(seedAddon)) {
    const addon = addonPathFor(currentPath);
    mkdirSync(dirname(addon), { recursive: true });
    copyFileSync(seedAddon, addon);
    const seedAddonSig = `${seedAddon}${SIG_SIDECAR_SUFFIX}`;
    if (existsSync(seedAddonSig)) copyFileSync(seedAddonSig, `${addon}${SIG_SIDECAR_SUFFIX}`);
  }
  return true;
};


// ────────────────────────────────────────────────────────────────
// IO loop
// ────────────────────────────────────────────────────────────────

export interface RunLauncherOptions {
  /** Data-volume bin directory (default `/data/bin`). */
  binDir?: string;
  /** The pinned, embedded trusted release pubkey (minisign). Empty pre-GA. */
  pubkey: string;
  /** Args forwarded to the server binary. */
  args: string[];
  env?: NodeJS.ProcessEnv;
  /** Baked initial binary path (image-side, e.g. `/opt/recued-seed/recued`).
   *  Copied into `binDir` on first boot when the volume has no binary yet. */
  seedBinaryPath?: string;
  /** Crash backoff before re-exec (ms). Tests pass 0. */
  crashBackoffMs?: number;
  /** Injected spawn-and-wait → resolved exit code. Tests stub it. */
  runBinary?: (binaryPath: string, args: string[], env: NodeJS.ProcessEnv) => Promise<number>;
  /** Injected sleep (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

const defaultRunBinary = (binaryPath: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> =>
  new Promise((resolve) => {
    const child = nodeSpawn(binaryPath, args, { stdio: 'inherit', env });
    child.on('exit', (code, signal) => resolve(signal ? 1 : (code ?? 1)));
    child.on('error', () => resolve(1));
  });

/** The verify-and-exec loop. Returns the process exit code the launcher itself
 *  should exit with. */
export const runLauncher = async (opts: RunLauncherOptions): Promise<number> => {
  const binDir = opts.binDir ?? '/data/bin';
  const currentPath = join(binDir, 'recued');
  const oldPath = `${currentPath}${OLD_SUFFIX}`;
  const addonPath = addonPathFor(currentPath);
  const counterPath = join(binDir, BOOT_FAILURE_COUNTER_FILE);
  const runBinary = opts.runBinary ?? defaultRunBinary;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = opts.log ?? ((m: string) => console.error(`[launcher] ${m}`));
  const baseEnv = opts.env ?? process.env;
  const crashBackoffMs = opts.crashBackoffMs ?? 2000;

  // I-2 posture: with no pinned key the volume re-verification is DISABLED
  // (pre-GA — the signing identity isn't generated yet). Surface it loudly so a
  // production `:managed` image built before the key is pinned never silently
  // accepts arbitrary volume contents.
  if (!opts.pubkey) {
    log('WARNING: no pinned release key — binary signature re-verification is DISABLED (pre-GA)');
  }

  // First-boot seed: copy the baked binary onto an empty volume so there's
  // something to verify-and-exec; the running server self-updates from there.
  if (seedIfAbsent(currentPath, binDir, opts.seedBinaryPath)) {
    log('seeded initial binary onto the data volume');
  }

  // Bound the loop so a pathological revert↔crash oscillation can't spin
  // forever inside one container lifetime — well above the boot-failure
  // threshold; docker's restart policy is the outer backstop.
  const MAX_ITERATIONS = 50;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const repairedSignatures = repairInterruptedOutgoingSignatures(
      currentPath,
      oldPath,
      addonPath,
      opts.pubkey,
    );
    if (repairedSignatures > 0) {
      log(`repaired ${repairedSignatures} interrupted detached-signature move(s)`);
    }
    // Whole-payload verification (exe + addon). The `.old` candidate is paired
    // with the `.old` ADDON, not the live one — see `verifyPayloadSignature`.
    const decision = decideLaunch({
      currentExists: existsSync(currentPath),
      currentVerified: verifyPayloadSignature(currentPath, addonPath, opts.pubkey),
      oldExists: existsSync(oldPath),
      oldVerified: verifyPayloadSignature(oldPath, `${addonPath}${OLD_SUFFIX}`, opts.pubkey),
      failureCount: readFailureCount(counterPath),
      threshold: BOOT_FAILURE_THRESHOLD,
    });

    if (decision.action === 'refuse') {
      log(`refusing to launch: ${decision.reason}`);
      return 1;
    }
    if (decision.action === 'revert-and-exec-old') {
      log(`auto-revert to previous binary: ${decision.reason}`);
      // ⛔⛔⛔ THE REVERT IS PERFORMED BY THE BINARY WE ARE REVERTING TO, NOT HERE.
      // This used to swap the files itself — and swapping the BINARY PAIR is all
      // it ever did. No pre-migration snapshot, no webclient, no check that the
      // revert was even safe. So a `docker-thin` install whose new release had
      // migrated came back on the OLD binary against the NEW schema, behind the
      // NEW webclient, with `recued.old` consumed and a terminal written — which
      // is the state from which nothing downstream can retry.
      //
      // 🔑 IT IS NOT A COPY THAT DRIFTED BY ACCIDENT; IT IS A COPY, AND COPIES
      // DRIFT. The same rule lives in `update/supervised-boot-failure.ts`, and
      // this file may not import it: it is the frozen image entrypoint, bundled
      // standalone, deliberately free of the changing engine (I-9). The binary
      // channel met this exact wall and answered it by having its supervising
      // script run the verdict IN `recued.old`. This is that answer, here.
      //
      // ⚠ EXEC'ING `recued.old` IS ALREADY SANCTIONED AT THIS POINT, and only at
      // this point: `decideLaunch` returns `revert-and-exec-old` ONLY when the
      // previous payload passed its full signature re-verify. We are about to run
      // it as the server anyway.
      //
      // ⚠ AND THE DECISION STAYS HERE. `--reason` carries it, because the
      // launcher reverts for causes no exit code can express — a current binary
      // that is missing, or one that fails I-2 verification — which is why this
      // asks for the ACT and not for a verdict.
      const verdict = await runBinary(
        oldPath,
        ['revert-release', '--bin-dir', binDir, '--reason', decision.reason, ...opts.args],
        baseEnv,
      );
      if (verdict !== 0) {
        // ⛔ HALT, DO NOT SWAP ANYWAY. A refusal here means the revert would be
        // unsafe (the failed release migrated and there is no snapshot) or the
        // previous binary could not run it — and a previous binary that cannot
        // run cannot serve either, so reverting to it would only trade a halt for
        // a crash loop. Both want an operator, and the log line is what tells
        // them. Nothing has been changed on disk.
        log(`the previous binary did not complete the revert (exit ${verdict}) — halting`);
        return 1;
      }
      continue; // re-decide over the reverted binary
    }

    // exec-current
    const childEnv: NodeJS.ProcessEnv = {
      ...baseEnv,
      RECUED_LAUNCHER_VERSION: String(LAUNCHER_VERSION),
      RECUED_SUPERVISOR_MODE: 'docker-thin',
    };
    const code = await runBinary(currentPath, opts.args, childEnv);

    if (code === EXIT_CLEAN) {
      // Clean shutdown — healthy. Clear the counter; let docker's restart policy
      // decide whether to bring the container back (operator stop stays down).
      resetFailureCount(counterPath);
      return EXIT_CLEAN;
    }
    if (code === EXIT_RESTART) {
      // The server self-applied (or asked to restart) — re-exec, picking up any
      // freshly-swapped binary. NOT a boot failure.
      log('restart requested — re-launching');
      continue;
    }
    if (code === EXIT_LOCK_HELD) {
      // Another instance owns the data path; halting (report clean so the docker
      // restart policy doesn't tight-loop, mirroring docker-entrypoint.sh).
      log('lock held by another instance — halting');
      return EXIT_CLEAN;
    }
    // Any other non-zero is a CRASH — count it; the next iteration's decision
    // reverts once the threshold trips.
    const count = incrementFailureCount(counterPath);
    log(`server exited ${code} (boot failure ${count}/${BOOT_FAILURE_THRESHOLD})`);
    if (crashBackoffMs > 0) await sleep(crashBackoffMs);
  }

  log(`exceeded ${MAX_ITERATIONS} launch iterations — halting`);
  return 1;
};
