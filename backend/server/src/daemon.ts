/** Daemon management — start/stop/status for the background server process.
 *
 *  Uses a pidfile to track the running process. The server is spawned
 *  as a detached child with stdout/stderr redirected to a log file.
 *
 *  File layout (next to the database):
 *    recued-server.pid   — PID of the running server
 *    recued-server.log   — stdout + stderr
 */

import { spawn } from 'node:child_process';
import { createServer as netCreateServer } from 'node:net';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { openSync } from 'node:fs';
import { readAutoDisabledFromDb, renderAutoDisabledTable } from './cli-status-extras.js';
import { runningAsPackagedBinary } from './packaged-binary.js';

/** Find the npx binary path. Falls back to 'npx' (relies on PATH). */
const findNpx = (): string => {
  // npx lives next to the node binary
  const nodeDir = dirname(process.execPath);
  const candidate = join(nodeDir, 'npx');
  return existsSync(candidate) ? candidate : 'npx';
};

/** Resolve pidfile + logfile paths from the database path.
 *  Keeps everything in one directory. */
const resolvePaths = (dbPath: string) => {
  const dir = dirname(resolve(dbPath));
  return {
    pidFile: join(dir, 'recued-server.pid'),
    logFile: join(dir, 'recued-server.log'),
  };
};

/** Read PID from the pidfile. Returns null if missing or unparseable. */
const readPid = (pidFile: string): number | null => {
  if (!existsSync(pidFile)) return null;
  const raw = readFileSync(pidFile, 'utf-8').trim();
  const pid = parseInt(raw, 10);
  return isNaN(pid) ? null : pid;
};

/** Check if a process with the given PID is alive. */
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Ping the health endpoint to verify the server is responding. */
const pingHealth = async (port: number): Promise<boolean> => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { 'Authorization': 'Bearer status-check' },
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
};

/** Is anything holding the port? Distinguishes "nothing is there" from "held by
 *  a process this command did not start" — `pingHealth` alone cannot, because a
 *  non-recued listener and an empty port both fail it identically. */
const portInUse = (port: number): Promise<boolean> =>
  new Promise((res) => {
    const probe = netCreateServer();
    probe.once('error', (e: NodeJS.ErrnoException) => res(e.code === 'EADDRINUSE'));
    probe.once('listening', () => probe.close(() => res(false)));
    try { probe.listen(port, '127.0.0.1'); } catch { res(false); }
  });

// ────────────────────────────────────────────────────────────────
// Public commands
// ────────────────────────────────────────────────────────────────

export interface DaemonOptions {
  dbPath: string;
  port: number;
  /** Extra CLI args to forward to the child process. */
  extraArgs?: string[];
}

export interface DaemonSpawn { cmd: string; args: string[]; cwd: string }

/** How the background server is launched — pure, so the rule can be asserted
 *  without building a 140 MB executable to look at it.
 *
 *  ⛔⛔ THE PACKAGED BINARY MUST RE-EXECUTE ITSELF. This had one branch —
 *  `npx tsx <dir>/bin.ts` — which is right from a source checkout and impossible
 *  anywhere else. In a SEA there is no `bin.ts` on disk and `import.meta.dirname`
 *  is not a directory, so the path resolved against the process CWD and the
 *  daemon spawned `npx tsx ./bin.ts`: it borrowed whatever node and tsx happened
 *  to be on the owner's PATH, died instantly with ERR_MODULE_NOT_FOUND, and left
 *  `recued status` truthfully reporting "stopped". That is why this read as a
 *  status bug. On a machine with no Node installed — every machine the installer
 *  targets — `npx` is not even spawnable, so `recued start` could never have
 *  worked in a published build.
 *
 *  🔑 The binary IS the entrypoint: `process.execPath` with the server args and
 *  no subcommand is exactly the foreground `serve` the banner documents, and it
 *  carries its own runtime plus the `lib/` sidecar beside it.
 *
 *  ⚠ CWD IS PART OF THE CONTRACT, not incidental. The db path default is
 *  CWD-relative, so the child must land somewhere deterministic or a restart can
 *  open a DIFFERENT database. Source keeps the repo root it always used; the
 *  binary gets the realm directory — already the agreed place, since the pidfile
 *  and the log live there. */
