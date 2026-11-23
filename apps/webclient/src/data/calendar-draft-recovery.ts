import { CALENDAR_EVENT_EDIT_LIMITS, DAY_MS, calendarDayMs, normalizeCalendarEventGuests, type CalendarEventCreateRequest } from '@recued/contracts';
import type { CalendarCreateDraft } from './calendar-create-surface.js';
import { calendarWallClockCandidates } from './calendar-event-surface.js';
import { readCalendarTaskOrigin, type CalendarTaskOrigin } from './calendar-task-draft.js';
import { readCalendarMailOrigin, type CalendarMailOrigin } from './calendar-mail.js';
import { readCalendarDuplicateOrigin, type CalendarDuplicateOrigin } from './calendar-event-duplicate.js';
import { createDraftRecoveryStore, type DraftRecoveryEntry, type DraftRecoveryStorage, type DraftRecoveryTicket } from './draft-recovery.js';

export interface CalendarRecoveryValues {
  draft: CalendarCreateDraft;
  zone: string;
  calendarName: string;
  incarnation: string | null;
  creationId: string;
  request: CalendarEventCreateRequest | null;
  duplicate?: CalendarDuplicateOrigin;
  mail?: CalendarMailOrigin;
  task?: CalendarTaskOrigin;
}
export type CalendarRecoveryEntry = DraftRecoveryEntry<CalendarRecoveryValues, null>;
export type CalendarRecoveryStorage = DraftRecoveryStorage;
export const CALENDAR_RECOVERY_LIMITS = { entries: 6, entryBytes: 1024 * 1024, bytes: 2 * 1024 * 1024, age: 7 * DAY_MS } as const;
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length <= limit;
const identifier = (value: unknown, limit = 256): value is string => text(value, limit) && value.length > 0;
export const calendarDraftDestination = (value: string): [string, string] | null => {
  try {
    const pair: unknown = JSON.parse(value);
    return Array.isArray(pair) && pair.length === 2 && identifier(pair[0]) && identifier(pair[1], 4096) ? [pair[0], pair[1]] : null;
  } catch { return null; }
};

/** Stored values are data only. A pending copy must bind the exact reviewed
 * calendar, interval, guests and creation ID; unknown fields never reach RPC. */
