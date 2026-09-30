/** D-179 P1 — Dishes: execution instances. D-319 — a dish is a recipe
 *  switched on.
 *
 *  A recipe is a paper record — pure JSON, infinitely instantiable. A
 *  **dish** is one set of its settings, a name and an On/Off switch:
 *  "I have 10 repos on the same recipe" = ten named dishes of one template.
 *  Everything that starts the recipe on its own belongs to one dish and runs
 *  with its settings — each trigger the recipe declares (one copy per dish),
 *  each trigger the owner adds, each schedule, and its auto-run timer (one
 *  per dish). The switch governs only those: a run by hand is never
 *  gated by it. Settings are edited in place; each run records the settings
 *  it ran with (`config_snapshot` on its audit anchor, beside `dish_id`).
 *
 *  A recipe's first dish is its MAIN dish (`is_default`, formerly the
 *  install-config dish). A run that names no dish — chat, MCP, a door, a
 *  recipe calling another — uses its settings under the run's own values.
 *
 *  Which settings a run uses, lowest first:
 *  - as a dish: its group's ‹ the dish's ‹ the values given for this run;
 *  - with no dish: the main dish's ‹ the values given for this run;
 *  - resumed or reviewed: the settings it was approved with, replayed.
 *  The D-177 action-identity hash basis is post-resolution, so grants need
 *  nothing (D-179 spec § 2.5).
 *
 *  Two lifetimes:
 *  - **Standing dish** — a persisted row (this shape).
 *  - **Ephemeral dish** — a run with no `dish_id` mints an
 *    `dsh:eph:<run_id>` id for audit attribution only; nothing is
 *    persisted and no continuity state attaches.
 *
 *  Spec: D-179 (RATIFIED 2026-06-12), D-319.
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
  /** User-facing name ("repo: recued-dev"). `''` while it needs none: a
   *  recipe with one dish shows it under the recipe's own name (D-319). */
  name: string;
  /** D-319 — the recipe's MAIN dish: its first, and the one a run that names
   *  no dish takes its settings from. At most one per recipe (a partial
   *  unique index); the server sets it — never the caller. */
  is_default: boolean;
  /** The dish's settings, edited in place (D-319). */
  config_overlay: Record<string, unknown>;
  /** D-319 — the switch. Off, none of the dish's triggers, schedules or its
   *  auto-run timer fire; a run by hand is not gated by it. */
  enabled: boolean;
  /** D-179 P3 — dish-group membership (≤ 1 group per dish). The group's
   *  shared `config_overlay` merges UNDER this dish's own overlay. Absent ⇒
   *  free dish. */
  group_id?: string;
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
 *  still NOT the whole `AuditEntry`: the full error payloads stay
 *  server-side. History answers "what has this dish done, and with what".
 *
 *  🔑 A dish's history OUTLIVES the dish. `dish_id` is only an audit-row
 *  field, so these rows keep answering for a dish that was removed. That is
 *  the RETIRED case, and a surface must render it as retired, never as an
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
  /** D-319 — the settings the run ran with (its `config_snapshot`). A dish's
   *  settings are edited in place, so this — not the dish — is what a past
   *  run used. `null` when the audit row recorded none. */
  config: Record<string, unknown> | null;
}

/** Prefix for dish-group ids. */
export const DISH_GROUP_ID_PREFIX = 'dgrp_';

/** D-179 P3 — a dish group: a free-floating named group of dishes =
 *  one workflow instance ("this repo's issue pipeline"). Deliberately
 *  CROSS-pack (spec § 3): the pack stays the distribution / grant
 *  unit; the group is the workflow container. It carries one shared
 *  config overlay member dishes inherit (a run as a member takes the
 *  group's ‹ the dish's ‹ its own values — D-319) and is the
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
