import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { archiveImportOperationId, archiveImportReceiptPath, createArchiveImportReceipts } from '../archive/archive-import-receipts.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const fixture = (maxEntries?: number) => {
  const dir = mkdtempSync(join(tmpdir(), 'recued-import-receipt-')); dirs.push(dir);
  const db = join(dir, 'realm.db'), staged = `${db}.staging-1234567890abcdef`, id = randomUUID();
  return { db, staged, id, path: archiveImportReceiptPath(db), store: createArchiveImportReceipts(db, { now: () => 100, maxEntries }) };
};

describe('durable archive import receipts', () => {
  it('keeps identity and the exact swap verdict outside a replaced database', () => {
    const { db, staged, id, path, store } = fixture();
    expect(store.status(id)).toEqual({ status: 'unknown' });
    store.reserve(id); expect(store.status(id)).toEqual({ status: 'preparing' });
    store.staged(id, staged); expect(store.status(id)).toEqual({ status: 'waiting_for_restart' });
    store.settle(id, basename(staged), true);
    writeFileSync(db, 'an older restored database');
    expect(createArchiveImportReceipts(db).status(id)).toEqual({ status: 'completed' });
    expect(Object.keys(store.status(id))).toEqual(['status']);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('never mistakes request acceptance or a restart without a journal for completion', () => {
    const { db, id, staged, store } = fixture();
    store.reserve(id); store.staged(id, staged);
    createArchiveImportReceipts(db).reconcileBoot({ journalOpen: false, parksResolved: true });
    expect(store.status(id)).toEqual({ status: 'unknown' });
  });

  it.each([true, false])('keeps an interrupted stream recoverable until its parks are resolved (journalOpen=%s)', journalOpen => {
    const { store, id } = fixture(); store.reserve(id);
    store.reconcileBoot({ journalOpen, parksResolved: false });
    expect(store.status(id)).toEqual({ status: 'recovery_required' });
    expect(() => store.reserve(randomUUID())).toThrow('still requires recovery');
    store.reconcileBoot({ journalOpen: false, parksResolved: true });
    expect(store.status(id)).toEqual({ status: 'unknown' });
  });

  it('binds a journal verdict to its original staged database and rejects contradictions', () => {
    const { store, id, staged } = fixture(); store.reserve(id); store.staged(id, staged);
    expect(() => store.settle(id, 'realm.db.staging-abcdef0123456789', true)).toThrow('different swap');
    expect(store.status(id)).toEqual({ status: 'waiting_for_restart' });
    store.settle(id, basename(staged), false);
    expect(() => store.settle(id, basename(staged), true)).toThrow('conflicts');
    expect(store.status(id)).toEqual({ status: 'not_applied' });
  });

  it('preserves terminal receipts across repeated boot reconciliation', () => {
    const { store, id, staged } = fixture(); store.reserve(id); store.staged(id, staged); store.settle(id, basename(staged), true);
    store.reconcileBoot({ journalOpen: true, parksResolved: false });
    expect(store.status(id)).toEqual({ status: 'completed' });
    expect(() => store.reserve(id)).toThrow('already in use');
  });

  it('does not forget used identifiers to make room for a delayed destructive request', () => {
    const { store, id } = fixture(1); store.reserve(id); store.refused(id);
    expect(() => store.reserve(randomUUID())).toThrow('history is full');
    expect(() => store.reserve(id)).toThrow('already in use');
    expect(store.status(id)).toEqual({ status: 'not_applied' });
  });

  it('rejects malformed, oversized and value-bearing history without inventing outcomes', () => {
    const { store, path, id } = fixture();
    for (const value of ['{', '{"v":2,"receipts":[]}', JSON.stringify({ v: 1, receipts: [{ id, status: 'completed', started_at: 1 }] }),
      JSON.stringify({ v: 1, receipts: [{ id: null, status: 'preparing', started_at: 1 }] }),
      JSON.stringify({ v: 1, receipts: [{ id, status: 'preparing', started_at: 1, recoveryKey: 'must never be stored' }] }), ' '.repeat(2 * 1024 * 1024 + 1)]) {
      writeFileSync(path, value); expect(() => store.status(id)).toThrow();
    }
  });

  it('normalizes only valid UUIDs and confines the staging binding to this database', () => {
    const { store, id, db } = fixture();
    expect(archiveImportOperationId(id.toUpperCase())).toBe(id);
    expect(archiveImportOperationId('../other')).toBeNull();
    store.reserve(id);
    for (const path of [`${db}.staging-bad`, join(tmpdir(), `${basename(db)}.staging-1234567890abcdef`)]) {
      expect(() => store.staged(id, path)).toThrow('does not match');
    }
  });
});
