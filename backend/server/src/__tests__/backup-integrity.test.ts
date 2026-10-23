import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isReservedLocalRpc, MCP_TOOL_CATALOG, type ArchiveBackupIntegrityPolicy, type ArchiveRemoteBackup,
  type ArchiveUnattendedStatus, type ServerRpcRegistry } from '@recued/contracts';
import { backupIntegrityPath, createBackupIntegrity } from '../archive/backup-integrity.js';
import { createRemoteBackupStore, remoteBackupLedgerPath } from '../archive/remote-backup-store.js';
import { createRemoteBackups } from '../archive/remote-backups.js';
import { createS3RemoteBackupTransport } from '../archive/remote-backup-s3.js';
import { createRemoteBackupS3Fixture, REMOTE_FIXTURE_ACCESS, REMOTE_FIXTURE_SECRET } from './helpers/remote-backup-s3-fixture.js';
import { makeArchiveHandlers } from '../archive/archive-handler.js';
import { createRpcDispatcher } from '../rpc-dispatcher.js';
import { createBackgroundServiceRegistry } from '../composition/bin/wire-background-services.js';
import { bootBackupIntegrity } from '../composition/data/scheduler/backup-integrity/boot.js';
import * as durableFs from '../durable-fs.js';

const HOUR = 3_600_000, DAY = 24 * HOUR, epoch = Date.UTC(2026, 9, 21);
const policy: ArchiveBackupIntegrityPolicy = { enabled: true, schedule: { cadence: 'daily', hour_utc: 4, minute_utc: 0, weekday_utc: 0 } };
const disposals: (() => void | Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of disposals.splice(0).reverse()) await close(); vi.useRealTimers(); });
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'backup-integrity-')), dbPath = join(dir, 'server.db');
  disposals.push(() => rmSync(dir, { recursive: true, force: true }));
  let at = epoch, canRun = true;
  const source: ArchiveUnattendedStatus = { configured: true, settings: { enabled: true, connection_name: 'safe', destination_id: 'a'.repeat(64),
    keep_last: 5, schedule: policy.schedule } };
  const schedule = vi.fn(() => source), store = createRemoteBackupStore(dbPath, { now: () => at });
  const recheck = vi.fn(async (id: string, _signal: AbortSignal): Promise<ArchiveRemoteBackup | null> => store.update(id, row => {
    row.state = 'verified'; row.verified_at = at; delete row.issue;
  }));
  const notify = vi.fn(async (_message: { title: string; text: string; link_url: string }, _id: string) => true);
  const options = { dbPath, schedule, remoteBackups: { recheck }, notify, now: () => at, canRun: () => canRun };
  const service = createBackupIntegrity(options); disposals.push(() => service.stop());
  const copy = (destinationId = 'a'.repeat(64)) => {
    const id = randomUUID(); store.reserve({ operation_id: id, job_id: `arx-${id}`, fingerprint: destinationId, keep_last: 5,
      destination: { connection_name: 'safe', destination_id: destinationId, bucket: 'backup-bucket', region: 'us-east-1', endpoint: 'https://fixture.invalid', prefix: '' } });
    return store.update(id, row => { row.state = 'verified'; row.bytes = 100; row.sha256 = 'b'.repeat(64); row.verified_at = at; });
  };
  return { dir, dbPath, source, schedule, store, copy, options, service, recheck, notify,
    advance: (ms: number) => { at += ms; }, time: () => at, canRun: (v: boolean) => { canRun = v; } };
};

