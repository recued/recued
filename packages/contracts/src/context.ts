import {
  executionSourceContractId,
  type Actor,
  type ExecutionSource,
} from './commits.js';

/** Typed shapes for fields the engine injects into the `context.*`
 *  namespace at recipe-execution start.
 *
 *  `context.*` is the per-run environment surface — page state, tab
 *  info, runtime capabilities. Recipes reference these via `{{context.…}}`
 *  in any value field, including `skip_when` / `fail_on` conditions.
 *
 *  Each interface in this file describes one well-known field. The
 *  resolver doesn't enforce the shape (the namespace is open via
 *  `RunContext`'s index signature), but a typed interface lets every
 *  caller — sidebar, popup, server — populate the field consistently.
 *
 *  Trigger-event payloads ride on `context.event` and live in
 *  `triggers.ts` (`TriggerDispatchContext`); see there for the
 *  reactive-fire shape. */

/** `context.server` — paired-server reachability snapshot at recipe
 *  start. Recipe authors gate warehouse-dependent steps with:
 *
 *      "skip_when": "{{context.server.available}} equal false"
 *
 *  When no server is paired (anon / free, or pairing dropped), every
 *  caller sets `available: false`. Server-hosted runs always set
 *  `available: true` (the server is calling itself). The optional
 *  `name` mirrors `getServerStatus`'s response so recipes that want
 *  to render the server's display label can. */
export interface ContextServer {
  available: boolean;
  name?: string;
  /** The owner's IANA zone, set by the server on every run it hosts —
   *  `date_parse`'s `time_zone` reads a day in it:
   *
   *      { "transform": "date_parse", "input": "2026-10-20T00:00:00",
   *        "time_zone": "{{context.server.time_zone}}" }
   *
   *  A recipe's date transforms otherwise read the server PROCESS's clock,
   *  which on a server in UTC is hours from the owner's (D-315 slice 7: a
   *  date-only stay booked on the evening before, west of UTC). */
  time_zone?: string;
}

/** `context.caller` — the trusted, minimal recipe-visible projection of
 *  the server-authenticated execution source.
 *
 *  Unlike the open caller-provided `context.*` namespace (and unlike
 *  `context.server`, where a caller snapshot may win), this root is
 *  host-owned. The server strips any supplied `context.caller` and derives
 *  it from `ExecuteRequest.execution_source`; when no source exists the root
 *  is absent. Recipes may use the stable contract identifier for local
 *  participant/role lookup, but it is an identifier, never a bearer secret.
 *
 *      "contract_id": "{{context.caller.contract_id}}"
 */
export interface ContextCaller {
  /** Authenticated dispatch channel (`mcp`, `chat`, `user`, ...). */
  readonly channel: ExecutionSource['channel'];
  /** Authenticated actor class carried by the execution source. */
  readonly actor: Actor;
  /** Contract in force, absent for an unrestricted/source-without-contract run. */
  readonly contract_id?: string;
}

/** Project an authenticated execution source into the deliberately-minimal
 *  recipe-visible caller shape. Channel-specific ids and bearer/token material
 *  stay inside the execution source and are never copied into `context.*`. */
export const contextCallerFromExecutionSource = (
  source: ExecutionSource,
): ContextCaller => {
  const contract_id = executionSourceContractId(source);
  // Exact-object resolver refs preserve identity (`{{context.caller}}` returns
  // this object, not a clone). Freeze the authority projection at its source so
  // an in-process consumer cannot rewrite what a later recipe condition reads.
  return Object.freeze({
    channel: source.channel,
    actor: source.actor,
    ...(contract_id !== undefined ? { contract_id } : {}),
  });
};

/** Install the host-owned caller projection on an otherwise-open runtime
 *  context object. The property itself is non-writable/non-configurable so an
 *  exact `{{context}}` ref cannot replace or delete it; the projected value is
 *  frozen by {@link contextCallerFromExecutionSource}. A source-less run gets
 *  a non-enumerable `undefined` reservation: recipes still observe the root as
 *  absent, while an in-process consumer cannot add a forged value mid-run. */
export const installContextCaller = (
  context: Record<string, unknown>,
  source?: ExecutionSource,
): ContextCaller | undefined => {
  const caller = source === undefined
    ? undefined
    : contextCallerFromExecutionSource(source);
  Object.defineProperty(context, 'caller', {
    value: caller,
    enumerable: caller !== undefined,
    writable: false,
    configurable: false,
  });
  return caller;
};

