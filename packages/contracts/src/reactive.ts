/** D-115 — Reactive recipes contracts.
 *
 *  Schema-time shapes + runtime constants shared between extension SW
 *  scheduler, server scheduler, executor, audit log, and validator.
 *  Engine wiring is implemented in later phases (scheduler core lives
 *  in `@recued/scheduler`; SW + server adapters live in their app
 *  packages); contracts only describe the wire/persisted shapes.
 *
 *  Vocabulary:
 *
 *    - `auto_run`           — recipe-level opt-in for reactive ticks.
 *                             Pairs with `trigger_steps` to gate firings.
 *    - `trigger_steps`      — gate phase that runs before prefetch on
 *                             every tick. Steps must yield TriggerOutput.
 *    - `TriggerOutput`      — `{ should_run, ...data }` envelope all
 *                             trigger-phase ingredients return.
 *    - `process_id`         — UUID grouping every tick of one reactive
 *                             install. Retired on stop / pause /
 *                             uninstall / version_bump / circuit_broken.
 *    - `CircuitBreakerState` — per-recipe consecutive-failure counter
 *                             that auto-disables a runaway ticker.
 *
 *  Spec: docs/d-115-spec.md.
 */

import type { VariableDefault } from './recipe.js';

/** Extension SW alarm floor (chrome.alarms, MV3 constraint).
 *  30s in unpacked dev, effectively 1 min in stable Chrome. Authors
 *  asking for sub-floor intervals on the extension are clamped up to
 *  this value; the same recipe on a server runs at the requested
 *  interval down to AUTO_RUN_SERVER_FLOOR_MS. */
export const AUTO_RUN_EXTENSION_FLOOR_MS = 30_000;

/** Server tick floor — setTimeout runs unbounded, but we cap to avoid
 *  accidental busy-loops. */
export const AUTO_RUN_SERVER_FLOOR_MS = 250;

/** Circuit breaker: N consecutive failures before auto-disable. */
export const CIRCUIT_BREAKER_THRESHOLD = 5;

/** D-116 — Maximum ms a single `wait` transform may request. Above this
 *  the validator errors out; authors should use `auto_run` + the dynamic
 *  `next_run_at` hint instead of blocking a single run for minutes. */
export const WAIT_TRANSFORM_MAX_MS = 60_000;

/** D-116 — Kitchen trigger-test idempotency window. Repeated test fires
 *  within this window reuse the cached result so an author rapid-clicking
 *  "Test trigger" doesn't burn warehouse-rpc quota. */
export const TRIGGER_TEST_DEDUPE_MS = 1_500;

/** D-116 — Marketplace tag namespace for starter templates. Recipes
 *  with any tag matching `template:*` surface in the gallery; the
 *  segment after the second colon is the vertical (e.g.
 *  `template:reactive:crm`, `template:reactive:mail`). Reserved for the
 *  `recued-core` handle + any explicitly whitelisted template publishers
 *  — third-party recipes carrying `template:` are stripped at publish. */
export const TEMPLATE_TAG_PREFIX = 'template:';

/** Why a `process_id` was retired. Recorded on the install registry
 *  entry when the previous process_id is rotated out. */
export type ProcessRetireReason =
  | 'stopped'          // user clicked Stop
  | 'paused'           // user clicked Pause
  | 'uninstalled'      // recipe removed
  | 'version_bump'     // recipe upgraded; new process_id issued
  | 'circuit_broken';  // auto-disable after N failures

/** Recipe-level opt-in for reactive auto-run ticks. Coexists with
 *  the existing `schedule` (cron) regime — authors pick one or the
 *  other based on whether they want short-reactive (auto_run) or
 *  precise long-interval (cron) timing. Both can be present, but
 *  the engine treats them as independent regimes. */
export interface AutoRunSpec {
  /** Static interval in ms. The extension SW clamps this up to
   *  AUTO_RUN_EXTENSION_FLOOR_MS; the server clamps to
   *  AUTO_RUN_SERVER_FLOOR_MS. */
  interval_ms: number;
  /** When true, the engine reads `{{next_run_at}}` after each run
   *  and uses that as the next fire time. Falls back to
   *  `interval_ms` when the recipe doesn't write one. Default false. */
  dynamic?: boolean;
  /** Initial user-intent state when no runtime setting exists yet.
   *  Defaults to true for compatibility with existing reactive recipes.
   *  Set false when installation must expose the recipe in Automation
   *  without putting it in the live scheduler roster until the owner
   *  explicitly configures and enables it. */
  default_enabled?: boolean;
}

