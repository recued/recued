/** Archive publication durability: a successful return means both the complete
 * encrypted bytes and their final directory entry crossed the best-effort fsync
 * boundary. The spies make removing either barrier observable; the real helpers
 * still run so this remains an end-to-end archive write/read test. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';

const durability = vi.hoisted(() => ({
  file: vi.fn<(path: string) => void>(),
  dir: vi.fn<(path: string) => void>(),
}));

vi.mock('../durable-fs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../durable-fs.js')>();
  return {
    ...actual,
    fsyncFile: (path: string): void => {
      durability.file(path);
      actual.fsyncFile(path);
    },
    fsyncDir: (path: string): void => {
      durability.dir(path);
      actual.fsyncDir(path);
    },
  };
});

import { exportArchive } from '../archive/archive-export.js';
import { importArchive } from '../archive/archive-import.js';
import { EXPORT_DB_SCRATCH_PREFIX } from '../archive/archive-scratch.js';

let dir: string | undefined;
let db: Database.Database | undefined;

afterEach(() => {
  try { db?.close(); } catch { /* already closed */ }
  db = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
  durability.file.mockClear();
  durability.dir.mockClear();
});

describe('archive export durable publication', () => {
  it('flushes the partial bytes before rename and the destination directory before success', async () => {
    dir = mkdtempSync(join(tmpdir(), 'archive-export-durable-'));
    const dbPath = join(dir, 'realm.db');
    const dest = join(dir, 'backup.recued.archive');
    const key = Buffer.alloc(32, 0x5a);
    db = new Database(dbPath);
    db.exec('CREATE TABLE example (value TEXT); INSERT INTO example VALUES (\'durable\')');

    const result = await exportArchive({
      destPath: dest,
      recoveryKey: key,
      db,
      producerVersion: '0.2.0',
    });

    expect(durability.file).toHaveBeenCalledWith(`${dest}.partial`);
    expect(durability.dir).toHaveBeenCalledWith(dirname(dest));
    expect(durability.file.mock.invocationCallOrder[0])
      .toBeLessThan(durability.dir.mock.invocationCallOrder.at(-1)!);
    expect(statSync(dest).mode & 0o077).toBe(0);
    expect(readdirSync(dir).some((name) => name.startsWith(EXPORT_DB_SCRATCH_PREFIX)))
      .toBe(false);
    expect((await importArchive({
      archivePath: result.path,
      recoveryKey: key,
      consumerVersion: '0.2.0',
    })).db.length)
      .toBeGreaterThan(0);
  });
});
