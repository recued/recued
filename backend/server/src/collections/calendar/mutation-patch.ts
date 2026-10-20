import { normalizeAllDaySpan, type CanonicalEvent } from '@recued/contracts';

/** Review and dispatch use the same effective patch. Moves retain the event's
 * zone/all-day flag, and all-day times become calendar days before review. */
export const normalizeCalendarMutationPatch = (
  input: Partial<CanonicalEvent>, existing: CanonicalEvent,
): Partial<CanonicalEvent> => {
  const moves = input.start_at !== undefined || input.end_at !== undefined;
  const patch = moves ? {
    ...input,
    ...(input.timezone === undefined || input.timezone === '' ? { timezone: existing.timezone || 'UTC' } : {}),
    ...(input.is_all_day === undefined ? { is_all_day: existing.is_all_day } : {}),
  } : input;
  const allDay = patch.is_all_day ?? existing.is_all_day;
  const becomesAllDay = patch.is_all_day === true && !existing.is_all_day;
  if (!allDay || (!moves && !becomesAllDay)) return patch;
  const days = normalizeAllDaySpan(patch.start_at ?? existing.start_at,
    patch.end_at ?? existing.end_at, patch.timezone || existing.timezone);
  return {
    ...patch,
    ...(patch.start_at !== undefined || days.start_at !== existing.start_at ? { start_at: days.start_at } : {}),
    ...(patch.end_at !== undefined || days.end_at !== existing.end_at ? { end_at: days.end_at } : {}),
  };
};
