/** Recovery evidence lives beside the DB, so restoring an older DB cannot
 * rewind it. Closed, bounded records contain no words, paths, or user rows. */
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { isValidReleaseVersion } from '@recued/release';
import { ARCHIVE_RESTORE_DRILL_ISSUE_TEXT, type ArchiveRestoreDrill, type ArchiveRestoreDrillChecks } from '@recued/contracts';
import { writeFileAtomicSync } from '../durable-fs.js';
import { archiveImportOperationId } from './archive-import-receipts.js';

const LIMIT = 4096, MAX_BYTES = 4 * 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/u;
const STATES = new Set(['retrieving', 'restoring', 'checking', 'cleaning', 'succeeded', 'failed']);
const KEYS = new Set(['operation_id', 'backup_operation_id', 'destination_id', 'archive_sha256', 'archive_bytes',
  'started_at', 'finished_at', 'state', 'issue', 'cleanup_pending', 'cancel_requested_at', 'cleanup_completed_at', 'checks']);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const id = (v: unknown): v is string => typeof v === 'string' && archiveImportOperationId(v) === v;
const hash = (v: unknown): v is string => typeof v === 'string' && HASH.test(v);
export const isRestoreDrillChecks = (v: unknown): v is ArchiveRestoreDrillChecks => object(v) && v.version === 1
  && typeof v.server_version === 'string' && isValidReleaseVersion(v.server_version)
  && v.database_integrity === 'ok' && v.foreign_keys === 'ok' && v.local_boot_key === 'ok'
  && integer(v.database_bytes) && integer(v.restored_blob_records) && integer(v.referenced_blobs) && integer(v.blob_bytes)
  && Object.keys(v).every(k => ['version', 'server_version', 'database_integrity', 'foreign_keys', 'local_boot_key',
    'database_bytes', 'restored_blob_records', 'referenced_blobs', 'blob_bytes'].includes(k));
const receipt = (v: unknown): v is ArchiveRestoreDrill => object(v) && id(v.operation_id) && id(v.backup_operation_id)
  && hash(v.destination_id) && hash(v.archive_sha256) && integer(v.archive_bytes) && v.archive_bytes >= 4
  && integer(v.started_at) && typeof v.state === 'string' && STATES.has(v.state)
  && (v.finished_at === undefined || integer(v.finished_at))
  && (v.issue === undefined || (typeof v.issue === 'string' && Object.hasOwn(ARCHIVE_RESTORE_DRILL_ISSUE_TEXT, v.issue)))
  && (v.cleanup_pending === undefined || v.cleanup_pending === true)
  && (v.cancel_requested_at === undefined || (integer(v.cancel_requested_at) && v.state !== 'succeeded'))
  && (v.issue !== 'cancelled' || v.cancel_requested_at !== undefined)
  && (v.cleanup_completed_at === undefined || (integer(v.cleanup_completed_at) && v.state === 'failed' && v.cleanup_pending === undefined))
  && (v.state === 'failed' ? v.issue !== undefined && v.finished_at !== undefined && v.checks === undefined
    : v.state === 'succeeded' ? isRestoreDrillChecks(v.checks) && v.finished_at !== undefined && v.issue === undefined && v.cleanup_pending === undefined
    : v.finished_at === undefined && v.issue === undefined && v.checks === undefined && v.cleanup_pending === undefined)
  && Object.keys(v).every(k => KEYS.has(k));

export const restoreDrillLedgerPath = (dbPath: string): string => `${resolve(dbPath)}.restore-drills.json`;
export const restoreDrillScratchPath = (dbPath: string): string => `${resolve(dbPath)}.restore-drills`;
export const restoreDrillActive = (row: ArchiveRestoreDrill): boolean => row.state !== 'succeeded' && row.state !== 'failed';
export const createRestoreDrillStore = (dbPath: string, maxEntries = LIMIT) => {
  const path = restoreDrillLedgerPath(dbPath);
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > LIMIT) throw new Error('Invalid drill history limit');
  const read = (): ArchiveRestoreDrill[] => {
    let raw: Buffer;
    try {
      if (statSync(path).size > MAX_BYTES) throw new Error('Drill history exceeds its limit');
      raw = readFileSync(path);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    if (raw.length > MAX_BYTES) throw new Error('Drill history exceeds its limit');
    const value: unknown = JSON.parse(raw.toString('utf8'));
    if (!object(value) || value.v !== 1 || !Array.isArray(value.drills) || value.drills.length > LIMIT
      || Object.keys(value).some(k => k !== 'v' && k !== 'drills')) throw new Error('Invalid drill history');
    const ids = new Set<string>(), rows: ArchiveRestoreDrill[] = [];
    for (const row of value.drills) {
      if (!receipt(row) || ids.has(row.operation_id)) throw new Error('Invalid drill receipt');
      ids.add(row.operation_id); rows.push(row);
    }
    return rows;
  };
  const write = (rows: ArchiveRestoreDrill[]): void => {
    if (!rows.every(receipt)) throw new Error('Invalid drill receipt');
    const raw = `${JSON.stringify({ v: 1, drills: rows })}\n`;
    if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error('Drill history exceeds its limit');
    writeFileAtomicSync(path, raw);
  };
  return {
    rows: read,
    reserve(row: ArchiveRestoreDrill): void {
      const rows = read();
      if (rows.length >= maxEntries || rows.some(r => r.operation_id === row.operation_id)) throw new Error('Drill history is full or the identifier was already used');
      if (rows.some(r => restoreDrillActive(r) || r.cleanup_pending)) throw new Error('An earlier drill still needs cleanup or reconciliation');
      rows.push(row); write(rows);
    },
    update(operationId: string, change: (row: ArchiveRestoreDrill) => void): ArchiveRestoreDrill {
      const rows = read(), row = rows.find(r => r.operation_id === operationId);
      if (!row) throw new Error('Drill receipt is missing');
      change(row); write(rows); return structuredClone(row);
    },
  };
};
