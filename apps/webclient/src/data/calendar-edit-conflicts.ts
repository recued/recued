import { e } from '@recued/ui-shared';
import type { CalendarEventDetails, CalendarEventSnapshot } from '@recued/contracts';
import { calendarEventDraft, calendarEventPatch, type CalendarEventDraft } from './calendar-event-draft.js';
import { calendarWallClockValue } from './calendar-wall-clock.js';
import type { CalendarEditEntry } from './calendar-edit-recovery.js';

export const CALENDAR_CONFLICT_FIELD = 'data-calendar-conflict-field';
export const CALENDAR_CONFLICT_TOKEN = 'data-calendar-conflict-token';
export type CalendarConflictField = 'summary' | 'location' | 'description' | 'when';
export type CalendarConflictChoice = 'saved' | 'mine';
export interface CalendarConflictRow {
  key: CalendarConflictField; label: string; mineChanged: boolean; savedChanged: boolean; conflict: boolean;
  saved: string; mine: string;
}
export interface CalendarEditComparison {
  token: string; entry: CalendarEditEntry; saved: CalendarEventSnapshot; rows: CalendarConflictRow[];
  choices: Partial<Record<CalendarConflictField, CalendarConflictChoice>>;
}
const stamp = (at: number, zone: string): string => {
  if (!Number.isFinite(new Date(at).getTime())) return 'Invalid time';
  try { return new Intl.DateTimeFormat(undefined, { timeZone: zone, year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit',
    ...(at % 1000 ? { fractionalSecondDigits: 3 as const } : {}), timeZoneName: 'short' }).format(at); }
  catch { return new Date(at).toISOString(); }
};
const span = (event: CalendarEventDetails, draft: CalendarEventDraft): [number, number] | null => {
  const initial = calendarEventDraft(event);
  const result = calendarEventPatch(event, { ...draft, summary: initial.summary || 'Untitled event', description: initial.description, location: initial.location });
  return result.patch ? [result.patch.start_at ?? event.start_at, result.patch.end_at ?? event.end_at] : null;
};
const intervalLabel = (event: CalendarEventDetails, draft: CalendarEventDraft): string => {
  if (event.is_all_day) return `${draft.start || '(choose a first day)'} through ${draft.end || '(choose a last day)'} · All day`;
  const value = span(event, draft);
  return value ? `${stamp(value[0], event.timezone)} – ${stamp(value[1], event.timezone)}`
    : `${draft.start || '(choose a start)'} – ${draft.end || '(choose an end)'} · ${event.timezone} · Times need review`;
};
/** Compare owner edits with the original review, then with the current event.
 * A start/end interval is one choice, including both exact repeated-hour epochs. */
export const compareCalendarEdits = (entry: CalendarEditEntry, saved: CalendarEventSnapshot): CalendarEditComparison => {
  const original = entry.original.event, before = calendarEventDraft(original), mine = entry.values.draft, current = calendarEventDraft(saved.event);
  const rows: CalendarConflictRow[] = [];
  for (const key of ['summary', 'location', 'description'] as const) {
    const mineChanged = mine[key] !== before[key], savedChanged = current[key] !== before[key];
    if (mineChanged || savedChanged) rows.push({ key, label: { summary: 'Title', location: 'Location', description: 'Notes' }[key], mineChanged, savedChanged,
      conflict: mineChanged && savedChanged && mine[key] !== current[key], saved: current[key], mine: mine[key] });
  }
  const baseTime = [original.start_at, original.end_at], mineTime = span(original, mine), savedTime = [saved.event.start_at, saved.event.end_at];
  const same = (a: number[] | null, b: number[]) => a !== null && a[0] === b[0] && a[1] === b[1];
  const mineChanged = !same(mineTime, baseTime), savedChanged = !same(savedTime, baseTime);
  if (mineChanged || savedChanged) rows.push({ key: 'when', label: original.is_all_day ? 'Dates' : 'Dates and times', mineChanged, savedChanged,
    conflict: mineChanged && savedChanged && !same(mineTime, savedTime), saved: intervalLabel(saved.event, current), mine: intervalLabel(original, mine) });
  return { token: crypto.randomUUID(), entry: structuredClone(entry), saved: structuredClone(saved), rows, choices: {} };
};
export const unresolvedCalendarConflicts = (comparison: CalendarEditComparison) => comparison.rows.filter(row => row.conflict
  && comparison.choices[row.key] !== 'saved' && comparison.choices[row.key] !== 'mine');
