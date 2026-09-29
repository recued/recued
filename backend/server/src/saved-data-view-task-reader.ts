/** The same local task filters as Data, with a fixed owner calendar zone. */
import {
  DEFAULT_TASK_VIEW_FILTERS, resolveTaskListFilter,
  type SavedDataViewDefinition, type TaskListFilter, type TaskViewFilters,
} from '@recued/contracts';
import type { WorkEntityStore } from './storage/work-entity-store.js';
import { readThroughSourceIds } from './work-entity-read-resolution.js';
import { zonedWallClockToEpochMs } from './ports/reception/processors/intake-destination-mapping.js';

export type SavedTaskViewReader = (definition: SavedDataViewDefinition, time_zone: string, now: number) => Array<{ id: string; title: string }>;

export const resolveAlertTaskFilter = (filters: TaskViewFilters, now: number, time_zone: string): TaskListFilter => {
  if (filters.due === 'all' || filters.due === 'overdue') return resolveTaskListFilter(filters, now);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: time_zone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const part = (type: string) => Number(parts.find(value => value.type === type)?.value);
  const date = new Date(Date.UTC(part('year'), part('month') - 1, part('day')));
  const from = zonedWallClockToEpochMs(date.toISOString().slice(0, 10), time_zone);
  date.setUTCDate(date.getUTCDate() + (filters.due === 'today' ? 1 : 7));
  const before = zonedWallClockToEpochMs(date.toISOString().slice(0, 10), time_zone);
  if (from === null || before === null || from >= before) throw new Error('Task alert calendar is unavailable.');
  return { completion: filters.completion, sort: filters.sort, due: { kind: 'range', from, before } };
};

/** Caller holds a SQLite transaction for the whole snapshot, including every
 * page. An unavailable source is an error, never an empty membership set. */
export const createSavedTaskViewReader = (store: WorkEntityStore): SavedTaskViewReader =>
  (definition, time_zone, now) => {
    if (definition.tab !== 'task' || !('source_id' in definition)) throw new Error('Alerts require a task view.');
    const excluded = readThroughSourceIds(store.listSources());
    if (definition.source_id !== null) {
      const source = store.getSource(definition.source_id);
      if (!source || source.top_tier_kind !== 'task' || excluded.has(source.id)) {
        throw new Error('The saved task source is unavailable for alerts.');
      }
    }
    const task_filter = resolveAlertTaskFilter(definition.task_filters ?? DEFAULT_TASK_VIEW_FILTERS, now, time_zone);
    const matches: Array<{ id: string; title: string }> = [];
    for (let offset = 0; ; offset += 1000) {
      const page = store.listTasks({
        ...(definition.source_id === null ? {} : { source_id: definition.source_id }),
        // The alert's own calendar zone reads a date-only due's day too
        // (`due-day.ts`), as it already reads the filter's days.
        search: definition.query, task_filter, time_zone, excluded_source_ids: [...excluded], limit: 1000, offset,
      });
      matches.push(...page.map(task => ({ id: task.id, title: task.title })));
      if (page.length < 1000) return matches;
    }
  };
