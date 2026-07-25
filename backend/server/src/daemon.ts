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
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { openSync } from 'node:fs';
import { readAutoDisabledFromDb, renderAutoDisabledTable } from './cli-status-extras.js';

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

// ────────────────────────────────────────────────────────────────
// Public commands
// ────────────────────────────────────────────────────────────────

export interface DaemonOptions {
  dbPath: string;
  port: number;
  /** Extra CLI args to forward to the child process. */
  extraArgs?: string[];
}

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

  // Build child command: re-invoke bin.ts via npx tsx (the same way
  // the user invokes it). npx tsx handles .js→.ts import rewriting.
  const binPath = resolve(import.meta.dirname ?? __dirname, 'bin.ts');
  const npxPath = findNpx();
  const childCmd = npxPath;
  const childArgs = [
    'tsx', binPath,
    '--port', String(opts.port),
    '--db', opts.dbPath,
    ...(opts.extraArgs ?? []),
  ];

  // Open log file for append
  const logFd = openSync(logFile, 'a');

  const child = spawn(childCmd, childArgs, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env },
    cwd: resolve(import.meta.dirname ?? __dirname, '..', '..', '..'),
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
    console.log('No pidfile found — server is not running.');
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
    const rows = readAutoDisabledFromDb(opts.dbPath);
    autoDisabledBlock = '\n' + renderAutoDisabledTable(rows);
  } catch {
    // Status should never be a hard failure — best-effort.
    autoDisabledBlock = '';
  }

  if (!pid) {
    console.log('Status: stopped');
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
