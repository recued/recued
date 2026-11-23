import type { WorkEntity } from '@recued/contracts';
import type { RecentSearchStorage } from './recent-searches.js';

export type ReadingEntity = Extract<WorkEntity, { _kind: 'task' | 'note' }>;
export type ReadingFormat = 'plain' | 'formatted';
export interface SavedReadingPosition {
  top: number; outlineTop: number; sections: [string, boolean][];
  anchor?: { index: number; offset: number };
}
export interface ReaderFindState { open: boolean; query: string; active: number }
export interface ReaderSnapshot { format: ReadingFormat; positions: Partial<Record<ReadingFormat, SavedReadingPosition>> }
export interface SavedReaderState extends ReaderSnapshot { find: ReaderFindState }
export interface ReadingRecord {
  kind: 'task' | 'note'; id: string; sourceId: string; sourceRecordId: string | null; createdAt: number; contentKey: string;
}
export interface ReaderStateStore { get(record: ReadingRecord): SavedReaderState | undefined; set(record: ReadingRecord, state: SavedReaderState): void }
const identity = (record: ReadingRecord) => JSON.stringify([record.kind, record.id, record.sourceId, record.sourceRecordId, record.createdAt]);
export const sameReadingIdentity = (first: ReadingRecord, second: ReadingRecord): boolean => identity(first) === identity(second);

/** A content revision hint, not an authority or identity check. Never retain
 * the text itself, a heading label, a body link or a focus selector. */
export const readingRecord = (entity: ReadingEntity): ReadingRecord => {
  const title = entity.title ?? '', body = entity.body ?? '';
  let first = 2166136261, second = 5381;
  for (const value of [title, body]) for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index); first = Math.imul(first ^ code, 16777619); second = Math.imul(second, 33) ^ code;
  }
  return { kind: entity._kind, id: entity.id, sourceId: entity.source_id, sourceRecordId: entity.source_record_id ?? null, createdAt: entity.created_at,
    contentKey: `${title.length}:${body.length}:${(first >>> 0).toString(16).padStart(8, '0')}:${(second >>> 0).toString(16).padStart(8, '0')}` };
};
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\u0000-\u001f\u007f]/u.test(value);
const bounded = (value: unknown, low: number, high: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high;
const cleanRecord = (input: unknown): ReadingRecord | undefined => {
  const row = object(input);
  if (!row || row.kind !== 'task' && row.kind !== 'note' || !id(row.id) || !id(row.sourceId) || row.sourceRecordId !== null && !id(row.sourceRecordId)
    || !Number.isSafeInteger(row.createdAt) || (row.createdAt as number) < 0 || typeof row.contentKey !== 'string' || !/^\d+:\d+:[\da-f]{8}:[\da-f]{8}$/u.test(row.contentKey)) return;
  return { kind: row.kind, id: row.id, sourceId: row.sourceId, sourceRecordId: row.sourceRecordId, createdAt: row.createdAt as number, contentKey: row.contentKey };
};
const cleanState = (input: unknown): SavedReaderState | undefined => {
  const row = object(input), find = object(row?.find), positions = object(row?.positions);
  if (!row || row.format !== 'plain' && row.format !== 'formatted' || !positions || !find || typeof find.open !== 'boolean'
    || typeof find.query !== 'string' || find.query.length > 512 || !Number.isInteger(find.active) || !bounded(find.active, 0, 999)) return;
  const cleaned: SavedReaderState = { format: row.format, positions: {}, find: { open: find.open, query: find.query, active: find.active } };
  for (const format of ['plain', 'formatted'] as const) {
    if (positions[format] === undefined) continue;
    const position = object(positions[format]), anchor = object(position?.anchor);
    if (!position || !bounded(position.top, 0, 100_000_000) || !bounded(position.outlineTop, 0, 100_000_000) || !Array.isArray(position.sections) || position.sections.length > 16
      || position.anchor !== undefined && (!anchor || !Number.isInteger(anchor.index) || !bounded(anchor.index, 0, 100_000) || !bounded(anchor.offset, -100_000_000, 100_000_000))) return;
    const sections: [string, boolean][] = [];
    for (const entry of position.sections) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !/^[a-z-]{1,32}$/u.test(entry[0]) || typeof entry[1] !== 'boolean') return;
      sections.push([entry[0], entry[1]]);
    }
    cleaned.positions[format] = { top: position.top, outlineTop: position.outlineTop, sections,
      ...(anchor ? { anchor: { index: anchor.index as number, offset: anchor.offset as number } } : {}) };
  }
  return cleaned;
};

/** Bounded reading metadata in this tab and pairing. A fresh record must match
 * the stored identity; changed content keeps only the display preference. */
export const createReaderStateStore = (opts: { scope: string; storage?: RecentSearchStorage | null }): ReaderStateStore => {
  const key = 'recued.work.reading.v1:' + encodeURIComponent(opts.scope);
  let storage = opts.storage;
  if (storage === undefined) { try { storage = globalThis.sessionStorage; } catch { storage = null; } }
  let entries: { record: ReadingRecord; state: SavedReaderState }[] = [];
  try {
    const raw = storage?.getItem(key), parsed: unknown = raw && raw.length <= 262_144 ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) for (const input of parsed.slice(0, 100)) {
      const row = object(input), record = cleanRecord(row?.record), state = cleanState(row?.state);
      if (record && state && !entries.some(entry => entry.record.kind === record.kind && entry.record.id === record.id)) entries.push({ record, state });
      if (entries.length === 24) break;
    }
  } catch { /* Reading remains usable when storage is unavailable. */ }
  return {
    get(record) {
      const entry = entries.find(entry => entry.record.kind === record.kind && entry.record.id === record.id);
      if (!entry || identity(entry.record) !== identity(record)) return;
      return cleanState(entry.record.contentKey === record.contentKey ? entry.state
        : { format: entry.state.format, positions: {}, find: { open: false, query: '', active: 0 } });
    },
    set(record, state) {
      const ref = cleanRecord(record), snapshot = cleanState(state); if (!ref || !snapshot) return;
      entries = [{ record: ref, state: snapshot }, ...entries.filter(entry => entry.record.kind !== ref.kind || entry.record.id !== ref.id)].slice(0, 24);
      let raw = JSON.stringify(entries);
      while (raw.length > 262_144) { entries.pop(); raw = JSON.stringify(entries); }
      try { storage?.setItem(key, raw); } catch { /* Fall back to this boot's memory. */ }
    },
  };
};
