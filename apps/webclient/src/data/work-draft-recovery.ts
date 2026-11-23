import { readDraftOrigin } from './draft-origin.js';
import type { WorkEntity } from '@recued/contracts';
import { createDraftCheckpoint, createDraftRecoveryStore, type DraftRecoveryEntry, type DraftRecoveryStorage } from './draft-recovery.js';

export type WorkDraftKind = 'task' | 'project';
export const isWorkDraftKind = (kind: string): kind is WorkDraftKind => kind === 'task' || kind === 'project';
export type WorkDraftEntity = Extract<WorkEntity, { _kind: WorkDraftKind }>;
export type WorkDraftValue = string | number | boolean | null | WorkDraftValue[] | { [key: string]: WorkDraftValue };
export type WorkDraftValues = Record<string, WorkDraftValue>;
export interface WorkDraftOriginal {
  kind: WorkDraftKind; id: string; sourceId: string; sourceRecordId: string | null;
  createdAt: number; updatedAt: number; values: WorkDraftValues;
}
export interface WorkRecoveryEntry extends DraftRecoveryEntry<WorkDraftValues, WorkDraftOriginal> {}
export type WorkRecoveryStorage = DraftRecoveryStorage;
export const WORK_RECOVERY_LIMITS = { entries: 8, entryBytes: 512 * 1024, bytes: 2 * 1024 * 1024, age: 7 * 86_400_000 } as const;
const object = (input: unknown): Record<string, unknown> | null => input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null;
const identifier = (input: unknown): input is string => typeof input === 'string' && input.length > 0 && input.length <= 2048;
const timestamp = (input: unknown): input is number => typeof input === 'number' && Number.isSafeInteger(input) && input >= 0;
const forbidden = new Set(['__proto__', 'prototype', 'constructor', 'id', '_kind', 'kind', 'source_id', 'source_record_id',
  'created_at', 'updated_at', 'last_seen_at', 'last_activity_at', 'completed_at', 'sync_state', 'pending_write', 'deleted_at', 'conflict_policy']);
const safeValue = (input: unknown, depth = 0): input is WorkDraftValue => {
  if (input === null || typeof input === 'boolean') return true;
  if (typeof input === 'number') return Number.isFinite(input);
  if (typeof input === 'string') return input.length <= 100_000;
  if (depth >= 6) return false;
  if (Array.isArray(input)) return input.length <= 100 && input.every(value => safeValue(value, depth + 1));
  const row = object(input);
  return row !== null && Object.keys(row).length <= 100 && Object.entries(row).every(([key, value]) =>
    key.length <= 256 && !['__proto__', 'constructor', 'prototype'].includes(key) && safeValue(value, depth + 1));
};

/** Fields are data only. On resume the route intersects them with the freshly
 * checked form definition; they can never supply an id, source or RPC method. */
export const workDraftValues = (input: Readonly<Record<string, unknown>>): WorkDraftValues => Object.fromEntries(
  Object.entries(input).filter(([key, value]) => !forbidden.has(key) && value !== undefined)
    .map(([key, value]) => [key, structuredClone(value)]),
) as WorkDraftValues;
const parseValues = (input: unknown): WorkDraftValues | null => {
  const row = object(input);
  if (!row || Object.keys(row).length > 200 || !Object.entries(row).every(([key, value]) => key.length <= 256 && safeValue(value))
    || row.title !== undefined && (typeof row.title !== 'string' || row.title.length > 2048)) return null;
  return workDraftValues(row);
};
const stable = (value: WorkDraftValue): string => JSON.stringify(value, (_key, item: unknown) => {
  const row = object(item);
  return row ? Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])) : item;
});
export const workDraftOriginal = (entity: WorkDraftEntity): WorkDraftOriginal => {
  const values = workDraftValues(entity as unknown as Record<string, unknown>);
  for (const key of ['blocks_task_ids', 'related_contact_ids']) {
    const value = values[key]; if (Array.isArray(value)) values[key] = [...value].sort();
  }
  return { kind: entity._kind, id: entity.id, sourceId: entity.source_id, sourceRecordId: entity.source_record_id ?? null,
    createdAt: entity.created_at, updatedAt: entity.updated_at, values };
};
export const workDraftMatchesOriginal = (original: WorkDraftOriginal, entity: WorkDraftEntity): boolean => {
  const current = workDraftOriginal(entity);
  return original.kind === current.kind && original.id === current.id && original.sourceId === current.sourceId
    && original.sourceRecordId === current.sourceRecordId && original.createdAt === current.createdAt
    && original.updatedAt === current.updatedAt && stable(original.values) === stable(current.values);
};
export const parseWorkRecovery = (input: unknown, now: number, kind: WorkDraftKind): WorkRecoveryEntry | null => {
  const row = object(input), values = parseValues(row?.values), original = object(row?.original);
  if (!row || !values || typeof row.id !== 'string' || !/^wdr_[0-9a-f-]{36}$/.test(row.id)
    || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1 || !identifier(row.sourceId)
    || !timestamp(row.updatedAt) || row.updatedAt < now - WORK_RECOVERY_LIMITS.age || row.updatedAt > now + 60_000
    || !['editing', 'pending', 'unknown'].includes(String(row.status))
    || row.attempt !== undefined && (typeof row.attempt !== 'string' || !/^[0-9a-f-]{36}$/.test(row.attempt))
    || row.status !== 'editing' && !row.attempt || row.savedId !== undefined && !identifier(row.savedId)) return null;
  let base: WorkDraftOriginal | null = null;
  if (row.original !== null) {
    const baseValues = parseValues(original?.values);
    if (!original || !baseValues || original.kind !== kind || !identifier(original.id) || original.sourceId !== row.sourceId
      || original.sourceRecordId !== null && !identifier(original.sourceRecordId)
      || !timestamp(original.createdAt) || !timestamp(original.updatedAt)) return null;
    base = { kind, id: original.id, sourceId: row.sourceId, sourceRecordId: original.sourceRecordId as string | null,
      createdAt: original.createdAt, updatedAt: original.updatedAt, values: baseValues };
  }
  const origin = kind === 'task' && base === null ? readDraftOrigin(row.origin) : undefined;
  return { id: row.id, revision: Number(row.revision), updatedAt: row.updatedAt, sourceId: row.sourceId, values, original: base,
    ...(origin ? { origin } : {}), status: row.status as WorkRecoveryEntry['status'], ...(row.attempt ? { attempt: row.attempt as string } : {}),
    ...(row.savedId ? { savedId: row.savedId as string } : {}) };
};
export const createWorkRecoveryStore = (opts: { scope: string; kind: WorkDraftKind; storage?: WorkRecoveryStorage | null; now?: () => number }) =>
  createDraftRecoveryStore({ ...opts, key: `recued.${opts.kind}.draft-recovery.v1:${encodeURIComponent(opts.scope)}`,
    limits: WORK_RECOVERY_LIMITS, parse: (input, now) => parseWorkRecovery(input, now, opts.kind) });
export type WorkRecoveryStore = ReturnType<typeof createWorkRecoveryStore>;
export type WorkRecoveryStores = Partial<Record<WorkDraftKind, WorkRecoveryStore>>;
export const createWorkDraftCheckpoint = (opts: { kind: WorkDraftKind; store?: WorkRecoveryStore; now?: () => number; changed?: () => void }) =>
  createDraftCheckpoint({ ...opts, values: workDraftValues, same: (a, b) => stable(a) === stable(b), idPrefix: 'wdr_', label: opts.kind,
    initialMessage: `Unfinished ${opts.kind === 'task' ? 'tasks' : 'projects'} are kept in this tab.` });
