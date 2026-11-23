import { cleanRecentWorkRecord, type RecentWorkRecord, type RecentWorkRecords } from './recent-work-records.js';
import type { RecentSearchStorage } from './recent-searches.js';

export const PINNED_RECORD_LIMIT = 24;
const SIZE_LIMIT = 131_072;
export interface PinnedRecords extends RecentWorkRecords {
  has(kind: string, id: string): boolean;
  pin(record: RecentWorkRecord): boolean;
}
const clean = (input: unknown): RecentWorkRecord | null => {
  const record = cleanRecentWorkRecord(input);
  if (!record || 'origin' in record) return record;
  if (!Number.isSafeInteger(record.created_at) || record.created_at < 0) return null;
  const source = (input as { source_record_id?: unknown }).source_record_id;
  if (source !== null && (typeof source !== 'string' || !source || source.length > 2048 || /[\u0000-\u001f\u007f]/u.test(source))) return null;
  return { ...record, source_record_id: source };
};
export const pinnedRecordIdentity = (record: RecentWorkRecord): string => 'origin' in record
  ? JSON.stringify([record.kind, record.id, { ...record.origin, label: '' }])
  : JSON.stringify([record.kind, record.id, record.source_id, record.created_at, record.source_record_id ?? null]);

/** Device-local shortcuts. Only references and display labels survive a boot;
 * opening one still requires the current server to confirm its identity. */
export const createPinnedRecords = (opts: { scope: string; storage?: RecentSearchStorage | null }): PinnedRecords => {
  const key = 'recued.work.pinned.v1:' + encodeURIComponent(opts.scope);
  let storage = opts.storage;
  let unavailable = false;
  if (storage === undefined) { try { storage = globalThis.localStorage ?? null; unavailable = storage === null; } catch { storage = null; unavailable = true; } }
  let records: RecentWorkRecord[] = [];
  const same = (record: RecentWorkRecord, kind: string, id: string) => record.kind === kind && record.id === id;
  const refresh = (): void => { try {
    const raw = storage?.getItem(key), parsed: unknown = raw && raw.length <= SIZE_LIMIT ? JSON.parse(raw) : null;
    if (!storage) return;
    const next: RecentWorkRecord[] = [];
    if (Array.isArray(parsed)) for (const input of parsed.slice(0, 100)) {
      const record = clean(input);
      if (record && !next.some(row => same(row, record.kind, record.id))) next.push(record);
      if (next.length === PINNED_RECORD_LIMIT) break;
    }
    records = next;
  } catch { /* A bad shortcut list never blocks Data. */ } };
  refresh();
  const write = (next: RecentWorkRecord[]): boolean => {
    if (unavailable) return false;
    try {
      const value = JSON.stringify(next); if (value.length > SIZE_LIMIT) return false;
      if (next.length) storage?.setItem(key, value); else storage?.removeItem(key);
      records = next; return true;
    } catch { return false; }
  };
  return {
    list: () => { refresh(); return records.map(record => clean(record)!); },
    has: (kind, id) => records.some(row => same(row, kind, id)),
    pin(input) {
      refresh();
      const record = clean(input); if (!record) return false;
      const others = records.filter(row => !same(row, record.kind, record.id));
      if (others.length >= PINNED_RECORD_LIMIT) return false;
      return write([record, ...others]);
    },
    remember(input) {
      refresh();
      const record = clean(input); if (!record) return;
      const identity = pinnedRecordIdentity(record);
      const index = records.findIndex(row => pinnedRecordIdentity(row) === identity);
      if (index < 0 || JSON.stringify(records[index]) === JSON.stringify(record)) return;
      const next = [...records]; next[index] = record; write(next);
    },
    remove(kind, id) { refresh(); return write(records.filter(row => !same(row, kind, id))); },
    clear: () => write([]),
  };
};
