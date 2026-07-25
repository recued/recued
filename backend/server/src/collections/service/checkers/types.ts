/** D-118 Phase 4 — checker registry shared types.
 *
 *  Closed typed checker registry used by `install_check`,
 *  `health_check`, and `startup_check[]`. Mirrors the installer
 *  registry structure (per-kind module + validator + shared
 *  dispatcher) so the surface shape is learnable once and reused.
 *
 *  Difference from installers: checkers return a lightweight
 *  `ServiceCheckResult { passed, detail? }` rather than exit codes
 *  + log lines. A check is a boolean predicate with optional
 *  human-readable context, not a one-shot installer run.
 *
 *  All subprocess / IO seams are injectable via `CheckerContext`
 *  so tests can assert argv / URL / path without touching the
 *  real environment.
 */
import type {
  ServiceCheckKind,
  ServiceCheckResult,
} from '@recued/contracts';

/** Spawn + timeout signature used by `exec_ok`. Returns only the
 *  exit code — checkers don't care about log output, only pass /
 *  fail. Timeout kills the child and surfaces as `exit_code: -9`
 *  so the handler can classify it as a failed check with a clear
 *  `detail`. Stdio mirrors the installer shape:
 *  `['ignore', 'ignore', 'ignore']` — checkers don't capture, and
 *  stdin `/dev/null` structurally prevents REPL-shaped binaries
 *  from hanging the probe (decision #9). */
export type CheckerSpawnFn = (
  argv: string[],
  timeoutMs: number,
) => Promise<{ exit_code: number }>;

/** TCP probe signature for `tcp_open`. Resolves true when
 *  `connect(host, port)` succeeds inside `timeoutMs`, false on
 *  timeout / error. */
export type CheckerTcpConnectFn = (
  host: string,
  port: number,
  timeoutMs: number,
) => Promise<boolean>;

/** Per-call context wired by the server composition root. Tests
 *  inject mocks for deterministic checks; production runs with
 *  the real Node IO from `process.ts`. */
export interface CheckerContext {
  /** HTTP fetch seam for `http_ok`. Defaults to
   *  `globalThis.fetch`. Runs with an AbortController tied to
   *  `timeout_ms`. */
  fetch?: typeof fetch;
  /** Spawn + timeout seam for `exec_ok`. */
  spawnWithTimeout?: CheckerSpawnFn;
  /** fs.stat-style existence probe for `file_exists` +
   *  `pid_file`. True iff the path resolves to an existing entry;
   *  false on ENOENT / permission error / broken symlink. */
  stat?: (path: string) => Promise<boolean>;
  /** UTF-8 file read for `pid_file` pid-integer parsing. Rejects
   *  on IO error — handler catches + maps to `passed: false`. */
  readText?: (path: string) => Promise<string>;
  /** `kill(pid, 0)` liveness probe for `pid_file`. Returns true
   *  when the process exists and is signalable by the current uid;
   *  false on ESRCH / EPERM. */
  kill0?: (pid: number) => boolean;
  /** TCP connect probe for `tcp_open`. */
  tcpConnect?: CheckerTcpConnectFn;
  /** PATH scan for `binary_in_path`. True iff the binary resolves
   *  to an executable file on `process.env.PATH`. */
  whichBinary?: (name: string) => Promise<boolean>;
}

/** One checker kind's handler. Each module validates its own
 *  params shape (per-kind required fields differ — http_ok needs
 *  `url`, tcp_open needs `host + port`, etc.). Validation
 *  failures throw `CheckerParamError`. */
export interface CheckerKindModule<P> {
  validate: (raw: unknown) => P;
  check: (params: P, ctx: CheckerContext) => Promise<ServiceCheckResult>;
}

/** Thrown when params don't match the kind's required shape.
 *  Distinct from `{ passed: false }` — this is a manifest
 *  authoring error, surfaced before any IO attempt. */
export class CheckerParamError extends Error {
  readonly kind: ServiceCheckKind;
  constructor(kind: ServiceCheckKind, message: string) {
    super(`${kind}: ${message}`);
    this.name = 'CheckerParamError';
    this.kind = kind;
  }
}
