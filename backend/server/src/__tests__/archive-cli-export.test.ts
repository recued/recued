/** M3 verification — `archive export` CLI command.
 *
 *  The archive CLI (`cmdArchive` → `cmdExport`) had NO tests; the archive
 *  suites exercise `exportArchive` directly. These prove the operator-facing
 *  command end-to-end, in particular that the positional dest path already
 *  writes to an ARBITRARY location (a different directory / mount than the
 *  data volume) — the stated M3 goal — and round-trips through import.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { cmdArchive, type ArchiveCommandDeps } from '../commands/archive.js';
import { importArchive } from '../archive/archive-import.js';

const HEX_KEY = Buffer.alloc(32, 1).toString('hex'); // 64-char hex → 32 bytes

interface Harness {
  dataDir: string;
  outDir: string;
  deps: ArchiveCommandDeps;
  close(): void;
}

const newHarness = (): Harness => {
  const dataDir = mkdtempSync(join(tmpdir(), 'cli-export-data-'));
  // A SEPARATE directory standing in for "another mount" — the dest path
  // here lives nowhere under dataDir.
  const outDir = mkdtempSync(join(tmpdir(), 'cli-export-out-'));
  const dbPath = join(dataDir, 'recued-server.db');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE example (k TEXT PRIMARY KEY, v TEXT)');
  db.prepare('INSERT INTO example VALUES (?, ?)').run('hello', 'world');
  db.close(); // cmdExport opens its own handle from dbPath
  return {
    dataDir, outDir,
    deps: { dbPath, configPath: null, dataPath: dataDir, serverVersion: '0.2.0' },
    close() {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    },
  };
};

let h: Harness;
afterEach(() => { h?.close(); vi.restoreAllMocks(); });

describe('archive export CLI', () => {
  it('writes to an arbitrary out path (another mount) and round-trips', async () => {
    h = newHarness();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    // Dest is outside the data volume entirely — the M3 "write to another
    // mount" case, served by the existing positional path argument.
    const dest = join(h.outDir, 'backup.recued.archive');
    await cmdArchive(h.deps, ['export', dest, `--key=${HEX_KEY}`]);

    expect(existsSync(dest)).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining(dest));

    const imported = await importArchive({
      archivePath: dest,
      recoveryKey: Buffer.from(HEX_KEY, 'hex'),
      consumerVersion: '0.2.0',
    });
    expect(imported.db.length).toBeGreaterThan(0);
    expect(imported.manifest.producer_version).toBe('0.2.0');
  });

  it('creates missing parent directories of the out path', async () => {
    h = newHarness();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const dest = join(h.outDir, 'nested', 'deeper', 'backup.recued.archive');
    await cmdArchive(h.deps, ['export', dest, `--key=${HEX_KEY}`]);
    expect(existsSync(dest)).toBe(true);
  });

  it('refuses a missing recovery key', async () => {
    h = newHarness();
    const dest = join(h.outDir, 'backup.recued.archive');
    await expect(cmdArchive(h.deps, ['export', dest])).rejects.toThrow(/recovery key missing/);
  });

  it('refuses an existing dest without --force, overwrites with it', async () => {
    h = newHarness();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const dest = join(h.outDir, 'backup.recued.archive');
    await cmdArchive(h.deps, ['export', dest, `--key=${HEX_KEY}`]);
    await expect(cmdArchive(h.deps, ['export', dest, `--key=${HEX_KEY}`]))
      .rejects.toThrow(/ARCHIVE_TARGET_UNWRITABLE/);
    await cmdArchive(h.deps, ['export', dest, `--key=${HEX_KEY}`, '--force']);
    expect(existsSync(dest)).toBe(true);
  });
});
