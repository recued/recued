import {
  allDayEventDays, DAY_MS,
  CALENDAR_EVENT_EDIT_LIMITS,
  type CalendarEventDetails, type CalendarEventPatch, type CalendarEventRef,
  type CalendarEventSnapshot, type CalendarEventUpdateRequest,
  type CalendarEventRespondRequest, type CalendarEventRespondResult, type CalendarInvitationResponse,
  type CalendarEventDeleteRequest, type CalendarEventDeleteResult,
  type CalendarEventDeletionCheckRequest, type CalendarEventDeletionState,
  type CalendarEventOccasion, type YoursCommand,
} from '@recued/contracts';
import { e, renderActionLabel, type IconName } from '@recued/ui-shared';
import { createCalendarOverlapPreview, CALENDAR_OVERLAP_STYLES, type CalendarOverlapCaller } from './calendar-overlap-preview.js';
import { classifyRpcError, humanizeRpcError } from '../shell/rpc-error-copy.js';
import { copyText } from '../shell/copy-text.js';
import { selectedCalendarEventContext, type SelectedCalendarEventContext } from '../calendar/event-context.js';
import { calendarMeetingHref, calendarEventCopyText, calendarTimeLabel as timeLabel, calendarDayLabel as dayLabel } from './calendar-event-actions.js';
import { calendarEmailLinks } from './calendar-email-links.js';
import type { TaskNoteSource } from './task-note-source.js';
import { calendarWallClockCandidates, calendarWallClockValue } from './calendar-wall-clock.js';
export { calendarWallClockCandidates, calendarWallClockValue } from './calendar-wall-clock.js';
import { createCalendarEditCheckpoint, calendarEditOriginal, type CalendarEditRecoveryStore, type CalendarEditEntry } from './calendar-edit-recovery.js';
import { renderCalendarEditRecoveries, CALENDAR_EDIT_RECOVERY_STYLES } from './calendar-edit-recovery-ui.js';
import { compareCalendarEdits, mergeCalendarEdits, calendarConflictStatus, unresolvedCalendarConflicts, CALENDAR_CONFLICT_FIELD, CALENDAR_CONFLICT_TOKEN, CALENDAR_EDIT_CONFLICT_STYLES, type CalendarEditComparison, type CalendarConflictField } from './calendar-edit-conflicts.js';
import { createCalendarTimeFinder, CALENDAR_TIME_FIELD, CALENDAR_TIME_FINDER_STYLES } from './calendar-time-finder.js';

export const CALENDAR_EVENT_ACTION_PREFIX = 'calendar-event-';
export const CALENDAR_EVENT_FIELD = 'data-calendar-event-field';
const FOCUS = 'data-calendar-event-focus';
const REPEAT = 'data-calendar-event-repeat';
import { calendarEventDraft, calendarEventPatch, type CalendarEventDraft, type Field } from './calendar-event-draft.js';
export { calendarEventDraft, calendarEventPatch, type CalendarEventDraft } from './calendar-event-draft.js';
export interface CalendarEventCallers {
  overlaps?: CalendarOverlapCaller;
  get?: (ref: CalendarEventRef) => Promise<CalendarEventSnapshot>;
  update?: (request: CalendarEventUpdateRequest) => Promise<CalendarEventSnapshot>;
  respond?: (request: CalendarEventRespondRequest) => Promise<CalendarEventRespondResult>;
  delete?: (request: CalendarEventDeleteRequest) => Promise<CalendarEventDeleteResult>;
  checkDeletion?: (request: CalendarEventDeletionCheckRequest) => Promise<CalendarEventDeletionState>;
  /** D-407 slice 5 — the Occasion tick, sent as the owner's Yours change. */
  occasion?: (change: CalendarEventOccasionChange) => Promise<{ message: string }>;
}
/** D-407 slice 5 — the two Yours changes the Occasion tick sends. */
export type CalendarEventOccasionChange = Extract<YoursCommand, { action: 'occasion.adopt_event' | 'occasion.release_event' }>;
/** D-407 slice 5 — the tick's controls, by what each does. */
export const CALENDAR_EVENT_OCCASION = 'data-calendar-event-occasion';
export interface CalendarEventFocus { key: string; start?: number | null; end?: number | null; preventScroll?: true; }

const deletionRangeLabel = (event: CalendarEventDetails): string => {
  const days = event.is_all_day ? allDayEventDays(event) : null;
  if (days) return dayLabel(days.first) + (days.last !== days.first ? ' – ' + dayLabel(days.last) : '');
  try {
    const date = new Intl.DateTimeFormat(undefined, { timeZone: event.timezone, dateStyle: 'short' });
    const sameDay = date.format(event.start_at) === date.format(event.end_at);
    const first = new Intl.DateTimeFormat(undefined, { timeZone: event.timezone, dateStyle: 'medium', timeStyle: 'long' });
    const endOptions: Intl.DateTimeFormatOptions = { timeZone: event.timezone, timeStyle: 'long' };
    if (!sameDay) endOptions.dateStyle = 'medium';
    // Keep both offsets when a range crosses a repeated daylight-saving hour.
    return first.format(event.start_at) + ' – ' + new Intl.DateTimeFormat(undefined, endOptions).format(event.end_at);
  } catch { return timeLabel(event.start_at, event.timezone) + ' – ' + timeLabel(event.end_at, event.timezone); }
};
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
const confirmsDraft = (before: Pick<CalendarEventSnapshot, 'event' | 'incarnation'>, patch: CalendarEventPatch, after: CalendarEventSnapshot): boolean => {
  const wanted = { ...before.event, ...patch };
  return after.incarnation === before.incarnation && (['calendar_id', 'summary', 'description', 'location', 'start_at', 'end_at', 'timezone', 'is_all_day', 'status', 'is_recurring'] as const)
    .every(key => after.event[key] === wanted[key]);
};

