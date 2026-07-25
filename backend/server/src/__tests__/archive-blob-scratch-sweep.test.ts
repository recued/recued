import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import {
  exportBlobScratchPath,
  restoreBlobScratchPath,
  sweepBlobScratch,
} from '../archive/archive-scratch.js';

const dirs: string[] = [];

const newDataDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'archive-scratch-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  while (dirs.length) {
    rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

const HASH = 'a'.repeat(64);

describe('archive blob scratch sweep', () => {
  it('reclaims the scratch files export and restore leave behind', () => {
    const dir = newDataDir();
    const exported = exportBlobScratchPath(dir, HASH);
    const restored = restoreBlobScratchPath(dir);
    writeFileSync(exported, 'plaintext blob');
    writeFileSync(restored, 'plaintext blob');

    expect(sweepBlobScratch(dir)).toBe(2);
    expect(existsSync(exported)).toBe(false);
    expect(existsSync(restored)).toBe(false);
  });

  // The whole point of building both names in the sweep's own module: a writer
  // that drifted from the pattern would strand plaintext the sweep walks past.
  it('matches the names the path builders actually produce', () => {
    const dir = newDataDir();
    for (const path of [
      exportBlobScratchPath(dir, HASH),
      exportBlobScratchPath(dir, 'b'.repeat(64)),
      restoreBlobScratchPath(dir),
      restoreBlobScratchPath(dir),
    ]) {
      writeFileSync(path, 'plaintext blob');
    }

    expect(sweepBlobScratch(dir)).toBe(4);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('leaves every other file in the data dir alone', () => {
    const dir = newDataDir();
    const keep = [
      'recued.db',
      'recued.db-wal',
      'recued.db.server-vault-bundle.json',
      'recued.db.staging-0123456789abcdef',
      'recued-server.lock',
      'config.toml',
      // An export's own temps: the archive is encrypted and the `VACUUM INTO`
      // copy keeps the source cipher, so neither is ours to reap.
      'recued-2024-01-01.recued.archive.partial',
      'recued-2024-01-01.recued.archive.db.tmp',
      // The CAS publish temp — swept inside the shard dirs by `sweepOrphans`,
      // and a prefix away from ours either way.
      '.tmp-abcdef0123456789',
    ];
    for (const name of keep) writeFileSync(join(dir, name), 'keep me');
    const scratch = exportBlobScratchPath(dir, HASH);
    writeFileSync(scratch, 'plaintext blob');

    expect(sweepBlobScratch(dir)).toBe(1);
    expect(readdirSync(dir).sort()).toEqual([...keep].sort());
    expect(existsSync(scratch)).toBe(false);
  });

  it('reports nothing swept for a data dir that is not there', () => {
    const dir = newDataDir();
    expect(sweepBlobScratch(join(dir, 'absent'))).toBe(0);
  });

  it('gives each scratch file a fresh name so concurrent blobs cannot collide', () => {
    const dir = newDataDir();
    const names = [
      basename(exportBlobScratchPath(dir, HASH)),
      basename(exportBlobScratchPath(dir, HASH)),
      basename(restoreBlobScratchPath(dir)),
      basename(restoreBlobScratchPath(dir)),
    ];
    expect(new Set(names).size).toBe(names.length);
  });
});
