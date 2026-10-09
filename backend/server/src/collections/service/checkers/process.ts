/** D-118 Phase 4 — default IO seams for checkers.
 *
 *  Every checker kind reaches into Node IO through one of these
 *  helpers. The dispatcher loads them as the default `ctx.*`
 *  when the caller hasn't injected a mock. Keeping them in a
 *  single file lets tests replace them wholesale without having
 *  to shim child_process / net / fs / fetch across modules.
 *
 *  Stdio for exec_ok spawns matches D-118 decision #9:
 *  `['ignore', 'ignore', 'ignore']`. Checkers only care about the
 *  exit code — stdout/stderr capture would be wasted IO on a
 *  predicate, and an ignored stdin keeps REPL-shaped binaries
 *  from hanging the probe until the timeout fires.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { createConnection } from 'node:net';
import { delimiter as pathDelimiter, join } from 'node:path';
import { envForOthers } from '../../../supervision/env-for-others.js';

import type {
  CheckerContext,
  CheckerSpawnFn,
  CheckerTcpConnectFn,
} from './types.js';

/** Spawn with timeout. Kills the child with SIGKILL if the
 *  timer fires before exit; surfaces the timeout as
 *  `exit_code: -9` so handlers can distinguish it from a normal
 *  non-zero exit. Spawn-time errors (binary missing, permission
 *  denied) surface as `exit_code: -1`. */
export const defaultSpawnWithTimeout: CheckerSpawnFn = (argv, timeoutMs) =>
  new Promise((resolve) => {
    if (argv.length === 0) {
      resolve({ exit_code: -1 });
      return;
    }
    const [cmd, ...rest] = argv;
    let settled = false;
    const finish = (exit_code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exit_code });
    };
    let child;
    try {
      child = nodeSpawn(cmd, rest, {
        shell: false,
        stdio: ['ignore', 'ignore', 'ignore'],
        // Never the server's environment whole: see `supervision/env-for-others.ts`.
        env: envForOthers(),
      });
    } catch {
      resolve({ exit_code: -1 });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish(-9);
    }, timeoutMs);
    child.on('error', () => { finish(-1); });
    child.on('close', (code) => { finish(code ?? -1); });
  });

/** fs.stat → true/false. Any error (ENOENT, EACCES, broken
 *  symlink) surfaces as `false` — checkers are predicates. */
export const defaultStat = async (path: string): Promise<boolean> => {
  try {
    await fsp.stat(path);
    return true;
  } catch {
    return false;
  }
};

/** UTF-8 read for pid files. Throws on IO error so the handler
 *  can classify as `passed: false` with the error message in
 *  `detail`. Pid files are small — read the whole thing. */
export const defaultReadText = (path: string): Promise<string> =>
  fsp.readFile(path, 'utf8');

/** `kill(pid, 0)` probe. Returns true when the process exists
 *  and is signalable by the current uid; false on ESRCH (no such
 *  process) or EPERM (exists but foreign uid — still a liveness
 *  signal, but `pid_file` treats it as "not ours"). */
export const defaultKill0 = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** TCP connect probe. Resolves true on `connect`, false on
 *  timeout / error. Uses `net.createConnection` with an explicit
 *  `setTimeout` so we don't block past the caller's budget. */
export const defaultTcpConnect: CheckerTcpConnectFn = (host, port, timeoutMs) =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* already destroyed */
      }
      resolve(ok);
    };
    const socket = createConnection({ host, port }, () => { finish(true); });
    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => { finish(false); });
    socket.on('error', () => { finish(false); });
  });

/** PATH scan for `binary_in_path`. Walks `process.env.PATH`
 *  entries, checking each directory for a file named `<binary>`
 *  (plus Windows extensions from `PATHEXT`). The actual
 *  executable-bit check is OS-specific and expensive for the
 *  common success case; here we rely on `fs.stat` existence and
 *  defer "is actually runnable" to `exec_ok` when a template
 *  cares. */
export const defaultWhichBinary = async (name: string): Promise<boolean> => {
  const pathEnv = process.env.PATH ?? '';
  if (pathEnv === '') return false;
  const dirs = pathEnv.split(pathDelimiter).filter(Boolean);
  const candidates = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .map((ext) => name + ext.toLowerCase())
    : [name];
  for (const dir of dirs) {
    for (const cand of candidates) {
      if (await defaultStat(join(dir, cand))) return true;
    }
  }
  return false;
};

/** Populate `ctx` with any missing default IO seams. Centralised
 *  so every checker handler can rely on the context being
 *  complete without per-handler `?? default` fallbacks. */
export const withDefaults = (ctx: CheckerContext): Required<CheckerContext> => ({
  fetch: ctx.fetch ?? globalThis.fetch,
  spawnWithTimeout: ctx.spawnWithTimeout ?? defaultSpawnWithTimeout,
  stat: ctx.stat ?? defaultStat,
  readText: ctx.readText ?? defaultReadText,
  kill0: ctx.kill0 ?? defaultKill0,
  tcpConnect: ctx.tcpConnect ?? defaultTcpConnect,
  whichBinary: ctx.whichBinary ?? defaultWhichBinary,
});
