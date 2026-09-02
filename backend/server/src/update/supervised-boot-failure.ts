/** What an OUTER supervisor does when the payload fails to start.
 *
 *  THE GAP THIS CLOSES. D-178's auto-revert is counted IN-PROCESS: the increment
 *  lives in `reconcileBootState` (`apply-orchestrator.ts`), so the newly-swapped
 *  binary has to boot far enough to record its own failure. That covers a binary
 *  that starts and then misbehaves. It cannot cover a binary that never executes
 *  at all — a truncated download that still passed staging, a wrong-architecture
 *  artifact, a missing dynamic symbol. Nothing runs, so nothing counts, and the
 *  unit restarts the same broken payload forever with a known-good `recued.old`
 *  sitting beside it. An early in-process increment does NOT fix this, and it is
 *  worth being explicit about why: there is no "early" inside a process that
 *  never starts.
 *
 *  ⛔ SO THE COUNTER MUST BE INCREMENTED BY SOMETHING THAT IS NOT THE PAYLOAD.
 *  On `docker-thin` that is `managed-launcher.ts`, supervising from the image.
 *  On the `binary` channel the supervisor is `recued-supervise`, a small POSIX
 *  script `install.sh` writes and updates never replace — the immutability is
 *  the whole point, since a supervisor that is swapped along with the payload
 *  shares its fate.
 *
 *  🔑 AND THE VERDICT RUNS IN `recued.old`, NOT IN THE SCRIPT. The script knows
 *  only "the payload exited N"; every rule — the threshold, the counter format,
 *  the revert transaction, the ledger terminal — stays here and is executed by
 *  the previous binary, which is known-good by construction: it is the thing we
 *  would be reverting TO. Restating any of that in shell would be a second copy
 *  of the rule, and the copies drift.
 *
 *  ⚠ THE LEDGER TERMINAL IS NOT COSMETIC. Reverting the files alone leaves the
 *  apply in flight, so when the restored binary boots, its own reconciliation
 *  sees a staged release it is not running, counts THAT as a failed boot, and
 *  works toward an auto-revert whose target we just consumed. Recording the
 *  terminal is what stops the revert from arming a second one.
 *
 *  ⛔⛔⛔ AND THE TERMINAL IS WHY THIS REVERT MUST BE COMPLETE, NOT PARTIAL. It
 *  restored the BINARY PAIR ONLY — no pre-migration snapshot, no webclient —
 *  while writing the terminal that says the operation is resolved. Walk what
 *  that produced. A payload that starts, runs its store DDL and THEN dies before
 *  the listener is this supervisor's case and no other: the in-process
 *  boot-failure counter runs post-listener, so it never sees it, and
 *  `snapshotRealmOnNewRelease` deliberately skips the realm with an apply in
 *  flight (`compose-storage-context.ts`) because the apply already took the
 *  snapshot. So the old binary came back on a MIGRATED database, behind the NEW
 *  webclient. Then: the terminal closed the operation, so the in-process
 *  auto-revert that WOULD have restored the snapshot could never run;
 *  the swap consumed `recued.old`, so `decideRollback` refuses for want of a
 *  previous binary; and the snapshot sat on disk with no supported command able
 *  to reach it. A downgrade the owner did not ask for, on data the new release
 *  had already rewritten, recorded as a successful recovery.
 *
 *  🔑 THIS IS THE ONE RECOVERY ACTOR THAT IS SAFE BY CONSTRUCTION. `restoreSnapshot`
 *  requires that NOTHING holds the database open, and the three in-process
 *  callers each pay for that differently (refuse in-process / close first / defer
 *  past the restart drain). Here the payload is DEAD and this verdict is a
 *  separate short-lived process that opens nothing — the precondition is simply
 *  true. So the completeness this path was missing is also the cheapest to add.
 *
 *  ⇒ ONE TRANSACTION, GATED BY THE SHARED RULE. `decideRollback` — the same
 *  function the rpc rollback and the in-process auto-revert consult — decides,
 *  and its `refuse` is honoured rather than reinvented: a migrating release with
 *  no snapshot leaves the binary ALONE and the apply in flight, because an old
 *  binary on a migrated database is the wedge, not the rescue.
 */