describe('scheduled retained-backup integrity', () => {
  it('is opt-in, does no provider work from status or setup, and coalesces missed UTC slots', async () => {
    const h = setup(); h.copy();
    expect(h.service.status()).toMatchObject({ policy: { enabled: false, schedule: { cadence: 'weekly' } }, monitoring: 'paused' });
    expect(existsSync(backupIntegrityPath(h.dbPath))).toBe(false);
    h.advance(10 * DAY); await h.service.tick(); expect(h.recheck).not.toHaveBeenCalled();
    expect(h.service.save(policy).next_run_at).toBe(h.time() + 4 * HOUR); expect(h.recheck).not.toHaveBeenCalled();
    h.advance(9 * DAY + 5 * HOUR); await h.service.tick(); await h.service.tick();
    expect(h.recheck).toHaveBeenCalledTimes(1);
    expect(h.service.status()).toMatchObject({ last_run: { outcome: 'completed', total: 1, checked: 1, failed: 0, skipped: 0 }, next_run_at: h.time() + 23 * HOUR });
    const reboot = createBackupIntegrity(h.options); disposals.push(() => reboot.stop()); await reboot.tick();
    expect(h.recheck).toHaveBeenCalledTimes(1); expect(statSync(backupIntegrityPath(h.dbPath)).mode & 0o777).toBe(0o600);
    const saved = readFileSync(backupIntegrityPath(h.dbPath), 'utf8');
    for (const secret of ['recoveryKey', 'ciphertext', 'fixture.invalid', h.dir, 'object_key']) expect(saved).not.toContain(secret);
  });

  it('scans beyond the UI history window and selects only previously verified retained copies in the exact destination', async () => {
    const h = setup(), kept = h.copy(), retry = h.copy(), removed = h.copy(), pruning = h.copy(); h.copy('c'.repeat(64));
    h.store.update(retry.operation_id, row => { row.state = 'unconfirmed'; row.issue = 'verification_failed'; });
    h.store.update(removed.operation_id, row => { row.state = 'pruned'; }); h.store.update(pruning.operation_id, row => { row.state = 'pruning'; });
    for (let n = 0; n < 105; n++) { const row = h.copy(); h.store.update(row.operation_id, r => { r.state = 'unconfirmed'; delete r.verified_at; }); }
    h.service.save(policy); h.advance(4 * HOUR); await h.service.tick();
    expect(h.recheck.mock.calls.map(c => c[0])).toEqual([kept.operation_id, retry.operation_id]);
    expect(h.service.status().last_run).toMatchObject({ total: 2, checked: 2, failed: 0 });
  });

  it('claims a scan durably, checks sequentially, and records busy/removed copies as skipped', async () => {
    const h = setup(), first = h.copy(); h.copy(); h.service.save(policy); h.advance(4 * HOUR);
    let release = () => {}; const held = new Promise<void>(resolve => { release = resolve; });
    h.recheck.mockImplementationOnce(async id => { await held; return h.store.get(id); }).mockResolvedValueOnce(null);
    const work = h.service.tick();
    try {
      expect(h.recheck.mock.calls.map(c => c[0])).toEqual([first.operation_id]);
      expect(JSON.parse(readFileSync(backupIntegrityPath(h.dbPath), 'utf8'))).toMatchObject({ last_run: { outcome: 'running', total: 2, checked: 0 }, next_run_at: epoch + DAY + 4 * HOUR });
      expect(h.service.tick()).toBe(work); expect(h.recheck).toHaveBeenCalledTimes(1);
    } finally { release(); await work; }
    expect(h.service.status().last_run).toMatchObject({ outcome: 'completed', total: 2, checked: 1, skipped: 1 });
  });

  it('keeps failures pending with stable IDs and hourly retries across restarts', async () => {
    const h = setup(), row = h.copy(); h.service.save(policy);
    h.recheck.mockImplementation(async id => h.store.update(id, r => { r.state = 'unconfirmed'; r.issue = 'verification_failed'; }));
    h.notify.mockResolvedValue(false); h.advance(4 * HOUR); await h.service.tick();
    await vi.waitFor(() => expect(h.notify).toHaveBeenCalledTimes(1)); const id = h.notify.mock.calls[0]![1];
    expect(h.service.status()).toMatchObject({ last_run: { checked: 1, failed: 1, outcome: 'failed', issue: 'verification_failed' }, alert_pending: true });
    expect(h.store.get(row.operation_id)?.created_at).toBe(epoch);
    const reboot = createBackupIntegrity(h.options); disposals.push(() => reboot.stop()); await reboot.tick(); expect(h.notify).toHaveBeenCalledTimes(1);
    h.advance(HOUR - 1); await reboot.tick(); expect(h.notify).toHaveBeenCalledTimes(1);
    h.advance(1); h.notify.mockResolvedValue(true); await reboot.tick();
    await vi.waitFor(() => expect(reboot.status().alert_pending).toBeUndefined());
    expect(h.notify.mock.calls.map(c => c[1])).toEqual([id, id]); expect(h.recheck).toHaveBeenCalledTimes(1);
  });

  it('alerts once for multiple failures in a scan, even if delivery completes before the next copy', async () => {
    const h = setup(); h.copy(); h.copy(); h.service.save(policy); h.advance(4 * HOUR);
    h.recheck.mockImplementation(async id => {
      await new Promise<void>(resolve => setImmediate(resolve));
      return h.store.update(id, row => { row.state = 'unconfirmed'; row.issue = 'transfer_unconfirmed'; });
    });
    await h.service.tick(); await vi.waitFor(() => expect(h.service.status().alert_pending).toBeUndefined());
    expect(h.notify).toHaveBeenCalledTimes(1); expect(h.service.status().last_run?.failed).toBe(2);
  });

  it('keeps new scheduled scans moving while the notification route is stalled', async () => {
    const h = setup(); h.copy(); h.service.save(policy); h.advance(4 * HOUR);
    h.recheck.mockImplementation(async id => h.store.update(id, row => { row.state = 'unconfirmed'; row.issue = 'verification_failed'; }));
    let release = () => {}; const held = new Promise<void>(resolve => { release = resolve; });
    h.notify.mockImplementationOnce(async () => { await held; return true; });
    try {
      await h.service.tick(); await vi.waitFor(() => expect(h.notify).toHaveBeenCalledTimes(1));
      h.advance(DAY); await h.service.tick(); expect(h.recheck).toHaveBeenCalledTimes(2); expect(h.notify).toHaveBeenCalledTimes(1);
      expect(h.service.status()).toMatchObject({ last_run: { started_at: h.time(), outcome: 'failed' }, alert_pending: true });
    } finally { release(); await h.service.stop(); }
  });

  it('retains the same alert after a failed acknowledgment write, without resending before an hour', async () => {
    const h = setup(); h.copy(); h.service.save(policy); h.advance(4 * HOUR);
    h.recheck.mockImplementation(async id => h.store.update(id, row => { row.state = 'unconfirmed'; row.issue = 'verification_failed'; }));
    const originalWrite = durableFs.writeFileAtomicSync;
    h.notify.mockImplementationOnce(async () => {
      let failAck = true;
      vi.spyOn(durableFs, 'writeFileAtomicSync').mockImplementation((path, content, ...rest) => {
        if (failAck && path === backupIntegrityPath(h.dbPath) && JSON.parse(String(content)).alert === undefined) {
          failAck = false; throw new Error('private ACK path');
        }
        return originalWrite(path, content, ...rest);
      }); return true;
    });
    await h.service.tick(); await new Promise<void>(resolve => setImmediate(resolve)); expect(h.notify).toHaveBeenCalledTimes(1);
    await h.service.tick(); expect(h.notify).toHaveBeenCalledTimes(1); expect(h.service.status().alert_pending).toBe(true);
    await h.service.stop(); h.service.resume(); // Drain the independently tracked alert task before moving the clock.
    h.advance(HOUR); await h.service.tick(); await vi.waitFor(() => expect(h.service.status().alert_pending).toBeUndefined());
    expect(h.notify.mock.calls[0]![1]).toBe(h.notify.mock.calls[1]![1]);
  });

  it('turns interrupted claims into visible failures without resuming the scan on boot', async () => {
    const h = setup(); h.copy(); h.service.save(policy); h.advance(4 * HOUR); await h.service.tick();
    const path = backupIntegrityPath(h.dbPath), saved = JSON.parse(readFileSync(path, 'utf8'));
    saved.last_run.outcome = 'running'; delete saved.last_run.finished_at; writeFileSync(path, JSON.stringify(saved));
    const reboot = createBackupIntegrity(h.options); disposals.push(() => reboot.stop());
    expect(reboot.status()).toMatchObject({ last_run: { outcome: 'failed', issue: 'interrupted' }, alert_pending: true });
    expect(h.recheck).toHaveBeenCalledTimes(1); await reboot.tick(); await vi.waitFor(() => expect(h.notify).toHaveBeenCalledTimes(1));
    expect(h.recheck).toHaveBeenCalledTimes(1);
  });

  it('stops new reads when the source pauses, moves destination, or lifecycle is unavailable', async () => {
    const h = setup(); h.copy(); h.copy(); h.service.save(policy); h.advance(4 * HOUR);
    h.canRun(false); await h.service.tick(); expect(h.recheck).not.toHaveBeenCalled(); h.canRun(true);
    h.source.settings!.enabled = false; await h.service.tick(); expect(h.recheck).not.toHaveBeenCalled(); h.source.settings!.enabled = true;
    h.recheck.mockImplementationOnce(async id => { h.source.settings!.destination_id = 'c'.repeat(64); return h.store.get(id); });
    await h.service.tick(); expect(h.recheck).toHaveBeenCalledTimes(1);
    expect(h.service.status().last_run).toMatchObject({ outcome: 'failed', issue: 'stopped', checked: 1 });
    h.source.configured = false; expect(h.service.status().monitoring).toBe('not_configured');
    h.schedule.mockImplementationOnce(() => { throw new Error('private schedule'); }); expect(h.service.status().issue).toBe('schedule_unavailable');
  });

  it('cancels and drains reads on pause/maintenance, preserving newer schedule edits', async () => {
    const h = setup(); h.copy(); h.copy(); h.service.save(policy); h.advance(4 * HOUR);
    h.recheck.mockImplementationOnce(async (_id, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))));
    const work = h.service.tick(); const paused = { ...policy, enabled: false, schedule: { ...policy.schedule, hour_utc: 7 } };
    h.service.save(paused); await work;
    expect(h.service.status()).toMatchObject({ policy: paused, monitoring: 'paused', last_run: { outcome: 'failed', issue: 'stopped', checked: 0 } });
    expect(h.recheck).toHaveBeenCalledTimes(1); expect(h.notify).not.toHaveBeenCalled();
    h.service.save(policy); h.advance(DAY); const registry = createBackgroundServiceRegistry(), slot = bootBackupIntegrity({ registry, backupIntegrity: h.service })!;
    h.recheck.mockImplementationOnce(async (_id, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))));
    const work2 = h.service.tick(); await registry.stopAll({ kind: 'scheduler' }); await work2;
    expect(h.service.status().last_run?.issue).toBe('stopped'); h.advance(DAY); await h.service.tick(); expect(h.recheck).toHaveBeenCalledTimes(2);
    slot.rebuild!(); await h.service.tick(); expect(h.recheck).toHaveBeenCalledTimes(4); await registry.stopAll();
  });

  it('fails closed on malformed settings, unknown fields, and failed claim writes', async () => {
    const h = setup(); h.copy();
    for (const v of [{ ...policy, recoveryKey: 'secret' }, { ...policy, enabled: 'yes' }, { ...policy, schedule: { ...policy.schedule, hour_utc: 24 } },
      { ...policy, schedule: { ...policy.schedule, weekday_utc: 0.5 } }, { ...policy, schedule: { ...policy.schedule, extra: true } }]) expect(() => h.service.save(v)).toThrow();
    h.service.save(policy); const path = backupIntegrityPath(h.dbPath), original = readFileSync(path, 'utf8');
    for (const bad of ['{broken', ' '.repeat(16_385), JSON.stringify({ ...JSON.parse(original), recoveryKey: 'secret' })]) {
      writeFileSync(path, bad); expect(h.service.status().issue).toBe('settings_unavailable'); expect(() => h.service.save(policy)).toThrow();
      h.advance(DAY); await h.service.tick(); expect(h.recheck).not.toHaveBeenCalled(); expect(h.notify).not.toHaveBeenCalled(); expect(readFileSync(path, 'utf8')).toBe(bad);
    }
    writeFileSync(path, original); const write = vi.spyOn(durableFs, 'writeFileAtomicSync').mockImplementationOnce(() => { throw new Error('private disk path'); });
    await h.service.tick(); expect(h.recheck).not.toHaveBeenCalled(); write.mockRestore(); await h.service.tick(); expect(h.recheck).toHaveBeenCalledTimes(1);
  });

  it('reports unreadable history, persists notification intent, and rejects backwards clocks', async () => {
    const h = setup(); h.copy(); h.service.save(policy); h.advance(4 * HOUR); writeFileSync(remoteBackupLedgerPath(h.dbPath), '{bad history');
    h.notify.mockImplementation(async () => {
      expect(JSON.parse(readFileSync(backupIntegrityPath(h.dbPath), 'utf8')).alert.last_attempt_at).toBe(h.time()); throw new Error('private provider body');
    });
    await h.service.tick(); await vi.waitFor(() => expect(h.notify).toHaveBeenCalledTimes(1));
    expect(h.recheck).not.toHaveBeenCalled(); expect(h.service.status()).toMatchObject({ last_run: { outcome: 'failed', issue: 'history_unavailable' }, alert_pending: true });
    expect(readFileSync(backupIntegrityPath(h.dbPath), 'utf8')).not.toContain('private');
    h.advance(-HOUR); expect(h.service.status().issue).toBe('clock_changed'); await h.service.tick(); expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it('treats a deleted or shortened known ledger as unavailable, rather than an empty successful scan', async () => {
    const h = setup(); h.copy(); h.service.save(policy); h.advance(4 * HOUR); await h.service.tick();
    const path = remoteBackupLedgerPath(h.dbPath), original = readFileSync(path, 'utf8');
    rmSync(path); h.advance(DAY); await h.service.tick();
    expect(h.service.status().last_run).toMatchObject({ outcome: 'failed', issue: 'history_unavailable' });
    const shorter = JSON.parse(original); shorter.backups = []; writeFileSync(path, JSON.stringify(shorter));
    h.advance(DAY); await h.service.tick(); expect(h.service.status().last_run?.issue).toBe('history_unavailable');
    expect(h.recheck).toHaveBeenCalledTimes(1);
  });

  it('preserves edits and a new alert when an older notification acknowledgment arrives', async () => {
    const h = setup(); h.copy(); h.service.save(policy); h.advance(4 * HOUR);
    h.recheck.mockImplementation(async id => h.store.update(id, row => { row.state = 'unconfirmed'; row.issue = 'verification_failed'; }));
    let release = () => {}; const held = new Promise<void>(resolve => { release = resolve; }); h.notify.mockImplementationOnce(async () => { await held; return true; });
    await h.service.tick(); await vi.waitFor(() => expect(h.notify).toHaveBeenCalledTimes(1));
    h.service.save({ ...policy, schedule: { ...policy.schedule, hour_utc: 8 } });
    const path = backupIntegrityPath(h.dbPath), saved = JSON.parse(readFileSync(path, 'utf8')), newId = randomUUID();
    saved.alert.id = newId; writeFileSync(path, JSON.stringify(saved));
    release(); await vi.waitFor(() => expect(h.service.status().policy.schedule.hour_utc).toBe(8)); await h.service.stop();
    const latest = JSON.parse(readFileSync(path, 'utf8')); expect(latest.alert.id).toBe(newId); expect(latest.policy.schedule.hour_utc).toBe(8);
  });

  it('registers reserved owner RPCs, idle-exempt reads, and optional scheduler slots', async () => {
    const h = setup(), { slice } = makeArchiveHandlers({ runtime: {} as never, backupIntegrity: h.service, dataPath: h.dir });
    expect(slice!.methods).toEqual(expect.arrayContaining(['server.archive.integrity.get', 'server.archive.integrity.save']));
    const touchActivity = vi.fn(), dispatch = createRpcDispatcher<ServerRpcRegistry, never>(slice!.handlers, { touchActivity });
    expect((await dispatch('server.archive.integrity.get', {}, {} as never)).ok).toBe(true); expect(touchActivity).not.toHaveBeenCalled();
    expect((await dispatch('server.archive.integrity.save', { policy }, {} as never)).ok).toBe(true); expect(touchActivity).toHaveBeenCalledTimes(1);
    for (const method of ['server.archive.integrity.get', 'server.archive.integrity.save']) { expect(isReservedLocalRpc(method)).toBe(true); expect(MCP_TOOL_CATALOG).not.toContain(method); }
    const unavailable = makeArchiveHandlers({ runtime: {} as never, dataPath: h.dir }).slice!;
    await expect(unavailable.handlers['server.archive.integrity.get']!({}, {} as never)).rejects.toMatchObject({ code: 'not_configured' });
    expect(bootBackupIntegrity({ registry: createBackgroundServiceRegistry() })).toBeUndefined();
  });
});

