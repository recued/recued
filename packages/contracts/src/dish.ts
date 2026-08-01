/** D-179 P1 — Dishes: execution instances.
 *
 *  A recipe is a paper record — pure JSON, infinitely instantiable. A
 *  **dish** is the named execution instance minted when a recipe is
 *  assigned to execution: it carries the long-life identity that audit
 *  attribution, `prefs.<dish_id>` run-to-run continuity, attachment
 *  rows (P2), and config-overlay resolution key on.
 *
 *  Overlay resolution order (spec § 2.4): dish overlay → install
 *  config → recipe variable defaults. The D-177 action-identity hash
 *  basis is post-resolution, so dishes compose with grants / held-
 *  action identity with no new key-space — grants need NOTHING
 *  (spec § 2.5).
 *
 *  Two lifetimes:
 *  - **Standing dish** — a persisted row (this shape), created via
 *    `dishes.create` or implicitly as the recipe's invisible DEFAULT
 *    dish (fork (c): surfaces in UI only once a second dish of the
 *    same recipe exists).
 *  - **Ephemeral dish** — a manual run with no `dish_id` mints an
 *    `dsh:eph:<run_id>` id for audit attribution only; nothing is
 *    persisted and no continuity state attaches.
 *
 *  Spec: D-179 (RATIFIED 2026-06-12).
 */

/** Prefix for standing dish ids. */
export const DISH_ID_PREFIX = 'dsh_';

/** Prefix for ephemeral (manual-run) dish ids — `dsh:eph:<run_id>`.
 *  The `:` makes an ephemeral id structurally distinct from any
 *  persisted `dsh_` row key, so a store lookup can never collide. */
export const EPHEMERAL_DISH_ID_PREFIX = 'dsh:eph:';

/** Mint the ephemeral dish id for a manual run. Pure — derived from
 *  the run's own id so attribution joins need no extra state. */
export const ephemeralDishId = (run_id: string): string =>
  `${EPHEMERAL_DISH_ID_PREFIX}${run_id}`;

/** True for ids minted by `ephemeralDishId` (never persisted). */
export const isEphemeralDishId = (dish_id: string): boolean =>
  dish_id.startsWith(EPHEMERAL_DISH_ID_PREFIX);

/** One standing execution instance of a recipe. */
export interface Dish {
  /** Long-life id, `dsh_` prefixed. */
  dish_id: string;
  /** The recipe template this dish instantiates. */
  recipe_id: string;
  publisher_id: string;
  /** User-facing name ("repo: recued-dev"). The default dish carries
   *  `''` — it renders under the recipe's own name (fork (c)). */
  name: string;
  /** Exactly one default dish per recipe — minted lazily so today's
   *  single-instance installs stay byte-identical until a second dish
   *  appears. */
  is_default: boolean;
  /** Per-dish config overlay, merged OVER install config at dispatch
   *  (dish → install → defaults). */
  config_overlay: Record<string, unknown>;
  /** Disabled dishes refuse dispatch (standing dishes only; P2 wires
   *  attachments to honor this at fire time). */
  enabled: boolean;
  /** D-179 P3 — dish-group membership (≤ 1 group per dish). The group's
   *  shared `config_overlay` merges UNDER this dish's own overlay at
   *  dispatch: dish → group → install → defaults. Absent ⇒ free dish. */
  group_id?: string;
  /** D-179 P5c (owner decision 2026-06-12) — set when this dish was
   *  AUTO-MINTED by enabling a recipe-origin event trigger; carries
   *  the managing trigger row's id. Lifecycle: enable mints (or
   *  re-enables), disable flips `enabled: false` (identity +
   *  continuity survive a disable/enable cycle), recipe uninstall
   *  dissolves (the reconciler deletes the dish + its continuity
   *  snapshot when it removes the managing row). User-assigned dishes
   *  never carry this and are never auto-dissolved. */
  managed_by_trigger_id?: string;
  /** D-179 — set when this dish carries a recipe's AUTO-RUN config; the
   *  value is the owning `recipe_id`. Auto-run config is versioned
   *  immutably: a config change mints a NEW dish and dissolves the prior
   *  (one `dish_id` = one config, so the audit never shows a `dish_id`
   *  with drifting results). `auto_run_settings.dish_id` points at the
   *  current one; superseded dishes are dissolved, never mutated. Managed
   *  ⇒ hidden from the dishes surface + dissolved on recipe uninstall. */
  managed_by_auto_run?: string;
  /** D-179 — set when this dish was AUTO-MINTED to carry the config
   *  overlay a headless SCHEDULE fires with (the schedule/trigger enable
   *  flow has no per-run prompt, so the overlay lives on a managed dish);
   *  carries the managing `schedules.*` row id. Lifecycle mirrors
   *  `managed_by_trigger_id`: `schedules.create` with a non-empty
   *  `config_overlay` mints it, `schedules.delete` dissolves it. A
   *  user-assigned dish never carries this and is never auto-dissolved. */
  managed_by_schedule_id?: string;
  created_at: number; // epoch ms
}

