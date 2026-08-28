/**
 * Layer 3 plumbing — boot the PACKAGED binary on a throwaway copy of an
 * enrolled realm, so a real browser has a real server to pair with.
 *
 * ⛔ WHY THIS LAYER EXISTS. Layer 1 (staging-smoke) drives a real browser with
 * NO server behind it; Layer 2 (kitchen-render) drives real UI against a MOCK
 * connection. Neither opens a socket to a recued-server — which is how every
 * published binary from 2026-07-31 to 26.8.27 shipped with a `/ws` that
 * answered nothing at all. The upgrade handler reached `ws` through a runtime
 * `require` that did not survive single-executable bundling, and thousands of
 * green tests never saw it because under vitest `ws` is simply on disk. The
 * only artifact that can show it is the file a user downloads.
 *
 * Everything here is env-addressed; nothing hard-codes a path or a hostname.
 *   E2E_RECUED_BINARY   the executable under test
 *   E2E_RECUED_SIDECAR  its native SQLite addon (default: sniffed, see below)
 *   E2E_SEED_DIR        a directory holding an ENROLLED realm trio —
 *                       seed-test.db, seed-identity.json, seed-recovery-key.txt
 *   E2E_REQUIRE_LIVE=1  turn "not configured" from a skip into a failure
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';

/** The binary ships as TWO files and says so when the second is missing:
 *  `lib/better_sqlite3.node` must sit beside the executable. The release
 *  staging dir keeps the addons under their triple names, so a caller who
 *  points only at the binary still gets a working pair. */
export const hostTriple = (): string => {
  const os = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return `${os}-${arch}`;
};

export type LiveConfig = {
  binary: string;
  sidecar: string;
  seedDir: string;
  /** Set when the seed ships one — see `identityPassphrase` below. */
  passphrase?: string;
};

/** ⛔ A SEED'S IDENTITY MAY BE SEALED, AND THE SEAL MAY NOT TRAVEL. Left to
 *  itself the server picks the strongest rung the machine offers — on macOS
 *  `os-keyring` — and a keyfile sealed that way is bound to the keychain of the
 *  machine that minted it: boot elsewhere and it dies with "sealed by
 *  'os-keyring', which cannot produce its secret right now", which reads like a
 *  product defect and is not one. `make-e2e-seed.mjs` therefore seals with a
 *  passphrase and drops it beside the realm. Read it if it is there; a seed
 *  whose identity is cleartext (an older fixture) simply has no such file. */
const identityPassphrase = (seedDir: string): string | undefined => {
  const path = join(seedDir, 'seed-identity-passphrase.txt');
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : undefined;
};

/** Resolve the env contract, or explain precisely what is missing. Returns a
 *  reason string rather than throwing, so a spec can skip with the reason
 *  printed — a skip nobody can read is how a dead gate stays green. */
export const resolveLiveConfig = (): LiveConfig | { unavailable: string } => {
  const binary = process.env.E2E_RECUED_BINARY;
  const seedDir = process.env.E2E_SEED_DIR;
  if (!binary) return { unavailable: 'E2E_RECUED_BINARY is unset (path to the packaged binary under test)' };
  if (!existsSync(binary)) return { unavailable: `E2E_RECUED_BINARY points at nothing: ${binary}` };
  if (!seedDir) return { unavailable: 'E2E_SEED_DIR is unset (a directory holding an enrolled realm trio)' };
  for (const f of ['seed-test.db', 'seed-identity.json', 'seed-recovery-key.txt']) {
    if (!existsSync(join(seedDir, f))) return { unavailable: `E2E_SEED_DIR is missing ${f}: ${seedDir}` };
  }
  const sidecar = process.env.E2E_RECUED_SIDECAR
    ?? join(binary, '..', `better_sqlite3-${hostTriple()}.node`);
  if (!existsSync(sidecar)) {
    return { unavailable: `no native SQLite addon for ${hostTriple()} beside the binary — set E2E_RECUED_SIDECAR (looked at ${sidecar})` };
  }
  return { binary, sidecar, seedDir, passphrase: identityPassphrase(seedDir) };
};

