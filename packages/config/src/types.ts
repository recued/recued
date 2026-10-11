/** Typed shape of recued-server's on-disk config.
 *
 *  The file splits into two sections with distinct semantics:
 *
 *  - `[bootstrap]` — read once at process start. Changing any field here
 *    requires a restart. Two fields: the listen port and the inbound-webhook
 *    switch. The renamed and removed ones are listed in `bootstrap-keys.ts`.
 *
 *  - `[runtime]` — live-editable via the ext→server rpc (`server.setConfigField`)
 *    or direct file edit + reload. Keys are dotted strings written as
 *    TOML-quoted properties so they stay literal (not interpreted as
 *    TOML's nested-table dotted-key syntax). The flat-string convention
 *    matches `ServerConfigField.key` on the rpc wire. */

export type Distribution = 'binary' | 'source' | 'server';

export interface BootstrapConfig {
  /** The port the server listens on (its LAN listener; the public listener's
   *  port is set in Settings). `--port` and `PORT` win over it — see
   *  `backend/server/src/cli/resolve-bind-port.ts`. */
  bind_port: number;
  /** Whether the server accepts inbound webhooks at all: Slack, Telegram and
   *  vendor callbacks. `false` composes no inbound listeners and the path-router
   *  404s every webhook / hook request; `true` composes all three. It opens no
   *  port of its own — webhooks are paths on the server's own port, so that is
   *  the port an operator makes reachable. Public delivery also needs a public
   *  host + the runtime key `collection.webhook.public_reachable` (or the older
   *  `RECUED_PUBLIC_REACHABLE`) — self-host only, never relayed via the cloud,
   *  per D-096.
   *
   *  ⛔ RENAMED 2026-10-10 from `webhook_port`, an on/off switch that read as a
   *  port: 0 was off, any other number on, and the number was never bound
   *  (D-272) — the name sent operators off to forward it in their router. The old
   *  name still works and boot names the rename (`bootstrap-keys.ts`). */
  webhooks_enabled: boolean;
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
