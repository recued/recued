/** D-120 Phase 7.5 — `run_mode` derivation helpers.
 *
 *  The engine itself doesn't track `trigger_source` — hosts pass it
 *  alongside the execute call. This module is the single derivation
 *  point: declarative `recipe.run_mode` wins over inference, otherwise
 *  the trigger source dictates.
 *
 *  Inference rules (when `recipe.run_mode` is absent):
 *
 *    'manual'   → user-initiated one-shot — chat, Run-Now, sidebar UI
 *    'backfill' → cursor-loop / catch-up reads of historical data
 *    'live'     → everything else (cron, reactive, …)
 *                 — the default; any unrecognised trigger source
 *                   conservatively counts as live activity now.
 *
 *  `audit_log.run_mode` gets stamped with the result and the
 *  `data.timeline()` event-axis ordering uses it (alongside `event_at`)
 *  so backfill-emitted links surface on the underlying record's actual
 *  date rather than today.
 *
 *  Spec: D-120 (Phase 7.5).
 */

import type { RunMode } from '@recued/contracts';

/** Closed enumeration of trigger-source strings the engine receives.
 *  Stays as a union of literals (not a Set) so callers' typos surface
 *  at compile time when the trigger source is the literal carrier
 *  itself (e.g. `'manual'` in sidebar.ts). Free strings still work at
 *  runtime via the wider `string` parameter — `deriveRunMode` falls
 *  back to `'live'` for anything it doesn't recognise. */
export const KNOWN_TRIGGER_SOURCES = [
  'manual',
  'backfill',
  'auto_run',
  'mcp',
  'schedule',
  'extension_ws',
  'reactive-remote',
  'server_command',
] as const;

export type KnownTriggerSource = (typeof KNOWN_TRIGGER_SOURCES)[number];

/** Pure derivation. `recipe_run_mode` (declarative) wins; otherwise
 *  fall back to inference from `trigger_source`. Returns `'live'` for
 *  anything unrecognised — defensive default that never hides activity
 *  behind a "discovered today" timestamp.
 *
 *  Examples:
 *    deriveRunMode(undefined, 'manual')   // → 'manual'
 *    deriveRunMode(undefined, 'auto_run') // → 'live'
 *    deriveRunMode(undefined, 'backfill') // → 'backfill'
 *    deriveRunMode('backfill', 'manual')  // → 'backfill' (declarative wins)
 *    deriveRunMode(undefined, undefined)  // → 'live' (defensive default)
 *    deriveRunMode(undefined, 'cron-7am') // → 'live' (unknown → live) */
export const deriveRunMode = (
  recipe_run_mode: RunMode | undefined,
  trigger_source: string | null | undefined,
): RunMode => {
  if (recipe_run_mode === 'live'
   || recipe_run_mode === 'backfill'
   || recipe_run_mode === 'manual') {
    return recipe_run_mode;
  }
  if (trigger_source === 'manual') return 'manual';
  if (trigger_source === 'backfill') return 'backfill';
  // Everything else — cron, auto_run, mcp, schedule, extension_ws,
  // reactive-remote, server_command, plus any free-form trigger source
  // we haven't enumerated — flows to 'live'. The conservative default
  // means a new trigger type doesn't accidentally land in 'manual' or
  // 'backfill' just because the lookup misses.
  return 'live';
};