/** How the server under test was launched.
 *
 *  `foreground` is `recued <args>` — what the banner, the docs and both
 *  autostart units use. `daemon` is `recued start`, which the installer prints
 *  as the way to run in the background and which NO published binary could
 *  actually do: the daemon spawned `npx tsx bin.ts`, died, and left `recued
 *  status` reporting "stopped". The two paths reach the same server by
 *  different routes, so a drive that only ever takes one of them proves nothing
 *  about the other. */
export type BootMode = 'foreground' | 'daemon';

export type LiveServer = {
  /** Origin a browser dials, e.g. http://127.0.0.1:7817 */
  url: string;
  port: number;
  /** One-time code from the boot banner. Fresh realm copy per run, so it is unused. */
  pairCode: string;
  /** The realm's 24 words. ⛔ NEVER log, print, or assert on this value. */
  recoveryWords: string[];
  log: () => string;
  stop: () => void;
  /** How this server was launched — for test names and failure messages. */
  mode: BootMode;
  /** The staged realm's database — what every CLI verb must be pointed at. */
  dbPath: string;
  /** Run a CLI verb against this realm (`status`, `stop`, …). Daemon mode only. */
  cli: (args: string[]) => { stdout: string; stderr: string; status: number | null };
};

/** Copy the realm — ⛔ never boot the seed's own db, and never write to it. The
 *  identity file's NAME matters: the server looks for `recued-server-identity.json`
 *  beside the database. The -wal/-shm siblings come too, or the copy silently
 *  loses whatever had not been checkpointed. */
const stageRealm = (seedDir: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'recued-e2e-realm-'));
  copyFileSync(join(seedDir, 'seed-test.db'), join(dir, 'verify.db'));
  for (const suffix of ['-wal', '-shm']) {
    const from = join(seedDir, `seed-test.db${suffix}`);
    if (existsSync(from)) copyFileSync(from, join(dir, `verify.db${suffix}`));
  }
  copyFileSync(join(seedDir, 'seed-identity.json'), join(dir, 'recued-server-identity.json'));
  mkdirSync(join(dir, 'bin', 'lib'), { recursive: true });
  return dir;
};

/** Boot the packaged binary and wait for the banner it prints for a human.
 *  The banner is the contract: `Status: Running` means the realm is ENROLLED,
 *  and the pairing code is printed right under it. */
