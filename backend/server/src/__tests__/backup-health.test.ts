import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isReservedLocalRpc, MCP_TOOL_CATALOG, type ArchiveRemoteBackup, type ArchiveRestoreDrill, type ArchiveUnattendedStatus, type ServerRpcRegistry } from '@recued/contracts';
import { backupHealthPath, createBackupHealth } from '../archive/backup-health.js';
import { createRemoteBackupStore, remoteBackupLedgerPath, remoteBackupObjectKey } from '../archive/remote-backup-store.js';
import { createRestoreDrillStore, restoreDrillLedgerPath } from '../archive/restore-drill-store.js';
import { makeArchiveHandlers } from '../archive/archive-handler.js';
import { createRpcDispatcher } from '../rpc-dispatcher.js';
import { createBackgroundServiceRegistry } from '../composition/bin/wire-background-services.js';
import { bootBackupHealth } from '../composition/data/scheduler/backup-health/boot.js';
import * as durableFs from '../durable-fs.js';

const HOUR = 3_600_000, DAY = 24 * HOUR, epoch = Date.UTC(2026, 9, 20);
const disposals: (() => void | Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of disposals.splice(0).reverse()) await close(); vi.useRealTimers(); });
const setup = (weekly = false) => {
  const dir = mkdtempSync(join(tmpdir(), 'backup-health-')), dbPath = join(dir, 'server.db');
  disposals.push(() => rmSync(dir, { recursive: true, force: true }));
  let at = epoch, canRun = true;
  let schedule: ArchiveUnattendedStatus = { configured: true, settings: { enabled: true, connection_name: 'safe', destination_id: 'a'.repeat(64), keep_last: 5,
    schedule: { cadence: weekly ? 'weekly' : 'daily', hour_utc: 2, minute_utc: 0, weekday_utc: 0 } } };
  const notify = vi.fn(async (_message: { title: string; text: string; link_url: string }, _episodeId: string) => true);
  const scheduleFn = vi.fn(() => schedule);
  const options = { dbPath, schedule: scheduleFn, notify, canRun: () => canRun, now: () => at };
  const service = createBackupHealth(options); disposals.push(() => service.stop());
  const remote = createRemoteBackupStore(dbPath, { now: () => at }), drills = createRestoreDrillStore(dbPath);
  const copy = (created = at, fingerprint = 'a'.repeat(64)) => {
    const savedAt = at; at = created; const id = randomUUID();
    remote.reserve({ operation_id: id, job_id: `arx-${id}`, fingerprint, keep_last: 5,
      destination: { connection_name: 'safe', destination_id: fingerprint, bucket: 'fixture', region: 'us-east-1', endpoint: 'https://fixture.invalid', prefix: '' } });
    at = savedAt;
    return remote.update(id, row => { row.state = 'verified'; row.bytes = 100; row.sha256 = 'b'.repeat(64); row.verified_at = Math.min(created + 1, at); });
  };
  const pass = (backup: ArchiveRemoteBackup, finished = at, extra: Partial<ArchiveRestoreDrill> = {}) => {
    const row: ArchiveRestoreDrill = { operation_id: randomUUID(), backup_operation_id: backup.operation_id, destination_id: backup.destination.destination_id,
      archive_sha256: backup.sha256!, archive_bytes: backup.bytes!, started_at: finished, finished_at: finished, state: 'succeeded',
      checks: { version: 1, server_version: '0.2.0', database_integrity: 'ok', foreign_keys: 'ok', local_boot_key: 'ok', database_bytes: 50,
        referenced_blobs: 3, restored_blob_records: 3, blob_bytes: 500 }, ...extra };
    drills.reserve(row); return row;
  };
  return { dir, dbPath, options, service, notify, remote, drills, copy, pass, scheduleFn,
    advance: (ms: number) => { at += ms; }, time: () => at,
    schedule: (value: ArchiveUnattendedStatus) => { schedule = value; },
    changeDestination: () => { schedule.settings!.destination_id = 'c'.repeat(64); },
    pause: () => { schedule.settings!.enabled = false; }, resume: () => { schedule.settings!.enabled = true; },
    canRun: (value: boolean) => { canRun = value; } };
};

