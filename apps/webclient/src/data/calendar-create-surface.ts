import {
  CALENDAR_EVENT_EDIT_LIMITS, CALENDAR_EVENT_GUEST_LIMITS, DAY_MS, calendarDayMs, normalizeCalendarEventGuests,
  type CalendarEventDestination, type CalendarEventDestinations,
  type CalendarEventCreateRequest, type CalendarEventCreateResult, type CalendarEventGuest,
} from '@recued/contracts';
import { e, renderActionLabel } from '@recued/ui-shared';
import { classifyRpcError, humanizeRpcError } from '../shell/rpc-error-copy.js';
import { createCalendarOverlapPreview, CALENDAR_OVERLAP_STYLES, type CalendarOverlapCaller } from './calendar-overlap-preview.js';
import { calendarWallClockCandidates, calendarWallClockValue } from './calendar-event-surface.js';

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
  onCreated(result: CalendarEventCreateResult): void;
  searchContacts?: (query: string) => Promise<CalendarEventGuest[]>;
  now?: () => number;
}) => {
  let draft: CalendarCreateDraft | null = null, initial = '';
  let zone = '', creationId = '', error = '', loading = false, saving = false, disposed = false;
  let destinations: CalendarEventDestinations = { destinations: [], unavailable: [] };
  let pending: CalendarEventCreateRequest | null = null;
  let needsCheck = false, generation = 0;
  let leave: (() => void) | null = null;
  let focus: string | null = null;
  let guestOptions: CalendarEventGuest[] = [], guestLoading = false, guestError = '', guestGeneration = 0;
  let guestComposing = false;
  let guestTimer: ReturnType<typeof setTimeout> | undefined;
  const overlaps = createCalendarOverlapPreview({ call: deps.callers.overlaps, id: 'create',
    actionAttr: deps.actionAttr, retryAction: 'calendar-create-overlap-retry' });
  const updateOverlaps = () => {
    if (!draft) { overlaps.reset(); return; }
    try { overlaps.update({ ...calendarCreateTimes(draft, zone), is_all_day: draft.allDay, timezone: zone }); }
    catch { overlaps.update(null); }
  };
  const available = () => Boolean(deps.callers.destinations && deps.callers.create);
  const dirty = () => Boolean(draft && (needsCheck || JSON.stringify(draft) !== initial));
  const paint = (key?: string) => { if (key) focus = key; deps.render(); };
  const destination = () => destinations.destinations.find(value => destinationKey(value) === draft?.destination);
  const canInvite = () => destination()?.can_invite === true && destination()?.provider !== 'local';
  const clearGuestSearch = () => {
    guestGeneration++; if (guestTimer) clearTimeout(guestTimer); guestTimer = undefined;
    guestOptions = []; guestLoading = false; guestError = '';
  };
  const reset = () => { overlaps.reset(); generation++; clearGuestSearch(); guestComposing = false; draft = null; pending = null; error = ''; leave = null; needsCheck = false; loading = false; };
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
      destinations = result;
      const before = draft.destination;
      if (!result.destinations.some(value => destinationKey(value) === draft!.destination)) {
        // Losing access to the selected destination must not silently move a
        // draft onto another calendar, including the local calendar.
        const selected = before ? undefined : preferred ? result.destinations.find(value => value.slug === preferred)
          : result.destinations.find(value => value.provider === 'local') ?? result.destinations[0];
        draft.destination = selected ? destinationKey(selected) : '';
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
    leave = resume; paint('keep'); return false;
  };
  const open = () => {
    if (!available() || disposed) return;
    if (draft) { paint('summary'); return; }
    const context = deps.context(); zone = context.zone;
    const nextHour = Math.ceil(((deps.now ?? Date.now)() + 1) / 3_600_000) * 3_600_000;
    const next = calendarWallClockValue(nextHour, zone);
    const start = next.slice(0, 10) === context.day ? next : `${context.day}T09:00`;
    const end = start === next ? calendarWallClockValue(nextHour + 3_600_000, zone) : `${context.day}T10:00`;
    creationId = crypto.randomUUID(); destinations = { destinations: [], unavailable: [] };
    draft = { destination: '', summary: '', description: '', location: '', start, end,
      allDay: false, startChoice: '', endChoice: '', guests: [], guestQuery: '' };
    initial = JSON.stringify(draft);
    error = ''; needsCheck = false; pending = null; updateOverlaps(); paint('summary'); void load();
  };
  const save = async () => {
    if (!draft || loading || saving || guestComposing || !deps.callers.create) return;
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
    const request = pending, mine = generation;
    clearGuestSearch(); saving = true; error = ''; paint('save');
    try {
      const result = await deps.callers.create(request);
      if (disposed || mine !== generation) return;
      const event = result?.snapshot?.event;
      if (result.slug !== request.slug || result.snapshot.incarnation !== request.expected_incarnation
        || !event?.source_id || event.calendar_id !== request.calendar_id || !result.snapshot.record?.record_id
        || result.snapshot.record.source_id !== event.source_id || result.snapshot.record.record_id !== event.record_id
        || event.summary !== request.summary || event.description !== request.description || event.location !== request.location
        || event.start_at !== request.start_at || event.end_at !== request.end_at || event.is_all_day !== request.is_all_day || event.is_recurring
        || request.send_invitations && result.invitations_requested !== true) {
        throw new Error('The saved event could not be confirmed.');
      }
      saving = false; reset(); deps.onCreated(result);
    } catch (cause) {
      if (disposed || mine !== generation) return;
      const code = classifyRpcError(cause).code;
      const refused = !needsCheck && code !== null && ['invalid_args', 'forbidden', 'unauthorized', 'resource_changed', 'not_configured', 'unknown_method'].includes(code);
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
  const render = (): string => {
    if (!draft) return '';
    const provider = { local: 'On this server', gcal: 'Google Calendar', graph: 'Outlook', caldav: 'CalDAV' };
    return `<form class="calendar-create" role="region" aria-label="New event" data-calendar-create-form>
      <div class="calendar-create-heading"><div><h3>New event</h3><p class="calendar-agenda-muted">One-off event · Times in ${e(zone)}</p></div></div>
      ${loading ? '<p role="status">Loading writable calendars…</p>' : ''}
      ${error ? `<p role="alert">${e(error)}</p>` : ''}
      ${destinations.unavailable.length ? `<details><summary>Some calendars are unavailable</summary><ul>${destinations.unavailable.map(value => `<li>${e(value.slug)}: ${e(value.reason)}</li>`).join('')}</ul></details>` : ''}
      <fieldset${saving || needsCheck ? ' disabled' : ''} class="calendar-create-fields">
        ${field('destination', 'Calendar', `<select class="data-input" ${attr('destination')}${loading ? ' disabled' : ''}><option value="">Choose a calendar</option>${destinations.destinations.map(value => `<option value="${e(destinationKey(value))}"${draft!.destination === destinationKey(value) ? ' selected' : ''}>${e(value.name)}${value.provider === 'local' ? '' : ` · ${e(value.slug)} · ${provider[value.provider]}`}</option>`).join('')}</select>`)}
        ${!loading && !destinations.destinations.length ? '<p class="calendar-agenda-muted">No writable calendars are available. Check your connections or reload calendars.</p>' : ''}
        ${field('summary', 'Title', `<input type="text" class="data-input" ${attr('summary')} maxlength="${CALENDAR_EVENT_EDIT_LIMITS.summary}" value="${e(draft.summary)}" required>`)}
        <label class="calendar-create-all-day"><input type="checkbox" ${attr('allDay')}${draft.allDay ? ' checked' : ''}> All day</label>
        <div class="calendar-create-times">${field('start', draft.allDay ? 'First day' : 'Starts', `<input type="${draft.allDay ? 'date' : 'datetime-local'}" class="data-input" ${attr('start')} value="${e(draft.start)}" required>`)}
          ${field('end', draft.allDay ? 'Last day (inclusive)' : 'Ends', `<input type="${draft.allDay ? 'date' : 'datetime-local'}" class="data-input" ${attr('end')} value="${e(draft.end)}" required>`)}</div>
        ${(['start', 'end'] as const).map(key => { const choices = repeatedTime(key); return `<div ${REPEAT}="${key}"${choices ? '' : ' hidden'}>${choices}</div>`; }).join('')}
        ${overlaps.render()}
        ${field('location', 'Location (optional)', `<input type="text" class="data-input" ${attr('location')} maxlength="${CALENDAR_EVENT_EDIT_LIMITS.location}" value="${e(draft.location)}">`)}
        ${field('description', 'Notes (optional)', `<textarea class="data-input" ${attr('description')} rows="3" maxlength="${CALENDAR_EVENT_EDIT_LIMITS.description}">${e(draft.description)}</textarea>`)}
        ${!loading ? renderGuests() : ''}
      </fieldset>
      <div class="calendar-create-actions">${button('save', saving ? 'Saving…' : needsCheck ? 'Check save' : draft.guests.length ? 'Create and send invitations' : 'Create event', true)}${button('cancel', 'Cancel')}${!needsCheck ? button('reload', 'Reload calendars') : ''}</div>
      ${needsCheck && pending?.send_invitations ? '<p class="calendar-agenda-muted">Checking this save will not create another event or send another set of invitations.</p>' : ''}
      ${leave ? `<div class="calendar-create-discard" role="group" aria-label="Unsaved event"><p>${needsCheck ? 'This event may already exist in your calendar. Check it before creating another.' : 'Discard this unsaved event draft?'}</p><div class="calendar-create-actions">${button('keep', 'Keep editing')}${button('discard', 'Discard draft')}</div></div>` : ''}
    </form>`;
  };
  return {
    available, render, open, beforeLeave,
    isOpen: () => draft !== null,
    hasUnsavedChanges: dirty,
    hasInFlightWork: () => saving,
    handleSubmit: (event: Event): void => {
      if (!(event.target as HTMLElement | null)?.hasAttribute?.('data-calendar-create-form')) return;
      event.preventDefault(); void save();
    },
    handleKeyDown: (event: KeyboardEvent): boolean => {
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
    handleAction: (action: string): boolean => {
      if (!action.startsWith(CALENDAR_CREATE_ACTION)) return false;
      const name = action.slice(CALENDAR_CREATE_ACTION.length);
      if (name === 'overlap-retry') overlaps.retry();
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
      else if (name === 'keep') { leave = null; paint('summary'); }
      else if (name === 'discard' && !saving) { const resume = leave; reset(); paint(); resume?.(); }
      else if (name === 'cancel' && beforeLeave(() => { reset(); paint('new'); })) { reset(); paint('new'); }
      return true;
    },
    handleInput: (target: HTMLElement, change = false): boolean => {
      const key = target.getAttribute(CALENDAR_CREATE_FIELD) as keyof CalendarCreateDraft | null;
      if (!key || !draft || !(key in draft)) return false;
      if (key === 'guests') return false;
      if (saving || needsCheck) return true;
      if (key === 'allDay') {
        const allDay = (target as HTMLInputElement).checked;
        if (allDay !== draft.allDay) {
          draft.allDay = allDay;
          draft.start = allDay ? draft.start.slice(0, 10) : `${draft.start}T09:00`;
          draft.end = allDay ? draft.end.slice(0, 10) : `${draft.end}T10:00`;
          draft.startChoice = draft.endChoice = '';
          updateOverlaps(); paint('allDay');
        }
      } else {
        const value = (target as HTMLInputElement).value;
        const changed = draft[key] !== value;
        if (changed) {
          draft[key] = value;
          if (key === 'start' || key === 'end') {
            draft[`${key}Choice`] = '';
            const host = target.closest?.('.calendar-create')?.querySelector<HTMLElement>(`[${REPEAT}="${key}"]`);
            if (host) { const choices = repeatedTime(key); host.innerHTML = choices; host.hidden = !choices; }
          }
          if (pending) { pending = null; creationId = crypto.randomUUID(); }
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
      return true;
    },
    captureFocus: (element: Element | null | undefined) => {
      const key = element?.getAttribute?.(FOCUS);
      if (!key) return null;
      const control = element as HTMLInputElement;
      return { key, start: control.selectionStart, end: control.selectionEnd };
    },
    restoreFocus: (root: ParentNode, previous: { key: string; start?: number | null; end?: number | null } | null) => {
      overlaps.mount(root);
      const explicit = focus, key = explicit ?? previous?.key; focus = null;
      const target = key ? root.querySelector<HTMLElement>(`[${FOCUS}="${key}"]`) : null;
      target?.focus({ preventScroll: true });
      if (!explicit && target && previous?.start != null && previous.end != null) {
        try { (target as HTMLInputElement).setSelectionRange(previous.start, previous.end); } catch { /* Native date and select controls have no text selection. */ }
      }
    },
    dispose: () => { disposed = true; reset(); },
  };
};

export const CALENDAR_CREATE_STYLES = CALENDAR_OVERLAP_STYLES + `
.calendar-create .data-button { display:inline-flex; align-items:center; justify-content:center; gap:6px; }
.calendar-create .data-button svg[aria-hidden=true] { flex:none; }
.calendar-create { border:1px solid var(--border); border-radius:10px; padding:20px; display:grid; gap:16px; max-width:760px; background:var(--surface); min-width:0; }
.calendar-create h3 { margin:0 0 5px; font-size:1.15rem; }
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
