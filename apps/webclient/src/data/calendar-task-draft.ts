import { CALENDAR_EVENT_EDIT_LIMITS, type WorkEntity } from '@recued/contracts';
import { serializeShellRoute } from '../shell/route.js';

type Task = Extract<WorkEntity, { _kind: 'task' }>;
export interface CalendarTaskOrigin {
  id: string;
  sourceId: string;
  sourceRecordId: string | null;
  createdAt: number;
  label: string;
}
export interface CalendarTaskSeed { origin: CalendarTaskOrigin; summary: string; description: string; location: string; }
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\u0000-\u001f\u007f]/u.test(value);
export const readCalendarTaskOrigin = (value: unknown): CalendarTaskOrigin | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !['id', 'sourceId', 'sourceRecordId', 'createdAt', 'label'].includes(key))
    || !id(row.id) || !id(row.sourceId) || row.sourceRecordId !== null && !id(row.sourceRecordId)
    || !Number.isSafeInteger(row.createdAt) || Number(row.createdAt) < 0 || !id(row.label) || !row.label.trim() || row.label.length > 512) return null;
  return { id: row.id, sourceId: row.sourceId, sourceRecordId: row.sourceRecordId as string | null, createdAt: Number(row.createdAt), label: row.label };
};
export const calendarTaskHref = (origin: CalendarTaskOrigin): string => serializeShellRoute('data', 'task', origin.id);
export const canScheduleTask = (task: Task): boolean => !task.done && task.sync_state === 'live' && task.deleted_at == null && !task.pending_write;
export const sameCalendarTask = (original: Task, current: WorkEntity | null): current is Task =>
  current?._kind === 'task' && current.id === original.id && current.source_id === original.source_id
  && (current.source_record_id ?? null) === (original.source_record_id ?? null) && current.created_at === original.created_at;

/** Scheduling reserves separate calendar time. No deadline, completion,
 * relationships, assignment or task-source write authority is copied. */
export const calendarTaskSeed = (original: Task, current: WorkEntity | null, clientUrl: string): CalendarTaskSeed => {
  if (!sameCalendarTask(original, current)) throw new Error('This task is unavailable or has a different identity. Reopen it before scheduling time.');
  if (!canScheduleTask(current)) throw new Error('This task is completed, unavailable or awaiting source confirmation. Reopen it to check its status.');
  const summary = current.title.replace(/[\r\n]+/g, ' ').trim() || 'Task';
  const origin = readCalendarTaskOrigin({ id: current.id, sourceId: current.source_id, sourceRecordId: current.source_record_id ?? null,
    createdAt: current.created_at, label: Array.from(summary.replace(/[\u0000-\u001f\u007f]/gu, ' ')).slice(0, 256).join('') });
  if (!origin) throw new Error('This task’s identity could not be confirmed. Reopen it before scheduling time.');
  const url = new URL(clientUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('The task link is unavailable.');
  url.username = ''; url.password = ''; url.search = ''; url.hash = calendarTaskHref(origin);
  const fields = { summary, description: `Task: ${url.href}`, location: '' };
  for (const key of ['summary', 'description', 'location'] as const)
    if (new TextEncoder().encode(fields[key]).length > CALENDAR_EVENT_EDIT_LIMITS[key])
      throw new Error('The task title or link exceeds this form’s limits. Start a new event and copy the details you need.');
  return { origin, ...fields };
};