/** D-215 slice 3 — the last-outcome cell a dish row renders.
 *
 *  Projected from the newest `AuditEntry` carrying this dish's id
 *  (`latestByDishes`, one scan for the whole list). Deliberately NOT the
 *  whole entry: the list needs "did it work, and when", and shipping the
 *  full audit row would put `config_snapshot` on the wire for every row.
 *
 *  A dish with no runs is ABSENT from the map rather than present with
 *  nulls — "never run" is a different statement from "ran, no status",
 *  and a caller that conflates them renders a fresh dish as failed. */
export interface DishLastRun {
  run_id: string;
  /** Ingestion time — when the engine recorded the run. */
  started_at: number;
  /** The run anchor's terminal state (`'succeeded'` / `'failed'` /
   *  `'awaiting_approval'` …). Carried verbatim so the surface can
   *  distinguish a hold from a failure. */
  commit_status: string;
}

/** D-215 slice 5 — one run in a dish's history.
 *
 *  A wider projection than `DishLastRun` (which is a single list cell) but
 *  still deliberately NOT the whole `AuditEntry`: `config_snapshot` and the
 *  full error payloads stay server-side. History answers "what has this
 *  queued item done", not "replay the run".
 *
 *  🔑 A dish's history OUTLIVES the dish. `dish_id` is only an audit-row
 *  field — auto-run config versioning dissolves the prior dish on every
 *  change, and a one-shot retires itself on success (§ 5) — so these rows
 *  keep answering for a `dish_id` that no longer resolves. That is the
 *  RETIRED case, and a surface must render it as retired, never as an
 *  error or an empty state. */
export interface DishRunRow {
  run_id: string;
  /** Ingestion time — when the engine recorded the run. */
  started_at: number;
  duration_ms: number;
  /** Run-anchor terminal state (`'succeeded'` / `'failed'` /
   *  `'awaiting_approval'` …). Verbatim, so a HOLD stays distinguishable
   *  from a failure. */
  commit_status: string;
  /** How the run was triggered (`'schedule'` / `'auto_run'` / …), when the
   *  audit row recorded one. */
  trigger_source: string | null;
  /** First error message, when the run failed. */
  error: string | null;
}

/** Prefix for dish-group ids. */
export const DISH_GROUP_ID_PREFIX = 'dgrp_';

/** D-179 P3 — a dish group: a free-floating named group of dishes =
 *  one workflow instance ("this repo's issue pipeline"). Deliberately
 *  CROSS-pack (spec § 3): the pack stays the distribution / grant
 *  unit; the group is the workflow container. It carries one shared
 *  config overlay member dishes inherit (resolution: dish overlay →
 *  group overlay → install config → variable defaults) and is the
 *  unit the UI presents as a pipeline (the wiring graph is derived
 *  from member recipes, never authored — spec § 7). */
export interface DishGroup {
  /** Long-life id, `dgrp_` prefixed. */
  group_id: string;
  /** User-facing name ("recued-dev issue pipeline"). */
  name: string;
  /** Shared overlay inherited by member dishes; each dish's own
   *  overlay wins key-by-key. */
  config_overlay: Record<string, unknown>;
  created_at: number; // epoch ms
}
