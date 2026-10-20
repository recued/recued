/** Recursive `fs.watch` handles, kept in a process of their own.
 *
 *  ⛔ CLOSING A RECURSIVE WATCH CAN STOP THE SERVER FOR SECONDS. On macOS a
 *  recursive `fs.watch` rides FSEvents, and libuv's close waits for its
 *  FSEvents thread to rebuild the event stream, blocking the event loop that
 *  closes it. Measured 2026-10-19: closes were usually 0.1 ms, but one took
 *  2 s on an ordinary disk, and test runs under load saw 38 s and more. The
 *  server closes a watch when a folder is connected (the capability check
 *  opens and closes one), changed or disconnected, and when it stops; each
 *  could freeze every chat, run and request with it.
 *
 *  On macOS the watches live in one child process, with its own event loop, so
 *  a slow close stalls only that process (`watchesInOwnProcess`: elsewhere a
 *  close does not block, and they stay in the server). A process, not a worker thread: under
 *  vitest's threads pool the backend suite segfaulted inside Node's worker
 *  code, cause never found (`vitest.config.ts`), and a crash in a worker takes
 *  the whole server with it. A crash here takes only the watches, which report
 *  `error` as any failed watch does.
 *
 *  A watch is an `EventEmitter` like `FSWatcher`: it emits `error` if the watch
 *  fails, `close()` returns at once, and `ready` settles when the watch has
 *  attached (or rejects when it could not). The process is unref'd, so it
 *  never keeps the server alive, and it exits when the server goes away,
 *  however it goes: its message channel closes. */

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { runningAsPackagedBinary } from '../../packaged-binary.js';

/** Whether the server's recursive watches go to a watch process. ⛔ On macOS
 *  closing one blocks the event loop that closes it, for seconds under load.
 *  On Linux and Windows a close took under a millisecond (measured 2026-10-19,
 *  five other watches held), and a watch process of the packaged binary costs
 *  about 100 MB, the binary's own start-up cost: there the watches stay in the
 *  server. */
export const watchesInOwnProcess = (platform: NodeJS.Platform = process.platform): boolean =>
  platform === 'darwin';

/** The watch process's whole program. Inline, so it runs from source, the
 *  bundle and the packaged binary alike, with no file of its own to find:
 *  `node -e` runs it, and the packaged binary, which takes no `-e`, runs it as
 *  `recued watch-host` (`runWatchHostChild`).
 *  ⚠ `process.getBuiltinModule`, not `require`: the same source must run as a
 *  script or inside a module, whichever starts it. */
export const WATCH_HOST_SOURCE = `
const { watch } = process.getBuiltinModule('node:fs');
const watches = new Map();
const send = (msg) => { if (process.connected) process.send(msg); };
const fail = (id, err) => send({ id, kind: 'error',
  message: err && err.message ? String(err.message) : String(err), code: err && err.code });
// Every watch here shares one FSEvents stream, which libuv rebuilds "since now"
// whenever a watch is added or removed: what changes meanwhile is lost to the
// others, without a word. A close waits for every rebuild queued before it, so
// once one returns the stream is whole again, and the others are told to walk.
// A watch alone in its process (the capability check's, a first folder's) has
// nobody to tell, and does not wait.
const settleStream = (root) => { try { watch(root, () => {}).close(); } catch {} };
const rescanOthers = (except) => { for (const id of watches.keys()) if (id !== except) send({ id, kind: 'rescan' }); };
process.on('message', (msg) => {
  if (msg.op === 'watch') {
    let w;
    try {
      w = watch(msg.root, { recursive: true }, (eventType, filename) => {
        send({ id: msg.id, kind: 'event', eventType,
          filename: typeof filename === 'string' ? filename : null });
      });
    } catch (err) { fail(msg.id, err); return; }
    watches.set(msg.id, w);
    w.on('error', (err) => { watches.delete(msg.id); try { w.close(); } catch {} fail(msg.id, err); rescanOthers(msg.id); });
    if (watches.size > 1) {
      settleStream(msg.root);
      rescanOthers(msg.id);
    }
    // An error on the watch's first turn is a failure to attach.
    setImmediate(() => { if (watches.get(msg.id) === w) send({ id: msg.id, kind: 'attached' }); });
  } else if (msg.op === 'close') {
    const w = watches.get(msg.id);
    watches.delete(msg.id);
    if (w) { try { w.close(); } catch {} rescanOthers(msg.id); }
  }
});
// The server is gone, or let this process go: there is nobody to watch for.
process.on('disconnect', () => process.exit(0));
// ⚠ Not on a signal: Ctrl+C reaches the server's whole process group, and a
// service manager may signal every process of the server at once. Dying with
// it here would report every folder's watch as failed while the server stops.
process.on('SIGINT', () => {});
process.on('SIGTERM', () => {});
`;

