/** Phase G (D-109) — event trigger shared types.
 *
 *  Event triggers bind a `(pattern, recipe_id, publisher_id)` tuple to
 *  the warehouse bus. When an event matching `pattern` fires, the
 *  server dispatches the bound recipe to `serverExecutor.executeRecipe`
 *  with the event payload riding on `context.event`.
 *
 *  Pattern syntax is `WarehouseEventBus.subscribe`: `.`-delimited
 *  segments plus `*` (single segment) and `**` (zero-or-more segments)
 *  wildcards. Examples:
 *    `data.email.work.**.created`  — any new email on the `work` slug
 *    `data.file.*.created`          — new files on any file slug
 *    `data.webhook.github.*`        — any webhook-kind event
 *
 *  Persistence lives in `event_triggers` SQLite table (server-side).
 *  Schema_version bumps 1 → 2 when the table lands; the archive format
 *  version is unchanged (triggers live in `*.recued.archive` as a
 *  dedicated table). */

/** Per-trigger ULID. 26 chars, sortable, base32-encoded. */
export type EventTriggerId = string;

/** Subscribe pattern — `.`-delimited segments with `*` + `**` wildcards. */
export type EventTriggerPattern = string;

/** Where a trigger row came from (poll-manager / G6 slice).
 *
 *  - `'user'` — authored via `triggers.create` (the rpc surface / a
 *    future Kitchen picker). Fully user-managed: update + delete.
 *  - `'recipe'` — materialized by the declarative reconciler from an
 *    installed recipe's `event_triggers` field. The ROW is managed by
 *    the reconciler (created on install, removed on uninstall — a
 *    manual `triggers.delete` would be undone by the next reconcile),
 *    but the `enabled` toggle stays the user's: disarm survives
 *    reconciles, so governance keeps the arm/disarm say over recipe-
 *    declared automation without forking the dispatch path. */
export type EventTriggerOrigin = 'user' | 'recipe';

/** One persisted trigger row. Surfaced via `triggers.list` and the
 *  three mutation methods (`triggers.create` / `update` / `delete`). */
