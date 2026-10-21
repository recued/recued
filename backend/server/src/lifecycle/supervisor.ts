/** Supervisor abstraction + mode-specific implementations (Phase C).
 *
 *  The daemon hands off to its supervisor by exiting with a
 *  mode-specific code. The supervisor (systemd / launchd / docker
 *  restart policy / native launcher shell script / `daemon.ts` CLI
 *  wrapper) interprets the code and respawns us as appropriate.
 *
 *  Exit-code contract:
 *    0 — clean shutdown; supervisor should NOT respawn.
 *    1 — crash (unhandled exception); supervisor SHOULD respawn.
 *    3 — explicit restart; supervisor SHOULD respawn.
 *    4 — fatal lock-held; supervisor should STOP RETRYING.
 *
 *  Per-mode remaps:
 *    docker  — `restart` remaps to 1 so container `restart: unless-stopped`
 *              picks it up (container policy ignores exit-code semantics).
 *    dev     — all codes collapse to 0; no wrapper would respawn us, and
 *              emitting non-zero in development just masks real errors
 *              under a confusing "process failed" banner. `requestRestart`
 *              logs a warning so the developer sees why the server is gone.
 *
 *  Mode detection at boot — precedence:
 *    1. `RECUED_SUPERVISOR_MODE` env var (explicit override).
 *    2. `INVOCATION_ID` → systemd (journald sets this).
 *    3. `XPC_SERVICE_NAME` matches com.recued.* → launchd.
 *    4. On macOS, a child of this install's `recued-supervise` → launchd.
 *    5. `/.dockerenv` exists OR `container=docker` env → docker.
 *    6. `RECUED_LAUNCHER=1` env → native (a launcher loop: the launcher script,
 *       and on Windows the `recued supervise` that `recued start` runs).
 *    7. Fallback → dev. */

import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  ResolvedSupervisorMode,
  SupervisorMode,
} from '@recued/contracts';

/** Intent hand-off from the lifecycle orchestrator. */
export type SupervisorIntent = 'restart' | 'shutdown' | 'crash' | 'lock_held';

export interface Supervisor {
  readonly mode: ResolvedSupervisorMode;
  /** Exit code that carries this intent to the supervisor. Per-mode
   *  remaps apply (see file docstring). */
  handoff(intent: SupervisorIntent): number;
  /** Invoked alongside `handoff('restart')` in `dev` mode to log the
   *  one-liner warning so developers see why the server is gone.
   *  Other modes return undefined — no user-visible message needed. */
  guidanceFor?: (intent: SupervisorIntent) => string | undefined;
}

// ────────────────────────────────────────────────────────────────
// Per-mode implementations
// ────────────────────────────────────────────────────────────────

/** Standard exit codes for the three modes that use them verbatim. */
const standardHandoff = (intent: SupervisorIntent): number => {
  switch (intent) {
    case 'shutdown': return 0;
    case 'crash':    return 1;
    case 'restart':  return 3;
    case 'lock_held': return 4;
  }
};

export const nativeSupervisor: Supervisor = {
  mode: 'native',
  handoff: standardHandoff,
};

export const systemdSupervisor: Supervisor = {
  mode: 'systemd',
  handoff: standardHandoff,
};

export const launchdSupervisor: Supervisor = {
  mode: 'launchd',
  handoff: standardHandoff,
};

/** Docker remaps `restart` to 1 because container restart policies
 *  respawn on non-zero regardless of which non-zero it is — we can't
 *  rely on `RestartForceExitStatus=3` semantics. `lock_held` stays 4
 *  because the entrypoint script is expected to intercept it
 *  (documented in Dockerfile.example). */
export const dockerSupervisor: Supervisor = {
  mode: 'docker',
  handoff(intent) {
    if (intent === 'restart') return 1;
    return standardHandoff(intent);
  },
};

/** D-178 `docker-thin` (the `:managed` self-updating image): the baked
 *  launcher is the supervisor, so exit codes are STANDARD — `restart` stays
 *  `3` (the launcher loop re-execs the current binary) rather than the plain-
 *  `docker` `3→1` remap. The launcher distinguishes restart-intent (3) from a
 *  crash (1, counts toward boot-failure auto-revert) from a clean shutdown (0)
 *  from lock-held (4). */
export const dockerThinSupervisor: Supervisor = {
  mode: 'docker-thin',
  handoff: standardHandoff,
};

/** Dev mode collapses every intent to 0 — no wrapper; developer
 *  re-runs manually. `guidanceFor('restart')` surfaces a line to
 *  stderr so they understand why the process exited. */
export const devSupervisor: Supervisor = {
  mode: 'dev',
  handoff: () => 0,
  guidanceFor(intent) {
    if (intent === 'restart') {
      return (
        'restart requested in dev mode — no supervisor will respawn; ' +
        're-run the daemon manually to continue.'
      );
    }
    if (intent === 'lock_held') {
      return (
        'another recued instance already owns this data folder; ' +
        'stop the other instance or pick a different --db path.'
      );
    }
    return undefined;
  },
};

const SUPERVISORS: Readonly<Record<ResolvedSupervisorMode, Supervisor>> = {
  native: nativeSupervisor,
  systemd: systemdSupervisor,
  launchd: launchdSupervisor,
  docker: dockerSupervisor,
  'docker-thin': dockerThinSupervisor,
  dev: devSupervisor,
};

// ────────────────────────────────────────────────────────────────
// Auto-detection
// ────────────────────────────────────────────────────────────────

