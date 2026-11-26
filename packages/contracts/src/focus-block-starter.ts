import type { ServerRecipeListEntry } from './rpc/server-registry.js';

export const FOCUS_BLOCK_RECIPE_ID = 'focus-block-proposer';
export const FOCUS_BLOCK_PACK = 'daily-ops';
export const FOCUS_BLOCK_PUBLISHER = 'recued-core';

export interface FocusBlocksPreviewRequest {
  calendar_slug: string;
  recipe_hash: string;
}

/** One set of settings for the worked example, the first run and its schedule. */
export const focusBlockStarterSettings = (calendar_slug: string) => ({
  calendar_slug,
  day_offset: 1,
  busy_event_threshold: 4,
  busy_hours_threshold: 4,
  min_block_minutes: 60,
  work_start_hour: 9,
  work_end_hour: 18,
  scan_limit: 100,
});

export const isInstalledFocusBlockStarter = (entry: ServerRecipeListEntry): boolean =>
  entry.recipe_id === FOCUS_BLOCK_RECIPE_ID && entry.publisher_id === FOCUS_BLOCK_PUBLISHER && entry.pack_slug === FOCUS_BLOCK_PACK;

export const isReadableFocusBlockStarter = (entry: ServerRecipeListEntry): boolean =>
  isInstalledFocusBlockStarter(entry) && entry.provably_read_only === true && entry.spends_per_run === false
    && Object.hasOwn(entry.recipe.variables ?? {}, 'calendar_slug') && !entry.recipe.auto_run && !entry.recipe.event_triggers?.length;
