import { CHAT_MAIL_REFS_MAX } from '@recued/contracts';

import { serializeShellRoute, serializeSourceRecordAddress } from '../shell/route.js';
import { RECORD_LINK_SELECTION_LIMIT, type PreparedRecordLink } from '../data/record-link-insert.js';
import { cleanRecentWorkRecord } from '../data/recent-work-records.js';
import { assetRecordIdentity, verifyExactRecordLink } from '../data/exact-record-link.js';
import type { RecordLinkTarget } from '../data/work-link-preview.js';
import { verifyRecordLinkShortcut, type RecordLinkShortcutReaders } from '../data/record-link-shortcuts.js';

const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\u0000-\u001f\u007f]/u.test(value);
const time = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const ASSET_LABEL = 'Selected asset';

const cleanShortcut = (value: unknown) => {
  const record = cleanRecentWorkRecord(value), raw = object(value);
  if (!record || 'origin' in record || !raw || !Object.hasOwn(raw, 'source_record_id')) return record;
  const source = raw.source_record_id;
  if (source !== null && !id(source)) return null;
  return { ...record, source_record_id: source as string | null };
};

export const copySelectedRecords = (records: readonly PreparedRecordLink[] = []): PreparedRecordLink[] => records.map(({ reference, shortcut }) => ({
  reference: { ...reference, target: { ...reference.target }, details: [...reference.details], ...(reference.routeAliases ? { routeAliases: [...reference.routeAliases] } : {}) },
  ...(shortcut ? { shortcut: cleanShortcut(shortcut)! } : {}),
}));

const shortcutMatches = (selection: PreparedRecordLink): boolean => {
  const { shortcut, reference: { target } } = selection; if (!shortcut) return true;
  if (shortcut.kind !== target.tab) return false;
  if (!('origin' in shortcut)) return 'id' in target && shortcut.id === target.id;
  const origin = shortcut.origin;
  return origin.kind === 'contact' ? 'id' in target && origin.id === target.id
    : !('id' in target) && origin.slug === target.collectionSlug && origin.recordId === target.recordId;
};

/** Wire context contains bounded labels and exact references. Saved bodies are
 * read through the ordinary governed readers, not copied into a chat draft. */
export const selectedRecordsWire = (records: readonly PreparedRecordLink[]): string => {
  if (!records.length || records.length > RECORD_LINK_SELECTION_LIMIT) throw new Error('Choose between 1 and 20 records.');
  const rows = records.map(selection => {
    const ref = selection.reference, token: unknown = JSON.parse(ref.identity);
    if (!Array.isArray(token)) throw new Error('This selected record could not be confirmed. Choose it again.');
    const kind = ref.target.tab;
    const record = kind === 'contact' || kind === 'asset' ? { kind, id: 'id' in ref.target ? ref.target.id : '', created_at: token[2] }
      : kind === 'task' || kind === 'note' || kind === 'commitment' || kind === 'booking' || kind === 'project' ? { kind, id: 'id' in ref.target ? ref.target.id : '', source_id: token[2], source_record_id: token[3], created_at: token[4] }
      : { kind, slug: 'collectionSlug' in ref.target ? ref.target.collectionSlug : '', record_id: 'recordId' in ref.target ? ref.target.recordId : '', source_id: token[3], received_at: token[4] };
    const shortcut = selection.shortcut ? cleanShortcut(selection.shortcut) : undefined;
    if (selection.shortcut && !shortcut) throw new Error('This selected record could not be confirmed. Choose it again.');
    // Yours labels can themselves be private. Resolve the asset through the
    // governed reader instead of disclosing its name in the message.
    return { record, title: kind === 'asset' ? ASSET_LABEL : ref.title, ...(shortcut ? { shortcut } : {}) };
  });
  const wire = JSON.stringify(rows);
  const checked = readSelectedRecordsWire(wire);
  if (wire.length > 65_536 || !checked || checked.some((row, index) => row.reference.identity !== records[index]!.reference.identity || row.reference.target.hash !== records[index]!.reference.target.hash)) throw new Error('These selected record references could not be included. Remove them and choose them again, or choose fewer records.');
  return wire;
};