describe('passive backup health', () => {
  it('starts a durable first-evidence grace period, uses daily/weekly defaults, and never sends during a read', async () => {
    const h = setup(), status = h.service.status();
    expect(status).toMatchObject({ monitoring: 'active', watched_since: epoch, policy: { alerts_enabled: true, backup_max_age_hours: 36, recovery_max_age_days: 30 },
      backup: { state: 'waiting', due_at: epoch + 36 * HOUR }, recovery: { state: 'waiting', due_at: epoch + 30 * DAY } });
    expect(statSync(backupHealthPath(h.dbPath)).mode & 0o777).toBe(0o600);
    h.advance(35 * HOUR); const reboot = createBackupHealth(h.options); disposals.push(() => reboot.stop());
    expect(reboot.status().watched_since).toBe(epoch); expect(reboot.status().backup?.state).toBe('waiting'); expect(h.notify).not.toHaveBeenCalled();
    const weekly = setup(true); expect(weekly.service.status().backup?.due_at).toBe(epoch + 192 * HOUR);
    expect(weekly.service.status().policy.backup_max_age_hours).toBe(192);
  });

  it('uses the newest retained verified copy by creation time; rechecking an old copy cannot renew freshness', async () => {
    const h = setup(), old = h.copy(epoch - 3 * DAY), recent = h.copy(epoch - HOUR);
    h.remote.update(old.operation_id, row => { row.verified_at = epoch; });
    expect(h.service.status().backup).toMatchObject({ state: 'current', operation_id: recent.operation_id, created_at: epoch - HOUR });
    h.remote.update(recent.operation_id, row => { row.state = 'pruned'; });
    expect(h.service.status().backup).toMatchObject({ state: 'due', operation_id: old.operation_id, due_at: epoch - 3 * DAY + 36 * HOUR });
    const other = h.copy(epoch, 'c'.repeat(64)); expect(h.service.status().backup?.operation_id).not.toBe(other.operation_id);
    h.remote.update(old.operation_id, row => { row.state = 'unconfirmed'; row.issue = 'verification_failed'; });
    expect(h.service.status().backup).toMatchObject({ state: 'due' }); expect(h.service.status().backup?.operation_id).toBeUndefined();
  });

  it('binds historical passing tests to exact receipt bytes and destination, including a later pruned copy', () => {
    const h = setup(), copy = h.copy(epoch - 2 * DAY), good = h.pass(copy, epoch - DAY);
    h.remote.update(copy.operation_id, row => { row.state = 'pruned'; });
    h.pass(copy, epoch, { archive_sha256: 'd'.repeat(64) });
    h.pass(copy, epoch, { archive_bytes: 101 });
    h.pass(copy, epoch, { destination_id: 'c'.repeat(64) });
    h.pass(copy, epoch, { state: 'failed', issue: 'interrupted', checks: undefined });
    h.pass(copy, epoch, { state: 'failed', issue: 'cleanup_failed', checks: undefined, cleanup_pending: true });
    expect(h.service.status().recovery).toMatchObject({ state: 'current', operation_id: good.operation_id, backup_operation_id: copy.operation_id, finished_at: epoch - DAY });
  });

  it('keeps prior verified evidence during a healthy recheck, but never elevates a failed copy merely because its retry is running', async () => {
    const h = setup(); h.advance(3 * DAY); const copy = h.copy(h.time() - HOUR);
    h.remote.update(copy.operation_id, row => { row.state = 'verifying'; });
    expect(h.service.status().backup).toMatchObject({ state: 'current', operation_id: copy.operation_id });
    await h.service.tick(); expect(h.notify).not.toHaveBeenCalled();
    h.remote.update(copy.operation_id, row => { row.state = 'unconfirmed'; row.issue = 'verification_failed'; });
    expect(h.service.status().backup).toMatchObject({ state: 'due', due_at: h.time() });
    await h.service.tick(); expect(h.notify).toHaveBeenCalledTimes(1);
    h.remote.update(copy.operation_id, row => { row.state = 'verifying'; });
    expect(h.service.status().backup?.state).toBe('due');
    await h.service.tick(); expect(h.notify).toHaveBeenCalledTimes(1);
    h.remote.update(copy.operation_id, row => { row.state = 'verified'; delete row.issue; row.verified_at = h.time(); });
    await h.service.tick(); expect(h.service.status().backup?.state).toBe('current'); expect(h.service.status().alerts).toEqual([]);
  });

  it('reads complete ledgers rather than hiding older evidence behind the latest-100 UI limit', () => {
    const h = setup(), copy = h.copy(epoch - HOUR), pass = h.pass(copy, epoch - HOUR);
    const remotePath = remoteBackupLedgerPath(h.dbPath), ledger = JSON.parse(readFileSync(remotePath, 'utf8'));
    for (let i = 0; i < 101; i++) {
      const id = randomUUID(); ledger.backups.push({ ...ledger.backups[0], operation_id: id, job_id: `arx-${id}`, object_key: remoteBackupObjectKey(ledger.namespace, id),
        state: 'unconfirmed', issue: 'interrupted', verified_at: undefined });
    }
    writeFileSync(remotePath, JSON.stringify(ledger));
    const drillPath = restoreDrillLedgerPath(h.dbPath), history = JSON.parse(readFileSync(drillPath, 'utf8'));
    for (let i = 0; i < 101; i++) history.drills.push({ ...pass, operation_id: randomUUID(), state: 'failed', issue: 'interrupted', checks: undefined });
    writeFileSync(drillPath, JSON.stringify(history));
    expect(h.service.status()).toMatchObject({ backup: { operation_id: copy.operation_id, state: 'current' }, recovery: { operation_id: pass.operation_id, state: 'current' } });
  });

  it('records one alert per observed condition across restart, rearms after recovery, and never changes backup receipts', async () => {
    const h = setup(); h.advance(36 * HOUR);
    await h.service.tick(); expect(h.notify).toHaveBeenCalledTimes(1);
    const firstId = h.notify.mock.calls[0]![1];
    expect(h.service.status().alerts).toEqual([{ kind: 'backup_overdue', delivery: 'delivered', first_detected_at: h.time() }]);
    const reboot = createBackupHealth(h.options); disposals.push(() => reboot.stop()); await reboot.tick(); expect(h.notify).toHaveBeenCalledTimes(1);
    h.service.save({ ...h.service.status().policy, recovery_max_age_days: 14 }); await h.service.tick();
    expect(h.notify).toHaveBeenCalledTimes(1); expect(h.service.status().watched_since).toBe(epoch);
    const copy = h.copy(), before = readFileSync(remoteBackupLedgerPath(h.dbPath)); await h.service.tick(); expect(h.service.status().alerts).toEqual([]);
    expect(readFileSync(remoteBackupLedgerPath(h.dbPath))).toEqual(before);
    h.advance(36 * HOUR); await h.service.tick(); expect(h.notify).toHaveBeenCalledTimes(2); expect(h.notify.mock.calls[1]![1]).not.toBe(firstId);
    expect(h.remote.get(copy.operation_id)?.state).toBe('verified');
  });

  it('retries unavailable routes at most hourly, persists the throttle, and keeps raw route errors out of storage', async () => {
    const h = setup(); h.advance(36 * HOUR); h.notify.mockRejectedValue(new Error('provider secret response'));
    await h.service.tick(); await h.service.tick(); expect(h.notify).toHaveBeenCalledTimes(1);
    const id = h.notify.mock.calls[0]![1], reboot = createBackupHealth(h.options); disposals.push(() => reboot.stop());
    h.advance(HOUR - 1); await reboot.tick(); expect(h.notify).toHaveBeenCalledTimes(1);
    h.advance(1); h.notify.mockResolvedValue(true); await reboot.tick(); expect(h.notify).toHaveBeenCalledTimes(2); expect(h.notify.mock.calls[1]![1]).toBe(id);
    expect(JSON.stringify(reboot.status())).not.toContain('provider secret'); expect(readFileSync(backupHealthPath(h.dbPath), 'utf8')).not.toContain('provider secret');
  });

  it('does not let a delayed acknowledgment overwrite policy, a new destination, or a newly armed episode', async () => {
    const h = setup(); h.advance(36 * HOUR); let release = () => {}, entered = () => {};
    const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    h.notify.mockImplementationOnce(async () => { entered(); await held; return true; });
    const tick = h.service.tick(); await started;
    try {
      h.service.save({ alerts_enabled: false, backup_max_age_hours: 48, recovery_max_age_days: 14 });
      h.changeDestination(); expect(h.service.status().backup?.state).toBe('waiting'); h.advance(48 * HOUR);
      h.service.save({ alerts_enabled: true, backup_max_age_hours: 48, recovery_max_age_days: 14 });
      expect(h.service.status().alerts[0]?.delivery).toBe('pending');
    } finally { release(); await tick; }
    expect(h.service.status()).toMatchObject({ destination: { destination_id: 'c'.repeat(64) }, policy: { backup_max_age_hours: 48, recovery_max_age_days: 14 } });
    expect(h.service.status().alerts[0]?.delivery).toBe('pending');
    await h.service.tick(); expect(h.service.status().alerts[0]?.delivery).toBe('delivered');
  });

  it('clears in-flight conditions from fresh evidence before accepting an old delivery acknowledgment', async () => {
    const h = setup(); h.advance(36 * HOUR); let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; }); h.notify.mockImplementationOnce(async () => { await held; return true; });
    const tick = h.service.tick();
    try { h.copy(); } finally { release(); await tick; }
    expect(h.service.status().alerts).toEqual([]);
  });

  it('keeps a pending episode on settlement write failure and retries the same delivery identity', async () => {
    const h = setup(); h.advance(36 * HOUR); const write = durableFs.writeFileAtomicSync;
    const fail = vi.spyOn(durableFs, 'writeFileAtomicSync').mockImplementation((path, bytes) => {
      if (path === backupHealthPath(h.dbPath) && String(bytes).includes('delivered_at')) throw new Error('synthetic settlement failure'); write(path, bytes);
    });
    await h.service.tick(); expect(h.service.status().alerts[0]?.delivery).toBe('pending'); fail.mockRestore();
    h.advance(HOUR); await h.service.tick(); expect(h.notify.mock.calls[1]![1]).toBe(h.notify.mock.calls[0]![1]);
    expect(h.service.status().alerts[0]?.delivery).toBe('delivered');
  });

  it('never sends before durable alert intent and throttle writes succeed', async () => {
    const h = setup(); h.advance(36 * HOUR); const write = durableFs.writeFileAtomicSync;
    const fail = vi.spyOn(durableFs, 'writeFileAtomicSync').mockImplementation((path, bytes) => {
      if (path === backupHealthPath(h.dbPath)) throw new Error('synthetic storage failure'); write(path, bytes);
    });
    await h.service.tick(); expect(h.notify).not.toHaveBeenCalled(); expect(h.service.status().issue).toBe('settings_unavailable'); fail.mockRestore();
    h.service.status();
    const throttleFail = vi.spyOn(durableFs, 'writeFileAtomicSync').mockImplementation((path, bytes) => {
      if (path === backupHealthPath(h.dbPath) && String(bytes).includes('last_attempt_at')) throw new Error('synthetic intent failure'); write(path, bytes);
    });
    await h.service.tick(); expect(h.notify).not.toHaveBeenCalled(); throttleFail.mockRestore();
    await h.service.tick(); expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it('distinguishes unreadable histories from healthy evidence and alerts without touching the broken files', async () => {
    const h = setup(); h.copy(); const path = restoreDrillLedgerPath(h.dbPath); writeFileSync(path, '{broken');
    expect(h.service.status()).toMatchObject({ backup: { state: 'current' }, recovery: { state: 'unavailable', issue: 'history_unavailable' } });
    await h.service.tick(); expect(h.notify).toHaveBeenCalledTimes(1); expect(h.service.status().alerts[0]?.kind).toBe('evidence_unavailable'); expect(readFileSync(path, 'utf8')).toBe('{broken');
    writeFileSync(remoteBackupLedgerPath(h.dbPath), '{broken remote');
    expect(h.service.status()).toMatchObject({ backup: { state: 'unavailable' }, recovery: { state: 'unavailable' } });
    await h.service.tick(); expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it('does not treat future-dated evidence or a backwards clock as fresh', () => {
    const h = setup(), copy = h.copy(); h.remote.update(copy.operation_id, row => { row.created_at = epoch + HOUR; });
    expect(h.service.status().backup).toMatchObject({ state: 'unavailable', issue: 'clock_changed' });
    h.remote.update(copy.operation_id, row => { row.created_at = epoch; }); h.pass(copy, epoch + HOUR);
    expect(h.service.status().recovery).toMatchObject({ state: 'unavailable', issue: 'clock_changed' });
    h.advance(-HOUR); expect(h.service.status()).toMatchObject({ backup: { state: 'unavailable' }, recovery: { state: 'unavailable' } });
  });

  it('does not turn deleted or shortened ledgers into a new first-evidence grace period', async () => {
    const h = setup(), copy = h.copy(epoch - 3 * DAY); h.pass(copy, epoch - DAY);
    expect(h.service.status().backup?.state).toBe('due'); await h.service.tick();
    const remotePath = remoteBackupLedgerPath(h.dbPath), drillPath = restoreDrillLedgerPath(h.dbPath), original = readFileSync(remotePath);
    rmSync(remotePath); expect(h.service.status()).toMatchObject({ backup: { state: 'unavailable' }, recovery: { state: 'unavailable' } });
    writeFileSync(remotePath, original); rmSync(drillPath);
    expect(h.service.status()).toMatchObject({ backup: { state: 'due' }, recovery: { state: 'unavailable' } });
    const reboot = createBackupHealth(h.options); disposals.push(() => reboot.stop());
    expect(reboot.status().recovery?.state).toBe('unavailable');
  });

  for (const accepted of [false, true]) it(`keeps ${accepted ? 'acknowledged' : 'pending'} overdue identity through an unavailable-history interval`, async () => {
    const h = setup(); h.copy(epoch - 3 * DAY); h.notify.mockResolvedValue(accepted);
    const path = remoteBackupLedgerPath(h.dbPath), original = readFileSync(path);
    await h.service.tick(); const id = h.notify.mock.calls[0]![1];
    writeFileSync(path, '{temporary unreadable history'); await h.service.tick();
    expect(h.service.status().alerts.map(a => a.kind)).toEqual(['evidence_unavailable']);
    h.advance(HOUR); await h.service.tick();
    expect(h.notify.mock.calls.filter(call => call[1] === id)).toHaveLength(1);
    writeFileSync(path, original); h.notify.mockResolvedValue(true); await h.service.tick();
    expect(h.service.status().alerts).toEqual([{ kind: 'backup_overdue', first_detected_at: epoch, delivery: 'delivered' }]);
    expect(h.notify.mock.calls.filter(call => call[1] === id)).toHaveLength(accepted ? 1 : 2);
  });

  it('pauses alerts with the schedule, keeps its original grace, and follows destination changes', async () => {
    const h = setup(); h.advance(40 * DAY); h.pause(); await h.service.tick(); expect(h.notify).not.toHaveBeenCalled(); expect(h.service.status().monitoring).toBe('paused');
    h.resume(); await h.service.tick(); expect(h.notify).toHaveBeenCalledTimes(2);
    h.changeDestination(); expect(h.service.status()).toMatchObject({ watched_since: h.time(), backup: { state: 'waiting' }, recovery: { state: 'waiting' }, alerts: [] });
    h.schedule({ configured: false }); expect(h.service.status().monitoring).toBe('not_configured');
    h.scheduleFn.mockImplementationOnce(() => { throw new Error('private settings'); });
    expect(h.service.status()).toMatchObject({ monitoring: 'unavailable', issue: 'schedule_unavailable' });
  });

  it('validates bounded, secret-free policy and never overwrites corrupt or oversized health state', async () => {
    const h = setup(), path = backupHealthPath(h.dbPath), policy = h.service.status().policy;
    for (const extra of [{ backup_max_age_hours: 0 }, { backup_max_age_hours: 8761 }, { recovery_max_age_days: 366 }, { recovery_max_age_days: 1.5 }, { alerts_enabled: 'yes' }, { recoveryKey: 'secret' }]) {
      expect(() => h.service.save({ ...policy, ...extra })).toThrow();
    }
    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain(h.dir); expect(raw).not.toContain('fixture.invalid');
    for (const bad of ['{broken', ' '.repeat(16_385), JSON.stringify({ ...JSON.parse(raw), recoveryKey: 'secret' }),
      JSON.stringify({ ...JSON.parse(raw), alerts: [{ id: randomUUID(), kind: 'backup_overdue', first_detected_at: epoch, delivered_at: epoch }] })]) {
      writeFileSync(path, bad); expect(h.service.status().issue).toBe('settings_unavailable'); expect(() => h.service.save(policy)).toThrow(); expect(readFileSync(path, 'utf8')).toBe(bad);
      await h.service.tick(); expect(h.notify).not.toHaveBeenCalled();
    }
    writeFileSync(path, raw); expect(h.service.save({ ...policy, alerts_enabled: false }).policy.alerts_enabled).toBe(false);
  });

  it('keeps scheduled observations moving while notification delivery is stalled', async () => {
    vi.useFakeTimers(); const h = setup(), registry = createBackgroundServiceRegistry(); bootBackupHealth({ registry, backupHealth: h.service });
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; }); h.notify.mockImplementationOnce(async () => { await held; return true; });
    h.advance(36 * HOUR); await vi.advanceTimersByTimeAsync(60_000); expect(h.notify).toHaveBeenCalledTimes(1);
    h.copy(); h.advance(60_000); await vi.advanceTimersByTimeAsync(60_000);
    // Read the durable checkpoint directly: status() must not be what clears it.
    expect(JSON.parse(readFileSync(backupHealthPath(h.dbPath), 'utf8')).alerts).toEqual([]);
    let drained = false; const stopping = registry.stopAll().then(() => { drained = true; });
    try { await Promise.resolve(); expect(drained).toBe(false); } finally { release(); await stopping; }
    expect(drained).toBe(true);
  });

  it('wires reserved owner RPCs with idle-exempt reads and service lifecycle drain', async () => {
    const h = setup(), { slice } = makeArchiveHandlers({ runtime: {} as never, backupHealth: h.service, dataPath: h.dir });
    expect(slice?.methods).toEqual(expect.arrayContaining(['server.archive.health.get', 'server.archive.health.save']));
    const touchActivity = vi.fn(), dispatch = createRpcDispatcher<ServerRpcRegistry, never>(slice!.handlers, { touchActivity });
    expect((await dispatch('server.archive.health.get', {}, {} as never)).ok).toBe(true); expect(touchActivity).not.toHaveBeenCalled();
    expect((await dispatch('server.archive.health.save', { policy: h.service.status().policy }, {} as never)).ok).toBe(true); expect(touchActivity).toHaveBeenCalledTimes(1);
    for (const method of ['server.archive.health.get', 'server.archive.health.save']) { expect(isReservedLocalRpc(method)).toBe(true); expect(MCP_TOOL_CATALOG).not.toContain(method); }
    const unavailable = makeArchiveHandlers({ runtime: {} as never, dataPath: h.dir }).slice!;
    await expect(unavailable.handlers['server.archive.health.get']!({}, {} as never)).rejects.toMatchObject({ code: 'not_configured' });
    const registry = createBackgroundServiceRegistry(), slot = bootBackupHealth({ registry, backupHealth: h.service })!;
    h.advance(36 * HOUR); let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; }); h.notify.mockImplementationOnce(async () => { await held; return true; });
    const tick = h.service.tick(); let stopped = false; const stopping = registry.stopAll({ kind: 'scheduler' }).then(() => { stopped = true; });
    try { await Promise.resolve(); expect(stopped).toBe(false); } finally { release(); await tick; await stopping; }
    h.advance(40 * DAY); await h.service.tick(); expect(h.notify).toHaveBeenCalledTimes(1); slot.rebuild!();
    h.canRun(false); await h.service.tick(); expect(h.notify).toHaveBeenCalledTimes(1); h.canRun(true); await h.service.tick(); expect(h.notify).toHaveBeenCalledTimes(2);
    await registry.stopAll();
  });
});
