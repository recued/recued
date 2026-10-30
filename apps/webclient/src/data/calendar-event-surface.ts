import {
  allDayEventDays, calendarDayMs, DAY_MS, zonedWallClockToEpochMs, zoneOffsetMsAt,
  CALENDAR_EVENT_EDIT_LIMITS,
  type CalendarEventDetails, type CalendarEventPatch, type CalendarEventRef,
  type CalendarEventSnapshot, type CalendarEventUpdateRequest,
  type CalendarEventRespondRequest, type CalendarEventRespondResult, type CalendarInvitationResponse,
} from '@recued/contracts';
import { e } from '@recued/ui-shared';
import { classifyRpcError, humanizeRpcError } from '../shell/rpc-error-copy.js';

export const CALENDAR_EVENT_ACTION_PREFIX = 'calendar-event-';
export const CALENDAR_EVENT_FIELD = 'data-calendar-event-field';
const FOCUS = 'data-calendar-event-focus';
const REPEAT = 'data-calendar-event-repeat';
type Field = 'summary' | 'description' | 'location' | 'start' | 'end' | 'startChoice' | 'endChoice';
export type CalendarEventDraft = Record<Field, string>;
export interface CalendarEventCallers {
  get?: (ref: CalendarEventRef) => Promise<CalendarEventSnapshot>;
  update?: (request: CalendarEventUpdateRequest) => Promise<CalendarEventSnapshot>;
  respond?: (request: CalendarEventRespondRequest) => Promise<CalendarEventRespondResult>;
}
export interface CalendarEventFocus { key: string; start?: number | null; end?: number | null; }

/** Always read the wall clock on the event's zone, even on a travelling browser. */
export const calendarWallClockValue = (at: number, zone: string): string => {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(at);
    const p = (key: string) => parts.find(part => part.type === key)?.value ?? '';
    return `${p('year')}-${p('month')}-${p('day')}T${p('hour')}:${p('minute')}`;
  } catch { return ''; }
};

/** Round-trip validation rejects invalid days and spring-forward gaps. Multiple
 * offsets around a transition expose both readings of a repeated wall clock. */
export const calendarWallClockCandidates = (value: string, zone: string): number[] => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return [];
  const first = zonedWallClockToEpochMs(value, zone);
  if (first === null) return [];
  const naive = Date.parse(value + ':00Z');
  if (!Number.isFinite(naive)) return [];
  const found = new Set<number>();
  try {
    for (const sample of [first - DAY_MS, first, first + DAY_MS]) {
      const candidate = naive - zoneOffsetMsAt(sample, zone);
      if (calendarWallClockValue(candidate, zone) === value) found.add(candidate);
    }
  } catch { return []; }
  return [...found].sort((a, b) => a - b);
};

export const calendarEventDraft = (event: CalendarEventDetails): CalendarEventDraft => {
  const days = event.is_all_day ? allDayEventDays(event) : null;
  return {
    // Native single-line inputs remove line breaks; preserve the original on
    // save when the owner has not changed their displayed value.
    summary: event.summary.replace(/[\r\n]/g, ''), location: event.location.replace(/[\r\n]/g, ''),
    description: event.description.replace(/\r\n?/g, '\n'),
    start: days?.first ?? calendarWallClockValue(event.start_at, event.timezone),
    end: days?.last ?? calendarWallClockValue(event.end_at, event.timezone),
    startChoice: String(event.start_at), endChoice: String(event.end_at),
  };
};

