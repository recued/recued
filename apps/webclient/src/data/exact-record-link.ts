import { recordLink } from '../shell/record-link.js';
import { serializeShellRoute } from '../shell/route.js';
import { workReaderLink, type WorkReaderLink } from './task-note-source.js';
import { readWorkLinkPreview, type WorkLinkPreviewReaders, type WorkLinkPreviewResult } from './work-link-preview.js';

export const EXACT_LINK_OPEN_ACTION = 'universal-search-open-exact-link';
export const EXACT_LINK_RETRY_ACTION = 'universal-search-retry-exact-link';
export const EXACT_LINK_KEY_ATTR = 'data-exact-link-key';
export const RECORD_LINK_QUERY_LIMIT = 65_536;
export interface ExactRecordLinkMatch {
  key: string; target: WorkReaderLink; href: string; title: string; details: string[]; identity: string; routeAliases?: string[]; warning?: string;
}
export type ExactRecordLinkState = { state: 'loading' }
  | { state: 'ready'; match: ExactRecordLinkMatch }
  | { state: 'missing'; message: string }
  | { state: 'error' | 'invalid'; message: string };
export type RecordLinkQuery = { kind: 'text' } | { kind: 'invalid'; message: string } | { kind: 'link'; target: WorkReaderLink };
const looksLikeLink = (query: string) => /^(?:[a-z][a-z\d+.-]*:\/\/|https?:|mailto:|javascript:|data:|file:|\/\/|#data(?:\/|$))/iu.test(query.trim())
  || /^\/(?!\/)[^\s]*#data(?:\/|$)/u.test(query.trim());
export const limitRecordLinkQuery = (query: string) => query.slice(0, looksLikeLink(query) ? RECORD_LINK_QUERY_LIMIT + 1 : 200);

/** Only exact links in this deployment reach a saved-record reader. URL-like
 * input never falls through to broad search or an external fetch. */
export const parseRecordLinkQuery = (query: string, clientHref: string): RecordLinkQuery => {
  const value = query.trim(); if (!looksLikeLink(value)) return { kind: 'text' };
  const invalid: RecordLinkQuery = { kind: 'invalid', message: 'Paste a Contact, Task, Note, Commitment, Booking, Project, Mail, or Calendar record link from this Recued app.' };
  if (value.length > RECORD_LINK_QUERY_LIMIT) return invalid;
  const target = workReaderLink(value, clientHref);
  if (!target || ('id' in target ? target.id.length > 2048 : target.collectionSlug.length > 2048 || target.recordId.length > 2048)) return invalid;
  return { kind: 'link', target };
};
export const exactRecordNoun = (target: WorkReaderLink) => target.tab === 'mail' ? 'email' : target.tab === 'calendar' ? 'event' : target.tab;

/** Project through the existing reader, retaining only bounded labels and a
 * lifetime token. Bodies and pairing parameters never enter lookup state. */
export const readExactRecordLink = async (target: WorkReaderLink, readers: WorkLinkPreviewReaders, clientHref: string, onPreview?: (result: Extract<WorkLinkPreviewResult, { state: 'ready' }>) => void): Promise<Exclude<ExactRecordLinkState, { state: 'loading' | 'error' | 'invalid' }>> => {
  let identity: string | undefined, canonical = target, merged = false, routeAliases: string[] | undefined;
  const result = await readWorkLinkPreview(target, {
    ...(readers.work ? { work: async (kind: 'task' | 'note' | 'commitment' | 'booking' | 'project', id: string) => {
      const reply = await readers.work!(kind, id), entity = reply.entity;
      if (entity && Number.isSafeInteger(entity.created_at)) identity = JSON.stringify([kind, entity.id, entity.source_id, entity.source_record_id ?? null, entity.created_at]);
      return reply;
    } } : {}),
    ...(readers.contact ? { contact: async (id: string) => {
      const reply = await readers.contact!(id), contact = reply.contact;
      if (contact && Number.isSafeInteger(contact.created_at)) {
        routeAliases = [serializeShellRoute('data', 'contact', contact.email)];
        identity = JSON.stringify(['contact', contact.contact_id ?? contact.email, contact.created_at]); merged = contact.merged_into !== undefined;
        if (contact.contact_id) canonical = { tab: 'contact', id: contact.contact_id, hash: serializeShellRoute('data', 'contact', contact.contact_id) };
      }
      return reply;
    } } : {}),
    ...(readers.source ? { source: async (args: Parameters<NonNullable<WorkLinkPreviewReaders['source']>>[0]) => {
      const reply = await readers.source!(args), record = reply.record;
      if (record && Number.isSafeInteger(record.received_at)) identity = JSON.stringify([args.platform, args.slug, record.record_id, record.source_id ?? null, record.received_at]);
      return reply;
    } } : {}),
  });
  if (result.state !== 'ready') return result;
  if (merged) return { state: 'missing', message: 'This contact has been merged. Find the current contact by name.' };
  const href = recordLink(clientHref, canonical.hash);
  if (!identity || !href) throw new Error('Record identity could not be checked.');
  onPreview?.(result);
  const key = JSON.stringify(['exact', canonical.hash, identity]);
  return { state: 'ready', match: { key, target: canonical, href, title: result.title,
    details: [canonical.tab === 'mail' ? 'Email' : canonical.tab === 'calendar' ? 'Event' : canonical.tab[0]!.toUpperCase() + canonical.tab.slice(1), ...result.details],
    identity, ...(routeAliases ? { routeAliases } : {}), ...(result.warning ? { warning: result.warning } : {}) } };
};

/** A successful lookup is not a lasting existence check. Refuse a record that
 * disappeared or reused its address while the owner was choosing a result. */
export const verifyExactRecordLink = async (match: ExactRecordLinkMatch, readers: WorkLinkPreviewReaders, clientHref: string) => {
  const current = await readExactRecordLink(match.target, readers, clientHref);
  return current.state === 'ready' && current.match.target.hash === match.target.hash && current.match.identity === match.identity;
};