export interface DetectSupervisorDeps {
  env?: NodeJS.ProcessEnv;
  /** Defaults to `existsSync('/.dockerenv')`. Injected for tests. */
  dockerEnvExists?: () => boolean;
  /** Defaults to `process.platform`. Injected for tests. */
  platform?: NodeJS.Platform;
  /** Defaults to `childOfInstallSupervisor()`. Injected for tests. */
  childOfInstallSupervisor?: () => boolean;
}

export interface InstallSupervisorProbe {
  /** Defaults to `process.execPath`: the installed `recued`. */
  execPath?: string;
  /** Defaults to `process.ppid`. */
  parentPid?: number;
  /** The parent's command line, or null when it cannot be read. */
  readCommand?: (pid: number) => string | null;
  realpath?: (path: string) => string;
}

const SUPERVISE_SCRIPT = 'recued-supervise';

const commandLineOf = (pid: number): string | null => {
  const probe = spawnSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], {
    encoding: 'utf8',
    timeout: 2_000,
  });
  if (probe.status !== 0 || probe.error) return null;
  return probe.stdout.trim() || null;
};

/** Is this process the payload of its own install's `recued-supervise`? That
 *  script lives beside the binary (`$BIN_DIR/recued-supervise` runs
 *  `$BIN_DIR/recued`) and respawns it on exit 3 whatever started the script.
 *  Its command line is `/bin/sh <script> serve …`, since `/bin/sh` runs it. */
export const childOfInstallSupervisor = (probe: InstallSupervisorProbe = {}): boolean => {
  const realpath = probe.realpath ?? realpathSync;
  const command = (probe.readCommand ?? commandLineOf)(probe.parentPid ?? process.ppid);
  if (command === null) return false;
  // The script's own name ends an argument; a folder may merely start with it.
  const found = new RegExp(`/${SUPERVISE_SCRIPT}(?= |$)`).exec(command);
  if (found === null) return false;
  const end = found.index + found[0].length;
  // The script's path starts after the interpreter's (` /…`).
  const start = command.lastIndexOf(' /', found.index);
  const script = command.slice(start + 1, end);
  try {
    return realpath(dirname(script))
      === realpath(dirname(probe.execPath ?? process.execPath));
  } catch {
    return false;
  }
};

const VALID_MODES: ReadonlySet<string> = new Set([
  'native', 'systemd', 'launchd', 'docker', 'docker-thin', 'dev',
]);

/** Resolve the concrete supervisor mode given the running environment.
 *  The `'auto'` sentinel is allowed as an input and triggers detection;
 *  every other input is treated as an explicit override (validated). */
/** Is this process inside a container? Our images say so
 *  (`RECUED_SUPERVISOR_MODE`), and any container says so to whoever looks:
 *  Docker's `/.dockerenv`, Podman's `/run/.containerenv`, or the `container`
 *  variable that systemd-nspawn and Podman set.
 *
 *  Not `resolveSupervisorMode`: an operator may supervise a containerised
 *  server some other way, and this answers a property of the machine. Inside a
 *  container there is no platform secret store to seal the key file with
 *  (`keys/file-store.ts`). Not the update channel either: tests set
 *  `RECUED_DISTRIBUTION_CHANNEL=docker-thin` on the host, to give a boot its own
 *  update lease. */
export const runningInContainer = (
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): boolean =>
  env.RECUED_SUPERVISOR_MODE === 'docker'
  || env.RECUED_SUPERVISOR_MODE === 'docker-thin'
  || (env.container !== undefined && env.container !== '')
  || exists('/.dockerenv')
  || exists('/run/.containerenv');

export const resolveSupervisorMode = (
  configured: SupervisorMode,
  deps: DetectSupervisorDeps = {},
): ResolvedSupervisorMode => {
  const env = deps.env ?? process.env;
  const dockerEnvExists = deps.dockerEnvExists ?? (() => existsSync('/.dockerenv'));

  // 1. Explicit override via env var (highest precedence — a human
  //    told us exactly what to do).
  const envOverride = env.RECUED_SUPERVISOR_MODE;
  if (envOverride && VALID_MODES.has(envOverride)) {
    return envOverride as ResolvedSupervisorMode;
  }

  // 2. Explicit config (non-auto) — respect the operator's choice.
  if (configured !== 'auto' && VALID_MODES.has(configured)) {
    return configured as ResolvedSupervisorMode;
  }

  // 3. Environment signatures.
  if (env.INVOCATION_ID) return 'systemd';
  if (env.XPC_SERVICE_NAME && env.XPC_SERVICE_NAME.startsWith('com.recued.')) {
    return 'launchd';
  }
  // ⛔⛔ THE LINE ABOVE MATCHES NO INSTALL ON CURRENT macOS. launchd gives every
  // LaunchAgent `XPC_SERVICE_NAME=0` (probed 2026-10-20 under `launchctl load` and
  // `bootstrap` alike), so every macOS autostart install resolved `dev`: the
  // webclient's update was refused as "not supervised" and Restart was hidden.
  // The LaunchAgent runs `recued-supervise`, which respawns this binary on exit 3,
  // so being that script's child is the signal. Not on Linux, where the same
  // script runs under systemd and `INVOCATION_ID` already says so.
  if ((deps.platform ?? process.platform) === 'darwin'
    && (deps.childOfInstallSupervisor ?? childOfInstallSupervisor)()) {
    return 'launchd';
  }
  if (dockerEnvExists() || env.container === 'docker') return 'docker';
  if (env.RECUED_LAUNCHER === '1') return 'native';

  // 4. Fallback — no wrapper detected.
  return 'dev';
};

/** Build the supervisor for a resolved mode. */
export const createSupervisor = (
  mode: ResolvedSupervisorMode,
): Supervisor => SUPERVISORS[mode];
