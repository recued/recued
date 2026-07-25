/** D-118 Phase 6 — service dispatcher shared types.
 *
 *  The six `service-*` kernel ingredients reach the server through
 *  this dispatcher. Each handler translates the kernel-layer input
 *  (opaque `Record<string, unknown>` from the recipe engine) into a
 *  concrete supervisor / state-store / quota call, enforces caps +
 *  validation + audit, and returns a recipe-facing output.
 *
 *  Phase 8 composition resolves the seams — bundle resolver from
 *  the `collection_instances` table + template manifest registry,
 *  quota config from runtime-schema + instance config, log reader
 *  from `AuditLogStore.listActivities` filtered to `service_event`
 *  rows.
 */
import type {
  ServiceAuditEvent,
  ServiceCheckKind,
  ServiceCollectionCaps,
  ServiceEventName,
  ServiceHealthState,
  ServiceRestartPolicy,
  ServiceState,
} from '@recued/contracts';

import type { ServiceInstanceStateStore } from '../service-state-table.js';
import type { ServiceQuotaTracker, ServiceQuotaConfig } from '../quota-tracker.js';
import type {
  ServiceEventEmitter,
  ServiceInstanceSpec,
  TimerSeams,
  VaultResolveFn,
  RunCheckFn,
} from '../supervisor/types.js';
import type { Supervisor } from '../supervisor/supervisor.js';

/** Per-field schema entry from the template manifest. Lifted here
 *  so the dispatcher can validate recipe-supplied `inputs` without
 *  pulling the full template-manifest-parser machinery (Phase 7
 *  concern). */
export interface InvokeFieldSchema {
  type: 'string' | 'number' | 'boolean' | 'enum' | 'file_ref' | 'url';
  required?: boolean;
  values?: string[];
  /** Opt-out from the `-`-prefix flag-injection guard for the
   *  rare `file_ref` / `url` template that legitimately wants
   *  flag-shaped values. Review flags manifests that set it. */
  allow_flag_like?: boolean;
  /** `file_ref` outputs only — marks the argv slot as a write
   *  target (post-invoke the captured path gets returned). */
  write?: boolean;
}

/** Declared shape of one `lifecycle.invoke.<op>` entry. `argv` is
 *  the literal argv array (with `{{input.*}}` / `{{config.*}}`
 *  slots). Dispatcher resolves refs, validates inputs, spawns
 *  one-shot with `timeout_ms` ceiling. */
export interface InvokeOpSpec {
  argv: string[];
  timeout_ms: number;
  exit_codes_ok?: number[];
  env?: Record<string, string>;
  cwd?: string;
  input: Record<string, InvokeFieldSchema>;
  /** Output map — field name → type hint. v1 recognises the
   *  metadata triad (`log_lines` / `exit_code` / `duration_ms`);
   *  custom fields declared here are accepted at manifest load but
   *  return `null` at runtime. `file_ref` outputs in a later spec. */
  output: Record<string, string>;
}

/** `exposes.<key>` entry — author-defined derived values that
 *  surface in `service-status.exposes` + the dashboard. */
export interface ExposeSpec {
  /** Template string with `{{config.*}}` interpolation. Exactly
   *  one of `template` / `source` is set per entry. */
  template?: string;
  /** Dotted ref path into the last health-check response or a
   *  similar runtime-sourced object. Phase 6 v1 only populates
   *  when the source is resolvable from the state store; unknown
   *  sources render as `''`. */
  source?: string;
}

/** Per-instance config-schema entry — used by
 *  `service-status.config` to know which fields are public and
 *  which are `vault_ref` (stripped unconditionally per decision
 *  #18). */
export interface ConfigFieldSchema {
  type: 'string' | 'number' | 'boolean' | 'enum' | 'file_ref' | 'vault_ref';
  public?: boolean;
  optional?: boolean;
  default?: unknown;
  values?: string[];
}

/** Compact spec+template bundle the dispatcher reads to handle one
 *  slug. Phase 8 composition builds it from `collection_instances`
 *  + template manifest registry; test harnesses assemble directly. */
export interface ServiceInstanceBundle {
  slug: string;
  template_slug: string;
  publisher_id: string;
  config: Record<string, unknown>;
  config_schema: Record<string, ConfigFieldSchema>;
  caps: ServiceCollectionCaps;
  /** Runtime-check definitions (pass-through to Phase 4 `runCheck`). */
  health_check: Record<string, unknown> | null;
  startup_check: Record<string, unknown>[] | null;
  /** lifecycle.start shape — null for tool-shaped templates. */
  start: BundleStartSpec | null;
  /** lifecycle.stop — null for tool-shaped templates. */
  stop: BundleStopSpec | null;
  /** lifecycle.invoke map keyed by op name. */
  invoke: Record<string, InvokeOpSpec>;
  /** exposes map from the manifest. */
  exposes: Record<string, ExposeSpec>;
  /** Grace window for reconcile partial re-eval. */
  startup_grace_ms: number;
  /** Interval already clamped to
   *  `SERVICE_HEALTH_CHECK_INTERVAL_MS_FLOOR`. */
  health_check_interval_ms: number;
}

