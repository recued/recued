import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  beginManualRollbackJournal,
  manualRollbackJournalTarget,
  sha256File,
} from '../manual-rollback-journal.js';
import { recoverManualRollbackBeforeOpen } from '../manual-rollback-recovery.js';
import { createUpdateLedger } from '../update-ledger.js';

const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'manual-rollback-recovery-'));
  const binaryPath = join(dir, 'recued');
  const previousPath = `${binaryPath}.old`;
  const dbPath = join(dir, 'realm.db');
  const snapshotPath = join(dir, 'snapshot.db');
  writeFileSync(binaryPath, 'current-binary');
  writeFileSync(previousPath, 'previous-binary');
  writeFileSync(dbPath, 'current-database');
  writeFileSync(snapshotPath, 'previous-database');
  const target = manualRollbackJournalTarget({
    dataDir: dir,
    dbPath,
    binaryPath,
    snapshotPath,
  });
  const ledger = createUpdateLedger(join(dir, 'updates.log'));
  let completedPairSwaps = 0;
  const begin = () => beginManualRollbackJournal(target, previousPath, {
    operationId: 'rollback-operation',
    releaseIdentity: 'stable:2.0.0',
    fromVersion: '2.0.0',
    toVersion: '1.0.0',
    channel: 'stable',
    migration: true,
    restoredSnapshot: true,
  });
  const recover = () => recoverManualRollbackBeforeOpen({
    target,
    ledger,
    now: () => 42,
    restoreDatabase: (source, destination) => copyFileSync(source, destination),
    completeRollbackSwap: () => {
      copyFileSync(previousPath, binaryPath);
      completedPairSwaps += 1;
    },
  });
  return {
    begin,
    binaryPath,
    dbPath,
    ledger,
    previousPath,
    recover,
    snapshotPath,
    target,
    completedPairSwaps: () => completedPairSwaps,
  };
};

