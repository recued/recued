import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateRecoveryKey, generateServerKey, recoveryKeyToEntropy } from '@recued/crypto';
import { isReservedLocalRpc, MCP_TOOL_CATALOG, type ArchiveRestoreDrill, type ServerRpcRegistry } from '@recued/contracts';
import { openDatabase, rekeyDatabase } from '../open-database.js';
import { createKeyManager } from '../key-manager.js';
import { createServerBundleStore, resolveServerBundlePath } from '../server-bundle-store.js';
import { resolveIdentityKeysPath } from '../identity/boot.js';
import { createArchiveRuntime, composeArchiveRpcDeps } from '../archive/archive-runtime.js';
import { createArchiveOperationGate } from '../archive/unattended-backups.js';
import { createRemoteBackups } from '../archive/remote-backups.js';
import { createS3RemoteBackupTransport } from '../archive/remote-backup-s3.js';
import { createRestoreDrills } from '../archive/restore-drills.js';
import { createRestoreDrillStore, restoreDrillActive, restoreDrillLedgerPath, restoreDrillScratchPath } from '../archive/restore-drill-store.js';
import { makeArchiveHandlers } from '../archive/archive-handler.js';
import { createEncryptedBlobStore, resolveBlobObjectPath } from '../storage/blob-store.js';
import { createRpcDispatcher } from '../rpc-dispatcher.js';
import { createBackgroundServiceRegistry } from '../composition/bin/wire-background-services.js';
import { bootRestoreDrills } from '../composition/data/scheduler/restore-drills/boot.js';
import { createRemoteBackupS3Fixture, REMOTE_FIXTURE_ACCESS, REMOTE_FIXTURE_SECRET } from './helpers/remote-backup-s3-fixture.js';
import * as worker from '../archive/restore-drill-worker.js';
import * as durableFs from '../durable-fs.js';
import * as fsPromises from 'node:fs/promises';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rm: vi.fn(actual.rm), statfs: vi.fn(actual.statfs) };
});

