/** The fs adapter's watcher (`fs-adapter.ts`): its ignore globs, its honest
 *  watch mode, and the walk that settles it after attaching. The production
 *  `fs` adapter (`adapters/fs/index.ts`) runs one per enrolled folder.
 *
 *  Moved here 2026-10-10 from `file-collection.test.ts`, when the Phase D
 *  collection it tested was removed; what a watched folder records from these
 *  events is `watched-folders.test.ts`. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync, type FSWatcher } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import {
  createFsWatcher,
  globToRegExp,
  matchesAnyIgnore,
} from '../collections/file/fs-adapter.js';

interface Harness {
  root: string;
  close(): void;
}

const newHarness = (): Harness => {
  const base = mkdtempSync(join(tmpdir(), 'fs-watcher-'));
  const root = join(base, 'watched');
  mkdirSync(root, { recursive: true });
  return {
    root,
    close() {
      rmSync(base, { recursive: true, force: true });
    },
  };
};

// ────────────────────────────────────────────────────────────────
// Glob matcher unit tests
// ────────────────────────────────────────────────────────────────

describe('globToRegExp + matchesAnyIgnore', () => {
  it('matches a literal filename anywhere in the tree', () => {
    const re = [globToRegExp('.DS_Store')];
    expect(matchesAnyIgnore(re, '.DS_Store')).toBe(true);
    expect(matchesAnyIgnore(re, 'sub/.DS_Store')).toBe(true);
    expect(matchesAnyIgnore(re, 'sub/other.txt')).toBe(false);
  });

  it('double-star matches nested segments', () => {
    const re = [globToRegExp('**/node_modules/**')];
    expect(matchesAnyIgnore(re, 'node_modules/a.js')).toBe(true);
    expect(matchesAnyIgnore(re, 'a/node_modules/b.js')).toBe(true);
    expect(matchesAnyIgnore(re, 'a/b/node_modules/c/d.js')).toBe(true);
    expect(matchesAnyIgnore(re, 'src/app.ts')).toBe(false);
  });

  it('single-star does not cross path separators', () => {
    const re = [globToRegExp('*.log')];
    expect(matchesAnyIgnore(re, 'a.log')).toBe(true);
    expect(matchesAnyIgnore(re, 'logs/a.log')).toBe(true);
    expect(matchesAnyIgnore(re, 'a.log/something')).toBe(false);
  });

  it('anchored pattern matches only from root', () => {
    const re = [globToRegExp('/top.txt')];
    expect(matchesAnyIgnore(re, 'top.txt')).toBe(true);
    expect(matchesAnyIgnore(re, 'sub/top.txt')).toBe(false);
  });
});

describe('createFsWatcher — honest watch mode', () => {
  let h: Harness;
  beforeEach(() => { h = newHarness(); });
  afterEach(() => { h.close(); });

  it('watch:none completes a one-shot scan without attaching a watcher', async () => {
    writeFileSync(join(h.root, 'seed.txt'), 'seed');
    const events: string[] = [];
    let attachCalls = 0;
    const watcher = createFsWatcher({
      root: h.root,
      ignore: [],
      watchMode: 'none',
      onEvent: (event) => { events.push(`${event.type}:${event.path}`); },
      watchFactory: () => {
        attachCalls++;
        throw new Error('must not attach');
      },
    });

    await watcher.start();
    expect(events).toEqual([`present:${join(h.root, 'seed.txt')}`]);
    expect(attachCalls).toBe(0);
    await watcher.stop();
  });

  it('rejects when realtime was promised but attachment fails', async () => {
    const watcher = createFsWatcher({
      root: h.root,
      ignore: [],
      watchMode: 'realtime',
      onEvent: () => {},
      watchFactory: () => { throw new Error('recursive watch unsupported'); },
    });

    await expect(watcher.start()).rejects.toMatchObject({
      name: 'FsWatchUnavailableError',
      code: 'FS_WATCH_UNAVAILABLE',
    });
    await watcher.stop();
  });

  it('reports an asynchronous watcher failure after a healthy start', async () => {
    const fakeWatcher = Object.assign(new EventEmitter(), { close: vi.fn() });
    const onUnavailable = vi.fn();
    const watcher = createFsWatcher({
      root: h.root,
      ignore: [],
      watchMode: 'realtime',
      onEvent: () => {},
      onUnavailable,
      watchFactory: () => fakeWatcher as unknown as FSWatcher,
    });

    await watcher.start();
    fakeWatcher.emit('error', new Error('watch handle lost'));

    await vi.waitFor(() => expect(onUnavailable).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'FS_WATCH_UNAVAILABLE' }),
    ));
    expect(fakeWatcher.close).toHaveBeenCalledOnce();
    await watcher.stop();
  });

  it('waits for a debounced event already inside onEvent before stopping', async () => {
    const fakeWatcher = Object.assign(new EventEmitter(), { close: vi.fn() });
    let watchListener: ((eventType: string, filename: string | null) => void) | undefined;
    let releaseEvent: () => void = () => {};
    let markEventStarted: () => void = () => {};
    const eventStarted = new Promise<void>((resolve) => { markEventStarted = resolve; });
    const watcher = createFsWatcher({
      root: h.root,
      ignore: [],
      debounceMs: 1,
      watchMode: 'realtime',
      onEvent: (event) => {
        if (event.type !== 'change') return;
        markEventStarted();
        return new Promise<void>((resolve) => { releaseEvent = resolve; });
      },
      watchFactory: (_root, listener) => {
        watchListener = listener;
        return fakeWatcher as unknown as FSWatcher;
      },
    });
    await watcher.start();
    writeFileSync(join(h.root, 'late.txt'), 'late');
    watchListener?.('change', 'late.txt');
    await eventStarted;

    let stopped = false;
    const stopping = watcher.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);

    releaseEvent();
    await stopping;
    expect(stopped).toBe(true);
    expect(fakeWatcher.close).toHaveBeenCalledOnce();
  });
});

describe('createFsWatcher — the settle walk after attaching', () => {
  // ⛔ An attached watcher is not yet a delivering one. On macOS under disk churn a write in the
  // first milliseconds after `fs.watch` returns was lost 19 times in 20 (2026-10-09), and the
  // initial walk had already run, so the file was never indexed. Here the fake watcher delivers
  // NOTHING: everything below must come from the walk that runs `settleMs` after attaching.
  let h: Harness;
  beforeEach(() => { h = newHarness(); });
  afterEach(() => { h.close(); });

  const deafWatcher = (): FSWatcher => Object.assign(new EventEmitter(), { close: vi.fn() }) as unknown as FSWatcher;
  const start = async (extra: Partial<Parameters<typeof createFsWatcher>[0]> = {}) => {
    const events: string[] = [];
    const watcher = createFsWatcher({
      root: h.root, ignore: [], debounceMs: 1, settleMs: 40,
      onEvent: (event) => { events.push(`${event.type}:${relative(h.root, event.path)}`); },
      watchFactory: () => deafWatcher(),
      ...extra,
    });
    await watcher.start();
    return { watcher, events };
  };

  it('reports a file created, one changed and one removed while the watcher was not yet live', async () => {
    writeFileSync(join(h.root, 'kept.txt'), 'v1');
    writeFileSync(join(h.root, 'gone.txt'), 'x');
    const { watcher, events } = await start();
    writeFileSync(join(h.root, 'new.txt'), 'created live');
    writeFileSync(join(h.root, 'kept.txt'), 'v2-longer');
    unlinkSync(join(h.root, 'gone.txt'));
    await vi.waitFor(() => expect(events).toEqual(expect.arrayContaining([
      'change:new.txt', 'change:kept.txt', 'remove:gone.txt',
    ])), { timeout: 3_000 });
    await watcher.stop();
  });

  it('does not report again what an event already handled', async () => {
    let listener: ((eventType: string, filename: string | null) => void) | undefined;
    const { watcher, events } = await start({
      watchFactory: (_root, l) => { listener = l; return deafWatcher(); },
    });
    writeFileSync(join(h.root, 'seen.txt'), 'live');
    listener?.('rename', 'seen.txt');                     // the watcher did see this one
    await vi.waitFor(() => expect(events).toContain('change:seen.txt'));
    await new Promise((r) => setTimeout(r, 150));         // past the settle walk
    expect(events.filter((e) => e === 'change:seen.txt')).toHaveLength(1);
    await watcher.stop();
  });

  // What protects these files is the stat each candidate gets before a removal is reported
  // (only ENOENT removes), not the walk: it cannot read the folder at all.
  it.skipIf(process.getuid?.() === 0)('takes nothing out when it cannot read a folder: its files may all be there', async () => {
    mkdirSync(join(h.root, 'sub'));
    writeFileSync(join(h.root, 'sub', 'inside.txt'), 'x');
    const { watcher, events } = await start({ settleMs: 80 });
    chmodSync(join(h.root, 'sub'), 0o000);
    try {
      await new Promise((r) => setTimeout(r, 250));
      expect(events.filter((e) => e.startsWith('remove:'))).toEqual([]);
    } finally {
      chmodSync(join(h.root, 'sub'), 0o755);
      await watcher.stop();
    }
  });

  it('a stop before the walk cancels it', async () => {
    const { watcher, events } = await start({ settleMs: 60 });
    await watcher.stop();
    writeFileSync(join(h.root, 'after-stop.txt'), 'x');
    await new Promise((r) => setTimeout(r, 150));
    expect(events.filter((e) => e.includes('after-stop'))).toEqual([]);
  });
});
