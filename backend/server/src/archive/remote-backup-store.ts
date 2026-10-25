/** Kept outside the replaced DB. IDs and retention authority do not rewind on
 * restore. The bounded ledger refuses new work rather than recycling an ID.
 * No recovery key, access key, secret, or provider error body belongs here. */
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ArchiveRemoteBackup, ArchiveRemoteDestination, ArchiveRemoteIssue, ArchiveRemoteState } from '@recued/contracts';
import { writeFileAtomicSync } from '../durable-fs.js';
import { archiveImportOperationId } from './archive-import-receipts.js';
import { isGeneratedExportName } from './export-store.js';

const LIMIT = 4096;
const MAX_BYTES = 8 * 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/u;
const STATES = new Set<ArchiveRemoteState>(['preparing', 'uploading', 'verifying', 'verified', 'unconfirmed', 'pruning', 'pruned']);
const ISSUES = new Set<ArchiveRemoteIssue>(['interrupted', 'export_failed', 'destination_unavailable', 'transfer_unconfirmed', 'verification_failed']);
export interface RemoteBackupRow extends Omit<ArchiveRemoteBackup, 'multipart_cleanup_pending'> {
  destination_fingerprint: string;
  export_name?: string;
  export_expires_at?: number;
  multipart_id?: string;
  etag?: string;
  version_id?: string;
}
interface Ledger { v: 1; namespace: string; backups: RemoteBackupRow[] }
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const validId = (v: unknown): v is string => typeof v === 'string' && archiveImportOperationId(v) === v;
const text = (v: unknown, max = 4096): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/u.test(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const destination = (v: unknown): v is ArchiveRemoteDestination => isObject(v)
  && text(v.connection_name, 256) && text(v.bucket, 255) && text(v.region, 128) && text(v.endpoint, 2048)
  && typeof v.destination_id === 'string' && HASH.test(v.destination_id)
  && typeof v.prefix === 'string' && /^(?:[A-Za-z0-9_.-]+\/)*$/u.test(v.prefix)
  && !v.prefix.split('/').some(p => p === '.' || p === '..')
  && Object.keys(v).every(k => ['connection_name', 'destination_id', 'bucket', 'region', 'endpoint', 'prefix'].includes(k));
const ROW_KEYS = new Set(['operation_id', 'job_id', 'destination', 'object_key', 'created_at', 'state', 'keep_last',
  'bytes', 'sha256', 'verified_at', 'issue', 'retention_pending', 'destination_fingerprint', 'export_name', 'export_expires_at', 'multipart_id', 'multipart_cleanup_issue', 'etag', 'version_id']);

export const remoteBackupLedgerPath = (dbPath: string): string => `${resolve(dbPath)}.remote-backups.json`;
export const remoteBackupScratchPath = (dbPath: string): string => `${resolve(dbPath)}.remote-backup-staging`;
export const remoteBackupObjectKey = (namespace: string, id: string, prefix = ''): string => `${prefix}recued-backups/${namespace}/${id}.recued.archive`;
export const remoteBackupView = (row: RemoteBackupRow): ArchiveRemoteBackup => ({
  operation_id: row.operation_id, job_id: row.job_id, destination: { ...row.destination }, object_key: row.object_key,
  created_at: row.created_at, state: row.state, keep_last: row.keep_last,
  ...(row.bytes === undefined ? {} : { bytes: row.bytes }), ...(row.sha256 === undefined ? {} : { sha256: row.sha256 }),
  ...(row.verified_at === undefined ? {} : { verified_at: row.verified_at }), ...(row.issue === undefined ? {} : { issue: row.issue }),
  ...(row.retention_pending === undefined ? {} : { retention_pending: row.retention_pending }),
  ...(row.multipart_id !== undefined && (row.state === 'unconfirmed' || row.state === 'verifying') ? {
    multipart_cleanup_pending: true,
    ...(row.multipart_cleanup_issue === 'permission_denied' ? { multipart_cleanup_issue: row.multipart_cleanup_issue } : {}),
  } : {}),
});

export const createRemoteBackupStore = (dbPath: string, options: { now?: () => number; maxEntries?: number } = {}) => {
  const path = remoteBackupLedgerPath(dbPath), now = options.now ?? Date.now, maxEntries = options.maxEntries ?? LIMIT;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > LIMIT) throw new Error('Invalid remote backup history limit');
  const read = (): Ledger | null => {
    let raw: Buffer;
    try {
      if (statSync(path).size > MAX_BYTES) throw new Error('Remote backup history exceeds its limit');
      raw = readFileSync(path);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    if (raw.length > MAX_BYTES) throw new Error('Remote backup history exceeds its limit');
    let value: unknown;
    try { value = JSON.parse(raw.toString('utf8')); } catch { throw new Error('Invalid remote backup history'); }
    if (!isObject(value) || value.v !== 1 || !validId(value.namespace) || !Array.isArray(value.backups)
      || value.backups.length > LIMIT || Object.keys(value).some(k => !['v', 'namespace', 'backups'].includes(k))) throw new Error('Invalid remote backup history');
    const ids = new Set<string>(), jobs = new Set<string>();
    const backups = value.backups.map((entry: unknown): RemoteBackupRow => {
      if (!isObject(entry) || !validId(entry.operation_id) || ids.has(entry.operation_id)
        || !text(entry.job_id, 128) || !/^arx-[0-9a-f-]+$/u.test(entry.job_id) || jobs.has(entry.job_id)
        || !destination(entry.destination) || entry.object_key !== remoteBackupObjectKey(value.namespace as string, entry.operation_id, entry.destination.prefix)
        || !integer(entry.created_at) || !STATES.has(entry.state as ArchiveRemoteState)
        || !integer(entry.keep_last) || entry.keep_last < 1 || entry.keep_last > 30
        || !text(entry.destination_fingerprint, 64) || !HASH.test(entry.destination_fingerprint)
        || entry.destination.destination_id !== entry.destination_fingerprint
        || (entry.bytes !== undefined && (!integer(entry.bytes) || entry.bytes < 4))
        || (entry.sha256 !== undefined && (typeof entry.sha256 !== 'string' || !HASH.test(entry.sha256)))
        || (entry.verified_at !== undefined && !integer(entry.verified_at))
        || (['verified', 'pruning', 'pruned'].includes(entry.state as string) && (entry.bytes === undefined || entry.sha256 === undefined || entry.verified_at === undefined))
        || (entry.issue !== undefined && !ISSUES.has(entry.issue as ArchiveRemoteIssue))
        || (entry.retention_pending !== undefined && typeof entry.retention_pending !== 'boolean')
        || (entry.multipart_cleanup_issue !== undefined && (entry.multipart_cleanup_issue !== 'permission_denied' || entry.multipart_id === undefined))
        || (entry.export_name !== undefined && (typeof entry.export_name !== 'string' || !isGeneratedExportName(entry.export_name)))
        || (entry.export_expires_at !== undefined && !integer(entry.export_expires_at))
        || ['multipart_id', 'etag', 'version_id'].some(k => entry[k] !== undefined && !text(entry[k]))
        || Object.keys(entry).some(k => !ROW_KEYS.has(k))) throw new Error('Invalid remote backup receipt');
      ids.add(entry.operation_id); jobs.add(entry.job_id);
      // The closed shape and each field were checked above. Return detached data.
      return structuredClone(entry) as unknown as RemoteBackupRow;
    });
    return { v: 1, namespace: value.namespace, backups };
  };
  const write = (ledger: Ledger): void => {
    const raw = `${JSON.stringify(ledger)}\n`;
    if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error('Remote backup history exceeds its limit');
    writeFileAtomicSync(path, raw);
  };
  return {
    rows(): RemoteBackupRow[] { return read()?.backups ?? []; },
    get(id: string): RemoteBackupRow | null { return read()?.backups.find(row => row.operation_id === id) ?? null; },
    reserve(input: { operation_id: string; job_id: string; destination: ArchiveRemoteDestination; fingerprint: string; keep_last: number }): RemoteBackupRow {
      if (!validId(input.operation_id) || !/^arx-[0-9a-f-]+$/u.test(input.job_id) || !destination(input.destination)
        || !HASH.test(input.fingerprint) || input.destination.destination_id !== input.fingerprint
        || !Number.isInteger(input.keep_last) || input.keep_last < 1 || input.keep_last > 30) throw new Error('Invalid remote backup request');
      const ledger = read() ?? { v: 1, namespace: randomUUID(), backups: [] };
      if (ledger.backups.some(row => row.operation_id === input.operation_id || row.job_id === input.job_id)) throw new Error('Remote backup identifier is already in use');
      if (ledger.backups.length >= maxEntries) throw new Error('Remote backup history is full');
      const row: RemoteBackupRow = { operation_id: input.operation_id, job_id: input.job_id, destination: { ...input.destination },
        destination_fingerprint: input.fingerprint, object_key: remoteBackupObjectKey(ledger.namespace, input.operation_id, input.destination.prefix),
        created_at: now(), state: 'preparing', keep_last: input.keep_last };
      ledger.backups.push(row); write(ledger); return structuredClone(row);
    },
    update(id: string, change: (row: RemoteBackupRow) => void): RemoteBackupRow {
      const ledger = read(), row = ledger?.backups.find(r => r.operation_id === id);
      if (!ledger || !row) throw new Error('Remote backup receipt is missing');
      change(row); write(ledger); return structuredClone(row);
    },
    reconcileBoot(): void {
      const ledger = read(); if (!ledger) return; let changed = false;
      for (const row of ledger.backups) {
        if (!['preparing', 'uploading', 'verifying'].includes(row.state)) continue;
        row.state = 'unconfirmed'; row.issue = 'interrupted'; changed = true;
      }
      if (changed) write(ledger);
    },
  };
};
