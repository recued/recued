/** D-118 — `data.service` shared types.
 *
 *  Lives alongside `collections.ts` + `calendar.ts`. The service
 *  platform is the fifth warehouse platform after mail / file /
 *  webhook / calendar — distinct from the other four because the
 *  underlying "collection" is a typed process-execution endpoint
 *  rather than a stream of records. Two workload classes collapse
 *  into one platform:
 *
 *    - **Tools** (`lifecycle.start = null`) — one-shot CLIs.
 *      `service-invoke` is the whole story; no supervisor; health
 *      reduces to "binary still installed".
 *    - **Services** (`lifecycle.start` non-null) — long-running
 *      processes. Full supervisor with crash detection, restart
 *      backoff, health polling, permanently-crashed state.
 *
 *  See `docs/d-118-spec.md` — closed registries (install kinds /
 *  check kinds / event names) are a load-bearing security boundary.
 *  Adding a new kind is a Recued-core code change, never a
 *  marketplace template change. Reviewer evaluates structural
 *  validation against the closed enumerations declared here.
 */

// ────────────────────────────────────────────────────────────────
// Closed typed registries
// ────────────────────────────────────────────────────────────────

/** Install kinds — every entry has a symmetric uninstall path
 *  (decision #3). Adding a new kind is a code change in the server
 *  installer registry + a contracts widening + reviewer guidance.
 *  System package managers (apt / yum / dnf / pacman / zypper / apk)
 *  are deliberately excluded — they require sudo, which forces
 *  recued-server to run as root. */
export const SERVICE_INSTALL_KINDS = [
  'brew',
  'scoop',
  'winget',
  'npm',
  'pip',
  'cargo',
  'go_install',
  'docker_pull',
  'download',
] as const;
export type ServiceInstallKind = (typeof SERVICE_INSTALL_KINDS)[number];

/** Check kinds — used uniformly by `install_check`, `health_check`,
 *  and per-entry `startup_check[]` slots. Closed registry; the
 *  dispatcher refuses any unknown kind. */
export const SERVICE_CHECK_KINDS = [
  'binary_in_path',
  'file_exists',
  'http_ok',
  'tcp_open',
  'pid_file',
  'exec_ok',
] as const;
export type ServiceCheckKind = (typeof SERVICE_CHECK_KINDS)[number];

/** Audit event names emitted under `type: 'service_event'`. The
 *  `service-logs` kernel ingredient filters audit rows by these. */
export const SERVICE_EVENT_NAMES = [
  'enrolled',
  'uninstalled',
  'installed',
  'upgraded',
  'started',
  'stopped',
  'crashed',
  'invoked',
  'health_changed',
  'install_failed',
  'upgrade_failed',
] as const;
export type ServiceEventName = (typeof SERVICE_EVENT_NAMES)[number];

/** Restart policies for `lifecycle.start.restart_policy`. `'on-crash'`
 *  is the default and the common choice. */
export const SERVICE_RESTART_POLICIES = [
  'never',
  'on-crash',
  'always',
] as const;
export type ServiceRestartPolicy = (typeof SERVICE_RESTART_POLICIES)[number];

/** Server OS as a `kind: service` template manifest declares it. */
export const SERVICE_TEMPLATE_OS = ['macos', 'linux', 'windows'] as const;
export type ServiceTemplateOS = (typeof SERVICE_TEMPLATE_OS)[number];

// ────────────────────────────────────────────────────────────────
// Defaults / floors
// ────────────────────────────────────────────────────────────────

/** Default grace window before a partial-pass `startup_check[]` re-
 *  evaluates during reconcile. Templates can override per-instance. */
export const SERVICE_STARTUP_GRACE_MS_DEFAULT = 15_000;

/** Floor for `health_check.interval_ms`. Templates that ask for
 *  faster polling are clamped — health is meant for status, not
 *  liveness probing. */
export const SERVICE_HEALTH_CHECK_INTERVAL_MS_FLOOR = 10_000;

/** `service-invoke` stdout cap. Above this, the buffer is truncated
 *  with `\n[stdout truncated at 1048576 bytes]\n`. Templates that
 *  need larger output use `file_ref` outputs instead. */
export const SERVICE_INVOKE_STDOUT_CAP_BYTES = 1_048_576; // 1 MiB

/** Floor for the OS free-space gate checked per invoke. The invoke
 *  fails with `SERVICE_STORAGE_PRESSURE` when `statvfs(<data_path>)
 *  .bavail` falls below this. */