export const calendarEventPatch = (
  event: CalendarEventDetails, draft: CalendarEventDraft,
): { patch?: CalendarEventPatch; error?: string } => {
  const initial = calendarEventDraft(event);
  if (!draft.summary.trim()) return { error: 'Enter an event title.' };
  const patch: CalendarEventPatch = {};
  for (const key of ['summary', 'description', 'location'] as const) {
    // Unedited provider fields can exceed this form's write limits. Keeping
    // them intact must not prevent an edit to another supported field.
    if (draft[key] === initial[key]) continue;
    if (new TextEncoder().encode(draft[key]).length > CALENDAR_EVENT_EDIT_LIMITS[key]) {
      return { error: `${key === 'summary' ? 'Title' : key === 'description' ? 'Description' : 'Location'} is too long.` };
    }
    patch[key] = draft[key];
  }
  const readTime = (key: 'start' | 'end'): number | string => {
    const old = key === 'start' ? event.start_at : event.end_at;
    // Avoid dropping imported seconds/milliseconds, or changing the reading of
    // an unchanged ambiguous time, when only the title or description changes.
    if (draft[key] === initial[key] && (!draft[`${key}Choice`] || draft[`${key}Choice`] === String(old))) return old;
    if (event.is_all_day) {
      const day = calendarDayMs(draft[key]);
      return day === null ? 'Choose valid start and end dates.' : day + (key === 'end' ? DAY_MS : 0);
    }
    const candidates = calendarWallClockCandidates(draft[key], event.timezone);
    if (candidates.length === 0) return `Choose a valid ${key} time in ${event.timezone}. That time may fall in a daylight saving gap.`;
    if (candidates.length === 1) return candidates[0]!;
    const chosen = Number(draft[`${key}Choice`]);
    return draft[`${key}Choice`] !== '' && candidates.includes(chosen) ? chosen : `Choose which repeated ${key} time you mean.`;
  };
  const start = readTime('start'); const end = readTime('end');
  if (typeof start === 'string') return { error: start };
  if (typeof end === 'string') return { error: end };
  if (end <= start) return { error: event.is_all_day ? 'The last day must be on or after the first day.' : 'The end must be after the start.' };
  if (start !== event.start_at) patch.start_at = start;
  if (end !== event.end_at) patch.end_at = end;
  return { patch };
};

const timeLabel = (at: number, zone: string): string => {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone: zone, dateStyle: 'full', timeStyle: 'long' }).format(at);
  } catch { return `${new Date(at).toISOString()} (event time zone unavailable)`; }
};
const dayLabel = (day: string): string => new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', dateStyle: 'full' }).format(Date.parse(day + 'T00:00:00Z'));
const durationLabel = (event: CalendarEventDetails): string => {
  if (event.is_all_day) { const n = (event.end_at - event.start_at) / DAY_MS; return `${n} ${n === 1 ? 'day' : 'days'}`; }
  const totalSeconds = Math.round((event.end_at - event.start_at) / 1000);
  if (totalSeconds === 0 && event.end_at > event.start_at) return 'Less than a second';
  const hours = Math.floor(totalSeconds / 3600); const rest = Math.floor(totalSeconds % 3600 / 60);
  const seconds = totalSeconds % 60;
  return [hours ? `${hours} ${hours === 1 ? 'hour' : 'hours'}` : '', rest ? `${rest} ${rest === 1 ? 'minute' : 'minutes'}` : '', seconds ? `${seconds} ${seconds === 1 ? 'second' : 'seconds'}` : ''].filter(Boolean).join(' ') || '0 minutes';
};
const identityMatches = (ref: CalendarEventRef, recordId: string, value: CalendarEventSnapshot): boolean =>
  value?.event?.source_id === ref.source_id && value.event.record_id === recordId
  && value.record?.source_id === ref.source_id && value.record.record_id === recordId;
const confirmsDraft = (before: CalendarEventSnapshot, patch: CalendarEventPatch, after: CalendarEventSnapshot): boolean => {
  const wanted = { ...before.event, ...patch };
  return after.incarnation === before.incarnation && (['calendar_id', 'summary', 'description', 'location', 'start_at', 'end_at', 'timezone', 'is_all_day', 'status', 'is_recurring'] as const)
    .every(key => after.event[key] === wanted[key]);
};