export const parseCalendarRecovery = (input: unknown, now: number): CalendarRecoveryEntry | null => {
  const row = object(input), values = object(row?.values), raw = object(values?.draft);
  if (!row || !values || !raw || typeof row.id !== 'string' || !row.id.startsWith('cdr_') || !uuid(row.id.slice(4))
    || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1 || row.sourceId !== 'calendar' || row.original !== null
    || !Number.isSafeInteger(row.updatedAt) || Number(row.updatedAt) < 0 || Number(row.updatedAt) > now + 60_000
    || !['editing', 'pending', 'unknown'].includes(String(row.status))
    || row.status === 'editing' && Number(row.updatedAt) < now - CALENDAR_RECOVERY_LIMITS.age
    || !uuid(values.creationId) || !identifier(values.zone) || !text(values.calendarName, 1024) || values.incarnation !== null && !identifier(values.incarnation)
    || typeof raw.allDay !== 'boolean' || !text(raw.destination, 9000) || raw.destination !== '' && !calendarDraftDestination(raw.destination)
    || !text(raw.summary, CALENDAR_EVENT_EDIT_LIMITS.summary) || !text(raw.description, CALENDAR_EVENT_EDIT_LIMITS.description)
    || !text(raw.location, CALENDAR_EVENT_EDIT_LIMITS.location) || !text(raw.start, 32) || !text(raw.end, 32)
    || !text(raw.startChoice, 32) || !text(raw.endChoice, 32) || !text(raw.guestQuery, 320) || !Array.isArray(raw.guests)) return null;
  let guests: CalendarCreateDraft['guests'];
  try {
    new Intl.DateTimeFormat('en', { timeZone: values.zone });
    guests = normalizeCalendarEventGuests(raw.guests);
  } catch { return null; }
  const draft: CalendarCreateDraft = { destination: raw.destination, summary: raw.summary, description: raw.description, location: raw.location,
    start: raw.start, end: raw.end, allDay: raw.allDay, startChoice: raw.startChoice, endChoice: raw.endChoice, guests, guestQuery: raw.guestQuery };
  const duplicate = values.duplicate === undefined ? undefined : readCalendarDuplicateOrigin(values.duplicate);
  const mail = values.mail === undefined ? undefined : readCalendarMailOrigin(values.mail);
  const task = values.task === undefined ? undefined : readCalendarTaskOrigin(values.task);
  if (duplicate === null || mail === null || task === null || [duplicate, mail, task].filter(Boolean).length > 1 || duplicate?.keepDuration && duplicate.allDay !== draft.allDay) return null;
  let request: CalendarEventCreateRequest | null = null;
  if (row.status === 'editing') {
    if (values.request !== null) return null;
  } else {
    const pending = object(values.request), pair = calendarDraftDestination(draft.destination);
    if (!pending || !pair || !uuid(row.attempt) || !values.incarnation || draft.guestQuery.trim()
      || pending.slug !== pair[0] || pending.calendar_id !== pair[1] || pending.expected_incarnation !== values.incarnation
      || pending.creation_id !== values.creationId || pending.timezone !== values.zone || pending.is_all_day !== draft.allDay
      || !draft.summary.trim() || pending.summary !== draft.summary.trim() || pending.description !== draft.description || pending.location !== draft.location
      || !Number.isSafeInteger(pending.start_at) || !Number.isSafeInteger(pending.end_at) || Number(pending.end_at) <= Number(pending.start_at)
      || Boolean(guests.length) !== (pending.send_invitations === true)) return null;
    try {
      if (JSON.stringify(normalizeCalendarEventGuests(pending.guests ?? [])) !== JSON.stringify(guests)) return null;
      for (const key of ['start', 'end'] as const) {
        const at = Number(pending[`${key}_at`]);
        if (draft.allDay) {
          const day = calendarDayMs(draft[key]);
          if (day === null || at !== day + (key === 'end' ? DAY_MS : 0)) return null;
        } else {
          const candidates = calendarWallClockCandidates(draft[key], values.zone);
          if (!candidates.includes(at) || candidates.length > 1 && draft[`${key}Choice`] !== String(at)) return null;
        }
      }
    } catch { return null; }
    request = { slug: pair[0], calendar_id: pair[1], expected_incarnation: values.incarnation, creation_id: values.creationId,
      summary: draft.summary.trim(), description: draft.description, location: draft.location, timezone: values.zone, is_all_day: draft.allDay,
      start_at: Number(pending.start_at), end_at: Number(pending.end_at), ...(guests.length ? { guests, send_invitations: true as const } : {}) };
  }
  return { id: row.id, revision: Number(row.revision), updatedAt: Number(row.updatedAt), sourceId: 'calendar', original: null,
    status: row.status as CalendarRecoveryEntry['status'], ...(row.status !== 'editing' ? { attempt: row.attempt as string } : {}),
    values: { draft, zone: values.zone, calendarName: values.calendarName, incarnation: values.incarnation as string | null, creationId: values.creationId, request,
      ...(duplicate ? { duplicate } : {}), ...(mail ? { mail } : {}), ...(task ? { task } : {}) } };
};

export const createCalendarRecoveryStore = (opts: { scope: string; storage?: CalendarRecoveryStorage | null; now?: () => number }) =>
  createDraftRecoveryStore({ ...opts, key: `recued.calendar.draft-recovery.v1:${encodeURIComponent(opts.scope)}`,
    limits: CALENDAR_RECOVERY_LIMITS, parse: parseCalendarRecovery });
export type CalendarRecoveryStore = ReturnType<typeof createCalendarRecoveryStore>;

/** Flush before dispatch/pagehide. Settlement owns only its exact revision and
 * attempt, including replies that arrive after the form has been disposed. */
