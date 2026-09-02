import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  beginManualRollbackJournal,
  dropManualRollbackJournal,
  inspectManualRollbackJournal,
  manualRollbackJournalTarget,
  markManualRollbackPhase,
} from '../manual-rollback-journal.js';

const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'manual-rollback-journal-'));
  const binary = join(dir, 'recued');
  const previous = `${binary}.old`;
  const dbPath = join(dir, 'realm.db');
  const snapshotPath = join(dir, 'snapshot.db');
  writeFileSync(binary, 'current-generation');
  writeFileSync(previous, 'previous-generation');
  writeFileSync(dbPath, 'current-database');
  writeFileSync(snapshotPath, 'previous-database');
  const target = manualRollbackJournalTarget({
    dataDir: dir,
    dbPath,
    binaryPath: binary,
    snapshotPath,
  });
  return { binary, dbPath, previous, snapshotPath, target };
};

describe('manual rollback journal', () => {
  it('classifies the exact old generation after a swap', () => {
    const { binary, previous, target } = fixture();
    beginManualRollbackJournal(target, previous, {
      operationId: 'receipt',
      releaseIdentity: 'stable:2.0.0',
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
      channel: 'stable',
      migration: false,
      restoredSnapshot: false,
    });
    const oldBytes = readFileSync(previous);
    writeFileSync(binary, oldBytes);
    expect(inspectManualRollbackJournal(target)).toMatchObject({
      disk: 'rolled-back',
      journal: { operation_id: 'receipt', realm_id: target.realmId },
    });
    dropManualRollbackJournal(target);
    expect(inspectManualRollbackJournal(target)).toBeNull();
  });

  it('distinguishes unchanged from an unrecognized third generation', () => {
    const { binary, previous, target } = fixture();
    beginManualRollbackJournal(target, previous, {
      operationId: 'receipt',
      releaseIdentity: 'stable:2.0.0',
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
      channel: 'stable',
      migration: false,
      restoredSnapshot: false,
    });
    expect(inspectManualRollbackJournal(target)?.disk).toBe('unchanged');
    writeFileSync(binary, 'third-generation');
    expect(inspectManualRollbackJournal(target)?.disk).toBe('unknown');
    expect(readFileSync(target.journalPath, 'utf8')).toContain('receipt');
  });

  it('cannot be consumed by a different realm sharing the host binary', () => {
    const { binary, previous, target } = fixture();
    beginManualRollbackJournal(target, previous, {
      operationId: 'realm-a-receipt',
      releaseIdentity: 'stable:2.0.0',
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
      channel: 'stable',
      migration: false,
      restoredSnapshot: false,
    });
    const otherDir = mkdtempSync(join(tmpdir(), 'manual-rollback-journal-realm-b-'));
    const other = manualRollbackJournalTarget({
      dataDir: otherDir,
      dbPath: join(otherDir, 'realm-b.db'),
      binaryPath: binary,
      snapshotPath: join(otherDir, 'snapshot.db'),
    });
    expect(inspectManualRollbackJournal(other)).toBeNull();
    expect(inspectManualRollbackJournal(target)?.journal.operation_id).toBe('realm-a-receipt');
  });

  it('binds both database generations and preserves an undo before mutation', () => {
    const { dbPath, previous, snapshotPath, target } = fixture();
    beginManualRollbackJournal(target, previous, {
      operationId: 'migrating-receipt',
      releaseIdentity: 'stable:2.0.0',
      fromVersion: '1.0.0',
      toVersion: '2.0.0',
      channel: 'stable',
      migration: true,
      restoredSnapshot: true,
    });

    expect(inspectManualRollbackJournal(target)).toMatchObject({
      disk: 'unchanged',
      database: 'unchanged',
      journal: {
        schema: 3,
        phase: 'prepared',
        db_path: dbPath,
        snapshot_path: snapshotPath,
        undo_path: target.undoPath,
        previous_generation: [{
          path: previous,
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        }],
      },
    });
    expect(readFileSync(target.undoPath, 'utf8')).toBe('current-database');

    writeFileSync(dbPath, readFileSync(snapshotPath));
    markManualRollbackPhase(target, 'migrating-receipt', 'snapshot-restored');
    expect(inspectManualRollbackJournal(target)).toMatchObject({
      database: 'rolled-back',
      journal: { phase: 'snapshot-restored' },
    });

    dropManualRollbackJournal(target);
    expect(existsSync(target.journalPath)).toBe(false);
    expect(existsSync(target.undoPath)).toBe(false);
  });
});
