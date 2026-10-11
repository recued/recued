/** D-321 — whether a cli pack's tool is ready: on PATH, starts, and is a version
 *  its pack was tested with.
 *
 *  One service, built once at composition and shared by the executor's check
 *  before an action runs and the pack page's readiness read (D-321 slice 3). In
 *  v1 it probes only a tool whose pack declares a tested range (R5); every other
 *  tool keeps the PATH check (`cli-binary-reachability.ts`).
 *
 *  The probe is the pack's own (`cli_probe`), and the catalog validator holds it
 *  to `[binary, one version flag]` (`CLI_VERSION_PROBE_FLAGS`), because it runs
 *  here, outside the owner's grants on the pack's actions. This service runs no
 *  other shape (`isVersionOnlyProbe`), whatever a stored catalog carries. It runs:
 *    - as argv, never through a shell, with stdin closed;
 *    - with the environment an action gets (`envForOthers`: the server's own,
 *      minus what is the server's alone);
 *    - in a fresh, empty folder of its own under the OS temp folder, removed
 *      afterwards, so a tool that writes where it starts writes nowhere that
 *      matters (`codex --version` writes a lock file, under its home). ⛔ Never
 *      the shared temp folder itself: any local user can write to `/tmp`, and
 *      `node version` or `bun version` runs a file named `version` (or a
 *      `package.json` script) from the folder it starts in. The exception is an
 *      action's check of a version manager's shim, which starts the version the
 *      folder names: it runs where the action will (`isVersionManagerShim`);
 *    - for at most 10 seconds, with each stream's output capped at 64 KiB. The
 *      answer never waits past that, nor past a short grace once the tool exits,
 *      whatever still holds its output (a child that left its process group);
 *    - as the file the PATH walk found, so the version read is the version an
 *      action would run.
 *
 *  A version read is cached per probe, keyed on that file (its path, its real
 *  path, device, inode, size and mtime) and on the PATH, so an upgrade or a PATH
 *  change reads again. It also expires after an hour, because a version
 *  manager's shim (asdf, pyenv) keeps its path and bytes across upgrades, and
 *  `forget` drops it ("Check again"). A shim read in an action's folder is not
 *  cached at all.
 *
 *  ⚠ A FAILED READ IS NOT CACHED (`broken`, `unreadable`). An owner who repairs
 *  the tool (reinstalls the library ffmpeg lost, which leaves ffmpeg's own file
 *  unchanged) and retries must not be refused by the old answer for an hour.
 *  Re-probing costs one short process per run of a tool that is failing anyway.
 */

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import {
  CLI_VERSION_PROBE_FLAGS,
  isToolVersionTested,
  readToolVersion,
  type CliToolState,
  type CliToolVersionPolicy,
} from '@recued/contracts';
import { createCliBinaryPathResolver } from './cli-binary-reachability.js';
import { envForOthers } from './supervision/env-for-others.js';
import {
  killProcessGroup,
  reapProcessGroupAfterLeaderExit,
} from './supervision/process-group-kill.js';

export const CLI_TOOL_PROBE_TIMEOUT_MS = 10_000;
export const CLI_TOOL_PROBE_OUTPUT_CAP_BYTES = 64 * 1024;
/** How long the probe waits, once the tool has exited, for the rest of its
 *  output before answering from what it read. */
export const CLI_TOOL_PROBE_EXIT_GRACE_MS = 250;
export const CLI_TOOL_VERSION_TTL_MS = 60 * 60 * 1000;
/** The longest a diagnostic line carried into a message gets. */
const DIAGNOSTIC_LINE_MAX = 200;

/** A tool's state (D-321 § 3.3), as contracts defines it for the readiness
 *  read too. */
export type { CliToolState } from '@recued/contracts';

/** What one run of the probe showed. `line` is the first line the tool printed
 *  that is not blank, stderr first, cut to 200 characters. `not_run` is a probe
 *  that was never started because it asks for more than the version (see
 *  `isVersionOnlyProbe`); its tool's version is unreadable. */
export type CliToolProbeResult =
  | { kind: 'version'; version: string }
  | { kind: 'unreadable'; exit_code: number; line?: string }
  | { kind: 'not_run' }
  | { kind: 'broken'; cause: 'start'; error: string }
  | { kind: 'broken'; cause: 'signal'; signal: string; line?: string }
  | { kind: 'broken'; cause: 'timeout'; timeout_ms: number; line?: string };

/** ⛔ THE ONLY PROBE THIS SERVICE RUNS: `[binary, one version flag]`.
 *
 *  The catalog validator already refuses any other probe beside a range
 *  (`cliProbeProblems`). This is the run-time half, as the executor re-checks a
 *  binding's pinned environment: a catalog stored by an older server was never
 *  checked for a probe (its validator let runtime keys through), and the probe
 *  runs outside the owner's grants, so the server must not run whatever argv a
 *  stored catalog carries. */