import {
  copyFileSync,
  existsSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  BOOT_FAILURE_THRESHOLD,
  incrementFailureCount,
  OLD_SUFFIX,
  resetFailureCount,
} from '../launcher/managed-launcher.js';
import { BOOT_FAILURE_COUNTER_FILE } from './boot-failure-counter.js';
import { deriveCommittedRelease, deriveInFlightEntry } from './apply-orchestrator.js';
import {
  restoreSnapshot,
  reconcileInterruptedPairSwap,
  rollbackSwap,
  sidecarPathsFor,
} from './binary-apply-executor.js';
import { realmSnapshotPath } from './realm-generation-snapshot.js';
import { webclientBundleDirForDataDir } from '../webclient-bundle-loader.js';
import { acquireUpdateLease, updateLeasePathFor } from './update-lease.js';
import {
  createUpdateLedger,
  type UpdateLedgerEntry,
  type UpdateLedgerKind,
} from './update-ledger.js';
import { decideRollback, shouldAutoRevert } from './apply-state-machine.js';
import { UPDATE_LEDGER_FILE } from './update-ledger.js';
import { fsyncDir, writeFileAtomicSync } from '../durable-fs.js';

/** Exit codes the supervising script reads. Kept small and explicit because a
 *  shell `case` is the only consumer. */
export const SUPERVISED_RETRY_NOW = 0;
export const SUPERVISED_RETRY_AFTER_BACKOFF = 10;
export const SUPERVISED_GIVE_UP = 20;

export interface SupervisedBootFailureInput {
  /** The live binary, by full path — see `RevertReleaseInput.binaryPath` for why
   *  this is not a directory. */
  binaryPath: string;
  /** The realm database the failed payload was serving.
   *
   *  ⛔ ONE INPUT, NOT TWO. This took a `dataDir` instead, which was enough to
   *  find `updates.log` and nothing else. The recovery also has to name the
   *  database it restores OVER and the snapshot beside it, and those are
   *  derivations of this single path — passing the directory separately would
   *  let a caller hand us a data dir that does not hold this db, and the input
   *  that disagreed would be the one aimed at the file we replace. */
  dbPath: string;
  /** The payload's exit status, for the ledger detail line. */
  exitCode: number;
  threshold?: number;
  now?: () => number;
  log?: (message: string) => void;
  /** Read for `RECUED_NATIVE_BINDING` / `RECUED_WEBCLIENT_DIR` — the same
   *  overrides the apply honoured when it swapped those paths. The supervising
   *  script inherits the unit's environment, so this is the server's own. */
  env?: NodeJS.ProcessEnv;
}

export type SupervisedBootFailureOutcome =
  | { action: 'reverted'; count: number; restoredSnapshot: boolean }
  | { action: 'no-apply-in-flight'; count: number }
  | { action: 'counted'; count: number }
  | { action: 'no-rollback-target'; count: number }
  /** The release IS on trial and `recued.old` IS here, but reverting would leave
   *  an old binary on a database the failed release already migrated. Nothing is
   *  touched and the apply stays in flight, so an owner still has the snapshot
   *  and both binaries to work with. */
  | { action: 'revert-unsafe'; count: number; reason: string }
  /** Another process holds the host-wide update lease. Nothing was touched, and
   *  this is the one refusal that should COME BACK rather than give up: the
   *  install that is running will finish, and it is probably the fix. */
  | { action: 'update-in-progress'; count: number; reason: string }
  | { action: 'revert-failed'; count: number; detail: string };

