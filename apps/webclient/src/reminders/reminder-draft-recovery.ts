import { REMINDER_TEXT_MAX, readReminderMailReference, readReminderRecordReference, zonedWallClockToEpochMs,
  type ReminderCreateRequest, type ReminderMailReference, type ReminderRecordReference } from '@recued/contracts';
import { createDraftRecoveryStore, type DraftRecoveryEntry, type DraftRecoveryStorage, type DraftRecoveryTicket } from '../data/draft-recovery.js';
import { serializeShellRoute, serializeSourceRecordAddress } from '../shell/route.js';
import { reminderWallClockValue } from './reminder-time.js';

export interface ReminderDraftValues {
  kind: 'reminder' | 'alarm'; text: string; time: string; zone: string; chosenAt: number | null;
  creationId: string; fromHistory: boolean; request: ReminderCreateRequest | null;
  record_ref?: ReminderRecordReference; mail_ref?: ReminderMailReference;
}
export type ReminderDraftEntry = DraftRecoveryEntry<ReminderDraftValues, null>;
export type ReminderRecoveryStorage = DraftRecoveryStorage;
export const REMINDER_RECOVERY_LIMITS = { entries: 8, entryBytes: 64 * 1024, bytes: 512 * 1024, age: 7 * 86_400_000 } as const;
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const instant = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 8.64e15;
export const reminderDraftText = (text: string) => text.replace(/\s+/gu, ' ').trim();
export const reminderDraftAt = (values: Pick<ReminderDraftValues, 'time' | 'zone' | 'chosenAt'>): number | null => {
  try {
    const at = values.chosenAt ?? zonedWallClockToEpochMs(values.time, values.zone);
    return at !== null && instant(at) && reminderWallClockValue(at, values.zone) === values.time ? at : null;
  } catch { return null; }
};
export const reminderDraftSource = (values: Pick<ReminderDraftValues, 'mail_ref' | 'record_ref'>): { href: string; label: string } | undefined =>
  values.mail_ref ? { href: serializeSourceRecordAddress({ tab: 'mail', collectionSlug: values.mail_ref.slug, recordId: values.mail_ref.record_id }), label: 'View source email' }
    : values.record_ref ? { href: serializeShellRoute('data', values.record_ref.kind, values.record_ref.id), label: `View source ${values.record_ref.kind}` } : undefined;

/** Recovery is unfinished owner input. A submitted copy must bind the exact
 * request and original creation ID; stored data never invents RPC arguments. */
export const parseReminderRecovery = (input: unknown, now: number): ReminderDraftEntry | null => {
  const row = object(input), raw = object(row?.values);
  if (!row || !raw || typeof row.id !== 'string' || !row.id.startsWith('rdr_') || !uuid(row.id.slice(4))
    || row.original !== null || row.sourceId !== 'reminder' || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1
    || !instant(row.updatedAt) || row.updatedAt > now + 60_000 || !['editing', 'pending', 'unknown'].includes(String(row.status))
    || row.status === 'editing' && row.updatedAt < now - REMINDER_RECOVERY_LIMITS.age
    || !['reminder', 'alarm'].includes(String(raw.kind)) || typeof raw.text !== 'string' || raw.text.length > REMINDER_TEXT_MAX
    || typeof raw.time !== 'string' || raw.time.length > 32 || typeof raw.zone !== 'string' || raw.zone.length > 256
    || raw.chosenAt !== null && !instant(raw.chosenAt) || !uuid(raw.creationId) || typeof raw.fromHistory !== 'boolean') return null;
  try { new Intl.DateTimeFormat('en', { timeZone: raw.zone }); } catch { return null; }
  const record_ref = raw.record_ref === undefined ? undefined : readReminderRecordReference(raw.record_ref);
  const mail_ref = raw.mail_ref === undefined ? undefined : readReminderMailReference(raw.mail_ref);
  if (raw.record_ref !== undefined && !record_ref || raw.mail_ref !== undefined && !mail_ref || record_ref && mail_ref) return null;
  const values: ReminderDraftValues = { kind: raw.kind as ReminderDraftValues['kind'], text: raw.text, time: raw.time, zone: raw.zone,
    chosenAt: raw.chosenAt as number | null, creationId: raw.creationId, fromHistory: raw.fromHistory, request: null,
    ...(record_ref ? { record_ref } : {}), ...(mail_ref ? { mail_ref } : {}) };
  if (values.chosenAt !== null && reminderDraftAt(values) === null) return null;
  if (row.status === 'editing') { if (raw.request !== null) return null; }
  else {
    const request = object(raw.request), at = reminderDraftAt(values), text = reminderDraftText(values.text);
    if (!request || !uuid(row.attempt) || at === null || !text || request.at !== at || request.text !== text || request.creation_id !== values.creationId
      || JSON.stringify(request.record_ref === undefined ? undefined : readReminderRecordReference(request.record_ref)) !== JSON.stringify(record_ref)
      || JSON.stringify(request.mail_ref === undefined ? undefined : readReminderMailReference(request.mail_ref)) !== JSON.stringify(mail_ref)
      || (request.record_ref !== undefined) !== Boolean(record_ref) || (request.mail_ref !== undefined) !== Boolean(mail_ref)) return null;
    values.request = { text, at, creation_id: values.creationId, ...(record_ref ? { record_ref } : {}), ...(mail_ref ? { mail_ref } : {}) };
  }
  return { id: row.id, revision: Number(row.revision), updatedAt: row.updatedAt, sourceId: 'reminder', original: null, values,
    status: row.status as ReminderDraftEntry['status'], ...(row.status !== 'editing' ? { attempt: row.attempt as string } : {}) };
};
export const createReminderRecoveryStore = (options: { scope: string; storage?: ReminderRecoveryStorage | null; now?: () => number }) =>
  createDraftRecoveryStore<ReminderDraftValues, null>({ ...options, key: 'recued.reminder.draft-recovery.v1:' + encodeURIComponent(options.scope),
    limits: REMINDER_RECOVERY_LIMITS, parse: parseReminderRecovery });
