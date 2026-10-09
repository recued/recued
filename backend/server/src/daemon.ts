/** Daemon management — start/stop/status for the background server process.
 *
 *  Uses a pidfile to track the running process. The server is spawned
 *  as a detached child with stdout/stderr redirected to a log file.
 *
 *  File layout (next to the database):
 *    recued-server.pid   — PID of the running server
 *    recued-server.log   — stdout + stderr. The server recognises this file as
 *                          its stdout and writes it through `cli/server-log.ts`,
 *                          which caps it at 5 MB plus one older copy. A server
 *                          started under the macOS LaunchAgent, whose output is
 *                          /dev/null, writes the same file the same way.
 */

import { lastStartErrorLines, readLastStartError } from './cli/last-start-error.js';
import { SERVER_LOG_FILE } from './cli/server-log.js';
import { spawn } from 'node:child_process';
import { createServer as netCreateServer } from 'node:net';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { openSync } from 'node:fs';
import { readAutoDisabledFromDb, renderAutoDisabledTable } from './cli-status-extras.js';
import { runningAsPackagedBinary } from './packaged-binary.js';
// ⚠ THE SAME RULE THE UPDATE PATH USES, from the layer that owns the lock. A
// second definition of "is a server holding this realm" is how two commands
// come to disagree about one machine; importing the update profile's copy
// would instead breach the per-profile module graph `bin-router` ratchets.
import { liveServerHolding } from './lifecycle/instance-lock.js';

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
    logFile: join(dir, SERVER_LOG_FILE),
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
    // ⛔⛔ SAYING "I CANNOT KNOW" WAS HONEST AND STILL A DEAD END. The previous
    // message correctly stopped claiming the server was not running — a pidfile
    // records only what `recued start` launched — but it left the owner with
    // nowhere to go, and the routes it pointed at refuse in turn: the installer
    // will not upgrade a healthy install, and `recued update apply` refuses
    // while anything holds the realm. Three correct refusals compose into a
    // LIVELOCK, and `recued serve` — the form the boot banner and BOTH autostart
    // units use — is the shape that has no way out.
    //
    // 🔑 THE ANSWER WAS ALREADY ON DISK. The instance lock beside the database
    // records the holder's `pid` AND `bind_port`; it is what lets `recued update
    // apply` name them. One subsystem held the identity of the holder while this
    // one announced it could not know.
    //
    // ⚠ SAFE UNDER A SUPERVISOR, AND THAT IS MEASURED RATHER THAN HOPED. Both
    // generated units restart on FAILURE only (`KeepAlive{SuccessfulExit:false}`
    // / `Restart=on-failure`), and `recued-supervise` forwards a clean child
    // exit as its own `exit 0` — so a graceful stop of the payload takes the
    // whole stack down and neither launchd nor systemd respawns it.
    const holder = liveServerHolding(opts.dbPath);
    if (!holder) {
      console.log('No pidfile, and nothing holds this realm — no server to stop.');
      console.log('  `recued stop` manages a server started by `recued start`, and falls back');
      console.log('  to the instance lock a `recued serve` (foreground or supervised) writes.');
      console.log('  If a port is busy anyway it belongs to another realm; `recued status` says which.');
      return;
    }
    await terminate(holder.pid, `pid ${holder.pid}, port ${holder.bind_port}`);
    noteAutostartUnitStillArmed();
    return;
  }

  if (!isAlive(pid)) {
    console.log(`Stale pidfile (pid ${pid} is not running). Cleaning up.`);
    try { unlinkSync(pidFile); } catch {}
    return;
  }

  await terminate(pid, `pid ${pid}`);
  try { unlinkSync(pidFile); } catch {}
};

/** SIGTERM, wait, then SIGKILL — the one stop behaviour both routes share, so a
 *  `serve`-started server is not stopped more abruptly than a `start`-ed one. */
const terminate = async (pid: number, label: string): Promise<void> => {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    console.log(`Server (${label}) exited before it could be signalled.`);
    return;
  }
  for (let i = 0; i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    if (!isAlive(pid)) {
      console.log(`Server stopped (${label}).`);
      return;
    }
  }
  console.error(`Server (${label}) did not stop after 5s. Sending SIGKILL.`);
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  console.log('Killed.');
};

/** ⚠ STOPPED IS NOT DISARMED. An autostart unit brings the server back at the
 *  next login or boot, which is correct and surprising in equal measure — so say
 *  it, and name the command that actually disarms it on THIS platform. */
const noteAutostartUnitStillArmed = (): void => {
  const home = process.env.HOME ?? '';
  const units: [string, string][] = [
    [join(home, 'Library/LaunchAgents/com.recued.server.plist'),
      'launchctl bootout gui/$(id -u)/com.recued.server'],
    ['/etc/systemd/system/recued.service', 'sudo systemctl disable --now recued'],
    [join(home, '.config/systemd/user/recued.service'), 'systemctl --user disable --now recued'],
  ];
  for (const [unit, disable] of units) {
    if (unit && existsSync(unit)) {
      console.log('');
      console.log(`  ⚠ Start-at-login is still armed (${unit}).`);
      console.log('    The server returns at the next login or boot. To disarm it:');
      console.log(`      ${disable}`);
      return;
    }
  }
};

