import { checkDraftOrigin } from './draft-origin.js';
import { pinnedRecordIdentity } from './pinned-records.js';
import type { RecentWorkRecord, RecentWorkRecords } from './recent-work-records.js';
import type { LinkKind, LinkOption } from './record-link-insert.js';
import { serializeShellRoute, serializeSourceRecordAddress } from '../shell/route.js';
import type { WorkLinkPreviewReaders } from './work-link-preview.js';

export interface RecordLinkShortcutGroup { label: 'Pinned' | 'Recently opened'; options: LinkOption[] }
export type RecordLinkShortcutReaders = WorkLinkPreviewReaders & Pick<Parameters<typeof checkDraftOrigin>[1], 'mail' | 'calendar'>;

/** Reuse the pairing-scoped lists. This does not read a record, write history,
 * or copy bodies into picker state. Distinct incarnations stay distinct. */
export const recordLinkShortcuts = (deps: {
  pinned?: Pick<RecentWorkRecords, 'list'>; recent?: Pick<RecentWorkRecords, 'list'>;
  kinds: readonly LinkKind[]; filter: LinkKind | 'all'; current?: { kind: 'note' | 'task'; id?: string };
}): RecordLinkShortcutGroup[] => {
  const seen: RecentWorkRecord[] = [];
  return ([['Pinned', deps.pinned], ['Recently opened', deps.recent]] as const).flatMap(([label, store]) => {
    const options: LinkOption[] = [];
    for (const record of store?.list() ?? []) {
      if (!deps.kinds.includes(record.kind) || deps.filter !== 'all' && record.kind !== deps.filter
        || record.kind === deps.current?.kind && record.id === deps.current.id) continue;
      const identity = pinnedRecordIdentity(record);
      // History lacks a provider row key. Prefer the stronger pin for the same
      // observed lifetime rather than offering a second, weaker activation.
      if (seen.some(prior => pinnedRecordIdentity(prior) === identity || !('origin' in prior) && !('origin' in record)
        && prior.kind === record.kind && prior.id === record.id && prior.source_id === record.source_id && prior.created_at === record.created_at
        && (!Object.hasOwn(prior, 'source_record_id') || !Object.hasOwn(record, 'source_record_id')))) continue;
      seen.push(record);
      const source = 'origin' in record ? record.origin : null;
      const target = source && (source.kind === 'mail' || source.kind === 'calendar')
        ? { tab: source.kind, collectionSlug: source.slug, recordId: source.recordId, hash: serializeSourceRecordAddress({ tab: source.kind, collectionSlug: source.slug, recordId: source.recordId }) }
        : { tab: record.kind as 'note' | 'task' | 'contact', id: record.id, hash: serializeShellRoute('data', record.kind, record.id) };
      const account = source && (source.kind === 'mail' || source.kind === 'calendar') ? source.slug : undefined;
      const noun = record.kind === 'mail' ? 'Email' : record.kind === 'calendar' ? 'Event' : record.kind === 'contact' ? 'Contact' : record.kind === 'task' ? 'Task' : 'Note';
      options.push({ key: JSON.stringify(['shortcut', label, identity]), target, shortcut: record, title: record.title,
        detail: [noun, ...(record.source_label !== account ? [record.source_label] : []), ...(account ? ['Account: ' + account] : [])].join(' · ') });
    }
    return options.length ? [{ label, options }] : [];
  });
};

/** Shortcuts are discovery hints. Use the same identity checks as opening them
 * from universal search, including account incarnations and pinned row keys. */
export const verifyRecordLinkShortcut = async (record: RecentWorkRecord, readers: RecordLinkShortcutReaders): Promise<boolean> => {
  if ('origin' in record) {
    const checked = await checkDraftOrigin(record.origin, { contact: readers.contact, mail: readers.mail, calendar: readers.calendar });
    if (checked.kind !== record.kind) return false;
    if (record.origin.kind === 'mail') {
      if (!readers.source) return false;
      const { record: current } = await readers.source({ platform: 'mail', slug: record.origin.slug, record_id: record.origin.recordId });
      return !!current && current.record_id === record.origin.recordId && current.received_at === record.origin.receivedAt;
    }
    return true;
  }
  if (!readers.work) return false;
  const { entity } = await readers.work(record.kind, record.id);
  return !!entity && entity._kind === record.kind && entity.id === record.id && entity.source_id === record.source_id
    && entity.created_at === record.created_at && entity.deleted_at == null && entity.sync_state !== 'tombstoned' && entity.sync_state !== 'orphaned'
    && (!Object.hasOwn(record, 'source_record_id') || (entity.source_record_id ?? null) === (record.source_record_id ?? null));
};