export const handleSupervisedBootFailure = (
  input: SupervisedBootFailureInput,
): SupervisedBootFailureOutcome => {
  const log = input.log ?? ((m: string) => console.error(`[supervise] ${m}`));
  const now = input.now ?? (() => Date.now());
  const threshold = input.threshold ?? BOOT_FAILURE_THRESHOLD;
  const env = input.env ?? process.env;

  const currentPath = input.binaryPath;
  const oldPath = `${currentPath}${OLD_SUFFIX}`;
  // The counter still lives beside the binary, which is what `binaryDir` always
  // meant — it is derived here rather than passed, so the two cannot disagree.
  const counterPath = join(dirname(currentPath), BOOT_FAILURE_COUNTER_FILE);
  const dataDir = dirname(input.dbPath);
  const ledgerPath = join(dataDir, UPDATE_LEDGER_FILE);
  const snapshotPath = realmSnapshotPath(input.dbPath);

  const count = incrementFailureCount(counterPath);
  log(`payload exited ${input.exitCode} (boot failure ${count}/${threshold})`);

  if (!shouldAutoRevert(count, threshold)) {
    return { action: 'counted', count };
  }
  // ⛔⛔ IS A RELEASE ACTUALLY ON TRIAL? `recued.old` OUTLIVES THE UPDATE THAT
  // CREATED IT — it is the retained previous binary and stays on disk long after
  // the update committed. So "there is something to revert to" is not the same
  // question as "is this failure the new release's fault", and conflating them
  // means three consecutive non-zero exits from ANY cause — an unopenable realm,
  // a permissions change, a full disk — silently downgrade a binary that has
  // been serving for weeks and is not implicated at all.
  //
  // 🔑 The in-process counter never had this problem: it only counts a release
  // that is STAGED AND UNCOMMITTED. This supervisor exists to extend that rule
  // to a payload that cannot start, not to widen it. So it asks the same
  // question, via the same derivation the server uses.
  //
  // ⚠ `recordLedgerRevert` already asks this internally and declines to write a
  // terminal when nothing is in flight — which would have left the binary
  // downgraded on disk with NOTHING in the ledger saying so. Asking one step
  // earlier is what turns a missing log line into a refusal.
  // ⛔ THE WHOLE ENTRY, NOT JUST ITS IDENTITY. `migration` is what decides
  // whether the database also has to come back, and reading only the release
  // string is how that question stopped being asked.
  const inFlight = readInFlightEntry(ledgerPath);
  if (inFlight === null) {
    log(`payload exited ${input.exitCode} ${count} times, but no release is on trial `
      + `— not reverting (this failure is not the binary's doing)`);
    return { action: 'no-apply-in-flight', count };
  }

  // ⛔ THE TRANSACTION ITSELF IS SHARED, NOT RESTATED. Everything from here —
  // the `decideRollback` gate, the snapshot, the swap, the terminal — is the
  // same work the `docker-thin` launcher's revert needs, and the copies drifted
  // once already. This supervisor owns the QUESTION ("is this failure the new
  // release's fault"); `revertStagedRelease` owns the ACT.
  const outcome = revertStagedRelease({
    binaryPath: input.binaryPath,
    dbPath: input.dbPath,
    reason: `boot health failed ${count} times (payload exited ${input.exitCode}, never started)`,
    ...(input.now === undefined ? {} : { now: input.now }),
    log,
    env,
  });
  switch (outcome.status) {
    case 'reverted':
      return { action: 'reverted', count, restoredSnapshot: outcome.restoredSnapshot };
    case 'busy':
      // NOT A GIVE-UP. Somebody is installing something on this host right now;
      // halting the unit would leave the server down after they finish, which is
      // the opposite of what their update is for.
      log(`boot failed ${count} times, but ${outcome.reason} — waiting rather than reverting`);
      return { action: 'update-in-progress', count, reason: outcome.reason };
    case 'failed':
      return { action: 'revert-failed', count, detail: outcome.detail };
    case 'refused':
      if (outcome.noPreviousBinary) {
        // Nothing to revert to — a first install, or a revert already consumed
        // the one generation we keep. Say so rather than looping in silence: the
        // owner has to intervene, and the log line is the only thing that tells
        // them.
        log(`boot failed ${count} times and there is no ${oldPath} to revert to`);
        return { action: 'no-rollback-target', count };
      }
      // ⚠ CHANGING NOTHING IS THE RESCUE HERE. The alternative — swap the binary
      // and hope — is what put an old binary on a migrated database, and it also
      // consumed `recued.old`, which is the very thing that made the state
      // unrecoverable afterwards. Leaving the apply in flight keeps every option
      // the owner has: both binaries on disk, and a `recued update rollback` that
      // can still say why it refuses.
      log(`boot failed ${count} times but this revert would be unsafe: ${outcome.reason}`
        + ' — nothing was changed and the apply stays in flight');
      return { action: 'revert-unsafe', count, reason: outcome.reason };
  }
};

