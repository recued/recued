import type { ContactRecord, WorkEntity } from '@recued/contracts';
import type { RecentSearchStorage } from './recent-searches.js';

export type RecentReferenceKind = 'contact' | 'project' | 'task';
export interface RecentReferenceChoice {
  kind: RecentReferenceKind; id: string; createdAt: number; sourceId?: string; sourceRecordId?: string | null;
}
export interface RecentReferenceChoices {
  list(kind: RecentReferenceKind): readonly RecentReferenceChoice[];
  remember(choice: RecentReferenceChoice): void;
  clear(kind: RecentReferenceKind): boolean;
  clearEpoch(kind: RecentReferenceKind): number;
}
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\u0000-\u001f\u007f]/u.test(value);
const clean = (value: unknown): RecentReferenceChoice | undefined => {
  if (!value || typeof value !== 'object') return;
  const row = value as Partial<RecentReferenceChoice>;
  if (!['contact', 'project', 'task'].includes(row.kind ?? '') || !identifier(row.id) || typeof row.createdAt !== 'number' || !Number.isFinite(row.createdAt) || row.createdAt < 0) return;
  if (row.kind === 'contact') return { kind: row.kind, id: row.id, createdAt: row.createdAt };
  if (!identifier(row.sourceId) || row.sourceRecordId != null && !identifier(row.sourceRecordId)) return;
  return { kind: row.kind as 'task' | 'project', id: row.id, createdAt: row.createdAt, sourceId: row.sourceId, sourceRecordId: row.sourceRecordId ?? null };
};
export const contactReferenceChoice = (contact: ContactRecord): RecentReferenceChoice => ({ kind: 'contact', id: contact.contact_id || contact.email, createdAt: contact.created_at });
export const workReferenceChoice = (entity: Extract<WorkEntity, { _kind: 'task' | 'project' }>): RecentReferenceChoice => ({
  kind: entity._kind, id: entity.id, createdAt: entity.created_at, sourceId: entity.source_id, sourceRecordId: entity.source_record_id ?? null,
});
export const sameReferenceChoice = (a: RecentReferenceChoice, b: RecentReferenceChoice): boolean => a.kind === b.kind && a.id === b.id
  && a.createdAt === b.createdAt && (a.sourceId ?? null) === (b.sourceId ?? null) && (a.sourceRecordId ?? null) === (b.sourceRecordId ?? null);

/** Eight choices per kind, scoped to this pairing in this tab. Names and
 * record contents are fetched again rather than persisted in history. */
export const createRecentReferenceChoices = (opts: { scope: string; storage?: RecentSearchStorage | null }): RecentReferenceChoices => {
  const key = 'recued.reference.choices.v1:' + encodeURIComponent(opts.scope), epochs = { contact: 0, task: 0, project: 0 };
  let storage = opts.storage, choices: RecentReferenceChoice[] = [];
  if (storage === undefined) { try { storage = globalThis.sessionStorage ?? null; } catch { storage = null; } }
  try {
    const raw = storage?.getItem(key), parsed: unknown = raw && raw.length <= 65536 ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) for (const value of parsed.slice(0, 100)) {
      const row = clean(value);
      if (row && choices.filter(old => old.kind === row.kind).length < 8 && !choices.some(old => old.kind === row.kind && old.id === row.id)) choices.push(row);
    }
  } catch { /* A blocked history store does not prevent choosing a reference. */ }
  const write = (next: RecentReferenceChoice[]): boolean => {
    try { if (next.length) storage?.setItem(key, JSON.stringify(next)); else storage?.removeItem(key); return true; }
    catch { return false; }
  };
  return {
    list: kind => choices.filter(row => row.kind === kind).map(row => ({ ...row })),
    clearEpoch: kind => epochs[kind],
    remember(value) {
      const row = clean(value); if (!row) return;
      const counts = { contact: 0, task: 0, project: 0 };
      choices = [row, ...choices.filter(old => old.kind !== row.kind || old.id !== row.id)].filter(item => ++counts[item.kind] <= 8);
      while (JSON.stringify(choices).length > 65536) choices.pop();
      write(choices);
    },
    clear(kind) {
      const next = choices.filter(row => row.kind !== kind);
      if (!write(next)) return false;
      choices = next; epochs[kind]++; return true;
    },
  };
};