/** How the server starts its watch process: `node -e` with the program, or the
 *  packaged binary as `watch-host`, since it takes no `-e`. No inherited Node
 *  flags (`spawn` passes none): a parent's `--import` loader or `--inspect`
 *  port would change how this small program starts, or fail it. */
export const watchHostCommand = (
  packaged: boolean,
  source: string = WATCH_HOST_SOURCE,
): { command: string; args: string[] } => ({
  command: process.execPath,
  args: packaged ? ['watch-host'] : ['-e', source],
});

/** `recued watch-host`: the packaged binary's way into the program above.
 *  Internal: run without a message channel there is nobody to watch for, so it
 *  says so and exits. */
export const runWatchHostChild = (): void => {
  if (typeof process.send !== 'function') {
    console.error('recued watch-host is started by the server to watch its folders; it does nothing on its own.');
    process.exitCode = 1;
    return;
  }
  new Function(WATCH_HOST_SOURCE)();
};

type HostMessage =
  | { id: number; kind: 'event'; eventType: string; filename: string | null }
  | { id: number; kind: 'error'; message: string; code?: string }
  | { id: number; kind: 'attached' }
  | { id: number; kind: 'rescan' };

/** One recursive watch held by the watch process. It emits `rescan` when it may
 *  have missed changes: the process rebuilt its stream for another watch. */
export class HostedWatch extends EventEmitter {
  /** Settles once the watch has attached; rejects when it could not. */
  readonly ready: Promise<void>;
  private settle: { resolve: () => void; reject: (err: Error) => void } | undefined;
  private closed = false;

  constructor(
    private readonly id: number,
    private readonly listener: (eventType: string, filename: string | null) => void,
    private readonly post: (msg: unknown) => void,
    private readonly forget: (id: number) => void,
  ) {
    super();
    this.ready = new Promise<void>((resolve, reject) => { this.settle = { resolve, reject }; });
    // A rejection nobody awaits is reported through `error` as well.
    this.ready.catch(() => {});
  }

  /** @internal — a message from the watch process for this watch. */
  receive(msg: HostMessage): void {
    if (this.closed) return;
    if (msg.kind === 'event') {
      this.listener(msg.eventType, msg.filename);
    } else if (msg.kind === 'attached') {
      this.settle?.resolve();
      this.settle = undefined;
    } else if (msg.kind === 'rescan') {
      // The stream was rebuilt for another watch: this one may have missed changes.
      this.emit('rescan');
    } else {
      const err = Object.assign(new Error(msg.message), msg.code !== undefined ? { code: msg.code } : {});
      this.closed = true;
      this.forget(this.id);
      this.settle?.reject(err);
      this.settle = undefined;
      // ⚠ Only to a listener: an `error` nobody listens for throws, and a
      // watch that failed must never take the server down. `ready` has it.
      if (this.listenerCount('error') > 0) this.emit('error', err);
    }
  }

  /** Stop watching. Returns at once: the watch process closes the handle. */
  close(): void {
    if (!this.end()) return;
    this.post({ op: 'close', id: this.id });
  }

  /** @internal — the process is being let go: stop listening, and ask it for
   *  nothing, since it exits instead of closing the handle. */
  abandon(): void {
    this.end();
  }

  private end(): boolean {
    if (this.closed) return false;
    this.closed = true;
    this.forget(this.id);
    this.settle?.reject(new Error('fs.watch closed before it attached'));
    this.settle = undefined;
    return true;
  }
}

