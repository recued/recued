/** The schema comparison an updating server makes before a `migration: false`
 *  (update/schema-compat.ts), with stand-in binaries. The rules themselves are pinned by
 *  release/lib/schema-fingerprint.test.mjs, which runs the same copy; what is pinned here
 *  is the server's side: where the binaries run, what they leave behind, and the port
 *  `release-config.ts` composes for the orchestrator. */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import Database from 'better-sqlite3';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  compareReleaseSchemas, placeFile, SCHEMA_BOOT_MIN_DISK_BYTES, SCHEMA_BOOT_MIN_FREE_BYTES, sweepStaleSchemaWork,
} from '../update/schema-compat.js';
import { buildApplyOrchestratorDeps } from '../update/release-config.js';
import type { ReleaseCheckDeps } from '../update/release-check.js';

const dirs: string[] = [];
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'recued-schema-compare-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const SQLITE = createRequire(import.meta.url).resolve('better-sqlite3');
const open = (path: string) => new Database(path, { fileMustExist: true });
/** The stand-in binaries are shell scripts. */
const withStandIns = describe.skipIf(process.platform === 'win32');

/** What a stand-in saw of itself when it ran. */
interface Ran { self: string; ino: number; addon: string | null; home: string }

/** A stand-in for a release binary: it writes where it ran to `record`, creates `sql` in
 *  its `--db`, prints the boot banner's status line and waits to be stopped. */
