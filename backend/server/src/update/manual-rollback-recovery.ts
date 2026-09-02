/** Pre-open recovery for a stopped-server manual rollback.
 *
 * This module owns no SQLite handle. It runs under the host update lease after
 * interrupted pair-swap reconciliation and before the server imports its
 * database graph. A durable `rolled_back` row is the write-ahead commit; without
 * one, exact physical hashes decide whether the current generation aborts or the
 * previous generation completed. Unknown database bytes are never overwritten. */
import { existsSync } from 'node:fs';
import type { UpdateLedger, UpdateLedgerEntry } from './update-ledger.js';
import {
  dropManualRollbackJournal,
  inspectManualRollbackJournal,
  sha256File,
  validateManualRollbackPreviousGeneration,
  type CurrentManualRollbackJournal,
  type ManualRollbackJournal,
  type ManualRollbackJournalTarget,
} from './manual-rollback-journal.js';

export type ManualRollbackPreopenOutcome =
  | { action: 'none' }
  | { action: 'aborted'; releaseIdentity: string; reason: string }
  | { action: 'completed'; releaseIdentity: string; reason: string }
  | { action: 'refused'; releaseIdentity?: string; reason: string };

export interface ManualRollbackPreopenDeps {
  target: ManualRollbackJournalTarget;
  ledger: UpdateLedger;
  restoreDatabase: (sourcePath: string, dbPath: string) => void;
  /** Finish a write-ahead-committed pair rollback while this newer binary is
   * still executing. Required only when the terminal receipt won the race but
   * the live path still contains the current generation. */
  completeRollbackSwap?: () => void;
  now?: () => number;
}

const terminalFor = (
  ledger: UpdateLedger,
  operationId: string,
): { entry: UpdateLedgerEntry; index: number; entries: UpdateLedgerEntry[] } | undefined => {
  const entries = ledger.readAll();
  const index = entries.findIndex((entry) =>
    entry.id === operationId
    && (entry.kind === 'rolled_back' || entry.kind === 'operation_refused'));
  return index < 0 ? undefined : { entry: entries[index]!, index, entries };
};

const appendTerminal = (
  deps: ManualRollbackPreopenDeps,
  journal: ManualRollbackJournal,
  kind: 'rolled_back' | 'operation_refused',
): void => {
  deps.ledger.append({
    id: journal.operation_id,
    kind,
    at: (deps.now ?? Date.now)(),
    from_version: journal.from_version,
    to_version: journal.to_version,
    channel: journal.channel,
    trigger: 'manual',
    release_identity: journal.release_identity,
    migration: journal.migration,
    ...(kind === 'rolled_back'
      ? {
          detail: `recovered a stopped-server manual rollback before database open${journal.restored_snapshot ? ' (snapshot restored)' : ''}`,
        }
      : {
          reserved_operation_id: journal.operation_id,
          reserved_operation: 'rollback' as const,
          detail: 'the stopped-server process died before the manual rollback changed the live binary; restored its database generation',
        }),
  });
};

