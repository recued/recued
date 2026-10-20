/** On macOS no recursive watch is ever opened on the server's own thread:
 *  closing one there can stop the server for seconds (see `fs-watch-host.test.ts`).
 *  On Linux and Windows a close does not block, and the watches stay in the
 *  server (`watchesInOwnProcess`).
 *
 *  `fs.watch` throws in this file's module graph. The watch process loads `fs`
 *  for itself, in its own process, so on macOS the capability check and the
 *  folder watcher still attach — through that process, which is the point. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    watch: () => { throw new Error('a recursive watch was opened on the server thread'); },
  };
});

const { defaultProbeWatchFactory, probeFsCaps } = await import('../collections/file/adapters/fs/probe.js');
const { createFsWatcher, defaultWatchFactory } = await import('../collections/file/fs-adapter.js');

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const folder = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'watch-off-thread-'));
  dirs.push(dir);
  return dir;
};

it.runIf(process.platform === 'darwin')('the capability check and the folder watcher watch only through the watch process', async () => {
  const dir = folder();
  expect((await probeFsCaps({ path: dir })).watch).toBe('realtime');
  const watcher = createFsWatcher({ root: dir, ignore: [], settleMs: -1, onEvent: () => {} });
  await watcher.start();
  await watcher.stop();
  // A congested FSEvents can make even attaching slow; the server never waits on it.
}, 120_000);

it('watches go to the watch process on macOS, and stay on the server thread on Linux and Windows', () => {
  const dir = folder();
  for (const platform of ['linux', 'win32'] as const) {
    expect(() => defaultWatchFactory(platform)(dir, () => {})).toThrow('opened on the server thread');
    expect(() => defaultProbeWatchFactory(platform)(dir, { recursive: true })).toThrow('opened on the server thread');
  }
  const folderWatch = defaultWatchFactory('darwin')(dir, () => {});
  const check = defaultProbeWatchFactory('darwin')(dir, { recursive: true });
  expect(folderWatch.ready).toBeInstanceOf(Promise);
  expect(check.ready).toBeInstanceOf(Promise);
  folderWatch.close();
  check.close();
});
