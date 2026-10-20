/** Recursive folder watches live in a process of their own, so closing one can
 *  never stop the server.
 *
 *  ⛔ On macOS, closing a recursive `fs.watch` waits for FSEvents and blocks the
 *  event loop that closes it: measured 2026-10-19 under disk churn, closes on
 *  the server's own loop stalled it for 436 ms and 2,566 ms.
 *
 *  ⚠ NOTHING HERE WAITS FOR A REAL FILE EVENT. On a busy machine FSEvents
 *  delivers late (12.8 s, then none within 120 s, measured the same evening),
 *  and a test that waits for one is a load flake. Routing is driven through a
 *  scripted watch process; real watches are used where delivery does not
 *  matter: attaching, failing, closing. `watched-folders.test.ts` covers real
 *  events. */

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createFsWatcher, defaultWatchFactory, FsWatchUnavailableError, type FsWatchHandle,
} from '../collections/file/fs-adapter.js';
import {
  createWatchHost, WATCH_HOST_SOURCE, watchHostCommand, watchOnce, type WatchHost,
} from '../collections/file/watch-host.js';

const dirs: string[] = [];
const hosts: WatchHost[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const host of hosts.splice(0)) host.stop();
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const folder = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'watch-host-'));
  dirs.push(dir);
  return dir;
};
const host = (source?: string): WatchHost => {
  const created = createWatchHost(source === undefined ? {} : { source });
  hosts.push(created);
  return created;
};
const until = async (done: () => boolean, ms = 10_000): Promise<boolean> => {
  for (const deadline = Date.now() + ms; !done() && Date.now() < deadline;) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return done();
};

/** A watch process that answers like the real one, with events it makes up:
 *  each watch gets one event naming itself; a close is answered with a late
 *  event for the closed watch and an "after-close" event for every other one. */
const SCRIPTED = `
const live = new Set();
process.on('message', (msg) => {
  if (msg.op === 'watch') {
    live.add(msg.id);
    process.send({ id: msg.id, kind: 'attached' });
    process.send({ id: msg.id, kind: 'event', eventType: 'change', filename: 'for-' + msg.id + '.txt' });
  } else if (msg.op === 'close') {
    live.delete(msg.id);
    process.send({ id: msg.id, kind: 'event', eventType: 'change', filename: 'late.txt' });
    for (const other of live) process.send({ id: other, kind: 'event', eventType: 'change', filename: 'after-close.txt' });
  }
});
process.on('disconnect', () => process.exit(0));
`;

/** The watch process, started the way the server starts it, outside a host. */
const startProcess = (command: string, args: string[]): { child: ChildProcess; replies: unknown[] } => {
  const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  children.push(child);
  const replies: unknown[] = [];
  child.on('message', (msg) => { replies.push(msg); });
  return { child, replies };
};
const exited = (child: ChildProcess): Promise<number | null> => new Promise((resolve) => {
  if (child.exitCode !== null) resolve(child.exitCode);
  else child.once('exit', (code) => resolve(code));
});