export const buildDaemonSpawn = (opts: DaemonOptions, packaged: boolean): DaemonSpawn => {
  const serverArgs = [
    '--port', String(opts.port),
    '--db', opts.dbPath,
    ...(opts.extraArgs ?? []),
  ];
  if (packaged) {
    return { cmd: process.execPath, args: serverArgs, cwd: dirname(resolve(opts.dbPath)) };
  }
  const binPath = resolve(import.meta.dirname ?? __dirname, 'bin.ts');
  return {
    cmd: findNpx(),
    args: ['tsx', binPath, ...serverArgs],
    cwd: resolve(import.meta.dirname ?? __dirname, '..', '..', '..'),
  };
};

/** Start the server as a background process. */
export const daemonStart = async (opts: DaemonOptions): Promise<void> => {
  const { pidFile, logFile } = resolvePaths(opts.dbPath);

  // Check for already running
  const existingPid = readPid(pidFile);
  if (existingPid && isAlive(existingPid)) {
    const healthy = await pingHealth(opts.port);
    console.log(`Server already running (pid ${existingPid})${healthy ? '' : ' — not responding to health check'}`);
    return;
  }

  // Clean up stale pidfile
  if (existingPid) {
    try { unlinkSync(pidFile); } catch {}
  }

  // Ensure directory exists
  const dir = dirname(pidFile);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  // See `buildDaemonSpawn` — the SEA and the source checkout launch differently.
  const { cmd: childCmd, args: childArgs, cwd: childCwd } =
    buildDaemonSpawn(opts, runningAsPackagedBinary());

  // Open log file for append
  const logFd = openSync(logFile, 'a');

  const child = spawn(childCmd, childArgs, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env },
    cwd: childCwd,
  });

  child.unref();

  if (!child.pid) {
    console.error('Failed to start server process');
    process.exit(1);
  }

  writeFileSync(pidFile, String(child.pid));

  // Wait briefly and verify the process is alive
  await new Promise(r => setTimeout(r, 500));
  if (!isAlive(child.pid)) {
    // Best-effort: inspect the log for Phase C lock_held signal so
    // the CLI prints a specific error instead of a generic one.
    let lockHeld = false;
    try {
      const logTail = readFileSync(logFile, 'utf-8').slice(-2048);
      if (/\[lifecycle\] another recued is already running/.test(logTail) ||
          /lock_held|LOCK_HELD/.test(logTail)) {
        lockHeld = true;
      }
    } catch { /* log unreadable — fall through to generic error */ }
    if (lockHeld) {
      console.error('Another recued is already running against this data folder.');
      console.error(`Stop the other instance first, or check ${logFile} for details.`);
      try { unlinkSync(pidFile); } catch {}
      process.exit(4);
    }
    console.error(`Server process exited immediately. See ${logFile} for the cause.`);
    try { unlinkSync(pidFile); } catch {}
    process.exit(1);
  }

  // Try a health ping (may take a moment to bind)
  let healthy = false;
  for (let i = 0; i < 5; i++) {
    healthy = await pingHealth(opts.port);
    if (healthy) break;
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`Server started (pid ${child.pid}, port ${opts.port})${healthy ? '' : ' — waiting for the health check'}`);
  console.log(`  Log: ${logFile}`);
  console.log(`  PID: ${pidFile}`);
};

