import type { CalendarEventRef, CalendarEventSnapshot, ContactAdditionalIdentifiers, ContactRecord,
  MailMessageRef, MailMessageSnapshot, WorkEntity, WorkEntityGetRpcResponse } from '@recued/contracts';
import { serializeShellRoute, serializeSourceRecordAddress } from '../shell/route.js';

/** Navigation context only. Draft values, destinations and write authority are
 * checked separately by the existing editors. Never infer this from draft text. */
export type DraftOrigin = { label: string } & (
  | { kind: 'contact'; id: string; createdAt: number }
  | { kind: 'note'; id: string; sourceId: string; sourceRecordId: string | null; createdAt: number }
  | { kind: 'mail'; slug: string; recordId: string; receivedAt: number; identity: string | null; conversation?: { thread_id: string | null; incarnation: string } }
  | { kind: 'calendar'; slug: string; recordId: string; sourceId: string; receivedAt: number; incarnation: string | null }
);
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\u0000-\u001f\u007f]/u.test(value);
const time = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const nullableId = (value: unknown): value is string | null => value === null || id(value);
const label = (value: string) => Array.from(value.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim()).slice(0, 256).join('');

/** Bad optional metadata cannot make otherwise valid draft text unrecoverable. */
export const readDraftOrigin = (input: unknown): DraftOrigin | undefined => {
  const row = object(input);
  if (!row || typeof row.label !== 'string' || !row.label.trim() || row.label.length > 512 || /[\u0000-\u001f\u007f]/u.test(row.label)) return;
  const title = label(row.label);
  if (row.kind === 'contact' && id(row.id) && time(row.createdAt)) return { kind: row.kind, id: row.id, createdAt: row.createdAt, label: title };
  if (row.kind === 'note' && id(row.id) && id(row.sourceId) && nullableId(row.sourceRecordId) && time(row.createdAt))
    return { kind: row.kind, id: row.id, sourceId: row.sourceId, sourceRecordId: row.sourceRecordId, createdAt: row.createdAt, label: title };
  if (row.kind === 'mail' && id(row.slug) && id(row.recordId) && time(row.receivedAt) && nullableId(row.identity)) {
    const scope = object(row.conversation);
    if (row.conversation !== undefined && (!scope || !nullableId(scope.thread_id) || !id(scope.incarnation))) return;
    return { kind: row.kind, slug: row.slug, recordId: row.recordId, receivedAt: row.receivedAt, identity: row.identity, label: title,
      ...(scope ? { conversation: { thread_id: scope.thread_id as string | null, incarnation: scope.incarnation as string } } : {}) };
  }
  if (row.kind === 'calendar' && id(row.slug) && id(row.recordId) && id(row.sourceId) && time(row.receivedAt) && nullableId(row.incarnation))
    return { kind: row.kind, slug: row.slug, recordId: row.recordId, sourceId: row.sourceId, receivedAt: row.receivedAt, incarnation: row.incarnation, label: title };
};
export const contactDraftOrigin = (contact: ContactRecord) => readDraftOrigin({ kind: 'contact', id: contact.contact_id,
  createdAt: contact.created_at, label: label(contact.name?.trim() || contact.email) });
export const noteDraftOrigin = (note: Extract<WorkEntity, { _kind: 'note' }>) => readDraftOrigin({ kind: 'note', id: note.id,
  sourceId: note.source_id, sourceRecordId: note.source_record_id ?? null, createdAt: note.created_at, label: label(note.title?.trim() || 'Untitled note') });
export const mailDraftOrigin = (message: MailMessageSnapshot) => readDraftOrigin({ kind: 'mail', slug: message.slug, recordId: message.record_id,
  receivedAt: message.received_at, identity: message.state?.identity ?? null, label: label(message.subject.trim() || 'Email'),
  ...(message.conversation ? { conversation: message.conversation } : {}) });