export type RevertReleaseOutcome =
  | { status: 'reverted'; restoredSnapshot: boolean }
  | { status: 'refused'; reason: string; noPreviousBinary: boolean }
  /** Somebody else holds the host-wide update lease. Nothing was touched, and
   *  the right answer is to come back rather than to give up: whatever they are
   *  installing will finish, and it is probably the fix. */
  | { status: 'busy'; reason: string }
  /** The transaction threw part-way. `databaseRestored` says whether the
   *  pre-migration snapshot had already gone over the live database when it did
   *  — the difference between "nothing happened" and "the install now has the
   *  OLD data under the NEW binary", which decides whether the operation may be
   *  closed. */
  | { status: 'failed'; detail: string; databaseRestored: boolean };

/** Durable witness for the gap between the physical revert and its terminal
 * ledger append. The hash is captured from `recued.old` before the swap, so a
 * retry can recognize that exact generation at the live path without executing
 * a possibly-broken payload or trusting a second version label. */
export const REVERT_JOURNAL_SUFFIX = '.revert-journal.json';

interface RevertJournal {
  schema: 1;
  release_identity: string;
  previous_sha256: string;
  restored_snapshot: boolean;
}

const sha256File = (path: string): string | null => {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
};

const readRevertJournal = (binaryPath: string): RevertJournal | null => {
  try {
    const value = JSON.parse(readFileSync(`${binaryPath}${REVERT_JOURNAL_SUFFIX}`, 'utf8')) as Partial<RevertJournal>;
    if (
      value.schema !== 1
      || typeof value.release_identity !== 'string'
      || !/^[0-9a-f]{64}$/.test(value.previous_sha256 ?? '')
      || typeof value.restored_snapshot !== 'boolean'
    ) return null;
    return value as RevertJournal;
  } catch {
    return null;
  }
};

const writeRevertJournal = (binaryPath: string, journal: RevertJournal): void => {
  const path = `${binaryPath}${REVERT_JOURNAL_SUFFIX}`;
  writeFileAtomicSync(path, `${JSON.stringify(journal)}\n`);
};

export const dropRevertJournal = (binaryPath: string): void => {
  const path = `${binaryPath}${REVERT_JOURNAL_SUFFIX}`;
  rmSync(path, { force: true });
  try { fsyncDir(dirname(path)); } catch { /* best-effort after unlink */ }
};

export const revertJournalMatchesCurrent = (
  binaryPath: string,
  releaseIdentity: string,
): boolean => {
  const journal = readRevertJournal(binaryPath);
  return journal?.release_identity === releaseIdentity
    && sha256File(binaryPath) === journal.previous_sha256;
};

export interface RevertReleaseInput {
  /** The LIVE BINARY, by full path — not its directory.
   *
   *  ⛔⛔ THIS WAS A DIRECTORY AND THE FILE NAME WAS HARD-CODED `recued`, WHICH IS
   *  WRONG ON EVERY WINDOWS INSTALL. `install.ps1` lays the executable down as
   *  `recued.exe`, so the staged pair is `recued.exe` / `recued.exe.old` — and
   *  this looked for `recued.old`, found nothing, and answered "no previous
   *  binary" while leaving the NEW executable live. The rollback the CLI
   *  advertises could not run on the platform whose installer has no supervisor
   *  to fall back on. Measured with `recued.exe.old` present.
   *
   *  🔑 The caller already HAS the path — `resolveUpdateBinaryPath` returns it,
   *  and `process.execPath` carries the real name including `.exe`. Passing the
   *  directory threw that away and made the callee guess; the guess was a
   *  constant. Ask what the caller can know, and take it. */
  binaryPath: string;
  /** The realm database the failed payload was serving — see the note on
   *  `SupervisedBootFailureInput.dbPath`. */
  dbPath: string;
  /** Why the CALLER decided a revert is warranted, recorded on the terminal.
   *  The two supervisors decide differently and both are right: the binary
   *  channel counts consecutive boot failures against a release on trial; the
   *  `docker-thin` launcher also reverts a current binary that is MISSING or
   *  fails its signature re-verify, which is its I-2 job and has nothing to do
   *  with boot health. Neither decision belongs in here. */
  reason: string;
  now?: () => number;
  log?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
  /** Fault-injection seam for the disk-complete / terminal-lost boundary. */
  recordRevert?: typeof recordLedgerRevert;
}

