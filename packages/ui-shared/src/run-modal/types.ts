/** Shared Run | Schedule modal — public types.
 *
 *  ONE modal for launching an installed recipe, reused by the recipes
 *  library page and the chat-composer "Run a recipe" command-palette
 *  (webclient IA §D.L1). Two tabs:
 *   - Run      — variable widgets + raw-JSON config + the targeting guard
 *                (design § 8) + the `execute` rpc.
 *   - Schedule — a CRON-preset time picker + the recipe's existing
 *                schedule rows (pause / resume / remove / add).
 *
 *  The caller types mirror the recipes-route options verbatim so a host
 *  that already wires those rpcs can pass the same closures straight
 *  through. Every caller is optional: a missing one degrades that
 *  affordance to a "not wired" note instead of crashing the modal.
 *
 *  Layering (mirrors `ref-picker/`): `model.ts` = pure state + gate;
 *  `render.ts` = state → HTML string; `wire.ts` = the DOM glue.
 */

import type {
  EventTrigger,
  PreparePreapproval,
  PreapprovalResult,
  RecipeInvocation,
  ServerExecuteResponse,
  ServerRecipeListEntry,
  ServerSchedule,
  MissedSchedulePolicy,
} from '@recued/contracts';
import type { RefPickerSearchCaller } from '../ref-picker/types.js';
import type { RecordRefVariableSearch } from '../record-ref-variable.js';

/** Which tab the modal opens on. A manual recipe's `[Run]` opens `run`;
 *  its `[Schedule]` opens `schedule`; R21's Automation "Add" opens
 *  `schedule` or `trigger`. */
export type RunModalTab = 'run' | 'schedule' | 'trigger';

/** Execute one recipe. Identical shape to the recipes-route
 *  `RecipeExecuteCaller`; `context` carries the filled targeting fields. */
export type RunModalExecuteCaller = (args: {
  recipe_id: string;
  config?: Record<string, unknown>;
  context?: Record<string, unknown>;
  /** D-222 — used by result-surface filters; the ordinary run modal never
   *  authors this member, but keeping the execute seam exact lets hosts share
   *  one caller without a narrowing adapter. */
  invocation?: RecipeInvocation;
}) => Promise<ServerExecuteResponse>;

/** Lists ALL schedules; the modal filters to this recipe's. */
export type RunModalSchedulesListCaller = () => Promise<{
  schedules: ServerSchedule[];
}>;

export type RunModalSchedulesCreateCaller = (args: {
  recipe_id: string;
  publisher_id?: string;
  /** D-215 slice 5 — absent ⇒ `'recurring'` (every pre-slice-5 caller). */
  mode?: 'recurring' | 'one_shot';
  /** Required for `recurring`; the server synthesizes it for `one_shot`. */
  cron_expression?: string;
  /** D-215 slice 5 — the one-shot fire time, epoch ms. */
  run_at?: number;
  /** Config overlay for this schedule's headless fires. The server
   *  mints a managed dish to hold it (empty ⇒ omitted; fires on
   *  recipe defaults). */
  config_overlay?: Record<string, unknown>;
}) => Promise<{ schedule: ServerSchedule }>;

export type RunModalSchedulesUpdateCaller = (args: {
  schedule_id: string;
  /** D-266 — the owner's missed-run policy for this schedule. */
  missed_policy?: MissedSchedulePolicy;
  enabled?: boolean;
  /** D-179 — edit the schedule's headless-fire config (immutably
   *  re-versioned on a managed dish server-side; `{}` clears). */
  config_overlay?: Record<string, unknown>;
}) => Promise<{ schedule: ServerSchedule }>;

export type RunModalSchedulesDeleteCaller = (args: {
  schedule_id: string;
}) => Promise<{ deleted: true }>;

// ── R21 — the Trigger tab (warehouse event-triggers per recipe) ──

/** Lists ALL triggers; the modal filters to this recipe's. */
export type RunModalTriggersListCaller = () => Promise<{
  triggers: EventTrigger[];
}>;

export type RunModalTriggersCreateCaller = (args: {
  recipe_id: string;
  /** Required by the `triggers.create` rpc (the wire layer always sends
   *  `publisherId ?? recipe.publisher_id`). */
  publisher_id: string;
  pattern: string;
  /** Config overlay for this trigger's headless fires. The server mints
   *  a managed dish to hold it (empty ⇒ omitted; fires on recipe
   *  defaults). */
  config_overlay?: Record<string, unknown>;
}) => Promise<{ trigger: EventTrigger }>;

export type RunModalTriggersUpdateCaller = (args: {
  trigger_id: string;
  enabled?: boolean;
  /** D-179 — edit the trigger's headless-fire config (immutably
   *  re-versioned on a managed dish server-side; `{}` clears). */
  config_overlay?: Record<string, unknown>;
}) => Promise<{ trigger: EventTrigger }>;

