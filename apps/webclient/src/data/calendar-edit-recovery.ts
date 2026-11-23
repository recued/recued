import { DAY_MS, type CalendarEventDetails, type CalendarEventSnapshot, type CalendarEventUpdateRequest } from '@recued/contracts';
import { calendarEventDraft, calendarEventPatch, type CalendarEventDraft } from './calendar-event-draft.js';
import { createDraftRecoveryStore, type DraftRecoveryEntry, type DraftRecoveryStorage, type DraftRecoveryTicket } from './draft-recovery.js';

export interface CalendarEditOriginal {
  slug: string; incarnation: string; resource_version: string; providerCheck: boolean; event: CalendarEventDetails;
}
export interface CalendarEditValues { draft: CalendarEventDraft; calendarName: string; request: CalendarEventUpdateRequest | null }
export interface CalendarEditEntry extends DraftRecoveryEntry<CalendarEditValues, CalendarEditOriginal> { original: CalendarEditOriginal }
export const CALENDAR_EDIT_RECOVERY_LIMITS = { entries: 6, entryBytes: 2 * 1024 * 1024, bytes: 4 * 1024 * 1024, age: 7 * DAY_MS } as const;
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown, max = 4096): value is string => typeof value === 'string' && value.length <= max;
const id = (value: unknown): value is string => text(value) && value.length > 0;
const time = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const fields = ['summary', 'description', 'location', 'start', 'end', 'startChoice', 'endChoice'] as const;
const eventFields = ['record_id', 'source_id', 'calendar_id', 'summary', 'description', 'location', 'start_at', 'end_at', 'updated_at', 'timezone', 'is_all_day', 'status', 'is_recurring'] as const;
export const calendarEditOriginal = (slug: string, snapshot: CalendarEventSnapshot): CalendarEditOriginal => ({
  slug, incarnation: snapshot.incarnation!, resource_version: snapshot.resource_version, providerCheck: snapshot.editable_fields !== undefined,
  event: Object.fromEntries(eventFields.map(key => [key, snapshot.event[key]])) as unknown as CalendarEventDetails,
});
export const parseCalendarEditRecovery = (input: unknown, now: number): CalendarEditEntry | null => {
  const row = object(input), original = object(row?.original), event = object(original?.event), values = object(row?.values), draft = object(values?.draft);
  if (!row || !original || !event || !values || !draft || !text(row.id, 40) || !row.id.startsWith('ced_') || !uuid(row.id.slice(4))
    || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1 || !id(row.sourceId) || row.sourceId !== original.slug
    || !time(row.updatedAt) || row.updatedAt > now + 60_000 || !['editing', 'pending', 'unknown'].includes(String(row.status))
    || row.status === 'editing' && row.updatedAt < now - CALENDAR_EDIT_RECOVERY_LIMITS.age
    || !id(original.incarnation) || !id(original.resource_version) || typeof original.providerCheck !== 'boolean'
    || !['record_id', 'source_id', 'calendar_id', 'timezone'].every(key => id(event[key]))
    || !['summary', 'description', 'location'].every(key => text(event[key], 1_000_000))
    || !time(event.start_at) || !time(event.end_at) || event.end_at <= event.start_at || !time(event.updated_at)
    || typeof event.is_all_day !== 'boolean' || typeof event.is_recurring !== 'boolean' || !['confirmed', 'tentative', 'cancelled'].includes(String(event.status))
    || !fields.every(key => text(draft[key], ['summary', 'description', 'location'].includes(key) ? 1_000_000 : 64)) || !text(values.calendarName)
    || row.status !== 'editing' && !uuid(row.attempt)) return null;
  const base = { slug: row.sourceId, incarnation: original.incarnation, resource_version: original.resource_version, providerCheck: original.providerCheck,
    event: Object.fromEntries(eventFields.map(key => [key, event[key]])) as unknown as CalendarEventDetails };
  const cleanDraft = Object.fromEntries(fields.map(key => [key, draft[key]])) as CalendarEventDraft;
  let request: CalendarEventUpdateRequest | null = null;
  if (row.status === 'editing') { if (values.request !== null) return null; }
  else {
    const raw = object(values.request), patch = object(raw?.patch), calculated = calendarEventPatch(base.event, cleanDraft).patch;
    if (!raw || !patch || !calculated || !Object.keys(calculated).length || raw.slug !== base.slug || raw.source_id !== base.event.source_id
      || raw.expected_incarnation !== base.incarnation || raw.expected_version !== base.resource_version
      || Object.keys(patch).length !== Object.keys(calculated).length || Object.entries(calculated).some(([key, value]) => patch[key] !== value)) return null;
    request = { slug: base.slug, source_id: base.event.source_id, expected_incarnation: base.incarnation, expected_version: base.resource_version, patch: calculated };
  }
  return { id: row.id, revision: Number(row.revision), updatedAt: row.updatedAt, sourceId: row.sourceId, original: base,
    values: { draft: cleanDraft, calendarName: values.calendarName, request }, status: row.status as CalendarEditEntry['status'],
    ...(row.status !== 'editing' ? { attempt: row.attempt as string } : {}) };
};
export const createCalendarEditRecoveryStore = (opts: { scope: string; storage?: DraftRecoveryStorage | null; now?: () => number }) =>
  createDraftRecoveryStore<CalendarEditValues, CalendarEditOriginal>({ ...opts, key: `recued.calendar.edit-recovery.v1:${encodeURIComponent(opts.scope)}`,
    limits: CALENDAR_EDIT_RECOVERY_LIMITS, parse: parseCalendarEditRecovery });
