/** D-182 §7.2 — wire shapes for the owner-only `cli.reachability.*` grid rpc.
 *
 *  A `cli` op (whisper / docling / ffmpeg / magick / codex) is connection-LESS
 *  and pack-only, so it has no `ConnectionOperationProfile` to authorize against
 *  — its authorization is a per-(principal × cli-ingredient × OPERATION)
 *  reachability allowlist (`cli_reachability_state`, absent ⇒ DENIED,
 *  fail-closed), the SAME (contract × pack-op) grant shape every other pack-op
 *  uses, just with no connection binding. Risk tier is NOT a key — it's
 *  orthogonal (it decides owner-notification for write/destructive, never
 *  admission), so it rides along only as a display badge. This family is the
 *  owner surface that AUTHORS that allowlist — the "Local tools" surface (a
 *  contract-first list of per-op toggles) writes it, and it supersedes the
 *  deleted `cli.capability.*` tool-toggle family:
 *
 *    - `cli.reachability.list` — every reachability row (the surface's data read;
 *      a cheap store scan, no manifest walk). The UI joins this with the
 *      cli-tool universe to render available × granted ops.
 *    - `cli.reachability.set`  — grant (or revoke) ONE op for a principal
 *      (`allowed: true` ⇒ a recipe run under that principal may reach the cli
 *      ingredient's op; `allowed: false` ⇒ drop the row, back to the fail-closed
 *      default). `principal` defaults to the owner (`user_self`). Audited.
 *
 *  Owner-only by construction: `cli.reachability.` is in
 *  `MCP_RESERVED_RPC_PREFIXES`, so a compromised MCP-channel agent can never
 *  grant itself reachability to a local binary, nor enumerate the grid. The
 *  Gateway ENFORCES a *dispatched* cli op against the same allowlist
 *  (`resolveCliReachabilityPolicy`); this family writes it.
 *
 *  Spec: `docs/d-182-spec.md` §7.2 (per-contract cli reachability grid). */

/** One persisted reachability row — the `cli.reachability.list` projection.
 *  `principal` is the owner (`user_self`) or a door/agent `contract_id`;
 *  `ingredient_id` is the cli catalog ingredient (carries the catalog binding —
 *  the cross-catalog guard is structural); `operation_id` is the granted
 *  callable op. A present row with `allowed: true` admits; an absent row
 *  denies. */
export interface CliReachabilityRowView {
  principal: string;
  ingredient_id: string;
  operation_id: string;
  allowed: boolean;
  /** Epoch-ms the row was set (the audit stamp). */
  set_at?: number;
}

/** `cli.reachability.set` request — grant/revoke one op. `principal` is optional
 *  and defaults to the owner (`user_self`); the UI passes a door/agent
 *  `contract_id` for a contract row. `allowed: false` revokes (drops the row). */
export interface CliReachabilitySetRequest {
  ingredient_id: string;
  operation_id: string;
  allowed: boolean;
  principal?: string;
}

/** `cli.reachability.set` response — the resulting op state (so the caller
 *  renders the toggle without a re-list). On a revoke, `allowed: false` and
 *  `set_at` is absent. */
export interface CliReachabilitySetResponse {
  principal: string;
  ingredient_id: string;
  operation_id: string;
  allowed: boolean;
  set_at?: number;
}

/** `cli.reachability.list` response — every reachability row (the grid read). */
export interface CliReachabilityListResponse {
  rows: CliReachabilityRowView[];
}

/** One callable cli op the Local-tools surface offers a per-(principal, op)
 *  toggle for — the AUTHORIZATION leaf. The reachability row it writes is keyed
 *  `(principal, catalog_slug, operation_id)`: `catalog_slug` is the declaring
 *  cli catalog ingredient (the cross-catalog binding — a row for ingredient A
 *  can never authorize ingredient B), and `operation_id` names the callable op.
 *
 *  `risk_tier` is a DISPLAY badge + the "asks" mark only (write/destructive → the
 *  per-action approval fires) — NEVER an authorization key. Two different
 *  ingredients under the same tool may each declare a same-named op; they are
 *  DISTINCT entries (distinct `catalog_slug`) and distinct reachability rows. */
export interface CliToolOpEntry {
  /** The callable op id — the reachability key's `operation_id`. */
  operation_id: string;
  /** The cli catalog slug that declares this op — the reachability key's
   *  `ingredient_id`. */
  catalog_slug: string;
  /** The op's declared risk tier (`read` / `write` / `admin` / `destructive`) —
   *  a display badge + the per-action approval signal, never an authorization
   *  key. */
  risk_tier: string;
}

/** One row of the §7.2 "Local tools" surface — an installed cli TOOL (a local
 *  binary: `whisper` / `ffmpeg` / `magick` / `docling`) with everything the UI
 *  needs to render its per-op toggles and map each toggle to the underlying
 *  reachability row.
 *
 *  A tool is human-legible vocabulary, NOT the authorization key: the Gateway
 *  authorizes a dispatched cli op by per-(principal × cli-INGREDIENT ×
 *  operation) reachability, keyed on the catalog slug — and a single tool maps to
 *  ≥1 cli catalog ingredient (`catalog_slugs`). So the tool's per-op toggles
 *  (`operations`) each carry their own `catalog_slug` + `operation_id`, and one
 *  toggle writes exactly one `cli.reachability.set` row (no fan-out). */
export interface CliToolGridEntry {
  /** The tool key (the local binary the catalog invokes — `cliToolFrom-
   *  ConnectorRuntime`: `entry_point`, else the `system_binary:` package_ref). */
  tool: string;
  /** Every installed cli catalog slug that invokes this tool, in manifest order.
   *  The reachability rows are keyed by these (per op), not by `tool`. */
  catalog_slugs: string[];
  /** Every callable op across the tool's catalog slugs, each carrying its
   *  declaring slug + risk badge. The UI renders one per-op toggle per entry;
   *  toggling writes ONE `cli.reachability.set` for `(principal, catalog_slug,
   *  operation_id)` (one reachability row per op — no fan-out). */
  operations: CliToolOpEntry[];
  /** D-182 — whether the tool's local binary is reachable on the server's PATH
   *  (a readiness probe at universe-read time). `false` ⇒ the binary isn't
   *  installed / not on PATH — the run-time `CLI_TOOL_NOT_FOUND` story, surfaced
   *  PROACTIVELY so the Local-tools surface shows "not installed" before a run.
   *  `undefined` ⇒ not probed (db-less / pre-wire harness, or no probe wired).
   *  Vocabulary only — it does NOT gate authorization (the gateway keys on the
   *  per-(principal × ingredient × op) reachability grant, not on this). */
  reachable?: boolean;
}

/** `cli.reachability.universe` response — the installed cli-tool universe the
 *  Local-tools surface renders its tool rows + per-op toggles from. The UI JOINS
 *  this (tools + ops) with `cli.reachability.list` (the granted rows) and
 *  `collection.contract.listContracts` (the contract rows = Owner + each
 *  door/agent). Pure read over the installed manifest snapshot — a cheap derive,
 *  no store scan. Empty `tools` when no cli catalog is installed. */
export interface CliReachabilityUniverseResponse {
  tools: CliToolGridEntry[];
}