export type RunModalTriggersDeleteCaller = (args: {
  trigger_id: string;
}) => Promise<{ ok: true }>;

/** The mutable UI state for one open instance. */
export interface RunModalState {
  /** Active tab. */
  tab: RunModalTab;
  /** D-269 — the SERVER's resolved zone, so the one-shot field can say what the
   *  picked time means there.
   *
   *  ⚠ THE ONE-SHOT'S EXECUTION IS NOT WRONG — it stores an absolute instant and
   *  fires exactly when the owner meant. What was missing is the sentence saying
   *  which clock they were reading, which matters once the server may keep a
   *  different one. (The CRON case was a real defect, because a wall clock with
   *  no zone has no answer at all.) */
  server_time_zone?: string;
  // ── Run tab ──
  /** Raw-JSON config (advanced field + the variable-widget sync target). */
  config_text: string;
  /** Filled context-target inputs (design § 8), keyed by target name. */
  target_values: Record<string, string>;
  /** JSON-typed author context supplied by a result action. Kept separate
   *  from the string target inputs so numbers, booleans, arrays, and objects
   *  survive review and dispatch without coercion. */
  context_values: Record<string, unknown>;
  /** A run is in flight (Run button → "Running...", disabled). */
  executing: boolean;
  /** Last run error, surfaced in the result block. */
  run_error: string | null;
  /** Last successful/failed run summary, or null before the first run. */
  result: ServerExecuteResponse | null;
  // ── Schedule tab ──
  /** Loaded schedules (already filtered to this recipe), or null when not
   *  yet loaded / the caller is absent (→ "not available" note). */
  schedules: readonly ServerSchedule[] | null;
  /** D-266 — the missed-run policy the next Add will arm the schedule
   *  with. Chosen WHEN THE SCHEDULE IS WRITTEN, which is the moment the
   *  owner actually knows whether a late run is worth having; editing it
   *  afterwards on the row is the same choice made later, not instead. */
  missed_policy: MissedSchedulePolicy;
  /** The selected "Add schedule" preset CRON expression. */
  preset_expression: string;
  /** D-215 slice 5 — the Repeat toggle. `true` (default) keeps the CRON
   *  preset picker; `false` swaps in the datetime control and creates a
   *  ONE-SHOT.
   *
   *  🔑 One-shot is not a second concept in the IA — it is this toggle off.
   *  The substrate already agrees: `createSchedule` SYNTHESIZES the cron
   *  expression from `run_at`, and `updateSchedule` refuses a cron change
   *  on a one-shot, so cadence is already meaningless there. */
  repeat: boolean;
  /** D-215 slice 5 — the one-shot fire time, as the datetime-local control
   *  reports it. Empty until the owner picks one. */
  run_at_local: string;
  /** A schedule mutation is in flight (disables the schedule controls). */
  mutating: boolean;
  /** Last schedule-tab error. */
  schedule_error: string | null;
  // ── Trigger tab (R21) ──
  /** Loaded triggers (already filtered to this recipe), or null when not
   *  yet loaded / the caller is absent. */
  triggers: readonly EventTrigger[] | null;
  /** The "Add trigger" bus-pattern input (server validates on create). */
  pattern_text: string;
  /** A trigger mutation is in flight. */
  trigger_mutating: boolean;
  /** Last trigger-tab error. */
  trigger_error: string | null;
}

