import { readDraftOrigin } from './draft-origin.js';
import type { Note } from '@recued/contracts';
import { createDraftCheckpoint, createDraftRecoveryStore, type DraftRecoveryEntry, type DraftRecoveryStorage, type DraftRecoveryTicket } from './draft-recovery.js';

export interface NoteRecoveryStorage extends DraftRecoveryStorage {}
export const NOTE_DRAFT_RELATIONS = ['related_contact', 'related_calendar_event', 'related_mail_thread', 'related_project'] as const;
export type NoteDraftValues = { title: string; body: string } & Record<typeof NOTE_DRAFT_RELATIONS[number], string[]>;
export interface NoteDraftOriginal {
  id: string; sourceId: string; sourceRecordId: string | null; createdAt: number; updatedAt: number; values: NoteDraftValues; editRevision?: string;
}
export interface NoteRecoveryEntry extends DraftRecoveryEntry<NoteDraftValues, NoteDraftOriginal> {}
export const NOTE_RECOVERY_LIMITS = { entries: 8, entryBytes: 512 * 1024, bytes: 2 * 1024 * 1024, age: 7 * 86_400_000 } as const;
const PREFIX = 'recued.note.draft-recovery.v1:';
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown, max = 100_000): value is string => typeof value === 'string' && value.length <= max;
const identifier = (value: unknown): value is string => text(value, 2048) && value.length > 0;
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Only note text and canonical relationship choices cross the storage boundary.
 * Stored data is never an upsert request or authority to edit a source. */
export const noteDraftValues = (values: Readonly<Record<string, unknown>>): NoteDraftValues => ({
  title: typeof values.title === 'string' ? values.title : '',
  body: typeof values.body === 'string' ? values.body : '',
  ...Object.fromEntries(NOTE_DRAFT_RELATIONS.map(key => [key, Array.isArray(values[key])
    ? values[key].filter((value): value is string => typeof value === 'string' && value.length > 0) : []])),
}) as NoteDraftValues;
const parseValues = (input: unknown): NoteDraftValues | null => {
  const values = object(input);
  if (!values || !text(values.title, 2048) || !text(values.body)
    || NOTE_DRAFT_RELATIONS.some(key => !Array.isArray(values[key]) || values[key].length > 100
      || !values[key].every(identifier))) return null;
  return noteDraftValues(values);
};
export const noteDraftOriginal = (note: Note): NoteDraftOriginal => ({
  id: note.id, sourceId: note.source_id, sourceRecordId: note.source_record_id ?? null,
  createdAt: note.created_at, updatedAt: note.updated_at,
  values: noteDraftValues({ title: note.title, body: note.body,
    ...Object.fromEntries(NOTE_DRAFT_RELATIONS.map(key => [key, note[`${key}_ids`]])) }),
});
const sameValues = (a: NoteDraftValues, b: NoteDraftValues) => a.title === b.title && a.body === b.body
  && NOTE_DRAFT_RELATIONS.every(key => JSON.stringify([...a[key]].sort()) === JSON.stringify([...b[key]].sort()));
export const noteDraftMatchesOriginal = (original: NoteDraftOriginal, note: Note): boolean => {
  const current = noteDraftOriginal(note);
  return original.id === current.id && original.sourceId === current.sourceId && original.sourceRecordId === current.sourceRecordId
    && original.createdAt === current.createdAt && original.updatedAt === current.updatedAt && sameValues(original.values, current.values);
};
export const parseNoteRecovery = (input: unknown, now: number): NoteRecoveryEntry | null => {
  const row = object(input), values = parseValues(row?.values), original = object(row?.original);
  if (!row || !values || !text(row.id, 80) || !/^ndr_[0-9a-f-]{36}$/.test(row.id)
    || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1 || !identifier(row.sourceId)
    || !timestamp(row.updatedAt) || row.updatedAt < now - NOTE_RECOVERY_LIMITS.age || row.updatedAt > now + 60_000
    || !['editing', 'pending', 'unknown'].includes(String(row.status))
    || row.attempt !== undefined && (!text(row.attempt, 80) || !/^[0-9a-f-]{36}$/.test(row.attempt))
    || row.status !== 'editing' && !row.attempt || row.savedId !== undefined && !identifier(row.savedId)) return null;
  let base: NoteDraftOriginal | null = null;
  if (row.original !== null) {
    const baseValues = parseValues(original?.values);
    if (!original || !baseValues || !identifier(original.id) || original.sourceId !== row.sourceId
      || original.sourceRecordId !== null && !identifier(original.sourceRecordId)
      || original.editRevision !== undefined && (typeof original.editRevision !== 'string' || !/^[a-f0-9]{64}$/u.test(original.editRevision))
      || !timestamp(original.createdAt) || !timestamp(original.updatedAt)) return null;
    base = { id: original.id, sourceId: row.sourceId, sourceRecordId: original.sourceRecordId as string | null,
      createdAt: original.createdAt, updatedAt: original.updatedAt, values: baseValues,
      ...(typeof original.editRevision === 'string' ? { editRevision: original.editRevision } : {}) };
  }
  const origin = base === null ? readDraftOrigin(row.origin) : undefined;
  return { id: row.id, revision: Number(row.revision), updatedAt: row.updatedAt, sourceId: row.sourceId, values, original: base,
    ...(origin ? { origin } : {}), status: row.status as NoteRecoveryEntry['status'], ...(row.attempt ? { attempt: row.attempt as string } : {}),
    ...(row.savedId ? { savedId: row.savedId as string } : {}) };
};
export const createNoteRecoveryStore = (opts: { scope: string; storage?: NoteRecoveryStorage | null; now?: () => number }) =>
  createDraftRecoveryStore({ ...opts, key: PREFIX + encodeURIComponent(opts.scope), limits: NOTE_RECOVERY_LIMITS, parse: parseNoteRecovery });
export type NoteRecoveryStore = ReturnType<typeof createNoteRecoveryStore>;
export interface NoteRecoveryTicket extends DraftRecoveryTicket {}
export const createNoteDraftCheckpoint = (opts: { store?: NoteRecoveryStore; now?: () => number; changed?: () => void }) =>
  createDraftCheckpoint({ ...opts, values: noteDraftValues, same: sameValues, idPrefix: 'ndr_', label: 'note', initialMessage: 'Unfinished notes are kept in this tab.' });
