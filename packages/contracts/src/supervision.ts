/** Supervision feature — owner-only `supervision.*` rpc wire types.
 *
 *  A supervised daemon is the UI-enrolled keep-alive instance of a pack's
 *  detached cli daemon op (a `CliMethodBinding.detached.supervision`-bearing
 *  op — `cloudflared`/`tunnel.run_detached`, `ollama`/`serve.run_detached`).
 *  These rpcs are the seam the pack-detail manual/auto flip UI builds against.
 *  Owner-only by construction: `supervision.` is in `MCP_RESERVED_RPC_PREFIXES`,
 *  so an MCP-channel agent can never enrol, flip, start, or stop a daemon (a
 *  long-running tunnel/serve is operator territory).
 *
 *  Keyed on `(ingredient_slug, op)` — the single-instance-per-server identity:
 *  the supervised singleton (one ollama serve, one cloudflared tunnel) is the
 *  binary/op being supervised, NOT the pack it ships in (the same ingredient in
 *  two packs is still ONE daemon). The pack is discovery + display context only
 *  (the UI groups a row under a pack via the pack manifest's ingredient refs).
 *  A future docker-compose multi-instance model would ADD an instance segment,
 *  not re-key.
 *
 *  The `mode` collapses the (restart_policy × restart_on_server_start) pair the
 *  store holds into the one control the UI offers:
 *   - `manual` → `restart_policy: 'never'`, no boot-persist (UI start/stop only);
 *   - `auto`   → the pack op's declared `restart_policy` + `restart_on_server_start`;
 *   - `off`    → un-enrolled (a discovered-but-not-yet-enrolled op, or `set` to
 *                un-enrol = stop + drop the row).
 */
import type { ServiceRestartPolicy, ServiceState } from './service.js';

/** The pack-detail control: un-enrol, or supervise with manual / auto restart. */
export type SupervisionMode = 'off' | 'manual' | 'auto';

/** `supervision.set` request — enrol/flip/start/stop one daemon op. */
export interface SupervisionSetRequest {
  /** The catalog ingredient whose `surfaces.connector.executes[op]` carries the
   *  `CliMethodBinding.detached.supervision` — the single-instance key. */
  ingredient_slug: string;
  /** The daemon operation key (e.g. `tunnel.run_detached`). */
  op: string;
  mode: SupervisionMode;
  /** Run-intent (Start/Stop). Defaults to `true` for `manual`/`auto`; ignored
   *  for `off`. */
  enabled?: boolean;
  /** The op's business args (e.g. `{ tunnel_name }`). Required on first enrol;
   *  omit on a later toggle to preserve the stored args. */
  args?: Record<string, unknown>;
}

/** One supervisable daemon op — durable config merged with live runtime state.
 *  `supervision.list` returns one per installed `detached.supervision` op (NOT
 *  just enrolled ones — an un-enrolled op comes back `mode: 'off'`), so the UI
 *  can render the off→manual/auto enrol control. Also the `supervision.set` /
 *  `.status` result. */
export interface SupervisionDaemonRow {
  ingredient_slug: string;
  op: string;
  /** `'off'` = discovered but not enrolled. `'manual'` / `'auto'` derive from
   *  the enrolled `restart_policy` (`'never'` → manual, else auto). */
  mode: SupervisionMode;
  /** Run-intent. Always `false` for an un-enrolled (`off`) row. */
  enabled: boolean;
  /** Enrolled policy, or the op's DECLARED default for an un-enrolled row (so
   *  the UI can preview what `auto` would set). */
  restart_policy: ServiceRestartPolicy;
  restart_on_server_start: boolean;
  /** Live state (the D-118 `ServiceState` vocabulary). `unknown` before the
   *  first launch / for an un-enrolled row. */
  state: ServiceState;
  pid: number | null;
  started_at: number | null;
  consecutive_crashes: number;
  last_crash_at: number | null;
  last_exit_code: number | null;
  /** Required `argv_template` arg keys (e.g. `['tunnel_name']`) the enrol form
   *  must collect — `supervision.set` rejects a `manual`/`auto` enrol that omits
   *  any of them. */
  required_args: string[];
}

export interface SupervisionListResponse {
  daemons: SupervisionDaemonRow[];
}

export interface SupervisionStatusRequest {
  ingredient_slug: string;
  op: string;
}
