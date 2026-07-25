/** D-122 Phase 6 — marketplace filter chips.
 *
 *  Single horizontal strip of toggle chips covering the facets the
 *  marketplace search supports. The "Alerts" chip ships with D-122 P6
 *  alongside the alert-pack rollout — it filters listings whose recipes
 *  expose an `alert` trigger shape (auto_run + trigger_steps with
 *  time-relative-watcher). Selecting a chip toggles its `tag` value in
 *  the search query's tag set; the marketplace listing returns rows
 *  whose tags include the toggled tag.
 *
 *  Pure render + a tiny pure helper that flips one chip in a tag set —
 *  the host wires `data-action="toggle-marketplace-filter"` clicks
 *  through the event-dispatcher and re-issues the search.
 */

import { e } from '../template.js';

/** One chip in the filter strip. The chip's `tag` corresponds to a
 *  marketplace tag — selecting the chip ANDs the tag into the search
 *  query's `tags[]` filter. */
export interface MarketplaceFilterChip {
  /** Stable key — used for the data-attribute and as the search-state
   *  identifier. */
  id: string;
  /** Display label. */
  label: string;
  /** Tag value the chip toggles in the search query. */
  tag: string;
}

/** Default chip set surfaced on the marketplace landing page. The chip
 *  list itself is plain data so callers can append publisher-specific
 *  chips at a higher layer if needed. */
export const DEFAULT_MARKETPLACE_FILTER_CHIPS: readonly MarketplaceFilterChip[] = [
  { id: 'alerts',     label: 'Alerts',     tag: 'alerts' },
  { id: 'reactive',   label: 'Reactive',   tag: 'reactive' },
  { id: 'calendar',   label: 'Calendar',   tag: 'calendar' },
  { id: 'mail',       label: 'Mail',       tag: 'mail' },
  { id: 'crm',        label: 'CRM',        tag: 'crm' },
];

export interface MarketplaceFilterChipsState {
  /** All chips to render, in display order. */
  chips: readonly MarketplaceFilterChip[];
  /** Currently active chip ids. The chip render flips its
   *  `--active` modifier when its id appears here. */
  active: readonly string[];
}

/** Render the chip strip. Returns an HTML string the host injects into
 *  the marketplace toolbar. Each chip carries `data-action`
 *  + `data-chip-id` so the host's event-dispatcher can route the click. */
export const renderMarketplaceFilterChips = (state: MarketplaceFilterChipsState): string => {
  const activeSet = new Set(state.active);
  const chips = state.chips.map((chip) => {
    const isActive = activeSet.has(chip.id);
    const klass = `marketplace-chip ${isActive ? 'marketplace-chip--active' : ''}`.trim();
    return `
      <button type="button" class="${klass}"
        data-action="toggle-marketplace-filter"
        data-chip-id="${e(chip.id)}"
        data-tag="${e(chip.tag)}"
        aria-pressed="${isActive}">
        ${e(chip.label)}
      </button>
    `;
  }).join('');
  return `<div class="marketplace-chips" role="group" aria-label="Marketplace filters">${chips}</div>`;
};

/** Pure helper — flip one chip's id in an existing active-set and return
 *  the next state. Used by the host's click handler to derive the new
 *  search query without coupling render to mutation. */
export const toggleMarketplaceFilter = (
  active: readonly string[],
  chipId: string,
): string[] => {
  const set = new Set(active);
  if (set.has(chipId)) {
    set.delete(chipId);
  } else {
    set.add(chipId);
  }
  return [...set];
};