/** The complete revert transaction, shared by both outer supervisors: gate on
 *  `decideRollback`, restore the pre-migration snapshot when one applies, swap
 *  the binary pair AND the displaced webclient back, record the terminal, clear
 *  the counter.
 *
 *  ⛔⛔ IT PERFORMS, IT DOES NOT DECIDE WHETHER TO TRY. The caller has already
 *  concluded the current release cannot be run; what this decides is the
 *  narrower and non-negotiable question of whether the revert would be SAFE, and
 *  that answer comes from `decideRollback` — the same function the rpc rollback
 *  and the in-process auto-revert consult.
 *
 *  🔑 SAFE BY CONSTRUCTION IN BOTH CALLERS. `restoreSnapshot` requires that
 *  nothing holds the database open; both supervisors run with the payload dead
 *  and open nothing themselves. */
export const revertStagedRelease = (input: RevertReleaseInput): RevertReleaseOutcome => {
  const log = input.log ?? ((m: string) => console.error(`[revert] ${m}`));
  const now = input.now ?? (() => Date.now());
  const env = input.env ?? process.env;

  const currentPath = input.binaryPath;
  const oldPath = `${currentPath}${OLD_SUFFIX}`;
  const counterPath = join(dirname(currentPath), BOOT_FAILURE_COUNTER_FILE);
  const dataDir = dirname(input.dbPath);
  const ledgerPath = join(dataDir, UPDATE_LEDGER_FILE);
  const snapshotPath = realmSnapshotPath(input.dbPath);

  // ⛔⛔⛔ CLAIM THE MUTEX, DO NOT MERELY RUN INSIDE THE WINDOW IT PROTECTS. This
  // path mutates the same set `recued update apply` does — the binary, the addon,
  // the webclient bundle and the DATABASE — and took nothing. It also runs at the
  // one moment nothing else excludes it: the payload is dead, so the CLI's
  // `liveServerHolding` check finds no server and proceeds. A recovery revert and
  // an owner-run apply could therefore rename over each other's files.
  //
  // ⚠ ANY FAILURE TO ACQUIRE STOPS US, not just a held lease — the same rule
  // `runApply` applies (it answers `busy` on any throw). Proceeding without the
  // exclusion is the behaviour being removed, and a lease we cannot write is a
  // binary directory we probably cannot swap in either.
  let lease: { release: () => void };
  try {
    lease = acquireUpdateLease({
      leasePath: updateLeasePathFor(currentPath),
      operation: 'revert',
    });
  } catch (err) {
    const holder = (err as { holder?: { pid: number; operation: string } }).holder;
    const reason = holder
      ? `another update is running on this install (pid ${holder.pid}, ${holder.operation})`
      : `the update lease at ${updateLeasePathFor(currentPath)} could not be taken`;
    log(`not reverting: ${reason}`);
    return { status: 'busy', reason };
  }
  try {
    return revertUnderLease();
  } finally {
    lease.release();
  }

  /** The transaction itself, with the lease held for all of it — including the
   *  `decideRollback` reads, which are of state another actor could change. */
  function revertUnderLease(): RevertReleaseOutcome {
  const recordRevert = input.recordRevert ?? recordLedgerRevert;
  const inFlight = readInFlightEntry(ledgerPath);
  let journal = readRevertJournal(currentPath);

  if (journal && inFlight && journal.release_identity === inFlight.release_identity) {
    // A kill may have interrupted `rollbackSwap` itself. Its stable asides are a
    // journal for that inner transaction; finish it before comparing hashes.
    try {
      reconcileInterruptedPairSwap(oldPath, currentPath, sidecarPathsFor(currentPath, env));
    } catch (err) {
      return {
        status: 'failed',
        detail: err instanceof Error ? err.message : String(err),
        databaseRestored: journal.restored_snapshot,
      };
    }
    if (sha256File(currentPath) === journal.previous_sha256) {
      // The exact generation that was `recued.old` before this revert is already
      // live. Retrying the swap would consume the newly rebuilt `.old` and move
      // back a second generation; only the lost terminal remains.
      const recorded = recordRevert(
        ledgerPath,
        `${input.reason}${journal.restored_snapshot ? ' (snapshot restored)' : ''}`,
        now(),
      );
      if (recorded) {
        try { dropRevertJournal(currentPath); } catch { /* terminal is authoritative */ }
      }
      resetFailureCount(counterPath);
      log(recorded
        ? 'the physical revert was already complete; repaired its missing ledger terminal'
        : 'the physical revert is complete, but its ledger terminal is still unavailable; leaving the journal for retry');
      return { status: 'reverted', restoredSnapshot: journal.restored_snapshot };
    }
  } else if (journal) {
    // It belongs to an operation the ledger already closed (or a different
    // release). It cannot authorize any move in this transaction.
    try { dropRevertJournal(currentPath); } catch { /* overwritten below if needed */ }
    journal = null;
  }

  const appliedMigration = readAppliedMigration(ledgerPath);
  if (appliedMigration === null) {
    // ⛔⛔ NEITHER ANSWER IS SAFE TO GUESS, SO REFUSE. Guessing `false` swaps an
    // old binary onto a schema that may already be migrated; guessing `true`
    // restores a snapshot that may predate a COMMITTED, working release, which
    // destroys data rather than merely downgrading a file. An unreadable ledger
    // is the one input that makes the question unanswerable, and the only honest
    // move is to change nothing and say so.
    return {
      status: 'refused',
      reason: 'the update ledger could not be read, so whether the failed release migrated the '
        + 'database is unknowable — refusing rather than guessing',
      noPreviousBinary: false,
    };
  }

  // ⛔ THE SHARED RULE DECIDES, NOT THIS FILE. Its refusals are load-bearing —
  // see the header.
  const decision = decideRollback({
    appliedMigration,
    hasPreviousBinary: existsSync(oldPath),
    hasSnapshot: existsSync(snapshotPath),
  });
  if (decision.action === 'refuse') {
    return { status: 'refused', reason: decision.reason, noPreviousBinary: !existsSync(oldPath) };
  }

  const restoredSnapshot = decision.action === 'restore-snapshot';
  // ⛔ SET BEFORE THE CALL, NEVER AFTER IT. `restoreSnapshot` replaces the
  // database with a rename that is its LAST step, so a throw almost always means
  // it did not land — but "almost always" is not something to record a terminal
  // on. Raising the flag first makes the uncertain case take the careful branch.
  let databaseTouched = false;
  try {
    if (inFlight) {
      const previousSha256 = sha256File(oldPath);
      if (previousSha256 === null) throw new Error('could not hash the previous binary before reverting');
      const nextJournal: RevertJournal = {
        schema: 1,
        release_identity: inFlight.release_identity,
        previous_sha256: previousSha256,
        restored_snapshot: restoredSnapshot,
      };
      if (
        journal?.release_identity !== nextJournal.release_identity
        || journal.previous_sha256 !== nextJournal.previous_sha256
        || journal.restored_snapshot !== nextJournal.restored_snapshot
      ) {
        writeRevertJournal(currentPath, nextJournal);
      }
      journal = nextJournal;
    }
    // ⛔ DISK FIRST, TERMINAL AFTER — the same ordering the launcher and the
    // server's rollback both settled on. A terminal written first would claim a
    // revert that a failed swap never performed.
    //
    // ⛔ AND WITHIN THE DISK WORK: SNAPSHOT FIRST, BINARY LAST. Identical to
    // `performAutoRevert` and `runRollbackLeased`, for the identical reason —
    // the copy is the failure-prone step, and if it throws the binary is
    // untouched, so we stay on a consistent (new binary, new schema) install
    // rather than manufacturing the old-binary-on-migrated-db state by failing
    // halfway. The swap is an atomic rename and goes last.
    if (restoredSnapshot) {
      databaseTouched = true;
      restoreSnapshot(snapshotPath, input.dbPath, (from, to) => copyFileSync(from, to));
    }
    // The binary pair AND the webclient the apply displaced. `rollbackSwap` is
    // the same primitive the rpc rollback uses; the webclient half is best-effort
    // INSIDE it, so a bundle that will not move never costs us the binary revert.
    rollbackSwap(
      oldPath,
      currentPath,
      sidecarPathsFor(currentPath, env),
      webclientBundleDirForDataDir(dataDir, env.RECUED_WEBCLIENT_DIR),
    );
    const recorded = recordRevert(
      ledgerPath,
      `${input.reason}${restoredSnapshot ? ' (snapshot restored)' : ''}`,
      now(),
    );
    if (recorded && journal) {
      try { dropRevertJournal(currentPath); } catch { /* terminal is authoritative */ }
    }
    resetFailureCount(counterPath);
    log(`reverted to the previous binary${restoredSnapshot ? ' and the pre-migration snapshot' : ''}`
      + (recorded ? '' : '; the terminal ledger write will be retried from the durable revert journal'));
    return { status: 'reverted', restoredSnapshot };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // ⛔⛔⛔ A HALF-DONE REVERT MUST NOT BE RECORDED AS A FINISHED ONE. This wrote
    // the terminal unconditionally, with the detail `revert FAILED (payload
    // unchanged)` — a sentence that was TRUE while this function only moved
    // binaries, and became FALSE the moment a database restore went in above it.
    // Reproduced: restore succeeds, the addon rename fails, `rollbackSwap`
    // unwinds the executable, and the install is left holding the PREVIOUS
    // database under the FAILED release's binary while the ledger says the
    // operation is resolved and nothing changed.
    //
    // 🔑 AND THE TERMINAL IS WHAT MAKES THAT PERMANENT. Every automatic recovery
    // is gated on a release being on trial — `hasApplyInFlight` here, and
    // `evaluatePendingApplyOnBoot` in the server — so closing the operation
    // retires the only mechanism that would try again. The owner's
    // `recued update rollback` is not the fallback it looks like either: its
    // context comes from `deriveCommittedRelease`, and an install whose FIRST
    // update failed this way has no `apply_committed` to find, so it answers
    // "nothing to roll back".
    //
    // ⇒ Leave it IN FLIGHT and say so. The snapshot file survives its own
    // restore, so the restore is idempotent and the swap is simply retryable:
    // the next start counts a failure against the same on-trial release, reaches
    // the same decision, and redoes both steps. Nothing here is lost by waiting;
    // recording a terminal is what loses it.
    if (databaseTouched) {
      log(`revert FAILED after the database was restored: ${detail}`);
      log('  this install now has the PREVIOUS database under the FAILED release\'s binary. '
        + 'The operation is deliberately left OPEN so the next start retries it — the snapshot '
        + 'is still on disk and restoring it again is a no-op.');
      return { status: 'failed', detail, databaseRestored: true };
    }
    // Nothing was written: no snapshot restore was attempted, and `rollbackSwap`
    // unwinds its own renames. Closing the operation is honest here, and it is
    // what keeps the restored-or-not binary from fighting a phantom apply.
    log(`revert failed: ${detail}`);
    const recorded = recordRevert(
      ledgerPath,
      `revert FAILED (binary and database unchanged): ${detail}`,
      now(),
    );
    if (recorded && journal) {
      try { dropRevertJournal(currentPath); } catch { /* terminal is authoritative */ }
    }
    return { status: 'failed', detail, databaseRestored: false };
  }
  }
};

