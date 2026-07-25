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
}

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
 *  ⛔ NOT BACKED FOR `auto_run` (audited 2026-07-17, d-120-spec.md
 *  § context.recipe.* durability → AS BUILT). The design's "reactive
 *  recipes snapshot at process boundaries (`ProcessRetireReason`)"
 *  was never implemented: `ProcessRetireReason` has no handler, and
 *  `auto-run-handler.ts` holds `Pick<DishContextStore, 'clear'>` — it
 *  cannot `set`. The host write is gated `trigger_source !==
 *  'auto_run'`. Reads still resolve (the store is re-injected), so a
 *  reactive read returns `undefined` FOREVER and any gate on it is
 *  always true — silently. Use `data.shared` for a reactive cursor;
 *  the authoring path rejects the pattern (`context_recipe_in_auto_run`).
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