export const SERVICE_MIN_DISK_FREE_BYTES_DEFAULT = 1_073_741_824; // 1 GiB

/** Default per-instance quota. Cached `du` over the instance cwd
 *  refreshed every 30 s; failing the gate returns
 *  `SERVICE_STORAGE_PRESSURE` with the layer that tripped. */
export const SERVICE_QUOTA_BYTES_DEFAULT = 5_368_709_120; // 5 GiB

/** Consecutive crashes ceiling — past this, the supervisor stops
 *  restarting and flips the instance to `permanently_crashed`.
 *  User clears via the dashboard `[Clear & retry]` button. */
export const SERVICE_CONSECUTIVE_CRASHES_MAX = 5;

/** Restart backoff schedule indexed by `consecutive_crashes - 1`.
 *  1 s → 5 s → 30 s → 2 min → 10 min, then ceiling fires. */
export const SERVICE_RESTART_BACKOFF_MS = [
  1_000,
  5_000,
  30_000,
  120_000,
  600_000,
] as const;

/** Subdirectory under `<data_path>` that holds per-instance cwds.
 *  Each enrolled service runs with cwd = `<data_path>/services/<slug>/`
 *  unless the template overrides via `lifecycle.start.cwd`. */
export const SERVICE_CWD_SUBDIR = 'services';

// ────────────────────────────────────────────────────────────────
// Runtime state shapes
// ────────────────────────────────────────────────────────────────

/** Live execution state of a service instance. Tools (no
 *  `lifecycle.start`) sit at `'unknown'` since there is no process
 *  to observe; the dashboard renders them via `caps.start === 'no'`
 *  rather than reading `state` for them. */
export type ServiceState =
  | 'running'
  | 'stopped'
  | 'crashed'
  | 'permanently_crashed'
  | 'unknown';

/** Result of the most recent health-check evaluation. `'unknown'`
 *  before the first tick OR when `caps.health === 'none'`. */
export type ServiceHealthState = 'healthy' | 'unhealthy' | 'unknown';

// ────────────────────────────────────────────────────────────────
// Capability model (D-110 parity)
// ────────────────────────────────────────────────────────────────

/** Per-instance capability shape — populated at enroll time from the
 *  template manifest's structural shape (no runtime probe needed —
 *  caps derive deterministically from `lifecycle.*` + `install*`).
 *  Cached on the `collection_instances.caps` column. Read at
 *  parseRecipe time so cap mismatches surface as install-time
 *  errors. Read again at dispatch time so a recipe can't call
 *  `service-start` against a tool-shaped instance.
 *
 *  Special encodings:
 *   - `install: 'hint_only'` — `install[]` is null but
 *     `install_hint` is present; UI shows the manual install string,
 *     the install rpc returns `SERVICE_INSTALL_UNAVAILABLE`.
 *   - `start: 'no'` + `stop: 'no'` together — tool shape; `service-
 *     start` and `service-stop` return `SERVICE_OP_NOT_SUPPORTED`. */
export interface ServiceCollectionCaps {
  install: 'yes' | 'no' | 'hint_only';
  upgrade: 'yes' | 'no';
  uninstall: 'yes' | 'no';
  start: 'yes' | 'no';
  stop: 'yes' | 'no';
  /** List of available `lifecycle.invoke.<op>` slugs. Empty when the
   *  template declares no invoke ops (rare — most templates ship at
   *  least one op even when they're services). */
  invoke: readonly string[];
  /** Health-check kind, or `'install_check'` alias (tools), or
   *  `'none'` when the template declined to declare a health check. */
  health: ServiceCheckKind | 'install_check' | 'none';
  restart: ServiceRestartPolicy;
}

// ────────────────────────────────────────────────────────────────
// Status snapshot (`service-status` output)
// ────────────────────────────────────────────────────────────────

/** Snapshot returned by the `service-status` kernel ingredient.
 *  Pure read — no side effects, no health-check tick. The caller
 *  receives a point-in-time picture of `service_instance_state`
 *  joined with the resolved `exposes` templates from the manifest.
 *
 *  `config` carries only fields declared `public: true` in the
 *  template's `config_schema`; `vault_ref` entries are stripped
 *  unconditionally per decision #18 — secrets stay in vault, never
 *  cross the recipe-readable surface. */
