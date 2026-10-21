/** The outer supervisor `recued start` runs on Windows — `recued supervise` (D-178).
 *
 *  Windows has no service manager a user-scope install can use: the Startup
 *  shortcut runs `recued start`, which used to launch the bare server, so a
 *  restart left it down and Settings refused every update there. `start` now
 *  launches this loop instead, and the loop does what `recued-supervise` does on
 *  macOS and Linux: it runs the payload, starts it again when it asks to (exit
 *  3), and when it fails it asks the PREVIOUS binary what to do.
 *
 *  ⛔ IT RUNS FROM ITS OWN COPY OF THE BINARY, `recued-supervise.exe`, NEVER FROM
 *  `recued.exe`. An update renames the running `recued.exe` aside, which Windows
 *  allows, but a later update deletes that aside, which Windows refuses while any
 *  process still runs from it: a supervisor running from `recued.exe` would make
 *  the third update of a session fail. The same holds for the SQLite addon in
 *  `lib\`, so the `supervise` command loads nothing but Node's own modules.
 *
 *  ⚠ IT CARRIES NO POLICY, like the shell script: no threshold, no counter, no
 *  revert. Those belong to `report-boot-failure`, run from `recued.exe.old`. The
 *  codes below mirror TypeScript constants this file must not import (that would
 *  load the update graph, and with it the addon); `supervisor-contract.test.ts`
 *  holds them equal. */

export const SUPERVISE_EXIT_CLEAN = 0;
export const SUPERVISE_EXIT_RESTART = 3;
export const SUPERVISE_EXIT_LOCK_HELD = 4;
export const SUPERVISE_VERDICT_RETRY_NOW = 0;
export const SUPERVISE_VERDICT_RETRY_AFTER_BACKOFF = 10;

/** The payload starts at most this many times in a row without one run lasting
 *  `steadyRunMs`. The shell script caps every start, restarts included, and is
 *  started again by its unit when it halts; nothing restarts this loop, so a
 *  server that restarts for an update once a day must not use the cap up. */
export const SUPERVISE_MAX_RAPID_STARTS = 50;
export const SUPERVISE_STEADY_RUN_MS = 60_000;
export const SUPERVISE_BACKOFF_MS = 5_000;

/** The supervisor's own copy of the binary, beside `recued.exe` (see above for why a copy). */
export const SUPERVISOR_COPY_NAME = 'recued-supervise.exe';

/** Beside the database. `recued stop` leaves it before it ends the server, so the
 *  supervisor reads that end as a stop. */
export const SUPERVISE_STOP_FILE = 'recued-server.stop';

/** The live binary's name in its install directory: `install.ps1` lays it down as
 *  `recued.exe`, and the previous one is that name plus `.old`. */
export const liveBinaryName = (platform: NodeJS.Platform): string =>
  (platform === 'win32' ? 'recued.exe' : 'recued');

export interface OuterSupervisorDeps {
  /** Runs the payload once and resolves with its exit status. */
  runPayload: () => Promise<number>;
  /** Whether there is a previous binary to ask. */
  previousExists: () => boolean;
  /** Runs `report-boot-failure` from the previous binary and resolves with its exit status. */
  askPrevious: (exitCode: number) => Promise<number>;
  /** True once `recued stop` has asked, consuming the request. */
  stopRequested: () => boolean;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (line: string) => void;
}

export interface OuterSupervisorOptions {
  backoffMs?: number;
  maxRapidStarts?: number;
  steadyRunMs?: number;
}

/** Runs the payload until it stops for good; resolves with the supervisor's own exit status. */
export const runOuterSupervisor = async (
  deps: OuterSupervisorDeps,
  options: OuterSupervisorOptions = {},
): Promise<number> => {
  const backoffMs = options.backoffMs ?? SUPERVISE_BACKOFF_MS;
  const maxRapidStarts = options.maxRapidStarts ?? SUPERVISE_MAX_RAPID_STARTS;
  const steadyRunMs = options.steadyRunMs ?? SUPERVISE_STEADY_RUN_MS;
  let rapidStarts = 0;
  for (;;) {
    const startedAt = deps.now();
    const code = await deps.runPayload();

    // ⛔ ASKED BEFORE THE EXIT STATUS IS READ. `recued stop` ends the payload hard
    // on Windows, so its status is a crash's. Read as one, it would count a boot
    // failure and start the server again after the backoff.
    if (deps.stopRequested()) return SUPERVISE_EXIT_CLEAN;
    if (code === SUPERVISE_EXIT_CLEAN) return SUPERVISE_EXIT_CLEAN;
    if (code === SUPERVISE_EXIT_LOCK_HELD) {
      deps.log('another instance owns this realm — halting');
      return SUPERVISE_EXIT_CLEAN;
    }

    rapidStarts = deps.now() - startedAt >= steadyRunMs ? 1 : rapidStarts + 1;
    if (rapidStarts >= maxRapidStarts) {
      deps.log(`the server stopped ${rapidStarts} times in a row, each within ${steadyRunMs / 1000} s of starting — halting`);
      return code === SUPERVISE_EXIT_RESTART ? 1 : code;
    }
    if (code === SUPERVISE_EXIT_RESTART) continue;

    // Anything else is a failed run, including "cannot execute" — precisely the
    // case the server's own counter can never see.
    if (!deps.previousExists()) {
      deps.log(`the server exited ${code} and there is no previous version to ask — halting`);
      return code;
    }
    const verdict = await deps.askPrevious(code);
    if (verdict === SUPERVISE_VERDICT_RETRY_NOW) continue;
    if (verdict === SUPERVISE_VERDICT_RETRY_AFTER_BACKOFF) {
      await deps.sleep(backoffMs);
      continue;
    }
    return code;
  }
};