/** Where to look for whatever holds `port` (and, when a recued server is
 *  answering, for the autostart job) — on THIS platform.
 *
 *  ⛔ These were Linux-only (`ss -ltnp`, `systemctl status recued`) on every
 *  host, so a Mac owner whose launchd job held the port was sent to two commands
 *  macOS does not have (reported 2026-09-28). The Mac's autostart is the
 *  `com.recued.server` LaunchAgent the installer writes. */
export const findOwnerHint = (
  port: number,
  platform: NodeJS.Platform,
  withAutostart: boolean,
): string[] => {
  if (platform === 'darwin') {
    return [
      `  Find the owner:  lsof -nP -iTCP:${port} -sTCP:LISTEN`,
      ...(withAutostart
        ? ['                   launchctl print gui/$(id -u)/com.recued.server   (the autostart job, if armed)']
        : []),
    ];
  }
  if (platform === 'win32') {
    return [`  Find the owner:  netstat -ano | findstr :${port}`];
  }
  return [
    `  Find the owner:  ss -ltnp | grep ${port}   (or: lsof -i :${port})`,
    ...(withAutostart
      ? ['                   systemctl status recued   (or systemctl --user status recued: the autostart unit, if armed)']
      : []),
  ];
};

/** Show the running state. */
export const daemonStatus = async (
  opts: DaemonOptions,
  platform: NodeJS.Platform = process.platform,
): Promise<void> => {
  const { pidFile, logFile } = resolvePaths(opts.dbPath);
  const pidFromFile = readPid(pidFile);
  // ⛔ A STALE PIDFILE IS NOT A STOPPED SERVER. Its process is gone, which says
  // nothing about the realm or the port: an autostart unit may be serving right
  // now. This branch used to print `Status: stopped (stale pidfile …)` and
  // return, so an owner whose launchd job held the port read "stopped", then
  // "running" on the very next run, because this call had removed the file
  // (reported 2026-09-28). Clear it, then answer the way the no-pidfile path
  // does — from the realm lock, then the port.
  const stalePid = pidFromFile && !isAlive(pidFromFile) ? pidFromFile : null;
  if (stalePid !== null) {
    try { unlinkSync(pidFile); } catch {}
  }
  const pid = stalePid === null ? pidFromFile : null;
  const staleNote = stalePid !== null
    ? `  Removed a stale pidfile: pid ${stalePid} (from an earlier \`recued start\`) is gone.`
    : null;

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
    // ⛔ ASK THE REALM BEFORE ASKING THE PORT. `pingHealth` answers "is a recued
    // server on THIS PORT", which is a different question from "is a server
    // running on THIS REALM" in two ways that both mislead: another realm's
    // server bound to the same port reads as ours, and our own server bound to
    // a port other than the one this command was handed is missed entirely.
    // The instance lock is realm-scoped and records the port the holder ACTUALLY
    // bound — the same source `recued stop` and `recued update` now use, so all
    // three commands answer one machine the same way.
    const holder = liveServerHolding(opts.dbPath);
    if (holder) {
      console.log(`Status: running — started by \`recued serve\` (pid ${holder.pid}, port ${holder.bind_port}).`);
      if (staleNote) console.log(staleNote);
      console.log('  No pidfile: `recued start` did not launch it — a foreground `recued serve`');
      console.log('  or an autostart unit did. That is the normal shape, not a fault.');
      // ⚠ THIS USED TO SAY `recued stop` COULD NOT HELP, WHICH WAS TRUE AND IS
      // NOT ANY MORE: stop reads this same lock. Leaving the old sentence here
      // would send the owner round the loop this pair was fixed to end.
      console.log('  `recued stop` can stop it — it reads this same instance lock.');
      if (holder.bind_port !== opts.port) {
        console.log('');
        console.log(`  ⚠ It is bound to ${holder.bind_port}, not the ${opts.port} this command was given.`);
        console.log('    Reachability below is computed for the port you passed, not the live one.');
      }
      if (autoDisabledBlock) console.log(autoDisabledBlock);
      return;
    }

    const answering = await pingHealth(opts.port);
    if (answering) {
      console.log('Status: running — but NOT on this realm.');
      if (staleNote) console.log(staleNote);
      console.log(`  A recued server is answering /health on port ${opts.port}, and nothing`);
      console.log('  holds this realm\'s instance lock — so it is serving a DIFFERENT database.');
      console.log('  `recued stop` cannot stop it: it manages this realm only.');
      for (const line of findOwnerHint(opts.port, platform, true)) console.log(line);
    } else if (await portInUse(opts.port)) {
      console.log(`Status: stopped — but port ${opts.port} is already in use.`);
      if (staleNote) console.log(staleNote);
      console.log('  Whatever holds it does not answer /health, so it is probably not a');
      console.log('  recued server. `recued serve` will fail with EADDRINUSE until it is freed.');
      for (const line of findOwnerHint(opts.port, platform, false)) console.log(line);
    } else if (stalePid !== null) {
      console.log(`Status: stopped (stale pidfile for pid ${stalePid}, removed)`);
    } else {
      console.log('Status: stopped');
    }
    // 🔑 SAY WHY, when a start failed. An autostart service has no terminal, so
    // its error went nowhere an owner looks — a passphrase-sealed key file whose
    // service lacks RECUED_IDENTITY_PASSPHRASE just read "stopped" here
    // (`cli/last-start-error.ts`). Cleared by the next start that listens.
    const lastStart = readLastStartError(opts.dbPath);
    if (lastStart) for (const line of lastStartErrorLines(lastStart, Date.now())) console.log(line);
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
