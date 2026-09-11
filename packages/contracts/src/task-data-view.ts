/** Task view settings persist relative dates; list requests carry one fixed window. */
export const TASK_COMPLETION_FILTERS = ['all', 'open', 'completed'] as const;
export const TASK_DUE_FILTERS = ['all', 'overdue', 'today', 'next_7_days'] as const;
export const TASK_VIEW_SORTS = ['default', 'due_asc'] as const;

export interface TaskViewFilters {
  completion: typeof TASK_COMPLETION_FILTERS[number];
  due: typeof TASK_DUE_FILTERS[number];
  sort: typeof TASK_VIEW_SORTS[number];
}
export const DEFAULT_TASK_VIEW_FILTERS: Readonly<TaskViewFilters> = {
  completion: 'all', due: 'all', sort: 'default',
};

export interface TaskListFilter {
  completion: TaskViewFilters['completion'];
  sort: TaskViewFilters['sort'];
  due: { kind: 'all' } | { kind: 'overdue'; before: number }
    | { kind: 'range'; from: number; before: number };
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const keysAre = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const timestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= 8.64e15;

export const parseTaskViewFilters = (value: unknown): TaskViewFilters | null => {
  if (!object(value) || !keysAre(value, ['completion', 'due', 'sort'])) return null;
  const completion = TASK_COMPLETION_FILTERS.find((item) => item === value.completion);
  const due = TASK_DUE_FILTERS.find((item) => item === value.due);
  const sort = TASK_VIEW_SORTS.find((item) => item === value.sort);
  return completion === undefined || due === undefined || sort === undefined
    ? null : { completion, due, sort };
};

export const parseTaskListFilter = (value: unknown): TaskListFilter | null => {
  if (!object(value) || !keysAre(value, ['completion', 'due', 'sort'])) return null;
  const settings = parseTaskViewFilters({ ...value, due: 'all' });
  const due = value.due;
  if (settings === null || !object(due)) return null;
  const base = { completion: settings.completion, sort: settings.sort };
  if (due.kind === 'all' && keysAre(due, ['kind'])) return { ...base, due: { kind: 'all' } };
  if (due.kind === 'overdue' && keysAre(due, ['kind', 'before']) && timestamp(due.before)) {
    return { ...base, due: { kind: 'overdue', before: due.before } };
  }
  if (due.kind === 'range' && keysAre(due, ['kind', 'from', 'before'])
    && timestamp(due.from) && timestamp(due.before) && due.from < due.before) {
    return { ...base, due: { kind: 'range', from: due.from, before: due.before } };
  }
  return null;
};

/** Browser-local calendar days, including 23/25-hour daylight-saving days.
 * Next seven days includes today. Overdue always excludes completed tasks.
 * Resolve on a fresh read; reuse the result for every subsequent page. */
export const resolveTaskListFilter = (filters: TaskViewFilters, now: number): TaskListFilter => {
  const base = { completion: filters.completion, sort: filters.sort };
  if (filters.due === 'all') return { ...base, due: { kind: 'all' } };
  if (filters.due === 'overdue') return { ...base, due: { kind: 'overdue', before: now } };
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + (filters.due === 'today' ? 1 : 7));
  return { ...base, due: { kind: 'range', from: start.getTime(), before: end.getTime() } };
};
