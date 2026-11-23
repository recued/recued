import { e } from '@recued/ui-shared';
import { serializeSourceRecordAddress } from '../shell/route.js';
import { renderCalendarEditComparison, type CalendarEditComparison } from './calendar-edit-conflicts.js';
import type { CalendarEditEntry } from './calendar-edit-recovery.js';

export const renderCalendarEditRecoveries = (props: {
  entries: CalendarEditEntry[]; actionAttr: string; focusAttr: string; current?: { slug: string; source_id: string } | null;
  busy: boolean; discard: string | null; notice: string; unavailable: boolean; comparison?: CalendarEditComparison | null;
}): string => {
  if (!props.entries.length && !props.unavailable && !props.notice) return '';
  return `<section class="calendar-edit-recoveries" aria-label="Unfinished event edits"><h3>Unfinished event edits</h3>
    <p>These edits are kept in this browser tab. They have not been sent again.</p>
    ${props.unavailable ? '<p role="alert">Kept event edits could not be read. Keep any open draft here or copy its details before leaving.</p>' : ''}
    ${props.notice ? `<p role="alert" tabindex="-1" ${props.focusAttr}="recovery-notice">${e(props.notice)}</p>` : ''}
    ${props.entries.map(entry => {
      const original = entry.original, current = props.current?.slug === original.slug && props.current.source_id === original.event.source_id;
      const action = (name: string, label: string) => `<button type="button" class="data-button" ${props.actionAttr}="calendar-event-recovery-${name}-${entry.id}-${entry.revision}" ${props.focusAttr}="recovery-${name}-${entry.id}"${props.busy ? ' disabled' : ''}>${label}</button>`;
      const href = serializeSourceRecordAddress({ tab: 'calendar', collectionSlug: original.slug, recordId: original.event.record_id });
      const values = entry.values.draft, comparison = props.comparison?.entry.id === entry.id ? props.comparison : null;
      const instant = (value: string) => {
        const at = Number(value); if (!value || !Number.isSafeInteger(at)) return 'Choose a time when resuming';
        try { return new Intl.DateTimeFormat(undefined, { timeZone: original.event.timezone, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, timeZoneName: 'short' }).format(at); }
        catch { return new Date(at).toISOString(); }
      };
      return `<article data-calendar-edit-recovery="${entry.id}"><h4>${e(values.summary || 'Untitled event')}</h4>
        <p>${e(entry.values.calendarName || original.slug)} · ${e(original.event.timezone)} · <time datetime="${new Date(entry.updatedAt).toISOString()}">${e(new Date(entry.updatedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))}</time></p>
        ${entry.status !== 'editing' ? '<p>Save was not confirmed. Check the saved event before making another change; the earlier save may still complete.</p>' : ''}
        <div class="calendar-event-actions">${comparison ? '' : current ? action('resume', props.busy ? 'Checking…' : entry.status === 'editing' ? 'Resume edits' : 'Check saved event')
          : `<a class="data-button" href="${e(href)}">Review event edits</a>`}${action('discard', 'Discard edits')}</div>
        ${comparison ? renderCalendarEditComparison(comparison, props) : ''}
        ${props.discard === entry.id ? `<div role="group" aria-label="Discard these event edits?"><p>Discard this recovery copy? The saved event stays as it is.${entry.status !== 'editing' ? ' The earlier save may still complete.' : ''}</p><div class="calendar-event-actions">${action('keep', 'Keep edits')}${action('remove', 'Discard recovery copy')}</div></div>` : ''}
        <details><summary>Review kept edits</summary><div class="calendar-edit-recovery-preview">
          ${(['summary', 'location', 'start', 'end'] as const).map(key => `<label>${{ summary: 'Kept title', location: 'Kept location', start: 'Kept start', end: 'Kept end' }[key]}<input class="data-input" readonly value="${e(values[key])}"></label>`).join('')}
          <label>Kept description<textarea class="data-input" readonly rows="5">\n${e(values.description)}</textarea></label>
          ${!original.event.is_all_day ? `<p>Exact selected start: ${e(instant(values.startChoice))}. Exact selected end: ${e(instant(values.endChoice))}.</p>` : ''}
        </div></details>
      </article>`;
    }).join('')}</section>`;
};
export const CALENDAR_EDIT_RECOVERY_STYLES = `
.calendar-edit-recoveries { display:grid; gap:12px; padding:14px; margin-bottom:14px; border:1px solid var(--border); border-radius:8px; min-width:0; }
.calendar-edit-recoveries h3,.calendar-edit-recoveries h4,.calendar-edit-recoveries p { margin:0; overflow-wrap:anywhere; }
.calendar-edit-recoveries article { display:grid; gap:10px; min-width:0; }
.calendar-edit-recoveries article + article { border-top:1px solid var(--border); padding-top:12px; }
.calendar-edit-recoveries p { font-size:.875rem; color:var(--fg-muted); }
.calendar-edit-recoveries .data-button { min-height:44px; }
.calendar-edit-recovery-preview { display:grid; gap:10px; padding-top:10px; }
.calendar-edit-recovery-preview label { display:grid; gap:6px; min-width:0; }
.calendar-edit-recovery-preview .data-input { box-sizing:border-box; width:100%; min-width:0; }
`;