export interface EventTrigger {
  /** Server-assigned ULID. Stable across updates. */
  trigger_id: EventTriggerId;
  /** Target recipe. Must be installed on the server at dispatch time
   *  (missing recipes → auto-disable + `TRIGGER_RECIPE_NOT_INSTALLED`
   *  on the next fire). */
  recipe_id: string;
  /** Publisher handle scoping the recipe install. `'local'` for
   *  user-saved installs. */
  publisher_id: string;
  /** Bus pattern. Validated via `WarehouseEventBus.isValidPattern`
   *  at create / update time; invalid patterns reject with
   *  `TRIGGER_PATTERN_INVALID`. */
  pattern: EventTriggerPattern;
  /** True while the trigger should fire. Set false by the user OR by
   *  the auto-disable path when `error_count_24h` crosses
   *  `triggers.auto_disable_after_errors_24h`. */
  enabled: boolean;
  /** Unix-ms of the CREATE. */
  created_at: number;
  /** Unix-ms of the most recent dispatch (successful or not). Null
   *  when the trigger has never fired. */
  last_fired_at: number | null;
  /** Most recent dispatch error message. Cleared on the first success
   *  after a failure, so a user editing the trigger sees a clean slate
   *  once the fix sticks. */
  last_error: string | null;
  /** D-179 P2 — standing dish this trigger dispatches as. The per-row
   *  config override (`config_patch`, retired in this slice — the
   *  latent dish row that proved the shape) is replaced by the dish's
   *  `config_overlay`, resolved inside `handleExecute` at dispatch
   *  (dish → install → defaults). Absent ⇒ the run is dishless
   *  (ephemeral attribution), exactly like a manual run. Fire-time
   *  honors `dish.enabled`: a disabled dish SKIPS silently (the
   *  attachment stays armed; no failed-run noise). */
  dish_id?: string;
  /** D-179 — the config the trigger's headless fires use, read from the
   *  bound dish at list time (absent ⇒ fires on recipe defaults). Surfaced
   *  so the run modal's per-row Config editor can pre-fill the widgets.
   *  Not persisted on the trigger row — the dish is the source of truth. */
  config_overlay?: Record<string, unknown>;
  /** Poll-manager (G6) — this subscriber's poll-interval preference
   *  when the pattern targets a `data.connection.api.<vendor>.
   *  <entity>.…` watch. The effective interval per watch key is `min`
   *  over subscriber preferences, floored at
   *  `WATCH_MIN_POLL_INTERVAL_MS`. (D-179 P2 lifted this out of the
   *  retired `config_patch` grab-bag into a dedicated infra field —
   *  it is a trigger-row knob, not recipe config.) */
  watch_interval_ms?: number;
  /** Row provenance — `'user'` (authored via `triggers.create`) or
   *  `'recipe'` (materialized from an installed recipe's declarative
   *  `event_triggers` by the reconciler). Recipe-origin rows are
   *  lifecycle-managed by the reconciler; clients hide Remove for them
   *  and show a "from recipe" badge. The `enabled` toggle works the
   *  same for both. */
  origin: EventTriggerOrigin;
  /** Authoring-sugar compile-down — dispatch filter: dot-paths into
   *  the dispatch payload → expected scalar (AND). Evaluated read-free
   *  by the dispatcher BEFORE enqueueing a fire; a missing payload
   *  path PASSES (fidelity layering — doorbell-shaped reconciler
   *  events carry no `record`, and over-fire beats silent-dead; see
   *  `matchesTriggerDispatchFilter`). Materialized from a raw entry's
   *  `filter` or a sugar entry's `where`; absent on user-authored rows
   *  (no rpc surface yet). */
  filter?: Record<string, unknown>;
  /** Authoring-sugar compile-down — changed-fields gate: fire only
   *  when the event's `changed_fields` intersects (any-of). Events
   *  without `changed_fields` PASS (only poll-sourced `updated` events
   *  carry the list). Materialized from a sugar entry's `fields`. */
  fields?: string[];
}

/** Context the server injects into `executeRecipe` when a trigger
 *  fires. Rides on `context.event` so recipes access it via
 *  `{{context.event.*}}`. The shape mirrors `WarehouseBusEvent` from
 *  `@recued/warehouse-events` — redeclared here so contracts can type
 *  the ext-side renderer without pulling warehouse-events. */
export interface TriggerDispatchContext {
  /** The pattern segment array that matched (e.g. `['data','email',
   *  'work','12345','created']`). Useful for recipes that want to
   *  know which sub-path fired them. */
  topic: readonly string[];
  /** Event kind — the last segment of `topic` (`created` / `updated` /
   *  `deleted` / custom). */
  kind: string;
  /** Structured payload describing the warehouse event. D-124 Phase 1
   *  tightened this from `unknown` so recipes can rely on a stable
   *  shape across collections. `prev` is populated for `updated` and
   *  `deleted` events (per-collection canonical hot-fields snapshot,
   *  collection-defined shape) and absent for `created` / `synced`. */
  payload: TriggerEventPayload;
  /** Trigger row id — lets recipes that fan out cross-correlate firings. */
  trigger_id: EventTriggerId;
}

/** Wire shape recipes see at `{{context.event.payload.*}}`. The
 *  identifier-shaped fields (`record_id`, `platform`, `slug`,
 *  `entity_type`) are always present; `prev` rides on the non-
 *  `created`/`synced` events and is collection-defined. Authors
 *  read fields like `{{context.event.payload.prev.start_at}}`
 *  knowing the per-collection shape from the trigger pattern they
 *  subscribed to. */