/** Stop the running server. */
// Stop is pidfile + signal driven — it needs only the data path, never the
// bind port. The narrow type lets the CLI invoke it as a recovery command
// without resolving the port (which can throw on a malformed config).
export const daemonStop = async (opts: Pick<DaemonOptions, 'dbPath'>): Promise<void> => {
  const { pidFile } = resolvePaths(opts.dbPath);
  const pid = readPid(pidFile);

  if (!pid) {
    // ⛔ THIS SAID "server is not running", WHICH IT CANNOT KNOW. The pidfile
    // records what `recued start` launched; a server started by a systemd or
    // launchd unit, or a foreground `recued serve` in another shell, leaves no
    // pidfile and is invisible here. Asserting it is not running — to an owner
    // staring at EADDRINUSE — sends them hunting the wrong fault. Say only what
    // this command actually knows.
    console.log('No pidfile — `recued stop` only manages a server started by `recued start`.');
    console.log('  If something is serving on the port anyway (an autostart unit, or a');
    console.log('  foreground `recued serve` in another shell), this cannot stop it.');
    console.log('  `recued status` will say which case you are in.');
    return;
  }

  if (!isAlive(pid)) {
    console.log(`Stale pidfile (pid ${pid} is not running). Cleaning up.`);
    try { unlinkSync(pidFile); } catch {}
    return;
  }

  // Send SIGTERM and wait for exit
  process.kill(pid, 'SIGTERM');

  let stopped = false;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 250));
    if (!isAlive(pid)) { stopped = true; break; }
  }

  if (stopped) {
    try { unlinkSync(pidFile); } catch {}
    console.log(`Server stopped (pid ${pid}).`);
  } else {
    console.error(`Server (pid ${pid}) did not stop after 5s. Sending SIGKILL.`);
    try { process.kill(pid, 'SIGKILL'); } catch {}
    try { unlinkSync(pidFile); } catch {}
    console.log('Killed.');
  }
};

/** Show the running state. */
export const daemonStatus = async (opts: DaemonOptions): Promise<void> => {
  const { pidFile, logFile } = resolvePaths(opts.dbPath);
  const pid = readPid(pidFile);

  // Auto-disabled circuit rows live in SQLite and are read directly
  // — same answer whether the daemon is up or down (a restart
  // hydrates back from the same table).
  let autoDisabledBlock = '';
  try {
    const rows = await readAutoDisabledFromDb(opts.dbPath);
    autoDisabledBlock = '\n' + renderAutoDisabledTable(rows);
  } catch {
    // Status should never be a hard failure — best-effort.
    autoDisabledBlock = '';
  }

  if (!pid) {
    // ⛔⛔ "stopped" IS A CLAIM ABOUT THE PIDFILE, NOT ABOUT THE PORT — and the
    // two now disagree routinely, because D-178 autostart units start the server
    // at boot and write no pidfile. The owner then reads `Status: stopped` next
    // to an `EADDRINUSE` from `recued serve` and cannot tell which is lying.
    // Neither is: they answer different questions.
    //
    // 🔑 A negative must name its cause. Three outcomes, never one:
    //    answers /health       → a recued server is up, just not ours to stop
    //    port held, no health  → something else owns it; serve keeps failing
    //    port free             → genuinely stopped
    const answering = await pingHealth(opts.port);
    if (answering) {
      console.log('Status: running — but NOT under `recued start` (no pidfile).');
      console.log(`  A recued server is answering /health on port ${opts.port}.`);
      console.log('  `recued stop` cannot stop it: it only manages what it started.');
      console.log(`  Find the owner:  ss -ltnp | grep ${opts.port}   (or: lsof -i :${opts.port})`);
      console.log('                   systemctl status recued   (the autostart unit, if armed)');
    } else if (await portInUse(opts.port)) {
      console.log(`Status: stopped — but port ${opts.port} is already in use.`);
      console.log('  Whatever holds it does not answer /health, so it is probably not a');
      console.log('  recued server. `recued serve` will fail with EADDRINUSE until it is freed.');
      console.log(`  Find the owner:  ss -ltnp | grep ${opts.port}   (or: lsof -i :${opts.port})`);
    } else {
      console.log('Status: stopped');
    }
    if (autoDisabledBlock) console.log(autoDisabledBlock);
    return;
  }

  if (!isAlive(pid)) {
    console.log(`Status: stopped (stale pidfile for pid ${pid})`);
    try { unlinkSync(pidFile); } catch {}
    if (autoDisabledBlock) console.log(autoDisabledBlock);
    return;
  }

  const healthy = await pingHealth(opts.port);

  console.log(`Status:  running`);
  console.log(`PID:     ${pid}`);
  console.log(`Port:    ${opts.port}`);
  console.log(`Health:  ${healthy ? 'ok' : 'not responding'}`);
  console.log(`DB:      ${opts.dbPath}`);
  console.log(`Log:     ${logFile}`);
  if (autoDisabledBlock) console.log(autoDisabledBlock);
};

/** Restart: stop then start. */
export const daemonRestart = async (opts: DaemonOptions): Promise<void> => {
  await daemonStop(opts);
  await daemonStart(opts);
};
