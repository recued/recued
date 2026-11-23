import {
  CALENDAR_EVENT_EDIT_LIMITS, CALENDAR_EVENT_GUEST_LIMITS, DAY_MS, calendarDayMs, normalizeCalendarEventGuests,
  type CalendarEventDestination, type CalendarEventDestinations,
  type CalendarEventCreateRequest, type CalendarEventCreateResult, type CalendarEventGuest,
} from '@recued/contracts';
import { e, renderActionLabel } from '@recued/ui-shared';
import { classifyRpcError, humanizeRpcError } from '../shell/rpc-error-copy.js';
import { createCalendarOverlapPreview, CALENDAR_OVERLAP_STYLES, type CalendarOverlapCaller } from './calendar-overlap-preview.js';
import { calendarWallClockCandidates, calendarWallClockValue } from './calendar-event-surface.js';
import { calendarDraftDestination, createCalendarDraftCheckpoint, type CalendarRecoveryStore, type CalendarRecoveryValues } from './calendar-draft-recovery.js';
import { calendarTaskHref, type CalendarTaskOrigin, type CalendarTaskSeed } from './calendar-task-draft.js';
import { draftOriginHash } from './draft-origin.js';
import type { CalendarMailOrigin, CalendarMailSeed } from './calendar-mail.js';
import { calendarDuplicateEnd, calendarDuplicateSpanLabel, type CalendarDuplicateOrigin, type CalendarDuplicateSeed } from './calendar-event-duplicate.js';
import { createCalendarTimeFinder, CALENDAR_TIME_FIELD, CALENDAR_TIME_FINDER_STYLES } from './calendar-time-finder.js';

export const CALENDAR_CREATE_ACTION = 'calendar-create-';
export const CALENDAR_CREATE_FIELD = 'data-calendar-create-field';
const FOCUS = 'data-calendar-create-focus';
const REPEAT = 'data-calendar-create-repeat';
export interface CalendarCreateCallers {
  overlaps?: CalendarOverlapCaller;
  destinations?: () => Promise<CalendarEventDestinations>;
  create?: (input: CalendarEventCreateRequest) => Promise<CalendarEventCreateResult>;
}
export interface CalendarCreateDraft {
  destination: string; summary: string; description: string; location: string;
  start: string; end: string; allDay: boolean; startChoice: string; endChoice: string;
  guests: CalendarEventGuest[]; guestQuery: string;
}
const destinationKey = (destination: CalendarEventDestination) => JSON.stringify([destination.slug, destination.calendar_id]);
export const calendarCreateTimes = (draft: CalendarCreateDraft, zone: string): { start_at: number; end_at: number } => {
  const read = (key: 'start' | 'end'): number => {
    if (draft.allDay) {
      const at = calendarDayMs(draft[key]);
      if (at === null) throw new Error('Choose valid start and end dates.');
      return at + (key === 'end' ? DAY_MS : 0);
    }
    const candidates = calendarWallClockCandidates(draft[key], zone);
    if (!candidates.length) throw new Error(`Choose a valid ${key} time in ${zone}. That time may fall in a daylight saving gap.`);
    if (candidates.length === 1) return candidates[0]!;
    const choice = Number(draft[`${key}Choice`]);
    if (!draft[`${key}Choice`] || !candidates.includes(choice)) throw new Error(`Choose which repeated ${key} time you mean.`);
    return choice;
  };
  const start_at = read('start'), end_at = read('end');
  if (end_at <= start_at) throw new Error(draft.allDay ? 'The last day must be on or after the first day.' : 'The end must be after the start.');
  return { start_at, end_at };
};

