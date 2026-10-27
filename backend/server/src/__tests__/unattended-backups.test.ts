import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServerBundle, generateRecoveryKey, generateServerKey, recoveryKeyToEntropy } from '@recued/crypto';
import type { ArchiveUnattendedSettings, ArchiveRemoteDestination } from '@recued/contracts';
import { openDatabase, rekeyDatabase } from '../open-database.js';
import { createKeyManager } from '../key-manager.js';
import { createServerBundleStore } from '../server-bundle-store.js';
import { createArchiveRuntime } from '../archive/archive-runtime.js';
import { createArchiveOperationGate, createUnattendedBackups, nextBackupTime, unattendedBackupPath } from '../archive/unattended-backups.js';
import { createRemoteBackups } from '../archive/remote-backups.js';
import { createS3RemoteBackupTransport } from '../archive/remote-backup-s3.js';
import { makeArchiveHandlers } from '../archive/archive-handler.js';
import { createEncryptedBlobStore } from '../storage/blob-store.js';
import { deriveArchiveKeys, deriveArchiveBackupRoot } from '../archive/archive-crypto.js';
import { createBackgroundServiceRegistry } from '../composition/bin/wire-background-services.js';
import { bootUnattendedBackups } from '../composition/data/scheduler/unattended-backups/boot.js';
import { createRemoteBackupS3Fixture, REMOTE_FIXTURE_ACCESS, REMOTE_FIXTURE_SECRET } from './helpers/remote-backup-s3-fixture.js';
import * as durableFs from '../durable-fs.js';
import { STOP_GRACE_MS } from '../lifecycle/settle-within.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const setup = async (opts: { fetchImpl?: typeof fetch } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'unattended-')), dbPath = join(dir, 'server.db');
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = await openDatabase(dbPath, { databaseKey: null }); cleanup.push(() => { if (db.open) db.close(); });
  const bundleStore = createServerBundleStore(dbPath), mnemonic = generateRecoveryKey().mnemonic;
  const keys = createKeyManager({ loadBundle: () => null, saveBundle: () => {}, loadServerBundle: () => bundleStore.load(), saveServerBundle: bundle => bundleStore.save(bundle) });
  const serverKey = generateServerKey(); await keys.initServerVault({ recoveryKey: mnemonic, serverKey }); cleanup.push(() => keys.lock());
  rekeyDatabase(db, keys.getSubDEK('database')); db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE example (v TEXT); INSERT INTO example VALUES (\'original\'); CREATE TABLE cache_entries (key TEXT PRIMARY KEY, blob_hash TEXT);');
  const blobKey = keys.getSubDEK('blob-store'); cleanup.push(() => { blobKey.fill(0); });
  const blobStore = createEncryptedBlobStore(join(dir, 'cache_blobs'), () => blobKey);
  const blob = Buffer.from('scheduled backup blob'), hash = await blobStore.put(blob);
  db.prepare('INSERT INTO cache_entries VALUES (?, ?)').run('fixture', hash);
  let at = Date.UTC(2026, 9, 20, 1), onDrained: ((ok: boolean) => Promise<void>) | undefined;
  const runtime = createArchiveRuntime({ db, dbPath, dataPath: dir, configPath: null, serverVersion: '0.2.0', getKeys: () => keys,
    now: () => at, requestRestart: callback => { onDrained = callback; } });
  const s3 = await createRemoteBackupS3Fixture(); cleanup.push(() => s3.close());
  const fingerprint = createHash('sha256').update(s3.endpoint).digest('hex');
  let destination: ArchiveRemoteDestination = { connection_name: 'safe', destination_id: fingerprint, bucket: 'backup-bucket', region: 'us-east-1', endpoint: s3.endpoint, prefix: '' };
  const transport = createS3RemoteBackupTransport({ config: { access_key: REMOTE_FIXTURE_ACCESS, secret_key: REMOTE_FIXTURE_SECRET,
    bucket: destination.bucket, region: destination.region, endpoint: s3.endpoint }, assertCurrent: () => {},
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
  const remoteOptions = { dbPath, now: () => at, destinations: () => [destination], describe: () => ({ destination, fingerprint: destination.destination_id }),
    resolve: async () => ({ destination, fingerprint: destination.destination_id, transport }) };
  const remote = createRemoteBackups(remoteOptions), gate = createArchiveOperationGate();
  const notify = vi.fn(async () => true);
  const options = { dbPath, runtime, remoteBackups: remote, gate, getEncryptionKey: () => keys.keyProvider('archive-backup')(), now: () => at, notify };
  const service = createUnattendedBackups(options); cleanup.push(() => service.stop());
  const settings: ArchiveUnattendedSettings = { enabled: true, connection_name: 'safe', destination_id: fingerprint, keep_last: 1,
    schedule: { cadence: 'daily', hour_utc: 2, minute_utc: 0, weekday_utc: 0 } };
  const due = () => { at = service.status().next_run_at!; };
  return { dir, dbPath, db, runtime, keys, serverKey, mnemonic, s3, remote, remoteOptions, gate, service, settings, notify, options, due, blobStore, blob, hash,
    advance: (ms: number) => { at += ms; }, changed: () => { destination = { ...destination, destination_id: 'f'.repeat(64) }; },
    commit: async () => { if (!onDrained) throw new Error('Missing restart callback'); await onDrained(true); } };
};

describe('unattended encrypted backups', () => {
  it('keeps scheduled backups moving while a prior failure alert is stalled, and drains the alert at shutdown', async () => {
    const h = await setup(); await h.service.save(h.settings, h.mnemonic);
    h.s3.faults.corruptRead = true; h.notify.mockResolvedValue(false); h.due(); await h.service.tick();
    await vi.waitFor(() => expect(h.service.status().alert_pending).toBe(true));
    let release = () => {}, enter = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { enter = resolve; });
    h.notify.mockImplementationOnce(async () => { enter(); await held; return true; });
    h.advance(3_600_000); const retry = h.service.tick(); await entered;
    h.s3.faults.corruptRead = false; h.due(); const next = h.service.tick();
    let stop: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(h.remote.list()).toHaveLength(2), { timeout: 1000 });
      await next;
      expect(h.service.status().last_run?.outcome).toBe('verified');
      let stopped = false; stop = h.service.stop().then(() => { stopped = true; });
      await Promise.resolve(); expect(stopped).toBe(false);
    } finally { release(); await Promise.allSettled([retry, next, stop]); }
    expect(h.service.status().last_run?.outcome).toBe('verified');
    expect(h.service.status().alert_pending).toBeUndefined();
  });

  it('keeps a verified S3 receipt authoritative when the schedule settlement write fails once', async () => {
    const h = await setup(); await h.service.save(h.settings, h.mnemonic); h.due();
    const write = durableFs.writeFileAtomicSync; let injected = false;
    const spy = vi.spyOn(durableFs, 'writeFileAtomicSync').mockImplementation((path, bytes) => {
      if (path === unattendedBackupPath(h.dbPath) && JSON.parse(String(bytes)).last_run?.outcome === 'verified' && !injected) {
        injected = true; throw new Error('fixture transient settlement I/O failure');
      }
      write(path, bytes);
    });
    try {
      await h.service.tick();
      expect(injected).toBe(true); expect(h.remote.list()[0]?.state).toBe('verified');
      expect(h.service.status().last_run?.outcome).toBe('verified');
      expect(h.notify).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it('keeps an overdue slot when only retention settings or JSON field order changes', async () => {
    const h = await setup(); await h.service.save(h.settings, h.mnemonic);
    const due = h.service.status().next_run_at!; h.due(); h.advance(60_000);
    await h.service.save({ ...h.settings, keep_last: 3, schedule: { minute_utc: 0, weekday_utc: 6, hour_utc: 2, cadence: 'daily' } });
    expect(h.service.status().next_run_at).toBe(due);
    await h.service.tick(); expect(h.service.status().last_run?.outcome).toBe('verified');
  });

  it('does not let a delayed alert acknowledgment overwrite new settings or a newer failure', async () => {
    const h = await setup(); await h.service.save(h.settings, h.mnemonic);
    h.s3.faults.corruptRead = true; h.notify.mockResolvedValue(false); h.due(); await h.service.tick();
    let release = () => {}, enter = () => {};
    const held = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { enter = resolve; });
    h.notify.mockImplementationOnce(async () => { enter(); await held; return true; });
    h.advance(3_600_000); await h.service.tick(); await entered;
    try {
      await h.service.save({ ...h.settings, keep_last: 3 });
      h.due(); await h.service.tick();
      expect(h.service.status().settings?.keep_last).toBe(3);
    } finally { release(); await h.service.stop(); }
    expect(h.service.status().settings?.keep_last).toBe(3);
    expect(h.service.status().last_run?.operation_id).toBe(h.remote.list()[0]?.operation_id);
    expect(h.service.status().last_run?.outcome).toBe('failed');
    expect(h.service.status().alert_pending).toBe(true);
  });
  it('sets up once, survives restart, verifies real S3 bytes, retains copies, and restores with only the recovery words', async () => {
    const h = await setup();
    const first = await h.service.save(h.settings, h.mnemonic);
    const persisted = readFileSync(unattendedBackupPath(h.dbPath), 'utf8');
    const entropy = Buffer.from(recoveryKeyToEntropy(h.mnemonic));
    const salt = Buffer.from(JSON.parse(persisted).capability.salt_hex, 'hex');
    const root = deriveArchiveBackupRoot(entropy, salt);
    expect(persisted).not.toContain(h.mnemonic); expect(persisted).not.toContain(entropy.toString('hex'));
    expect(persisted).not.toContain(root.toString('hex')); expect(JSON.stringify(first)).not.toContain('ciphertext');
    expect(statSync(unattendedBackupPath(h.dbPath)).mode & 0o777).toBe(0o600);
    expect(deriveArchiveKeys(entropy, salt)).not.toEqual(deriveArchiveKeys(root, salt)); entropy.fill(0); root.fill(0);
    await h.service.stop(); h.keys.lock(); await h.keys.unlockWithServerKey({ serverKey: h.serverKey });
    const reboot = createUnattendedBackups(h.options); cleanup.push(() => reboot.stop());
    await reboot.save(h.settings); // No words after setup, including changes.
    h.s3.faults.losePutReply = true; // Delivery may succeed even when PUT's reply is lost.
    h.advance(3_600_000); await reboot.tick();
    expect(reboot.status().last_run?.outcome).toBe('verified'); expect(h.s3.objects.size).toBe(1);
    h.advance(24 * 3_600_000); await reboot.tick();
    expect(h.s3.objects.size).toBe(1); expect(h.remote.list().map(row => row.state)).toEqual(['verified', 'pruned']);
    const latest = h.remote.list()[0]!, stage = await h.remote.retrieve(latest.operation_id);
    const path = join(h.dir, 'exports', stage.staged_name);
    expect((await h.runtime.readManifest(path, h.mnemonic)).includes_blobs).toBe(true);
    await expect(h.runtime.readManifest(path, generateRecoveryKey().mnemonic)).rejects.toThrow();
    h.db.exec("INSERT INTO example VALUES ('later')");
    const databaseKey = h.keys.getSubDEK('database');
    await h.runtime.runImport({ path, recoveryKey: h.mnemonic, force: false });
    h.db.close(); await h.commit();
    const restored = await openDatabase(h.dbPath, { databaseKey, readonly: true });
    try { expect(restored.prepare('SELECT v FROM example').all()).toEqual([{ v: 'original' }]); }
    finally { restored.close(); databaseKey.fill(0); }
    expect(await h.blobStore.get(h.hash)).toEqual(h.blob);
  });

  it('records corrupt delivery as failure, preserves its retained copy, and retries a failed notification without re-exporting', async () => {
    const h = await setup(); await h.service.save(h.settings, h.mnemonic); h.due(); await h.service.tick();
    h.s3.faults.corruptRead = true; h.notify.mockResolvedValue(false); h.due(); await h.service.tick();
    expect(h.service.status()).toMatchObject({ alert_pending: true, last_run: { outcome: 'failed', issue: 'verification_failed' } });
    expect(h.s3.objects.size).toBe(2); expect(h.remote.list().at(-1)?.state).toBe('verified');
    const requests = h.s3.calls.length; await h.service.tick(); expect(h.notify).toHaveBeenCalledTimes(1);
    h.advance(3_600_000); h.notify.mockResolvedValue(true); await h.service.tick();
    expect(h.notify).toHaveBeenCalledTimes(2); expect(h.s3.calls).toHaveLength(requests);
    expect(h.service.status().alert_pending).toBeUndefined();
    expect(JSON.stringify(h.notify.mock.calls)).not.toContain(h.mnemonic);
  });

  it('marks an interrupted claim as failed on restart and never replays its upload', async () => {
    const h = await setup(); await h.service.save(h.settings, h.mnemonic);
    const path = unattendedBackupPath(h.dbPath), saved = JSON.parse(readFileSync(path, 'utf8'));
    saved.last_run = { operation_id: randomUUID(), started_at: 1, outcome: 'running' }; writeFileSync(path, JSON.stringify(saved));
    const reboot = createUnattendedBackups(h.options); cleanup.push(() => reboot.stop());
    expect(reboot.status().last_run).toMatchObject({ outcome: 'failed', issue: 'interrupted' });
    await reboot.tick(); expect(h.s3.calls).toHaveLength(0); expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it('serializes ticks with manual exports, and drains admitted work before stopping', async () => {
    const h = await setup(); await h.service.save(h.settings, h.mnemonic); h.due();
    const release = h.gate.acquire(); await h.service.tick(); expect(h.service.status().last_run).toBeUndefined(); release();
    let settle = () => {}, enter = () => {};
    const held = new Promise<void>(resolve => { settle = resolve; }), entered = new Promise<void>(resolve => { enter = resolve; });
    const run = h.runtime.runUnattendedExport!;
    const spy = vi.spyOn(h.runtime, 'runUnattendedExport').mockImplementation(async capability => { enter(); await held; return run(capability); });
    const tick = h.service.tick(); await entered;
    expect(h.service.tick()).toBe(tick);
    const handlers = makeArchiveHandlers({ runtime: h.runtime, dataPath: h.dir, operationGate: h.gate });
    await expect(handlers.slice!.handlers['server.archive.export']!({ recoveryKey: h.mnemonic }, {} as never)).rejects.toMatchObject({ code: 'archive_export_in_progress' });
    let stopped = false; const stop = h.service.stop().then(() => { stopped = true; }); await Promise.resolve(); expect(stopped).toBe(false);
    settle(); await tick; await stop; expect(spy).toHaveBeenCalledTimes(1);
    h.advance(7 * 24 * 3_600_000); await h.service.tick(); expect(spy).toHaveBeenCalledTimes(1);
  });

  it('refuses foreign words, vault lock, changed destinations, and altered sealed capabilities', async () => {
    const h = await setup();
    await expect(h.service.save(h.settings, generateRecoveryKey().mnemonic)).rejects.toThrow('This recovery key does not open');
    expect(h.service.status().configured).toBe(false); await h.service.save(h.settings, h.mnemonic);
    h.keys.lock(); h.due(); await h.service.tick(); expect(h.service.status().last_run?.issue).toBe('vault_unavailable'); expect(h.s3.calls).toHaveLength(0);
    await h.keys.unlockWithServerKey({ serverKey: h.serverKey }); h.changed(); h.due(); await h.service.tick();
    expect(h.service.status().last_run?.issue).toBe('destination_unavailable'); expect(h.s3.calls).toHaveLength(0);
    const path = unattendedBackupPath(h.dbPath), saved = JSON.parse(readFileSync(path, 'utf8'));
    saved.capability.salt_hex = 'f'.repeat(64); writeFileSync(path, JSON.stringify(saved)); h.due(); await h.service.tick();
    expect(h.service.status().last_run?.issue).toBe('setup_required'); expect(h.s3.calls).toHaveLength(0);
  });

  it('leaves broken settings intact, skips paused schedules, and coalesces missed slots', async () => {
    const h = await setup(); await h.service.save({ ...h.settings, enabled: false }, h.mnemonic);
    h.advance(30 * 24 * 3_600_000); await h.service.tick(); expect(h.s3.calls).toHaveLength(0);
    await h.service.save(h.settings); h.advance(30 * 24 * 3_600_000); await h.service.tick();
    expect(h.remote.list()).toHaveLength(1); await h.service.tick(); expect(h.remote.list()).toHaveLength(1);
    const path = unattendedBackupPath(h.dbPath); writeFileSync(path, '{ broken'); await h.service.tick();
    expect(() => h.service.status()).toThrow('invalid'); expect(readFileSync(path, 'utf8')).toBe('{ broken');
  });

  it('computes strict future UTC daily and weekly boundaries', () => {
    const after = Date.UTC(2026, 9, 20, 2);
    expect(nextBackupTime({ cadence: 'daily', hour_utc: 2, minute_utc: 0, weekday_utc: 0 }, after)).toBe(Date.UTC(2026, 9, 21, 2));
    expect(nextBackupTime({ cadence: 'weekly', hour_utc: 2, minute_utc: 0, weekday_utc: 2 }, after)).toBe(Date.UTC(2026, 9, 27, 2));
  });

  it('re-arms the actual backup scheduler slot after maintenance or master pause', async () => {
    const h = await setup(); await h.service.save(h.settings, h.mnemonic); h.due();
    const registry = createBackgroundServiceRegistry(), slot = bootUnattendedBackups({ registry, unattendedBackups: h.service });
    cleanup.push(() => registry.stopAll());
    await registry.stopAll({ kind: 'scheduler' }); await h.service.tick(); expect(h.remote.list()).toHaveLength(0);
    slot!.rebuild!(); await h.service.tick(); expect(h.service.status().last_run?.outcome).toBe('verified');
  });

  it('alerts on insufficient space and vault drift without sending archive bytes', async () => {
    const h = await setup(); await h.service.save(h.settings, h.mnemonic); h.due();
    const preflight = vi.spyOn(h.runtime, 'preflightExport').mockResolvedValueOnce({ ok: false, reason: 'fixture', need_bytes: 2, free_bytes: 1 });
    await h.service.tick(); expect(h.service.status().last_run?.issue).toBe('insufficient_storage');
    const replacement = await createServerBundle({ recoveryKey: h.mnemonic, serverKey: h.serverKey });
    createServerBundleStore(h.dbPath).save(replacement.bundle); replacement.masterDEK.fill(0);
    h.due(); await h.service.tick(); expect(h.service.status().last_run?.issue).toBe('setup_required');
    expect(h.s3.calls).toHaveLength(0); preflight.mockRestore();
  });

  it('alerts about retention cleanup separately from a verified backup', async () => {
    const h = await setup(); await h.service.save(h.settings, h.mnemonic); h.due(); await h.service.tick();
    h.s3.faults.denyDelete = true; h.due(); await h.service.tick();
    expect(h.service.status().last_run?.outcome).toBe('verified'); expect(h.s3.objects.size).toBe(2);
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('older copies could not be removed') }), expect.any(String));
  });

  it('settles an interrupted schedule checkpoint from a verified delivery receipt without alerting or uploading again', async () => {
    const h = await setup(); await h.service.save(h.settings, h.mnemonic); h.due(); await h.service.tick();
    const path = unattendedBackupPath(h.dbPath), saved = JSON.parse(readFileSync(path, 'utf8'));
    saved.last_run.outcome = 'running'; delete saved.last_run.finished_at; writeFileSync(path, JSON.stringify(saved));
    const requests = h.s3.calls.length, reboot = createUnattendedBackups(h.options); cleanup.push(() => reboot.stop());
    expect(reboot.status().last_run?.outcome).toBe('verified'); await reboot.tick();
    expect(h.s3.calls).toHaveLength(requests); expect(h.notify).not.toHaveBeenCalled();
  });
});

