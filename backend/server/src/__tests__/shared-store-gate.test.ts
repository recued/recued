import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createStorageGate, type StorageGate } from '@recued/storage-gate';
import { createAuditLogStore, createInMemoryCollection, type ActivityEntry, type AuditEntry, type AuditLogStore } from '@recued/storage';
import { createSharedStore } from '../storage/shared-store.js';
import { createBlobStore } from '../storage/blob-store.js';
import {
  handleSharedCompareAndSet,
  handleSharedWrite,
  type SharedRpcDeps,
} from '../shared-handler.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mkGate = (): StorageGate => createStorageGate({
  quota: 20 * 1024 * 1024,
  reservePct: 0,
  surface: 'shared_store',
  pressureRatio: 0.8,
});

describe('SharedStore — onBytesChanged', () => {
  let db: Database.Database;
  let tmpRoot: string;
  let deltas: number[];

  beforeEach(() => {
    db = new Database(':memory:');
    tmpRoot = mkdtempSync(join(tmpdir(), 'shared-gate-'));
    deltas = [];
  });

  afterEach(() => {
    db.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('reports positive delta on write', async () => {
    const blobs = createBlobStore(tmpRoot);
    const store = createSharedStore({
      db, blobs,
      onBytesChanged: (d) => deltas.push(d),
    });
    const res = await store.write('deal.1', { stage: 'new' }, { author_id: 'me' });
    expect(deltas).toEqual([res.bytes]);
  });

  it('reports net delta on overwrite', async () => {
    const blobs = createBlobStore(tmpRoot);
    const store = createSharedStore({
      db, blobs,
      onBytesChanged: (d) => deltas.push(d),
    });
    const r1 = await store.write('deal.1', { s: 'x'.repeat(100) }, { author_id: 'me' });
    deltas.length = 0;
    const r2 = await store.write('deal.1', { s: 'x'.repeat(500) }, { author_id: 'me' });
    expect(deltas).toEqual([r2.bytes - r1.bytes]);
  });

  it('reports CAS create/advance deltas but no delta for a conflict', async () => {
    const blobs = createBlobStore(tmpRoot);
    const store = createSharedStore({
      db, blobs,
      onBytesChanged: (d) => deltas.push(d),
    });
    const created = await store.compareAndSet(
      'state.1',
      null,
      { revision: 0, value: 'a' },
      { author_id: 'me' },
    );
    expect(deltas).toEqual([created.bytes]);

    deltas.length = 0;
    const advanced = await store.compareAndSet(
      'state.1',
      0,
      { revision: 1, value: 'longer' },
      { author_id: 'me' },
    );
    expect(deltas).toEqual([advanced.bytes - created.bytes]);

    deltas.length = 0;
    await expect(store.compareAndSet(
      'state.1',
      0,
      { revision: 1, value: 'loser' },
      { author_id: 'me' },
    )).rejects.toMatchObject({ name: 'SharedCompareAndSetConflictError' });
    expect(deltas).toEqual([]);
  });

  it('reports negative delta on delete', async () => {
    const blobs = createBlobStore(tmpRoot);
    const store = createSharedStore({
      db, blobs,
      onBytesChanged: (d) => deltas.push(d),
    });
    const r = await store.write('deal.1', { stage: 'new' }, { author_id: 'me' });
    deltas.length = 0;
    await store.delete('deal.1');
    expect(deltas).toEqual([-r.bytes]);
  });

  it('reports sum of freed bytes on deleteByPrefix', async () => {
    const blobs = createBlobStore(tmpRoot);
    const store = createSharedStore({
      db, blobs,
      onBytesChanged: (d) => deltas.push(d),
    });
    const r1 = await store.write('deal.1', { s: 'a' }, { author_id: 'me' });
    const r2 = await store.write('deal.2', { s: 'bb' }, { author_id: 'me' });
    await store.write('other.1', { s: 'c' }, { author_id: 'me' });
    deltas.length = 0;
    const n = await store.deleteByPrefix('deal');
    expect(n).toBe(2);
    expect(deltas).toEqual([-(r1.bytes + r2.bytes)]);
  });

  it('delete of missing key reports no delta', async () => {
    const blobs = createBlobStore(tmpRoot);
    const store = createSharedStore({
      db, blobs,
      onBytesChanged: (d) => deltas.push(d),
    });
    const ok = await store.delete('never-existed');
    expect(ok).toBe(false);
    expect(deltas).toEqual([]);
  });

  it('no-op when onBytesChanged is undefined', async () => {
    const blobs = createBlobStore(tmpRoot);
    const store = createSharedStore({ db, blobs });
    await expect(store.write('k', 'v', { author_id: 'me' })).resolves.toMatchObject({ bytes: expect.any(Number) });
  });

  it('protects against handler exceptions', async () => {
    const blobs = createBlobStore(tmpRoot);
    const store = createSharedStore({
      db, blobs,
      onBytesChanged: () => { throw new Error('boom'); },
    });
    // Must not throw — write must succeed.
    await expect(store.write('k', 'v', { author_id: 'me' })).resolves.toMatchObject({ bytes: expect.any(Number) });
  });
});

describe('handleSharedWrite — gate admission', () => {
  let db: Database.Database;
  let tmpRoot: string;
  let gate: StorageGate;
  let auditLog: AuditLogStore;

  beforeEach(() => {
    db = new Database(':memory:');
    tmpRoot = mkdtempSync(join(tmpdir(), 'shared-gate-admit-'));
    gate = mkGate();
    auditLog = createAuditLogStore(
      createInMemoryCollection<AuditEntry>(),
      createInMemoryCollection<ActivityEntry>(),
    );
  });

  afterEach(() => {
    db.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  const mkDeps = (): SharedRpcDeps => {
    const blobs = createBlobStore(tmpRoot);
    const store = createSharedStore({
      db, blobs,
      onBytesChanged: (d) => gate.addUsed(d),
    });
    return { store, auditLog, gate };
  };

  it('admits writes under the gate pressure threshold', async () => {
    const deps = mkDeps();
    const r = await handleSharedWrite(deps, {
      key: 'data.shared.deal.1',
      value: { stage: 'new' },
    });
    expect(r.ok).toBe(true);
    expect(gate.info().used).toBeGreaterThan(0);
  });

  it('rejects with storage_pressure at writes_blocked', async () => {
    const deps = mkDeps();
    gate.setUsed(gate.info().blockedAt);
    await expect(
      handleSharedWrite(deps, {
        key: 'data.shared.deal.1',
        value: { stage: 'new' },
      }),
    ).rejects.toThrow(/shared_store write rejected/);
    // logActivity is fire-and-forget — yield so it completes.
    await new Promise((r) => setImmediate(r));
    const activities = await auditLog.listActivities();
    expect(activities.some((a) => a.action === 'quota_exceeded' && a.target === 'shared_store')).toBe(true);
  });

  it('rejects with halted when the gate is force-halted (kill switch)', async () => {
    const deps = mkDeps();
    gate.halt('crash_halt');
    await expect(
      handleSharedWrite(deps, {
        key: 'data.shared.deal.1',
        value: { stage: 'new' },
      }),
    ).rejects.toThrow(/shared_store write rejected/);
  });

  it('applies the same storage gate to compare-and-set writes', async () => {
    const deps = mkDeps();
    gate.setUsed(gate.info().blockedAt);
    await expect(handleSharedCompareAndSet(deps, {
      key: 'data.shared.state.1',
      expected_revision: null,
      value: { revision: 0 },
    })).rejects.toThrow(/shared_store write rejected/);
  });

  it('passes through when no gate wired (legacy)', async () => {
    const blobs = createBlobStore(tmpRoot);
    const store = createSharedStore({ db, blobs });
    const r = await handleSharedWrite({ store }, {
      key: 'data.shared.deal.1',
      value: { stage: 'new' },
    });
    expect(r.ok).toBe(true);
  });
});