export interface BundleStartSpec {
  argv: string[];
  env?: Record<string, string>;
  cwd?: string;
  detach?: boolean;
  restart_policy?: ServiceRestartPolicy;
  restart_on_server_start?: boolean;
}

export interface BundleStopSpec {
  signal?: NodeJS.Signals;
  grace_ms?: number;
  argv?: string[];
}

/** Seam — slug → bundle. Phase 8 resolves from the instance store
 *  + manifest registry; tests inject an in-memory map. */
export interface ServiceBundleResolver {
  get(slug: string): Promise<ServiceInstanceBundle | null>;
  list(): Promise<ServiceInstanceBundle[]>;
}

/** Seam — audit log reader filtered to `service_event` rows.
 *  Phase 8 composition wires this to `AuditLogStore.listActivities`
 *  with a light adapter; tests inject a stub list. */
export interface ServiceLogReader {
  listEvents(input: {
    slug: string;
    since?: number;
    event_names?: ServiceEventName[];
    limit: number;
  }): Promise<ServiceAuditEvent[]>;
}

/** One-shot spawn for `service-invoke`. Mirrors the installer
 *  spawn's stdio shape but adds a hard timeout + SIGKILL-on-expiry
 *  (surfaces as `timed_out: true`, `exit_code: -9`). */
export type SpawnInvokeFn = (
  argv: string[],
  opts: SpawnInvokeOpts,
) => Promise<InvokeSpawnResult>;

export interface SpawnInvokeOpts {
  env?: Record<string, string>;
  cwd?: string;
  timeout_ms: number;
}

export interface InvokeSpawnResult {
  exit_code: number;
  log_lines: string[];
  stdout_truncated: boolean;
  duration_ms: number;
  timed_out: boolean;
}

/** Full dispatcher context assembled at Phase 8 composition. */
export interface ServiceDispatcherDeps extends TimerSeams {
  supervisor: Supervisor;
  stateStore: ServiceInstanceStateStore;
  bundleResolver: ServiceBundleResolver;
  quotaTracker: ServiceQuotaTracker;
  spawnInvoke: SpawnInvokeFn;
  runCheck: RunCheckFn;
  logReader: ServiceLogReader;
  emitEvent: ServiceEventEmitter;
  resolveVault?: VaultResolveFn;
  /** Resolve quota config for a slug — Phase 8 composes from
   *  runtime-schema + per-instance overrides. */
  resolveQuotaConfig: (slug: string) => ServiceQuotaConfig;
  /** D-179 P5 — invoke guard knobs (§ 5: knobs, not designs). Called
   *  per invoke; the composed server path feeds it a snapshot taken at
   *  composition, so a Settings change applies on restart / re-compose
   *  — same posture as the other `collection.service.*` knobs. Absent
   *  ⇒ unbounded (legacy / unit-test path). */
  resolveInvokeLimits?: () => ServiceInvokeLimits;
}

/** D-179 P5 — server-level invoke guards. */
export interface ServiceInvokeLimits {
  /** Ceiling on any op's authored `timeout_ms`; effective deadline =
   *  min(authored, ceiling). */
  invoke_timeout_ceiling_ms: number;
  /** Server-wide simultaneous-invoke bound. */
  max_concurrent_invokes: number;
  /** Per-service-instance simultaneous-invoke bound. */
  max_concurrent_invokes_per_instance: number;
}

/** The six dispatcher-facing handler signatures, returning the
 *  kernel-facing shapes declared in
 *  `packages/ingredients/src/kernel.ts`. */
export interface ServiceDispatcher {
  start(input: {
    slug: string;
    wait_until_healthy?: { timeout_ms: number };
  }): Promise<{
    state: 'running' | 'unhealthy' | 'failed';
    pid: number | null;
    started_at: number | null;
  }>;

  stop(input: { slug: string }): Promise<{ state: 'stopped' | 'failed' }>;

  status(input: { slug: string }): Promise<DispatcherServiceStatus>;

  invoke(input: {
    slug: string;
    op: string;
    inputs: Record<string, unknown>;
  }): Promise<{
    exit_code: number;
    duration_ms: number;
    log_lines: string[];
    stdout_truncated: boolean;
  }>;

  logs(input: {
    slug: string;
    since?: number;
    event_names?: string[];
    limit?: number;
  }): Promise<{ events: ServiceAuditEvent[] }>;

  list(): Promise<{
    instances: Array<{
      slug: string;
      template: string;
      state: string;
      health: string;
    }>;
  }>;
}

/** Shape returned by `service-status`. Mirrors the contracts
 *  `ServiceStatus` but derived here to preserve the declaration-
 *  boundary rule. */
export interface DispatcherServiceStatus {
  state: ServiceState;
  health: ServiceHealthState;
  pid: number | null;
  started_at: number | null;
  uptime_s: number | null;
  last_crash_at: number | null;
  consecutive_crashes: number;
  config: Record<string, unknown>;
  exposes: Record<string, string>;
}

// Re-export to keep a single import path for dispatcher + tests.
export type {
  ServiceCheckKind,
  ServiceCollectionCaps,
  ServiceEventName,
  ServiceHealthState,
  ServiceInstanceSpec,
  ServiceQuotaConfig,
  ServiceState,
};