describe('scheduled checks using real loopback S3 transport', () => {
  it.each(['missing', 'changed', 'healthy'] as const)('checks %s retained bytes using existing verification and retention authority', async fault => {
    const h = setup(), s3 = await createRemoteBackupS3Fixture(); disposals.push(() => s3.close());
    const transport = createS3RemoteBackupTransport({ config: { access_key: REMOTE_FIXTURE_ACCESS, secret_key: REMOTE_FIXTURE_SECRET,
      bucket: 'backup-bucket', region: 'us-east-1', endpoint: s3.endpoint }, assertCurrent: () => {} });
    const destination = h.copy().destination, fingerprint = destination.destination_id;
    const remote = createRemoteBackups({ dbPath: h.dbPath, now: () => h.time(), destinations: () => [destination], describe: () => ({ destination, fingerprint }),
      resolve: async () => ({ destination, fingerprint, transport }) });
    const first = h.store.rows()[0]!, last = h.copy(), bytes = Buffer.from('RECA encrypted fixture');
    for (const row of [first, last]) {
      s3.objects.set(row.object_key, { bytes, etag: '"fixture"' });
      h.store.update(row.operation_id, r => { r.bytes = bytes.length; r.sha256 = createHash('sha256').update(bytes).digest('hex'); r.etag = '"fixture"'; r.keep_last = 1; });
    }
    if (fault === 'missing') s3.objects.delete(last.object_key);
    else if (fault === 'changed') s3.objects.set(last.object_key, { bytes: Buffer.from('X'.repeat(bytes.length)), etag: '"fixture"' });
    const service = createBackupIntegrity({ ...h.options, remoteBackups: remote }); disposals.push(() => service.stop());
    service.save(policy); h.advance(4 * HOUR); await service.tick();
    if (fault === 'healthy') {
      expect(service.status().last_run).toMatchObject({ total: 2, checked: 2, failed: 0, outcome: 'completed' });
      expect(h.store.get(first.operation_id)?.state).toBe('pruned'); expect(h.store.get(last.operation_id)).toMatchObject({ state: 'verified', created_at: epoch, verified_at: h.time() });
      expect(s3.calls.map(c => c.method)).toEqual(['GET', 'GET', 'DELETE']); expect(h.notify).not.toHaveBeenCalled();
    } else {
      await vi.waitFor(() => expect(h.notify).toHaveBeenCalledTimes(1));
      expect(service.status().last_run).toMatchObject({ total: 2, checked: 2, failed: 1, outcome: 'failed' });
      expect(h.store.get(first.operation_id)?.state).toBe('verified'); expect(h.store.get(last.operation_id)).toMatchObject({ state: 'unconfirmed', issue: 'verification_failed', created_at: epoch });
      expect(s3.calls.map(c => c.method)).toEqual(['GET', 'GET']);
    }
    if (fault === 'changed') expect(s3.objects.get(last.object_key)?.bytes.toString()).toBe('X'.repeat(bytes.length));
    expect(readFileSync(backupIntegrityPath(h.dbPath), 'utf8')).not.toContain(REMOTE_FIXTURE_SECRET);
  });

  it.each(['headers', 'body'] as const)('cancels and drains a scheduled recheck stalled at HTTP %s', async phase => {
    const h = setup(), row = h.copy(); let entered = () => {}, closed = false;
    const requested = new Promise<void>(resolve => { entered = resolve; });
    const server = createServer((_req, res) => {
      res.on('close', () => { closed = true; });
      if (phase === 'body') { res.writeHead(200, { 'content-length': 100 }); res.write('RECA'); }
      entered();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    disposals.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
    const transport = createS3RemoteBackupTransport({ config: { access_key: 'fixture', secret_key: 'fixture', bucket: 'backup-bucket', region: 'us-east-1', endpoint: `http://127.0.0.1:${address.port}` }, assertCurrent() {} });
    const destination = row.destination, fingerprint = destination.destination_id;
    const remote = createRemoteBackups({ dbPath: h.dbPath, destinations: () => [destination], describe: () => ({ destination, fingerprint }), resolve: async () => ({ destination, fingerprint, transport }) });
    const service = createBackupIntegrity({ ...h.options, remoteBackups: remote }); disposals.push(() => service.stop());
    service.save(policy); h.advance(4 * HOUR); const work = service.tick(); await requested;
    await service.stop(); await work; await vi.waitFor(() => expect(closed).toBe(true));
    expect(h.store.get(row.operation_id)).toMatchObject({ state: 'unconfirmed', issue: 'interrupted' });
    expect(service.status().last_run).toMatchObject({ outcome: 'failed', issue: 'stopped', total: 1, checked: 0 });
    expect(h.notify).not.toHaveBeenCalled();
  });
});