export type ReminderRecoveryStore = ReturnType<typeof createReminderRecoveryStore>;

/** Replies settle only their exact attempt and revision, even after disposal
 * or a later resume. Leaving proves the latest copy can still be read. */
export const createReminderDraftCheckpoint = (options: { store?: ReminderRecoveryStore; now?: () => number; changed(): void }) => {
  const now = options.now ?? Date.now;
  let entry: ReminderDraftEntry | null = null, needsWrite = false, persisted = false, failed = false, storedRevision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = (force = false): boolean => {
    clearTimeout(timer); timer = undefined;
    if (!entry || !needsWrite && !force) return true;
    if (persisted && options.store?.get(entry.id)?.revision !== storedRevision) { failed = true; options.changed(); return false; }
    const next = { ...entry, revision: entry.revision + 1, updatedAt: now() };
    failed = !options.store?.save(next);
    if (!failed) { entry = next; storedRevision = next.revision; persisted = true; needsWrite = false; }
    options.changed(); return !failed;
  };
  const clear = () => { clearTimeout(timer); timer = undefined; entry = null; needsWrite = persisted = failed = false; storedRevision = 0; };
  const suspend = () => { flush(); clear(); };
  return {
    flush, suspend, id: () => entry?.id, status: () => entry?.status,
    message: () => !options.store ? '' : failed ? 'Latest details could not be kept in this tab. Keep this form open or copy its details.'
      : entry?.status !== 'editing' && entry ? 'Save not confirmed. The original request is kept in this tab.'
        : persisted ? 'Draft kept in this tab.' : 'Unfinished drafts are kept in this tab for up to 7 days.',
    begin(values: ReminderDraftValues, restored?: ReminderDraftEntry, keepInitial = false) {
      suspend(); if (!options.store) return;
      entry = restored ? structuredClone(restored) : { id: 'rdr_' + crypto.randomUUID(), sourceId: 'reminder', original: null,
        updatedAt: now(), revision: 1, status: 'editing', values: structuredClone(values) };
      persisted = Boolean(restored); storedRevision = restored?.revision ?? 0;
      if (keepInitial && !restored) { needsWrite = true; timer = setTimeout(() => flush(), 180); }
    },
    capture(values: ReminderDraftValues) {
      if (!entry || entry.status !== 'editing' || JSON.stringify(entry.values) === JSON.stringify(values)) return;
      entry = { ...entry, values: structuredClone(values) }; needsWrite = true;
      clearTimeout(timer); timer = setTimeout(() => flush(), 180);
    },
    keepForLater(): boolean {
      if (!entry || !options.store || !flush(!persisted && !needsWrite)) return false;
      const expected = parseReminderRecovery(entry, now()), actual = options.store.get(entry.id);
      if (!expected || !actual || JSON.stringify(actual) !== JSON.stringify(expected)) { failed = true; options.changed(); return false; }
      clear(); return true;
    },
    startAttempt(values: ReminderDraftValues): DraftRecoveryTicket | undefined {
      if (!entry) return undefined;
      const previous = entry;
      entry = { ...entry, values: structuredClone(values), status: 'pending', attempt: crypto.randomUUID() }; needsWrite = true;
      if (!flush()) { entry = previous; needsWrite = true; return { id: entry.id, attempt: '', revision: entry.revision, blocked: true }; }
      return { id: entry.id, attempt: entry.attempt!, revision: entry.revision };
    },
    settle(ticket: DraftRecoveryTicket | undefined, outcome: 'confirmed' | 'refused' | 'unknown') {
      if (!ticket) return;
      const current = options.store?.get(ticket.id);
      if (current?.revision !== ticket.revision || current.attempt !== ticket.attempt) return;
      const next: ReminderDraftEntry = { ...current, revision: current.revision + 1, updatedAt: now(),
        status: outcome === 'refused' ? 'editing' : 'unknown', values: { ...current.values, ...(outcome === 'refused' ? { request: null } : {}) } };
      const saved = outcome === 'confirmed' ? options.store?.remove(current.id) : options.store?.save(next);
      if (entry?.id !== ticket.id || entry.attempt !== ticket.attempt) return;
      if (saved && outcome === 'confirmed') clear();
      else { entry = next; failed = !saved; needsWrite = !saved; if (saved) storedRevision = next.revision; }
      options.changed();
    },
    discard(): boolean {
      if (entry && persisted && (options.store?.get(entry.id)?.revision !== storedRevision || !options.store?.remove(entry.id))) {
        failed = true; options.changed(); return false;
      }
      clear(); return true;
    },
  };
};