export const createCalendarEventSurface = (deps: {
  callers: CalendarEventCallers; actionAttr: string; render: () => void;
  onSaved: (snapshot: CalendarEventSnapshot) => void;
  onRemoved?: (recordId: string) => void;
}) => {
  let ref: CalendarEventRef | null = null;
  let recordId = '';
  let snapshot: CalendarEventSnapshot | null = null;
  let draft: CalendarEventDraft | null = null;
  let busy: 'read' | 'save' | 'respond' | null = null;
  let responseNeedsCheck = false;
  let saveNeedsCheck = false;
  let pendingResponse: CalendarInvitationResponse | null = null;
  let removed = false;
  const responseLabel = (value: string): string => ({ accepted: 'Accepted', tentative: 'Maybe', declined: 'Declined', needs_action: 'Awaiting response' })[value] ?? 'Unknown';
  let error = ''; let notice = '';
  /** A server before 26.10.28 has no event read: the event's listed fields and Reschedule stand alone. */
  let unsupported = false;
  let generation = 0; let disposed = false;
  let pendingLeave: (() => void) | null = null;
  let pendingFocus: (CalendarEventFocus & { onlyIfOwned?: true }) | null = null;
  let editorFocus: CalendarEventFocus = { key: 'summary' };
  const dirty = (): boolean => {
    if (!draft || !snapshot) return false;
    const initial = calendarEventDraft(snapshot.event);
    return (Object.keys(initial) as Field[]).some(key =>
      (key !== 'startChoice' && key !== 'endChoice' || draft![key] !== '') && draft![key] !== initial[key]);
  };
  const button = (action: string, label: string, primary = false): string => `<button type="button" class="data-button${primary ? ' data-button--primary' : ''}" ${deps.actionAttr}="calendar-event-${action}" ${FOCUS}="${action}"${busy || action === 'save' && saveNeedsCheck ? ' aria-disabled="true"' : ''}${busy ? ' aria-busy="true"' : ''}>${e(label)}</button>`;
  const repaint = (focus?: string | CalendarEventFocus) => {
    if (focus) pendingFocus = typeof focus === 'string' ? { key: focus } : focus;
    deps.render();
  };
  const zoneAvailable = (event: CalendarEventDetails): boolean => event.is_all_day
    || Boolean(calendarWallClockValue(event.start_at, event.timezone) && calendarWallClockValue(event.end_at, event.timezone));
  const editable = (value: CalendarEventSnapshot | null): boolean => value?.editable === true
    && deps.callers.update !== undefined && (zoneAvailable(value.event)
      || value.editable_fields !== undefined && !value.editable_fields.some(key => key === 'start_at' || key === 'end_at'));
  const fieldAllowed = (key: Field): boolean => {
    const field = key === 'start' || key === 'startChoice' ? 'start_at' : key === 'end' || key === 'endChoice' ? 'end_at' : key;
    return snapshot?.editable_fields === undefined || snapshot.editable_fields.includes(field);
  };
  const viewFocus = (value: CalendarEventSnapshot) => editable(value) ? 'edit' : 'heading';
  const resumeEditing = () => { pendingLeave = null; repaint(editorFocus); };
  const read = async (checkDraft = false, owner?: 'retry' | 'check' | 'heading' | 'response-check' | 'response-refresh'): Promise<void> => {
    if (!ref || !deps.callers.get || busy || disposed) return;
    const seq = ++generation; const expectedRef = ref; const expectedRecord = recordId;
    busy = 'read'; notice = ''; repaint(owner);
    try {
      const value = await deps.callers.get(expectedRef);
      if (disposed || seq !== generation) return;
      if (!identityMatches(expectedRef, expectedRecord, value)) throw new Error('The calendar returned a different event. Refresh its details.');
      if (checkDraft && draft && snapshot) {
        if (snapshot.editable_fields !== undefined && value.provider_verified !== true) {
          throw new Error(value.refresh_error ?? 'The connected calendar could not verify the saved event. Your draft is kept.');
        }
        const wanted = calendarEventPatch(snapshot.event, draft);
        const confirmed = wanted.patch && confirmsDraft(snapshot, wanted.patch, value);
        if (confirmed) {
          snapshot = value; draft = null; saveNeedsCheck = false; error = ''; notice = 'Your changes are saved.'; deps.onSaved(value);
          pendingFocus = { key: viewFocus(value), onlyIfOwned: true };
        } else if (snapshot.editable_fields !== undefined && value.resource_version === snapshot.resource_version
          && value.incarnation === snapshot.incarnation && editable(value)
          && Object.keys(wanted.patch ?? {}).every(key => value.editable_fields?.includes(key as keyof CalendarEventPatch))) {
          snapshot = value; saveNeedsCheck = false;
          error = 'Your calendar still has the saved values. Your draft is kept; no changes were sent again.';
        } else { error = 'The saved event differs from your draft. Your draft is kept. Reload saved values to start again.'; }
      } else {
        const checkingResponse = responseNeedsCheck;
        if (checkingResponse && snapshot && value.incarnation !== snapshot.incarnation) throw new Error('This calendar connection was replaced. Reopen the event before responding.');
        snapshot = value; saveNeedsCheck = false; error = value.refresh_error ?? ''; notice = '';
        if (checkingResponse && value.provider_verified !== true) {
          error = value.refresh_error ?? value.invitation?.unavailable_reason ?? 'Your calendar could not verify the response. Check again before sending.';
        } else if (checkingResponse) {
          responseNeedsCheck = false;
          notice = value.invitation ? `Your calendar currently shows ${responseLabel(value.invitation.response)}. No response was sent again.` : 'This event no longer has a response available.';
          if (value.invitation?.response !== pendingResponse) notice += ' The earlier request may still complete.';
          pendingResponse = null;
          deps.onSaved(value);
        }
        if (!error && owner === 'response-refresh' && value.provider_verified) notice = 'Response refreshed from your calendar.';
      }
    } catch (err) {
      if (!disposed && seq === generation) {
        if (classifyRpcError(err).code === 'unknown_method') unsupported = true; else error = humanizeRpcError(err);
      }
    }
    finally { if (!disposed && seq === generation) {
      busy = null;
      if (owner && !pendingFocus) pendingFocus = { key: error ? (responseNeedsCheck ? 'response-check' : snapshot?.refresh_error ? 'response-refresh' : draft ? 'check' : 'retry') : owner === 'response-refresh' ? 'response-refresh' : 'heading', onlyIfOwned: true };
      repaint();
    } }
  };
  const reset = () => { generation++; ref = null; recordId = ''; snapshot = null; draft = null; busy = null; saveNeedsCheck = false; responseNeedsCheck = false; pendingResponse = null; removed = false; error = ''; notice = ''; unsupported = false; pendingLeave = null; pendingFocus = null; editorFocus = { key: 'summary' }; };
  const save = async (): Promise<void> => {
    if (!snapshot || !draft || !ref || !deps.callers.update || busy || saveNeedsCheck || !editable(snapshot) || !snapshot.incarnation) return;
    const result = calendarEventPatch(snapshot.event, draft);
    if (!result.patch) { error = result.error!; repaint(); return; }
    if (snapshot.editable_fields && Object.keys(result.patch).some(key => !snapshot!.editable_fields!.includes(key as keyof CalendarEventPatch))) {
      error = 'Edit that field in the connected calendar. Your draft is kept.'; repaint(); return;
    }
    if (Object.keys(result.patch).length === 0) { draft = null; error = ''; repaint('edit'); return; }
    const request = { ...ref, expected_version: snapshot.resource_version, expected_incarnation: snapshot.incarnation, patch: result.patch };
    const seq = ++generation; const expectedRecord = recordId;
    busy = 'save'; error = ''; notice = ''; repaint('save');
    try {
      const value = await deps.callers.update(request);
      if (disposed || seq !== generation) return;
      if (!identityMatches(request, expectedRecord, value) || !confirmsDraft(snapshot, request.patch, value)) {
        throw new Error('The save could not be confirmed. Your draft is kept. Check the saved event before trying again.');
      }
      snapshot = value; draft = null; notice = 'Event saved.'; deps.onSaved(value);
      pendingFocus = { key: viewFocus(value), onlyIfOwned: true };
    } catch (err) { if (!disposed && seq === generation) {
      saveNeedsCheck = snapshot.editable_fields !== undefined;
      error = humanizeRpcError(err) + (saveNeedsCheck ? ' Check the saved event before trying again.' : '');
      if (saveNeedsCheck) pendingFocus = { key: 'check', onlyIfOwned: true };
    } }
    finally { if (!disposed && seq === generation) { busy = null; repaint(); } }
  };
  const respond = async (response: CalendarInvitationResponse): Promise<void> => {
    if (!ref || !snapshot?.invitation?.can_respond || snapshot.provider_verified !== true || !snapshot.incarnation || !deps.callers.respond
      || busy || draft || removed || responseNeedsCheck || snapshot.invitation.response === response) return;
    const before = snapshot;
    const request = { ...ref, expected_version: before.resource_version, expected_incarnation: before.incarnation!, response };
    const seq = ++generation; const expectedRecord = recordId;
    busy = 'respond'; pendingResponse = response; error = ''; notice = ''; repaint(`respond-${response}`);
    try {
      const result = await deps.callers.respond(request);
      if (disposed || seq !== generation) return;
      if (result.removed) {
        if (response !== 'declined' || result.source_id !== request.source_id) throw new Error('The response could not be confirmed.');
        removed = true;
        snapshot = { ...before, invitation: { ...before.invitation!, response: 'declined', can_respond: false } };
        notice = 'Decline submitted for the organizer. Your calendar removed this event.';
        deps.onRemoved?.(expectedRecord);
      } else {
        const value = result.snapshot;
        if (!identityMatches(request, expectedRecord, value) || value.incarnation !== request.expected_incarnation
          || value.provider_verified !== true || value.invitation?.response !== response) throw new Error('The response could not be confirmed.');
        snapshot = value; notice = 'Response submitted to your calendar for the organizer.'; deps.onSaved(value);
      }
      pendingResponse = null; responseNeedsCheck = false;
      pendingFocus = { key: 'heading', onlyIfOwned: true };
    } catch (err) {
      if (!disposed && seq === generation) {
        responseNeedsCheck = true;
        error = `${humanizeRpcError(err)} Check your response before sending again.`;
        pendingFocus = { key: 'response-check', onlyIfOwned: true };
      }
    } finally { if (!disposed && seq === generation) { busy = null; repaint(); } }
  };
  const beforeLeave = (effect: () => void): boolean => {
    if (!draft && busy !== 'save' && busy !== 'respond') return true;
    if (busy) { repaint(busy === 'respond' ? `respond-${pendingResponse}` : busy === 'save' ? 'save' : 'check'); return false; }
    if (!dirty()) { draft = null; return true; }
    if (!pendingLeave) pendingLeave = effect;
    repaint('keep'); return false;
  };
  const repeatedTime = (key: 'start' | 'end'): string => {
    const event = snapshot?.event;
    if (!draft || !event || event.is_all_day) return '';
    const zone = event.timezone;
    const values = calendarWallClockCandidates(draft![key], zone);
    if (values.length < 2) return '';
    const current = Number(draft![`${key}Choice`]);
    const initialMinute = Math.floor((key === 'start' ? event.start_at : event.end_at) / 60_000) * 60_000;
    const choice = values.includes(current) ? String(current)
      : draft![key] === calendarEventDraft(event)[key] ? String(initialMinute) : '';
    return `<label class="calendar-event-field">Repeated ${key} time<select class="data-input" ${CALENDAR_EVENT_FIELD}="${key}Choice" ${FOCUS}="${key}Choice"${busy || pendingLeave || saveNeedsCheck || !fieldAllowed(key) ? ' disabled' : ''}><option value="">Choose a reading</option>${values.map(at => `<option value="${at}"${String(at) === choice ? ' selected' : ''}>${e(timeLabel(at, zone))}</option>`).join('')}</select></label>`;
  };
  return {
    reset,
    dispose: () => { disposed = true; reset(); },
    async open(next: CalendarEventRef, id: string): Promise<void> {
      reset(); if (disposed || !deps.callers.get) return;
      ref = { ...next }; recordId = id; await read();
    },
    hasSnapshot: () => snapshot !== null,
    isEditable: () => editable(snapshot),
    isEditing: () => draft !== null,
    isLoading: () => busy === 'read' && draft === null,
    hasUnsavedChanges: dirty,
    hasInFlightWork: () => busy === 'save' || busy === 'respond' || (busy === 'read' && draft !== null),
    beforeLeave,
    render(): string {
      if (!ref || (!snapshot && unsupported)) return '';
      if (!snapshot) return `<div class="calendar-event"><p ${error ? 'role="alert"' : 'role="status"'}>${e(error || 'Loading event details…')}</p>${error ? button('retry', busy ? 'Retrying…' : 'Retry event details') : ''}</div>`;
      const event = snapshot.event;
      const days = event.is_all_day ? allDayEventDays(event) : null;
      const zone = event.timezone || 'Unknown time zone';
      const readOnlyReason = snapshot.read_only_reason || (!editable(snapshot) && !zoneAvailable(event) ? 'The event’s time zone is unavailable in this browser’s editor.' : '');
      const field = (key: Field, label: string, type = 'text'): string => `<label class="calendar-event-field">${e(label)}${!fieldAllowed(key) ? ' (read-only)' : ''}<input class="data-input" type="${type}" ${CALENDAR_EVENT_FIELD}="${key}" ${FOCUS}="${key}" value="${e(draft![key])}"${key === 'summary' ? ' required' : ''}${busy || pendingLeave || saveNeedsCheck || !fieldAllowed(key) && type !== 'text' ? ' disabled' : !fieldAllowed(key) ? ' readonly' : ''}${type === 'text' ? ` maxlength="${CALENDAR_EVENT_EDIT_LIMITS[key as 'summary' | 'location']}"` : ''}></label>`;
      const dateField = (key: 'start' | 'end', label: string): string => {
        const choices = repeatedTime(key);
        return `<div class="calendar-event-date-field">${field(key, label, event.is_all_day ? 'date' : 'datetime-local')}
          <div ${REPEAT}="${key}"${choices ? '' : ' hidden'}>${choices}</div></div>`;
      };
      const editor = draft ? `<div class="calendar-event-editor" aria-label="Edit event">
        <h3>Edit event</h3><p class="calendar-event-hint">${event.is_all_day ? 'All-day dates include the first and last day.' : `Times use ${e(zone)}.`}</p>
        ${snapshot.edit_notice ? `<p class="calendar-event-hint">${e(snapshot.edit_notice)}</p>` : ''}
        ${field('summary', 'Title')}${field('location', 'Location')}
        <div class="calendar-event-dates">${dateField('start', event.is_all_day ? 'First day' : 'Start')}${dateField('end', event.is_all_day ? 'Last day' : 'End')}</div>
        <label class="calendar-event-field">Description${!fieldAllowed('description') ? ' (read-only)' : ''}<textarea class="data-input" rows="6" maxlength="${CALENDAR_EVENT_EDIT_LIMITS.description}" ${CALENDAR_EVENT_FIELD}="description" ${FOCUS}="description"${busy || pendingLeave || saveNeedsCheck ? ' disabled' : !fieldAllowed('description') ? ' readonly' : ''}>
${e(draft.description)}</textarea></label>
        ${pendingLeave ? `<div class="calendar-event-discard" role="alertdialog" aria-modal="true" aria-labelledby="calendar-event-discard-title" aria-describedby="calendar-event-discard-copy"><h4 id="calendar-event-discard-title">Discard event changes?</h4><p id="calendar-event-discard-copy">Your unfinished changes will be lost.</p><div class="calendar-event-actions">${button('keep', 'Keep editing')}${button('discard', 'Discard changes')}</div></div>` : `<div class="calendar-event-actions">${button('save', busy === 'save' ? 'Saving…' : 'Save changes', true)}${button('cancel', 'Cancel')}</div>`}
      </div>` : '';
      const meta = (label: string, value: string) => `<div><dt>${e(label)}</dt><dd>${e(value)}</dd></div>`;
      const errorHtml = error ? `<div class="calendar-event-error" role="alert"><p>${e(error)}</p>${responseNeedsCheck ? button('response-check', busy === 'read' ? 'Checking…' : 'Check response') : draft ? `<div class="calendar-event-actions">${button('check', busy === 'read' ? 'Checking…' : 'Check saved event')}${button('reload', 'Reload saved values')}</div>` : snapshot.refresh_error ? button('response-refresh', busy ? 'Refreshing…' : 'Retry refresh') : button('retry', busy ? 'Retrying…' : 'Retry event details')}</div>` : '';
      const invitation = snapshot.invitation;
      const invitationHtml = !draft && invitation ? `<section class="calendar-event-invitation" aria-label="Invitation response">
        <div class="calendar-event-title-row"><h3>Invitation</h3>${!removed && !responseNeedsCheck && !snapshot.refresh_error && deps.callers.get ? button('response-refresh', busy === 'read' ? 'Refreshing…' : 'Refresh response') : ''}</div><dl class="calendar-event-meta">${meta('Organizer', invitation.organizer.display_name ? `${invitation.organizer.display_name} <${invitation.organizer.email}>` : invitation.organizer.email)}${meta('Responding as', invitation.attendee_email)}${meta(snapshot.provider_verified ? 'Your response' : 'Last synced response', responseLabel(invitation.response))}</dl>
        ${!removed && snapshot.provider_verified === true && invitation.can_respond && deps.callers.respond ? `<p class="calendar-event-hint">Your calendar sends your response to the organizer.${invitation.scope === 'series' ? ' This response applies to the whole series.' : invitation.scope === 'occurrence' ? ' This response applies to this occurrence.' : ''}</p><div class="calendar-event-actions">${(['accepted', 'tentative', 'declined'] as const).map(response => {
          const label = response === 'accepted' ? 'Accept' : response === 'tentative' ? 'Maybe' : 'Decline';
          return button(`respond-${response}`, busy === 'respond' && pendingResponse === response ? 'Sending…' : label)
            .replace('type="button"', `type="button" aria-pressed="${invitation.response === response}"${responseNeedsCheck || invitation.response === response ? ' disabled' : ''}`);
        }).join('')}</div>` : !removed && invitation.unavailable_reason && !snapshot.refresh_error ? `<p class="calendar-event-hint">${e(invitation.unavailable_reason)}</p>` : ''}
        ${responseNeedsCheck || snapshot.refresh_error ? errorHtml : ''}
      </section>` : '';
      return `<div class="calendar-event">
        <header class="calendar-event-head"><div class="calendar-event-context"><span class="col-explorer-detail-scope">Calendar · ${e(event.calendar_name || event.calendar_id)}</span><span class="calendar-event-status">${e(event.status === 'cancelled' ? 'Cancelled' : event.status === 'tentative' ? 'Tentative' : 'Confirmed')}${event.is_recurring ? ' · Recurring' : ''}</span></div>
          <div class="calendar-event-title-row"><h2 class="col-explorer-detail-title" data-recued-collection-detail-heading ${FOCUS}="heading" tabindex="-1">${e(event.summary || 'Untitled event')}</h2>${!draft && editable(snapshot) ? button('edit', 'Edit event') : ''}</div>
        </header>
        ${notice ? `<p role="status" class="calendar-event-notice">${e(notice)}</p>` : ''}
        ${busy === 'read' ? `<p role="status" class="calendar-event-hint">${draft ? 'Checking saved event…' : responseNeedsCheck ? 'Checking your response…' : 'Reading event details…'}</p>` : ''}
        ${!draft ? `<dl class="calendar-event-meta">${meta(days ? 'First day' : 'Start', days ? dayLabel(days.first) : timeLabel(event.start_at, zone))}${meta(days ? 'Last day' : 'End', days ? dayLabel(days.last) : timeLabel(event.end_at, zone))}${meta(days ? 'All day' : 'Time zone', days ? 'Yes' : zone)}${meta('Duration', durationLabel(event))}${event.location ? meta('Location', event.location) : ''}</dl>${invitationHtml}${event.description ? `<div><h3>Description</h3><p class="calendar-event-description">${e(event.description)}</p>${event.description_truncated ? '<p class="calendar-event-hint">Description preview. The full text is kept in the calendar.</p>' : ''}</div>` : ''}${readOnlyReason ? `<p class="calendar-event-hint">${e(readOnlyReason)}</p>` : ''}` : editor}
        ${!invitation || (!responseNeedsCheck && !snapshot.refresh_error) ? errorHtml : ''}
        ${!draft ? `<details class="calendar-event-identities"><summary>Event identifiers</summary><dl class="calendar-event-meta">${meta('Record id', event.record_id)}${meta('Source id', event.source_id)}</dl></details>` : ''}
      </div>`;
    },
    handleAction(action: string): boolean {
      if (!action.startsWith(CALENDAR_EVENT_ACTION_PREFIX)) return false;
      const key = action.slice(CALENDAR_EVENT_ACTION_PREFIX.length);
      if (busy) return true;
      if (pendingLeave && key !== 'keep' && key !== 'discard') return true;
      if (key === 'retry' && !removed) void read(false, 'retry');
      if (key === 'response-check') void read(false, 'response-check');
      if (key === 'response-refresh' && !removed) void read(false, 'response-refresh');
      if (key === 'respond-accepted' || key === 'respond-tentative' || key === 'respond-declined') void respond(key.slice('respond-'.length) as CalendarInvitationResponse);
      if (key === 'edit' && snapshot && editable(snapshot)) {
        if (saveNeedsCheck) void read(false, 'heading');
        else { draft = calendarEventDraft(snapshot.event); editorFocus = { key: 'summary' }; error = ''; notice = ''; repaint('summary'); }
      }
      if (key === 'save') void save();
      if (key === 'check') void read(true, 'check');
      if (key === 'cancel') {
        const cancel = () => { draft = null; error = ''; notice = ''; repaint('edit'); };
        if (beforeLeave(cancel)) cancel();
      }
      if (key === 'reload') {
        const reload = () => { draft = null; error = ''; void read(false, 'heading'); };
        if (beforeLeave(reload)) reload();
      }
      if (key === 'keep') resumeEditing();
      if (key === 'discard') { const leave = pendingLeave; pendingLeave = null; draft = null; error = ''; leave?.(); }
      return true;
    },
    handleInput(target: HTMLElement, _change = false): boolean {
      const key = target.getAttribute(CALENDAR_EVENT_FIELD) as Field | null;
      if (!key) return false;
      if (!draft || busy || saveNeedsCheck || pendingLeave || !(key in draft) || !fieldAllowed(key)) return true;
      const control = target as HTMLInputElement;
      editorFocus = { key, start: control.selectionStart, end: control.selectionEnd };
      if (draft[key] === control.value) return true;
      draft[key] = control.value;
      if (key === 'start' || key === 'end') {
        draft[`${key}Choice`] = '';
        // Preserve the native input's active date/time segment. Only the
        // dependent repeated-time choice needs to change while typing.
        const host = target.closest?.('.calendar-event')?.querySelector<HTMLElement>(`[${REPEAT}="${key}"]`);
        if (host) { const choices = repeatedTime(key); host.innerHTML = choices; host.hidden = !choices; }
      }
      return true;
    },
    guardKeyDown(event: KeyboardEvent, root: HTMLElement): boolean {
      if (!pendingLeave || event.key !== 'Tab') return false;
      const keep = root.querySelector<HTMLElement>(`[${FOCUS}="keep"]`);
      const discard = root.querySelector<HTMLElement>(`[${FOCUS}="discard"]`);
      const target = event.target;
      if ((event.shiftKey && target === keep) || (!event.shiftKey && target === discard)
        || (target !== keep && target !== discard)) {
        event.preventDefault(); (event.shiftKey ? discard : keep)?.focus();
      }
      return true;
    },
    escape(): boolean {
      if (!draft) return false;
      if (busy) return true;
      if (pendingLeave) resumeEditing();
      else this.handleAction('calendar-event-cancel');
      return true;
    },
    captureFocus(active: HTMLElement | null | undefined): CalendarEventFocus | null {
      const key = active?.getAttribute?.(FOCUS);
      if (!key) return null;
      const field = active as HTMLInputElement;
      const focus = { key, start: field.selectionStart, end: field.selectionEnd };
      if (draft && key in draft) editorFocus = focus;
      return focus;
    },
    restoreFocus(root: HTMLElement, previous: CalendarEventFocus | null): void {
      const requested = pendingFocus; pendingFocus = null;
      if (requested?.onlyIfOwned && previous === null) return;
      const focus = requested ?? previous;
      if (!focus) return;
      const target = Array.from(root.querySelectorAll<HTMLElement>(`[${FOCUS}]`)).find(el => el.getAttribute(FOCUS) === focus.key);
      target?.focus();
      if (focus.start != null && focus.end != null && target && 'setSelectionRange' in target) {
        try { (target as HTMLInputElement).setSelectionRange(focus.start, focus.end); } catch { /* date/select fields */ }
      }
    },
  };
};