export interface ServiceStatus {
  state: ServiceState;
  health: ServiceHealthState;
  pid: number | null;
  /** Unix-ms when the live process started, or null when stopped. */
  started_at: number | null;
  /** Seconds since `started_at`; null when stopped. Computed at read
   *  time so consumers don't have to do the math. */
  uptime_s: number | null;
  /** Unix-ms of the last crash, or null when no crash recorded. */
  last_crash_at: number | null;
  consecutive_crashes: number;
  /** Public config fields only. `vault_ref` entries stripped. */
  config: Record<string, unknown>;
  /** Resolved `exposes` map from the template — author-defined
   *  derived values (e.g. `endpoint` rendered from `{{config.port}}`,
   *  `api_version` pulled from the most recent health check). */
  exposes: Record<string, string>;
}

// ────────────────────────────────────────────────────────────────
// Heartbeat health (extends CollectionHealth)
// ────────────────────────────────────────────────────────────────

/** Service-platform variant of `CollectionHealth`. Emitted on the
 *  heartbeat envelope alongside mail / file / webhook / calendar
 *  rows. The dashboard's per-instance card consumes this directly —
 *  no follow-up rpc needed for the live status view.
 *
 *  Structurally a `CollectionHealth` (same base fields) — typed as a
 *  standalone interface so callers can `health.platform === 'service'`
 *  narrow without circular imports between `collections.ts` and
 *  `service.ts`. The Phase 8 heartbeat path emits these into the
 *  `collections[]` array on each envelope. */
export interface ServiceCollectionHealth {
  platform: 'service';
  slug: string;
  /** Unix-ms of the last successful health check. 0 before the
   *  first tick. */
  last_indexed_at: number;
  /** Always 0 for service rows — services have no per-record
   *  ingestion queue. Field kept for shape compatibility with
   *  `CollectionHealth`. */
  pending_queue_size: number;
  /** Rolling crash count in the last 24 h. Cycles back to 0 across
   *  the day boundary. Distinct from `consecutive_crashes` — that
   *  counter resets on healthy start, this one is windowed. */
  error_count_24h: number;
  /** Maps the supervisor's runtime state to the shared
   *  `CollectionState` shape for dashboard rendering. */
  state: 'connected' | 'disconnected' | 'syncing' | 'idle' | 'error';
  /** D-110 — auth state surfaced for parity with other collections.
   *  Service-platform rows reuse `'expired'` to signal
   *  permanently-crashed (auth_state = 'unauthorized') so generic
   *  dashboard widgets render a distinguishable pill. */
  auth_state?: 'healthy' | 'expired' | 'unauthorized' | 'degraded';
  /** Live process state from `service_instance_state`. */
  service_state: ServiceState;
  pid: number | null;
  uptime_s: number | null;
  last_crash_at: number | null;
  consecutive_crashes: number;
}

// ────────────────────────────────────────────────────────────────
// Audit event shape
// ────────────────────────────────────────────────────────────────

/** Wire shape of a `type: 'service_event'` audit row. The
 *  `service-logs` kernel ingredient is a thin filter over rows of
 *  this shape — no separate log-storage subsystem.
 *
 *  Argv values resolved from `{{vault.*}}` are redacted by key name
 *  at the dispatcher boundary BEFORE landing here (`["--api-key",
 *  "<vault:my_key>"]` rather than the plaintext). Decision #18 —
 *  vault secrets never flow through the audit log. */
export interface ServiceAuditEvent {
  type: 'service_event';
  /** `data.service.<slug>` — the enrolled instance. */
  slug: string;
  /** `install_check.binary` if declared, else the first argv
   *  element of the operation that emitted this event, else null. */
  binary: string | null;
  event_name: ServiceEventName;
  /** Argv array for invoke / install / start / stop events; null
   *  for purely informational events (`enrolled`, `health_changed`).
   *  Vault-resolved values are redacted by key name. */
  argv: string[] | null;
  /** Failure detail for failed events; null on success. */
  error: string | null;
  /** Unix-ms. */
  timestamp: number;
}

// ────────────────────────────────────────────────────────────────
// Enroll / install / status rpc payload shapes
// ────────────────────────────────────────────────────────────────

/** Result of one structured check — uniform across `install_check`,
 *  `health_check`, and entries in `startup_check[]`. */
export interface ServiceCheckResult {
  passed: boolean;
  /** Optional human-readable detail — surfaced in audit + UI. */
  detail?: string;
}

/** `collection.service.enroll` request payload. */
export interface ServiceEnrollInput {
  /** User-chosen slug, unique within `data.service.*`. */
  slug: string;
  /** Marketplace template, optionally pinned: `"ollama-macos@1.0.0"`. */
  template_slug: string;
  /** Validated against the template's `config_schema` at enroll. */
  config: Record<string, unknown>;
}