// A drain step has 5 s. The stop used to wait for the whole export and upload
// (each S3 request may run 30 minutes); a step that runs out makes an update
// refuse to swap versions, while the process exits after the drain anyway.
describe('unattended backups — stop', () => {
  /** S3 that answers everything except the archive PUT. */
  const unansweredPut = (opts: { honoursAbort: boolean; once?: boolean }) => {
    const signals: AbortSignal[] = [];
    let puts = 0, entered = () => {}, release = () => {};
    const putStarted = new Promise<void>(resolve => { entered = resolve; });
    const gone = new Promise<void>(resolve => { release = resolve; });
    const fetchImpl: typeof fetch = (input, init) => {
      if (init?.method !== 'PUT' || (opts.once && puts > 0)) return fetch(input, init);
      puts += 1; const signal = init.signal;
      if (signal) signals.push(signal);
      entered();
      return new Promise<Response>((_resolve, reject) => {
        if (opts.honoursAbort) signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        else void gone.then(() => reject(new Error('fixture: the provider gave up')));
      });
    };
    return { fetchImpl, signals, putStarted, release };
  };

  it('aborts the upload in flight, records the run interrupted, and writes nothing once it returns', async () => {
    const s3 = unansweredPut({ honoursAbort: true, once: true });
    const h = await setup({ fetchImpl: s3.fetchImpl }); await h.service.save(h.settings, h.mnemonic); h.due();
    const tick = h.service.tick(); await s3.putStarted;
    const writes = vi.spyOn(durableFs, 'writeFileAtomicSync');
    try {
      const started = performance.now();
      await h.service.stop();
      expect(performance.now() - started).toBeLessThan(STOP_GRACE_MS);
      expect(s3.signals[0]?.aborted).toBe(true);
      // Recorded while the stop waited, not after it: the same verdict boot
      // gives a claim the process did not live to finish.
      expect(h.service.status().last_run).toMatchObject({ outcome: 'failed', issue: 'interrupted' });
      expect(h.remote.list()[0]).toMatchObject({ state: 'unconfirmed', issue: 'interrupted' });
      const atStop = writes.mock.calls.length;
      await tick; await new Promise(resolve => setTimeout(resolve, 50));
      expect(writes.mock.calls.length).toBe(atStop);
    } finally { writes.mockRestore(); }
    expect(h.s3.objects.size).toBe(0);
    // The normal schedule runs a fresh backup at the next slot; nothing resends the interrupted one.
    h.service.resume(); h.due(); await h.service.tick();
    expect(h.service.status().last_run?.outcome).toBe('verified');
    expect(h.remote.list().map(row => row.state)).toEqual(['verified', 'unconfirmed']);
    expect(h.s3.objects.size).toBe(1);
  });

  it('returns at the grace when the provider ignores the abort, and releases the tick the interval waits on', async () => {
    const s3 = unansweredPut({ honoursAbort: false });
    const h = await setup({ fetchImpl: s3.fetchImpl }); await h.service.save(h.settings, h.mnemonic); h.due();
    const tick = h.service.tick(); await s3.putStarted;
    const started = performance.now();
    await h.service.stop();
    const waited = performance.now() - started;
    expect(waited).toBeGreaterThanOrEqual(STOP_GRACE_MS - 50);
    expect(waited).toBeLessThan(STOP_GRACE_MS * 3);
    expect(s3.signals[0]?.aborted).toBe(true);
    // `unattended-backup-ticks` (stop_timers) waits for exactly this promise.
    await tick;
    // The provider gives up after the drain: the run still ends interrupted.
    s3.release();
    await vi.waitFor(() => expect(h.service.status().last_run).toMatchObject({ outcome: 'failed', issue: 'interrupted' }));
  });

  it('passes the stop to the export, which commits nothing', async () => {
    const h = await setup(); await h.service.save(h.settings, h.mnemonic); h.due();
    let enter = () => {}, release = () => {}, seen: AbortSignal | undefined;
    const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const run = h.runtime.runUnattendedExport!;
    vi.spyOn(h.runtime, 'runUnattendedExport').mockImplementation(async (capability, signal) => {
      seen = signal; enter(); await held; return run(capability, signal);
    });
    const tick = h.service.tick(); await entered;
    const stopping = h.service.stop();
    expect(seen?.aborted).toBe(true);
    release(); await stopping; await tick;
    expect(h.service.status().last_run).toMatchObject({ outcome: 'failed', issue: 'interrupted' });
    expect(h.remote.list()[0]).toMatchObject({ state: 'unconfirmed', issue: 'interrupted' });
    const exportsDir = join(h.dir, 'exports');
    expect(existsSync(exportsDir) ? readdirSync(exportsDir) : []).toEqual([]);
    expect(h.s3.calls).toHaveLength(0);
  });
});