export const calendarConflictStatus = (comparison: CalendarEditComparison): string => {
  const remaining = unresolvedCalendarConflicts(comparison).length;
  return remaining ? `Choose a version for ${remaining} ${remaining === 1 ? 'field' : 'fields'} before preparing your draft.`
    : 'Your choices are ready. Prepare draft checks the saved event again; it does not save changes.';
};
export const mergeCalendarEdits = (comparison: CalendarEditComparison): CalendarEventDraft | null => {
  if (unresolvedCalendarConflicts(comparison).length) return null;
  const draft = calendarEventDraft(comparison.saved.event), mine = comparison.entry.values.draft, original = comparison.entry.original.event;
  for (const row of comparison.rows) {
    const useMine = row.mineChanged && (!row.savedChanged || row.conflict && comparison.choices[row.key] === 'mine');
    if (!useMine) continue;
    if (row.key !== 'when') { draft[row.key] = mine[row.key]; continue; }
    const times = span(original, mine), initial = calendarEventDraft(original);
    for (const [index, key] of (['start', 'end'] as const).entries()) {
      const at = times?.[index] ?? (mine[key] === initial[key] && (!mine[`${key}Choice`] || mine[`${key}Choice`] === initial[`${key}Choice`]) ? original[`${key}_at`] : null);
      draft[key] = at === null ? mine[key] : original.is_all_day ? mine[key]
        : calendarWallClockValue(at, original.timezone, at % 1000 ? 'millisecond' : at % 60_000 ? 'second' : 'minute');
      draft[`${key}Choice`] = at === null ? mine[`${key}Choice`] : String(at);
    }
  }
  return draft;
};

export const renderCalendarEditComparison = (comparison: CalendarEditComparison, attrs: { actionAttr: string; focusAttr: string; busy: boolean }): string => {
  const button = (key: string, label: string, disabled = false) => `<button type="button" class="data-button" ${attrs.actionAttr}="calendar-event-conflict-${key}-${comparison.token}" ${attrs.focusAttr}="conflict-${key}"${attrs.busy || disabled ? ' disabled' : ''}>${label}</button>`;
  return `<section class="calendar-edit-comparison" aria-label="Compare event edits"><h4 tabindex="-1" ${attrs.focusAttr}="comparison-heading">Compare event edits</h4>
    <p>The saved event changed. Changes in different fields can be kept together. When both versions changed the same field, choose which to use.</p>
    ${comparison.rows.length ? comparison.rows.map(row => `<fieldset><legend>${row.label}</legend><div class="calendar-conflict-values"><div><h5>Saved now</h5><p tabindex="0">${e(row.saved || '(empty)')}</p></div><div><h5>Your edits</h5><p tabindex="0">${e(row.mine || '(empty)')}</p></div></div>
      ${row.conflict ? `<label>${row.label}: which version?<select class="data-input" ${CALENDAR_CONFLICT_FIELD}="${row.key}" ${CALENDAR_CONFLICT_TOKEN}="${comparison.token}" ${attrs.focusAttr}="conflict-${row.key}"${attrs.busy ? ' disabled' : ''}><option value="">Choose a version</option><option value="saved"${comparison.choices[row.key] === 'saved' ? ' selected' : ''}>Use saved value</option><option value="mine"${comparison.choices[row.key] === 'mine' ? ' selected' : ''}>Use my edits</option></select></label>`
        : `<p>${!row.mineChanged ? 'The saved change will be kept.' : !row.savedChanged ? 'Your edits will be carried over.' : 'Both versions have this value.'}</p>`}</fieldset>`).join('')
      : '<p>The editable fields have not changed.</p>'}
    <p role="status" data-calendar-conflict-status>${e(calendarConflictStatus(comparison))}</p>
    <div class="calendar-event-actions">${button('prepare', 'Prepare draft', unresolvedCalendarConflicts(comparison).length > 0)}${button('cancel', 'Cancel comparison')}</div></section>`;
};
export const CALENDAR_EDIT_CONFLICT_STYLES = `
.calendar-edit-comparison { display:grid; gap:12px; min-width:0; }
.calendar-edit-comparison fieldset { display:grid; gap:10px; min-width:0; margin:0; padding:12px; border:1px solid var(--border); border-radius:6px; }
.calendar-edit-comparison legend { padding:0 4px; font-weight:600; }
.calendar-edit-comparison h5 { margin:0 0 6px; font-size:.8125rem; }
.calendar-conflict-values { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; min-width:0; }
.calendar-conflict-values p { white-space:pre-wrap; overflow-wrap:anywhere; max-height:12rem; overflow-y:auto; }
.calendar-edit-comparison label { display:grid; gap:6px; min-width:0; }
@media(max-width:600px) { .calendar-conflict-values { grid-template-columns:minmax(0,1fr); } }
`;