export const calendarDraftOrigin = (ref: CalendarEventRef, snapshot: CalendarEventSnapshot) => readDraftOrigin({ kind: 'calendar',
  slug: ref.slug, recordId: snapshot.record.record_id, sourceId: snapshot.event.source_id, receivedAt: snapshot.record.received_at,
  incarnation: snapshot.incarnation, label: label(snapshot.event.summary.trim() || 'Calendar event') });
export const draftOriginNoun = (origin: DraftOrigin) => origin.kind === 'mail' ? 'email' : origin.kind === 'calendar' ? 'event' : origin.kind;
export const draftOriginHash = (origin: DraftOrigin): string => origin.kind === 'contact' || origin.kind === 'note'
  ? serializeShellRoute('data', origin.kind, origin.id)
  : serializeSourceRecordAddress({ tab: origin.kind, collectionSlug: origin.slug, recordId: origin.recordId });

type ContactReply = { contact: ContactRecord | null; identifiers?: ContactAdditionalIdentifiers };
export type CheckedDraftOrigin =
  | { kind: 'contact'; reply: ContactReply & { contact: ContactRecord } }
  | { kind: 'note'; reply: WorkEntityGetRpcResponse & { entity: Extract<WorkEntity, { _kind: 'note' }> } }
  | { kind: 'mail'; message: MailMessageSnapshot }
  | { kind: 'calendar'; snapshot: CalendarEventSnapshot };
export const checkDraftOrigin = async (origin: DraftOrigin, callers: {
  contact?: (id: string) => Promise<ContactReply>;
  note?: (id: string) => Promise<WorkEntityGetRpcResponse>;
  mail?: (ref: MailMessageRef) => Promise<MailMessageSnapshot>;
  calendar?: (ref: CalendarEventRef) => Promise<CalendarEventSnapshot>;
}): Promise<CheckedDraftOrigin> => {
  const unavailable = () => new Error(`The original ${draftOriginNoun(origin)} is unavailable or has a different identity. Your draft is still here.`);
  if (origin.kind === 'contact' && callers.contact) {
    const reply = await callers.contact(origin.id), contact = reply.contact;
    if (!contact || contact.contact_id !== origin.id || contact.created_at !== origin.createdAt || contact.merged_into !== undefined) throw unavailable();
    return { kind: origin.kind, reply: { ...reply, contact } };
  }
  if (origin.kind === 'note' && callers.note) {
    const reply = await callers.note(origin.id), entity = reply.entity;
    if (entity?._kind !== 'note' || entity.id !== origin.id || entity.source_id !== origin.sourceId
      || (entity.source_record_id ?? null) !== origin.sourceRecordId || entity.created_at !== origin.createdAt || entity.deleted_at != null) throw unavailable();
    return { kind: origin.kind, reply: { ...reply, entity } };
  }
  if (origin.kind === 'mail' && callers.mail) {
    const message = await callers.mail({ slug: origin.slug, record_id: origin.recordId, ...(origin.conversation ? { conversation: origin.conversation } : {}) });
    if (!message || message.slug !== origin.slug || message.record_id !== origin.recordId || message.received_at !== origin.receivedAt
      || origin.identity !== null && message.state?.identity !== origin.identity
      || origin.conversation && (message.conversation?.incarnation !== origin.conversation.incarnation || message.conversation.thread_id !== origin.conversation.thread_id)) throw unavailable();
    return { kind: origin.kind, message };
  }
  if (origin.kind === 'calendar' && callers.calendar) {
    const snapshot = await callers.calendar({ slug: origin.slug, source_id: origin.sourceId });
    if (!snapshot || snapshot.record.record_id !== origin.recordId || snapshot.event.record_id !== origin.recordId || snapshot.event.source_id !== origin.sourceId
      || snapshot.record.source_id !== origin.sourceId || snapshot.record.received_at !== origin.receivedAt || snapshot.incarnation !== origin.incarnation) throw unavailable();
    return { kind: origin.kind, snapshot };
  }
  throw unavailable();
};