export interface WatchHost {
  watch(root: string, listener: (eventType: string, filename: string | null) => void): HostedWatch;
  /** Let the watch process go, and every watch it holds with it, without a
   *  failure. It exits rather than closing them: measured 2026-10-19, closing
   *  one of five watches took 80 ms to 2.4 s, and letting the process go
   *  2-5 ms. A later watch starts a new process. */
  stop(): void;
}

/** A host with its own process, started on the first watch. If the process
 *  dies, every live watch reports `error` (the folder's health degrades, as
 *  for any failed watch) and the next watch starts a new process. */
export const createWatchHost = (opts: {
  /** Test seam: another program for the process, to drive one that fails.
   *  The packaged binary always runs the real one. */
  readonly source?: string;
} = {}): WatchHost => {
  let child: ChildProcess | undefined;
  let nextId = 1;
  const live = new Map<number, HostedWatch>();

  const failAll = (err: Error): void => {
    child = undefined;
    for (const watch of [...live.values()]) watch.receive({ id: 0, kind: 'error', message: err.message });
  };
  const ensureChild = (): ChildProcess => {
    if (child) return child;
    const { command, args } = watchHostCommand(runningAsPackagedBinary(), opts.source);
    // ⚠ No environment: the server's holds its secrets (`server-secrets-in-
    // child-env.test.ts`), and watching folders needs none of it. On Windows
    // Node itself puts back the system's own (PATH, SYSTEMROOT, TEMP, USERNAME
    // …; measured 2026-10-19 on Windows 11), none of them the server's.
    const started = spawn(command, args, { env: {}, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    // ⚠ Both: the process and its message channel each keep the server's
    // event loop alive otherwise.
    started.unref();
    started.channel?.unref();
    started.on('message', (msg: HostMessage) => { live.get(msg.id)?.receive(msg); });
    started.on('error', (err) => {
      if (child === started) failAll(err);
    });
    started.on('exit', (code, signal) => {
      if (child === started) {
        failAll(new Error(`fs.watch process exited with ${signal ? `signal ${signal}` : `code ${code}`}`));
      }
    });
    child = started;
    return started;
  };

  return {
    watch(root, listener) {
      const host = ensureChild();
      const id = nextId;
      nextId += 1;
      // A process that has exited took its watches with it: nothing to close.
      // A send that fails reaches the `error` handler above.
      const post = (msg: unknown): void => { if (host.connected) host.send(msg as object); };
      const watch = new HostedWatch(id, listener, post, (gone) => { live.delete(gone); });
      live.set(id, watch);
      post({ op: 'watch', id, root });
      return watch;
    },
    stop() {
      const running = child;
      child = undefined;
      for (const watch of [...live.values()]) watch.abandon();
      // It ignores signals and leaves when its channel closes.
      if (running?.connected) running.disconnect();
    },
  };
};

/** One watch in a process of its own, for the capability check. Closing it
 *  lets that process go, so the check never waits on a close and never queues
 *  behind (or ahead of) the folders' own watches in the shared process. */
export const watchOnce = (root: string): Pick<HostedWatch, 'ready' | 'once' | 'removeListener' | 'close'> => {
  const host = createWatchHost();
  const watch = host.watch(root, () => {});
  return {
    ready: watch.ready,
    once: (event, listener) => watch.once(event, listener),
    removeListener: (event, listener) => watch.removeListener(event, listener),
    close: () => host.stop(),
  };
};

/** The process's watch host, for the folders' watches. */
let shared: WatchHost | undefined;
export const sharedWatchHost = (): WatchHost => {
  shared ??= createWatchHost();
  return shared;
};

/** Tests sharing a worker process: let the shared watch process go, so one
 *  test's closes never hold up another's watches. */
export const __stopSharedWatchHost = (): void => {
  shared?.stop();
};

/** Tests: put another host in the shared one's place (one with a scripted
 *  process), or, with none, go back to the real one. */
export const __setSharedWatchHost = (host?: WatchHost): void => {
  shared?.stop();
  shared = host;
};
