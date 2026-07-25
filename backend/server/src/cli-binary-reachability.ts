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

import { accessSync, constants } from 'node:fs';
import { delimiter as pathDelimiter, isAbsolute, join } from 'node:path';

export interface CliBinaryReachabilityOptions {
  /** PATH string to search (default `process.env.PATH`). */
  path?: string;
  /** PATH-entry delimiter (default `path.delimiter` — `:` POSIX / `;` Windows).
   *  Injected by tests so a `;`-delimited Windows PATH can be exercised on a
   *  POSIX runner (where `C:\…` would otherwise split on the host `:`). */
  delimiter?: string;
  /** Windows PATHEXT extensions to try (default `process.env.PATHEXT`). */
  pathext?: string;
  /** Platform (default `process.platform`); only `'win32'` changes behaviour. */
  platform?: NodeJS.Platform;
  /** Executable/existence check (default `fs.accessSync(p, X_OK)` → boolean).
   *  Injected by tests so the probe is hermetic (no real filesystem). */
  isExecutable?: (path: string) => boolean;
}

const defaultIsExecutable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** Build a reachability probe over a `cliToolFromConnectorRuntime` tool key (a
 *  bare binary like `whisper`, or an `entry_point` path). Returns a sync predicate
 *  — the `cli.reachability.universe` enrichment awaits it (the dep type allows
 *  either), so a future async backing can drop in without a signature change. */
export const createCliBinaryReachabilityProbe = (
  opts: CliBinaryReachabilityOptions = {},
): ((tool: string) => boolean) => {
  const isExecutable = opts.isExecutable ?? defaultIsExecutable;
  const isWin = (opts.platform ?? process.platform) === 'win32';
  const exts = isWin
    ? (opts.pathext ?? process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : [];
  // A path/name resolves if it exists as-is OR, on Windows, with a PATHEXT suffix.
  const resolves = (base: string): boolean =>
    isExecutable(base) || exts.some((ext) => isExecutable(base + ext));

  return (tool: string): boolean => {
    if (tool.length === 0) return false;
    // A path-bearing tool (an `entry_point` path) resolves directly — no PATH walk.
    if (tool.includes('/') || tool.includes('\\') || isAbsolute(tool)) {
      return resolves(tool);
    }
    // Drop empty PATH segments. POSIX treats an empty segment (`PATH=:/usr/bin`)
    // as the CWD — but resolving a cli tool from the server's transient working
    // directory is a footgun (and not a real "install"), so we DELIBERATELY don't
    // honour it: a binary reachable only via CWD reads "not installed" here. The
    // divergence is conservative — Node `spawn` may still find a CWD binary at run
    // time, but relying on CWD-in-PATH is unsafe, so the badge stays cautious.
    const dirs = (opts.path ?? process.env.PATH ?? '')
      .split(opts.delimiter ?? pathDelimiter)
      .filter((d) => d.length > 0);
    return dirs.some((dir) => resolves(join(dir, tool)));
  };
};
