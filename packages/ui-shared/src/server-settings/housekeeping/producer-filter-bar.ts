/** R25 — AI-producer filter bar.
 *
 *  Replaces the D-134 8-namespace chip wall (filter-chips.ts) with a
 *  one-line search + a three-way cost toggle. The chip wall's only two
 *  load-bearing axes were `surface` (token cost) and `department`; the
 *  cost toggle folds `surface` into an intuitive All / LLM / Computed
 *  choice and search covers everything else (topic + the user_value
 *  copy), so the intersection-of-chips UX collapses to two controls.
 *
 *  Pure render + a pure `filterProducers` predicate — the host holds
 *  the (mount-local) search string + cost choice and threads them back
 *  as props. Search is case-insensitive substring over the topic slug
 *  and the producer's `user_value`; the cost axis reads the row's
 *  AI-surface flag (LLM = a positive per-record token estimate,
 *  Computed = deterministic / zero-cost).
 *
 *  Spec: internal design notes §R25 (LOCKED) points 2 + 5/7E. */

import type { HousekeepingTaskStatus } from '@recued/contracts';
import { ENRICHMENT_REGISTRY } from '@recued/contracts';
import { e } from '../../template.js';
import { topicFromTaskId } from './detail-drawer.js';

/** The cost axis. `all` = no cost filter; `llm` = AI-surface producers
 *  only (positive per-record token estimate); `computed` = deterministic
 *  producers (zero token cost). */
export type HousekeepingProducerCostFilter = 'all' | 'llm' | 'computed';

export const HOUSEKEEPING_PRODUCER_COST_FILTERS: ReadonlyArray<{
  id: HousekeepingProducerCostFilter;
  label: string;
}> = [
  { id: 'all', label: 'All' },
  { id: 'llm', label: 'LLM' },
  { id: 'computed', label: 'Computed' },
];

/** Action names the host delegates on. Search fires on `input`; the
 *  cost segments fire on `click`. */
export const HOUSEKEEPING_PRODUCER_SEARCH_ACTION = 'housekeeping-producer-search';
export const HOUSEKEEPING_PRODUCER_COST_ACTION = 'housekeeping-producer-cost-filter';

/** True iff the producer is AI-surface — a positive per-record token
 *  estimate. Deterministic producers (`token_estimate_per_record === 0`)
 *  are `false`. Mirrors `enrichment-producer-section.ts`'s row-level
 *  derivation so the filter and the row badge never disagree. */
const isAiSurfaceRow = (status: HousekeepingTaskStatus): boolean =>
  status.enrichment ? status.enrichment.token_estimate_per_record > 0 : false;

/** The user-facing one-liner for a producer row — the registry's
 *  `user_value` (the "you can use this to…" copy) falling back to the
 *  engineering `description` when the topic has no registry entry (only
 *  during a boot race or for an unregistered test topic). Exported so
 *  the row renderer and the search predicate share one source. */
export const producerOneLiner = (status: HousekeepingTaskStatus): string => {
  const topic = topicFromTaskId(status.meta.id);
  const entry = ENRICHMENT_REGISTRY[topic as keyof typeof ENRICHMENT_REGISTRY];
  return entry?.user_value ?? status.meta.description;
};

/** Filter the enrichment producer list by the search string + cost
 *  axis. Search is case-insensitive substring over the topic slug and
 *  the one-liner copy; an empty search matches everything. Pure —
 *  exported for testability. */
export const filterProducers = (
  producers: ReadonlyArray<HousekeepingTaskStatus>,
  search: string,
  cost: HousekeepingProducerCostFilter,
): ReadonlyArray<HousekeepingTaskStatus> => {
  const needle = search.trim().toLowerCase();
  return producers.filter((status) => {
    if (cost === 'llm' && !isAiSurfaceRow(status)) return false;
    if (cost === 'computed' && isAiSurfaceRow(status)) return false;
    if (needle === '') return true;
    const topic = topicFromTaskId(status.meta.id).toLowerCase();
    if (topic.includes(needle)) return true;
    return producerOneLiner(status).toLowerCase().includes(needle);
  });
};

export interface HousekeepingProducerFilterBarProps {
  /** Current search string (mount-local). */
  search: string;
  /** Current cost-axis choice (mount-local). */
  cost: HousekeepingProducerCostFilter;
}

export const renderHousekeepingProducerFilterBar = (
  props: HousekeepingProducerFilterBarProps,
): string => {
  const segments = HOUSEKEEPING_PRODUCER_COST_FILTERS.map((seg) => {
    const active = props.cost === seg.id;
    return `<button
        type="button"
        class="housekeeping-producer-cost-segment"
        data-action="${HOUSEKEEPING_PRODUCER_COST_ACTION}"
        data-cost="${e(seg.id)}"
        aria-pressed="${active ? 'true' : 'false'}"
      >${e(seg.label)}</button>`;
  }).join('');
  return `
    <div class="housekeeping-producer-filter-bar">
      <input
        type="search"
        class="housekeeping-producer-search"
        data-action="${HOUSEKEEPING_PRODUCER_SEARCH_ACTION}"
        value="${e(props.search)}"
        placeholder="Search producers…"
        aria-label="Search AI producers"
      />
      <div class="housekeeping-producer-cost-toggle" role="group" aria-label="Filter by cost">
        ${segments}
      </div>
    </div>
  `;
};