/** D-148 § A.3.6 — `context.bridge` snapshot at recipe-execution
 *  start. The server populates from its connected-bridges registry;
 *  recipes pre-check via:
 *
 *      "skip_when": "{{context.bridge.online}} equal false"
 *
 *  for graceful skip patterns. When no bridge is connected (or the
 *  recipe runs server-side without a paired bridge), `online: false`
 *  + the engine returns `capacity_gap: bridge_online` if a bridge-
 *  bound ingredient still tries to dispatch.
 *
 *  The capabilities field surfaces bridge-runtime details (Chrome
 *  version, granted origins, MV3 keepalive state) so recipes can
 *  fail-loud rather than silently produce empty outputs when the
 *  bridge is missing a permission. Capabilities matches the
 *  `BridgeCapabilityProfile` shape from `bridge.ts`. */
export interface ContextBridge {
  online: boolean;
  /** Unix-ms timestamp of the active connection's start. Absent when
   *  `online` is false. */
  online_since?: number;
  /** User-set label for the bridge ("work laptop" / "home laptop"). */
  client_label?: string;
  /** Bridge-runtime capabilities. Optional — present when a bridge
   *  is connected; absent when unknown / offline. Shape mirrors
   *  `BridgeCapabilityProfile` (re-exported via the bridge contract). */
  capabilities?: {
    software_version: string;
    chrome_version: string;
    permissions_granted: string[];
    granted_origins: string[];
    offscreen_supported: boolean;
    alarms_supported: boolean;
    user_agent?: string;
  };
}

/** D-120 Phase 4.5 — `context.recipe.*` durability shape.
 *
 *  Cron + manual recipes that need run-to-run continuity reference
 *  prior-run step outputs through `{{context.recipe.<step_id>}}`,
 *  typically wrapped in `coalesce` for first-run safety:
 *
 *      { "id": "prev_total", "transform": "coalesce",
 *        "values": ["{{context.recipe.pipeline_total}}", 0] }
 *
 *  The engine snapshots referenced step outputs at run end and re-
 *  injects on the next run start — for MANUAL + CRON runs only.
 *
 *  ⛔ MANUAL + CRON ONLY, and `auto_run` is now CLOSED — deliberately
 *  out of scope, not pending (2026-07-27; d-120-spec.md
 *  § context.recipe.* durability, AMENDED). The original design's
 *  "reactive recipes snapshot at process boundaries
 *  (`ProcessRetireReason`)" was never built, and will not be:
 *   - the host write is gated `trigger_source !== 'auto_run'`
 *     (`execute-handler.ts`) — deliberate, per-tick writes would thrash;
 *   - `auto-run-handler.ts` holds `Pick<DishContextStore, 'clear'>`, so
 *     the handler the design named cannot `set` at all;
 *   - `ProcessRetireReason` records why a process was rotated. It is NOT
 *     a continuity boundary and never was one in code.
 *
 *  Why closed rather than finished: a snapshot is RESUMPTION ("where was
 *  I?"), and when resumption state is missing the recipe silently redoes
 *  or silently skips work at `success: true` — the read resolves
 *  `undefined`, `coalesce` makes every tick look like a first run, and a
 *  cursor gate is unconditionally true. The seller pack carries the
 *  highest-stakes continuity in the codebase (paid access across billing
 *  cycles) with ZERO engine continuity, by pairing a procedural recipe
 *  with a CONVERGENT write — which has no silent-redo mode, because
 *  re-derivation is the recovery path. That is the sanctioned shape.
 *
 *  ⇒ Reactive continuity: a paired recipe over a convergent write
 *  ({@link ConvergentWriteResult}); a `data.shared` cursor only when the
 *  source has no stable per-record identity to converge on. The authoring
 *  path enforces this (`context_recipe_in_auto_run`, error). Full
 *  guidance: internal design notes.
 *
 *  Field naming convention: keys match recipe step ids. Static
 *  analysis at install extracts the referenced ids from the recipe;
 *  unreferenced step outputs are *not* snapshotted, keeping the per-
 *  dish payload small.
 *
 *  Storage: a SQLite store keyed by `dish_id`
 *  (`backend/server/src/dish-context-store.ts`) — per-pair, no cloud
 *  sync (D-102). ⚠ NOT `prefs.<recipe_id>.context_recipe`: D-179 P1
 *  re-keyed continuity per DISH, so two dishes of one recipe hold
 *  separate state. */
export interface ContextRecipe {
  /** Step output keyed by step_id. Open shape so the engine can store
   *  whatever the prior run produced for the referenced steps. */
  [step_id: string]: unknown;
}
