/** D-118 Phase 5 — supervisor shared types.
 *
 *  The supervisor manages long-running `data.service.*` processes:
 *  spawns them, tracks pid, listens for `exit`, and decides whether
 *  to restart per the template's `restart_policy`. Crash handling
 *  updates the Phase 2 state table as the single source of truth;
 *  in-process it also holds a `Map<slug, ProcessRecord>` so it can
 *  reach child handles for `.kill()`.
 *
 *  All subprocess IO + timers + audit emission flow through
 *  injectable seams so tests can drive the state machine with
 *  synthetic child handles + fake timers + an event-capture spy.
 */
import type {
  ServiceAuditEvent,
  ServiceRestartPolicy,
} from '@recued/contracts';

import type { ServiceInstanceStateStore } from '../service-state-table.js';
import type { CheckerContext } from '../checkers/dispatcher.js';

/** One step in the supervisor's per-instance lifecycle — enough
 *  information to spawn, stop, and re-check health without reading
 *  back the manifest. The Phase 7 enroll layer + composition root
 *  assemble this from the stored `collection_instances` row plus
 *  the template ingredient manifest. */
export interface ServiceInstanceSpec {
  slug: string;
  /** Template slug (`ollama-macos@1.0.0` etc). Audit events reference
   *  this so operators can tell which template crashed. */
  template_slug: string;
  /** Publisher id of the template. Scopes `{{vault.*}}` refs in
   *  `lifecycle.start.env` per D-003. */
  publisher_id: string;
  /** Instance config row (validated at enroll against the template's
   *  `config_schema`). Supplies `{{config.*}}` values for argv / env /
   *  check specs. */
  config: Record<string, unknown>;
  /** `lifecycle.start` — null for tool-shaped templates where
   *  `caps.start === 'no'`. Supervisor returns `SERVICE_OP_NOT_SUPPORTED`
   *  to callers in that case; tools only run through
   *  `service-invoke` (Phase 6). */
  start: StartSpec | null;
  /** `lifecycle.stop` — matches `start` shape (both null for tools,
   *  both non-null for services). */
  stop: StopSpec | null;
  /** `health_check` spec — may be `null` when `caps.health === 'none'`.
   *  Dispatcher resolves `{ kind: "install_check" }` aliases upstream
   *  (per spec line 493) so the supervisor only sees concrete kinds. */
  health_check: CheckSpec | null;
  /** `startup_check[]` — reconcile path only. `null` when the
   *  template declined to declare one. */
  startup_check: CheckSpec[] | null;
  /** Grace window for partial `startup_check[]` re-evaluation
   *  during reconcile. Defaults to `SERVICE_STARTUP_GRACE_MS_DEFAULT`. */
  startup_grace_ms: number;
  /** Polling interval for `health_check`, already clamped to the
   *  `SERVICE_HEALTH_CHECK_INTERVAL_MS_FLOOR` floor by the caller. */
  health_check_interval_ms: number;
}

export interface StartSpec {
  argv: string[];
  env?: Record<string, string>;
  cwd?: string;
  detach?: boolean;
  restart_policy?: ServiceRestartPolicy;
  restart_on_server_start?: boolean;
}

export interface StopSpec {
  signal?: NodeJS.Signals;
  grace_ms?: number;
  /** When set, run this argv to request shutdown (e.g.
   *  `docker compose down`) instead of signalling the child. After
   *  argv exits (or `grace_ms` elapses), SIGKILL on the original pid
   *  if still alive. Supplied as a plain array — no shell. */
  argv?: string[];
}

/** A resolved check spec — same shape the Phase 4 dispatcher
 *  consumes. Kept as an opaque object here so the supervisor
 *  doesn't need to know which kind it is. */
export type CheckSpec = Record<string, unknown>;

/** Handle returned by the spawn seam. Mirrors the ChildProcess
 *  surface we actually use — pid + kill + a one-shot exit
 *  handler — without requiring tests to build full
 *  ChildProcess mocks. */
export interface SpawnedProcess {
  pid: number | null;
  /** Signal the child. Returns true when the signal was delivered,
   *  false when the process was already gone. */
  kill(signal?: NodeJS.Signals): boolean;
  /** Register the crash listener. Supervisor calls this once per
   *  spawn; the handler fires when the child exits for any
   *  reason. */
  onExit(handler: ProcessExitHandler): void;
}

export type ProcessExitHandler = (
  code: number | null,
  signal: NodeJS.Signals | null,
) => void;

/** Spawn seam — always invoked with `shell: false` + the decision-#9
 *  stdio shape. Production implementation lives in
 *  `supervisor/process.ts`; tests pass a mock that returns a
 *  synthetic handle they can drive exit events on. */
export type SpawnProcessFn = (
  argv: string[],
  opts: SpawnOpts,
) => SpawnedProcess;

export interface SpawnOpts {
  env?: Record<string, string>;
  cwd?: string;
  detached?: boolean;
}

/** Audit emitter seam. Phase 8 composition wires this to the real
 *  AuditLogStore via an adapter that packs `ServiceAuditEvent`
 *  fields into an `ActivityEntry`. Kept as a pure callback here so
 *  the supervisor is testable without standing up a SQLite store. */
export type ServiceEventEmitter = (evt: ServiceAuditEvent) => void;

/** Check runner seam — wraps the Phase 4 `runCheck` so tests can
 *  stub check outcomes without interleaving a full checker
 *  dispatch. Production default just forwards to runCheck with a
 *  real CheckerContext. */
export type RunCheckFn = (
  spec: CheckSpec,
  config: Record<string, unknown>,
) => Promise<{ passed: boolean; detail?: string }>;

/** Timer + clock seams. Supervisor uses `setTimeout` for
 *  restart backoff + stop grace windows. Tests pass
 *  `vi.useFakeTimers`-bound versions. */
export interface TimerSeams {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimeout: (t: NodeJS.Timeout) => void;
}

/** Vault resolution seam. Takes a `{{vault.KEY}}` reference name
 *  scoped to the template's publisher_id (D-003); returns the
 *  plaintext secret, or `undefined` when the key is absent. Phase
 *  8 composition wires it to the extension-paired vault store. */
export type VaultResolveFn = (
  publisher_id: string,
  key: string,
) => string | undefined;

/** Full supervisor context assembled by the composition root. */
export interface SupervisorContext extends TimerSeams {
  stateStore: ServiceInstanceStateStore;
  spawn: SpawnProcessFn;
  emitEvent: ServiceEventEmitter;
  runCheck: RunCheckFn;
  /** Optional — default returns `undefined`, which leaves
   *  `{{vault.*}}` refs as literal text and surfaces via the
   *  binary's own "missing credential" error. */
  resolveVault?: VaultResolveFn;
  /** Checker context forwarded to `runCheck` default implementations
   *  (production supervisors inject a real context; tests stub
   *  runCheck directly and leave this empty). */
  checkerCtx?: CheckerContext;
}

/** Outcome of a `supervisor.start(spec)` call. */
export interface StartOutcome {
  state: 'running' | 'unhealthy' | 'failed';
  pid: number | null;
  started_at: number | null;
  detail?: string;
}

/** Outcome of a `supervisor.stop(slug)` call. */
export interface StopOutcome {
  state: 'stopped' | 'failed';
  detail?: string;
}