export const bootLiveServer = async (
  config: LiveConfig,
  { port = 7817, timeoutMs = 60_000, mode = 'foreground' }:
    { port?: number; timeoutMs?: number; mode?: BootMode } = {},
): Promise<LiveServer> => {
  const dir = stageRealm(config.seedDir);
  const exe = join(dir, 'bin', process.platform === 'win32' ? 'recued.exe' : 'recued');
  copyFileSync(config.binary, exe);
  copyFileSync(config.sidecar, join(dir, 'bin', 'lib', 'better_sqlite3.node'));
  if (process.platform !== 'win32') chmodSync(exe, 0o755);

  const dbPath = join(dir, 'verify.db');
  const childEnv = {
    ...process.env,
    ...(config.passphrase ? { RECUED_IDENTITY_PASSPHRASE: config.passphrase } : {}),
  };
  const cli = (args: string[]) => {
    const r = spawnSync(exe, args, { cwd: dir, encoding: 'utf8', timeout: 90_000, env: childEnv });
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
  };

  let out = '';
  let child: ChildProcess | undefined;
  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (mode === 'daemon') {
      // ⛔ ASK THE CLI, DO NOT KILL A PID WE NEVER OWNED. `recued start`
      // detaches; this process is not its parent, so a SIGTERM from here would
      // be aimed at nothing. `stop` is also the verb an owner uses, so failing
      // to shut down cleanly is itself worth finding out about.
      try { cli(['stop', '--db', dbPath]); } catch { /* best effort on teardown */ }
    } else if (child && !child.killed) {
      child.kill('SIGTERM');
    }
    child = undefined;
    // The realm copy holds a pairing credential once a browser has paired.
    rmSync(dir, { recursive: true, force: true });
  };

  // The daemon's banner goes to the log file beside the realm, not to a pipe:
  // `start` returns as soon as the child is spawned and healthy.
  const daemonLog = join(dir, 'recued-server.log');
  const readAll = () => (mode === 'daemon'
    ? (() => { try { return readFileSync(daemonLog, 'utf8'); } catch { return ''; } })()
    : out);

  if (mode === 'daemon') {
    const started = cli(['start', '--db', dbPath, '--port', String(port)]);
    out = `${started.stdout}${started.stderr}`;
    if (started.status !== 0) {
      const log = readAll().trim().slice(-1500);
      stop();
      throw new Error(`\`recued start\` failed (exit ${started.status}):\n${out.trim()}\n`
        + (log ? `daemon log:\n${log}` : '(the daemon wrote no log at all)'));
    }
  } else {
    child = spawn(exe, ['--db', dbPath, '--port', String(port)], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv,
    });
    child.stdout?.on('data', (b) => { out += String(b); });
    child.stderr?.on('data', (b) => { out += String(b); });
  }

  const deadline = Date.now() + timeoutMs;
  let code: string | undefined;
  while (Date.now() < deadline) {
    if (mode === 'foreground' && child?.exitCode !== null && child?.exitCode !== undefined) {
      const why = out;
      stop();
      throw new Error(`the binary exited (${child?.exitCode}) before it listened:\n${why}`);
    }
    const text = readAll();
    const m = /Pairing code:\s*([A-Z0-9-]+)/.exec(text);
    if (m && /Status:\s*Running/.test(text)) { code = m[1]; break; }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!code) {
    const why = readAll().trim() || '(the binary printed nothing at all)';
    stop();
    throw new Error(`the binary never reached "Status: Running" with a pairing code `
      + `(${mode} mode):\n${why}`);
  }

  // ⛔ Read, never echo. A seed minted by `make-e2e-seed.mjs` is sealed under
  // the published all-zero BIP39 test vector and holds nothing — but this
  // harness cannot tell that seed from one an operator pointed at a realm they
  // care about, and the file name is identical either way. Treat every one as
  // the second kind: printing it puts it in CI logs and in Playwright's trace.
  const recoveryWords = readFileSync(join(config.seedDir, 'seed-recovery-key.txt'), 'utf8')
    .trim().split(/\s+/);
  if (recoveryWords.length !== 24) {
    stop();
    throw new Error(`seed-recovery-key.txt holds ${recoveryWords.length} words, expected 24`);
  }

  return {
    url: `http://127.0.0.1:${port}`, port, pairCode: code, recoveryWords,
    log: () => readAll(), stop, mode, cli, dbPath,
  };
};

/** Speak the WebSocket handshake by hand and return the server's FIRST LINE.
 *
 *  ⛔ THE ASSERTION IS "SOMETHING CAME BACK", NOT "101". An unauthenticated
 *  upgrade is *supposed* to be refused — 401 is the correct answer. The defect
 *  this catches is SILENCE: the broken build accepted the TCP connection and
 *  destroyed the socket without writing a byte, so a browser saw a closed
 *  connection with no status to report and every diagnostic blamed the network.
 *  Resolving to '' is the failure. */
export const probeUpgrade = (port: number, timeoutMs = 8_000): Promise<string> =>
  new Promise((resolve) => {
    let seen = '';
    const socket = connect({ host: '127.0.0.1', port }, () => {
      socket.write(
        'GET /ws HTTP/1.1\r\n'
        + `Host: 127.0.0.1:${port}\r\n`
        + 'Connection: Upgrade\r\nUpgrade: websocket\r\n'
        + 'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
      );
    });
    const done = () => { socket.destroy(); resolve(seen.split('\r\n')[0] ?? ''); };
    socket.setTimeout(timeoutMs, done);
    socket.on('data', (b) => { seen += String(b); if (seen.includes('\r\n')) done(); });
    socket.on('error', done);
    socket.on('close', () => resolve(seen.split('\r\n')[0] ?? ''));
  });