/** Output contract for ingredients used in the `trigger_steps` phase.
 *  Any ingredient CAN be used as a trigger step as long as it
 *  conforms — watcher-family ingredients (mail-watcher, file-watcher,
 *  etc.) are opinionated implementations that bundle the polling +
 *  filter logic.
 *
 *  Trigger-phase semantics:
 *    - All steps run; AND-gate over `should_run`.
 *    - Any `should_run: false` short-circuits the tick silently — no
 *      audit entry, no notification, no side effect.
 *    - All other fields land on `{{trigger.<step_id>.<field>}}` for
 *      prefetch + steps to consume. */
export interface TriggerOutput {
  should_run: boolean;
  /** Arbitrary data the watcher hands down. Accessible to prefetch +
   *  steps as `{{trigger.<step_id>.<field>}}`. */
  [field: string]: unknown;
}

/** Per-recipe circuit-breaker state. Lives alongside the install
 *  registry entry — extension persists in IDB, server in SQLite.
 *  Counter behaviour:
 *    - `success`         → counter resets to 0.
 *    - `failed`          → counter += 1.
 *    - `skipped`         → counter unchanged (trigger returned false).
 *    - `skipped_overlap` → counter unchanged (concurrency=1 drop).
 *    - `counter ≥ CIRCUIT_BREAKER_THRESHOLD` → auto_disabled = true.
 *  User action `resetCircuit` clears the counter + flag. */
export interface CircuitBreakerState {
  recipe_id: string;
  consecutive_failures: number;
  auto_disabled: boolean;
  last_failure_at?: number;
  last_failure_reason?: string;
}

/** Reactive-substrate slice 1 — merged per-recipe auto-run status row
 *  served by the `auto_run.list` rpc. Joins three server-side sources
 *  over the definitional `recipe.auto_run` roster:
 *
 *    - the user-intent settings store (`enabled` — the arm/disarm
 *      toggle this rpc surface exists to expose; mirrors the
 *      event-trigger `enabled` model),
 *    - the persisted circuit-breaker store (`auto_disabled` +
 *      failure provenance),
 *    - the LIVE scheduler roster (`next_run_at` / last-run stamps —
 *      `null` when the entry isn't armed: user-disabled recipes drop
 *      out of the roster entirely, and a just-booted server may not
 *      have armed yet).
 *
 *  `enabled` (user intent) and `auto_disabled` (failure state) are
 *  deliberately separate axes: the UI presents one effective switch
 *  (`enabled && !auto_disabled`) but re-arming a tripped circuit and
 *  pausing a healthy recipe are different user actions with different
 *  audit meaning. */
export interface AutoRunStatusEntry {
  recipe_id: string;
  publisher_id: string;
  /** Display name from `recipe.metadata.name`; null when the stored
   *  JSON is unreadable or carries no name. */
  recipe_name: string | null;
  interval_ms: number;
  dynamic: boolean;
  /** User-intent toggle. An explicit settings row wins; otherwise this
   *  reflects `recipe.auto_run.default_enabled ?? true`. `false` keeps
   *  the recipe out of the scheduler roster entirely. */
  enabled: boolean;
  /** Circuit-breaker auto-disable flag (failure axis). */
  auto_disabled: boolean;
  consecutive_failures: number;
  last_failure_at: number | null;
  last_failure_reason: string | null;
  /** Live roster fields — null when the entry isn't currently armed. */
  next_run_at: number | null;
  last_started_at: number | null;
  last_finished_at: number | null;
  /** D-179 — the config the recipe's headless auto-run fires use, read
   *  from the current managed config dish (`auto_run_settings.dish_id`).
   *  `{}` when no config is set (fires on recipe defaults). Surfaced so
   *  the arm/resume UI can pre-fill the variable widgets. */
  config_overlay: Record<string, unknown>;
  /** D-179 — the recipe's variable DEFINITIONS (labels/kinds/defaults),
   *  so the arm/resume config editor can render the widgets without a
   *  separate recipe fetch. `{}` when the recipe declares none. */
  variables: Record<string, VariableDefault>;
}
