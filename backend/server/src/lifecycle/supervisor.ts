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
 *    4. `/.dockerenv` exists OR `container=docker` env → docker.
 *    5. `RECUED_LAUNCHER=1` env → native.
 *    6. Fallback → dev. */

import { existsSync } from 'node:fs';
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
        'another recued instance already owns this data_path; ' +
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
}

const VALID_MODES: ReadonlySet<string> = new Set([
  'native', 'systemd', 'launchd', 'docker', 'docker-thin', 'dev',
]);

/** Resolve the concrete supervisor mode given the running environment.
 *  The `'auto'` sentinel is allowed as an input and triggers detection;
 *  every other input is treated as an explicit override (validated). */
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
  if (dockerEnvExists() || env.container === 'docker') return 'docker';
  if (env.RECUED_LAUNCHER === '1') return 'native';

  // 4. Fallback — no wrapper detected.
  return 'dev';
};

/** Build the supervisor for a resolved mode. */
export const createSupervisor = (
  mode: ResolvedSupervisorMode,
): Supervisor => SUPERVISORS[mode];
