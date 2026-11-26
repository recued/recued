import { RUN_SEARCH_OUTCOMES, RUN_SEARCH_TIME_RANGES, type RunSearchFilters, type RunSearchOutcome, type RunSearchTimeRange } from '@recued/contracts';
import { e } from '@recued/ui-shared';

export const SEARCH_RUN_FILTER = 'data-search-run-filter';
export const SEARCH_CLEAR_RUN_FILTERS = 'universal-search-clear-run-filters';
export const RUN_SEARCH_OUTCOME_LABELS: Record<RunSearchOutcome, string> = {
  failed: 'Failed', partial: 'Partial result', refused: 'All items failed', unknown: 'Needs checking', 'waiting-owner': 'Awaiting approval',
};
export const RUN_SEARCH_TIME_LABELS: Record<RunSearchTimeRange, string> = {
  '24h': 'Last 24 hours', '7d': 'Last 7 days', '30d': 'Last 30 days',
};
export const describeRunSearchFilters = (filters: RunSearchFilters): string => [
  ...(filters.outcome ? [RUN_SEARCH_OUTCOME_LABELS[filters.outcome]] : []),
  ...(filters.time_range ? [RUN_SEARCH_TIME_LABELS[filters.time_range]] : []),
].join(' · ');
export const renderRunSearchFilters = (filters: RunSearchFilters, actionAttr: string, disabled: boolean): string =>
  `<fieldset class="rq-run-filters" aria-label="Filter run history search"${disabled ? ' disabled' : ''}>
    <div class="rq-type-controls"><label for="rq-run-outcome">Run outcome</label><select id="rq-run-outcome" ${SEARCH_RUN_FILTER}="outcome">
      <option value="all"${!filters.outcome ? ' selected' : ''}>All outcomes</option>
      ${RUN_SEARCH_OUTCOMES.map(value => `<option value="${value}"${filters.outcome === value ? ' selected' : ''}>${e(RUN_SEARCH_OUTCOME_LABELS[value])}</option>`).join('')}
    </select></div>
    <div class="rq-type-controls"><label for="rq-run-time">Run start time</label><select id="rq-run-time" ${SEARCH_RUN_FILTER}="time_range" aria-describedby="rq-run-filter-description">
      <option value="all"${!filters.time_range ? ' selected' : ''}>All history</option>
      ${RUN_SEARCH_TIME_RANGES.map(value => `<option value="${value}"${filters.time_range === value ? ' selected' : ''}>${e(RUN_SEARCH_TIME_LABELS[value])}</option>`).join('')}
    </select></div>
    ${Object.keys(filters).length ? `<button type="button" class="rq-retry" ${e(actionAttr)}="${SEARCH_CLEAR_RUN_FILTERS}">Clear run filters</button>` : ''}
    <p class="rq-subtle" id="rq-run-filter-description">Time filters match when a run started. Refresh updates the time window.</p>
  </fieldset>`;