/** Options for `wireRunModal`. */
export interface WireRunModalOptions {
  /** D-269 step 1 — the server's resolved IANA zone, for the scheduled-run
   *  activation stamp. A thunk because the host fetches it once, asynchronously.
   *  ⚠ Absent ⇒ falls back to THIS browser's zone, which is what every caller
   *  did before — so an unwired caller keeps working rather than writing an
   *  empty zone into a durable row. */
  serverTimeZone?: () => string | undefined;
  /** The recipe to run — needs `recipe_id` + `recipe` (for variable
   *  widgets + targeting derivation + the display name). */
  recipe: ServerRecipeListEntry;
  /** DOM factory — pass for non-browser (test) environments. */
  document?: Document;
  /** Tab to open on. Default `'run'`. */
  initialTab?: RunModalTab;
  /** `execute` rpc. Absent → Run shows a "not wired" note. */
  execute?: RunModalExecuteCaller;
  /** D-200 — owner-file inventory search for `type:'file_ref'` variables.
   * Absent keeps a pasteable durable-ref input. */
  fileRefSearch?: RefPickerSearchCaller;
  /** Pack-owned Records inventory for `type:'record_ref'` variables. The
   *  caller is already bound to the recipe's owner and receives the variable's
   *  entity plus its optional equality scope. Absent keeps a raw-id input. */
  recordRefSearch?: RecordRefVariableSearch;
  /** `schedules.list` rpc. Absent → the Schedule tab shows a
   *  "not available" note (and the modal hides the Schedule tab unless
   *  it opened on it). */
  schedulesList?: RunModalSchedulesListCaller;
  schedulesCreate?: RunModalSchedulesCreateCaller;
  schedulesUpdate?: RunModalSchedulesUpdateCaller;
  schedulesDelete?: RunModalSchedulesDeleteCaller;
  /** Prepare one future execution for owner review. This does not activate
   * a schedule or approve anything; the host opens the returned review. */
  preapprovalPrepare?: (request: PreparePreapproval) => Promise<PreapprovalResult>;
  onPreapprovalPrepared?: (result: PreapprovalResult) => void;
  /** `triggers.list` rpc. Absent → the Trigger tab hides (unless the
   *  modal opened on it — then a "not available" note). R21. */
  triggersList?: RunModalTriggersListCaller;
  triggersCreate?: RunModalTriggersCreateCaller;
  triggersUpdate?: RunModalTriggersUpdateCaller;
  triggersDelete?: RunModalTriggersDeleteCaller;
  /** Overrides the publisher threaded into `schedules.create`. Defaults
   *  to the recipe entry's `publisher_id` (recipes-route parity). */
  publisherId?: string;
  /** Fired when the modal closes (Close button / Escape). The host owns
   *  the DOM lifecycle — call the handle's `destroy()` in response. */
  onClose?: () => void;
  /** Fired after a successful run, so the host can route to the Log /
   *  surface the live-control bubble. */
  onRan?: (result: ServerExecuteResponse) => void;
}

/** Imperative handle returned by `wireRunModal`.
 *
 *  Beyond the DOM lifecycle (`element` / `destroy`), the action methods
 *  mirror the user-facing controls so a host can drive the modal
 *  programmatically (e.g. open on the Schedule tab) AND so the flow is
 *  testable without a real DOM — the codebase's fake-document tests can't
 *  dispatch clicks, so they call these directly (same pattern as the
 *  recipes route's `openRunModal` / `confirmRun`). */
export interface RunModalHandle {
  /** The overlay root (backdrop + panel). The host appends it to
   *  `document.body` (or its own portal) and removes it on `destroy`. */
  readonly element: HTMLElement;
  /** Current state snapshot (read-only; for tests/inspection). */
  getState(): Readonly<RunModalState>;
  /** Switch the active tab (re-paints). */
  setTab(tab: RunModalTab): void;
  /** Set the raw-JSON config (mirrors a textarea edit). */
  setConfigText(text: string): void;
  /** Set one context-target value (mirrors a target-input edit). */
  setTargetValue(key: string, value: string): void;
  /** Set the JSON-typed author context prefilled by a result action. */
  setContextValues(context: Record<string, unknown>): void;
  /** Set the selected "Add schedule" preset CRON expression. */
  setPreset(expression: string): void;
  /** D-266 — set the policy the next Add arms the schedule with. */
  setNewMissedPolicy(policy: MissedSchedulePolicy): void;
  /** D-215 slice 5 — flip Repeat. Off ⇒ the next Add creates a one-shot. */
  setRepeat(repeat: boolean): void;
  /** D-215 slice 5 — the one-shot fire time (datetime-local wall clock). */
  setRunAtLocal(value: string): void;
  /** Run the recipe (the `execute` rpc + gate/parse guards). */
  confirmRun(): Promise<void>;
  /** Create a schedule from the selected preset. */
  addSchedule(): Promise<void>;
  /** Prepare the configured one-shot execution without creating a schedule. */
  reviewSchedule(): Promise<void>;
  /** Pause / resume one schedule. */
  toggleSchedule(scheduleId: string, enabled: boolean): Promise<void>;
  /** D-266 — set one schedule's missed-run policy. */
  setMissedPolicy(scheduleId: string, policy: MissedSchedulePolicy): Promise<void>;
  /** Delete one schedule. */
  removeSchedule(scheduleId: string): Promise<void>;
  /** Set the "Add trigger" pattern text (mirrors the input). R21. */
  setPatternText(text: string): void;
  /** Create a trigger from the pattern text. R21. */
  addTrigger(): Promise<void>;
  /** Pause / resume one trigger. R21. */
  toggleTrigger(triggerId: string, enabled: boolean): Promise<void>;
  /** Delete one trigger. R21. */
  removeTrigger(triggerId: string): Promise<void>;
  /** True while a run, schedule mutation, or trigger mutation has no terminal
   *  result yet. Hosts use this to retain the modal across route navigation. */
  hasInFlightWork(): boolean;
  /** Remove listeners + detach the overlay. Idempotent. */
  destroy(): void;
}
