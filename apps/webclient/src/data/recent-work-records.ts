import type { WorkEntity } from '@recued/contracts';
import type { RecentSearchStorage } from './recent-searches.js';
import { readDraftOrigin, type DraftOrigin } from './draft-origin.js';

export interface RecentWorkEntityRecord {
  kind: 'task' | 'note'; id: string; title: string;
  source_id: string; source_label: string; created_at: number; source_record_id?: string | null;
}
export type RecentSourceOrigin = Extract<DraftOrigin, { kind: 'contact' | 'mail' | 'calendar' }>;
export interface RecentSourceRecord {
  kind: RecentSourceOrigin['kind']; id: string; title: string; source_label: string; origin: RecentSourceOrigin;
}
export type RecentWorkRecord = RecentWorkEntityRecord | RecentSourceRecord;
const sourceId = (origin: RecentSourceOrigin) => origin.kind === 'contact' ? origin.id : JSON.stringify([origin.slug, origin.recordId]);
export const recentSourceRecord = (origin: DraftOrigin | undefined, sourceLabel: string): RecentSourceRecord | undefined => {
  if (!origin || origin.kind === 'note') return;
  return { kind: origin.kind, id: sourceId(origin), title: origin.label, source_label: sourceLabel, origin };
};
export const recentRecordNoun = (kind: RecentWorkRecord['kind']) => kind === 'mail' ? 'email' : kind === 'calendar' ? 'event' : kind;
export interface RecentWorkRecords {
  list(): readonly RecentWorkRecord[];
  remember(record: RecentWorkRecord): void;
  remove(kind: RecentWorkRecord['kind'], id: string): boolean;
  clear(): boolean;
}
export const recentWorkRecord = (entity: Extract<WorkEntity, { _kind: 'task' | 'note' }>, sourceLabel: string): RecentWorkEntityRecord => ({
  kind: entity._kind, id: entity.id, title: entity.title?.trim() || (entity._kind === 'task' ? 'Task' : 'Note'),
  source_id: entity.source_id, source_label: sourceLabel, created_at: entity.created_at,
});
const text = (value: unknown, limit: number): string => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, limit) : '';
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\u0000-\u001f\u007f]/u.test(value);
export const cleanRecentWorkRecord = (value: unknown): RecentWorkRecord | null => {
  if (!value || typeof value !== 'object') return null;
  const row = value as Omit<Partial<RecentWorkEntityRecord>, 'kind'> & { kind?: string; origin?: unknown };
  if (row.kind === 'contact' || row.kind === 'mail' || row.kind === 'calendar') {
    const origin = readDraftOrigin(row.origin);
    if (!origin || origin.kind !== row.kind || row.id !== sourceId(origin)) return null;
    return { kind: origin.kind, id: sourceId(origin), title: text(row.title, 480) || origin.label,
      source_label: text(row.source_label, 160) || 'Source unavailable', origin };
  }
  if ((row.kind !== 'task' && row.kind !== 'note') || !identifier(row.id) || !identifier(row.source_id)
    || typeof row.created_at !== 'number' || !Number.isFinite(row.created_at)) return null;
  return { kind: row.kind, id: row.id, title: text(row.title, 480) || (row.kind === 'task' ? 'Task' : 'Note'),
    source_id: row.source_id, source_label: text(row.source_label, 160) || 'Source unavailable', created_at: row.created_at };
};
const same = (a: Pick<RecentWorkRecord, 'kind' | 'id'>, b: Pick<RecentWorkRecord, 'kind' | 'id'>) => a.kind === b.kind && a.id === b.id;

/** Bounded record references and display labels, scoped to one pairing in this
 * tab. Readers always fetch the current record before opening it. */
export const createRecentWorkRecords = (opts: { scope: string; storage?: RecentSearchStorage | null }): RecentWorkRecords => {
  const key = 'recued.work.recent.v1:' + encodeURIComponent(opts.scope);
  let storage = opts.storage;
  if (storage === undefined) { try { storage = globalThis.sessionStorage; } catch { storage = null; } }
  let records: RecentWorkRecord[] = [];
  try {
    const raw = storage?.getItem(key), parsed: unknown = raw && raw.length <= 65_536 ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) for (const item of parsed.slice(0, 100)) {
      const row = cleanRecentWorkRecord(item);
      if (row && !records.some(previous => same(previous, row))) records.push(row);
      if (records.length === 8) break;
    }
  } catch { /* History never prevents navigation when storage is unavailable. */ }
  const write = (next: RecentWorkRecord[]): boolean => {
    try { if (next.length) storage?.setItem(key, JSON.stringify(next)); else storage?.removeItem(key); return true; }
    catch { return false; }
  };
  return {
    list: () => records.map(record => cleanRecentWorkRecord(record)!),
    remember(record) {
      const row = cleanRecentWorkRecord(record); if (!row) return;
      records = [row, ...records.filter(previous => !same(previous, row))].slice(0, 8);
      while (JSON.stringify(records).length > 65_536) records.pop();
      write(records);
    },
    remove(kind, id) {
      const next = records.filter(record => !same(record, { kind, id }));
      if (!write(next)) return false;
      records = next; return true;
    },
    clear() { if (!write([])) return false; records = []; return true; },
  };
};
