import { e } from '@recued/ui-shared';
import { COLLECTION_OPEN_RECORD_ACTION, COLLECTION_RECORD_ID_ATTR } from './collection-explorer.js';
import type { AgendaEvent, AgendaWindow } from './calendar-agenda.js';

export const MONTH_DAY_ATTR = 'data-calendar-month-day';
interface CalendarMonthProps {
  window: AgendaWindow;
  selectedDay: string;
  today: string;
  events: readonly AgendaEvent[];
  complete: boolean;
  searching?: boolean;
  sourceLabels: ReadonlyMap<string, string>;
  actionAttr: string;
  actionPrefix: string;
  focusAttr: string;
  sourceAttr: string;
  dateLabel(value: number, options: Intl.DateTimeFormatOptions): string;
  timeLabel(value: number): string;
}

/** Native day and event buttons keep the month usable without relying on a
 * visual grid. Previews are bounded; the selected day's agenda holds every event. */
export const renderCalendarMonth = (props: CalendarMonthProps): string => {
  const { window, actionAttr, focusAttr, actionPrefix, sourceAttr } = props;
  const firstWeekday = new Date(window.dateFrom).getUTCDay();
  const weekdays = Array.from({ length: 7 }, (_, day) => new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', weekday: 'short' })
    .format(new Date(Date.UTC(2026, 10, 1 + day)))); // Sunday through Saturday.
  const cells = window.days.map(day => {
    const rows = props.events.filter(event => event.start < day.before && event.end > day.from)
      .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start - b.start || a.key.localeCompare(b.key));
    const label = props.dateLabel(day.from, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const count = `${rows.length} ${props.searching ? 'matching ' : ''}saved event${rows.length === 1 ? '' : 's'}`;
    const countLabel = props.complete ? count : rows.length ? `${count} so far; count incomplete` : 'Event count incomplete';
    const selected = day.day === props.selectedDay;
    return `<li class="calendar-month-cell${selected ? ' is-selected' : ''}" data-calendar-month-cell="${day.day}">
      <button type="button" class="calendar-month-date" ${actionAttr}="${actionPrefix}day"
        ${MONTH_DAY_ATTR}="${day.day}" ${focusAttr}="day:${day.day}" tabindex="${selected ? '0' : '-1'}"
        aria-pressed="${selected}"${day.day === props.today ? ' aria-current="date"' : ''} aria-label="${e(label + ', ' + countLabel)}">
        <time datetime="${day.day}">${Number(day.day.slice(8))}</time>
        <span class="calendar-month-count" aria-hidden="true">${props.complete ? rows.length : rows.length ? rows.length + '+' : '?'}</span>
      </button>
      <ul class="calendar-month-previews">${rows.slice(0, 3).map(event => {
        const time = event.allDay ? 'All day' : event.start < day.from ? 'Continues' : props.timeLabel(event.start);
        const source = props.sourceLabels.get(event.slug) ?? event.slug;
        return `<li><button type="button" class="calendar-month-event" ${actionAttr}="${COLLECTION_OPEN_RECORD_ACTION}"
          ${COLLECTION_RECORD_ID_ATTR}="${e(event.record.record_id)}" ${sourceAttr}="${e(event.slug)}"
          ${focusAttr}="${e('month:' + JSON.stringify([day.day, event.slug, event.record.record_id]))}"
          aria-label="${e(label + ', ' + time + ', ' + event.title + ', ' + source)}">
          <span>${e(time)}</span> <strong>${e(event.title)}</strong></button></li>`;
      }).join('')}${rows.length > 3 ? `<li><button type="button" class="calendar-month-more" ${actionAttr}="${actionPrefix}day"
        ${MONTH_DAY_ATTR}="${day.day}" ${focusAttr}="more:${day.day}" aria-label="${e('Show all saved events for ' + label)}">+${rows.length - 3} more</button></li>` : ''}</ul>
    </li>`;
  });
  const trailing = (7 - (firstWeekday + cells.length) % 7) % 7;
  const blank = '<li class="calendar-month-blank" aria-hidden="true"></li>';
  return `<section data-calendar-month aria-label="${e(props.dateLabel(window.from, { month: 'long', year: 'numeric' }) + ' calendar')}">
    <p class="calendar-agenda-muted">Choose a day to see its agenda. Use arrow keys to move between days.</p>
    ${!props.complete ? '<p class="calendar-agenda-muted" role="status">Event counts are incomplete while calendars are loading or unavailable.</p>' : ''}
    <div class="calendar-month-weekdays" aria-hidden="true">${weekdays.map(day => `<span>${e(day)}</span>`).join('')}</div>
    <ol class="calendar-month-grid">${blank.repeat(firstWeekday)}${cells.join('')}${blank.repeat(trailing)}</ol>
  </section>`;
};

export const CALENDAR_MONTH_STYLES = `
[data-calendar-month] { min-width:0; }
.calendar-month-weekdays,.calendar-month-grid { display:grid; grid-template-columns:repeat(7,minmax(0,1fr)); }
.calendar-month-weekdays { margin-top:.75rem; text-align:center; font-size:.8rem; color:var(--fg-muted); }
.calendar-month-grid { list-style:none; padding:0; margin:.4rem 0 0; border-left:1px solid var(--border); border-top:1px solid var(--border); }
.calendar-month-cell,.calendar-month-blank { min-width:0; border-right:1px solid var(--border); border-bottom:1px solid var(--border); }
.calendar-month-cell { background:var(--surface); padding:.25rem; }
.calendar-month-cell.is-selected { box-shadow:inset 0 0 0 2px var(--accent); }
.calendar-month-date { display:flex; justify-content:space-between; align-items:center; gap:.25rem; width:100%; min-height:44px; border:0; background:transparent; color:var(--fg); font:inherit; text-align:left; cursor:pointer; }
.calendar-month-date[aria-current="date"] time { font-weight:750; text-decoration:underline; text-underline-offset:.2rem; }
.calendar-month-count { font-size:.75rem; color:var(--fg-muted); }
.calendar-month-previews { list-style:none; padding:0; margin:0; min-height:3rem; }
.calendar-month-event,.calendar-month-more { display:block; width:100%; min-width:0; min-height:44px; border:0; border-radius:.25rem; text-align:left; color:var(--fg); background:transparent; font:inherit; font-size:.75rem; cursor:pointer; }
.calendar-month-event strong { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.calendar-month-event span,.calendar-month-more { color:var(--fg-muted); }
.calendar-month-date:focus-visible,.calendar-month-event:focus-visible,.calendar-month-more:focus-visible { outline:2px solid var(--accent); outline-offset:-2px; }
.calendar-agenda [data-calendar-view][aria-pressed="true"] { border-color:var(--accent); color:var(--accent); font-weight:700; }
@media(max-width:600px) {
  .calendar-month-previews { display:none; }
  .calendar-month-cell { padding:.1rem; }
  .calendar-month-date { flex-direction:column; justify-content:center; gap:.15rem; padding:.3rem .1rem; min-height:54px; }
}
`;