const fakeBinary = (path: string, sql: string, record: string): string => {
  writeFileSync(path, [
    '#!/usr/bin/env node',
    "const fs = require('fs'); const path = require('path');",
    'const self = process.argv[1];',
    "const addon = path.join(path.dirname(self), 'lib', 'better_sqlite3.node');",
    `fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ self, ino: fs.statSync(self).ino,`
      + " addon: fs.existsSync(addon) ? fs.readFileSync(addon, 'utf8') : null, home: process.env.HOME }));",
    `const Database = require(${JSON.stringify(SQLITE)});`,
    "const db = new Database(process.argv[process.argv.indexOf('--db') + 1]);",
    `db.exec(${JSON.stringify(sql)});`,
    'db.close();',
    "console.log('Status: Running');",
    "process.on('SIGTERM', () => process.exit(0));",
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  chmodSync(path, 0o755);
  return path;
};

const ran = (record: string): Ran => JSON.parse(readFileSync(record, 'utf8')) as Ran;
const work = (dir: string): string[] => readdirSync(dir).filter((name) => name.startsWith('.recued-schema-'));
const MiB = 1024 * 1024;
/** The machine's real free memory and disk would make these depend on its state. */
const plenty = (): number => 8 * 1024 * MiB;
const roomy = (): number => 100 * 1024 * MiB;
const BEFORE = 'CREATE TABLE notes (id TEXT)';
const AFTER = 'CREATE TABLE notes (id TEXT, pinned INTEGER NOT NULL DEFAULT 0)';

withStandIns('compareReleaseSchemas', () => {
  it('⛔ boots each binary from a folder of its own beside them, by hard link, and sorts the change', async () => {
    const bin = tmp();
    const records = tmp();
    mkdirSync(join(bin, 'lib'));
    writeFileSync(join(bin, 'lib', 'better_sqlite3.node'), 'live addon');
    const previous = fakeBinary(join(bin, 'recued'), BEFORE, join(records, 'previous.json'));
    const next = fakeBinary(join(bin, 'recued.staged'), AFTER, join(records, 'next.json'));
    const result = await compareReleaseSchemas({
      previous: { binary: previous, sidecar: join(bin, 'lib', 'better_sqlite3.node') },
      next: { binary: next, sidecar: join(bin, 'lib', 'better_sqlite3.node') },
      open,
      workRoot: bin,
      availableMemory: plenty,
      freeDiskBytes: roomy,
    });
    expect(result.breaking).toEqual(['table notes changed (adds column pinned)']);
    for (const [binary, record] of [[previous, 'previous.json'], [next, 'next.json']] as const) {
      const run = ran(join(records, record));
      // ⛔ Never where it lives: a binary keys its lease, boot counter and swap files on
      // its own path, so one booted beside an install would act on that install.
      const folder = dirname(dirname(run.self));
      expect(dirname(folder)).toBe(bin);
      expect(folder.slice(bin.length + 1)).toMatch(/^\.recued-schema-/);
      expect(run.ino, 'a hard link, not a 150 MB copy').toBe(statSync(binary).ino);
      expect(run.addon, 'its sidecar where a release binary looks for it').toBe('live addon');
      expect(run.home).toBe(folder);
    }
    expect(work(bin)).toEqual([]);
    expect(statSync(previous).nlink, 'the links went with the folder').toBe(1);
  });

  it('a staged binary that cannot boot an empty realm is reported, naming it, and leaves nothing', async () => {
    const bin = tmp();
    writeFileSync(join(bin, 'addon.node'), 'addon');
    const previous = fakeBinary(join(bin, 'recued'), BEFORE, join(tmp(), 'previous.json'));
    const next = join(bin, 'recued.staged');
    writeFileSync(next, "#!/usr/bin/env node\nconsole.error('boom'); process.exit(3);\n");
    chmodSync(next, 0o755);
    await expect(compareReleaseSchemas({
      previous: { binary: previous, sidecar: join(bin, 'addon.node') },
      next: { binary: next, sidecar: join(bin, 'addon.node') },
      open,
      workRoot: bin,
      availableMemory: plenty,
      freeDiskBytes: roomy,
    })).rejects.toThrow(/recued\.staged did not finish booting a fresh realm \(exit 3\):\nboom/);
    expect(work(bin)).toEqual([]);
  });
});

withStandIns('compareReleaseSchemas where memory is short', () => {
  const staged = () => {
    const bin = tmp();
    const records = tmp();
    writeFileSync(join(bin, 'addon.node'), 'addon');
    return {
      bin,
      records,
      previous: { binary: fakeBinary(join(bin, 'recued'), BEFORE, join(records, 'previous.json')), sidecar: join(bin, 'addon.node') },
      next: { binary: fakeBinary(join(bin, 'recued.staged'), AFTER, join(records, 'next.json')), sidecar: join(bin, 'addon.node') },
    };
  };

  it(`⛔ with less than ${SCHEMA_BOOT_MIN_FREE_BYTES / MiB} MB free it starts no second server, and says why`, async () => {
    const { bin, records, previous, next } = staged();
    await expect(compareReleaseSchemas({ previous, next, open, workRoot: bin, availableMemory: () => 300 * MiB }))
      .rejects.toThrow('only 300 MB of memory is free, under the 512 MB a second server needs beside this one, so none was started');
    expect(readdirSync(records), 'nothing booted').toEqual([]);
    expect(work(bin)).toEqual([]);
  });

  it('asks again before the second boot', async () => {
    const { bin, records, previous, next } = staged();
    const answers = [plenty(), 300 * MiB];
    await expect(compareReleaseSchemas({
      previous, next, open, workRoot: bin, availableMemory: () => answers.shift()!, freeDiskBytes: roomy,
    }))
      .rejects.toThrow(/only 300 MB of memory is free/);
    expect(readdirSync(records)).toEqual(['previous.json']);
  });

  it("asks the process's own measure by default, which counts a container's limit", async () => {
    const { bin, records, previous, next } = staged();
    const measure = vi.spyOn(process, 'availableMemory').mockReturnValue(100 * MiB);
    try {
      await expect(compareReleaseSchemas({ previous, next, open, workRoot: bin })).rejects.toThrow(/only 100 MB of memory is free/);
      expect(measure).toHaveBeenCalled();
    } finally {
      measure.mockRestore();
    }
    expect(readdirSync(records)).toEqual([]);
  });
});

withStandIns('compareReleaseSchemas where the disk is short', () => {
  const staged = () => {
    const bin = tmp();
    const records = tmp();
    writeFileSync(join(bin, 'addon.node'), 'addon');
    return {
      bin,
      records,
      previous: { binary: fakeBinary(join(bin, 'recued'), BEFORE, join(records, 'previous.json')), sidecar: join(bin, 'addon.node') },
      next: { binary: fakeBinary(join(bin, 'recued.staged'), AFTER, join(records, 'next.json')), sidecar: join(bin, 'addon.node') },
    };
  };

  it(`⛔ with less than ${SCHEMA_BOOT_MIN_DISK_BYTES / MiB} MB free beside the binaries it starts nothing, and says why`, async () => {
    const { bin, records, previous, next } = staged();
    await expect(compareReleaseSchemas({
      previous, next, open, workRoot: bin, availableMemory: plenty, freeDiskBytes: () => 10 * MiB,
    })).rejects.toThrow(
      'only 10 MB is free on the disk the binaries are on, under the 64 MB a throwaway realm needs, so none was started',
    );
    expect(readdirSync(records), 'nothing booted').toEqual([]);
    expect(work(bin)).toEqual([]);
  });

  it('a disk that cannot say how full it is does not stop it, as it does not stop the update', async () => {
    const { bin, previous, next } = staged();
    const result = await compareReleaseSchemas({
      previous, next, open, workRoot: bin, availableMemory: plenty,
      freeDiskBytes: () => { throw new Error('statfs: not supported'); },
    });
    expect(result.breaking).toEqual(['table notes changed (adds column pinned)']);
  });
});

describe('placeFile', () => {
  const release = () => {
    const dir = tmp();
    writeFileSync(join(dir, 'recued'), 'a release binary');
    return { from: join(dir, 'recued'), to: join(dir, 'copy') };
  };
  const unlinkable = (): never => { throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' }); };

  it('links when it can, and a link needs no room', () => {
    const { from, to } = release();
    placeFile(from, to, { freeDiskBytes: () => 0 });
    expect(statSync(to).ino).toBe(statSync(from).ino);
  });

  it('⛔ where it cannot link, it copies only with room for the copy and a realm after it', () => {
    const { from, to } = release();
    const need = statSync(from).size + SCHEMA_BOOT_MIN_DISK_BYTES;
    expect(() => placeFile(from, to, { link: unlinkable, freeDiskBytes: () => need - MiB }))
      .toThrow(`${from} could not be linked, and a copy needs 64 MB where only 63 MB is free, so none was made`);
    expect(existsSync(to)).toBe(false);
    placeFile(from, to, { link: unlinkable, freeDiskBytes: () => need });
    expect(readFileSync(to, 'utf8')).toBe('a release binary');
    expect(statSync(to).ino).not.toBe(statSync(from).ino);
  });

  it('copies where the disk cannot say how full it is', () => {
    const { from, to } = release();
    placeFile(from, to, { link: unlinkable, freeDiskBytes: () => { throw new Error('statfs: not supported'); } });
    expect(readFileSync(to, 'utf8')).toBe('a release binary');
  });
});

describe('sweepStaleSchemaWork', () => {
  it('clears only its own folders, and only those a killed comparison left over an hour ago', () => {
    const bin = tmp();
    for (const name of ['.recued-schema-old', '.recued-schema-new', 'recued.old']) mkdirSync(join(bin, name));
    const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    utimesSync(join(bin, '.recued-schema-old'), twoHoursAgo, twoHoursAgo);
    utimesSync(join(bin, 'recued.old'), twoHoursAgo, twoHoursAgo);
    sweepStaleSchemaWork(bin);
    expect(readdirSync(bin).sort()).toEqual(['.recued-schema-new', 'recued.old']);
  });
});

withStandIns('the port release-config composes for the orchestrator', () => {
  // The port reads the real measure; these pin it, as the tests above pass theirs.
  let measure: MockInstance<() => number>;
  beforeEach(() => { measure = vi.spyOn(process, 'availableMemory').mockReturnValue(plenty()); });
  afterEach(() => { measure.mockRestore(); });

  const install = () => {
    const bin = tmp();
    mkdirSync(join(bin, 'lib'));
    writeFileSync(join(bin, 'lib', 'better_sqlite3.node'), 'live addon');
    writeFileSync(join(bin, 'lib', 'better_sqlite3.node.staged'), 'staged addon');
    const binaryPath = join(bin, 'recued');
    const deps = buildApplyOrchestratorDeps({
      db: new Database(':memory:'),
      releaseCheckDeps: { trustedPubkey: 'PUB' } as unknown as ReleaseCheckDeps,
      requestRestart: () => {},
      isQuiesced: () => true,
      env: { RECUED_DISTRIBUTION_CHANNEL: 'binary' },
      binaryPath,
      dataDir: tmp(),
    });
    if (!deps?.ports.compareSchemas) throw new Error('expected a compareSchemas port on the binary channel');
    return { compare: deps.ports.compareSchemas, bin, binaryPath, records: tmp() };
  };

  it('⛔ boots the installed binary against the staged one, the staged one with the addon this apply staged', async () => {
    const { compare, bin, binaryPath, records } = install();
    fakeBinary(binaryPath, BEFORE, join(records, 'live.json'));
    fakeBinary(`${binaryPath}.staged`, AFTER, join(records, 'staged.json'));

    expect((await compare({ stagedAddon: true }))?.breaking).toEqual(['table notes changed (adds column pinned)']);
    expect(ran(join(records, 'live.json')).addon).toBe('live addon');
    expect(ran(join(records, 'staged.json')).addon).toBe('staged addon');

    // A release that carries no addon runs on the one already installed.
    await compare({ stagedAddon: false });
    expect(ran(join(records, 'staged.json')).addon).toBe('live addon');

    expect(existsSync(join(bin, 'recued.staged')), 'the staged binary is still there to swap').toBe(true);
    expect(work(bin)).toEqual([]);
  });

  it('⛔ boots nothing on a host short of memory, and says why', async () => {
    const { compare, binaryPath, records } = install();
    fakeBinary(binaryPath, BEFORE, join(records, 'live.json'));
    fakeBinary(`${binaryPath}.staged`, AFTER, join(records, 'staged.json'));
    measure.mockReturnValue(200 * MiB);
    await expect(compare({ stagedAddon: false })).rejects.toThrow(/only 200 MB of memory is free/);
    expect(readdirSync(records)).toEqual([]);
  });

  it('answers null when there is no installed binary for a rollback to return to', async () => {
    const { compare, binaryPath, records } = install();
    fakeBinary(`${binaryPath}.staged`, AFTER, join(records, 'staged.json'));
    expect(await compare({ stagedAddon: false })).toBeNull();
    expect(existsSync(join(records, 'staged.json')), 'nothing was booted').toBe(false);
  });
});
