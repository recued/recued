/** D-182 — proactive cli-tool readiness: is a tool's local binary reachable on
 *  the server's PATH?
 *
 *  Mirrors the run-time `not_found` verdict (a `spawn(shell:false)` `ENOENT` →
 *  `CLI_TOOL_NOT_FOUND`) so a missing binary reads IDENTICALLY before a run (the
 *  Local-tools surface shows "not installed") and during one (the classified run
 *  error). A spawn-FREE check — it never RUNS the tool (no side effects, no
 *  subprocess per panel load), it only resolves the binary the way Node's
 *  `spawn` PATH lookup would: a path-bearing `entry_point` is checked directly, a
 *  bare binary name is walked over `PATH` (× `PATHEXT` on Windows).
 *
 *  This is the §6 `reachable` preflight stage's readiness signal (the `probe`
 *  argv is intentionally NOT run here — the locked binary on PATH is the cheaper,
 *  available signal, and it is exactly what the run-time `not_found` means). */

import { accessSync, constants, statSync } from 'node:fs';
import { delimiter as pathDelimiter, posix, win32 } from 'node:path';

export interface CliBinaryReachabilityOptions {
  /** PATH string to search (default `process.env.PATH`). */
  path?: string;
  /** PATH-entry delimiter (default `path.delimiter` — `:` POSIX / `;` Windows).
   *  Injected by tests so a `;`-delimited Windows PATH can be exercised on a
   *  POSIX runner (where `C:\…` would otherwise split on the host `:`). */
  delimiter?: string;
  /** Platform (default `process.platform`); only `'win32'` changes behaviour. */
  platform?: NodeJS.Platform;
  /** Whether a launch can start this file (default: a regular file, and
   *  executable on POSIX). Injected by tests so the probe is hermetic (no real
   *  filesystem). */
  isExecutable?: (path: string) => boolean;
}

/** A regular file, and on POSIX one this process may execute. A folder named
 *  like the tool is not one: a launch passes over it to the next PATH entry, so
 *  the resolver does too. */
const defaultIsLaunchable = (platform: NodeJS.Platform) => (path: string): boolean => {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform !== 'win32') accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** What Node's `spawn` starts on Windows without a shell: the name as given when
 *  it already ends `.com` or `.exe`, else the name with `.com`, then `.exe`,
 *  appended. A `.cmd` or `.bat` script (npm's shims are both) needs a shell,
 *  which no action is given, so it is never a match, whatever PATHEXT says. */
const WINDOWS_LAUNCHABLE = ['.com', '.exe'] as const;

/** Build a resolver over a `cliToolFromConnectorRuntime` tool key (a bare binary
 *  like `whisper`, or an `entry_point` path): the file a launch would run, or
 *  `undefined` when there is none. D-321's version check keys its cache on that
 *  file, and runs it, so the version it reads is the one an action would run. */
export const createCliBinaryPathResolver = (
  opts: CliBinaryReachabilityOptions = {},
): ((tool: string) => string | undefined) => {
  const platform = opts.platform ?? process.platform;
  const isWin = platform === 'win32';
  const paths = isWin ? win32 : posix;
  const isExecutable = opts.isExecutable ?? defaultIsLaunchable(platform);
  const candidates = (base: string): string[] => {
    if (!isWin) return [base];
    const lower = base.toLowerCase();
    return WINDOWS_LAUNCHABLE.some((ext) => lower.endsWith(ext))
      ? [base]
      : WINDOWS_LAUNCHABLE.map((ext) => base + ext);
  };
  const resolved = (base: string): string | undefined => candidates(base).find(isExecutable);

  return (tool: string): string | undefined => {
    if (tool.length === 0) return undefined;
    // A path-bearing tool (an `entry_point` path) resolves directly — no PATH walk.
    if (tool.includes('/') || tool.includes('\\') || paths.isAbsolute(tool)) {
      return resolved(tool);
    }
    // ⛔ ABSOLUTE PATH ENTRIES ONLY. An empty entry (`PATH=:/usr/bin`) means the
    // working folder, and a relative one is read from it; an action works in a
    // repository's folder, so either would let the repository's own copy of the
    // tool run, and not the one the version check read. The executor launches
    // the file this returns (D-321), so neither is honoured at run time either.
    const dirs = (opts.path ?? process.env.PATH ?? '')
      .split(opts.delimiter ?? pathDelimiter)
      .filter((d) => d.length > 0 && paths.isAbsolute(d));
    for (const dir of dirs) {
      const found = resolved(paths.join(dir, tool));
      if (found !== undefined) return found;
    }
    return undefined;
  };
};

/** Build a reachability probe over a `cliToolFromConnectorRuntime` tool key (a
 *  bare binary like `whisper`, or an `entry_point` path). Returns a sync predicate
 *  — the `cli.reachability.universe` enrichment awaits it (the dep type allows
 *  either), so a future async backing can drop in without a signature change. */
export const createCliBinaryReachabilityProbe = (
  opts: CliBinaryReachabilityOptions = {},
): ((tool: string) => boolean) => {
  const resolve = createCliBinaryPathResolver(opts);
  return (tool: string): boolean => resolve(tool) !== undefined;
};