/** `collection.service.enroll` response payload. The `install_check`
 *  outcome is computed during enroll; on pass, the instance is ready
 *  to start. On fail, the UI dispatches to either the install button
 *  (when `install_available`) or the install_hint string. */
export interface ServiceEnrollOutput {
  slug: string;
  install_check: ServiceCheckResult;
  /** True when the template declares an `install[]` array. False for
   *  templates that only carry `install_hint`. */
  install_available: boolean;
  caps: ServiceCollectionCaps;
}

/** Streamed install / upgrade / uninstall outcome. */
export interface ServiceInstallOutput {
  slug: string;
  /** Final exit code from the underlying installer. */
  exit_code: number;
  /** Install-check result re-evaluated post-install. */
  install_check: ServiceCheckResult;
  /** Truncated installer stdout (capped same as service-invoke). */
  log_lines: string[];
}

/** Same shape as `ServiceInstallOutput` — kept distinct so the
 *  rpc registry is self-documenting and a future divergence
 *  doesn't require a wire bump. */
export type ServiceUpgradeOutput = ServiceInstallOutput;

/** Same shape as `ServiceInstallOutput` — kept distinct for the
 *  same self-documenting reason. */
export type ServiceUninstallOutput = ServiceInstallOutput;

/** One row returned by `collection.service.list`. Subset of
 *  `ServiceStatus` — enumeration view rather than detail view. */
export interface ServiceInstanceListRow {
  slug: string;
  template_slug: string;
  state: ServiceState;
  health: ServiceHealthState;
  caps: ServiceCollectionCaps;
}

/** `collection.service.list` response payload. */
export interface ServiceInstanceList {
  instances: ServiceInstanceListRow[];
}

// ────────────────────────────────────────────────────────────────
// Template catalog (`collection.service.listTemplates` — D-118
// Phase 10 follow-up)
// ────────────────────────────────────────────────────────────────

/** Template config-field schema — the UI-relevant projection of
 *  `ConfigFieldSchema` on the server side. `label` + `placeholder`
 *  are UI-only hints the marketplace renderer fills in for the
 *  picker; both optional so round-trip via the rpc stays lossless
 *  for templates that don't declare them. `default` is present on
 *  the server shape but kept unknown-typed here because the picker
 *  only needs to render the schema, not enforce the default. */
export interface ServiceTemplateConfigField {
  type: 'string' | 'number' | 'boolean' | 'enum' | 'file_ref' | 'vault_ref';
  public?: boolean;
  optional?: boolean;
  required?: boolean;
  default?: unknown;
  values?: readonly string[];
  label?: string;
  placeholder?: string;
}

/** One row in the picker. Everything the enroll form needs to
 *  populate itself without a second rpc — slug, label, caps (so
 *  the form can render the appropriate lifecycle hints), the
 *  config schema (for schema-driven inputs), and the install-hint
 *  fallback. Pure JSON — nothing function-valued. */
export interface ServiceTemplateListRow {
  /** Full pinned template slug, e.g. `ollama-macos@1.0.0`. Passed
   *  back verbatim to `collection.service.enroll`. */
  template_slug: string;
  /** Base slug without version pin — `ollama-macos`. */
  slug: string;
  /** Human-readable label. Populated from the ingredient manifest's
   *  `name` when present; otherwise the slug. */
  label: string;
  platform: ServiceTemplateOS;
  variant_group: string;
  caps: ServiceCollectionCaps;
  config_schema: Record<string, ServiceTemplateConfigField>;
  install_hint: string | null;
}

/** Request filter — narrow the catalog by OS (defaults to the
 *  detected server OS) and/or variant_group (for recipes that
 *  already know which group they need). Both optional; empty
 *  payload returns every cached template that matches the server's
 *  OS. */
export interface ServiceTemplateListInput {
  /** Defaults to the server's detected OS. Callers that want the
   *  full cross-platform catalog pass an explicit `null` — the
   *  enroll picker never does, but a marketplace-browse surface
   *  might. */
  platform?: ServiceTemplateOS | null;
  /** When set, returns only templates whose `variant_group`
   *  matches. Used by the `service_ref` install-time picker that
   *  already knows the group it needs (e.g. "ollama"). */
  variant_group?: string;
}

/** `collection.service.listTemplates` response. */
export interface ServiceTemplateList {
  templates: ServiceTemplateListRow[];
  /** The OS filter that was actually applied (echo of the
   *  detected-or-specified platform). Lets the picker show
   *  "Showing templates for macOS" without a second rpc. */
  applied_platform: ServiceTemplateOS | null;
}

