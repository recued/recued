/** D-116 Phase 3 — shared shapes for the Kitchen "Test trigger" flow.
 *
 *  The extension Kitchen authors a one-click surface against live data:
 *  dispatch ONE trigger-phase step through the normal
 *  ingredient-executor chain, capture the resolved TriggerOutput, and
 *  render vault-redacted inputs + output in a side panel. Repeated
 *  fires within `TRIGGER_TEST_DEDUPE_MS` reuse a cached result so
 *  rapid clicks don't burn warehouse-rpc quota.
 *
 *  Results are written to a SEPARATE audit store (`triggered_test`
 *  IDB collection on the extension, `triggered_test` SQLite table on
 *  the server) — never the main audit log. That keeps production
 *  history clean and lets the user wipe test history without losing
 *  real runs. */

/** Redacted representation of a vault value in a test result. The
 *  length is exposed so a user with a 40-char token can distinguish
 *  it from a 24-char one; the value itself never leaves the vault. */
export interface RedactedVaultValue {
  redacted: true;
  length: number;
}

export type TriggerTestInputValue = unknown | RedactedVaultValue;

/** One cached trigger-test result. Stable hash of the resolved input
 *  is the dedupe key; the runtime compares `(recipe_id, step_id, hash)`
 *  against `TRIGGER_TEST_DEDUPE_MS` before re-dispatching. */
export interface TriggerTestResult {
  recipe_id: string;
  step_id: string;
  /** Ingredient slug that was dispatched. */
  ingredient: string;
  /** Resolved input with `{{vault.*}}` values redacted. Safe to
   *  render in the Kitchen side panel; never shown with real tokens. */
  inputs_received: Record<string, TriggerTestInputValue>;
  /** The ingredient's response. For watcher-family slugs this is a
   *  `TriggerOutput`. For trigger-phase transforms it's a plain
   *  object; the caller inspects `should_run`. */
  output: Record<string, unknown>;
  /** Convenience copy of `output.should_run`. */
  should_run: boolean;
  /** True when this result came from the dedupe cache (UI renders a
   *  faded "stale" badge if `Date.now() - at >= TRIGGER_TEST_DEDUPE_MS`). */
  cached: boolean;
  /** epoch-ms timestamp of the original fire. Used for staleness
   *  display + cache TTL comparison. */
  at: number;
}

/** Pair-rpc payload for `runtime.testTrigger`. The server-side path
 *  is opt-in: Kitchen forwards the call when the recipe targets a
 *  warehouse-routed watcher (mail / file / calendar) so the server
 *  warehouse can evaluate it. `dry_run: true` is the only mode — the
 *  server never commits the trigger-test to the main audit log. */
export interface TriggerTestRequest {
  recipe_id: string;
  step_id: string;
  /** Watcher slug the step dispatches. The server handler narrows
   *  this to the closed `KernelWatcherSlug` set before calling into
   *  `createWatcherDispatcher`; unknown slugs return an error so
   *  kitchen authoring can fail loud rather than silently. */
  ingredient: string;
  dry_run: true;
  /** Caller-resolved input. The server does NOT re-resolve vault
   *  refs (it doesn't have the extension's vault). Pass the
   *  already-resolved input here; the server's vault answers the
   *  server's own watcher call. */
  resolved_input: Record<string, unknown>;
}

export type TriggerTestResponse = TriggerTestResult;