describe('the watch process', () => {
  it('gives each watch its own events, and nothing once it is closed', async () => {
    const scripted = host(SCRIPTED);
    const first: string[] = [];
    const second: string[] = [];
    const one = scripted.watch('/first', (_type, name) => { if (name) first.push(name); });
    const two = scripted.watch('/second', (_type, name) => { if (name) second.push(name); });
    await one.ready;
    await two.ready;
    expect(await until(() => first.length === 1 && second.length === 1)).toBe(true);
    expect(first[0]).not.toBe(second[0]);

    one.close();
    // The process answered the close (the other watch heard about it), and its
    // late event for the closed watch went nowhere.
    expect(await until(() => second.includes('after-close.txt'))).toBe(true);
    expect(first).toHaveLength(1);
    two.close();
  });

  it('attaches a real watch, and closing it returns at once', async () => {
    const watch = host().watch(folder(), () => {});
    await watch.ready;
    const before = performance.now();
    watch.close();
    expect(performance.now() - before).toBeLessThan(20);
  }, 120_000);

  it('a folder that is not there fails `ready`, with no listener needed', async () => {
    const watch = host().watch(join(folder(), 'missing'), () => {});
    await expect(watch.ready).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('and a listener hears the failure', async () => {
    const watch = host().watch(join(folder(), 'missing'), () => {});
    const heard = new Promise<Error>((resolve) => watch.on('error', resolve));
    await expect(heard).resolves.toMatchObject({ code: 'ENOENT' });
  });

  it('the process starts with none of the server\'s environment, so none of its secrets', async () => {
    vi.stubEnv('RECUED_IDENTITY_PASSPHRASE', 'correct horse battery staple');
    // Outside the namespace, so a child given the server's environment would see it.
    vi.stubEnv('CHILD_ENV_CANARY', 'canary');
    // A scripted process that answers its first watch with the names it can see.
    // (Not an empty list: macOS adds its text encoding, and on Windows Node puts
    // back the system's own variables.)
    const scripted = host(`
process.on('message', (msg) => process.send({ id: msg.id, kind: 'error', message: JSON.stringify(Object.keys(process.env)) }));
process.on('disconnect', () => process.exit(0));
`);
    const watch = scripted.watch(folder(), () => {});
    const seen = JSON.parse(await watch.ready.then(() => '[]', (err: Error) => err.message)) as string[];
    expect(seen.filter((name) => /^recued_/i.test(name) || name === 'CHILD_ENV_CANARY')).toEqual([]);
  });

  it('the real program: once a watch joins others, it waits for the rebuilt stream, then tells them to walk again; a close tells them too', async () => {
    // The program as shipped, with `node:fs` swapped for a stand-in whose watches
    // open and close at once and log what was done: real FSEvents rebuilds take
    // minutes on a loaded machine, and the order is what is under test here.
    const standIn = `
const realGet = process.getBuiltinModule.bind(process);
const { EventEmitter } = realGet('node:events');
const done = [];
process.getBuiltinModule = (name) => name !== 'node:fs' ? realGet(name) : { watch(path, options) {
  const kind = typeof options === 'object' && options.recursive ? 'watch' : 'throwaway';
  done.push(kind + ' ' + path);
  const w = new EventEmitter();
  w.close = () => { done.push('close ' + kind + ' ' + path); };
  return w;
} };
process.on('message', (msg) => { if (msg.op === 'log') process.send({ log: done.splice(0) }); });
`;
    const { child, replies } = startProcess(process.execPath, ['-e', standIn + WATCH_HOST_SOURCE]);
    const exchange = async (msg: object, count: number): Promise<unknown[]> => {
      const before = replies.length;
      child.send(msg);
      expect(await until(() => replies.length >= before + count, 30_000)).toBe(true);
      return replies.slice(before);
    };
    // Alone in the process: nobody to tell, and no wait.
    expect(await exchange({ op: 'watch', id: 1, root: '/a' }, 1)).toEqual([{ id: 1, kind: 'attached' }]);
    expect(await exchange({ op: 'log' }, 1)).toEqual([{ log: ['watch /a'] }]);
    // Joining one: wait for the rebuilt stream (a throwaway watch opened and
    // closed), then the first walks again, before the second is attached.
    expect(await exchange({ op: 'watch', id: 2, root: '/b' }, 2)).toEqual([
      { id: 1, kind: 'rescan' },
      { id: 2, kind: 'attached' },
    ]);
    expect(await exchange({ op: 'log' }, 1)).toEqual([{ log: ['watch /b', 'throwaway /b', 'close throwaway /b'] }]);
    // Closing the second rebuilds the stream again: the first walks again.
    expect(await exchange({ op: 'close', id: 2 }, 1)).toEqual([{ id: 1, kind: 'rescan' }]);
    expect(await exchange({ op: 'log' }, 1)).toEqual([{ log: ['close watch /b'] }]);
    child.disconnect();
  });

  it('a process that dies fails every watch it held', async () => {
    const dying = host('process.exit(3)');
    const one = dying.watch(folder(), () => {});
    const two = dying.watch(folder(), () => {});
    await expect(one.ready).rejects.toThrow('fs.watch process exited with code 3');
    await expect(two.ready).rejects.toThrow('fs.watch process exited with code 3');
  });

  it('`stop` lets the process go: its watches end quietly, and a slow close holds up nothing after it', async () => {
    // A watch process whose every close takes 8 s, as a close can under load.
    const slowClose = host(`
process.on('message', (msg) => {
  if (msg.op === 'watch') process.send({ id: msg.id, kind: 'attached' });
  else if (msg.op === 'close') { const until = Date.now() + 8000; while (Date.now() < until); }
});
process.on('disconnect', () => process.exit(0));
`);
    const closing = slowClose.watch('/closing', () => {});
    const open = slowClose.watch('/open', () => {});
    await closing.ready;
    await open.ready;
    const failures: Error[] = [];
    open.on('error', (err: Error) => { failures.push(err); });

    closing.close();
    slowClose.stop();
    const before = performance.now();
    await slowClose.watch('/later', () => {}).ready;
    // A new process: not the one still busy with the close.
    expect(performance.now() - before).toBeLessThan(5_000);
    expect(failures).toEqual([]);
  }, 120_000);

  it('`stop` lets the process go at once, asking it to close nothing', async () => {
    // Every close here takes 8 s; leaving, it writes a marker.
    const marker = join(folder(), 'gone');
    const stopping = host(`
process.on('message', (msg) => {
  if (msg.op === 'watch') process.send({ id: msg.id, kind: 'attached' });
  else if (msg.op === 'close') { const until = Date.now() + 8000; while (Date.now() < until); }
});
process.on('disconnect', () => {
  process.getBuiltinModule('node:fs').writeFileSync(${JSON.stringify(marker)}, 'gone');
  process.exit(0);
});
`);
    const open = stopping.watch('/open', () => {});
    await open.ready;
    stopping.stop();
    expect(await until(() => existsSync(marker), 4_000)).toBe(true);
  }, 120_000);

  it('the capability check watches in a process of its own, which closing lets go', async () => {
    const check = watchOnce(folder());
    await check.ready;
    const before = performance.now();
    check.close();
    expect(performance.now() - before).toBeLessThan(20);

    const missing = watchOnce(join(folder(), 'missing'));
    await expect(missing.ready).rejects.toMatchObject({ code: 'ENOENT' });
    missing.close();
  }, 120_000);

  it('never keeps the server running: a process holding a watch still exits', async () => {
    // A stand-in server: it opens a watch, then has nothing left to do.
    const module = fileURLToPath(new URL('../collections/file/watch-host.ts', import.meta.url));
    const program = `import(${JSON.stringify(module)}).then(({ createWatchHost }) => {
      createWatchHost().watch(${JSON.stringify(folder())}, () => {});
    });`;
    const server = spawn(process.execPath, ['--import', 'tsx', '-e', program], { stdio: ['ignore', 'ignore', 'inherit'] });
    children.push(server);
    expect(await exited(server)).toBe(0);
  }, 120_000);

  it('leaves when the server lets go of it, and not on a signal meant for the server', async () => {
    const { command, args } = watchHostCommand(false);
    const { child, replies } = startProcess(command, args);
    child.send({ op: 'watch', id: 1, root: folder() });
    // Answered: its program is running, so its handlers are in place.
    expect(await until(() => replies.length > 0, 60_000)).toBe(true);
    expect(replies[0]).toEqual({ id: 1, kind: 'attached' });

    // Ctrl+C reaches the server's whole process group.
    child.kill('SIGINT');
    await new Promise((r) => setTimeout(r, 500));
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();

    child.disconnect();
    expect(await exited(child)).toBe(0);
  }, 120_000);
});

describe('the packaged binary', () => {
  // `recued watch-host` from source: the router, its profile and the program,
  // as the packaged binary runs them (it takes no `node -e`).
  const bin = fileURLToPath(new URL('../bin.ts', import.meta.url));

  it('starts the watch process as `watch-host`', () => {
    expect(watchHostCommand(true)).toEqual({ command: process.execPath, args: ['watch-host'] });
  });

  it('`recued watch-host` runs the watch process', async () => {
    const { child, replies } = startProcess(process.execPath, ['--import', 'tsx', bin, 'watch-host']);
    child.send({ op: 'watch', id: 1, root: folder() });
    child.send({ op: 'watch', id: 2, root: join(folder(), 'missing') });
    expect(await until(() => replies.length >= 2, 60_000)).toBe(true);
    expect(replies).toEqual(expect.arrayContaining([
      { id: 1, kind: 'attached' },
      expect.objectContaining({ id: 2, kind: 'error', code: 'ENOENT' }),
    ]));
    child.disconnect();
    expect(await exited(child)).toBe(0);
  }, 120_000);

  it('run by hand, with nobody to watch for, says what it is and exits', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', bin, 'watch-host'], { stdio: ['ignore', 'ignore', 'pipe'] });
    children.push(child);
    let stderr = '';
    child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    expect(await exited(child)).toBe(1);
    expect(stderr).toContain('started by the server to watch its folders');
  }, 120_000);
});

describe('the folder watcher over the watch process', () => {
  it('walks the folder and attaches its watch in the watch process', async () => {
    const dir = folder();
    writeFileSync(join(dir, 'there.txt'), 'x');
    const events: string[] = [];
    // macOS's factory on every platform: elsewhere the default watches in the server.
    const watcher = createFsWatcher({
      root: dir, ignore: [], settleMs: -1, watchFactory: defaultWatchFactory('darwin'),
      onEvent: (event) => { events.push(`${event.type}:${event.path.slice(dir.length + 1)}`); },
    });
    await watcher.start();
    expect(events).toEqual(['present:there.txt']);
    await watcher.stop();
  }, 120_000);

  it('asks to be walked again when its watch may have missed changes, and not once stopped', async () => {
    const handle = Object.assign(new EventEmitter(), { close: () => {}, ready: Promise.resolve() });
    let asked = 0;
    const watcher = createFsWatcher({
      root: folder(), ignore: [], settleMs: -1, onEvent: () => {},
      watchFactory: () => handle as unknown as FsWatchHandle,
      onRescanNeeded: () => { asked += 1; },
    });
    await watcher.start();
    handle.emit('rescan');
    expect(asked).toBe(1);
    await watcher.stop();
    handle.emit('rescan');
    expect(asked).toBe(1);
  });

  it('and once events naming the folder itself have stopped for 2 s, not while they come', async () => {
    const dir = folder();
    let listener: ((eventType: string, filename: string | null) => void) | undefined;
    const handle = Object.assign(new EventEmitter(), { close: () => {}, ready: Promise.resolve() });
    let asked = 0;
    const watcher = createFsWatcher({
      root: dir, ignore: [], settleMs: -1, onEvent: () => {},
      watchFactory: (_root, l) => { listener = l; return handle as unknown as FsWatchHandle; },
      onRescanNeeded: () => { asked += 1; },
    });
    await watcher.start();
    // libuv names the folder by its own name, resolved.
    const itself = basename(realpathSync(dir));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      listener!('rename', itself);
      vi.advanceTimersByTime(1_500);
      listener!('rename', itself);
      vi.advanceTimersByTime(1_500);
      expect(asked).toBe(0);
      vi.advanceTimersByTime(600);
      expect(asked).toBe(1);
      // A file's own event asks for nothing.
      listener!('rename', 'note.txt');
      vi.advanceTimersByTime(3_000);
      expect(asked).toBe(1);
    } finally {
      vi.useRealTimers();
      await watcher.stop();
    }
  });

  it('`rescan` walks again: every file present, complete only when every directory was read', async () => {
    const dir = folder();
    writeFileSync(join(dir, 'a.txt'), 'a');
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'b.txt'), 'b');
    const events: string[] = [];
    const watcher = createFsWatcher({
      root: dir, ignore: [], settleMs: -1, watchMode: 'none',
      onEvent: (event) => { events.push(`${event.type}:${relative(dir, event.path).split('\\').join('/')}`); },
    });
    await watcher.start();
    events.length = 0;
    writeFileSync(join(dir, 'c.txt'), 'c');
    expect(await watcher.rescan()).toEqual({ complete: true });
    expect(events.sort()).toEqual(['present:a.txt', 'present:c.txt', 'present:sub/b.txt']);
    if (process.platform !== 'win32') {
      chmodSync(join(dir, 'sub'), 0o000);
      try {
        expect(await watcher.rescan()).toEqual({ complete: false });
      } finally {
        chmodSync(join(dir, 'sub'), 0o700);
      }
    }
    // The initial walk's count stays its own.
    expect(watcher.walkErrors()).toBe(0);
    await watcher.stop();
    expect(await watcher.rescan()).toEqual({ complete: false });
  });

  it('fails `start` when a watch cannot attach, however late it says so', async () => {
    // A hosted watch reports from its process, more than one event-loop turn
    // after it is opened; `start` must wait for that, not call it attached.
    const late: FsWatchHandle = {
      close: () => {},
      on: () => late,
      removeListener: () => late,
      ready: new Promise<void>((_resolve, reject) => {
        setTimeout(() => reject(Object.assign(new Error('watch failed'), { code: 'EMFILE' })), 50);
      }),
    };
    late.ready!.catch(() => {});
    const watcher = createFsWatcher({
      root: folder(), ignore: [], settleMs: -1, onEvent: () => {}, watchFactory: () => late,
    });
    await expect(watcher.start()).rejects.toBeInstanceOf(FsWatchUnavailableError);
  });
});