describe('recoverManualRollbackBeforeOpen', () => {
  it('unwinds a crash after snapshot restore but before the binary swap', () => {
    const f = fixture();
    f.begin();
    copyFileSync(f.snapshotPath, f.dbPath);

    expect(f.recover()).toMatchObject({ action: 'aborted' });
    expect(readFileSync(f.dbPath, 'utf8')).toBe('current-database');
    expect(f.ledger.readAll()).toContainEqual(expect.objectContaining({
      id: 'rollback-operation',
      kind: 'operation_refused',
    }));
    expect(existsSync(f.target.journalPath)).toBe(false);
    expect(existsSync(f.target.undoPath)).toBe(false);
  });

  it('preserves writes accepted by an older binary that could not read the journal', () => {
    const f = fixture();
    f.begin();
    // N-1 has no reader for this newer journal. It boots after the pair swap and
    // accepts a write before the newer generation is installed again.
    copyFileSync(f.previousPath, f.binaryPath);
    writeFileSync(f.dbPath, 'post-rollback-write');

    expect(f.recover()).toMatchObject({ action: 'completed' });
    expect(readFileSync(f.dbPath, 'utf8')).toBe('post-rollback-write');
    expect(f.completedPairSwaps()).toBe(0);
    expect(f.ledger.readAll()).toContainEqual(expect.objectContaining({
      id: 'rollback-operation',
      kind: 'rolled_back',
    }));
  });

  it('finishes a write-ahead-committed pair swap before opening the database', () => {
    const f = fixture();
    f.begin();
    copyFileSync(f.snapshotPath, f.dbPath);
    f.ledger.append({
      id: 'rollback-operation',
      kind: 'rolled_back',
      at: 1,
      from_version: '2.0.0',
      to_version: '1.0.0',
      channel: 'stable',
      trigger: 'manual',
      release_identity: 'stable:2.0.0',
      migration: true,
    });

    expect(f.recover()).toMatchObject({ action: 'completed' });
    expect(f.completedPairSwaps()).toBe(1);
    expect(readFileSync(f.binaryPath, 'utf8')).toBe('previous-binary');
    expect(readFileSync(f.dbPath, 'utf8')).toBe('previous-database');
    expect(existsSync(f.target.journalPath)).toBe(false);
  });

  it('refuses before mutation when the committed previous binary changed', () => {
    const f = fixture();
    f.begin();
    copyFileSync(f.snapshotPath, f.dbPath);
    f.ledger.append({
      id: 'rollback-operation',
      kind: 'rolled_back',
      at: 1,
      from_version: '2.0.0',
      to_version: '1.0.0',
      channel: 'stable',
      trigger: 'manual',
      release_identity: 'stable:2.0.0',
      migration: true,
    });
    writeFileSync(f.previousPath, 'tampered-previous-binary');

    expect(f.recover()).toMatchObject({
      action: 'refused',
      reason: expect.stringMatching(/rollback candidate.*generation witness/),
    });
    expect(f.completedPairSwaps(), 'validation must precede the destructive callback').toBe(0);
    expect(readFileSync(f.binaryPath, 'utf8')).toBe('current-binary');
    expect(existsSync(f.target.journalPath)).toBe(true);
  });

  it('binds the previous addon and the witnessed absence of its optional signature', () => {
    const f = fixture();
    const previousAddon = join(dirname(f.binaryPath), 'lib', 'better_sqlite3.node.old');
    const previousAddonSignature = `${previousAddon}.minisig`;
    mkdirSync(dirname(previousAddon), { recursive: true });
    writeFileSync(previousAddon, 'previous-addon');
    const target = manualRollbackJournalTarget({
      dataDir: dirname(f.binaryPath),
      dbPath: f.dbPath,
      binaryPath: f.binaryPath,
      snapshotPath: f.snapshotPath,
      previousBinaryPath: f.previousPath,
      previousGenerationPaths: [f.previousPath, previousAddon, previousAddonSignature],
    });
    beginManualRollbackJournal(target, f.previousPath, {
      operationId: 'addon-rollback',
      releaseIdentity: 'stable:2.0.0',
      fromVersion: '2.0.0',
      toVersion: '1.0.0',
      channel: 'stable',
      migration: false,
      restoredSnapshot: false,
    });
    f.ledger.append({
      id: 'addon-rollback',
      kind: 'rolled_back',
      at: 1,
      from_version: '2.0.0',
      to_version: '1.0.0',
      channel: 'stable',
      trigger: 'manual',
      release_identity: 'stable:2.0.0',
      migration: false,
    });
    writeFileSync(previousAddonSignature, 'unexpected-signature');
    let swaps = 0;

    expect(recoverManualRollbackBeforeOpen({
      target,
      ledger: f.ledger,
      restoreDatabase: (source, destination) => copyFileSync(source, destination),
      completeRollbackSwap: () => { swaps += 1; },
    })).toMatchObject({ action: 'refused' });
    expect(swaps).toBe(0);
    expect(readFileSync(f.binaryPath, 'utf8')).toBe('current-binary');
  });

  it('never restores the undo over unknown bytes when the current binary returns', () => {
    const f = fixture();
    f.begin();
    copyFileSync(f.snapshotPath, f.dbPath);
    writeFileSync(f.dbPath, 'post-rollback-write');

    expect(f.recover()).toMatchObject({
      action: 'refused',
      reason: expect.stringMatching(/possible post-rollback writes/),
    });
    expect(readFileSync(f.dbPath, 'utf8')).toBe('post-rollback-write');
    expect(f.completedPairSwaps()).toBe(0);
    expect(existsSync(f.target.journalPath)).toBe(true);
  });

  it('refuses an ambiguous database even after the write-ahead rollback commit', () => {
    const f = fixture();
    f.begin();
    copyFileSync(f.snapshotPath, f.dbPath);
    f.ledger.append({
      id: 'rollback-operation',
      kind: 'rolled_back',
      at: 1,
      from_version: '2.0.0',
      to_version: '1.0.0',
      channel: 'stable',
      trigger: 'manual',
      release_identity: 'stable:2.0.0',
      migration: true,
    });
    writeFileSync(f.dbPath, 'writes-after-an-unwitnessed-return');

    expect(f.recover()).toMatchObject({
      action: 'refused',
      reason: expect.stringMatching(/does not match its exact restored snapshot/),
    });
    expect(f.completedPairSwaps()).toBe(0);
    expect(readFileSync(f.dbPath, 'utf8')).toBe('writes-after-an-unwitnessed-return');
    expect(existsSync(f.target.journalPath)).toBe(true);
  });

  it('cleans a committed journal without touching a supported later apply', () => {
    const f = fixture();
    f.begin();
    copyFileSync(f.snapshotPath, f.dbPath);
    f.ledger.append({
      id: 'rollback-operation',
      kind: 'rolled_back',
      at: 1,
      from_version: '2.0.0',
      to_version: '1.0.0',
      channel: 'stable',
      trigger: 'manual',
      release_identity: 'stable:2.0.0',
      migration: true,
    });
    f.ledger.append({
      id: 'later-apply',
      kind: 'apply_started',
      at: 2,
      from_version: '1.0.0',
      to_version: '3.0.0',
      channel: 'stable',
      trigger: 'manual',
      release_identity: 'stable:3.0.0',
    });
    writeFileSync(f.binaryPath, 'later-binary');
    writeFileSync(f.dbPath, 'later-database-write');

    expect(f.recover()).toMatchObject({ action: 'aborted' });
    expect(f.completedPairSwaps()).toBe(0);
    expect(readFileSync(f.binaryPath, 'utf8')).toBe('later-binary');
    expect(readFileSync(f.dbPath, 'utf8')).toBe('later-database-write');
    expect(existsSync(f.target.journalPath)).toBe(false);
  });

  it('refuses and retains the journal when the required undo is no longer authentic', () => {
    const f = fixture();
    f.begin();
    copyFileSync(f.snapshotPath, f.dbPath);
    writeFileSync(f.target.undoPath, 'tampered-undo');

    expect(f.recover()).toMatchObject({
      action: 'refused',
      reason: expect.stringMatching(/missing or no longer matches/),
    });
    expect(readFileSync(f.dbPath, 'utf8')).toBe('previous-database');
    expect(f.ledger.readAll()).toHaveLength(0);
    expect(existsSync(f.target.journalPath)).toBe(true);
  });

  it('never replays a legacy post-swap receipt over a later repaired generation', () => {
    const f = fixture();
    writeFileSync(f.target.journalPath, `${JSON.stringify({
      schema: 2,
      realm_id: f.target.realmId,
      operation_id: 'legacy-rollback',
      release_identity: 'stable:2.0.0',
      from_version: '2.0.0',
      to_version: '1.0.0',
      channel: 'stable',
      migration: true,
      restored_snapshot: true,
      previous_sha256: sha256File(f.previousPath),
      current_sha256: sha256File(f.binaryPath),
    })}\n`);
    f.ledger.append({
      id: 'legacy-rollback',
      kind: 'rolled_back',
      at: 1,
      from_version: '2.0.0',
      to_version: '1.0.0',
      channel: 'stable',
      trigger: 'manual',
      release_identity: 'stable:2.0.0',
      migration: true,
    });
    writeFileSync(f.dbPath, 'writes-after-the-legacy-rollback');

    expect(f.recover()).toMatchObject({ action: 'aborted' });
    expect(f.completedPairSwaps()).toBe(0);
    expect(readFileSync(f.binaryPath, 'utf8')).toBe('current-binary');
    expect(readFileSync(f.dbPath, 'utf8')).toBe('writes-after-the-legacy-rollback');
    expect(existsSync(f.target.journalPath)).toBe(false);
  });

  it('refuses an ambiguous legacy migrating journal before opening SQLite', () => {
    const f = fixture();
    writeFileSync(f.target.journalPath, `${JSON.stringify({
      schema: 2,
      realm_id: f.target.realmId,
      operation_id: 'legacy-rollback',
      release_identity: 'stable:2.0.0',
      from_version: '2.0.0',
      to_version: '1.0.0',
      channel: 'stable',
      migration: true,
      restored_snapshot: true,
      previous_sha256: sha256File(f.previousPath),
      current_sha256: sha256File(f.binaryPath),
    })}\n`);

    expect(f.recover()).toMatchObject({
      action: 'refused',
      reason: expect.stringMatching(/cannot prove whether/),
    });
    expect(existsSync(f.target.journalPath)).toBe(true);
  });
});