export const isVersionOnlyProbe = (probe: readonly unknown[]): boolean =>
  probe.length === 2
  && typeof probe[0] === 'string'
  && probe[0].length > 0
  && (CLI_VERSION_PROBE_FLAGS as readonly unknown[]).includes(probe[1]);

/** Why a tool whose probe did not end in a version is broken, in the words the
 *  refusal and the pack's page both use: the line the tool printed when a
 *  signal stopped it (ffmpeg's `dyld: Library not loaded: …`), else the cause. */
export const brokenProbeDetail = (
  probe: readonly string[],
  result: Extract<CliToolProbeResult, { kind: 'broken' }>,
): string => {
  const ran = `'${probe.join(' ')}'`;
  if (result.cause === 'start') return `${ran} could not be started (${result.error}).`;
  if (result.cause === 'signal') return result.line ?? `${ran} was stopped by ${result.signal}.`;
  const seconds = Math.max(1, Math.round(result.timeout_ms / 1000));
  return `${ran} did not finish within ${seconds} second${seconds === 1 ? '' : 's'}.`;
};

/** Why a tool's version could not be read, without the closing period, which
 *  each sentence that uses it adds. */
export const unreadableProbeDetail = (
  binary: string,
  probe: readonly string[],
  result: Extract<CliToolProbeResult, { kind: 'unreadable' | 'not_run' }>,
): string => {
  const ran = `'${probe.join(' ')}'`;
  if (result.kind === 'not_run') {
    return `its pack's version check ${ran} is not one Recued runs, because it may only ask ${binary} for its version`;
  }
  return result.exit_code !== 0
    ? `${ran} exited with code ${result.exit_code}${result.line !== undefined ? ` (${result.line})` : ''}`
    : `${ran} printed no version number`;
};

export interface CliToolStatusReport {
  state: CliToolState;
  /** The launched binary, `probe[0]`. */
  binary: string;
  /** The file the PATH walk found. Absent when `missing`. */
  path?: string;
  /** What the probe showed. Absent when `missing`. */
  probe_result?: CliToolProbeResult;
  /** When `probe_result` was read: a cached read keeps its time. */
  checked_at?: number;
  /** The folder the version was read in, when it was the action's own: the tool
   *  is a version manager's shim, which picks the version by folder. */
  folder?: string;
}

export interface CliToolStatusCheck {
  /** The pack's probe: `[binary, version flag]`. */
  probe: readonly string[];
  tested: CliToolVersionPolicy['tested'];
  /** Where the action will start, and with what environment. Read only when the
   *  tool is a version manager's shim (`isVersionManagerShim`); absent for a
   *  check no action is waiting on (the pack page). */
  where?: { cwd: string; env: NodeJS.ProcessEnv };
}

export interface CliToolStatus {
  check(target: CliToolStatusCheck): Promise<CliToolStatusReport>;
  /** Drop every cached read of `binary`, so the next check probes again. */
  forget(binary: string): void;
}

export interface CliToolStatusOptions {
  spawn?: typeof nodeSpawn;
  now?: () => number;
  /** The probe's environment, whose PATH is also the one walked. Default:
   *  `envForOthers()`, the environment an action gets. */
  env?: () => NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** The folder the probe starts in. Default: a fresh private folder under the
   *  OS temp folder, made for each probe and removed after it. */
  cwd?: string;
  timeoutMs?: number;
  ttlMs?: number;
}

interface CachedRead {
  binary: string;
  identity: string;
  result: Extract<CliToolProbeResult, { kind: 'version' }>;
  checked_at: number;
  expires_at: number;
}

interface CappedStream {
  chunks: Buffer[];
  bytes: number;
}

const appendCapped = (stream: CappedStream, chunk: Buffer): void => {
  // Keep reading past the cap, and keep nothing: a tool blocked on a full pipe
  // would otherwise hang until the timeout and read as broken.
  const room = CLI_TOOL_PROBE_OUTPUT_CAP_BYTES - stream.bytes;
  if (room <= 0) return;
  const kept = chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
  stream.chunks.push(kept);
  stream.bytes += kept.byteLength;
};

const firstLine = (text: string): string | undefined => {
  const line = text.split(/\r?\n/u).map((l) => l.trim()).find((l) => l.length > 0);
  if (line === undefined) return undefined;
  return line.length > DIAGNOSTIC_LINE_MAX ? `${line.slice(0, DIAGNOSTIC_LINE_MAX)}…` : line;
};

