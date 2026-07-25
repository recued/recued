/** Typed shape of recued-server's on-disk config.
 *
 *  The file splits into two sections with distinct semantics:
 *
 *  - `[bootstrap]` — read once at process start. Changing any field here
 *    requires a restart. Fields control where the server lives (data path,
 *    log path), how it listens (host, ports), and which optional surfaces
 *    come online (MCP, webhook).
 *
 *  - `[runtime]` — live-editable via the ext→server rpc (`server.setConfigField`)
 *    or direct file edit + reload. Keys are dotted strings written as
 *    TOML-quoted properties so they stay literal (not interpreted as
 *    TOML's nested-table dotted-key syntax). The flat-string convention
 *    matches `ServerConfigField.key` on the rpc wire. */

export type Distribution = 'binary' | 'source' | 'server';

export interface BootstrapConfig {
  data_path: string;
  bind_host: string;
  bind_port: number;
  /** 0 disables the MCP surface. */
  mcp_port: number;
  /** 0 disables the inbound-webhook surface. Non-zero requires a public
   *  host (self-host only — not relayed via the cloud per D-096). */
  webhook_port: number;
  /** Supports the `{data_path}` template token so the default "logs
   *  next to data" convention survives a user moving data_path. */
  log_path: string;
}

export type RuntimeValue = string | number | boolean;

/** Runtime config is a flat map of dotted keys to scalar values.
 *  The `RUNTIME_SCHEMA` in `./schema.ts` enforces which keys are valid
 *  and what shape/type each value may take. */
export type RuntimeConfig = Record<string, RuntimeValue>;

export interface LoadedConfig {
  bootstrap: BootstrapConfig;
  runtime: RuntimeConfig;
  /** Absolute path the config was loaded from — null when no file existed
   *  and we're running on bundled-preset defaults only. */
  source: string | null;
  distribution: Distribution;
}

export interface LoadOptions {
  /** Distribution selector — controls which preset supplies the base
   *  defaults. Build-time constant from each distribution's entry
   *  point; caller chooses. */
  distribution: Distribution;
  /** Explicit config file path override. Honors --config / $RECUED_CONFIG
   *  before the OS-conventional default. */
  configPath?: string;
  /** CLI argv (normally `process.argv.slice(2)`). When present, single-
   *  flag overrides like `--bind-port 8080` post-process the loaded
   *  config. Ignored when absent so tests can stay deterministic. */
  argv?: string[];
  /** Env source — normally `process.env`. Extracted as a parameter so
   *  tests can inject a synthetic environment without touching globals. */
  env?: Record<string, string | undefined>;
}

/** Schema entry for a single runtime key. `section: 'bootstrap'` entries
 *  are tracked for completeness even though they live in the bootstrap
 *  config object — some validation + env plumbing is shared. */
export type ScalarType = 'string' | 'number' | 'boolean' | 'enum';

export interface ScalarSchemaEntry {
  key: string;
  type: ScalarType;
  default: RuntimeValue;
  /** Permitted values when `type === 'enum'`. Ignored otherwise. */
  enum?: readonly string[];
  /** Inclusive minimum for numeric fields. */
  min?: number;
  /** Inclusive maximum for numeric fields. */
  max?: number;
  /** When true, numeric fields must be integral. */
  integer?: boolean;
  /** Human-readable description — surfaces to the extension's schema-
   *  driven renderer via `server.getConfigSchema`. */
  description?: string;
  /** UI-facing short label ("Per-publisher vault quota"). Falls back to
   *  a humanized key when omitted. */
  label?: string;
  /** Grouping heading the renderer uses to order fields. Falls back to
   *  a prefix-derived section when omitted. */
  section?: string;
  /** When true, the field is NOT exposed through the generic
   *  `server.getConfigSchema` / `server.setConfigField` rpc surface — it
   *  persists + reads via the runtime store like any other field, but a
   *  dedicated rpc owns its write path (so a cross-field consistency gate
   *  can't be bypassed by the generic scalar setter). R26.2 Delta 2 uses
   *  this for `network.apex_mode` (owned by `exposure.set_apex`). */
  internal?: boolean;
}