export const createCalendarEventSurface = (deps: {
  callers: CalendarEventCallers; actionAttr: string; render: () => void;
  onSaved: (snapshot: CalendarEventSnapshot) => void;
  onRemoved?: (recordId: string, returnToAgenda?: boolean) => void;
  document?: Document;
  now?: () => number;
  recovery?: CalendarEditRecoveryStore;
  copyBlocked?: () => boolean;
  onAsk?: (context: SelectedCalendarEventContext, question: string) => void;
  onCreateTask?: (ref: CalendarEventRef, snapshot: CalendarEventSnapshot, isCurrent: () => boolean) => Promise<void>;
  onCreateNote?: (ref: CalendarEventRef, snapshot: CalendarEventSnapshot, isCurrent: () => boolean) => Promise<void>;
  onDuplicate?: (ref: CalendarEventRef, snapshot: CalendarEventSnapshot, isCurrent: () => boolean) => void;
  onExistingDuplicate?: () => boolean;
  onOpenEmail?: (source: TaskNoteSource, ref: CalendarEventRef, snapshot: CalendarEventSnapshot, isCurrent: () => boolean) => Promise<void>;
}) => {
  let ref: CalendarEventRef | null = null;
  let recordId = '';
  let snapshot: CalendarEventSnapshot | null = null;
  let draft: CalendarEventDraft | null = null;
  let busy: 'read' | 'save' | 'respond' | 'delete' | 'delete-check' | null = null;
  let deleteReview = false;
  let deleteNeedsCheck = false;
  let responseNeedsCheck = false;
  let saveNeedsCheck = false, recoveredUncertain = false;
  let comparison: CalendarEditComparison | null = null;
  let recoveryNotice = '', recoveryDiscard: string | null = null, recoveryRoot: ParentNode | null = null;
  const checkpoint = createCalendarEditCheckpoint({ store: deps.recovery, now: deps.now, changed: () => {
    const status = recoveryRoot?.querySelector('[data-calendar-edit-recovery-status]');
    if (status) status.textContent = checkpoint.message();
  } });
  const captureDraft = () => { if (draft) checkpoint.capture(draft); };
  const recoveryEntries = (current = false) => {
    const read = deps.recovery?.inspect?.() ?? { entries: deps.recovery?.list() ?? [], unavailable: false };
    return { ...read, entries: read.entries.filter((row): row is CalendarEditEntry => row.original !== null && (!draft || row.id !== checkpoint.id())
      && (!current || row.original.slug === ref?.slug && row.original.event.source_id === ref.source_id)) };
  };
  const recoveryMarkup = (current = false) => renderCalendarEditRecoveries({ ...recoveryEntries(current), actionAttr: deps.actionAttr,
    focusAttr: FOCUS, current: ref, comparison: current ? comparison : null, busy: busy !== null, discard: recoveryDiscard, notice: recoveryNotice });
  let pendingResponse: CalendarInvitationResponse | null = null;
  let removed = false;
  // D-407 slice 5 (§4.1, Q4, Q5) — the Occasion tick: opened before an occasion is made, which occasion (`''` a new
  // one), its privacy, and what the last change said.
  let occasionOpen = false, occasionChoice = '', occasionPrivate = true, occasionBusy = false;
  let occasionNotice = '', occasionError = '';
  const responseLabel = (value: string): string => ({ accepted: 'Accepted', tentative: 'Maybe', declined: 'Declined', needs_action: 'Awaiting response' })[value] ?? 'Unknown';
  let error = ''; let notice = '';
  let copying = false; let copySequence = 0;
  let workOpening: 'task' | 'note' | 'duplicate' | 'email' | null = null;
  let expectedRead: { incarnation: string | null; receivedAt: number } | null = null;
  let verifyRead: ((value: CalendarEventSnapshot) => void) | undefined;
  let copyNotice: { error: boolean; text: string } | null = null;
  const clearCopy = () => { copySequence++; copying = false; copyNotice = null; };
  /** A server before 26.10.28 has no event read: the event's listed fields and Reschedule stand alone. */
  let unsupported = false;
  let generation = 0; let disposed = false;
  let pendingLeave: { discard(): void; keep(): void } | null = null;
  let pendingFocus: (CalendarEventFocus & { onlyIfOwned?: true }) | null = null;
  let editorFocus: CalendarEventFocus = { key: 'summary' };
  const dirty = (): boolean => {
    if (!draft || !snapshot) return false;
    const initial = calendarEventDraft(snapshot.event);
    return (Object.keys(initial) as Field[]).some(key =>
      (key !== 'startChoice' && key !== 'endChoice' || draft![key] !== '') && draft![key] !== initial[key]);
  };
  const actionIcons: Partial<Record<string, IconName>> = {
    edit: 'rename', save: 'save', retry: 'refresh', check: 'refresh', reload: 'refresh',
    copy: 'copy', duplicate: 'copy',
    'response-check': 'refresh', 'response-refresh': 'refresh',
    'delete-open': 'delete', 'delete-confirm': 'delete', 'delete-check': 'refresh',
  };
  const button = (action: string, label: string, primary = false): string => {
    const icon = actionIcons[action];
    const pending = busy || workOpening || action === 'copy' && (copying || deps.copyBlocked?.());
    return `<button type="button" class="data-button${primary ? ' data-button--primary' : ''}${action === 'delete-open' || action === 'delete-confirm' ? ' data-button--danger' : ''}" ${deps.actionAttr}="calendar-event-${action}" ${FOCUS}="${action}"${pending || action === 'save' && saveNeedsCheck ? ' aria-disabled="true"' : ''}${pending ? ' aria-busy="true"' : ''}>${icon ? renderActionLabel(icon, label) : e(label)}</button>`;
  };
  /** D-407 slice 5 (§4.1, Q4, Q5) — the Occasion tick. *Occasion* unticked is a plain event; ticked, an occasion
   *  holds it: a new one, or the next one of an occasion waiting for its date (the one matching its organizer or place
   *  chosen first). *Private* under it, ticked to start for a new one (no kind of occasion exists to start it by), as
   *  the chosen occasion is for one waiting. An occasion's own event (*In my calendar*) is changed in Yours. */
  const occasionMarkup = (block: CalendarEventOccasion): string => {
    const off = occasionBusy || busy !== null ? ' disabled' : '';
    const control = (type: 'checkbox' | 'radio', action: string, label: string, checked: boolean): string =>
      `<label class="calendar-event-occasion-choice"><input type="${type}" ${deps.actionAttr}="calendar-event-occasion-${action}" ${CALENDAR_EVENT_OCCASION}="${action}"${type === 'radio' ? ' name="calendar-event-occasion-which"' : ''}${checked ? ' checked' : ''}${off}> ${e(label)}</label>`;
    const said = `${occasionError ? `<p role="alert" class="calendar-event-error">${e(occasionError)}</p>` : ''}${occasionNotice ? `<p role="status" class="calendar-event-notice">${e(occasionNotice)}</p>` : ''}`;
    const section = (body: string): string => `<section class="calendar-event-occasion" aria-label="Occasion"><h3>Occasion</h3>${body}${said}</section>`;
    const owner = block.owner;
    if (owner?.written_by_occasion) {
      return section(`<p class="calendar-event-hint">This is the event of the occasion ${e(owner.title)}, which Recued writes. Change it in Yours.</p>`);
    }
    const privacy = (privateNow: boolean): string => privateNow ? 'Private: your messages call it only “Reminder in Yours”.' : 'Shown by name: your messages name it.';
    if (owner) {
      return section(`${control('checkbox', 'tick', `Occasion: ${owner.title}`, true)}${control('checkbox', 'private', 'Private', owner.private)}
        <p class="calendar-event-hint">${privacy(owner.private)} It follows this event, which stays as it is in your calendar. Untick Occasion to let the event go.</p>`);
    }
    const which = block.waiting.length > 0 ? `<fieldset class="calendar-event-occasion-which"><legend>Which occasion is this?</legend>${block.waiting.map(row =>
      control('radio', `which-${row.occasion_id}`, `${row.title}: its next one${row.match ? ' (its organizer or place matches)' : ''}`, occasionChoice === row.occasion_id)).join('')}${
      control('radio', 'which-new', 'A new occasion', occasionChoice === '')}</fieldset>` : '';
    const make = button('occasion-make', occasionBusy ? 'Making…' : 'Make it an occasion', true);
    return section(`${control('checkbox', 'tick', 'Occasion', occasionOpen)}
      <p class="calendar-event-hint">Something personal with a date, such as a doctor’s visit. Recued reminds you of it and follows this event, which stays as it is.</p>
      ${occasionOpen ? `${which}${control('checkbox', 'private', 'Private', occasionPrivate)}
        <p class="calendar-event-hint">${privacy(occasionPrivate)}${block.marked_private ? ' Your calendar marks this event private, and that stays.' : ''}</p>
        <div class="calendar-event-actions">${occasionBusy ? make.replace('type="button"', 'type="button" disabled') : make}${button('occasion-cancel', 'Cancel')}</div>` : ''}`);
  };
  const occasionAction = async (what: string): Promise<void> => {
    const block = snapshot?.occasion;
    if (!ref || !snapshot || !block || occasionBusy || busy) { repaint(); return; }
    occasionError = ''; occasionNotice = '';
    const owner = block.owner;
    if (!owner) {
      if (what === 'tick') {
        occasionOpen = !occasionOpen;
        const match = block.waiting.find(row => row.match);
        if (occasionOpen) { occasionChoice = match?.occasion_id ?? ''; occasionPrivate = match ? match.private : true; }
        repaint(); return;
      }
      if (what === 'cancel') { occasionOpen = false; repaint(); return; }
      if (what === 'private') { occasionPrivate = !occasionPrivate; repaint(); return; }
      if (what.startsWith('which-')) {
        const row = block.waiting.find(one => one.occasion_id === what.slice('which-'.length));
        occasionChoice = row?.occasion_id ?? ''; occasionPrivate = row ? row.private : true; repaint(); return;
      }
    }
    const at = { slug: ref.slug, source_id: ref.source_id };
    const change: CalendarEventOccasionChange | null = owner?.written_by_occasion ? null
      : !owner && what === 'make' && occasionOpen ? { action: 'occasion.adopt_event', ...at, ...(occasionChoice ? { occasion_id: occasionChoice } : {}), private: occasionPrivate }
        : owner && what === 'private' ? { action: 'occasion.adopt_event', ...at, occasion_id: owner.occasion_id, private: !owner.private }
          : owner && what === 'tick' ? { action: 'occasion.release_event', ...at }
            : null;
    if (!change || !deps.callers.occasion) { repaint(); return; }
    const expected = ref; occasionBusy = true; repaint();
    try {
      const result = await deps.callers.occasion(change);
      if (disposed || ref !== expected) return;
      occasionNotice = result.message; occasionOpen = false;
    } catch (cause) {
      if (disposed || ref !== expected) return;
      occasionError = humanizeRpcError(cause);
    } finally { if (!disposed && ref === expected) occasionBusy = false; }
    // The event's block as it is now: held, let go, or private.
    await read();
  };
  const repaint = (focus?: string | CalendarEventFocus) => {
    captureDraft();
    if (focus) pendingFocus = typeof focus === 'string' ? { key: focus } : focus;
    deps.render();
  };
  const copyDetails = async () => {
    if (!deps.document || !snapshot || draft || removed || copying || deps.copyBlocked?.()) return;
    const text = calendarEventCopyText(snapshot.event);
    const seq = ++copySequence; const current = generation;
    copying = true; copyNotice = null;
    repaint({ key: 'copy', preventScroll: true });
    const copied = await copyText(deps.document, text);
    if (disposed || current !== generation || seq !== copySequence || draft) return;
    copying = false;
    copyNotice = { error: !copied, text: copied ? 'Event details copied.' : 'Could not copy. Select the event details and copy them.' };
    repaint();
  };
  const zoneAvailable = (event: CalendarEventDetails): boolean => event.is_all_day
    || Boolean(calendarWallClockValue(event.start_at, event.timezone) && calendarWallClockValue(event.end_at, event.timezone));
  const editable = (value: CalendarEventSnapshot | null): boolean => value?.editable === true
    && deps.callers.update !== undefined && (zoneAvailable(value.event)
      || value.editable_fields !== undefined && !value.editable_fields.some(key => key === 'start_at' || key === 'end_at'));
  // A local event says `deletable`; a connected calendar's says `provider_delete`, with what its
  // delete does (D-336 spec §58).
  const deletable = (): boolean => (snapshot?.deletable === true || snapshot?.provider_delete !== undefined)
    && Boolean(snapshot.incarnation) && !snapshot.event.is_recurring && Boolean(deps.callers.delete && deps.callers.checkDeletion);
  const fieldAllowed = (key: Field): boolean => {
    const field = key === 'start' || key === 'startChoice' ? 'start_at' : key === 'end' || key === 'endChoice' ? 'end_at' : key;
    return snapshot?.editable_fields === undefined || snapshot.editable_fields.includes(field);
  };
  const overlaps = createCalendarOverlapPreview({ call: deps.callers.overlaps, id: 'edit',
    actionAttr: deps.actionAttr, retryAction: 'calendar-event-overlap-retry' });
  const draftTimes = () => {
    if (!draft || !snapshot) return null;
    const original = calendarEventDraft(snapshot.event);
    const times = calendarEventPatch(snapshot.event, { ...draft, summary: original.summary || 'Untitled event',
      description: original.description, location: original.location });
    return times.patch ? { start_at: times.patch.start_at ?? snapshot.event.start_at,
      end_at: times.patch.end_at ?? snapshot.event.end_at } : null;
  };
  const canFindTime = () => Boolean(draft && snapshot && ref && snapshot.incarnation && deps.callers.overlaps
    && !snapshot.event.is_all_day && editable(snapshot) && fieldAllowed('start') && fieldAllowed('end') && !removed);
  const timeFinder = createCalendarTimeFinder({ call: deps.callers.overlaps, actionAttr: deps.actionAttr, focusAttr: FOCUS,
    actionPrefix: 'calendar-event', title: 'Find another time', now: deps.now,
    usable: () => canFindTime() && !busy && !pendingLeave && !saveNeedsCheck && !disposed,
    choose: slot => {
      if (!canFindTime() || !draft || !snapshot || busy || pendingLeave || saveNeedsCheck || disposed) return;
      const zone = snapshot.event.timezone;
      const value = (at: number) => calendarWallClockValue(at, zone, at % 1000 ? 'millisecond' : at % 60_000 ? 'second' : 'minute');
      draft.start = value(slot.start_at); draft.end = value(slot.end_at);
      draft.startChoice = String(slot.start_at); draft.endChoice = String(slot.end_at);
      timeFinder.reset(); error = ''; updateOverlaps(); repaint('start');
    },
  });
  const updateOverlaps = () => {
    if (!draft || !snapshot?.incarnation || !ref || !fieldAllowed('start') && !fieldAllowed('end')) { overlaps.reset(); return; }
    const times = draftTimes();
    if (!times) { overlaps.update(null); return; }
    overlaps.update({ ...times, is_all_day: snapshot.event.is_all_day,
      timezone: snapshot.event.timezone, exclude: { ...ref, expected_incarnation: snapshot.incarnation } });
  };
  const resumeRecovery = async (id: string, revision: number): Promise<void> => {
    const entry = deps.recovery?.get(id);
    if (!entry?.original || entry.revision !== revision || !ref || !deps.callers.get || draft || busy || disposed
      || entry.original.slug !== ref.slug || entry.original.event.source_id !== ref.source_id) return;
    const original = entry.original, expectedRef = ref, expectedRecord = recordId, seq = ++generation;
    busy = 'read'; recoveryNotice = ''; comparison = null; timeFinder.reset(); repaint();
    try {
      const value = await deps.callers.get(expectedRef);
      if (disposed || seq !== generation) return;
      if (JSON.stringify(deps.recovery?.get(id)) !== JSON.stringify(entry)) throw new Error('This recovery copy changed. Review the current kept edits before resuming.');
      if (!identityMatches(expectedRef, expectedRecord, value) || value.incarnation !== original.incarnation
        || value.event.calendar_id !== original.event.calendar_id || value.event.timezone !== original.event.timezone || value.event.is_all_day !== original.event.is_all_day)
        throw new Error('This event or calendar was replaced. Your kept edits are still available to review and copy.');
      if (value.refresh_error || (original.providerCheck || value.editable_fields !== undefined) && value.provider_verified !== true)
        throw new Error('The calendar could not verify this event. Your kept edits are still here. Try checking again.');
      snapshot = value; deps.onSaved(value);
      if (entry.status !== 'editing') {
        const request = entry.values.request;
        if (!request || !confirmsDraft(original, request.patch, value))
          throw new Error('The earlier save is not confirmed. Your kept edits are still here; no changes were sent again. The earlier save may still complete.');
        if (!deps.recovery?.remove(id)) throw new Error('The saved changes were confirmed, but the recovery copy could not be cleared. Check again.');
        snapshot = value; notice = 'Your changes are saved. No changes were sent again.'; deps.onSaved(value); pendingFocus = { key: viewFocus(value) }; return;
      }
      if (!editable(value)) throw new Error(value.read_only_reason || 'This event can no longer be edited here. Your kept edits are still available to copy.');
      if (value.resource_version !== original.resource_version || !confirmsDraft(original, {}, value)) {
        comparison = compareCalendarEdits(entry as CalendarEditEntry, value); pendingFocus = { key: 'comparison-heading' }; return;
      }
      const initial = calendarEventDraft(original.event);
      const changed = (Object.keys(initial) as Field[]).filter(key => entry.values.draft[key] !== initial[key]);
      if (value.editable_fields && changed.some(key => !value.editable_fields!.includes(key === 'start' || key === 'startChoice' ? 'start_at' : key === 'end' || key === 'endChoice' ? 'end_at' : key)))
        throw new Error('Some kept fields can no longer be edited here. Your kept edits are still available to review and copy.');
      snapshot = value; draft = { ...entry.values.draft }; saveNeedsCheck = false; recoveredUncertain = false; error = ''; notice = '';
      checkpoint.begin(original, draft, entry.values.calendarName, entry as CalendarEditEntry); updateOverlaps(); pendingFocus = { key: 'summary' };
    } catch (cause) { if (!disposed && seq === generation) { recoveryNotice = humanizeRpcError(cause); pendingFocus = { key: 'recovery-notice' }; } }
    finally { if (!disposed && seq === generation) { busy = null; repaint(); } }
  };
  const prepareComparison = async (): Promise<void> => {
    const reviewed = comparison;
    if (!reviewed || draft || busy || disposed || pendingLeave || !ref || !deps.callers.get || unresolvedCalendarConflicts(reviewed).length) return;
    const wanted = mergeCalendarEdits(reviewed); if (!wanted) return;
    const entry = reviewed.entry, original = entry.original, expectedRef = ref, expectedRecord = recordId, seq = ++generation;
    busy = 'read'; recoveryNotice = ''; repaint('conflict-prepare');
    try {
      const value = await deps.callers.get(expectedRef);
      if (disposed || seq !== generation || comparison !== reviewed) return;
      if (JSON.stringify(deps.recovery?.get(entry.id)) !== JSON.stringify(entry)) {
        comparison = null; throw new Error('This recovery copy changed. Review the current kept edits before preparing a draft.');
      }
      if (!identityMatches(expectedRef, expectedRecord, value) || value.incarnation !== original.incarnation
        || value.event.calendar_id !== original.event.calendar_id || value.event.timezone !== original.event.timezone || value.event.is_all_day !== original.event.is_all_day) {
        comparison = null; throw new Error('This event or calendar was replaced. Your kept edits are still available to review and copy.');
      }
      if (value.refresh_error || (original.providerCheck || value.editable_fields !== undefined) && value.provider_verified !== true)
        throw new Error('The calendar could not verify this event. Your kept edits are still here. Try checking again.');
      snapshot = value; deps.onSaved(value);
      if (!editable(value)) { comparison = null; throw new Error(value.read_only_reason || 'This event can no longer be edited here. Your kept edits are still available to copy.'); }
      if (value.resource_version !== reviewed.saved.resource_version || !confirmsDraft(reviewed.saved, {}, value)) {
        comparison = compareCalendarEdits(entry, value); recoveryNotice = 'The saved event changed again. Review the updated comparison and choose again.';
        pendingFocus = { key: 'comparison-heading' }; return;
      }
      const patch = calendarEventPatch(value.event, wanted).patch, initial = calendarEventDraft(value.event);
      const fields = patch ? Object.keys(patch) : (Object.keys(initial) as Field[]).filter(key => wanted[key] !== initial[key])
        .map(key => key === 'start' || key === 'startChoice' ? 'start_at' : key === 'end' || key === 'endChoice' ? 'end_at' : key);
      if (value.editable_fields && fields.some(key => !value.editable_fields!.includes(key as keyof CalendarEventPatch)))
        throw new Error('Some kept fields can no longer be edited here. Your kept edits are still available to review and copy.');
      const next: CalendarEditEntry = { ...entry, revision: entry.revision + 1, updatedAt: (deps.now ?? Date.now)(), status: 'editing',
        original: calendarEditOriginal(expectedRef.slug, value), values: { draft: wanted, calendarName: value.event.calendar_name ?? entry.values.calendarName, request: null } };
      if (!deps.recovery?.save(next)) throw new Error('The prepared draft could not be kept in this tab. Your original kept edits are still here. Try again.');
      const stored = deps.recovery.get(entry.id);
      if (!stored?.original || stored.revision !== next.revision || (Object.keys(wanted) as Field[]).some(key => stored.values.draft[key] !== wanted[key])) {
        comparison = null; throw new Error('The prepared recovery copy could not be confirmed. Review the current kept edits before resuming.');
      }
      draft = { ...stored.values.draft }; comparison = null; recoveryNotice = ''; recoveryDiscard = null; error = ''; notice = ''; saveNeedsCheck = false; recoveredUncertain = false;
      checkpoint.begin(stored.original, draft, stored.values.calendarName, stored as CalendarEditEntry); updateOverlaps(); pendingFocus = { key: 'summary' };
    } catch (cause) { if (!disposed && seq === generation) { recoveryNotice = humanizeRpcError(cause); pendingFocus = { key: 'recovery-notice' }; } }
    finally { if (!disposed && seq === generation) { busy = null; repaint(); } }
  };
  const viewFocus = (value: CalendarEventSnapshot) => editable(value) ? 'edit' : 'heading';
  const resumeEditing = () => { pendingLeave = null; repaint(saveNeedsCheck ? 'check' : editorFocus); };
  const read = async (checkDraft = false, owner?: 'retry' | 'check' | 'heading' | 'response-check' | 'response-refresh'): Promise<void> => {
    if (!ref || !deps.callers.get || busy || disposed) return;
    timeFinder.reset(); comparison = null;
    const seq = ++generation; const expectedRef = ref; const expectedRecord = recordId;
    clearCopy(); workOpening = null;
    busy = 'read'; notice = ''; repaint(owner);
    try {
      const value = await deps.callers.get(expectedRef);
      if (disposed || seq !== generation) return;
      if (!identityMatches(expectedRef, expectedRecord, value)) throw new Error('The calendar returned a different event. Refresh its details.');
      if (expectedRead && (value.incarnation !== expectedRead.incarnation || value.record.received_at !== expectedRead.receivedAt)) {
        throw new Error('This event has a different identity. Reopen it from Calendar to review it.');
      }
      verifyRead?.(value);
      if (checkDraft && draft && snapshot) {
        if (snapshot.editable_fields !== undefined && value.provider_verified !== true) {
          throw new Error(value.refresh_error ?? 'The connected calendar could not verify the saved event. Your draft is kept.');
        }
        const wanted = calendarEventPatch(snapshot.event, draft);
        const confirmed = wanted.patch && confirmsDraft(snapshot, wanted.patch, value);
        if (confirmed) {
          if (!checkpoint.discard()) throw new Error('Your changes are saved, but the recovery copy could not be cleared. Check again.');
          snapshot = value; draft = null; overlaps.reset(); timeFinder.reset(); saveNeedsCheck = false; recoveredUncertain = false; error = ''; notice = 'Your changes are saved.'; deps.onSaved(value);
          pendingFocus = { key: viewFocus(value), onlyIfOwned: true };
        } else if (!recoveredUncertain && snapshot.editable_fields !== undefined && value.resource_version === snapshot.resource_version
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
  const reset = () => {
    occasionOpen = false; occasionChoice = ''; occasionPrivate = true; occasionBusy = false; occasionNotice = ''; occasionError = '';
    captureDraft(); checkpoint.suspend(); comparison = null; recoveredUncertain = false; recoveryNotice = ''; recoveryDiscard = null; generation++; clearCopy(); workOpening = null; expectedRead = null; verifyRead = undefined; ref = null; recordId = ''; snapshot = null; draft = null; overlaps.reset(); timeFinder.reset(); busy = null; deleteReview = false; deleteNeedsCheck = false; saveNeedsCheck = false; responseNeedsCheck = false; pendingResponse = null; removed = false; error = ''; notice = ''; unsupported = false; pendingLeave = null; pendingFocus = null; editorFocus = { key: 'summary' }; };
  const finishDeletion = () => {
    removed = true; deleteReview = false; deleteNeedsCheck = false; busy = null; error = '';
    notice = 'Event is no longer in this calendar.';
    pendingFocus = { key: 'heading', onlyIfOwned: true };
    deps.onRemoved?.(recordId, true);
  };
  const deleteEvent = async (): Promise<void> => {
    if (!ref || !snapshot || !deleteReview || deleteNeedsCheck || !deletable() || busy || draft || removed) return;
    const request = { ...ref, expected_incarnation: snapshot.incarnation!, expected_version: snapshot.resource_version };
    const seq = ++generation;
    busy = 'delete'; error = ''; notice = ''; repaint('delete-confirm');
    try {
      const result = await deps.callers.delete!(request);
      if (disposed || seq !== generation) return;
      if (result?.deleted !== true || result.slug !== request.slug || result.source_id !== request.source_id
        || result.incarnation !== request.expected_incarnation) throw new Error('The deletion could not be confirmed.');
      finishDeletion();
    } catch (err) { if (!disposed && seq === generation) {
      deleteNeedsCheck = true;
      error = `${humanizeRpcError(err)} Check the event before trying again.`;
      pendingFocus = { key: 'delete-check', onlyIfOwned: true };
    } } finally { if (!disposed && seq === generation) { busy = null; repaint(); } }
  };
  const checkDeletion = async (): Promise<void> => {
    if (!ref || !snapshot?.incarnation || !deleteNeedsCheck || !deps.callers.checkDeletion || busy || removed) return;
    const request = { ...ref, expected_incarnation: snapshot.incarnation };
    const expectedRecord = recordId; const seq = ++generation;
    busy = 'delete-check'; error = ''; repaint('delete-check');
    try {
      const result = await deps.callers.checkDeletion(request);
      if (disposed || seq !== generation) return;
      if (result?.slug !== request.slug || result.source_id !== request.source_id || result.incarnation !== request.expected_incarnation) {
        throw new Error('This calendar could not confirm the event. Reopen its details.');
      }
      if (result.snapshot === null) finishDeletion();
      else {
        if (!identityMatches(request, expectedRecord, result.snapshot) || result.snapshot.incarnation !== request.expected_incarnation) {
          throw new Error('This calendar returned a different event. Reopen its details.');
        }
        snapshot = result.snapshot; deleteReview = false; deleteNeedsCheck = false;
        notice = 'The event is still here. Review its saved details before deleting again.';
        deps.onSaved(result.snapshot);
        pendingFocus = { key: 'heading', onlyIfOwned: true };
      }
    } catch (err) { if (!disposed && seq === generation) {
      error = humanizeRpcError(err); pendingFocus = { key: 'delete-check', onlyIfOwned: true };
    } } finally { if (!disposed && seq === generation) { busy = null; repaint(); } }
  };
  const save = async (): Promise<void> => {
    if (!snapshot || !draft || !ref || !deps.callers.update || busy || saveNeedsCheck || !editable(snapshot) || !snapshot.incarnation) return;
    const result = calendarEventPatch(snapshot.event, draft);
    if (!result.patch) { error = result.error!; repaint(); return; }
    if (snapshot.editable_fields && Object.keys(result.patch).some(key => !snapshot!.editable_fields!.includes(key as keyof CalendarEventPatch))) {
      error = 'Edit that field in the connected calendar. Your draft is kept.'; repaint(); return;
    }
    if (Object.keys(result.patch).length === 0) { if (!checkpoint.discard()) { error = 'The recovery copy could not be cleared. Keep this event open and try again.'; repaint(); return; } draft = null; overlaps.reset(); timeFinder.reset(); error = ''; repaint('edit'); return; }
    timeFinder.reset();
    const request = { ...ref, expected_version: snapshot.resource_version, expected_incarnation: snapshot.incarnation, patch: result.patch };
    captureDraft(); const ticket = checkpoint.startAttempt(request);
    if (ticket?.blocked) { error = 'The event edits could not be kept before saving. Keep this event open and try again.'; repaint(); return; }
    const before = snapshot;
    const seq = ++generation; const expectedRecord = recordId;
    busy = 'save'; error = ''; notice = ''; repaint('save');
    try {
      const value = await deps.callers.update(request);
      if (!identityMatches(request, expectedRecord, value) || !confirmsDraft(before, request.patch, value)) {
        throw new Error('The save could not be confirmed. Your draft is kept. Check the saved event before trying again.');
      }
      checkpoint.settle(ticket, 'confirmed');
      if (disposed || seq !== generation) return;
      snapshot = value; draft = null; overlaps.reset(); timeFinder.reset(); notice = 'Event saved.'; deps.onSaved(value);
      pendingFocus = { key: viewFocus(value), onlyIfOwned: true };
    } catch (err) {
      const refused = ['invalid_args', 'forbidden', 'unauthorized', 'resource_changed', 'not_configured', 'unknown_method'].includes(classifyRpcError(err).code ?? '');
      checkpoint.settle(ticket, refused ? 'refused' : 'unknown');
      if (!disposed && seq === generation) {
      recoveredUncertain = Boolean(ticket && !refused);
      saveNeedsCheck = snapshot.editable_fields !== undefined || recoveredUncertain;
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
    clearCopy();
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
  const beforeLeave = (effect: () => void, keepEffect = effect): boolean => {
    if (busy === 'delete') { repaint('delete-confirm'); return false; }
    if (!draft && busy !== 'save' && busy !== 'respond') return true;
    if (busy) { repaint(busy === 'respond' ? `respond-${pendingResponse}` : busy === 'save' ? 'save' : 'check'); return false; }
    if (!dirty()) { draft = null; overlaps.reset(); timeFinder.reset(); return true; }
    if (!pendingLeave) { timeFinder.reset(); pendingLeave = { discard: effect, keep: keepEffect }; }
    repaint('keep'); return false;
  };
  const createWork = async (kind: 'task' | 'note'): Promise<void> => {
    const create = kind === 'task' ? deps.onCreateTask : deps.onCreateNote;
    if (!ref || !snapshot || !create || draft || removed || busy || workOpening || deleteReview || deleteNeedsCheck) return;
    const selected = snapshot, selectedRef = ref, current = generation;
    const isCurrent = () => !disposed && generation === current && snapshot === selected && ref === selectedRef && !removed && !draft;
    if (!selectedCalendarEventContext(selectedRef, selected)) return;
    workOpening = kind; error = ''; repaint({ key: `create-${kind}`, preventScroll: true });
    try { await create(selectedRef, selected, isCurrent); }
    catch (cause) { if (isCurrent()) error = humanizeRpcError(cause); }
    finally { if (!disposed && generation === current) { workOpening = null; repaint(); } }
  };
  const duplicate = async (): Promise<void> => {
    if (!ref || !snapshot || !deps.onDuplicate || !deps.callers.get || draft || removed || busy || workOpening || deleteReview || deleteNeedsCheck) return;
    if (deps.onExistingDuplicate?.()) return;
    const selected = snapshot, selectedRef = ref, current = generation;
    const owns = () => !disposed && generation === current && ref === selectedRef && !removed && !draft;
    workOpening = 'duplicate'; error = ''; clearCopy(); repaint({ key: 'duplicate', preventScroll: true });
    try {
      const fresh = await deps.callers.get(selectedRef);
      if (!owns() || snapshot !== selected) return;
      if (!identityMatches(selectedRef, recordId, fresh) || fresh.incarnation !== selected.incarnation
        || fresh.event.calendar_id !== selected.event.calendar_id)
        throw new Error('The original event’s identity changed. Reopen it from Calendar before copying.');
      snapshot = fresh; deps.onSaved(fresh);
      deps.onDuplicate(selectedRef, fresh, () => owns() && snapshot === fresh);
    } catch (cause) { if (owns()) error = humanizeRpcError(cause); }
    finally { if (!disposed && generation === current) { workOpening = null; repaint(); } }
  };
  const openEmail = async (index: number): Promise<void> => {
    if (!ref || !snapshot || !deps.onOpenEmail || !deps.document || !deps.callers.get
      || draft || removed || busy || workOpening || deleteReview || deleteNeedsCheck) return;
    const selected = snapshot, selectedRef = ref, visit = generation, href = deps.document.defaultView?.location.href ?? deps.document.URL;
    const source = calendarEmailLinks(selected, href)[index]; if (!source) return;
    const owns = () => !disposed && generation === visit && ref === selectedRef && !removed && !draft;
    workOpening = 'email'; error = ''; repaint({ key: 'email-' + index, preventScroll: true });
    try {
      const fresh = await deps.callers.get(selectedRef);
      if (!owns() || snapshot !== selected) return;
      if (!identityMatches(selectedRef, recordId, fresh) || fresh.incarnation !== selected.incarnation
        || fresh.record.received_at !== selected.record.received_at || fresh.event.calendar_id !== selected.event.calendar_id)
        throw new Error('This event or calendar changed. Reopen it from Calendar.');
      if (fresh.refresh_error) throw new Error('The calendar could not verify this event. Refresh it and try again.');
      if (!calendarEmailLinks(fresh, href).some(link => link.hash === source.hash)) throw new Error('This event no longer links to that email. Refresh its details.');
      snapshot = fresh; deps.onSaved(fresh);
      await deps.onOpenEmail(source, selectedRef, fresh, () => owns() && snapshot === fresh);
    } catch (cause) { if (owns()) error = humanizeRpcError(cause); }
    finally { if (!disposed && generation === visit) { workOpening = null; repaint(); } }
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
    flush: () => { captureDraft(); return checkpoint.flush(); },
    renderRecoveries: () => recoveryMarkup(),
    notify: (text: string, focus: 'create-task' | 'create-note' = 'create-task') => { notice = text; repaint({ key: focus, preventScroll: true }); },
    dispose: () => { disposed = true; reset(); },
    async open(next: CalendarEventRef, id: string, expected?: CalendarEventSnapshot, verify?: (value: CalendarEventSnapshot) => void): Promise<void> {
      reset(); if (disposed || !deps.callers.get) return;
      verifyRead = verify;
      expectedRead = expected ? { incarnation: expected.incarnation, receivedAt: expected.record.received_at } : null;
      ref = { ...next }; recordId = id; await read();
    },
    hasSnapshot: () => snapshot !== null,
    isCopying: () => copying,
    recentSnapshot: () => ref && snapshot && !draft && !busy && !removed ? { ref, snapshot } : null,
    isEditable: () => editable(snapshot),
    isEditing: () => draft !== null,
    isDeleting: () => deleteReview || deleteNeedsCheck,
    isLoading: () => busy === 'read' && draft === null,
    hasUnsavedChanges: dirty,
    hasInFlightWork: () => busy === 'save' || busy === 'respond' || busy === 'delete' || (busy === 'read' && draft !== null),
    beforeLeave,
    render(): string {
      if (!ref || (!snapshot && unsupported)) return '';
      if (!snapshot) return `${recoveryMarkup(true)}<div class="calendar-event"><p ${error ? 'role="alert"' : 'role="status"'}>${e(error || 'Loading event details…')}</p>${error ? button('retry', busy ? 'Retrying…' : 'Retry event details') : ''}</div>`;
      const event = snapshot.event;
      const days = event.is_all_day ? allDayEventDays(event) : null;
      const zone = event.timezone || 'Unknown time zone';
      const readOnlyReason = snapshot.read_only_reason || (!editable(snapshot) && !zoneAvailable(event) ? 'The event’s time zone is unavailable in this browser’s editor.' : '');
      const field = (key: Field, label: string, type = 'text'): string => `<label class="calendar-event-field">${e(label)}${!fieldAllowed(key) ? ' (read-only)' : ''}<input class="data-input" type="${type}" ${CALENDAR_EVENT_FIELD}="${key}" ${FOCUS}="${key}" value="${e(draft![key])}"${key === 'summary' ? ' required' : ''}${busy || pendingLeave || saveNeedsCheck || !fieldAllowed(key) && type !== 'text' ? ' disabled' : !fieldAllowed(key) ? ' readonly' : ''}${type === 'datetime-local' ? ' step="any"' : ''}${type === 'text' ? ` maxlength="${CALENDAR_EVENT_EDIT_LIMITS[key as 'summary' | 'location']}"` : ''}></label>`;
      const dateField = (key: 'start' | 'end', label: string): string => {
        const choices = repeatedTime(key);
        return `<div class="calendar-event-date-field">${field(key, label, event.is_all_day ? 'date' : 'datetime-local')}
          <div ${REPEAT}="${key}"${choices ? '' : ' hidden'}>${choices}</div></div>`;
      };
      const editor = draft ? `<div class="calendar-event-editor" aria-label="Edit event">
        <h3>Edit event</h3><p class="calendar-event-hint" data-calendar-edit-recovery-status>${e(checkpoint.message())}</p><p class="calendar-event-hint">${event.is_all_day ? 'All-day dates include the first and last day.' : `Times use ${e(zone)}.`}</p>
        ${snapshot.edit_notice ? `<p class="calendar-event-hint">${e(snapshot.edit_notice)}</p>` : ''}
        ${field('summary', 'Title')}${field('location', 'Location')}
        <div class="calendar-event-dates">${dateField('start', event.is_all_day ? 'First day' : 'Start')}${dateField('end', event.is_all_day ? 'Last day' : 'End')}</div>
        ${canFindTime() && !saveNeedsCheck && !pendingLeave ? `<div class="calendar-event-actions">${button('find-open', 'Find another time')}</div>${timeFinder.render()}` : ''}
        ${snapshot.incarnation && (fieldAllowed('start') || fieldAllowed('end')) ? overlaps.render() : ''}
        <label class="calendar-event-field">Description${!fieldAllowed('description') ? ' (read-only)' : ''}<textarea class="data-input" rows="6" maxlength="${CALENDAR_EVENT_EDIT_LIMITS.description}" ${CALENDAR_EVENT_FIELD}="description" ${FOCUS}="description"${busy || pendingLeave || saveNeedsCheck ? ' disabled' : !fieldAllowed('description') ? ' readonly' : ''}>
${e(draft.description)}</textarea></label>
        ${pendingLeave ? `<div class="calendar-event-discard" role="alertdialog" aria-modal="true" aria-labelledby="calendar-event-discard-title" aria-describedby="calendar-event-discard-copy"><h4 id="calendar-event-discard-title">${deps.recovery ? 'Leave this event?' : 'Discard event changes?'}</h4><p id="calendar-event-discard-copy">${deps.recovery ? 'Keep your edits in this tab for later, discard them, or continue editing.' : 'Your unfinished changes will be lost.'}${recoveredUncertain ? ' The earlier save may still complete. Check your calendar before making another change.' : ''}</p>${error ? `<p role="alert" class="calendar-event-error">${e(error)}</p>` : ''}<div class="calendar-event-actions">${button('keep', 'Keep editing')}${deps.recovery ? button('later', 'Keep edits for later') : ''}${button('discard', 'Discard changes')}</div></div>` : `<div class="calendar-event-actions">${button('save', busy === 'save' ? 'Saving…' : 'Save changes', true)}${button('cancel', 'Cancel')}</div>`}
      </div>` : '';
      const meta = (label: string, value: string) => `<div><dt>${e(label)}</dt><dd>${e(value)}</dd></div>`;
      const deletion = deleteReview || deleteNeedsCheck ? `<section class="calendar-event-delete" aria-label="Delete event">
        <h3>${deleteNeedsCheck ? 'Check this event' : 'Delete this event?'}</h3>
        <p><strong>${e(event.summary || 'Untitled event')}</strong><br>${e(event.calendar_name || event.calendar_id)}</p>
        <p>${e(deletionRangeLabel(event))}${days ? ' · All day' : `<br>${e(zone)}`}</p>
        <p class="calendar-event-hint">${deleteNeedsCheck ? 'Check whether the event is still in this calendar before sending another deletion.' : e(snapshot.provider_delete?.notice ?? 'This permanently removes the event from this local calendar. Guests will not be notified.')}</p>
        ${error ? `<p role="alert" class="calendar-event-error">${e(error)}</p>` : ''}
        <div class="calendar-event-actions">${deleteNeedsCheck ? button('delete-check', busy === 'delete-check' ? 'Checking…' : 'Check deletion')
          : button('delete-cancel', 'Keep event') + button('delete-confirm', busy === 'delete' ? 'Deleting…' : 'Delete event')}</div>
      </section>` : '';
      const more = !draft && !removed && !deleteReview && !deleteNeedsCheck && deletable()
        ? `<details class="calendar-event-more"><summary class="data-button" ${FOCUS}="more">${renderActionLabel('more', 'More')}</summary><div>${button('delete-open', 'Delete event')}</div></details>` : '';
      const errorHtml = error && !deleteNeedsCheck && !pendingLeave ? `<div class="calendar-event-error" role="alert"><p>${e(error)}</p>${responseNeedsCheck ? button('response-check', busy === 'read' ? 'Checking…' : 'Check response') : draft ? `<div class="calendar-event-actions">${button('check', busy === 'read' ? 'Checking…' : 'Check saved event')}${button('reload', 'Reload saved values')}</div>` : snapshot.refresh_error ? button('response-refresh', busy ? 'Refreshing…' : 'Retry refresh') : button('retry', busy ? 'Retrying…' : 'Retry event details')}</div>` : '';
      const occasionHtml = !draft && !removed && !deleteReview && !deleteNeedsCheck && snapshot.occasion ? occasionMarkup(snapshot.occasion) : '';
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
      const attendeesHtml = !draft && event.attendees?.length ? `<section class="calendar-event-guests" aria-label="Event guests"><h3>Guests · ${e(String(event.attendee_count ?? event.attendees.length))}</h3>
        <ul>${event.attendees.map(guest => `<li><span>${guest.display_name ? `<strong>${e(guest.display_name)}</strong><br>` : ''}${e(guest.email)}</span><span class="calendar-event-hint">${e(responseLabel(guest.response_status))}</span></li>`).join('')}</ul>
        ${(event.attendee_count ?? 0) > event.attendees.length ? '<p class="calendar-event-hint">Open the provider calendar to see the complete guest list.</p>' : ''}</section>` : '';
      const meeting = !removed && event.status !== 'cancelled' ? calendarMeetingHref(event.conference_url) : null;
      const emails = deps.onOpenEmail && deps.document && deps.callers.get ? calendarEmailLinks(snapshot, deps.document.defaultView?.location.href ?? deps.document.URL) : [];
      const quickActions = !draft && !removed && !deleteReview && !deleteNeedsCheck ? `<div class="calendar-event-actions calendar-event-quick-actions" role="group" aria-label="Event quick actions">
        ${meeting ? `<a class="data-button data-button--primary" href="${e(meeting)}" target="_blank" rel="noopener noreferrer" ${FOCUS}="join">${renderActionLabel('external-link', 'Join meeting')}</a>` : ''}
        ${deps.onAsk && ref && selectedCalendarEventContext(ref, snapshot) ? button('chat', 'Chat about this') : ''}
        ${emails.map((source, index) => button('email-' + index, workOpening === 'email' ? 'Checking email…' : emails.length === 1 ? 'Open original email' : 'Open email ' + (index + 1) + ' in ' + source.collectionSlug)).join('')}
        ${deps.onCreateTask && ref && selectedCalendarEventContext(ref, snapshot) ? button('create-task', workOpening === 'task' ? 'Opening task…' : 'Create follow-up task') : ''}
        ${deps.onCreateNote && ref && selectedCalendarEventContext(ref, snapshot) ? button('create-note', workOpening === 'note' ? 'Opening note…' : 'Add note') : ''}
        ${deps.onDuplicate && deps.callers.get && ref && selectedCalendarEventContext(ref, snapshot) ? button('duplicate', workOpening === 'duplicate' ? 'Checking original…' : 'Duplicate event') : ''}
        ${deps.document ? button('copy', copying ? 'Copying…' : 'Copy event details') : ''}
      </div>${copyNotice ? `<p role="${copyNotice.error ? 'alert' : 'status'}" class="${copyNotice.error ? 'calendar-event-error' : 'calendar-event-notice'}">${e(copyNotice.text)}</p>` : ''}` : '';
      return `${!draft ? recoveryMarkup(true) : ''}<div class="calendar-event">
        <header class="calendar-event-head"><div class="calendar-event-context"><span class="col-explorer-detail-scope">Calendar · ${e(event.calendar_name || event.calendar_id)}</span><span class="calendar-event-status">${e(event.status === 'cancelled' ? 'Cancelled' : event.status === 'tentative' ? 'Tentative' : 'Confirmed')}${event.is_recurring ? ' · Recurring' : ''}</span></div>
          <div class="calendar-event-title-row"><h2 class="col-explorer-detail-title" data-recued-collection-detail-heading ${FOCUS}="heading" tabindex="-1">${e(event.summary || 'Untitled event')}</h2><div class="calendar-event-actions">${!draft && !removed && !deleteReview && !deleteNeedsCheck && editable(snapshot) ? button('edit', 'Edit event') : ''}${more}</div></div>
        </header>
        ${quickActions}
        ${notice ? `<p role="status" class="calendar-event-notice">${e(notice)}</p>` : ''}
        ${deletion}
        ${busy === 'read' ? `<p role="status" class="calendar-event-hint">${draft ? 'Checking saved event…' : responseNeedsCheck ? 'Checking your response…' : 'Reading event details…'}</p>` : ''}
        ${!draft ? `<dl class="calendar-event-meta">${meta(days ? 'First day' : 'Start', days ? dayLabel(days.first) : timeLabel(event.start_at, zone))}${meta(days ? 'Last day' : 'End', days ? dayLabel(days.last) : timeLabel(event.end_at, zone))}${meta(days ? 'All day' : 'Time zone', days ? 'Yes' : zone)}${meta('Duration', durationLabel(event))}${event.location ? meta('Location', event.location) : ''}</dl>${occasionHtml}${invitationHtml}${attendeesHtml}${event.description ? `<div><h3>Description</h3><p class="calendar-event-description">${e(event.description)}</p>${event.description_truncated ? '<p class="calendar-event-hint">Description preview. The full text is kept in the calendar.</p>' : ''}</div>` : ''}${readOnlyReason ? `<p class="calendar-event-hint">${e(readOnlyReason)}</p>` : ''}` : editor}
        ${!invitation || (!responseNeedsCheck && !snapshot.refresh_error) ? errorHtml : ''}
        ${!draft ? `<details class="calendar-event-identities"><summary>Event identifiers</summary><dl class="calendar-event-meta">${meta('Record id', event.record_id)}${meta('Source id', event.source_id)}</dl></details>` : ''}
      </div>`;
    },
    handleAction(action: string): boolean {
      if (!action.startsWith(CALENDAR_EVENT_ACTION_PREFIX)) return false;
      const key = action.slice(CALENDAR_EVENT_ACTION_PREFIX.length);
      // D-407 slice 5 — the Occasion tick.
      if (key.startsWith('occasion-')) { void occasionAction(key.slice('occasion-'.length)); return true; }
      if (key.startsWith('conflict-')) {
        if (!comparison || busy || workOpening || draft || pendingLeave) return true;
        if (key === 'conflict-prepare-' + comparison.token) void prepareComparison();
        else if (key === 'conflict-cancel-' + comparison.token) { const id = comparison.entry.id; comparison = null; recoveryNotice = ''; repaint('recovery-resume-' + id); }
        return true;
      }
      if (key.startsWith('recovery-')) {
        if (busy || workOpening || draft || pendingLeave) return true;
        const match = /^recovery-(resume|discard|keep|remove)-(ced_[0-9a-f-]{36})-(\d+)$/i.exec(key);
        if (!match) return true;
        const [, operation, id, rawRevision] = match, revision = Number(rawRevision), entry = deps.recovery?.get(id!);
        if (!entry || entry.revision !== revision) { recoveryNotice = 'This recovery copy changed or is no longer available. Review the current kept edits.'; repaint('recovery-notice'); return true; }
        if (operation === 'resume') void resumeRecovery(id!, revision);
        else if (operation === 'discard') { comparison = null; recoveryDiscard = id!; repaint('recovery-keep-' + id); }
        else if (operation === 'keep') { recoveryDiscard = null; repaint('recovery-discard-' + id); }
        else if (operation === 'remove' && recoveryDiscard === id) {
          if (!deps.recovery?.remove(id!)) recoveryNotice = 'The recovery copy could not be discarded. Your kept edits are still here.';
          else { recoveryDiscard = null; recoveryNotice = 'Kept event edits discarded. The saved event stays as it is.'; }
          repaint('recovery-notice');
        }
        return true;
      }

      if (/^email-\d+$/u.test(key)) { void openEmail(Number(key.slice(6))); return true; }
      if (key === 'create-task' || key === 'create-note') { void createWork(key === 'create-task' ? 'task' : 'note'); return true; }
      if (key === 'duplicate') { void duplicate(); return true; }
      if (busy || workOpening) return true;
      if (pendingLeave && !['keep', 'later', 'discard'].includes(key)) return true;
      if ((deleteReview || deleteNeedsCheck) && !['delete-confirm', 'delete-cancel', 'delete-check'].includes(key)) return true;
      if (key === 'copy') void copyDetails();
      if (key === 'chat' && ref && snapshot && !draft && !removed) {
        const context = selectedCalendarEventContext(ref, snapshot);
        if (context) deps.onAsk?.(context, snapshot.event.status === 'cancelled' ? 'What should I know about this cancelled event?' : 'Help me prepare for this meeting.');
      }
      if (key === 'delete-open' && deletable() && !draft && !removed) {
        clearCopy(); comparison = null;
        deleteReview = true; error = ''; notice = ''; repaint('delete-cancel');
      }
      if (key === 'delete-cancel' && !deleteNeedsCheck) { deleteReview = false; error = ''; repaint('more'); }
      if (key === 'delete-confirm') void deleteEvent();
      if (key === 'delete-check') void checkDeletion();
      if (key === 'retry' && !removed) void read(false, 'retry');
      if (key === 'response-check') void read(false, 'response-check');
      if (key === 'response-refresh' && !removed) void read(false, 'response-refresh');
      if (key === 'respond-accepted' || key === 'respond-tentative' || key === 'respond-declined') void respond(key.slice('respond-'.length) as CalendarInvitationResponse);
      if (key === 'edit' && snapshot && editable(snapshot)) {
        if (recoveryEntries(true).entries.length) { recoveryNotice = 'Resume or discard your kept event edits before starting another edit.'; repaint('recovery-notice'); return true; }
        if (saveNeedsCheck) void read(false, 'heading');
        else { clearCopy(); timeFinder.reset(); draft = calendarEventDraft(snapshot.event); checkpoint.begin(calendarEditOriginal(ref!.slug, snapshot), draft, snapshot.event.calendar_name ?? ref!.slug); updateOverlaps(); editorFocus = { key: 'summary' }; error = ''; notice = ''; repaint('summary'); }
      }
      if (key === 'find-open' && canFindTime() && !saveNeedsCheck) {
        const times = draftTimes();
        if (!times) { error = 'Choose valid start and end times before finding another time.'; repaint('start'); }
        else {
          timeFinder.open(calendarWallClockValue(times.start_at, snapshot!.event.timezone).slice(0, 10), snapshot!.event.timezone, 60,
            { durationMs: times.end_at - times.start_at, exclude: { ...ref!, expected_incarnation: snapshot!.incarnation! } });
          repaint('find-from');
        }
      } else if (key === 'find-close') { timeFinder.reset(); repaint('find-open'); }
      else if (key.startsWith('find-')) timeFinder.action(key);
      if (key === 'overlap-retry') overlaps.retry();
      if (key === 'save') void save();
      if (key === 'check') void read(true, 'check');
      if (key === 'cancel') {
        const close = () => { draft = null; overlaps.reset(); timeFinder.reset(); error = ''; notice = ''; repaint('edit'); };
        const cancel = () => { if (!checkpoint.discard()) { error = 'The recovery copy could not be cleared. Keep this event open and try again.'; repaint(); return; } close(); };
        if (beforeLeave(cancel, close)) cancel();
      }
      if (key === 'reload') {
        const refresh = () => { draft = null; overlaps.reset(); timeFinder.reset(); error = ''; void read(false, 'heading'); };
        const reload = () => { if (!checkpoint.discard()) { error = 'The recovery copy could not be cleared. Keep this event open and try again.'; repaint(); return; } refresh(); };
        if (beforeLeave(reload, refresh)) reload();
      }
      if (key === 'keep') resumeEditing();
      if (key === 'later' && deps.recovery && draft && pendingLeave) {
        captureDraft();
        if (!checkpoint.keepForLater()) { error = 'Your latest event edits could not be confirmed in this tab. Keep editing or try keeping them again before leaving.'; repaint('later'); return true; }
        const leave = pendingLeave.keep; pendingLeave = null; draft = null; overlaps.reset(); timeFinder.reset(); comparison = null; error = ''; notice = '';
        leave(); if (!disposed) repaint();
      }
      if (key === 'discard') { if (!checkpoint.discard()) { error = 'The recovery copy could not be cleared. Keep this event open and try again.'; repaint(); return true; } const leave = pendingLeave; pendingLeave = null; draft = null; overlaps.reset(); timeFinder.reset(); error = ''; leave?.discard(); }
      return true;
    },
    handleInput(target: HTMLElement, _change = false): boolean {
      const conflictField = target.getAttribute(CALENDAR_CONFLICT_FIELD) as CalendarConflictField | null;
      if (conflictField) {
        if (!comparison || busy || draft || target.getAttribute(CALENDAR_CONFLICT_TOKEN) !== comparison.token
          || !comparison.rows.some(row => row.key === conflictField && row.conflict)) return true;
        const choice = (target as HTMLSelectElement).value;
        if (choice === 'mine' || choice === 'saved') comparison.choices[conflictField] = choice;
        else if (choice === '') delete comparison.choices[conflictField];
        const status = recoveryRoot?.querySelector('[data-calendar-conflict-status]'); if (status) status.textContent = calendarConflictStatus(comparison);
        const prepare = recoveryRoot?.querySelector<HTMLButtonElement>(`[${FOCUS}="conflict-prepare"]`); if (prepare) prepare.disabled = unresolvedCalendarConflicts(comparison).length > 0;
        return true;
      }
      if (timeFinder.input(target)) return true;
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
      captureDraft();
      if (['start', 'end', 'startChoice', 'endChoice'].includes(key)) {
        timeFinder.reset();
        target.closest?.('.calendar-event')?.querySelector('.calendar-time-finder')?.remove();
        overlaps.mount(target.closest?.('.calendar-event') ?? target); updateOverlaps();
      }
      return true;
    },
    guardKeyDown(event: KeyboardEvent, root: HTMLElement): boolean {
      if (event.key === 'Enter' && (event.target as HTMLElement | null)?.hasAttribute?.(CALENDAR_TIME_FIELD) && timeFinder.owns(event.target as HTMLElement)) {
        if (!event.isComposing && event.keyCode !== 229) { event.preventDefault(); timeFinder.action('find-search'); }
        return true;
      }
      if (!pendingLeave || event.key !== 'Tab') return false;
      const actions = ['keep', ...(deps.recovery ? ['later'] : []), 'discard']
        .map(key => root.querySelector<HTMLElement>(`[${FOCUS}="${key}"]`)).filter((element): element is HTMLElement => element !== null);
      const index = actions.indexOf(event.target as HTMLElement), step = event.shiftKey ? -1 : 1;
      const next = index < 0 ? actions[event.shiftKey ? actions.length - 1 : 0] : actions[(index + step + actions.length) % actions.length];
      event.preventDefault(); next?.focus();
      return true;
    },
    escape(): boolean {
      if (busy === 'delete') return true;
      if (deleteReview && !deleteNeedsCheck) { this.handleAction('calendar-event-delete-cancel'); return true; }
      if (comparison) { if (!busy) this.handleAction('calendar-event-conflict-cancel-' + comparison.token); return true; }
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
      const focus: CalendarEventFocus = { key, start: field.selectionStart, end: field.selectionEnd, ...(key === 'copy' ? { preventScroll: true as const } : {}) };
      if (draft && key in draft) editorFocus = focus;
      return focus;
    },
    restoreFocus(root: HTMLElement, previous: CalendarEventFocus | null): void {
      recoveryRoot = root; overlaps.mount(root); timeFinder.mount(root);
      const requested = pendingFocus; pendingFocus = null;
      if (requested?.onlyIfOwned && previous === null) return;
      const focus = requested ?? previous;
      if (!focus) return;
      const target = Array.from(root.querySelectorAll<HTMLElement>(`[${FOCUS}]`)).find(el => el.getAttribute(FOCUS) === focus.key);
      target?.focus({ preventScroll: focus.preventScroll === true });
      if (focus.start != null && focus.end != null && target && 'setSelectionRange' in target) {
        try { (target as HTMLInputElement).setSelectionRange(focus.start, focus.end); } catch { /* date/select fields */ }
      }
    },
  };
};

export const CALENDAR_EVENT_STYLES = CALENDAR_OVERLAP_STYLES + CALENDAR_TIME_FINDER_STYLES + CALENDAR_EDIT_RECOVERY_STYLES + CALENDAR_EDIT_CONFLICT_STYLES + `
.calendar-event .data-button { display:inline-flex; align-items:center; justify-content:center; gap:6px; }
.calendar-event .data-button svg[aria-hidden=true] { flex:none; }
.calendar-event-quick-actions .data-button { min-height:44px; text-decoration:none; }
.calendar-event { display: grid; gap: 1rem; min-width: 0; }
.calendar-event h3, .calendar-event h4, .calendar-event p { margin: 0; }
.calendar-event-notice { overflow-wrap: anywhere; }
.calendar-event-head { display: grid; gap: .5rem; min-width: 0; }
.calendar-event-context, .calendar-event-title-row { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem 1rem; }
.calendar-event-title-row { justify-content: space-between; }
.calendar-event-head .col-explorer-detail-title { font-size: 1.125rem; line-height: 1.4; }
.calendar-event h3 { font-size: 1rem; }
.calendar-event-status, .calendar-event-hint, .calendar-event-identities { color: var(--fg-muted); font-size: .8125rem; overflow-wrap: anywhere; }
.calendar-event-invitation { display: grid; gap: .75rem; border: 1px solid var(--border); border-radius: .5rem; padding: 1rem; }
.calendar-event-guests { display:grid; gap:.75rem; }
.calendar-event-guests h3 { margin:0; }
.calendar-event-guests ul { display:grid; gap:.5rem; list-style:none; margin:0; padding:0; }
.calendar-event-guests li { display:flex; align-items:center; justify-content:space-between; gap:1rem; border-bottom:1px solid var(--border); padding:.5rem 0; }
.calendar-event-guests li > span:first-child { min-width:0; overflow-wrap:anywhere; }
.calendar-event-guests li > span:last-child { flex:none; }
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
.calendar-event-more { position: relative; }
.calendar-event-more > summary { list-style: none; cursor: pointer; }
.calendar-event-more > summary::-webkit-details-marker { display: none; }
.calendar-event-more > div { position: absolute; right: 0; top: calc(100% + .25rem); z-index: 2; padding: .5rem; border: 1px solid var(--border); border-radius: .5rem; background: var(--surface); box-shadow: 0 4px 12px #0002; white-space: nowrap; }
.calendar-event-delete { display: grid; gap: .75rem; padding: 1rem; min-width: 0; overflow-wrap: anywhere; border: 1px solid var(--border); border-radius: .5rem; background: var(--surface); }
.calendar-event-error, .calendar-event-discard { display: grid; gap: .75rem; padding: .875rem; border: 1px solid var(--border); border-radius: .375rem; }
.calendar-event-error { color: var(--danger); }
.calendar-event-identities summary { cursor: pointer; margin-bottom: .75rem; min-height: 36px; box-sizing: border-box; padding-block: 8px; }
@media (max-width: 540px) { .calendar-event-meta, .calendar-event-invitation .calendar-event-meta, .calendar-event-dates { grid-template-columns: minmax(0, 1fr); } .calendar-event-editor { padding: .75rem; } }
`;
