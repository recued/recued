/** D-148 § A.4.3 — internal-step grey-text stream.
 *
 *  Recipe runs emit `internal_step.<recipe_run_id>` broadcast events
 *  carrying compact one-line summaries of internal actions ("checking
 *  memory for mom's recent context...", "lookup mom's email", etc).
 *  The webclient appends each summary to a per-run feed; clicking a
 *  row expands to the full provenance audit row (D-120 substrate).
 *
 *  This module owns the per-run aggregator + the rendering hooks. It
 *  caps each run's history at a configurable limit so a long-running
 *  reactive recipe can't grow the in-memory feed without bound.
 *
 *  D-145 fills the substrate for `summary` text generation; D-148 P4
 *  ships the rendering substrate.
 */

import type { WebclientInternalStepEntry } from '@recued/contracts';

export const INTERNAL_STEP_DEFAULT_RUN_HISTORY = 64;

export type InternalStepListener = (
  recipe_run_id: string,
  entries: ReadonlyArray<WebclientInternalStepEntry>,
) => void;

export interface InternalStepStream {
  /** Append a step entry to its run's feed. Idempotent on duplicate
   *  `(recipe_run_id, step_id, ts)` triples — the stream coalesces
   *  duplicate broadcasts (e.g. on cursor replay). */
  push(entry: WebclientInternalStepEntry): void;
  /** Read every entry for a given run, in insertion order. Returns
   *  empty array when the run has no entries. */
  history(recipe_run_id: string): ReadonlyArray<WebclientInternalStepEntry>;
  /** Subscribe to per-run updates. Listener fires after every push
   *  with the freshly-updated history. Returns an unsubscribe fn. */
  subscribe(listener: InternalStepListener): () => void;
  /** Drop a run's history (call when the run is concluded + the user
   *  has acknowledged the resolution UI). */
  clearRun(recipe_run_id: string): void;
  /** Wipe every run's history — used by "Clear this browser" + on
   *  large-session reset. */
  clearAll(): void;
  /** Diagnostic — total entry count. */
  size(): number;
}

const dedupeKey = (e: WebclientInternalStepEntry): string =>
  `${e.recipe_run_id}|${e.step_id}|${e.ts}`;

export const createInternalStepStream = (
  options: { history_cap_per_run?: number } = {},
): InternalStepStream => {
  const cap = options.history_cap_per_run ?? INTERNAL_STEP_DEFAULT_RUN_HISTORY;
  const runs = new Map<string, WebclientInternalStepEntry[]>();
  const dedupe = new Map<string, Set<string>>();
  const listeners = new Set<InternalStepListener>();

  return {
    push(entry) {
      let arr = runs.get(entry.recipe_run_id);
      if (!arr) {
        arr = [];
        runs.set(entry.recipe_run_id, arr);
      }
      let seen = dedupe.get(entry.recipe_run_id);
      if (!seen) {
        seen = new Set();
        dedupe.set(entry.recipe_run_id, seen);
      }
      const key = dedupeKey(entry);
      if (seen.has(key)) return;
      seen.add(key);
      arr.push(entry);
      // Keep the trailing window — drop the oldest entry past the cap.
      if (arr.length > cap) {
        const dropped = arr.shift();
        if (dropped) seen.delete(dedupeKey(dropped));
      }
      const snapshot = [...arr];
      for (const l of [...listeners]) {
        try {
          l(entry.recipe_run_id, snapshot);
        } catch {
          // Renderer errors are isolated.
        }
      }
    },
    history(recipe_run_id) {
      return runs.get(recipe_run_id) ?? [];
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clearRun(recipe_run_id) {
      runs.delete(recipe_run_id);
      dedupe.delete(recipe_run_id);
    },
    clearAll() {
      runs.clear();
      dedupe.clear();
    },
    size() {
      let total = 0;
      for (const arr of runs.values()) total += arr.length;
      return total;
    },
  };
};