export const createCalendarDraftCheckpoint = (opts: { store?: CalendarRecoveryStore; now?: () => number; changed(): void }) => {
  const now = opts.now ?? Date.now;
  let entry: CalendarRecoveryEntry | null = null, needsWrite = false, persisted = false, failed = false;
  let storedRevision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = (): boolean => {
    clearTimeout(timer); timer = undefined;
    if (!entry || !needsWrite) return true;
    if (persisted && opts.store?.get(entry.id)?.revision !== storedRevision) { failed = true; opts.changed(); return false; }
    entry = { ...entry, revision: entry.revision + 1, updatedAt: now() };
    failed = !opts.store?.save(entry); persisted ||= !failed; needsWrite = failed;
    if (!failed) storedRevision = entry.revision;
    opts.changed(); return !failed;
  };
  const suspend = () => { flush(); entry = null; needsWrite = persisted = failed = false; storedRevision = 0; };
  const capture = (values: CalendarRecoveryValues) => {
    if (!entry || JSON.stringify(entry.values) === JSON.stringify(values)) return;
    entry = { ...entry, values: structuredClone(values) }; needsWrite = true;
    clearTimeout(timer); timer = setTimeout(flush, 300);
  };
  return {
    flush, suspend, capture,
    /** Prove the exact recovery is readable before releasing the form, even
     * when its latest details were already written by the debounce. */
    keepForLater(): boolean {
      if (!entry || !opts.store || !flush()) return false;
      try {
        const stored = opts.store.get(entry.id), expected = parseCalendarRecovery(entry, now());
        if (!persisted || !stored || !expected || stored.revision !== storedRevision || JSON.stringify(stored) !== JSON.stringify(expected)) {
          failed = true; opts.changed(); return false;
        }
      } catch { failed = true; opts.changed(); return false; }
      suspend(); return true;
    },
    begin(values: CalendarRecoveryValues, restored?: CalendarRecoveryEntry, keepInitial = false) {
      suspend();
      if (!opts.store) return;
      entry = restored ? structuredClone(restored) : { id: `cdr_${crypto.randomUUID()}`, revision: 1, updatedAt: now(), sourceId: 'calendar',
        original: null, status: 'editing', values: structuredClone(values) };
      persisted = Boolean(restored);
      storedRevision = restored?.revision ?? 0;
      if (keepInitial && !restored) { needsWrite = true; timer = setTimeout(flush, 300); }
    },
    id: () => entry?.id,
    hasChanges: () => needsWrite || persisted,
    message: () => !opts.store ? '' : failed ? 'Latest details could not be kept in this tab. Keep this event open or copy its details before leaving.'
      : entry?.status !== undefined && entry.status !== 'editing' ? 'Save not confirmed. Its original request is kept in this tab.'
        : persisted ? 'Event details kept in this tab.' : 'Unfinished event drafts are kept in this tab.',
    startAttempt(values: CalendarRecoveryValues): DraftRecoveryTicket | undefined {
      if (!entry) return undefined;
      const previous = entry, hadRecovery = persisted;
      entry = { ...entry, values: structuredClone(values), status: 'pending', attempt: crypto.randomUUID() }; needsWrite = true;
      const blocked = !flush() && hadRecovery;
      if (blocked) {
        entry = { ...previous, revision: entry.revision, values: { ...values, request: previous.status === 'editing' ? null : values.request } };
        needsWrite = true;
      }
      return { id: entry.id, attempt: entry.attempt!, revision: entry.revision, blocked };
    },
    settle(ticket: DraftRecoveryTicket | undefined, outcome: 'confirmed' | 'refused' | 'unknown') {
      if (!ticket) return;
      const current = opts.store?.get(ticket.id);
      const owned = current?.attempt === ticket.attempt && current?.revision === ticket.revision;
      if (current && !owned) return;
      const next = (row: CalendarRecoveryEntry): CalendarRecoveryEntry => ({ ...row, revision: row.revision + 1, updatedAt: now(),
        status: outcome === 'refused' ? 'editing' : 'unknown', values: { ...row.values, ...(outcome === 'refused' ? { request: null } : {}) } });
      const saved = owned && (outcome === 'confirmed' ? opts.store?.remove(ticket.id) : opts.store?.save(next(current!)));
      if (entry?.id !== ticket.id || entry.attempt !== ticket.attempt) return;
      if (saved && outcome === 'confirmed') { clearTimeout(timer); entry = null; needsWrite = persisted = failed = false; }
      else {
        entry = next(entry); failed = !saved; needsWrite = !saved;
        if (saved) { persisted = true; storedRevision = entry.revision; }
      }
      opts.changed();
    },
    discard(): boolean {
      clearTimeout(timer); timer = undefined;
      if (entry && persisted && !opts.store?.remove(entry.id)) { failed = true; opts.changed(); return false; }
      entry = null; needsWrite = persisted = failed = false; return true;
    },
  };
};