/** Did the release we are reverting AWAY FROM migrate the schema? `null` when the
 *  ledger cannot be read at all.
 *
 *  ⛔ TWO SITUATIONS, ONE QUESTION. A release ON TRIAL answers for itself. With
 *  nothing in flight — the launcher reverting a MISSING or unverifiable current
 *  binary — the release being downgraded is the last COMMITTED one, which is
 *  exactly the derivation the owner-facing `runRollback` already uses to build
 *  its `RollbackContext`. Reading only the in-flight entry would have answered
 *  `false` for that case and swapped an old binary onto a migrated schema. */
const readAppliedMigration = (ledgerPath: string): boolean | null => {
  try {
    if (!existsSync(ledgerPath)) return false;   // no ledger, no apply, nothing migrated
    const ledger = createUpdateLedger(ledgerPath);
    const inFlight = deriveInFlightEntry(ledger);
    if (inFlight !== null) return inFlight.migration ?? false;
    return deriveCommittedRelease(ledger)?.appliedMigration ?? false;
  } catch {
    return null;
  }
};

export const exitCodeFor = (outcome: SupervisedBootFailureOutcome): number => {
  switch (outcome.action) {
    case 'reverted':
      return SUPERVISED_RETRY_NOW;
    case 'counted':
    // Keep retrying rather than giving up: this is the shape a TRANSIENT
    // environment failure takes, and retrying is what the units did before a
    // supervisor existed.
    case 'no-apply-in-flight':
    // Same reasoning, different cause: another update is mid-flight on this
    // host. It will end, and what it leaves behind is very likely bootable.
    case 'update-in-progress':
      return SUPERVISED_RETRY_AFTER_BACKOFF;
    // `revert-unsafe` gives up for the same reason `no-rollback-target` does:
    // the payload is broken and there is no move left that this process can make
    // safely, so looping would only hide that from the owner who has to act.
    default:
      return SUPERVISED_GIVE_UP;
  }
};