export const readSelectedRecordsWire = (wire: unknown): PreparedRecordLink[] | null => {
  if (typeof wire !== 'string' || wire.length > 65_536) return null;
  try {
    const rows: unknown = JSON.parse(wire); if (!Array.isArray(rows) || !rows.length || rows.length > RECORD_LINK_SELECTION_LIMIT) return null;
    const records: PreparedRecordLink[] = [], hashes = new Set<string>();
    for (const raw of rows) {
      const row = object(raw), record = object(row?.record);
      if (!row || !record || typeof row.title !== 'string' || !row.title.trim() || row.title.length > 480) return null;
      let target: RecordLinkTarget, identity: string;
      if (record.kind === 'asset') {
        if (!id(record.id) || !time(record.created_at) || row.title !== ASSET_LABEL) return null;
        target = { tab: 'asset', id: record.id, hash: serializeShellRoute('yours', 'asset', record.id) };
        identity = assetRecordIdentity(record.id, record.created_at);
      } else if (record.kind === 'contact') {
        if (!id(record.id) || !time(record.created_at)) return null;
        target = { tab: 'contact', id: record.id, hash: serializeShellRoute('data', 'contact', record.id) };
        identity = JSON.stringify(['contact', record.id, record.created_at]);
      } else if (record.kind === 'task' || record.kind === 'note' || record.kind === 'commitment' || record.kind === 'booking' || record.kind === 'project') {
        if (!id(record.id) || !id(record.source_id) || record.source_record_id !== null && !id(record.source_record_id) || !time(record.created_at)) return null;
        target = { tab: record.kind, id: record.id, hash: serializeShellRoute('data', record.kind, record.id) };
        identity = JSON.stringify([record.kind, record.id, record.source_id, record.source_record_id, record.created_at]);
      } else if (record.kind === 'mail' || record.kind === 'calendar') {
        if (!id(record.slug) || !id(record.record_id) || record.source_id !== null && !id(record.source_id) || !time(record.received_at)) return null;
        target = { tab: record.kind, collectionSlug: record.slug, recordId: record.record_id, hash: serializeSourceRecordAddress({ tab: record.kind, collectionSlug: record.slug, recordId: record.record_id }) };
        identity = JSON.stringify([record.kind, record.slug, record.record_id, record.source_id, record.received_at]);
      } else return null;
      if (hashes.has(target.hash)) return null; hashes.add(target.hash);
      const shortcut = row.shortcut === undefined ? undefined : cleanShortcut(row.shortcut);
      if (row.shortcut !== undefined && !shortcut) return null;
      const selection: PreparedRecordLink = { reference: { key: JSON.stringify(['exact', target.hash, identity]), target, identity, href: target.hash, title: row.title, details: ['id' in target ? target.tab[0]!.toUpperCase() + target.tab.slice(1) : 'Account: ' + target.collectionSlug] }, ...(shortcut ? { shortcut } : {}) };
      if (!shortcutMatches(selection)) return null; records.push(selection);
    }
    return records;
  } catch { return null; }
};

export const verifySelectedRecord = async (record: PreparedRecordLink, readers: RecordLinkShortcutReaders, href: string): Promise<boolean> =>
  shortcutMatches(record) && (!record.shortcut || await verifyRecordLinkShortcut(record.shortcut, readers)) && await verifyExactRecordLink(record.reference, readers, href);

/** D-406 slice 2 — the emails among the records the owner added to a message, as `chat.send`'s `mail_refs`:
 *  each mailbox and record once, in the order added, the first {@link CHAT_MAIL_REFS_MAX}. The server reads those
 *  with `mail.read` before the turn's first round, with each one's place in its thread; any beyond them stay the
 *  references the message already carries, which the model reads itself. A server from before D-406 ignores
 *  `mail_refs` and answers from the references alone, as it did. */
export const pickedMailRefsOf = (records: readonly PreparedRecordLink[]): Array<{ slug: string; record_id: string }> => {
  const refs: Array<{ slug: string; record_id: string }> = [];
  const seen = new Set<string>();
  for (const { reference: { target } } of records) {
    if (refs.length >= CHAT_MAIL_REFS_MAX) break;
    if (target.tab !== 'mail') continue;
    const key = JSON.stringify([target.collectionSlug, target.recordId]);
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ slug: target.collectionSlug, record_id: target.recordId });
  }
  return refs;
};
