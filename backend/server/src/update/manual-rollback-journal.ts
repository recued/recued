/** Durable witness for an owner-initiated rollback between physical mutation
 * and its terminal ledger receipt. The current schema binds BOTH halves of a
 * migrating rollback: the install generation and the realm database generation. */
import { createHash, randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fsyncDir, fsyncFile, writeFileAtomicSync } from '../durable-fs.js';

export const MANUAL_ROLLBACK_JOURNAL_FILE = 'update-manual-rollback.json';
export const MANUAL_ROLLBACK_UNDO_SUFFIX = '.database-undo';

/** Standalone database opens do not know the update composition's dataDir. In
 * production that directory is the realm directory, so expose the exact path
 * the open chokepoint can guard before SQLite sees a half-restored database. */
export const manualRollbackJournalPathForDb = (dbPath: string): string =>
  join(dirname(resolve(dbPath)), MANUAL_ROLLBACK_JOURNAL_FILE);

/** The receipt belongs to the realm ledger that must consume it, even though the
 * binary whose mutation it witnesses is host-wide. Keeping the paths and realm
 * identity together makes it difficult for composition to bind only one half. */
export interface ManualRollbackJournalTarget {
  journalPath: string;
  realmId: string;
  binaryPath: string;
  /** The executable rollback candidate. Kept separate from the generation list
   * so pre-witness journals still have one unambiguous path to validate. */
  previousBinaryPath: string;
  /** Exact rollback inputs, including optional files whose absence is material. */
  previousGenerationPaths: readonly string[];
  dbPath: string;
  snapshotPath: string;
  undoPath: string;
}

export const manualRollbackJournalTarget = (input: {
  dataDir: string;
  dbPath: string;
  binaryPath: string;
  snapshotPath: string;
  previousBinaryPath?: string;
  previousGenerationPaths?: readonly string[];
}): ManualRollbackJournalTarget => {
  const journalPath = join(resolve(input.dataDir), MANUAL_ROLLBACK_JOURNAL_FILE);
  const binaryPath = resolve(input.binaryPath);
  const previousBinaryPath = resolve(input.previousBinaryPath ?? `${binaryPath}.old`);
  const previousGenerationPaths = (input.previousGenerationPaths ?? [previousBinaryPath])
    .map((path) => resolve(path));
  if (
    previousGenerationPaths.length === 0
    || previousGenerationPaths[0] !== previousBinaryPath
    || new Set(previousGenerationPaths).size !== previousGenerationPaths.length
  ) {
    throw new Error('manual rollback generation paths must start with the unique previous binary path');
  }
  return {
    journalPath,
    realmId: resolve(input.dbPath),
    binaryPath,
    previousBinaryPath,
    previousGenerationPaths,
    dbPath: resolve(input.dbPath),
    snapshotPath: resolve(input.snapshotPath),
    undoPath: `${journalPath}${MANUAL_ROLLBACK_UNDO_SUFFIX}`,
  };
};

/** Schema 2 shipped before the journal could identify the database generation.
 * It remains readable so an old crash is refused/reconciled deliberately rather
 * than being mistaken for no pending rollback. */
export interface LegacyManualRollbackJournal {
  schema: 2;
  realm_id: string;
  operation_id: string;
  release_identity: string;
  from_version: string;
  to_version: string;
  channel: 'stable' | 'edge';
  migration: boolean;
  restored_snapshot: boolean;
  previous_sha256: string;
  current_sha256: string;
}

export type ManualRollbackPhase = 'prepared' | 'snapshot-restored' | 'pair-rolled-back';

export interface CurrentManualRollbackJournal {
  schema: 3;
  realm_id: string;
  operation_id: string;
  release_identity: string;
  from_version: string;
  to_version: string;
  channel: 'stable' | 'edge';
  migration: boolean;
  restored_snapshot: boolean;
  phase: ManualRollbackPhase;
  previous_sha256: string;
  current_sha256: string;
  db_path: string;
  snapshot_path: string;
  undo_path: string;
  current_database_sha256?: string;
  snapshot_sha256?: string;
  /** Added compatibly within schema 3: deployed schema-3 readers ignore unknown
   * fields, while current recovery uses it to authenticate the whole rollback
   * candidate set. `null` durably witnesses that an optional file was absent. */
  previous_generation?: Array<{ path: string; sha256: string | null }>;
}

export type ManualRollbackJournal =
  | LegacyManualRollbackJournal
  | CurrentManualRollbackJournal;

export interface ManualRollbackJournalInput {
  operationId: string;
  releaseIdentity: string;
  fromVersion: string;
  toVersion: string;
  channel: 'stable' | 'edge';
  migration: boolean;
  restoredSnapshot: boolean;
}