/** The staged-but-uncommitted apply, i.e. the release actually on trial — or
 *  null. An unreadable ledger answers NULL, which declines to revert — the safe
 *  direction, since the cost is a retry loop and the alternative is downgrading a
 *  binary on evidence we could not read. */
const readInFlightEntry = (ledgerPath: string): UpdateLedgerEntry | null => {
  try {
    if (!existsSync(ledgerPath)) return null;
    return deriveInFlightEntry(createUpdateLedger(ledgerPath));
  } catch {
    return null;
  }
};

/** Record an outer supervisor's revert as a TERMINAL ledger entry so the
 *  server's apply lock + on-boot reconcile see the staged release as resolved.
 *  Without this the revert physically restores `recued.old` but the ledger still
 *  shows an unterminated `apply_started` — the server would then block every
 *  future apply AND try its own auto-revert into a `recued.old` the supervisor
 *  already consumed. A ledger write failure never unwinds the physical recovery;
 *  the false result keeps the durable revert journal for a terminal-only retry.
 *
 *  ⚠ IT LIVES HERE NOW, NOT IN `managed-launcher.ts`. It was defined beside the
 *  frozen image launcher back when that launcher wrote its own terminal; it no
 *  longer does (it delegates the whole revert to `recued revert-release`), and
 *  leaving the writer there kept dragging `update-ledger` into a bundle that is
 *  supposed to import nothing from the server. */
const TERMINAL_LEDGER_KINDS: ReadonlySet<UpdateLedgerKind> = new Set<UpdateLedgerKind>([
  'apply_committed',
  'apply_reverted',
  'rolled_back',
]);

export const recordLedgerRevert = (ledgerPath: string, reason: string, now: number): boolean => {
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
    if (!inFlight) return true; // server-side revert already recorded
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
      detail: `supervisor revert: ${reason}`,
    });
    return true;
  } catch {
    // The physical recovery must not be unwound for a log failure, but the
    // caller needs to retain its durable revert journal and retry only this
    // terminal rather than swapping a second generation.
    return false;
  }
};