export interface TriggerEventPayload {
  record_id: string;
  at: number;
  platform: string;
  slug: string;
  entity_type: string;
  /** Prior canonical hot-fields snapshot. Present for `updated` and
   *  `deleted`; absent for `created` and `synced`. Per-collection
   *  shape — recipes read fields the collection populates (e.g.
   *  `prev.start_at` for calendar, `prev.subject` for mail,
   *  `prev.path` for file metadata). Poll-manager (G6) events carry
   *  the full prior CANONICAL projection here. */
  prev?: Record<string, unknown>;
  /** The fresh canonical projection of the changed record at detection
   *  time. Present on poll-sourced (G6) AND reconciler-/webhook-sourced
   *  (D-128 pipeline) `created` / `updated` events so the fired recipe
   *  can read the watched entity WITHOUT re-fetching it (the change
   *  event is the freshness oracle; downstream secondary reads cache
   *  normally). The reconciler emits its meta snapshot minus stamping
   *  fields — meta keys are the canonical projection vocabulary, so
   *  both sources speak the same `record.<field>` language. Absent on
   *  adapter-sourced events (mail / calendar / file — those recipes
   *  re-read via their own fetch step) and on `deleted` (no current
   *  state — `prev` carries the last known projection). */
  record?: Record<string, unknown>;
  /** Canonical field keys whose values differ from the prior snapshot.
   *  Present on poll- and reconciler-sourced `updated` events whose
   *  prior snapshot carried meta. Dotted keys for nested canonical
   *  fields (`key_dates.close_date`). Recipes gate per-field reactions
   *  with `"{{context.event.payload.changed_fields}} contains stage"`. */
  changed_fields?: string[];
}

// ────────────────────────────────────────────────────────────────
// D-145 PB11 — contact_topic_mention trigger (Person-Specific Automation)
// ────────────────────────────────────────────────────────────────

/** D-145 PB11 — re-export the typed `contact_topic_mention` trigger
 *  shape + membership test from `personal-recipes.ts` under the
 *  triggers namespace.
 *
 *  Recipes carrying `trigger: { kind: 'contact_topic_mention',
 *  contact_id, topic }` fire when the engine's AIOutput dispatcher
 *  surfaces an `ExtractionEvent` with `subject_contact_id` matching
 *  AND a topic surface that resolves to the entry's topic.
 *
 *  The full validator + matcher live in `personal-recipes.ts`; this
 *  module just owns the trigger-kind registration so the union of
 *  recipe-side trigger shapes (warehouse-bus / contact_topic_mention)
 *  reads from one file.
 *
 *  Spec: `docs/d-145-spec.md` § B.12. */
export type {
  ContactTopicMentionTrigger,
} from './personal-recipes.js';
export {
  isContactTopicMentionTrigger,
} from './personal-recipes.js';

/** Context the engine injects into `recipe.invoke` when a
 *  `contact_topic_mention` trigger fires. Rides on `context.event`
 *  like the warehouse-event dispatch context, with
 *  `kind: 'contact-topic-mention'` discriminating from those.
 *
 *  `source_event_index` cross-correlates back into the AIOutput
 *  events array — recipes that want the extracted args (e.g. the
 *  travel_event summary) can pull them via `{{context.event.payload.
 *  args.*}}` once a live caller wires the payload through the
 *  orchestrator. */
export interface ContactTopicMentionDispatchContext {
  readonly kind: 'contact-topic-mention';
  /** Substrate-stable contact id whose `personal_recipes` entry
   *  matched. */
  readonly contact_id: string;
  /** The topic label on the matched entry (NOT the lower-cased
   *  normalized form — recipes see the user's label verbatim). */
  readonly topic: string;
  /** The extraction event kind that surfaced the topic. Recipes can
   *  branch on `extraction.commitment` vs `extraction.plan` etc. */
  readonly source_event_kind: string;
  /** Index into the AIOutput.events[] array that fired the match.
   *  Stable per turn; lets a recipe correlate back to the
   *  Transparency Stream event id. */
  readonly source_event_index: number;
  /** Unix-ms of the dispatch. */
  readonly at: number;
}