export type ManualRollbackRecovery = {
  journal: ManualRollbackJournal;
  disk: 'rolled-back' | 'unchanged' | 'unknown';
  database: 'rolled-back' | 'unchanged' | 'unknown' | 'not-applicable' | 'unproven';
};

export const sha256File = (path: string): string | null => {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
};

/** Copy a CLOSED database to the rollback undo slot. A surviving non-empty WAL
 * disproves the closed-database premise, just as it does for update snapshots. */
const preserveCurrentDatabase = (target: ManualRollbackJournalTarget): string => {
  const wal = `${target.dbPath}-wal`;
  if (existsSync(wal) && statSync(wal).size > 0) {
    throw new Error(
      `${wal} survived database close; refusing to preserve an incomplete rollback undo`,
    );
  }
  const staging = `${target.undoPath}.tmp.${process.pid}.${randomBytes(8).toString('hex')}`;
  try {
    copyFileSync(target.dbPath, staging);
    fsyncFile(staging);
    rmSync(target.undoPath, { force: true });
    renameSync(staging, target.undoPath);
    fsyncDir(dirname(target.undoPath));
  } catch (err) {
    rmSync(staging, { force: true });
    throw err;
  }
  const hash = sha256File(target.undoPath);
  if (hash === null) throw new Error('could not hash the preserved database rollback undo');
  return hash;
};

export const beginManualRollbackJournal = (
  target: ManualRollbackJournalTarget,
  previousBinaryPath: string,
  input: ManualRollbackJournalInput,
): void => {
  if (existsSync(target.journalPath)) {
    throw new Error('a prior manual rollback journal still requires recovery');
  }
  const resolvedPreviousBinaryPath = resolve(previousBinaryPath);
  if (resolvedPreviousBinaryPath !== target.previousBinaryPath) {
    throw new Error('manual rollback previous binary path does not match its recovery target');
  }
  const previousGeneration = target.previousGenerationPaths.map((path) => ({
    path,
    sha256: sha256File(path),
  }));
  const unhashable = previousGeneration.find((witness) =>
    witness.sha256 === null && existsSync(witness.path));
  if (unhashable) {
    throw new Error(`could not hash rollback generation file ${unhashable.path} before mutation`);
  }
  const previous = previousGeneration[0]?.sha256 ?? null;
  const current = sha256File(target.binaryPath);
  if (previous === null || current === null) {
    throw new Error('could not hash both rollback generations before mutation');
  }

  let currentDatabase: string | undefined;
  let snapshot: string | undefined;
  if (input.restoredSnapshot) {
    snapshot = sha256File(target.snapshotPath) ?? undefined;
    if (snapshot === undefined) {
      throw new Error('could not hash the rollback database snapshot before mutation');
    }
    currentDatabase = preserveCurrentDatabase(target);
    if (sha256File(target.dbPath) !== currentDatabase) {
      rmSync(target.undoPath, { force: true });
      throw new Error('the live database changed while its rollback undo was prepared');
    }
  }

  const journal: CurrentManualRollbackJournal = {
    schema: 3,
    realm_id: target.realmId,
    operation_id: input.operationId,
    release_identity: input.releaseIdentity,
    from_version: input.fromVersion,
    to_version: input.toVersion,
    channel: input.channel,
    migration: input.migration,
    restored_snapshot: input.restoredSnapshot,
    phase: 'prepared',
    previous_sha256: previous,
    current_sha256: current,
    db_path: target.dbPath,
    snapshot_path: target.snapshotPath,
    undo_path: target.undoPath,
    ...(currentDatabase ? { current_database_sha256: currentDatabase } : {}),
    ...(snapshot ? { snapshot_sha256: snapshot } : {}),
    previous_generation: previousGeneration,
  };
  try {
    writeFileAtomicSync(target.journalPath, `${JSON.stringify(journal)}\n`);
    fsyncDir(dirname(target.journalPath));
  } catch (err) {
    rmSync(target.undoPath, { force: true });
    throw err;
  }
};

const commonFieldsValid = (
  value: Partial<ManualRollbackJournal>,
  target: ManualRollbackJournalTarget,
): boolean => value.realm_id === target.realmId
  && typeof value.operation_id === 'string'
  && value.operation_id.length > 0
  && typeof value.release_identity === 'string'
  && typeof value.from_version === 'string'
  && typeof value.to_version === 'string'
  && (value.channel === 'stable' || value.channel === 'edge')
  && typeof value.migration === 'boolean'
  && typeof value.restored_snapshot === 'boolean'
  && /^[0-9a-f]{64}$/.test(value.previous_sha256 ?? '')
  && /^[0-9a-f]{64}$/.test(value.current_sha256 ?? '');