/** A variable from `env`, whose names are case-insensitive on Windows. */
const envValue = (env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined => {
  if (platform !== 'win32') return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
};

const errorCode = (err: unknown): string => {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (typeof code === 'string' && code.length > 0) return code;
  return err instanceof Error ? err.message : String(err);
};

/** The state a probe result puts a tool in, against one tested range. */
export const cliToolStateOf = (
  result: CliToolProbeResult,
  tested: CliToolVersionPolicy['tested'],
): Exclude<CliToolState, 'missing'> => {
  if (result.kind === 'version') return isToolVersionTested(result.version, tested) ? 'ready' : 'untested';
  return result.kind === 'not_run' ? 'unreadable' : result.kind;
};

/** Whether `path` is a version manager's shim: one file per tool on PATH that
 *  starts the version named by the folder it starts in. asdf, mise, proto,
 *  pyenv, rbenv, nodenv and their kin keep them in a folder named `shims`;
 *  Volta's are links to its `volta-shim`. A heuristic, kept narrow: a miss
 *  leaves the probe in its private folder, as for any other tool. */
export const isVersionManagerShim = (path: string, platform: NodeJS.Platform = process.platform): boolean => {
  const paths = platform === 'win32' ? win32 : posix;
  if (paths.basename(paths.dirname(path)).toLowerCase() === 'shims') return true;
  try {
    return /^volta-shim(?:\.exe)?$/iu.test(paths.basename(realpathSync(path)));
  } catch {
    return false;
  }
};

export const createCliToolStatus = (options: CliToolStatusOptions = {}): CliToolStatus => {
  const spawn = options.spawn ?? nodeSpawn;
  const now = options.now ?? (() => Date.now());
  const envOf = options.env ?? (() => envForOthers());
  const platform = options.platform ?? process.platform;
  const fixedCwd = options.cwd;
  const timeoutMs = options.timeoutMs ?? CLI_TOOL_PROBE_TIMEOUT_MS;
  const ttlMs = options.ttlMs ?? CLI_TOOL_VERSION_TTL_MS;
  // The process-group kill and reap reach real pids only, so a synthetic spawn
  // (a test's) gets the child's own kill instead.
  const realProcesses = options.spawn === undefined;

  const cache = new Map<string, CachedRead>();
  const inFlight = new Map<string, Promise<CliToolProbeResult>>();

  const runProbe = (
    path: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
    actionCwd?: string,
  ): Promise<CliToolProbeResult> => new Promise((settle) => {
    const stdout: CappedStream = { chunks: [], bytes: 0 };
    const stderr: CappedStream = { chunks: [], bytes: 0 };
    let cwd = actionCwd ?? fixedCwd;
    let ownCwd: string | undefined;
    let child: ChildProcess;
    try {
      if (cwd === undefined) {
        ownCwd = mkdtempSync(join(tmpdir(), 'recued-probe-'));
        cwd = ownCwd;
      }
      child = spawn(path, [...args], {
        shell: false,
        // The probe leads its own process group, so a timeout stops anything
        // it started too.
        detached: true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd,
        env: { ...env, PWD: cwd },
      });
    } catch (err) {
      if (ownCwd !== undefined) rmSync(ownCwd, { recursive: true, force: true });
      settle({ kind: 'broken', cause: 'start', error: errorCode(err) });
      return;
    }
    let settled = false;
    let timedOut = false;
    let exited = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const resultOf = (code: number | null, signal: NodeJS.Signals | null): CliToolProbeResult => {
      const out = Buffer.concat(stdout.chunks).toString('utf8');
      const err = Buffer.concat(stderr.chunks).toString('utf8');
      const line = firstLine(err) ?? firstLine(out);
      const withLine = line === undefined ? {} : { line };
      if (timedOut) return { kind: 'broken', cause: 'timeout', timeout_ms: timeoutMs, ...withLine };
      if (signal !== null) return { kind: 'broken', cause: 'signal', signal, ...withLine };
      if (code !== 0) return { kind: 'unreadable', exit_code: code ?? -1, ...withLine };
      const version = readToolVersion(out, err);
      return version === undefined
        ? { kind: 'unreadable', exit_code: 0, ...withLine }
        : { kind: 'version', version };
    };
    // ⛔ THE ANSWER NEVER WAITS FOR THE OUTPUT TO CLOSE. A process the tool
    // started that left its process group (`setsid`, as a daemon does) inherits
    // the output and holds it open for as long as it lives, out of reach of the
    // group kill: waiting for `close` made a 10-second limit take as long as that
    // process did, and every run of the tool joined the wait (measured). So the
    // probe answers at its limit, or a moment after the tool exits, from what it
    // has read, and lets go of the output.
    const finish = (result: CliToolProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (grace !== undefined) clearTimeout(grace);
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (ownCwd !== undefined) {
        try { rmSync(ownCwd, { recursive: true, force: true }); } catch { /* best effort */ }
      }
      settle(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (realProcesses && child.pid !== undefined) {
        // Once the leader is gone its pid may be reused: reach the group only.
        if (exited) reapProcessGroupAfterLeaderExit(child.pid, 'SIGKILL', platform);
        else killProcessGroup(child.pid, 'SIGKILL', platform);
      } else {
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
      }
      finish(resultOf(null, null));
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => appendCapped(stdout, chunk));
    child.stderr?.on('data', (chunk: Buffer) => appendCapped(stderr, chunk));
    child.on('error', (err) => finish({ kind: 'broken', cause: 'start', error: errorCode(err) }));
    // ⛔ REAP WHEN THE TOOL EXITS, NOT WHEN ITS OUTPUT CLOSES. A process the probe
    // left running in the background inherits its stdout, so the output does not
    // close while it lives: waiting for `close` read a tool that printed its
    // version and exited as broken, ten seconds later (measured). A version probe
    // has no business leaving a process behind, so its group is stopped here; and
    // in case something outside the group holds the output, the answer comes from
    // the exit after a short grace for the last of it.
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      exited = true;
      if (realProcesses && child.pid !== undefined) {
        reapProcessGroupAfterLeaderExit(child.pid, 'SIGKILL', platform);
      }
      grace = setTimeout(() => finish(resultOf(code, signal)), CLI_TOOL_PROBE_EXIT_GRACE_MS);
    });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      finish(resultOf(code, signal));
    });
  });

  return {
    async check({ probe, tested, where }) {
      const binary = probe[0] ?? '';
      if (!isVersionOnlyProbe(probe)) {
        return { state: 'unreadable', binary, probe_result: { kind: 'not_run' } };
      }
      const env = envOf();
      const PATH = envValue(env, 'PATH', platform) ?? '';
      // The file an action would start (the executor launches what this same
      // resolver finds), so the version read is the version an action runs.
      const path = createCliBinaryPathResolver({ path: PATH, platform })(binary);
      if (path === undefined) return { state: 'missing', binary };
      let identity: string;
      try {
        const stat = statSync(path);
        identity = JSON.stringify([
          path, realpathSync(path), stat.dev, stat.ino, stat.size, stat.mtimeMs, PATH,
        ]);
      } catch {
        // Gone between the walk and the stat: what a launch would find now.
        return { state: 'missing', binary };
      }
      // ⛔ A VERSION MANAGER'S SHIM STARTS WHAT THE FOLDER PICKS (`.tool-versions`,
      // `mise.toml`, a `package.json`), so a read in the private folder is the
      // manager's global version, not the one an action runs in a repository
      // that pins another. For an action, a shim is read where the action starts,
      // with its environment, and never cached: the folder's files decide, and
      // they change while the shim does not. The action runs whatever the shim
      // picks there anyway, so this runs nothing it would not. A bare `version`
      // stays in the private folder: it makes `node` or `bun` run a file from
      // the folder, which the action itself may never do.
      if (where !== undefined && isVersionManagerShim(path, platform)
        && (probe[1] ?? '').startsWith('-')) {
        const result = await runProbe(path, probe.slice(1), where.env, where.cwd);
        return {
          state: cliToolStateOf(result, tested),
          binary,
          path,
          probe_result: result,
          checked_at: now(),
          folder: where.cwd,
        };
      }
      const key = JSON.stringify(probe);
      const cached = cache.get(key);
      if (cached !== undefined && cached.identity === identity && now() < cached.expires_at) {
        return {
          state: cliToolStateOf(cached.result, tested),
          binary,
          path,
          probe_result: cached.result,
          checked_at: cached.checked_at,
        };
      }
      // One probe at a time per file: runs that start together share it.
      const flightKey = `${key}\u0000${identity}`;
      let flight = inFlight.get(flightKey);
      if (flight === undefined) {
        flight = runProbe(path, probe.slice(1), env).finally(() => inFlight.delete(flightKey));
        inFlight.set(flightKey, flight);
      }
      const result = await flight;
      const checked_at = now();
      if (result.kind === 'version') {
        cache.set(key, { binary, identity, result, checked_at, expires_at: checked_at + ttlMs });
      } else {
        cache.delete(key);
      }
      return { state: cliToolStateOf(result, tested), binary, path, probe_result: result, checked_at };
    },
    forget(binary) {
      for (const [key, entry] of cache) {
        if (entry.binary === binary) cache.delete(key);
      }
    },
  };
};