export const CALENDAR_EVENT_STYLES = `
.calendar-event { display: grid; gap: 1rem; min-width: 0; }
.calendar-event h3, .calendar-event h4, .calendar-event p { margin: 0; }
.calendar-event-head { display: grid; gap: .5rem; min-width: 0; }
.calendar-event-context, .calendar-event-title-row { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem 1rem; }
.calendar-event-title-row { justify-content: space-between; }
.calendar-event-head .col-explorer-detail-title { font-size: 1.125rem; line-height: 1.4; }
.calendar-event h3 { font-size: 1rem; }
.calendar-event-status, .calendar-event-hint, .calendar-event-identities { color: var(--fg-muted); font-size: .8125rem; overflow-wrap: anywhere; }
.calendar-event-invitation { display: grid; gap: .75rem; border: 1px solid var(--border); border-radius: .5rem; padding: 1rem; }
.calendar-event-meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem 1.5rem; margin: 0; }
.calendar-event-invitation .calendar-event-meta { grid-template-columns: minmax(0, 2fr) repeat(2, minmax(0, 1fr)); }
.calendar-event-meta dt { color: var(--fg-muted); font-size: .75rem; margin-bottom: .25rem; }
.calendar-event-meta dd { margin: 0; font-size: .875rem; overflow-wrap: anywhere; }
.calendar-event-description { white-space: pre-wrap; overflow-wrap: anywhere; font-size: .875rem; line-height: 1.6; margin-top: .5rem !important; }
.calendar-event-editor { display: grid; gap: 1rem; padding: 1rem; border: 1px solid var(--border); border-radius: .5rem; background: var(--surface); min-width: 0; }
.calendar-event-field { display: grid; gap: .375rem; font-size: .8125rem; min-width: 0; }
.calendar-event-field .data-input { box-sizing: border-box; width: 100%; min-width: 0; max-width: 100%; }
.calendar-event-field textarea { resize: vertical; line-height: 1.5; }
.calendar-event-date-field { display: grid; align-content: start; gap: .75rem; min-width: 0; }
.calendar-event-dates { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
.calendar-event-actions { display: flex; flex-wrap: wrap; gap: .5rem; }
.calendar-event-error, .calendar-event-discard { display: grid; gap: .75rem; padding: .875rem; border: 1px solid var(--border); border-radius: .375rem; }
.calendar-event-error { color: var(--danger); }
.calendar-event-identities summary { cursor: pointer; margin-bottom: .75rem; }
@media (max-width: 540px) { .calendar-event-meta, .calendar-event-invitation .calendar-event-meta, .calendar-event-dates { grid-template-columns: minmax(0, 1fr); } .calendar-event-editor { padding: .75rem; } }
`;
