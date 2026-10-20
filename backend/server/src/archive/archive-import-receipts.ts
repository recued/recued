/** Import outcomes live beside the database: restoring an older database must
 * not rewind the operation the owner is trying to verify. No archive path,
 * recovery key, bearer or archive content enters this file. The swap journal
 * settles its exact receipt BEFORE retiring its own commit/rollback evidence.
 *
 * IDs are never recycled. A bounded full history refuses another import;
 * expiring an ID would allow a delayed destructive request to run again. */
import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import type { ArchiveImportOperationStatus } from '@recued/contracts';
import { writeFileAtomicSync } from '../durable-fs.js';

export const ARCHIVE_IMPORT_RECEIPT_LIMIT = 4096;
const MAX_BYTES = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
type Status = ArchiveImportOperationStatus['status'];
interface Receipt {
  id: string;
  status: Status;
  started_at: number;
  staging_name?: string;
}
const STATES: ReadonlySet<string> = new Set<Status>([
  'unknown', 'preparing', 'waiting_for_restart', 'completed', 'not_applied', 'recovery_required',
]);
const terminal = (status: Status): boolean => status === 'completed' || status === 'not_applied';

export const archiveImportOperationId = (value: unknown): string | null =>
  typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;

export const archiveImportReceiptPath = (dbPath: string): string =>
  `${resolve(dbPath)}.archive-import-receipts.json`;

export const createArchiveImportReceipts = (
  dbPath: string,
  options: { now?: () => number; maxEntries?: number } = {},
) => {
  const path = archiveImportReceiptPath(dbPath);
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? ARCHIVE_IMPORT_RECEIPT_LIMIT;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > ARCHIVE_IMPORT_RECEIPT_LIMIT) {
    throw new Error('Invalid archive import receipt limit');
  }
  const escapedDbName = basename(dbPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stagingName = new RegExp(`^${escapedDbName}\\.staging-[0-9a-f]{16}$`, 'u');
  const read = (): Receipt[] => {
    let raw: Buffer;
    try {
      if (statSync(path).size > MAX_BYTES) throw new Error('Archive import receipt history is too large');
      raw = readFileSync(path);
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    if (raw.length > MAX_BYTES) throw new Error('Archive import receipt history is too large');
    let value: unknown;
    try { value = JSON.parse(raw.toString('utf8')); }
    catch { throw new Error('Invalid archive import receipt history'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid archive import receipt history');
    const data = value as { v?: unknown; receipts?: unknown };
    if (data.v !== 1 || !Array.isArray(data.receipts) || data.receipts.length > ARCHIVE_IMPORT_RECEIPT_LIMIT) {
      throw new Error('Invalid archive import receipt history');
    }
    const ids = new Set<string>();
    return data.receipts.map((entry: unknown): Receipt => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid archive import receipt');
      const row = entry as Partial<Receipt>;
      if (typeof row.id !== 'string' || archiveImportOperationId(row.id) !== row.id || ids.has(row.id)
        || !STATES.has(row.status ?? '') || !Number.isSafeInteger(row.started_at) || row.started_at! < 0
        || (row.staging_name !== undefined && !stagingName.test(row.staging_name))
        || ((row.status === 'waiting_for_restart' || row.status === 'completed') && row.staging_name === undefined)
        || Object.keys(row).some(key => !['id', 'status', 'started_at', 'staging_name'].includes(key))) {
        throw new Error('Invalid archive import receipt');
      }
      ids.add(row.id!);
      return { id: row.id!, status: row.status!, started_at: row.started_at!,
        ...(row.staging_name === undefined ? {} : { staging_name: row.staging_name }) };
    });
  };
  const write = (rows: Receipt[]): void => {
    writeFileAtomicSync(path, `${JSON.stringify({ v: 1, receipts: rows })}\n`);
  };
  const change = (id: string, update: (entry: Receipt) => void): void => {
    const rows = read(), entry = rows.find(row => row.id === id);
    if (!entry) throw new Error('Archive import receipt is missing');
    update(entry); write(rows);
  };
  return {
    reserve(id: string): void {
      if (typeof id !== 'string' || archiveImportOperationId(id) !== id) throw new Error('Archive import operation_id must be a UUID');
      const rows = read();
      if (rows.some(row => row.id === id)) throw new Error('Archive import operation_id is already in use; check its status');
      if (rows.some(row => row.status === 'recovery_required')) throw new Error('A previous archive restore still requires recovery; restart the server and check its status');
      if (rows.length >= maxEntries) throw new Error('Archive import receipt history is full; no import was started');
      rows.push({ id, status: 'preparing', started_at: now() }); write(rows);
    },
    staged(id: string, stagedPath: string): void {
      const name = basename(stagedPath);
      if (dirname(resolve(stagedPath)) !== dirname(resolve(dbPath)) || !stagingName.test(name)) {
        throw new Error('Archive import staging path does not match this database');
      }
      change(id, entry => {
        if (entry.status !== 'preparing') throw new Error('Archive import receipt is no longer preparing');
        entry.status = 'waiting_for_restart'; entry.staging_name = name;
      });
    },
    refused(id: string): void {
      change(id, entry => {
        if (terminal(entry.status) || entry.status === 'recovery_required') return;
        // A staged operation that escaped its ordinary unwind needs recovery.
        entry.status = entry.staging_name === undefined ? 'not_applied' : 'recovery_required';
      });
    },
    abandoned(id: string, recovered: boolean): void {
      change(id, entry => {
        if (entry.status === 'completed') throw new Error('A completed import cannot be abandoned');
        entry.status = recovered ? 'not_applied' : 'recovery_required';
      });
    },
    assertStaged(id: string, name: string): void {
      const entry = read().find(row => row.id === id);
      if (!entry || terminal(entry.status) || entry.staging_name !== name) {
        throw new Error('Archive import receipt does not authorize this staging transaction');
      }
    },
    settle(id: string, stagedName: string, committed: boolean): void {
      change(id, entry => {
        if (entry.staging_name !== stagedName) throw new Error('Archive import receipt belongs to a different swap');
        const status = committed ? 'completed' : 'not_applied';
        if (terminal(entry.status) && entry.status !== status) throw new Error('Archive import verdict conflicts with its receipt');
        entry.status = status;
      });
    },
    reconcileBoot(options: { journalOpen: boolean; parksResolved: boolean }): void {
      const rows = read(); let changed = false;
      for (const entry of rows) {
        if (terminal(entry.status)) continue;
        // No journal is not a durable negative verdict. A kill before journal
        // publication leaves uncertainty; it never becomes a claimed failure.
        const status = options.journalOpen || !options.parksResolved ? 'recovery_required' : 'unknown';
        if (entry.status !== status) { entry.status = status; changed = true; }
      }
      if (changed) write(rows);
    },
    status(id: string): ArchiveImportOperationStatus {
      if (typeof id !== 'string' || archiveImportOperationId(id) !== id) return { status: 'unknown' };
      return { status: read().find(row => row.id === id)?.status ?? 'unknown' };
    },
  };
};