const restoreVerified = (
  deps: ManualRollbackPreopenDeps,
  sourcePath: string,
  expectedSha256: string,
): string | null => {
  if (sha256File(sourcePath) !== expectedSha256) {
    return `required recovery source ${sourcePath} is missing or no longer matches its durable hash`;
  }
  try {
    deps.restoreDatabase(sourcePath, deps.target.dbPath);
  } catch (err) {
    return `could not restore ${deps.target.dbPath}: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (sha256File(deps.target.dbPath) !== expectedSha256) {
    return `restored database ${deps.target.dbPath} does not match its durable hash`;
  }
  return null;
};

const databaseRecoveryForCurrentBinary = (
  deps: ManualRollbackPreopenDeps,
  journal: CurrentManualRollbackJournal,
  database: 'rolled-back' | 'unchanged' | 'unknown' | 'not-applicable' | 'unproven',
): string | null => {
  if (!journal.restored_snapshot || database === 'unchanged') return null;
  // Unknown bytes may be writes accepted by N-1 after the physical rollback and
  // before this newer generation was applied again. Restoring the retained undo
  // in that state is data loss, not recovery. Exact snapshot bytes are the only
  // state that proves the current binary won before N-1 could have served.
  if (database === 'unknown') {
    return 'the current binary is live but the database matches neither rollback generation; refusing to overwrite possible post-rollback writes';
  }
  return restoreVerified(
    deps,
    journal.undo_path,
    journal.current_database_sha256 as string,
  );
};

export const recoverManualRollbackBeforeOpen = (
  deps: ManualRollbackPreopenDeps,
): ManualRollbackPreopenOutcome => {
  if (!existsSync(deps.target.journalPath)) return { action: 'none' };

  const recovery = inspectManualRollbackJournal(deps.target);
  if (!recovery) {
    return {
      action: 'refused',
      reason: `manual rollback journal ${deps.target.journalPath} is corrupt or belongs to another realm`,
    };
  }
  const { journal } = recovery;
  const existing = terminalFor(deps.ledger, journal.operation_id);
  if (existing) {
    if (existing.entry.kind === 'operation_refused') {
      if (recovery.disk !== 'unchanged') {
        return {
          action: 'refused',
          releaseIdentity: journal.release_identity,
          reason: 'the rollback refusal is durable but the live binary no longer matches the generation it refused to change',
        };
      }
      if (journal.schema === 3) {
        const databaseFailure = databaseRecoveryForCurrentBinary(
          deps,
          journal,
          recovery.database,
        );
        if (databaseFailure) {
          return {
            action: 'refused',
            releaseIdentity: journal.release_identity,
            reason: databaseFailure,
          };
        }
      }
      try {
        dropManualRollbackJournal(deps.target);
      } catch (err) {
        return {
          action: 'refused',
          releaseIdentity: journal.release_identity,
          reason: `terminal receipt exists but recovery cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      return {
        action: 'aborted',
        releaseIdentity: journal.release_identity,
        reason: 'the rollback refusal was already durable; restored the current database generation and cleaned its retained journal',
      };
    }

    const followedByApply = existing.entries
      .slice(existing.index + 1)
      .some((entry) => entry.kind === 'apply_started');

    // Schema 2 shipped with a POST-swap receipt. Its `rolled_back` row proves the
    // old implementation had already completed the physical rollback, so it can
    // never be replayed as the write-ahead commit introduced below. A current
    // binary here is a later repair/reapply; preserve it. An otherwise unknown
    // generation still needs a supported apply witness before this older journal
    // can get out of its way.
    if (journal.schema === 2) {
      if (recovery.disk === 'unknown' && !followedByApply) {
        return {
          action: 'refused',
          releaseIdentity: journal.release_identity,
          reason: 'the legacy rollback receipt completed before this journal format, but the live binary is not a witnessed later install generation',
        };
      }
      try {
        dropManualRollbackJournal(deps.target);
      } catch (err) {
        return {
          action: 'refused',
          releaseIdentity: journal.release_identity,
          reason: `legacy rollback receipt exists but recovery cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      return recovery.disk === 'rolled-back'
        ? {
            action: 'completed',
            releaseIdentity: journal.release_identity,
            reason: 'the legacy rollback receipt and previous binary were already durable; cleaned the retained journal',
          }
        : {
            action: 'aborted',
            releaseIdentity: journal.release_identity,
            reason: 'the legacy rollback had already completed before a later install generation; preserved it and cleaned the old journal',
          };
    }

    // A schema-3 `rolled_back` is a write-ahead COMMIT unless its phase already
    // proves the pair moved. A supported later apply necessarily leaves
    // `apply_started` after it in this append-only ledger; in that case the old
    // rollback completed and this boot must preserve the later generation, not
    // execute the old commit again. `pair-rolled-back` is the equivalent disk
    // witness for a journal whose cleanup alone was interrupted.
    const pairWasRecorded = journal.schema === 3 && journal.phase === 'pair-rolled-back';
    if (followedByApply || (pairWasRecorded && recovery.disk !== 'rolled-back')) {
      try {
        dropManualRollbackJournal(deps.target);
      } catch (err) {
        return {
          action: 'refused',
          releaseIdentity: journal.release_identity,
          reason: `committed rollback was superseded but recovery cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      return {
        action: 'aborted',
        releaseIdentity: journal.release_identity,
        reason: 'the committed rollback was followed by a later install generation; preserved it and cleaned the old journal',
      };
    }

    if (recovery.disk === 'unknown') {
      return {
        action: 'refused',
        releaseIdentity: journal.release_identity,
        reason: 'the committed rollback names neither the live binary nor a supported later apply',
      };
    }

    if (recovery.disk === 'unchanged') {
      if (
        journal.schema === 3
        && journal.restored_snapshot
        && recovery.database !== 'rolled-back'
      ) {
        return {
          action: 'refused',
          releaseIdentity: journal.release_identity,
          reason: 'the rollback commit is durable but the database does not match its exact restored snapshot',
        };
      }
      if (deps.completeRollbackSwap === undefined) {
        return {
          action: 'refused',
          releaseIdentity: journal.release_identity,
          reason: 'the rollback commit is durable but this launcher cannot finish its pending binary swap',
        };
      }
      const generationFailure = validateManualRollbackPreviousGeneration(
        deps.target,
        journal,
      );
      if (generationFailure) {
        return {
          action: 'refused',
          releaseIdentity: journal.release_identity,
          reason: generationFailure,
        };
      }
      try {
        deps.completeRollbackSwap();
      } catch (err) {
        return {
          action: 'refused',
          releaseIdentity: journal.release_identity,
          reason: `the rollback commit is durable but its binary swap still failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      if (sha256File(deps.target.binaryPath) !== journal.previous_sha256) {
        return {
          action: 'refused',
          releaseIdentity: journal.release_identity,
          reason: 'the rollback swap returned without placing the committed previous binary generation live',
        };
      }
    }

    try {
      dropManualRollbackJournal(deps.target);
    } catch (err) {
      return {
        action: 'refused',
        releaseIdentity: journal.release_identity,
        reason: `terminal receipt exists but recovery cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return {
      action: 'completed',
      releaseIdentity: journal.release_identity,
      reason: recovery.disk === 'unchanged'
        ? 'finished the binary swap selected by the durable rollback commit'
        : 'the rollback terminal and previous binary were already durable; cleaned the retained journal',
    };
  }

  if (recovery.disk === 'unknown') {
    return {
      action: 'refused',
      releaseIdentity: journal.release_identity,
      reason: 'the live binary matches neither generation in the manual rollback journal',
    };
  }

  // A previous binary may not understand this journal at all. Its exact hash is
  // nevertheless a conclusive COMMIT witness because snapshot restoration is
  // ordered and made durable before the binary can move. Never rewrite an
  // unrecognized database in this direction: it may contain writes N-1 accepted
  // after the rollback and before this newer recovery code returned.
  if (recovery.disk === 'rolled-back') {
    try {
      appendTerminal(deps, journal, 'rolled_back');
    } catch (err) {
      return {
        action: 'refused',
        releaseIdentity: journal.release_identity,
        reason: `physical rollback completed but its terminal receipt could not be written: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    try {
      dropManualRollbackJournal(deps.target);
    } catch (err) {
      return {
        action: 'refused',
        releaseIdentity: journal.release_identity,
        reason: `terminal receipt is durable but recovery cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return {
      action: 'completed',
      releaseIdentity: journal.release_identity,
      reason: 'recorded the completed stopped-server rollback without changing its live database',
    };
  }

  // Schema 2 records no database hash or undo generation. Ordering can suggest
  // where a migrating rollback stopped, but cannot prove the bytes now at the
  // realm path (or repair them). Keep every unreceipted legacy migration closed
  // for explicit recovery rather than turn an inference into a database open.
  if (journal.schema === 2 && journal.restored_snapshot) {
    return {
      action: 'refused',
      releaseIdentity: journal.release_identity,
      reason: 'legacy rollback journal cannot prove whether its database snapshot was restored',
    };
  }

  if (journal.schema === 3) {
    const databaseFailure = databaseRecoveryForCurrentBinary(deps, journal, recovery.database);
    if (databaseFailure) {
      return {
        action: 'refused',
        releaseIdentity: journal.release_identity,
        reason: databaseFailure,
      };
    }
  }

  try {
    appendTerminal(deps, journal, 'operation_refused');
  } catch (err) {
    return {
      action: 'refused',
      releaseIdentity: journal.release_identity,
      reason: `physical recovery succeeded but its terminal receipt could not be written: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  try {
    dropManualRollbackJournal(deps.target);
  } catch (err) {
    return {
      action: 'refused',
      releaseIdentity: journal.release_identity,
      reason: `terminal receipt is durable but recovery cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return {
    action: 'aborted',
    releaseIdentity: journal.release_identity,
    reason: 'unwound the partial stopped-server rollback to the current database generation',
  };
};
