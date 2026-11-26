import type { SavedDataView, SavedDataViewDefinition } from '@recued/contracts';
import { SEARCH_TYPE_LABELS } from './universal-search-filter.js';
import { REMINDER_STATUS_LABELS } from '../reminders/reminder-search.js';
import { describeRunSearchFilters } from '../logs/run-search-filters.js';

export const savedViewSettingsSummary = (definition: SavedDataViewDefinition): string => {
  const labels: Record<SavedDataViewDefinition['tab'], string> = {
    today: 'Today',
    search: 'Search', contact: 'Contacts', task: 'Tasks', note: 'Notes', commitment: 'Commitments',
    project: 'Projects', booking: 'Bookings', asset: 'Assets', mail: 'Mail', calendar: 'Calendar', files: 'Files',
    webhook: 'Webhook deliveries', memory: 'Memory', records: 'Records', form_response: 'Form responses',
    annotation: 'Annotations', link: 'Links', shared: 'Shared',
  };
  const parts = [labels[definition.tab]];
  if ('query' in definition) parts.push(definition.query ? `Search: “${definition.query}”` : 'No search text');
  if (definition.tab === 'search' && definition.result_type && definition.result_type !== 'all') parts.push(`Type: ${SEARCH_TYPE_LABELS[definition.result_type]}`);
  if (definition.tab === 'search' && definition.reminder_state && definition.reminder_state !== 'all') parts.push(`Reminders: ${REMINDER_STATUS_LABELS[definition.reminder_state]}`);
  if (definition.tab === 'search' && definition.run_filters) parts.push(`Runs: ${describeRunSearchFilters(definition.run_filters)}`);
  if (definition.tab === 'search' && definition.reminder_dates) {
    const dates = definition.reminder_dates;
    parts.push(`Dates: ${dates.range === 'custom' ? `${dates.from} through ${dates.through}` : dates.range === 'week' ? 'Next seven days' : 'Today'} (${dates.time_zone})`);
  }
  if ('source_id' in definition) {
    parts.push(`Source: ${definition.source_id ?? 'All sources'}`);
    if (definition.tab === 'booking') parts.push(`Lifecycle: ${definition.booking_lifecycle}`);
    if (definition.tab === 'commitment' && definition.commitment_filters) {
      const filters = definition.commitment_filters;
      parts.push(({ all: 'All directions', outbound: 'Promises you made', inbound: 'Promises to you', internal: 'Internal commitments' })[filters.direction]);
      parts.push(({ all: 'All statuses', open: 'Open', overdue: 'Overdue', closed: 'Closed' })[filters.status]);
    }
    if (definition.tab === 'task') {
      const filters = definition.task_filters;
      parts.push(({ all: 'All tasks', open: 'Open tasks', completed: 'Completed tasks' })[filters?.completion ?? 'all']);
      parts.push(({ all: 'Any time', overdue: 'Overdue', today: 'Today', next_7_days: 'Next seven days' })[filters?.due ?? 'all']);
      parts.push(filters?.sort === 'due_asc' ? 'Due date — earliest first' : 'Open first');
    }
  }
  if ('collection_slug' in definition) parts.push(`Source: ${definition.collection_slug ?? 'None selected'}`);
  if (definition.tab === 'records') {
    parts.push(definition.owner === null ? 'No pack selected'
      : `Pack: ${definition.owner.publisher}/${definition.owner.pack_slug}`, `Kind: ${definition.entity ?? 'None selected'}`);
    const operators = { eq: '=', ne: '≠', lt: '<', lte: '≤', gt: '>', gte: '≥', in: 'is any of', prefix: 'starts with' };
    const filters = Object.entries(definition.filters ?? {}).map(([field, filter]) =>
      filter.op === 'is_null' ? `${field} ${filter.value ? 'is not set' : 'is set'}`
        : `${field} ${operators[filter.op]} ${JSON.stringify(filter.value)}`);
    parts.push(filters.length ? `Filters: ${filters.join('; ')}` : 'No field filters');
    const sort = definition.sort ?? 'id';
    parts.push(`Sort: ${sort.startsWith('-') ? `${sort.slice(1)} descending` : `${sort} ascending`}`);
  }
  if (definition.tab === 'memory') parts.push(({ all: 'All origins', user_self: 'You', contracted_user: 'Agents', system: 'System' })[definition.origin]);
  return parts.join(' · ');
};
export const savedViewAlertSummary = (view: Pick<SavedDataView, 'definition' | 'alert'>): string => {
  const alert = view.alert;
  if (!alert) return 'Alerts off';
  if (!alert.enabled) return 'Alerts paused';
  const status = alert.status === 'unavailable'
    ? `Alerts waiting for your ${view.definition.tab === 'records' ? 'records' : 'tasks'}` : 'Alerts on';
  return `${status}${view.definition.tab === 'task' ? ` · ${alert.time_zone}` : ''}${alert.last_checked_at === null ? ''
    : ` · Checked ${new Date(alert.last_checked_at).toLocaleString()}`}`;
};