export type CalendarEditRecoveryStore = ReturnType<typeof createCalendarEditRecoveryStore>;

/** Persist the original review and exact draft. Late replies only settle their
 * own attempt/revision; recovery data never bypasses a fresh calendar read. */
export const createCalendarEditCheckpoint = (opts: { store?: CalendarEditRecoveryStore; now?: () => number; changed(): void }) => {
  const now = opts.now ?? Date.now;
  let entry: CalendarEditEntry | null = null, baseline = '', needsWrite = false, persisted = false, failed = false;
  let storedRevision = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const flush = (): boolean => {
    clearTimeout(timer); timer = undefined;
    if (!entry || !needsWrite) return true;
    if (persisted && opts.store?.get(entry.id)?.revision !== storedRevision) { failed = true; opts.changed(); return false; }
    const next = { ...entry, revision: entry.revision + 1, updatedAt: now() };
    failed = !opts.store?.save(next);
    if (!failed) { entry = next; storedRevision = next.revision; persisted = true; needsWrite = false; }
    opts.changed(); return !failed;
  };
  const suspend = () => { flush(); entry = null; baseline = ''; needsWrite = persisted = failed = false; storedRevision = 0; };
  return {
    flush, suspend, id: () => entry?.id,
    /** Leaving must prove the exact copy can still be read, even when a prior
     * debounce already flushed it. Failure leaves this checkpoint attached. */
    keepForLater(): boolean {
      if (!entry || !opts.store || !flush()) return false;
      try {
        const stored = opts.store.get(entry.id), expected = parseCalendarEditRecovery(entry, now());
        if (!persisted || !stored || !expected || stored.revision !== storedRevision || JSON.stringify(stored) !== JSON.stringify(expected)) {
          failed = true; opts.changed(); return false;
        }
      } catch { failed = true; opts.changed(); return false; }
      suspend(); return true;
    },
    begin(original: CalendarEditOriginal, draft: CalendarEventDraft, calendarName: string, restored?: CalendarEditEntry) {
      suspend(); if (!opts.store) return;
      baseline = JSON.stringify(calendarEventDraft(original.event));
      entry = restored ? structuredClone(restored) : { id: 'ced_' + crypto.randomUUID(), revision: 1, updatedAt: now(), sourceId: original.slug,
        original: structuredClone(original), values: { draft: { ...draft }, calendarName, request: null }, status: 'editing' };
      persisted = Boolean(restored); storedRevision = restored?.revision ?? 0;
    },
    capture(draft: CalendarEventDraft) {
      if (!entry || entry.status !== 'editing' || JSON.stringify(entry.values.draft) === JSON.stringify(draft)) return;
      if (!persisted && JSON.stringify(draft) === baseline) { clearTimeout(timer); timer = undefined; needsWrite = false; entry = { ...entry, values: { ...entry.values, draft: { ...draft } } }; return; }
      entry = { ...entry, values: { ...entry.values, draft: { ...draft } } }; needsWrite = true;
      clearTimeout(timer); timer = setTimeout(flush, 300);
    },
    message: () => !opts.store ? '' : failed ? 'Latest event edits could not be kept in this tab. Keep this event open or copy your edits before leaving.'
      : entry && entry.status !== 'editing' ? 'Save not confirmed. Check the saved event before sending changes again.'
        : persisted ? 'Event edits kept in this tab.' : 'Unfinished event edits are kept in this tab.',
    startAttempt(request: CalendarEventUpdateRequest): DraftRecoveryTicket | undefined {
      if (!entry) return undefined;
      entry = { ...entry, status: 'pending', attempt: crypto.randomUUID(), values: { ...entry.values, request: structuredClone(request) } }; needsWrite = true;
      const blocked = !flush();
      if (blocked) entry = { ...entry, status: 'editing', values: { ...entry.values, request: null } };
      return { id: entry.id, revision: entry.revision, attempt: entry.attempt!, blocked };
    },
    settle(ticket: DraftRecoveryTicket | undefined, outcome: 'confirmed' | 'refused' | 'unknown') {
      if (!ticket) return;
      const current = opts.store?.get(ticket.id);
      if (!current || current.revision !== ticket.revision || current.attempt !== ticket.attempt) return;
      const next: CalendarEditEntry = { ...current, original: current.original!, revision: current.revision + 1, updatedAt: now(),
        status: outcome === 'refused' ? 'editing' : 'unknown', values: { ...current.values, ...(outcome === 'refused' ? { request: null } : {}) } };
      const saved = outcome === 'confirmed' ? opts.store?.remove(ticket.id) : opts.store?.save(next);
      if (entry?.id === ticket.id && entry.attempt === ticket.attempt) {
        if (outcome === 'confirmed' && saved) { entry = null; needsWrite = persisted = failed = false; }
        else { entry = next; failed = !saved; needsWrite = !saved; storedRevision = saved ? next.revision : storedRevision; }
        opts.changed();
      }
    },
    discard(): boolean {
      clearTimeout(timer); timer = undefined;
      if (entry && persisted && (opts.store?.get(entry.id)?.revision !== storedRevision || !opts.store?.remove(entry.id))) { failed = true; opts.changed(); return false; }
      entry = null; baseline = ''; needsWrite = persisted = failed = false; return true;
    },
  };
};

/** Universal Search reads both calendar recovery collections under one stable
 * owner. It never copies draft text into another index or persistence. */
export const calendarRecoverySearchStore = (stores: Array<Pick<import('./draft-recovery.js').DraftRecoveryStore<unknown, unknown>, 'list' | 'get' | 'inspect'> | undefined>) => {
  const available = stores.filter((store): store is NonNullable<typeof store> => store !== undefined);
  if (!available.length) return undefined;
  return { list: () => available.flatMap(store => store.list()), get: (id: string) => available.map(store => store.get(id)).find(Boolean) ?? null,
    inspect: () => { const reads = available.map(store => store.inspect?.() ?? { entries: store.list(), unavailable: false });
      return { entries: reads.flatMap(read => read.entries), unavailable: reads.some(read => read.unavailable) }; } };
};