export const readManualRollbackJournal = (
  target: ManualRollbackJournalTarget,
): ManualRollbackJournal | null => {
  try {
    const value = JSON.parse(readFileSync(target.journalPath, 'utf8')) as Partial<ManualRollbackJournal>;
    if (!commonFieldsValid(value, target)) return null;
    if (value.schema === 2) return value as LegacyManualRollbackJournal;
    if (value.schema !== 3) return null;
    const current = value as Partial<CurrentManualRollbackJournal>;
    if (
      (current.phase !== 'prepared'
        && current.phase !== 'snapshot-restored'
        && current.phase !== 'pair-rolled-back')
      || current.db_path !== target.dbPath
      || current.snapshot_path !== target.snapshotPath
      || current.undo_path !== target.undoPath
      || (current.restored_snapshot
        && (!/^[0-9a-f]{64}$/.test(current.current_database_sha256 ?? '')
          || !/^[0-9a-f]{64}$/.test(current.snapshot_sha256 ?? '')))
    ) return null;
    if (current.previous_generation !== undefined) {
      if (
        !Array.isArray(current.previous_generation)
        || current.previous_generation.length !== target.previousGenerationPaths.length
        || current.previous_generation.some((witness, index) =>
          witness === null
          || typeof witness !== 'object'
          || witness.path !== target.previousGenerationPaths[index]
          || (witness.sha256 !== null && !/^[0-9a-f]{64}$/.test(witness.sha256)))
      ) return null;
    }
    return current as CurrentManualRollbackJournal;
  } catch {
    return null;
  }
};

const PHASE_ORDER: Record<ManualRollbackPhase, number> = {
  prepared: 0,
  'snapshot-restored': 1,
  'pair-rolled-back': 2,
};

export const markManualRollbackPhase = (
  target: ManualRollbackJournalTarget,
  operationId: string,
  phase: Exclude<ManualRollbackPhase, 'prepared'>,
): void => {
  const journal = readManualRollbackJournal(target);
  if (!journal || journal.schema !== 3 || journal.operation_id !== operationId) {
    throw new Error('manual rollback journal identity changed before phase advance');
  }
  if (PHASE_ORDER[phase] < PHASE_ORDER[journal.phase]) return;
  if (phase === 'snapshot-restored' && !journal.restored_snapshot) {
    throw new Error('cannot mark a snapshot restore for a binary-only rollback');
  }
  writeFileAtomicSync(target.journalPath, `${JSON.stringify({ ...journal, phase })}\n`);
};

export const inspectManualRollbackJournal = (
  target: ManualRollbackJournalTarget,
): ManualRollbackRecovery | null => {
  const journal = readManualRollbackJournal(target);
  if (!journal) return null;
  const live = sha256File(target.binaryPath);
  const disk = live === journal.previous_sha256
    ? 'rolled-back'
    : live === journal.current_sha256
      ? 'unchanged'
      : 'unknown';
  if (journal.schema === 2) {
    return {
      journal,
      disk,
      database: journal.restored_snapshot ? 'unproven' : 'not-applicable',
    };
  }
  if (!journal.restored_snapshot) return { journal, disk, database: 'not-applicable' };
  const databaseHash = sha256File(target.dbPath);
  return {
    journal,
    disk,
    database: databaseHash === journal.snapshot_sha256
      ? 'rolled-back'
      : databaseHash === journal.current_database_sha256
        ? 'unchanged'
        : 'unknown',
  };
};

/** Validate every source a committed rollback is about to consume before the
 * first destructive rename. Journals written before the generation witness was
 * added still authenticate their executable through `previous_sha256`; they
 * cannot prove an addon and therefore retain their historical behavior. */
export const validateManualRollbackPreviousGeneration = (
  target: ManualRollbackJournalTarget,
  journal: CurrentManualRollbackJournal,
): string | null => {
  const witnesses = journal.previous_generation ?? [{
    path: target.previousBinaryPath,
    sha256: journal.previous_sha256,
  }];
  for (const witness of witnesses) {
    const mismatched = witness.sha256 === null
      ? existsSync(witness.path)
      : sha256File(witness.path) !== witness.sha256;
    if (mismatched) {
      return `rollback candidate ${witness.path} is missing, appeared unexpectedly, or no longer matches its durable generation witness`;
    }
  }
  return null;
};

export const dropManualRollbackJournal = (target: ManualRollbackJournalTarget): void => {
  // The receipt is already authoritative when this runs. Remove the journal
  // first so a failed undo cleanup cannot block the next database open.
  rmSync(target.journalPath, { force: true });
  try { fsyncDir(dirname(target.journalPath)); } catch { /* best-effort after unlink */ }
  rmSync(target.undoPath, { force: true });
  try { fsyncDir(dirname(target.undoPath)); } catch { /* best-effort after unlink */ }
};