export const createCalendarCreateSurface = (deps: {
  callers: CalendarCreateCallers; actionAttr: string; render(): void;
  context(): { day: string; zone: string; preferredSlug?: string | null };
  onCreated(result: CalendarEventCreateResult, duplicate?: CalendarDuplicateOrigin, mail?: CalendarMailOrigin): void;
  onCancelled?: (duplicate: CalendarDuplicateOrigin) => void;
  onMailCancelled?: (origin: CalendarMailOrigin) => void;
  onTaskCancelled?: (origin: CalendarTaskOrigin) => void;
  onTaskCreated?: (result: CalendarEventCreateResult, origin: CalendarTaskOrigin) => void;
  searchContacts?: (query: string) => Promise<CalendarEventGuest[]>;
  recovery?: CalendarRecoveryStore;
  now?: () => number;
}) => {
  let draft: CalendarCreateDraft | null = null, initial = '';
  let duplicate: CalendarDuplicateOrigin | null = null;
  let mailOrigin: CalendarMailOrigin | null = null;
  let taskOrigin: CalendarTaskOrigin | null = null;
  let zone = '', creationId = '', error = '', loading = false, saving = false, disposed = false;
  let destinations: CalendarEventDestinations = { destinations: [], unavailable: [] };
  // Whether the calendar list has loaded since the form opened. "No writable calendars" is said
  // only of a list that loaded: a refused load (a paused server, a lost connection) says why in
  // its own error, and "check your connections" would send the owner to the wrong place.
  let listed = false;
  let pending: CalendarEventCreateRequest | null = null;
  let needsCheck = false, generation = 0;
  let leave: (() => void) | null = null;
  let focus: string | null = null;
  let guestOptions: CalendarEventGuest[] = [], guestLoading = false, guestError = '', guestGeneration = 0;
  let guestComposing = false;
  let guestTimer: ReturnType<typeof setTimeout> | undefined;
  let incarnation: string | null = null, calendarName = '', recoveryDiscard: string | null = null, recoveryNotice = '';
  let recoveryRoot: ParentNode | null = null;
  const checkpoint = createCalendarDraftCheckpoint({ store: deps.recovery, now: deps.now, changed: () => {
    const status = recoveryRoot?.querySelector('[data-calendar-recovery-status]');
    if (status) status.textContent = checkpoint.message();
  } });
  const recoveryValues = (): CalendarRecoveryValues => ({ draft: structuredClone(draft!), zone, calendarName, incarnation, creationId, request: pending,
    ...(duplicate ? { duplicate: structuredClone(duplicate) } : {}), ...(mailOrigin ? { mail: structuredClone(mailOrigin) } : {}), ...(taskOrigin ? { task: structuredClone(taskOrigin) } : {}) });
  const captureDraft = () => { if (draft && (dirty() || checkpoint.hasChanges())) checkpoint.capture(recoveryValues()); };
  const flush = () => { captureDraft(); return checkpoint.flush(); };
  const overlaps = createCalendarOverlapPreview({ call: deps.callers.overlaps, id: 'create',
    actionAttr: deps.actionAttr, retryAction: 'calendar-create-overlap-retry' });
  const updateOverlaps = () => {
    if (!draft) { overlaps.reset(); return; }
    try { overlaps.update({ ...calendarCreateTimes(draft, zone), is_all_day: draft.allDay, timezone: zone }); }
    catch { overlaps.update(null); }
  };
  const timeFinder = createCalendarTimeFinder({
    call: deps.callers.overlaps, actionAttr: deps.actionAttr, focusAttr: FOCUS, now: deps.now,
    usable: () => Boolean(draft && !draft.allDay && !saving && !needsCheck && !disposed),
    choose: slot => {
      if (!draft || draft.allDay || saving || needsCheck || disposed) return;
      draft.start = calendarWallClockValue(slot.start_at, zone); draft.end = calendarWallClockValue(slot.end_at, zone);
      draft.startChoice = calendarWallClockCandidates(draft.start, zone).length > 1 ? String(slot.start_at) : '';
      draft.endChoice = calendarWallClockCandidates(draft.end, zone).length > 1 ? String(slot.end_at) : '';
      if (duplicate) duplicate.keepDuration = false;
      if (pending) { pending = null; creationId = crypto.randomUUID(); }
      timeFinder.reset(); error = ''; updateOverlaps(); paint('start');
    },
  });
  const available = () => Boolean(deps.callers.destinations && deps.callers.create);
  const dirty = () => Boolean(draft && (duplicate || mailOrigin || taskOrigin || needsCheck || JSON.stringify(draft) !== initial));
  const paint = (key?: string) => { captureDraft(); if (key) focus = key; deps.render(); };
  const destination = () => destinations.destinations.find(value => destinationKey(value) === draft?.destination);
  const canInvite = () => destination()?.can_invite === true && destination()?.provider !== 'local';
  const clearGuestSearch = () => {
    guestGeneration++; if (guestTimer) clearTimeout(guestTimer); guestTimer = undefined;
    guestOptions = []; guestLoading = false; guestError = '';
  };
  const reset = () => { checkpoint.suspend(); overlaps.reset(); timeFinder.reset(); generation++; clearGuestSearch(); guestComposing = false; draft = null; duplicate = null; mailOrigin = null; taskOrigin = null; pending = null; error = ''; leave = null; needsCheck = false; loading = false; incarnation = null; calendarName = ''; };
  const searchGuests = () => {
    clearGuestSearch();
    if (guestComposing) return;
    const query = draft?.guestQuery.trim() ?? '', mine = guestGeneration;
    if (!canInvite() || query.length < 2 || !deps.searchContacts) { paint(); return; }
    guestLoading = true; paint();
    guestTimer = setTimeout(async () => {
      guestTimer = undefined;
      try {
        const values = await deps.searchContacts!(query);
        if (disposed || mine !== guestGeneration || !draft || saving || needsCheck || !canInvite()) return;
        const candidates: CalendarEventGuest[] = [];
        for (const value of values.slice(0, 8)) {
          try { candidates.push(...normalizeCalendarEventGuests([value])); } catch { /* A contact without a usable email is not a guest. */ }
        }
        guestOptions = normalizeCalendarEventGuests(candidates).filter(value => !draft!.guests.some(guest => guest.email === value.email));
      } catch {
        if (disposed || mine !== guestGeneration || !draft) return;
        guestError = 'Contacts could not be loaded. You can still enter an email address.';
      } finally { if (!disposed && mine === guestGeneration && draft) { guestLoading = false; paint(); } }
    }, 200);
  };
  const addGuest = (guest?: CalendarEventGuest) => {
    if (!draft || saving || needsCheck || loading || guestComposing || !canInvite()) return;
    try {
      const next = normalizeCalendarEventGuests([guest ?? { email: draft.guestQuery }])[0]!;
      if (draft.guests.some(value => value.email === next.email)) throw new Error('This guest is already on the list.');
      if (draft.guests.length >= CALENDAR_EVENT_GUEST_LIMITS.count) throw new Error(`Choose up to ${CALENDAR_EVENT_GUEST_LIMITS.count} guests.`);
      draft.guests.push(next); draft.guestQuery = ''; clearGuestSearch(); error = '';
      if (pending) { pending = null; creationId = crypto.randomUUID(); }
    } catch (cause) { guestError = humanizeRpcError(cause); }
    paint('guestQuery');
  };
  const load = async () => {
    if (!draft || loading || saving || needsCheck || !deps.callers.destinations) return;
    const mine = ++generation, preferred = deps.context().preferredSlug;
    loading = true; error = ''; paint();
    try {
      const result = await deps.callers.destinations();
      if (disposed || mine !== generation || !draft) return;
      if (!Array.isArray(result?.destinations) || !Array.isArray(result.unavailable)) throw new Error('The calendar list could not be confirmed.');
      destinations = result; listed = true;
      const before = draft.destination;
      const selected = result.destinations.find(value => destinationKey(value) === before);
      if (selected && incarnation && selected.incarnation !== incarnation) {
        draft.destination = ''; incarnation = null; calendarName = '';
        error = 'This calendar connection changed. Choose a calendar again. Your event details have been kept.';
      } else if (selected) { incarnation = selected.incarnation; calendarName = selected.name; }
      else if (!before) {
        // Losing access to the selected destination must not silently move a
        // draft onto another calendar, including the local calendar.
        const selected = preferred ? result.destinations.find(value => value.slug === preferred)
          : result.destinations.find(value => value.provider === 'local') ?? result.destinations[0];
        draft.destination = selected ? destinationKey(selected) : '';
        incarnation = selected?.incarnation ?? null;
        calendarName = selected?.name ?? '';
      }
      // Loading a sensible destination is not an unsaved owner edit.
      if (initial) {
        const baseline: CalendarCreateDraft = JSON.parse(initial);
        if (baseline.destination === before) initial = JSON.stringify({ ...baseline, destination: draft.destination });
      }
    } catch (cause) {
      if (!disposed && mine === generation) error = classifyRpcError(cause).code === 'unknown_method'
        ? 'Update your Recued server to create events here.' : humanizeRpcError(cause);
    } finally { if (!disposed && mine === generation) { loading = false; paint(); } }
  };
  const beforeLeave = (resume: () => void): boolean => {
    if (saving) { paint('save'); return false; }
    if (!draft) return true;
    if (!dirty()) { reset(); return true; }
    if (!leave) { timeFinder.reset(); leave = resume; }
    paint('keep'); return false;
  };
  const open = (seed?: CalendarDuplicateSeed, mailSeed?: CalendarMailSeed, taskSeed?: CalendarTaskSeed): boolean => {
    if (!available() || disposed) return false;
    if (draft) { paint(saving || needsCheck ? 'save' : 'summary'); return false; }
    const context = deps.context(); zone = seed?.zone ?? context.zone;
    const nextHour = Math.ceil(((deps.now ?? Date.now)() + 1) / 3_600_000) * 3_600_000;
    const next = calendarWallClockValue(nextHour, zone);
    const start = next.slice(0, 10) === context.day ? next : `${context.day}T09:00`;
    const end = start === next ? calendarWallClockValue(nextHour + 3_600_000, zone) : `${context.day}T10:00`;
    creationId = crypto.randomUUID(); destinations = { destinations: [], unavailable: [] }; listed = false;
    duplicate = seed ? structuredClone(seed.origin) : null;
    mailOrigin = mailSeed ? structuredClone(mailSeed.origin) : null;
    taskOrigin = taskSeed ? structuredClone(taskSeed.origin) : null;
    const fields = seed ?? mailSeed ?? taskSeed;
    draft = { destination: '', summary: fields?.summary ?? '', description: fields?.description ?? '', location: fields?.location ?? '',
      start: fields ? '' : start, end: fields ? '' : end,
      allDay: seed?.origin.allDay ?? false, startChoice: '', endChoice: '', guests: [], guestQuery: '' };
    initial = JSON.stringify(draft);
    checkpoint.begin(recoveryValues(), undefined, Boolean(duplicate || mailOrigin || taskOrigin)); recoveryNotice = ''; recoveryDiscard = null;
    error = ''; needsCheck = false; pending = null; updateOverlaps(); paint('summary'); void load();
    return true;
  };
  const save = async () => {
    if (disposed || !draft || loading || saving || leave || guestComposing || !deps.callers.create) return;
    if (!needsCheck) {
      const destination = destinations.destinations.find(value => destinationKey(value) === draft!.destination);
      try {
        if (!destination) throw new Error('Choose a writable calendar.');
        if ((draft.guests.length || draft.guestQuery.trim()) && !canInvite()) {
          focus = 'destination'; throw new Error('Choose a calendar that can send invitations, or clear the guests to create a personal event.');
        }
        if (draft.guestQuery.trim()) { focus = 'guestQuery'; throw new Error('Add the guest or clear the search before creating the event.'); }
        const guests = normalizeCalendarEventGuests(draft.guests);
        if (!draft.summary.trim()) { focus = 'summary'; throw new Error('Enter an event title.'); }
        for (const key of ['summary', 'description', 'location'] as const) {
          if (new TextEncoder().encode(draft[key]).length > CALENDAR_EVENT_EDIT_LIMITS[key]) throw new Error(`${key === 'summary' ? 'Title' : key === 'description' ? 'Notes' : 'Location'} is too long.`);
        }
        pending = { slug: destination.slug, calendar_id: destination.calendar_id,
          expected_incarnation: destination.incarnation, creation_id: creationId,
          summary: draft.summary.trim(), description: draft.description, location: draft.location,
          ...calendarCreateTimes(draft, zone), timezone: zone, is_all_day: draft.allDay,
          ...(guests.length ? { guests, send_invitations: true as const } : {}) };
      } catch (cause) { error = humanizeRpcError(cause); paint(); return; }
    }
    if (!pending) return;
    timeFinder.reset();
    const ticket = checkpoint.startAttempt(recoveryValues());
    if (ticket?.blocked) {
      if (!needsCheck) pending = null;
      error = 'The save could not start because the recovery copy could not be updated. Keep this event open and try again.';
      paint('save'); return;
    }
    const request = pending, mine = generation, checking = needsCheck;
    clearGuestSearch(); saving = true; error = ''; paint('save');
    try {
      const result = await deps.callers.create(request);
      const event = result?.snapshot?.event;
      if (result.slug !== request.slug || result.snapshot.incarnation !== request.expected_incarnation
        || !event?.source_id || event.calendar_id !== request.calendar_id || !result.snapshot.record?.record_id
        || result.snapshot.record.source_id !== event.source_id || result.snapshot.record.record_id !== event.record_id
        || event.summary !== request.summary || event.description !== request.description || event.location !== request.location
        || event.start_at !== request.start_at || event.end_at !== request.end_at || event.is_all_day !== request.is_all_day || event.is_recurring
        || request.send_invitations && result.invitations_requested !== true) {
        throw new Error('The saved event could not be confirmed.');
      }
      checkpoint.settle(ticket, 'confirmed');
      if (disposed || mine !== generation) return;
      const origin = duplicate, email = mailOrigin, task = taskOrigin;
      saving = false; reset(); if (task && deps.onTaskCreated) deps.onTaskCreated(result, task); else if (email) deps.onCreated(result, undefined, email); else if (origin) deps.onCreated(result, origin); else deps.onCreated(result);
    } catch (cause) {
      const code = classifyRpcError(cause).code;
      const refused = !checking && code !== null && ['invalid_args', 'forbidden', 'unauthorized', 'resource_changed', 'not_configured', 'unknown_method'].includes(code);
      checkpoint.settle(ticket, refused ? 'refused' : 'unknown');
      if (disposed || mine !== generation) return;
      needsCheck = !refused;
      if (refused) pending = null;
      error = code === 'unknown_method' ? 'Update your Recued server to create events here.' : needsCheck
        ? 'The save could not be confirmed. Check this save, or check the selected calendar before creating another event. Your details have been kept.' : humanizeRpcError(cause);
    } finally { if (!disposed && mine === generation) { saving = false; paint(); } }
  };
  const button = (name: string, label: string, primary = false, accessibleLabel?: string) => {
    const icon = name === 'save' ? needsCheck ? 'refresh' : 'booking' : name === 'reload' ? 'refresh' : null;
    return `<button type="${name === 'save' ? 'submit' : 'button'}" class="data-button${primary ? ' data-button--primary' : ''}" ${accessibleLabel ? `aria-label="${e(accessibleLabel)}"` : ''} ${name === 'save' ? '' : `${deps.actionAttr}="${CALENDAR_CREATE_ACTION}${name}"`} ${FOCUS}="${name}"${saving ? ' aria-disabled="true" aria-busy="true"' : ''}>${icon ? renderActionLabel(icon, label) : e(label)}</button>`;
  };
  const field = (key: string, label: string, control: string) => `<label class="calendar-create-field"><span id="calendar-create-label-${key}">${e(label)}</span>${control}</label>`;
  const attr = (key: string) => `${CALENDAR_CREATE_FIELD}="${key}" ${FOCUS}="${key}"${key === 'allDay' ? '' : ` aria-labelledby="calendar-create-label-${key}"`}`;
  const repeatedTime = (key: 'start' | 'end') => {
    if (!draft || draft.allDay) return '';
    const candidates = calendarWallClockCandidates(draft[key], zone);
    return candidates.length > 1 ? field(`${key}Choice`, `Which ${key} time?`, `<select class="data-input" ${attr(`${key}Choice`)}><option value="">Choose a time</option>${candidates.map((at, index) => `<option value="${at}"${draft![`${key}Choice`] === String(at) ? ' selected' : ''}>${index === 0 ? 'First' : 'Second'} ${e(new Intl.DateTimeFormat(undefined, { timeZone: zone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(at))}</option>`).join('')}</select>`) : '';
  };
  const duplicateHint = () => !duplicate ? '' : `Original ${duplicate.allDay ? 'span' : 'duration'}: ${calendarDuplicateSpanLabel(duplicate)}. ${duplicate.keepDuration ? 'Changing the start keeps this span until you edit the end.' : 'Dates and times are now set separately.'} Add guests below to review invitations.`;
  const renderGuests = () => {
    if (!draft) return '';
    const selected = destination(), supported = canInvite(), retained = draft.guests.length || draft.guestQuery.trim();
    if (!selected && !retained) return '';
    if (!supported && !retained) return `<p class="calendar-agenda-muted">${e(selected?.invitation_unavailable_reason
      || (selected?.provider === 'local' ? 'Choose a supported connected calendar to invite guests.' : 'Guest invitations are not available for this calendar.'))}</p>`;
    return `<section class="calendar-create-guests" aria-label="Event guests"><div class="calendar-create-guest-heading"><h4>Guests <span>${draft.guests.length}</span></h4>${retained ? button('guest-clear', 'Clear guests') : ''}</div>
      <p class="calendar-agenda-muted">${supported ? `${e(selected?.provider === 'graph' ? 'Outlook' : selected?.provider === 'gcal' ? 'Google Calendar' : 'Your calendar')} sends invitations to these guests and handles their replies.`
        : e(selected?.invitation_unavailable_reason || 'This calendar cannot send invitations. Choose another calendar or clear the guests.')}</p>
      ${draft.guests.length ? `<ul class="calendar-create-guest-list">${draft.guests.map(guest => `<li><span>${guest.display_name ? `<strong>${e(guest.display_name)}</strong><br>` : ''}${e(guest.email)}</span>${button(`guest-remove-${encodeURIComponent(guest.email)}`, 'Remove', false, `Remove ${guest.display_name || guest.email}`)}</li>`).join('')}</ul>` : ''}
      ${supported ? `<div class="calendar-create-guest-entry">${field('guestQuery', 'Add guests', `<input type="text" class="data-input" ${attr('guestQuery')} value="${e(draft.guestQuery)}" maxlength="320" autocomplete="off" placeholder="Name or email address" aria-describedby="calendar-create-guest-help">`)}${button('guest-add', 'Add guest')}</div><p id="calendar-create-guest-help" class="calendar-agenda-muted">Choose a contact or add one email address at a time. Enter adds a guest.</p>`
        : draft.guestQuery ? `<p>Unadded guest: ${e(draft.guestQuery)}</p>` : ''}
      ${guestLoading ? '<p role="status">Finding contacts…</p>' : ''}${guestError ? `<p role="alert">${e(guestError)}</p>` : ''}
      ${supported && guestOptions.length ? `<ul class="calendar-create-guest-options" aria-label="Matching contacts">${guestOptions.map(guest => `<li>${button(`guest-pick-${encodeURIComponent(guest.email)}`, `Add ${guest.display_name ? `${guest.display_name} · ` : ''}${guest.email}`)}</li>`).join('')}</ul>` : ''}
    </section>`;
  };
  const render = (source?: { slug: string; recordId: string; kind?: 'mail' | 'calendar' }): string => {
    const recoveries = renderRecoveries(source);
    if (!draft) return recoveries;
    const provider = { local: 'On this server', gcal: 'Google Calendar', graph: 'Outlook', caldav: 'CalDAV' };
    const missing = draft.destination && !destination() ? calendarDraftDestination(draft.destination) : null;
    return `${recoveries}<form class="calendar-create" role="region" aria-label="${duplicate ? 'Duplicate event' : mailOrigin ? 'Event from email' : taskOrigin ? 'Time for task' : 'New event'}" data-calendar-create-form>
      <div class="calendar-create-heading"><div><h3>${duplicate ? 'Duplicate event' : mailOrigin ? 'Event from email' : taskOrigin ? 'Time for task' : 'New event'}</h3><p class="calendar-agenda-muted">One-off event · Times in ${e(zone)}</p></div></div>
      ${taskOrigin ? `<p>For <a href="${e(calendarTaskHref(taskOrigin))}">${e(taskOrigin.label)}</a>. Choose dates and a calendar. Scheduling time does not change the task’s deadline or completion status.</p>` : ''}
      ${mailOrigin ? `<p>From <a href="${e(draftOriginHash(mailOrigin))}">${e(mailOrigin.label)}</a>. Choose dates and a calendar, then add any guests you want to invite.</p>` : ''}
      ${duplicate ? `<p>Copy of <strong>${e(duplicate.context.name)}</strong>. Choose a new date and calendar. The original event stays unchanged.</p>
        <p class="calendar-agenda-muted" data-calendar-duplicate-span>${e(duplicateHint())}</p>` : ''}
      ${deps.recovery ? `<p class="calendar-agenda-muted" data-calendar-recovery-status role="status">${e(checkpoint.message())}</p>` : ''}
      ${loading ? '<p role="status">Loading writable calendars…</p>' : ''}
      ${error && !leave ? `<p role="alert">${e(error)}</p>` : ''}
      ${destinations.unavailable.length ? `<details><summary>Some calendars are unavailable</summary><ul>${destinations.unavailable.map(value => `<li>${e(value.slug)}: ${e(value.reason)}</li>`).join('')}</ul></details>` : ''}
      <fieldset${saving || needsCheck || leave ? ' disabled' : ''} class="calendar-create-fields">
        ${field('destination', 'Calendar', `<select class="data-input" ${attr('destination')}${loading ? ' disabled' : ''}><option value="">Choose a calendar</option>${missing ? `<option value="${e(draft.destination)}" selected>${e(calendarName || 'Selected calendar')} · ${needsCheck ? 'Save awaiting confirmation' : 'Calendar unavailable'}</option>` : ''}${destinations.destinations.map(value => `<option value="${e(destinationKey(value))}"${draft!.destination === destinationKey(value) ? ' selected' : ''}>${e(value.name)}${value.provider === 'local' ? '' : ` · ${e(value.slug)} · ${provider[value.provider]}`}</option>`).join('')}</select>`)}
        ${!loading && listed && !destinations.destinations.length ? '<p class="calendar-agenda-muted">No writable calendars are available. Check your connections or reload calendars.</p>' : ''}
        ${field('summary', 'Title', `<input type="text" class="data-input" ${attr('summary')} maxlength="${CALENDAR_EVENT_EDIT_LIMITS.summary}" value="${e(draft.summary)}" required>`)}
        <label class="calendar-create-all-day"><input type="checkbox" ${attr('allDay')}${draft.allDay ? ' checked' : ''}> All day</label>
        ${deps.callers.overlaps && !draft.allDay && !needsCheck ? `<div class="calendar-create-actions">${button('find-open', 'Find a time')}</div>${timeFinder.render()}` : ''}
        <div class="calendar-create-times">${field('start', draft.allDay ? 'First day' : 'Starts', `<input type="${draft.allDay ? 'date' : 'datetime-local'}"${!draft.allDay && duplicate ? ' step="0.001"' : ''} class="data-input" ${attr('start')} value="${e(draft.start)}" required>`)}
          ${field('end', draft.allDay ? 'Last day (inclusive)' : 'Ends', `<input type="${draft.allDay ? 'date' : 'datetime-local'}"${!draft.allDay && duplicate ? ' step="0.001"' : ''} class="data-input" ${attr('end')} value="${e(draft.end)}" required>`)}</div>
        ${(['start', 'end'] as const).map(key => { const choices = repeatedTime(key); return `<div ${REPEAT}="${key}"${choices ? '' : ' hidden'}>${choices}</div>`; }).join('')}
        ${overlaps.render()}
        ${field('location', 'Location (optional)', `<input type="text" class="data-input" ${attr('location')} maxlength="${CALENDAR_EVENT_EDIT_LIMITS.location}" value="${e(draft.location)}">`)}
        ${field('description', 'Notes (optional)', `<textarea class="data-input" ${attr('description')} rows="3" maxlength="${CALENDAR_EVENT_EDIT_LIMITS.description}">\n${e(draft.description)}</textarea>`)}
        ${!loading ? renderGuests() : ''}
      </fieldset>
      ${!leave ? `<div class="calendar-create-actions">${button('save', saving ? 'Saving…' : needsCheck ? 'Check save' : draft.guests.length ? 'Create and send invitations' : 'Create event', true)}${button('cancel', 'Cancel')}${!needsCheck ? button('reload', 'Reload calendars') : ''}</div>` : ''}
      ${needsCheck && pending?.send_invitations ? '<p class="calendar-agenda-muted">Checking this save will not create another event or send another set of invitations.</p>' : ''}
      ${leave ? `<div class="calendar-create-discard" role="alertdialog" aria-modal="true" aria-labelledby="calendar-create-leave-title" aria-describedby="calendar-create-leave-copy"><h4 id="calendar-create-leave-title">Leave this event?</h4><p id="calendar-create-leave-copy">${deps.recovery ? 'Keep your draft in this tab for later, discard it, or continue editing.' : 'Your unfinished draft will be lost.'}${needsCheck ? ' This event may already exist in your calendar. Resume to check its original save before creating another.' : ''}</p>${error ? `<p role="alert">${e(error)}</p>` : ''}<div class="calendar-create-actions">${button('keep', 'Keep editing')}${deps.recovery ? button('later', 'Keep draft for later') : ''}${button('discard', 'Discard draft')}</div></div>` : ''}
    </form>`;
  };
  const renderRecoveries = (source?: { slug: string; recordId: string; kind?: 'mail' | 'calendar' }): string => {
    const entries = deps.recovery?.list().filter(entry => entry.id !== checkpoint.id()
      && (!source || (source.kind === 'mail' ? entry.values.mail?.slug === source.slug && entry.values.mail.recordId === source.recordId
        : entry.values.duplicate?.context.slug === source.slug && entry.values.duplicate.context.recordId === source.recordId))) ?? [];
    if (!entries.length) return recoveryNotice && !draft ? `<p role="alert">${e(recoveryNotice)}</p>` : '';
    return `<section class="calendar-draft-recoveries" role="region" aria-label="Unfinished calendar events"><h3>Unfinished calendar events</h3>
      <p>Drafts are kept in this browser tab for up to 7 days. Unconfirmed saves stay until checked or discarded.</p>
      ${recoveryNotice ? `<p role="alert">${e(recoveryNotice)}</p>` : ''}
      ${entries.map(entry => {
        const values = entry.values;
        const action = (name: string, label: string) => `<button type="button" class="data-button" ${deps.actionAttr}="${CALENDAR_CREATE_ACTION}recovery-${name}" data-calendar-draft-id="${e(entry.id)}" ${FOCUS}="recovery-${name}:${e(entry.id)}"${draft || saving ? ' disabled' : ''}>${label}</button>`;
        return `<article><h4>${e(values.draft.summary.trim() || 'Untitled event')}</h4><p>${e(values.draft.start.replace('T', ' ') || 'No start chosen')} · ${e(values.zone)} · ${e(values.calendarName || 'Calendar not selected')}</p>
          ${entry.status !== 'editing' ? '<p>This save was not confirmed. Resume to check the original save before creating another event.</p>' : ''}
          <div class="calendar-create-actions">${action('resume', 'Resume draft')}${action('discard', 'Discard draft')}</div>
          ${recoveryDiscard === entry.id ? `<div role="group" aria-label="Discard this event recovery copy?"><p>Discard this recovery copy? An event already saved in your calendar will stay there.</p><div class="calendar-create-actions">${action('keep', 'Keep draft')}${action('remove', 'Discard recovery copy')}</div></div>` : ''}</article>`;
      }).join('')}</section>`;
  };
  const recover = (id: string) => {
    if (draft || saving || !available() || !deps.recovery) return false;
    const entry = deps.recovery.get(id);
    if (!entry) { recoveryNotice = 'This recovery copy is no longer available.'; paint('new'); return false; }
    const values = entry.values;
    draft = structuredClone(values.draft); zone = values.zone; calendarName = values.calendarName; incarnation = values.incarnation; creationId = values.creationId;
    duplicate = values.duplicate ? structuredClone(values.duplicate) : null;
    mailOrigin = values.mail ? structuredClone(values.mail) : null;
    taskOrigin = values.task ? structuredClone(values.task) : null;
    pending = values.request ? structuredClone(values.request) : null; needsCheck = entry.status !== 'editing';
    initial = ''; error = needsCheck ? 'This save was interrupted. Check its original request before creating another event.' : '';
    destinations = { destinations: [], unavailable: [] }; listed = false; recoveryNotice = ''; recoveryDiscard = null;
    checkpoint.begin(recoveryValues(), entry); updateOverlaps(); paint(needsCheck ? 'save' : 'summary');
    if (!needsCheck) void load();
    return true;
  };
  return {
    available, render, open: (seed?: CalendarDuplicateSeed) => open(seed), openFromMail: (seed: CalendarMailSeed) => open(undefined, seed),
    openFromTask: (seed: CalendarTaskSeed) => open(undefined, undefined, seed), resumeDraft: recover,
    showRecoveryNotice: (message: string) => { recoveryNotice = message; paint(); }, beforeLeave, flush,
    releaseAfterLeave: (): boolean => { if (saving) return false; flush(); reset(); return true; },
    isOpen: () => draft !== null,
    hasUnsavedChanges: dirty,
    hasInFlightWork: () => saving,
    handleSubmit: (event: Event): void => {
      if (!(event.target as HTMLElement | null)?.hasAttribute?.('data-calendar-create-form')) return;
      event.preventDefault(); void save();
    },
    handleKeyDown: (event: KeyboardEvent): boolean => {
      if (leave && event.key === 'Escape' && !event.isComposing) {
        event.preventDefault(); leave = null; error = ''; paint(needsCheck ? 'save' : 'summary'); return true;
      }
      if (leave && event.key === 'Tab') {
        const actions = ['keep', ...(deps.recovery ? ['later'] : []), 'discard']
          .map(key => recoveryRoot?.querySelector<HTMLElement>(`[${FOCUS}="${key}"]`)).filter((element): element is HTMLElement => Boolean(element));
        const index = actions.indexOf(event.target as HTMLElement), step = event.shiftKey ? -1 : 1;
        const next = index < 0 ? actions[event.shiftKey ? actions.length - 1 : 0] : actions[(index + step + actions.length) % actions.length];
        event.preventDefault(); next?.focus(); return true;
      }
      if (event.key === 'Enter' && (event.target as HTMLElement | null)?.hasAttribute?.(CALENDAR_TIME_FIELD) && timeFinder.owns(event.target as HTMLElement)) {
        if (event.isComposing || event.keyCode === 229) return true;
        event.preventDefault();
        timeFinder.action('find-search');
        return true;
      }
      if (event.key !== 'Enter' || (event.target as HTMLElement | null)?.getAttribute?.(CALENDAR_CREATE_FIELD) !== 'guestQuery') return false;
      if (guestComposing || event.isComposing || event.keyCode === 229) return true;
      event.preventDefault(); addGuest(); return true;
    },
    handleComposition: (event: CompositionEvent): void => {
      const target = event.target as HTMLInputElement | null;
      if (target?.getAttribute?.(CALENDAR_CREATE_FIELD) !== 'guestQuery' || !draft || saving || needsCheck) return;
      guestComposing = event.type === 'compositionstart';
      if (guestComposing) clearGuestSearch();
      else { draft.guestQuery = target.value; searchGuests(); }
    },
    handleAction: (action: string, target?: HTMLElement): boolean => {
      if (!action.startsWith(CALENDAR_CREATE_ACTION)) return false;
      if (disposed) return true;
      const name = action.slice(CALENDAR_CREATE_ACTION.length);
      if (leave && !['keep', 'later', 'discard'].includes(name)) return true;
      if (name.startsWith('recovery-')) {
        if (draft || saving || !deps.recovery) return true;
        const id = target?.getAttribute('data-calendar-draft-id') ?? '';
        if (name === 'recovery-resume') recover(id);
        else if (name === 'recovery-discard') { recoveryDiscard = id; paint(`recovery-keep:${id}`); }
        else if (name === 'recovery-keep') { recoveryDiscard = null; paint(`recovery-discard:${id}`); }
        else if (name === 'recovery-remove' && recoveryDiscard === id) {
          if (!deps.recovery.remove(id)) { recoveryNotice = 'This recovery copy could not be discarded. Try again.'; paint(`recovery-remove:${id}`); }
          else { recoveryNotice = ''; recoveryDiscard = null; paint('new'); }
        }
      } else if (name === 'overlap-retry') overlaps.retry();
      else if (name === 'find-open' && draft && !draft.allDay && !saving && !needsCheck && deps.callers.overlaps) {
        let minutes = 60;
        try { const times = calendarCreateTimes(draft, zone); const span = (times.end_at - times.start_at) / 60_000; if (Number.isInteger(span) && span >= 15 && span <= 480) minutes = span; } catch { /* An unfinished interval starts with one hour. */ }
        timeFinder.open(draft.start.slice(0, 10) || deps.context().day, zone, minutes); paint('find-duration');
      } else if (name === 'find-close') { timeFinder.reset(); paint('find-open'); }
      else if (name.startsWith('find-')) timeFinder.action(name);
      else if (name === 'guest-add') addGuest();
      else if (name.startsWith('guest-pick-')) {
        const guest = guestOptions.find(value => encodeURIComponent(value.email) === name.slice('guest-pick-'.length));
        if (guest) addGuest(guest);
      } else if ((name === 'guest-clear' || name.startsWith('guest-remove-')) && draft && !saving && !needsCheck) {
        draft.guests = name === 'guest-clear' ? [] : draft.guests.filter(guest => encodeURIComponent(guest.email) !== name.slice('guest-remove-'.length));
        if (name === 'guest-clear') draft.guestQuery = '';
        error = '';
        if (draft.guestQuery.trim()) searchGuests(); else clearGuestSearch();
        paint(canInvite() ? 'guestQuery' : 'destination');
      } else if (name === 'new') open();
      else if (name === 'save') void save();
      else if (name === 'reload') void load();
      else if (name === 'keep') { leave = null; error = ''; paint(needsCheck ? 'save' : 'summary'); }
      else if (name === 'later' && deps.recovery && draft && leave && !saving) {
        captureDraft();
        if (!checkpoint.keepForLater()) {
          error = 'Your latest event draft could not be confirmed in this tab. Keep editing or try keeping it again before leaving.';
          paint('later'); return true;
        }
        const resume = leave; reset(); paint(); resume();
      }
      else if (name === 'discard' && !saving) {
        if (!checkpoint.discard()) { error = 'This recovery copy could not be discarded. Try again.'; paint('discard'); return true; }
        const resume = leave, origin = duplicate, email = mailOrigin, task = taskOrigin; reset(); paint(resume ? undefined : 'new');
        if (resume) resume(); else if (origin) deps.onCancelled?.(origin); else if (email) deps.onMailCancelled?.(email); else if (task) deps.onTaskCancelled?.(task);
      }
      else if (name === 'cancel') {
        const origin = duplicate, email = mailOrigin, task = taskOrigin;
        const cancel = () => { reset(); paint('new'); if (origin) deps.onCancelled?.(origin); else if (email) deps.onMailCancelled?.(email); else if (task) deps.onTaskCancelled?.(task); };
        if (beforeLeave(cancel)) cancel();
      }
      return true;
    },
    handleInput: (target: HTMLElement, change = false): boolean => {
      if (leave) return target.getAttribute(CALENDAR_CREATE_FIELD) !== null || target.getAttribute(CALENDAR_TIME_FIELD) !== null;
      if (timeFinder.input(target)) return true;
      const key = target.getAttribute(CALENDAR_CREATE_FIELD) as keyof CalendarCreateDraft | null;
      if (!key || !draft || !(key in draft)) return false;
      if (key === 'guests') return false;
      if (saving || needsCheck) return true;
      if (key === 'allDay') {
        const allDay = (target as HTMLInputElement).checked;
        if (allDay !== draft.allDay) {
          timeFinder.reset();
          if (duplicate) duplicate.keepDuration = false;
          draft.allDay = allDay;
          draft.start = !draft.start ? '' : allDay ? draft.start.slice(0, 10) : `${draft.start}T09:00`;
          draft.end = !draft.end ? '' : allDay ? draft.end.slice(0, 10) : `${draft.end}T10:00`;
          draft.startChoice = draft.endChoice = '';
          updateOverlaps(); paint('allDay');
        }
      } else {
        const value = (target as HTMLInputElement).value;
        const changed = draft[key] !== value;
        if (changed) {
          if (duplicate && (key === 'end' || key === 'endChoice')) duplicate.keepDuration = false;
          const hint = target.closest?.('.calendar-create')?.querySelector('[data-calendar-duplicate-span]');
          if (hint && duplicate) hint.textContent = duplicateHint();
          draft[key] = value;
          if (key === 'start' || key === 'end') {
            draft[`${key}Choice`] = '';
            const host = target.closest?.('.calendar-create')?.querySelector<HTMLElement>(`[${REPEAT}="${key}"]`);
            if (host) { const choices = repeatedTime(key); host.innerHTML = choices; host.hidden = !choices; }
          }
          if (duplicate?.keepDuration && (key === 'start' || key === 'startChoice')) {
            const times = calendarDuplicateEnd(draft, zone, duplicate);
            draft.end = times?.end ?? ''; draft.endChoice = times?.endChoice ?? '';
            const form = target.closest?.('.calendar-create');
            const end = form?.querySelector<HTMLInputElement>(`[${CALENDAR_CREATE_FIELD}="end"]`);
            if (end) end.value = draft.end;
            const host = form?.querySelector<HTMLElement>(`[${REPEAT}="end"]`);
            if (host) { const choices = repeatedTime('end'); host.innerHTML = choices; host.hidden = !choices; }
          }
          if (pending) { pending = null; creationId = crypto.randomUUID(); }
          if (key === 'destination') { incarnation = destination()?.incarnation ?? null; calendarName = destination()?.name ?? ''; }
          if (['start', 'end', 'startChoice', 'endChoice'].includes(key)) {
            overlaps.mount(target.closest?.('.calendar-create') ?? target); updateOverlaps();
          }
        }
        // Text and date fields also fire change while focus is moving to the
        // next field. Replacing that next control here would lose its input.
        if (key === 'guestQuery' && changed) searchGuests();
        else if (change && (key === 'destination' || key === 'startChoice' || key === 'endChoice')) {
          if (key === 'destination') clearGuestSearch();
          paint(key);
        }
      }
      captureDraft();
      return true;
    },
    captureFocus: (element: Element | null | undefined) => {
      const key = element?.getAttribute?.(FOCUS);
      if (!key) return null;
      const control = element as HTMLInputElement;
      return { key, start: control.selectionStart, end: control.selectionEnd };
    },
    restoreFocus: (root: ParentNode, previous: { key: string; start?: number | null; end?: number | null } | null) => {
      recoveryRoot = root;
      overlaps.mount(root);
      timeFinder.mount(root);
      const explicit = focus, key = explicit ?? previous?.key; focus = null;
      const target = key ? root.querySelector<HTMLElement>(`[${FOCUS}="${key}"]`) : null;
      target?.focus({ preventScroll: true });
      if (!explicit && target && previous?.start != null && previous.end != null) {
        try { (target as HTMLInputElement).setSelectionRange(previous.start, previous.end); } catch { /* Native date and select controls have no text selection. */ }
      }
    },
    dispose: () => { flush(); recoveryRoot = null; disposed = true; reset(); },
  };
};

export const CALENDAR_CREATE_STYLES = CALENDAR_OVERLAP_STYLES + CALENDAR_TIME_FINDER_STYLES + `
.calendar-draft-recoveries { margin-bottom:1rem; padding:1rem; border:1px solid var(--border); border-radius:10px; background:var(--surface); }
.calendar-draft-recoveries h3,.calendar-draft-recoveries h4 { margin:0 0 .5rem; }
.calendar-draft-recoveries p { color:var(--fg-muted); font-size:.9rem; overflow-wrap:anywhere; }
.calendar-draft-recoveries article + article { border-top:1px solid var(--border); margin-top:1rem; padding-top:1rem; }
.calendar-create .data-button { display:inline-flex; align-items:center; justify-content:center; gap:6px; }
.calendar-create .data-button svg[aria-hidden=true] { flex:none; }
.calendar-create { border:1px solid var(--border); border-radius:10px; padding:20px; display:grid; gap:16px; max-width:760px; background:var(--surface); min-width:0; }
.calendar-create h3 { margin:0 0 5px; font-size:1.15rem; }
.calendar-create > p { min-width:0; overflow-wrap:anywhere; }
.calendar-create-fields { display:grid; gap:14px; border:0; margin:0; padding:0; min-width:0; }
.calendar-create-field { display:grid; gap:6px; min-width:0; font-size:14px; }
.calendar-create-field .data-input { width:100%; min-width:0; box-sizing:border-box; }
.calendar-create-times { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px; }
.calendar-create-all-day,.calendar-create-actions { display:flex; align-items:center; flex-wrap:wrap; gap:10px; }
.calendar-create-discard { border-top:1px solid var(--border); padding-top:14px; display:grid; gap:12px; }
.calendar-create-guests { border-top:1px solid var(--border); padding-top:14px; display:grid; gap:10px; min-width:0; }
.calendar-create-guests h4,.calendar-create-guests p { margin:0; }
.calendar-create-guest-heading,.calendar-create-guest-list li { display:flex; justify-content:space-between; align-items:center; gap:12px; min-width:0; }
.calendar-create-guest-heading h4 span { color:var(--fg-muted); font-weight:normal; margin-left:6px; }
.calendar-create-guest-entry { display:flex; align-items:end; gap:10px; min-width:0; }
.calendar-create-guest-entry label { flex:1; }
.calendar-create-guest-list,.calendar-create-guest-options { list-style:none; margin:0; padding:0; display:grid; gap:8px; }
.calendar-create-guest-list li { border:1px solid var(--border); border-radius:8px; padding:8px 10px; }
.calendar-create-guest-list li span { overflow-wrap:anywhere; min-width:0; }
.calendar-create-guest-options .data-button { width:100%; justify-content:flex-start; text-align:left; overflow-wrap:anywhere; }
@media(max-width:600px) { .calendar-create { padding:16px; } .calendar-create-times { grid-template-columns:minmax(0,1fr); } .calendar-create-actions .data-button { min-height:42px; } }
`;
