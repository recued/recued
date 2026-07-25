/** D-118 Phase 3 — installer registry shared types.
 *
 *  Closed typed installer registry. Every entry has install /
 *  upgrade / uninstall handlers with the same call shape so the
 *  dispatcher can route uniformly. Per-kind quirks (npm needs an
 *  NPM_CONFIG_PREFIX override; download is HTTP + verify + atomic
 *  replace, not a spawn) live behind the same interface.
 *
 *  Stdio for every spawned subprocess matches D-118's load-bearing
 *  decision #9: `stdio: ['ignore', 'pipe', 'pipe']`. Stdin =
 *  /dev/null structurally enforces the no-stdin-piping non-goal
 *  (REPL-shaped binaries fail in milliseconds with EOF instead of
 *  hanging until timeout).
 */

import type { ServiceInstallKind } from '@recued/contracts';

/** Action requested by the dispatcher. Each kind implements all
 *  three; install/upgrade may run different argv (e.g. brew install
 *  vs brew upgrade) and uninstall removes the package. */
export type InstallerAction = 'install' | 'upgrade' | 'uninstall';

/** Outcome of one installer run. Exit code distinguishes success
 *  (`0`) from failure (any other value); log_lines carries the
 *  combined stdout + stderr capture (capped at the same 1 MiB
 *  ceiling as service-invoke per spec line 1069 — installers are
 *  one-shot processes, no streaming back to recipes). */
export interface InstallerOutcome {
  exit_code: number;
  log_lines: string[];
}

/** Spawn helper signature. Always invoked with `shell: false` and
 *  `stdio: ['ignore', 'pipe', 'pipe']`. Returns the merged log
 *  capture so callers don't need to reassemble two streams in
 *  order. The default implementation lives in `process.ts`; tests
 *  pass a mock to assert argv without spawning real processes. */
export type SpawnFn = (
  argv: string[],
  opts?: SpawnOptions,
) => Promise<SpawnResult>;

export interface SpawnOptions {
  /** Extra env merged onto `process.env`. Templates resolve
   *  `{{vault.*}}` / `{{config.*}}` before reaching here. */
  env?: Record<string, string>;
  cwd?: string;
}

export interface SpawnResult {
  exit_code: number;
  /** Combined stdout + stderr lines, in arrival order. The default
   *  spawn helper caps capture at 1 MiB and appends a truncation
   *  marker line if the binary exceeded the cap. */
  log_lines: string[];
}

/** Fetch + sha-verify + atomic-replace helper for the `download`
 *  kind. Default implementation lives in `download.ts`; tests pass
 *  a synthetic implementation that reads from a fixture map. */
export type FetchFn = typeof fetch;

/** Per-call context passed through the dispatcher. Composition root
 *  builds this once per server boot; per-call wrappers may layer
 *  on `onStdout` for live UI streaming. */
export interface InstallerContext {
  /** Server data_path. The `download` kind resolves `target` paths
   *  against `<dataPath>/services/<slug>/` for safety — even an
   *  absolute path in the manifest gets re-anchored. */
  dataPath: string;
  /** Slug of the enrolled service the installer is acting on.
   *  Used to scope the cwd / npm prefix / download target. */
  slug: string;
  /** Optional streaming callback fired per stdout/stderr line as
   *  it arrives. The collected log_lines also lands in the
   *  outcome — onStdout is for live UI display, not durable
   *  capture. */
  onStdout?: (line: string) => void;
  /** Spawn seam. Defaults to the real Node spawn wrapper from
   *  `process.ts`; tests inject a mock. */
  spawn?: SpawnFn;
  /** HTTP fetch seam used by the download kind. Defaults to
   *  `globalThis.fetch`; tests inject a mock that returns
   *  fixture bodies + computable sha256. */
  fetch?: FetchFn;
}

/** One installer kind's handlers. Each handler validates its own
 *  params shape (per-kind required fields differ — brew needs
 *  `package`, download needs `url + sha256 + target`). Validation
 *  failures throw `InstallerParamError`. */
export interface InstallerKindModule<P> {
  install: (params: P, ctx: InstallerContext) => Promise<InstallerOutcome>;
  /** Upgrade may take an additional `target` field (npm package@version,
   *  go package@version, download URL with new sha). Per-kind handlers
   *  decide how to thread it. */
  upgrade: (params: P, ctx: InstallerContext) => Promise<InstallerOutcome>;
  uninstall: (params: P, ctx: InstallerContext) => Promise<InstallerOutcome>;
}

/** Thrown when params don't match the kind's required shape.
 *  Distinct from a non-zero installer exit — this is a manifest
 *  authoring error, surfaced by the dispatcher before any
 *  subprocess runs. */
export class InstallerParamError extends Error {
  readonly kind: ServiceInstallKind;
  constructor(kind: ServiceInstallKind, message: string) {
    super(`${kind}: ${message}`);
    this.name = 'InstallerParamError';
    this.kind = kind;
  }
}

/** Thrown when the download kind's verified sha256 doesn't match
 *  the declared sha256. Atomic replace aborts; the previous binary
 *  (if any) survives via `.bak`. The dispatcher surfaces this as
 *  `SERVICE_DOWNLOAD_SHA_MISMATCH` to the rpc caller. */
export class DownloadShaMismatchError extends Error {
  readonly url: string;
  readonly expected: string;
  readonly actual: string;
  constructor(url: string, expected: string, actual: string) {
    super(`download sha256 mismatch for ${url}`);
    this.name = 'DownloadShaMismatchError';
    this.url = url;
    this.expected = expected;
    this.actual = actual;
  }
}
