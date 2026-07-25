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
 *  The pure `decideLaunch` core is unit-tested; `runLauncher` is the thin IO loop
 *  (spawn + counter IO + the atomic revert swap). */

import { spawn as nodeSpawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { verify } from '@recued/release';
import {
  createUpdateLedger,
  UPDATE_LEDGER_FILE,
  type UpdateLedgerEntry,
  type UpdateLedgerKind,
} from '../update/update-ledger.js';

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

/** Consecutive failed boots of the current uncommitted binary before the
 *  launcher reverts to `recued.old` (matches `apply-state-machine.BOOT_FAILURE_
 *  THRESHOLD`). */
export const BOOT_FAILURE_THRESHOLD = 3;

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

/** Swap `recued.old` (+ its sig sidecar) back into the current binary path —
 *  the launcher's boot-health revert. Atomic same-fs renames.
 *
 *  RESIDUAL (tiny same-fs crash sub-window): the binary + sig are two renames;
 *  a crash between them can leave the restored binary paired with a stale sig.
 *  Under a real key the next start would then refuse + halt (recoverable by
 *  re-pulling the digest-anchored image → reseed) rather than silently running
 *  unverified content. A fully atomic pair-swap (verified-pair directory rename)
 *  is the proper fix — follow-up before docker-thin GA. */
export const revertToOld = (currentPath: string, oldPath: string): void => {
  const curSig = `${currentPath}${SIG_SIDECAR_SUFFIX}`;
  const oldSig = `${oldPath}${SIG_SIDECAR_SUFFIX}`;
  if (process.platform === 'win32' && existsSync(currentPath)) rmSync(currentPath);
  renameSync(oldPath, currentPath);
  if (existsSync(oldSig)) {
    if (process.platform === 'win32' && existsSync(curSig)) rmSync(curSig);
    renameSync(oldSig, curSig);
  } else if (existsSync(curSig)) {
    // Reverted binary has no sig of its own — drop the stale current sig so the
    // next verify can't pair the old binary with a new-binary signature.
    rmSync(curSig);
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
  return true;
};

/** Record the launcher's boot-health auto-revert as a TERMINAL ledger entry so
 *  the server's apply lock + on-boot reconcile see the staged release as
 *  resolved. Without this the launcher physically reverts `recued.old` but the
 *  ledger still shows an unterminated `apply_started` — the server would then
 *  block every future apply AND try its own auto-revert into a `recued.old` the
 *  launcher already consumed (`rollbackSwap` throws). Reuses the dependency-free
 *  ledger module (the stable update substrate — not the changing engine, so it
 *  doesn't compromise the launcher's I-9 frozenness). Best-effort: a ledger
 *  write failure must never block the revert that's recovering the install. */
const TERMINAL_LEDGER_KINDS: ReadonlySet<UpdateLedgerKind> = new Set<UpdateLedgerKind>([
  'apply_committed',
  'apply_reverted',
  'rolled_back',
]);

export const recordLedgerRevert = (ledgerPath: string, reason: string, now: number): void => {
  try {
    const ledger = createUpdateLedger(ledgerPath);
    // Find the still-in-flight apply (the last `apply_started` with no later
    // terminal for the same release) — the same derivation the server uses.
    const pending: UpdateLedgerEntry[] = [];
    for (const e of ledger.readAll()) {
      if (e.kind === 'apply_started') {
        pending.push(e);
      } else if (TERMINAL_LEDGER_KINDS.has(e.kind)) {
        const i = pending.findIndex((p) => p.release_identity === e.release_identity);
        if (i >= 0) pending.splice(i, 1);
      }
    }
    const inFlight = pending[pending.length - 1];
    if (!inFlight) return; // nothing in flight — server-side revert already recorded
    ledger.append({
      id: randomUUID(),
      kind: 'apply_reverted',
      at: now,
      from_version: inFlight.from_version,
      to_version: inFlight.to_version,
      channel: inFlight.channel,
      trigger: 'revert',
      release_identity: inFlight.release_identity,
      migration: inFlight.migration ?? false,
      detail: `launcher boot-health revert: ${reason}`,
    });
  } catch {
    /* best-effort — never block the recovery revert on a ledger write */
  }
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
  /** Data-volume root holding the update ledger (`updates.log`). Defaults to the
   *  parent of `binDir` (`/data`). The launcher records its boot-health revert
   *  there so the server's apply lock stays consistent. */
  dataDir?: string;
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
  const oldPath = `${currentPath}.old`;
  const counterPath = join(binDir, 'boot-failures.json');
  const ledgerPath = join(opts.dataDir ?? dirname(binDir), UPDATE_LEDGER_FILE);
  const runBinary = opts.runBinary ?? defaultRunBinary;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = opts.log ?? ((m: string) => console.error(`[launcher] ${m}`));
  const now = () => Date.now();
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
    const decision = decideLaunch({
      currentExists: existsSync(currentPath),
      currentVerified: verifyBinarySignature(currentPath, opts.pubkey),
      oldExists: existsSync(oldPath),
      oldVerified: verifyBinarySignature(oldPath, opts.pubkey),
      failureCount: readFailureCount(counterPath),
      threshold: BOOT_FAILURE_THRESHOLD,
    });

    if (decision.action === 'refuse') {
      log(`refusing to launch: ${decision.reason}`);
      return 1;
    }
    if (decision.action === 'revert-and-exec-old') {
      log(`auto-revert to previous binary: ${decision.reason}`);
      try {
        // Record the terminal FIRST (while the in-flight `apply_started` is
        // still derivable + `recued.old` still present) so the server's apply
        // lock can never wedge if the swap below is interrupted.
        recordLedgerRevert(ledgerPath, decision.reason, now());
        revertToOld(currentPath, oldPath);
        resetFailureCount(counterPath);
      } catch (err) {
        log(`revert failed: ${err instanceof Error ? err.message : String(err)}`);
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