const cleanup: (() => void | Promise<void>)[] = [];
// Real encrypted restore/key derivation competes with other builds and suite
// workers on shared hosts. This bounds fixture completion, not product latency;
// worker deadline and cancellation behavior have separate process tests.
// ⚠ 60 s → 180 s (2026-10-23): three drills of one sweep each gave up at 60 s still
// `checking` — working, not stuck — while their whole cases take 11-30 s alone.
const DRILL_SETTLE_TIMEOUT_MS = 180_000;
// A case waits for at most two drills, so its bound outlasts both settle waits and the
// wait, not the case, is what reports a slow drill (with the row it last saw).
const DRILL_CASE_TIMEOUT_MS = 2 * DRILL_SETTLE_TIMEOUT_MS + 120_000;
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
const setup = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'restore-drill-')), dbPath = join(dir, 'server.db');
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = await openDatabase(dbPath, { databaseKey: null }); cleanup.push(() => { if (db.open) db.close(); });
  const bundleStore = createServerBundleStore(dbPath), mnemonic = generateRecoveryKey().mnemonic;
  const keys = createKeyManager({ loadBundle: () => null, saveBundle: () => {}, loadServerBundle: () => bundleStore.load(), saveServerBundle: b => bundleStore.save(b) });
  await keys.initServerVault({ recoveryKey: mnemonic, serverKey: generateServerKey() }); cleanup.push(() => keys.lock());
  rekeyDatabase(db, keys.getSubDEK('database')); db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE example (v TEXT); INSERT INTO example VALUES ('original');
    CREATE TABLE cache_entries (key TEXT PRIMARY KEY, blob_hash TEXT);
    CREATE TABLE shared_store (key TEXT PRIMARY KEY, blob_hash TEXT);
    CREATE TABLE user_memory (key TEXT PRIMARY KEY, data TEXT NOT NULL);`);
  const blobKey = keys.getSubDEK('blob-store'); cleanup.push(() => { blobKey.fill(0); });
  const blobs: { root: string; hash: string; bytes: Buffer }[] = [];
  for (const [root, size] of [['blobs', 3000], ['cache_blobs', 120_000], ['memory_blobs', 90_000]] as const) {
    const bytes = randomBytes(size), hash = await createEncryptedBlobStore(join(dir, root), () => blobKey).put(bytes);
    blobs.push({ root, bytes, hash });
    if (root === 'blobs') db.prepare('INSERT INTO shared_store VALUES (?, ?)').run('fixture', hash);
    else if (root === 'cache_blobs') db.prepare('INSERT INTO cache_entries VALUES (?, ?)').run('fixture', hash);
    else db.prepare('INSERT INTO user_memory VALUES (?, ?)').run('fixture', JSON.stringify({ blob_hash: hash }));
  }
  const restart = vi.fn(), runtime = createArchiveRuntime({ db, dbPath, dataPath: dir, configPath: null, serverVersion: '0.2.0', getKeys: () => keys, requestRestart: restart });
  const s3 = await createRemoteBackupS3Fixture(); cleanup.push(() => s3.close());
  const fingerprint = createHash('sha256').update(s3.endpoint).digest('hex');
  const destination = { connection_name: 'safe', destination_id: fingerprint, bucket: 'backup-bucket', region: 'us-east-1', endpoint: s3.endpoint, prefix: '' };
  const transport = createS3RemoteBackupTransport({ config: { access_key: REMOTE_FIXTURE_ACCESS, secret_key: REMOTE_FIXTURE_SECRET, bucket: destination.bucket, region: destination.region, endpoint: s3.endpoint }, assertCurrent: () => {} });
  let changed = false;
  const remote = createRemoteBackups({ dbPath, destinations: () => [destination], describe: () => ({ destination, fingerprint }),
    resolve: async () => ({ destination, fingerprint: changed ? 'f'.repeat(64) : fingerprint, transport }) });
  const gate = createArchiveOperationGate(), options = { dbPath, remoteBackups: remote, gate, serverVersion: '0.2.0' };
  const service = createRestoreDrills(options); cleanup.push(() => service.stop());
  const publish = async (delegated = false, includeBlobs = true) => {
    const backupId = randomUUID(); remote.reserve({ operation_id: backupId, connection_name: 'safe', destination_id: fingerprint, keep_last: 5 }, `arx-${backupId}`);
    let artifact;
    if (delegated) {
      const cap = await runtime.prepareUnattendedExport!(mnemonic);
      try { artifact = await runtime.runUnattendedExport!(cap); } finally { cap.key.fill(0); }
    } else artifact = await runtime.runExport({ includeBlobs, includePassport: false, recoveryKey: mnemonic });
    await remote.publish(backupId, artifact); return backupId;
  };
  const start = (backupId: string, words = mnemonic) => service.start({ operation_id: randomUUID(), backup_operation_id: backupId, recoveryKey: words });
  const settled = async (id: string) => {
    await vi.waitFor(() => expect(service.list().find(row => row.operation_id === id)).toSatisfy((row: ArchiveRestoreDrill) => !restoreDrillActive(row)), { timeout: DRILL_SETTLE_TIMEOUT_MS });
    return service.list().find(row => row.operation_id === id)!;
  };
  return { dir, dbPath, db, keys, mnemonic, blobs, runtime, remote, s3, gate, service, options, restart, publish, start, settled,
    changed: () => { changed = true; } };
};

describe('isolated recovery drills', { timeout: DRILL_CASE_TIMEOUT_MS }, () => {
  for (const delegated of [false, true]) it(`recovers ${delegated ? 'unattended v4' : 'manual v3'} S3 bytes, checks every root and local boot key, removes the realm, and keeps live data intact`, async () => {
    const h = await setup(), backupId = await h.publish(delegated);
    h.db.exec("INSERT INTO example VALUES ('live change')");
    const bundle = readFileSync(resolveServerBundlePath(h.dbPath));
    const liveBlobs = h.blobs.map(b => readFileSync(resolveBlobObjectPath(join(h.dir, b.root), b.hash)));
    const row = h.start(backupId), done = await h.settled(row.operation_id);
    expect(done).toMatchObject({ state: 'succeeded', backup_operation_id: backupId, archive_sha256: h.remote.receipt(backupId).sha256,
      checks: { version: 1, database_integrity: 'ok', foreign_keys: 'ok', local_boot_key: 'ok', referenced_blobs: 3, restored_blob_records: 3, blob_bytes: 213_000 } });
    expect(h.db.prepare('SELECT v FROM example ORDER BY rowid').all()).toEqual([{ v: 'original' }, { v: 'live change' }]);
    expect(readFileSync(resolveServerBundlePath(h.dbPath))).toEqual(bundle);
    expect(existsSync(resolveIdentityKeysPath(h.dbPath))).toBe(false); expect(h.restart).not.toHaveBeenCalled();
    h.blobs.forEach((b, i) => expect(readFileSync(resolveBlobObjectPath(join(h.dir, b.root), b.hash))).toEqual(liveBlobs[i]));
    expect(readdirSync(restoreDrillScratchPath(h.dbPath))).toEqual([]);
    const saved = readFileSync(restoreDrillLedgerPath(h.dbPath), 'utf8'), raw = recoveryKeyToEntropy(h.mnemonic);
    expect(saved).not.toContain(h.mnemonic); expect(saved).not.toContain(Buffer.from(raw).toString('hex')); raw.fill(0);
    expect(saved).not.toContain(h.dir); expect(saved).not.toContain('live change');
    expect(statSync(restoreDrillLedgerPath(h.dbPath)).mode & 0o777).toBe(0o600);
    const reboot = createRestoreDrills(h.options); cleanup.push(() => reboot.stop()); expect(reboot.list()).toEqual(h.service.list());
  });

  it('fails on wrong words, ignores a cached retrieval, and detects newly corrupt remote bytes', async () => {
    const h = await setup(), backupId = await h.publish(); await h.remote.retrieve(backupId);
    expect((await h.settled(h.start(backupId, generateRecoveryKey().mnemonic).operation_id)).issue).toBe('restore_failed');
    const gets = h.s3.calls.filter(c => c.method === 'GET').length;
    h.s3.faults.corruptRead = true;
    expect(await h.settled(h.start(backupId).operation_id)).toMatchObject({ state: 'failed', issue: 'retrieval_failed' });
    expect(h.s3.calls.filter(c => c.method === 'GET').length).toBe(gets + 1);
    expect(readdirSync(restoreDrillScratchPath(h.dbPath))).toEqual([]); expect(h.restart).not.toHaveBeenCalled();
  });

  it('refuses a missing or changed destination and does not claim a DB-only archive recovers referenced blobs', async () => {
    const h = await setup(), backupId = await h.publish(false, false);
    expect(await h.settled(h.start(backupId).operation_id)).toMatchObject({ state: 'failed', issue: 'integrity_failed' });
    h.changed();
    expect((await h.settled(h.start(backupId).operation_id)).issue).toBe('retrieval_failed');
  });

  it('detects foreign-key violations after restoring the database', async () => {
    const h = await setup(); h.db.pragma('foreign_keys = OFF');
    h.db.exec('CREATE TABLE drill_parent (id INTEGER PRIMARY KEY); CREATE TABLE drill_child (id INTEGER REFERENCES drill_parent(id)); INSERT INTO drill_child VALUES (4)');
    const backupId = await h.publish();
    expect(await h.settled(h.start(backupId).operation_id)).toMatchObject({ state: 'failed', issue: 'integrity_failed' });
  });

  it('re-reads recovered ciphertext and fails when a recovered blob is damaged before its checks', async () => {
    const h = await setup(), backupId = await h.publish(), run = worker.runRestoreDrillWorker;
    vi.spyOn(worker, 'runRestoreDrillWorker').mockImplementation(args => run({ ...args, onChecking: async () => {
      await args.onChecking(); const b = h.blobs[0]!;
      const path = resolveBlobObjectPath(join(args.dataPath, b.root), b.hash), bytes = readFileSync(path); bytes[bytes.length - 1]! ^= 1; writeFileSync(path, bytes);
    } }));
    expect(await h.settled(h.start(backupId).operation_id)).toMatchObject({ state: 'failed', issue: 'integrity_failed' });
    expect(readdirSync(restoreDrillScratchPath(h.dbPath))).toEqual([]);
  });

  it('holds the shared archive slot, never replays identifiers, and drains admitted work on maintenance', async () => {
    const h = await setup(), backupId = await h.publish(); let release = () => {}, enter = () => {};
    const held = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { enter = resolve; });
    const retrieve = h.remote.retrieveForDrill;
    vi.spyOn(h.remote, 'retrieveForDrill').mockImplementation(async (...args) => { enter(); await held; return retrieve(...args); });
    const row = h.start(backupId); await entered;
    expect(() => h.start(backupId)).toThrow();
    const registry = createBackgroundServiceRegistry();
    const slot = bootRestoreDrills({ registry, restoreDrills: h.service })!;
    let stopped = false; const stop = registry.stopAll({ kind: 'scheduler' }).then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false);
    expect(() => h.start(backupId)).toThrow('maintenance');
    release(); await stop; expect(stopped).toBe(true); expect(h.service.list()[0]).toMatchObject({ state: 'failed', issue: 'stopped' });
    slot.rebuild!();
    expect(() => h.service.start({ operation_id: row.operation_id, backup_operation_id: backupId, recoveryKey: h.mnemonic })).toThrow('already used');
    const gateRelease = h.gate.acquire(); gateRelease();
  });

  it('records cleanup failure without a success receipt, retries precise cleanup on boot, and leaves unrelated folders', async () => {
    const h = await setup(), backupId = await h.publish(), remove = fsPromises.rm;
    vi.mocked(fsPromises.rm).mockRejectedValueOnce(new Error('synthetic cleanup failure'));
    const row = await h.settled(h.start(backupId).operation_id);
    expect(row).toMatchObject({ state: 'failed', issue: 'cleanup_failed', cleanup_pending: true }); expect(row.checks).toBeUndefined();
    expect(fsPromises.rm).toBe(remove);
    const foreign = join(restoreDrillScratchPath(h.dbPath), randomUUID()); mkdirSync(foreign); writeFileSync(join(foreign, 'keep'), 'unrelated');
    const reboot = createRestoreDrills(h.options); cleanup.push(() => reboot.stop());
    expect(reboot.list()[0]?.cleanup_pending).toBeUndefined(); expect(existsSync(join(restoreDrillScratchPath(h.dbPath), row.operation_id))).toBe(false);
    expect(reboot.list()[0]).toMatchObject({ issue: row.issue, finished_at: row.finished_at, cleanup_completed_at: expect.any(Number) });
    expect(readFileSync(join(foreign, 'keep'), 'utf8')).toBe('unrelated');
  });

  it('persists exact cancellation before aborting a download, holds the gate until settlement, and leaves later tests alone', async () => {
    const h = await setup(), backupId = await h.publish();
    let enter = () => {}, release = () => {}, signal: AbortSignal | undefined;
    const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const retrieve = h.remote.retrieveForDrill;
    vi.spyOn(h.remote, 'retrieveForDrill').mockImplementationOnce(async (_id, _path, ownSignal) => {
      signal = ownSignal; enter(); await held; ownSignal!.throwIfAborted();
    });
    const row = h.start(backupId); await entered;
    const write = durableFs.writeFileAtomicSync;
    const failWrite = vi.spyOn(durableFs, 'writeFileAtomicSync').mockImplementation((path, bytes) => {
      if (path === restoreDrillLedgerPath(h.dbPath) && String(bytes).includes('cancel_requested_at')) throw new Error('synthetic intent write failure');
      write(path, bytes);
    });
    try {
      expect(() => h.service.cancel({ operation_id: row.operation_id })).toThrow(); expect(signal?.aborted).toBe(false);
      failWrite.mockRestore();
      signal!.addEventListener('abort', () => expect(createRestoreDrillStore(h.dbPath).rows()[0]?.cancel_requested_at).toEqual(expect.any(Number)), { once: true });
      const requested = h.service.cancel({ operation_id: row.operation_id });
      expect(requested).toMatchObject({ state: 'retrieving', cancel_requested_at: expect.any(Number) });
      expect(h.service.cancel({ operation_id: row.operation_id })).toEqual(requested);
      expect(signal?.aborted).toBe(true); expect(() => h.gate.acquire()).toThrow();
      expect(() => h.service.retryCleanup({ operation_id: row.operation_id })).toThrow('finish');
      release();
      const done = await h.settled(row.operation_id); expect(done).toMatchObject({ state: 'failed', issue: 'cancelled' }); expect(done.checks).toBeUndefined();
      expect(readdirSync(restoreDrillScratchPath(h.dbPath))).toEqual([]);
      let nextEnter = () => {}, nextRelease = () => {};
      const nextEntered = new Promise<void>(resolve => { nextEnter = resolve; }), nextHeld = new Promise<void>(resolve => { nextRelease = resolve; });
      vi.spyOn(h.remote, 'retrieveForDrill').mockImplementationOnce(async (...args) => { nextEnter(); await nextHeld; return retrieve(...args); });
      const next = h.start(backupId);
      try {
        await nextEntered;
        expect(h.service.cancel({ operation_id: row.operation_id })).toEqual(done);
        expect(h.service.list().find(r => r.operation_id === next.operation_id)?.cancel_requested_at).toBeUndefined();
      } finally { nextRelease(); }
      expect((await h.settled(next.operation_id)).state).toBe('succeeded');
    } finally { failWrite.mockRestore(); release(); }
  });

  it('lets the owner cancel a real checking worker without pausing admission or saving words', async () => {
    const h = await setup(), backupId = await h.publish(true), run = worker.runRestoreDrillWorker;
    let entered = () => {}, release = () => {};
    const checking = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(worker, 'runRestoreDrillWorker').mockImplementationOnce(args => run({ ...args, onChecking: async () => {
      await args.onChecking(); entered(); await held;
    } }));
    const row = h.start(backupId);
    try {
      await checking; h.service.cancel({ operation_id: row.operation_id });
      const done = await h.settled(row.operation_id);
      expect(done).toMatchObject({ state: 'failed', issue: 'cancelled', cancel_requested_at: expect.any(Number) });
      expect(done.checks).toBeUndefined(); expect(readdirSync(restoreDrillScratchPath(h.dbPath))).toEqual([]);
      expect(readFileSync(restoreDrillLedgerPath(h.dbPath), 'utf8')).not.toContain(h.mnemonic);
      expect((await h.settled(h.start(backupId).operation_id)).state).toBe('succeeded');
    } finally { release(); }
  });

  it('honours a cancellation accepted during cleanup rather than publishing the completed checks as success', async () => {
    const h = await setup(), backupId = await h.publish(), remove = fsPromises.rm;
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let entered = () => {}, release = () => {};
    const cleaning = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(remove).mockImplementationOnce(async (...args) => { entered(); await held; return actual.rm(...args); });
    const row = h.start(backupId);
    try {
      await cleaning; expect(h.service.list()[0]?.state).toBe('cleaning');
      h.service.cancel({ operation_id: row.operation_id }); expect(() => h.gate.acquire()).toThrow();
      release(); const done = await h.settled(row.operation_id);
      expect(done).toMatchObject({ state: 'failed', issue: 'cancelled' }); expect(done.checks).toBeUndefined();
    } finally { release(); }
  });

  it('retries only the chosen pending cleanup, coalesces repeats, drains on maintenance, and preserves the failure', async () => {
    const h = await setup(), backupId = await h.publish();
    vi.mocked(fsPromises.rm).mockRejectedValueOnce(new Error('synthetic cleanup failure'));
    const row = await h.settled(h.start(backupId).operation_id), root = restoreDrillScratchPath(h.dbPath);
    const foreign = join(root, randomUUID()); mkdirSync(foreign); writeFileSync(join(foreign, 'keep'), 'unrelated');
    expect(() => h.service.retryCleanup({ operation_id: randomUUID() })).toThrow('not in the saved history');
    expect(() => h.service.retryCleanup({ operation_id: '../escape' })).toThrow('operation identifier');
    const releaseGate = h.gate.acquire();
    expect(() => h.service.retryCleanup({ operation_id: row.operation_id })).toThrow('already running'); releaseGate();
    vi.mocked(fsPromises.rm).mockRejectedValueOnce(new Error('still cannot remove'));
    expect(await h.service.retryCleanup({ operation_id: row.operation_id })).toEqual(row);
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(fsPromises.rm).mockImplementationOnce(async (...args) => { await held; return actual.rm(...args); });
    const retry = h.service.retryCleanup({ operation_id: row.operation_id });
    expect(h.service.retryCleanup({ operation_id: row.operation_id })).toBe(retry);
    expect(() => h.gate.acquire()).toThrow();
    let stopped = false; const stop = h.service.stop().then(() => { stopped = true; });
    try {
      await Promise.resolve(); expect(stopped).toBe(false); release();
      const done = await retry; await stop;
      expect(done).toMatchObject({ state: 'failed', issue: row.issue, cleanup_completed_at: expect.any(Number) }); expect(done.cleanup_pending).toBeUndefined();
      expect(done.checks).toBeUndefined(); expect(done.finished_at).toBe(row.finished_at);
      expect(await h.service.retryCleanup({ operation_id: row.operation_id })).toEqual(done);
      expect(existsSync(join(root, row.operation_id))).toBe(false); expect(readFileSync(join(foreign, 'keep'), 'utf8')).toBe('unrelated');
      h.service.resume(); expect((await h.settled(h.start(backupId).operation_id)).state).toBe('succeeded');
    } finally { release(); }
  });

  it('stops a real recovery worker before cleanup and keeps the archive gate until it has exited', async () => {
    const h = await setup(), backupId = await h.publish(), run = worker.runRestoreDrillWorker;
    let entered = () => {}, release = () => {};
    const checking = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(worker, 'runRestoreDrillWorker').mockImplementation(args => run({ ...args, onChecking: async () => {
      await args.onChecking(); entered(); await held;
    } }));
    const row = h.start(backupId);
    try {
      await checking;
      const dir = join(restoreDrillScratchPath(h.dbPath), row.operation_id);
      expect(existsSync(join(dir, 'worker.json'))).toBe(true); expect(() => h.gate.acquire()).toThrow();
      await h.service.stop();
      expect(h.service.list()[0]).toMatchObject({ state: 'failed', issue: 'stopped' }); expect(existsSync(dir)).toBe(false);
      const gateRelease = h.gate.acquire(); gateRelease(); expect(h.restart).not.toHaveBeenCalled();
    } finally { release(); }
  });

  it('does not adopt or remove a pre-existing operation directory on a new request', async () => {
    const h = await setup(), backupId = await h.publish(), id = randomUUID();
    const foreign = join(restoreDrillScratchPath(h.dbPath), id); mkdirSync(foreign, { recursive: true }); writeFileSync(join(foreign, 'keep'), 'unrelated');
    expect(() => h.service.start({ operation_id: id, backup_operation_id: backupId, recoveryKey: h.mnemonic })).toThrow('already exists');
    expect(h.service.list()).toEqual([]); expect(readFileSync(join(foreign, 'keep'), 'utf8')).toBe('unrelated');
    const release = h.gate.acquire(); release();
  });

  it('blocks low space before retrieval and leaves the live database usable', async () => {
    const h = await setup(), backupId = await h.publish(), actual = await fsPromises.statfs(h.dir);
    vi.mocked(fsPromises.statfs).mockResolvedValueOnce({ ...actual, bavail: 0 } as never);
    const gets = h.s3.calls.length;
    expect(await h.settled(h.start(backupId).operation_id)).toMatchObject({ state: 'failed', issue: 'insufficient_storage' });
    expect(h.s3.calls).toHaveLength(gets); expect(h.db.prepare('SELECT count(*) n FROM example').get()).toEqual({ n: 1 });
  });

  it('keeps a settlement write failure uncertain and marks it interrupted after boot without replaying', async () => {
    const h = await setup(), backupId = await h.publish(), write = durableFs.writeFileAtomicSync;
    const spy = vi.spyOn(durableFs, 'writeFileAtomicSync').mockImplementation((path, bytes) => {
      if (path === restoreDrillLedgerPath(h.dbPath) && String(bytes).includes('"succeeded"')) throw new Error('synthetic settlement failure');
      write(path, bytes);
    });
    const row = h.start(backupId); await vi.waitFor(() => expect(h.service.list()[0]?.state).toBe('cleaning'), { timeout: DRILL_SETTLE_TIMEOUT_MS }); await h.service.stop();
    spy.mockRestore(); const calls = h.s3.calls.length;
    const reboot = createRestoreDrills(h.options); cleanup.push(() => reboot.stop());
    expect(reboot.list()[0]).toMatchObject({ operation_id: row.operation_id, state: 'failed', issue: 'interrupted' }); expect(h.s3.calls).toHaveLength(calls);
  });

  it('wires owner-only RPC methods and makes receipt polling idle-exempt', async () => {
    const h = await setup(), backupId = await h.publish();
    const { slice } = makeArchiveHandlers({ runtime: h.runtime, remoteBackups: h.remote, restoreDrills: h.service, dataPath: h.dir, operationGate: h.gate });
    expect(slice?.methods).toEqual(expect.arrayContaining(['server.archive.drills', 'server.archive.drill.start', 'server.archive.drill.cancel', 'server.archive.drill.cleanup', 'server.archive.unattended.get', 'server.archive.unattended.save']));
    const touchActivity = vi.fn(), dispatch = createRpcDispatcher<ServerRpcRegistry, never>(slice!.handlers, { touchActivity });
    expect((await dispatch('server.archive.drills', {}, {} as never)).ok).toBe(true); expect(touchActivity).not.toHaveBeenCalled();
    const row = await slice!.handlers['server.archive.drill.start']!({ operation_id: randomUUID(), backup_operation_id: backupId, recoveryKey: h.mnemonic }, {} as never);
    expect((await h.settled(row.operation_id)).state).toBe('succeeded');
    for (const method of ['server.archive.drill.cancel', 'server.archive.drill.cleanup'] as const) {
      expect(await slice!.handlers[method]!({ operation_id: row.operation_id }, {} as never)).toMatchObject({ state: 'succeeded' });
      expect((await dispatch(method, { operation_id: row.operation_id }, {} as never)).ok).toBe(true);
    }
    expect(touchActivity).toHaveBeenCalledTimes(2);
    for (const method of ['server.archive.drills', 'server.archive.drill.start', 'server.archive.drill.cancel', 'server.archive.drill.cleanup']) { expect(isReservedLocalRpc(method)).toBe(true); expect(MCP_TOOL_CATALOG).not.toContain(method); }
    const deps = composeArchiveRpcDeps({ db: h.db, dbPath: h.dbPath, configPath: null, serverVersion: '0.2.0', lifecycle: { machine: { state: 'running' } } as never, getKeys: () => h.keys });
    expect(deps?.restoreDrills).toBeDefined(); await deps?.restoreDrills?.stop(); await deps?.unattendedBackups?.stop();
  });
});

describe('recovery drill history boundaries', () => {
  it('keeps cancellation intent through boot reconciliation, and never calls an interrupted test a pass', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'drill-cancel-boot-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const dbPath = join(dir, 'server.db'), store = createRestoreDrillStore(dbPath), row: ArchiveRestoreDrill = {
      operation_id: randomUUID(), backup_operation_id: randomUUID(), destination_id: 'a'.repeat(64), archive_sha256: 'b'.repeat(64),
      archive_bytes: 4, started_at: 1, state: 'cleaning', cancel_requested_at: 2,
    };
    store.reserve(row); const root = restoreDrillScratchPath(dbPath); mkdirSync(join(root, row.operation_id), { recursive: true });
    const service = createRestoreDrills({ dbPath, remoteBackups: {} as never, gate: createArchiveOperationGate(), serverVersion: '0.2.0' }); cleanup.push(() => service.stop());
    expect(service.list()[0]).toMatchObject({ state: 'failed', issue: 'cancelled', cancel_requested_at: 2 });
    expect(await service.retryCleanup({ operation_id: row.operation_id })).toEqual(service.list()[0]);
  });

  it('refuses cleanup of a live or invalid worker marker, retries after it is removed, and survives a lost settlement write', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'drill-cleanup-retry-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const dbPath = join(dir, 'server.db'), root = restoreDrillScratchPath(dbPath), store = createRestoreDrillStore(dbPath);
    let canRun = false;
    const service = createRestoreDrills({ dbPath, remoteBackups: {} as never, gate: createArchiveOperationGate(), serverVersion: '0.2.0', canRun: () => canRun }); cleanup.push(() => service.stop());
    const row: ArchiveRestoreDrill = { operation_id: randomUUID(), backup_operation_id: randomUUID(), destination_id: 'a'.repeat(64), archive_sha256: 'b'.repeat(64),
      archive_bytes: 4, started_at: 1, state: 'failed', issue: 'cleanup_failed', finished_at: 2, cleanup_pending: true };
    store.reserve(row); const path = join(root, row.operation_id); mkdirSync(path, { recursive: true });
    const marker = join(path, 'worker.json'); writeFileSync(marker, JSON.stringify({ v: 1, pid: process.pid }));
    expect(() => service.retryCleanup({ operation_id: row.operation_id })).toThrow('maintenance'); canRun = true;
    expect(await service.retryCleanup({ operation_id: row.operation_id })).toEqual(row); expect(existsSync(marker)).toBe(true);
    writeFileSync(marker, '{broken'); expect(await service.retryCleanup({ operation_id: row.operation_id })).toEqual(row);
    rmSync(marker);
    const write = durableFs.writeFileAtomicSync;
    const failWrite = vi.spyOn(durableFs, 'writeFileAtomicSync').mockImplementation((path, bytes) => {
      if (path === restoreDrillLedgerPath(dbPath) && String(bytes).includes('cleanup_completed_at')) throw new Error('synthetic cleanup settlement failure');
      write(path, bytes);
    });
    const retry = service.retryCleanup({ operation_id: row.operation_id }), stopped = service.stop();
    await expect(retry).rejects.toThrow(); await expect(stopped).resolves.toBeUndefined();
    failWrite.mockRestore(); service.resume(); expect(existsSync(path)).toBe(false); expect(service.list()[0]).toEqual(row);
    const done = await service.retryCleanup({ operation_id: row.operation_id });
    expect(done).toMatchObject({ state: 'failed', issue: 'cleanup_failed', finished_at: 2, cleanup_completed_at: expect.any(Number) });
    expect(done.cleanup_pending).toBeUndefined(); expect(done.checks).toBeUndefined();
    expect(() => service.cancel({ operation_id: '../escape' })).toThrow('operation identifier');
    expect(() => service.cancel({ operation_id: randomUUID() })).toThrow('not in the saved history');
  });

  it('reclaims interrupted work by its exact receipt and refuses a symlinked scratch root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'drill-interruption-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const dbPath = join(dir, 'server.db'), root = restoreDrillScratchPath(dbPath), store = createRestoreDrillStore(dbPath);
    const row: ArchiveRestoreDrill = { operation_id: randomUUID(), backup_operation_id: randomUUID(), destination_id: 'a'.repeat(64),
      archive_sha256: 'b'.repeat(64), archive_bytes: 4, started_at: 1, state: 'restoring' };
    store.reserve(row); const path = join(root, row.operation_id); mkdirSync(path, { recursive: true }); writeFileSync(join(path, 'partial.tmp'), 'partial recovery bytes');
    const options = { dbPath, remoteBackups: {} as never, gate: createArchiveOperationGate(), serverVersion: '0.2.0' };
    const reboot = createRestoreDrills(options); cleanup.push(() => reboot.stop());
    expect(reboot.list()[0]).toMatchObject({ state: 'failed', issue: 'interrupted' }); expect(existsSync(path)).toBe(false);
    // The directory pointed at by a symlink is never cleanup authority.
    rmSync(root, { recursive: true }); const target = join(dir, 'foreign'); mkdirSync(target); writeFileSync(join(target, 'keep'), 'unrelated');
    symlinkSync(target, root, 'dir');
    store.update(row.operation_id, current => { current.state = 'restoring'; delete current.issue; delete current.finished_at; });
    const linked = createRestoreDrills(options); cleanup.push(() => linked.stop());
    expect(linked.list()[0]).toMatchObject({ state: 'failed', issue: 'cleanup_failed', cleanup_pending: true });
    expect(readFileSync(join(target, 'keep'), 'utf8')).toBe('unrelated');
  });

  it('refuses corrupt, oversized, or secret-bearing history, and never recycles identifiers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'drill-ledger-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const dbPath = join(dir, 'server.db'), path = restoreDrillLedgerPath(dbPath), store = createRestoreDrillStore(dbPath, 1);
    const row: ArchiveRestoreDrill = { operation_id: randomUUID(), backup_operation_id: randomUUID(), destination_id: 'a'.repeat(64),
      archive_sha256: 'b'.repeat(64), archive_bytes: 4, started_at: 1, finished_at: 2, state: 'failed', issue: 'interrupted' };
    store.reserve(row); expect(() => store.reserve(row)).toThrow(); expect(() => store.reserve({ ...row, operation_id: randomUUID() })).toThrow();
    const valid = readFileSync(path, 'utf8');
    for (const invalid of ['{broken', JSON.stringify({ v: 1, drills: [{ ...row, recoveryKey: 'secret' }] }),
      JSON.stringify({ v: 1, drills: [{ ...row, state: 'succeeded', issue: undefined }] }),
      ...[{ cancel_requested_at: -1 }, { cancel_requested_at: 'secret' }, { cleanup_pending: true, cleanup_completed_at: 3 },
        { state: 'restoring', finished_at: undefined, issue: undefined, cleanup_completed_at: 3 }, { issue: 'cancelled' }]
        .map(extra => JSON.stringify({ v: 1, drills: [{ ...row, ...extra }] })), ' '.repeat(4 * 1024 * 1024 + 1)]) {
      writeFileSync(path, invalid); expect(() => store.rows()).toThrow(); expect(readFileSync(path, 'utf8')).toBe(invalid);
    }
    writeFileSync(path, valid); expect(store.rows()).toEqual([row]);
  });
});
