/** Pre-SQLite recovery for `recued update rollback`.
 *
 * A staged release is precisely the generation whose native addon or database
 * open may have failed on this host. Importing the ordinary update profile first
 * loads its SQLite-backed composition and makes the advertised recovery command
 * depend on the failed component. This leaf reads only the external JSONL ledger
 * and performs the file-level complete revert (database snapshot, binary/addon,
 * and webclient) before that module graph is admitted.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type { BootTrace } from '../cli/boot-trace.js';
import { getArg, getFlag, parsePositionals } from '../cli/parse.js';
import { runningAsPackagedBinary } from '../packaged-binary.js';
import { resolveRealmDbPath } from '../realm-db-path.js';
import { deriveInFlightApply } from '../update/apply-orchestrator.js';
import {
  resolveDistributionChannel,
  resolveUpdateBinaryPath,
} from '../update/install-paths.js';
import { manualRollbackJournalPathForDb } from '../update/manual-rollback-journal.js';
import {
  revertStagedRelease,
  type RevertReleaseOutcome,
} from '../update/supervised-boot-failure.js';
import { acquireUpdateLease, updateLeasePathFor } from '../update/update-lease.js';
import { createUpdateLedger, UPDATE_LEDGER_FILE } from '../update/update-ledger.js';
import {
  liveServerHolding,
  refuseUnpackagedBinaryUpdate,
  refuseWhileRunning,
} from './update-profile-guards.js';

export interface StagedUpdateRollbackOptions {
  args: string[];
  /** Version reported by the executable running this pre-SQLite recovery. */
  serverVersion: string;
  bootTrace?: BootTrace;
  env?: NodeJS.ProcessEnv;
}

const hasRecoverableStagedApply = (
  dbPath: string,
  serverVersion: string,
): boolean => {
  try {
    const ledgerPath = join(dirname(resolve(dbPath)), UPDATE_LEDGER_FILE);
    const inFlight = deriveInFlightApply(createUpdateLedger(ledgerPath));
    if (inFlight === null) return false;
    if (inFlight.staged) return true;

    // The pair swap reaches disk BEFORE `apply_staged` is appended. A kill or
    // ENOSPC between those operations therefore leaves only `apply_started`,
    // even though this command is already running as the target release. Boot
    // reconciliation trusts that executable identity as independent disk
    // evidence; emergency rollback must use the same witness or it falls into
    // the SQLite/native graph precisely when the newly-installed addon broke.
    return inFlight.entry.to_version === serverVersion
      && inFlight.entry.release_identity
        === `${inFlight.entry.channel}:${serverVersion}`;
  } catch {
    // No readable staged/disk witness means no authority for this pre-open path
    // to mutate anything. The ordinary rollback can still diagnose its state.
    return false;
  }
};

/** The staged-but-uncommitted revert, phrased for someone at a terminal. */
const printStagedRevert = (outcome: RevertReleaseOutcome): void => {
  switch (outcome.status) {
    case 'reverted':
      console.log('Abandoned the staged update and put the previous release back.');
      if (outcome.restoredSnapshot) {
        console.log('  The pre-migration database snapshot was restored as well.');
      }
      console.log('  Start the server to run on it again.');
      return;
    case 'busy':
      console.error(`Not now: ${outcome.reason}`);
      break;
    case 'refused':
      console.error(`Cannot undo the staged update: ${outcome.reason}`);
      if (outcome.noPreviousBinary) {
        console.error('  There is no `recued.old` beside the binary to go back to.');
      }
      break;
    case 'failed':
      console.error(`The revert failed part-way: ${outcome.detail}`);
      console.error(outcome.databaseRestored
        ? '  ⚠ The database was ALREADY restored to its pre-migration snapshot, so this\n'
          + '    install now has the OLD data under the NEW binary. Do not start the server;\n'
          + '    restore `recued.old` by hand before doing anything else.'
        : '  Nothing was changed — the binary and the database are as they were.');
      break;
  }
  process.exitCode = 1;
};

/** Try the recovery-only rollback path. Returns true when this invocation was
 * fully handled; false means there is no staged release and the router should
 * continue into the ordinary SQLite-backed update profile. */
export async function tryRunStagedUpdateRollback(
  options: StagedUpdateRollbackOptions,
): Promise<boolean> {
  const positionals = parsePositionals(options.args);
  const sub = positionals[1] ?? 'check';
  const wantsRollback = sub === 'rollback' || getFlag(options.args, 'rollback');
  if (!wantsRollback) return false;

  const env = options.env ?? process.env;
  const dbPath = resolveRealmDbPath(getArg(options.args, 'db') ?? env.DB_PATH);

  // A retained manual-rollback journal owns the next database open and the next
  // generation choice. Do not start a second recovery transaction over it.
  const retainedRollbackJournal = manualRollbackJournalPathForDb(dbPath);
  if (existsSync(retainedRollbackJournal)) {
    console.error(
      `A stopped-server rollback still requires pre-open recovery (${retainedRollbackJournal}).\n`
      + '  Start the server once; it will finish or safely refuse that recovery before opening\n'
      + '  the database. Then re-run this update command.',
    );
    process.exitCode = 74;
    return true;
  }

  if (!hasRecoverableStagedApply(dbPath, options.serverVersion)) return false;

  // `binary` defaults even in a source checkout. Without the runtime SEA check,
  // resolving the recovery target here yields process.execPath and a staged
  // ledger could make this command replace the owner's Node executable.
  if (resolveDistributionChannel(env) === 'binary' && !runningAsPackagedBinary()) {
    refuseUnpackagedBinaryUpdate();
    return true;
  }

  // Keep the existing stopped-realm contract. The host-wide lease closes the
  // race with a server beginning to boot, and the second realm-lock read closes
  // the race with a server that finished booting before this claim won.
  const holder = liveServerHolding(dbPath);
  if (holder) {
    refuseWhileRunning(holder, 'rollback');
    return true;
  }

  const binaryPath = resolveUpdateBinaryPath(env);
  const leasePath = updateLeasePathFor(binaryPath);
  let lease: { release: () => void };
  try {
    lease = acquireUpdateLease({ leasePath, operation: 'rollback' });
  } catch (err) {
    const leaseHolder = (err as { holder?: { pid: number; operation: string } }).holder;
    console.error(
      leaseHolder
        ? `Another update is already running on this install (pid ${leaseHolder.pid}, ${leaseHolder.operation}).\n`
          + '  Wait for it to finish, or if that process is gone, remove:\n'
          + `    ${leasePath}`
        : 'Another update is already running on this install.',
    );
    process.exitCode = 1;
    return true;
  }

  try {
    const holderUnderLease = liveServerHolding(dbPath);
    if (holderUnderLease) {
      refuseWhileRunning(holderUnderLease, 'rollback');
      return true;
    }
    // State can settle while we wait for the lease. Re-read under exclusion so
    // an old preflight decision can never revert a now-committed generation.
    if (!hasRecoverableStagedApply(dbPath, options.serverVersion)) return false;

    const outcome = revertStagedRelease({
      binaryPath,
      dbPath,
      reason: 'owner ran `recued update rollback` before the update committed',
      env,
      log: (message) => console.log(`  ${message}`),
    });
    options.bootTrace?.mark('update-staged-rollback', outcome.status);
    printStagedRevert(outcome);
    return true;
  } finally {
    lease.release();
  }
}
