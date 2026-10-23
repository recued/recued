import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ArchiveBackupIntegrityRun, ArchiveRemoteBackup, ArchiveRestoreDrill, ArchiveUnattendedStatus } from '@recued/contracts';
import { backupRecoveryForPassport, type PassportBackupSources } from '../archive/passport-backup-evidence.js';
import { createServerBackupHealthSource } from '../archive/server-backup-health.js';
import { backupWatchdogPath, createBackupWatchdog } from '../archive/backup-watchdog.js';
import { createBackupHealth } from '../archive/backup-health.js';
import { backupIntegrityPath, createBackupIntegrity } from '../archive/backup-integrity.js';
import { createRemoteBackupStore, remoteBackupLedgerPath } from '../archive/remote-backup-store.js';
import { createRestoreDrillStore } from '../archive/restore-drill-store.js';

const HOUR = 3_600_000, DAY = 24 * HOUR, epoch = Date.UTC(2026, 9, 21);
const disposals: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of disposals.splice(0).reverse()) await close(); });
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'passport-backups-')), dbPath = join(dir, 'server.db');
  disposals.push(() => rmSync(dir, { recursive: true, force: true }));
  let at = epoch;
  const schedule: ArchiveUnattendedStatus = { configured: true, settings: { enabled: true, connection_name: 'private-storage-name', destination_id: 'a'.repeat(64),
    keep_last: 5, schedule: { cadence: 'daily', hour_utc: 4, minute_utc: 0, weekday_utc: 0 } } };
  const scheduleFn = vi.fn(() => schedule), notify = vi.fn(async () => true), recheck = vi.fn();
  const health = createBackupHealth({ dbPath, schedule: scheduleFn, notify, now: () => at });
  const integrity = createBackupIntegrity({ dbPath, schedule: scheduleFn, remoteBackups: { recheck }, notify, now: () => at });
  disposals.push(() => health.stop(), () => integrity.stop());
  const remote = createRemoteBackupStore(dbPath, { now: () => at }), drills = createRestoreDrillStore(dbPath);
  const sources: PassportBackupSources = { backupHealth: health, backupIntegrity: integrity };
  const monitor = () => {
    const source = createServerBackupHealthSource(sources, () => at), fetchImpl = vi.fn<typeof fetch>(async () => new Response('OK'));
    const getEncryptionKey = vi.fn(() => new Uint8Array(32).fill(9));
    const service = createBackupWatchdog({ dbPath, getEncryptionKey, readEvidence: fresh => source(fresh), fetchImpl, now: () => at });
    sources.backupWatchdog = service; disposals.push(() => service.stop());
    return { service, fetchImpl, getEncryptionKey, path: backupWatchdogPath(dbPath) };
  };
  const copy = (age = 0, destinationId = 'a'.repeat(64)) => {
    const id = randomUUID(); remote.reserve({ operation_id: id, job_id: `arx-${id}`, fingerprint: destinationId, keep_last: 5,
      destination: { connection_name: 'private-storage-name', destination_id: destinationId, bucket: 'private-bucket', region: 'us-east-1', endpoint: 'https://fixture.invalid', prefix: 'private/' } });
    return remote.update(id, row => { row.state = 'verified'; row.bytes = 100; row.sha256 = 'b'.repeat(64); row.created_at = at - age; row.verified_at = at; });
  };
  const pass = (backup: ArchiveRemoteBackup, age = 0) => {
    const row: ArchiveRestoreDrill = { operation_id: randomUUID(), backup_operation_id: backup.operation_id, destination_id: backup.destination.destination_id,
      archive_sha256: backup.sha256!, archive_bytes: backup.bytes!, started_at: at - age, finished_at: at - age, state: 'succeeded',
      checks: { version: 1, server_version: '26.10.21', database_integrity: 'ok', foreign_keys: 'ok', local_boot_key: 'ok', database_bytes: 50,
        referenced_blobs: 1, restored_blob_records: 1, blob_bytes: 50 } };
    drills.reserve(row); return row;
  };
  const scan = (extra: Partial<ArchiveBackupIntegrityRun> = {}) => {
    integrity.save({ enabled: true, schedule: schedule.settings!.schedule });
    const run: ArchiveBackupIntegrityRun = { operation_id: randomUUID(), destination_id: schedule.settings!.destination_id, started_at: at - 1000,
      finished_at: at, outcome: 'completed', total: 2, checked: 2, skipped: 0, failed: 0, ...extra };
    const path = backupIntegrityPath(dbPath), saved = JSON.parse(readFileSync(path, 'utf8')); saved.last_run = run; writeFileSync(path, JSON.stringify(saved)); return run;
  };
  return { dir, dbPath, health, integrity, sources, schedule, scheduleFn, notify, recheck, remote, drills, copy, pass, scan, monitor,
    read: () => backupRecoveryForPassport(sources, () => at), time: () => at, advance: (ms: number) => { at += ms; } };
};

describe('Passport backup and recovery evidence', () => {
  it('distinguishes an absent monitor service from readable setup, without changing backup status', async () => {
    const h = setup(); h.copy();
    expect(h.read()).toMatchObject({ backup_status: 'configured', backup_evidence: { watchdog: { state: 'unavailable', issue: 'service_unavailable' } } });
    const m = h.monitor(); expect(h.read().backup_evidence!.watchdog).toEqual({ configured: false, enabled: false, state: 'not_configured' });
    await m.service.save({ enabled: false, ping_url: 'https://monitor.example/private-monitor-token' });
    expect(h.read().backup_evidence!.watchdog).toEqual({ configured: true, enabled: false, state: 'paused' });
    writeFileSync(m.path, '{private corrupted monitor settings');
    expect(h.read()).toMatchObject({ backup_status: 'configured', backup_evidence: { watchdog: { state: 'unavailable', issue: 'settings_unavailable' } } });
    h.sources.backupWatchdog = { status() { throw new Error('private URL and path'); } };
    expect(h.read().backup_evidence!.watchdog).toMatchObject({ state: 'unavailable', issue: 'service_unavailable' });
    expect(JSON.stringify(h.read())).not.toContain('private URL');
  });

  it('reads real monitor and drill evidence without decrypting, pinging or rewriting the drill, keeping owner reports separate', async () => {
    const h = setup(); h.pass(h.copy()); h.scan(); const m = h.monitor();
    await m.service.save({ enabled: true, ping_url: 'https://monitor.example/private-monitor-token' }); await m.service.tick();
    const operation_id = randomUUID(), configuration_revision = m.service.status().configuration_revision!;
    m.service.startDrill({ operation_id, configuration_revision, pause_minutes: 10 });
    const before = readFileSync(m.path, 'utf8'); m.getEncryptionKey.mockClear();
    for (let i = 0; i < 3; i++) expect(h.read().backup_evidence!.watchdog).toMatchObject({ state: 'drill_paused', drill: { phase: 'paused', operation_id, current_configuration: true } });
    expect(readFileSync(m.path, 'utf8')).toBe(before); expect(m.getEncryptionKey).not.toHaveBeenCalled(); expect(m.fetchImpl).toHaveBeenCalledTimes(1);
    h.advance(3 * 60_000); m.service.updateDrill({ operation_id, action: 'confirm_alert' });
    expect(h.read().backup_evidence!.watchdog).toMatchObject({ last_acknowledged_at: epoch, drill: { phase: 'resuming', alert_reported_at: h.time() } });
    expect(h.read().backup_evidence!.watchdog!.drill!.ping_acknowledged_at).toBeUndefined();
    await m.service.tick();
    expect(h.read().backup_evidence!.watchdog!.drill).toMatchObject({ phase: 'completed', alert_reported_at: h.time(), ping_acknowledged_at: h.time(), finished_at: h.time() });
    for (const privateText of ['private-monitor-token', 'configuration_revision', 'origin_revision', 'bound_revision', 'ciphertext', 'recoveryKey']) expect(JSON.stringify(h.read())).not.toContain(privateText);
    expect(h.notify).not.toHaveBeenCalled(); expect(h.recheck).not.toHaveBeenCalled();
  });

  it('projects expiration without a fresh ping claim, and marks historical results as belonging to the earlier setup', async () => {
    const h = setup(); h.pass(h.copy()); const m = h.monitor();
    await m.service.save({ enabled: true, ping_url: 'https://monitor.example/private-monitor-token' }); await m.service.tick();
    const operation_id = randomUUID(); m.service.startDrill({ operation_id, configuration_revision: m.service.status().configuration_revision!, pause_minutes: 10 });
    const paused = readFileSync(m.path, 'utf8'); h.advance(10 * 60_000);
    expect(h.read().backup_evidence!.watchdog!.drill).toMatchObject({ phase: 'resuming', resumed_at: h.time() });
    expect(h.read().backup_evidence!.watchdog!.drill!.ping_acknowledged_at).toBeUndefined();
    expect(m.fetchImpl).toHaveBeenCalledTimes(1); expect(readFileSync(m.path, 'utf8')).toBe(paused);
    await m.service.tick(); expect(h.read().backup_evidence!.watchdog!.drill!.phase).toBe('awaiting_confirmation');
    m.service.updateDrill({ operation_id, action: 'confirm_alert' });
    await m.service.save({ enabled: false });
    expect(h.read().backup_evidence!.watchdog).toMatchObject({ state: 'paused', drill: { phase: 'completed', current_configuration: false } });
    await m.service.save({ enabled: false, forget: true });
    expect(h.read().backup_evidence!.watchdog).toMatchObject({ state: 'not_configured', configured: false, drill: { phase: 'completed', current_configuration: false } });
  });

  it('preserves cancellation and supersession without treating either as alert-test success', async () => {
    const h = setup(); h.pass(h.copy()); const m = h.monitor();
    await m.service.save({ enabled: true, ping_url: 'https://monitor.example/private-monitor-token' }); await m.service.tick();
    for (const action of ['cancel', 'save'] as const) {
      const operation_id = randomUUID(); m.service.startDrill({ operation_id, configuration_revision: m.service.status().configuration_revision!, pause_minutes: 10 });
      if (action === 'cancel') m.service.updateDrill({ operation_id, action }); else await m.service.save({ enabled: true });
      expect(h.read().backup_evidence!.watchdog!.drill).toMatchObject({ phase: action === 'cancel' ? 'cancelled' : 'superseded', current_configuration: action === 'cancel' });
      expect(h.read().backup_evidence!.watchdog!.drill!.ping_acknowledged_at).toBeUndefined();
    }
  });

  it('does not sign future or unavailable monitor events as passing proof, and whitelists nested fields', () => {
    const h = setup(); h.copy();
    const value = { configured: true, enabled: true, state: 'acknowledged' as const, last_attempt_at: epoch, last_acknowledged_at: epoch,
      configuration_revision: randomUUID(), ping_url: 'private-url', secret: { ciphertext: 'private-capability' }, drill: {
        operation_id: randomUUID(), phase: 'completed' as const, current_configuration: true, pause_minutes: 10 as const,
        started_at: epoch - HOUR, pause_until: epoch - HOUR + 600_000, resumed_at: epoch - HOUR + 600_000,
        alert_reported_at: epoch, ping_acknowledged_at: epoch, finished_at: epoch, provider_body: 'private-provider-body', recovery_words: 'private-words',
      } };
    h.sources.backupWatchdog = { status: () => value };
    for (const text of ['private-url', 'private-capability', 'private-provider-body', 'private-words', value.configuration_revision]) expect(JSON.stringify(h.read())).not.toContain(text);
    const detached = h.read().backup_evidence!.watchdog!; detached.drill!.phase = 'cancelled'; expect(h.read().backup_evidence!.watchdog!.drill!.phase).toBe('completed');
    for (const field of ['last_attempt_at', 'last_acknowledged_at'] as const) {
      h.sources.backupWatchdog = { status: () => ({ ...value, [field]: epoch + 1 }) };
      expect(h.read()).toMatchObject({ backup_status: 'configured', backup_evidence: { watchdog: { state: 'unavailable', issue: 'clock_changed' } } });
      expect(h.read().backup_evidence!.watchdog!.drill).toBeUndefined();
    }
    for (const field of ['started_at', 'resumed_at', 'alert_reported_at', 'ping_acknowledged_at', 'finished_at'] as const) {
      h.sources.backupWatchdog = { status: () => ({ ...value, drill: { ...value.drill, [field]: epoch + 1 } }) };
      expect(h.read().backup_evidence!.watchdog).toEqual({ configured: true, enabled: true, state: 'unavailable', issue: 'clock_changed' });
    }
    h.sources.backupWatchdog = { status: () => ({ ...value, state: 'unavailable', issue: 'settings_unavailable' }) };
    expect(h.read().backup_evidence!.watchdog).toEqual({ configured: true, enabled: true, state: 'unavailable', issue: 'settings_unavailable' });
  });

  it('stops external watchdog pings when real backup receipt evidence becomes overdue', async () => {
    const h = setup(), copy = h.copy(HOUR); h.pass(copy); h.scan();
    const source = createServerBackupHealthSource(h.sources, () => h.time()), fetchImpl = vi.fn<typeof fetch>(async () => new Response('OK'));
    const service = createBackupWatchdog({ dbPath: h.dbPath, getEncryptionKey: () => new Uint8Array(32).fill(9),
      readEvidence: () => source(true), fetchImpl, now: () => h.time() }); disposals.push(() => service.stop());
    await service.save({ enabled: true, ping_url: 'https://monitor.example/private-fixture-token' }); await service.tick();
    expect(fetchImpl).toHaveBeenCalledTimes(1); h.advance(40 * HOUR); await service.tick();
    expect(fetchImpl).toHaveBeenCalledTimes(1); expect(service.status().state).toBe('blocked');
    expect(h.notify).not.toHaveBeenCalled(); expect(h.recheck).not.toHaveBeenCalled();
  });

  it('feeds the heartbeat cache from the same real receipt observers without starting work', () => {
    const h = setup(); const copy = h.copy(HOUR); h.pass(copy); h.scan();
    const source = createServerBackupHealthSource(h.sources, () => h.time());
    expect(source()).toEqual({ age_ms: 0, monitoring: 'active', backup_state: 'current', recovery_test_state: 'current', integrity: { monitoring: 'active', state: 'completed' } });
    h.advance(40 * HOUR); expect(source().backup_state).toBe('due'); expect(h.notify).not.toHaveBeenCalled(); expect(h.recheck).not.toHaveBeenCalled();
  });

  it('projects current receipt proof without starting any backup, S3 request, recovery test or notification', () => {
    const h = setup(), copy = h.copy(HOUR), pass = h.pass(copy, HOUR / 2), scan = h.scan();
    expect(h.read()).toMatchObject({ backup_status: 'configured', last_backup_at: epoch - HOUR,
      backup_evidence: { observed_at: epoch, monitoring: 'active', destination: { connection_name: 'private-storage-name', destination_id: 'a'.repeat(64) },
        backup: { state: 'current', operation_id: copy.operation_id, created_at: epoch - HOUR, verified_at: epoch },
        recovery_test: { state: 'current', operation_id: pass.operation_id, backup_operation_id: copy.operation_id, finished_at: epoch - HOUR / 2 },
        integrity: { monitoring: 'active', state: 'completed', last_run: { operation_id: scan.operation_id, checked: 2, total: 2, failed: 0, skipped: 0 } } } });
    expect(h.read().backup_evidence!.integrity.last_run).not.toHaveProperty('destination_id');
    expect(h.notify).not.toHaveBeenCalled(); expect(h.recheck).not.toHaveBeenCalled();
    const json = JSON.stringify(h.read()); for (const privateText of ['private-bucket', 'fixture.invalid', h.dir, 'object_key', 'sha256', 'recoveryKey']) expect(json).not.toContain(privateText);
  });

  it('reads current state on every call and keeps backup creation age distinct from later verification', () => {
    const h = setup(), old = h.copy(40 * HOUR); h.pass(old);
    expect(h.read()).toMatchObject({ backup_status: 'overdue', last_backup_at: epoch - 40 * HOUR, backup_evidence: { recovery_test: { state: 'current' } } });
    h.advance(HOUR); h.remote.update(old.operation_id, row => { row.verified_at = h.time(); });
    expect(h.read().backup_status).toBe('overdue'); const fresh = h.copy();
    expect(h.read()).toMatchObject({ backup_status: 'configured', last_backup_at: h.time(), backup_evidence: { backup: { operation_id: fresh.operation_id } } });
  });

  it('distinguishes missing first proof, overdue proof, a paused schedule, and an unconfigured schedule', () => {
    const h = setup();
    expect(h.read()).toMatchObject({ backup_status: 'configured', backup_evidence: { backup: { state: 'waiting' }, recovery_test: { state: 'waiting' } } });
    expect(h.read().last_backup_at).toBeUndefined(); h.advance(37 * HOUR); expect(h.read().backup_status).toBe('overdue');
    h.schedule.settings!.enabled = false;
    expect(h.read()).toMatchObject({ backup_status: 'configured', backup_evidence: { monitoring: 'paused' } });
    expect(h.read().backup_evidence!.backup).toBeUndefined(); expect(h.read().last_backup_at).toBeUndefined();
    h.schedule.configured = false; delete h.schedule.settings;
    expect(h.read()).toMatchObject({ backup_status: 'unconfigured', backup_evidence: { monitoring: 'not_configured', integrity: { monitoring: 'not_configured', state: 'not_checked' } } });
  });

  it('uses unavailable for missing services, damaged history and settings, with no raw errors', () => {
    expect(backupRecoveryForPassport(undefined, () => epoch)).toMatchObject({ backup_status: 'unavailable', backup_evidence: { monitoring: 'unavailable' } });
    const h = setup(); h.copy(); h.read(); writeFileSync(remoteBackupLedgerPath(h.dbPath), '{bad receipt history');
    expect(h.read()).toMatchObject({ backup_status: 'unavailable', backup_evidence: { backup: { state: 'unavailable', issue: 'history_unavailable' }, recovery_test: { state: 'unavailable' } } });
    h.scheduleFn.mockImplementation(() => { throw new Error('private source error'); });
    expect(h.read()).toMatchObject({ backup_status: 'unavailable', backup_evidence: { monitoring: 'unavailable', issue: 'schedule_unavailable' } });
    expect(h.read().last_backup_at).toBeUndefined();
    const broken = backupRecoveryForPassport({ backupHealth: { status() { throw new Error('private history path'); } }, backupIntegrity: { status() { throw new Error('private scan path'); } } }, () => epoch);
    expect(broken.backup_status).toBe('unavailable'); expect(JSON.stringify(broken)).not.toContain('private');
  });

  it('separates stale recovery evidence from recent backups and accepts bound historical tests of a pruned copy', () => {
    const h = setup(), old = h.copy(40 * DAY); h.pass(old, 31 * DAY); h.remote.update(old.operation_id, row => { row.state = 'pruned'; }); h.copy();
    expect(h.read()).toMatchObject({ backup_status: 'configured', backup_evidence: { recovery_test: { state: 'due', backup_operation_id: old.operation_id } } });
    const pass = h.pass(old); expect(h.read().backup_evidence!.recovery_test).toMatchObject({ state: 'current', operation_id: pass.operation_id });
    h.drills.update(pass.operation_id, row => { row.archive_sha256 = 'd'.repeat(64); });
    expect(h.read().backup_evidence!.recovery_test!.state).toBe('due');
  });

  it('rejects evidence from another destination and omits an old destination scan', () => {
    const h = setup(); h.copy(); const scan = h.scan(); h.schedule.settings!.destination_id = 'c'.repeat(64);
    const value = h.read(); expect(value.last_backup_at).toBeUndefined(); expect(value.backup_evidence!.backup!.state).toBe('waiting');
    expect(value.backup_evidence!.integrity).toMatchObject({ monitoring: 'active', state: 'not_checked' });
    expect(value.backup_evidence!.integrity.last_run).toBeUndefined(); expect(JSON.stringify(value)).not.toContain(scan.operation_id);
  });

  it('clears positive claims if the clock moves behind the observer timestamp', () => {
    const h = setup(); h.copy(); h.pass(h.remote.rows()[0]!); h.scan();
    const value = backupRecoveryForPassport(h.sources, () => epoch - HOUR);
    expect(value).toMatchObject({ backup_status: 'unavailable', backup_evidence: { monitoring: 'unavailable', issue: 'clock_changed', integrity: { state: 'unavailable' } } });
    expect(value.last_backup_at).toBeUndefined(); expect(value.backup_evidence!.backup).toBeUndefined(); expect(value.backup_evidence!.recovery_test).toBeUndefined();
  });

  it.each([
    ['completed', { total: 2, checked: 2, skipped: 0 }],
    ['partial', { total: 3, checked: 2, skipped: 1 }],
    ['empty', { total: 0, checked: 0, skipped: 0 }],
    ['running', { outcome: 'running', finished_at: undefined, total: 3, checked: 1, skipped: 0 }],
    ['failed', { outcome: 'failed', total: 2, checked: 2, skipped: 0, failed: 1, issue: 'verification_failed' }],
  ] satisfies [string, Partial<ArchiveBackupIntegrityRun>][])('reports a %s scan independently of current backup age', (state, run) => {
    const h = setup(); h.copy(); h.scan(run); const value = h.read();
    expect(value.backup_status).toBe('configured'); expect(value.backup_evidence!.integrity.state).toBe(state);
  });

  it('does not report a successful scan for unavailable policy, future results, or a mismatched scope', () => {
    const h = setup(); h.copy(); const run = h.scan({ finished_at: epoch + HOUR });
    expect(h.read().backup_evidence!.integrity).toMatchObject({ state: 'unavailable', issue: 'clock_changed' });
    expect(h.read().backup_evidence!.integrity.last_run).toBeUndefined();
    writeFileSync(backupIntegrityPath(h.dbPath), '{bad settings');
    expect(h.read().backup_evidence!.integrity).toMatchObject({ state: 'unavailable', issue: 'settings_unavailable' });
    const health = h.health.status(), scan = { ...h.integrity.status(), monitoring: 'active' as const, destination: { connection_name: 'wrong', destination_id: 'f'.repeat(64) }, last_run: run };
    const value = backupRecoveryForPassport({ backupHealth: { status: () => health }, backupIntegrity: { status: () => scan } }, () => epoch);
    expect(value.backup_evidence!.integrity).toMatchObject({ state: 'unavailable', issue: 'destination_changed' });
  });

  it('whitelists nested receipt fields rather than copying future service metadata', () => {
    const h = setup(); h.copy(); h.pass(h.remote.rows()[0]!); h.scan();
    const health = h.health.status(), scan = h.integrity.status();
    const injectedHealth = { ...health, provider_body: 'private-provider-body', backup: { ...health.backup!, recoveryKey: 'private-words' }, recovery: { ...health.recovery!, private_path: '/private-test-realm' } };
    const injectedScan = { ...scan, last_run: { ...scan.last_run!, ciphertext: 'private-capability' } };
    const value = backupRecoveryForPassport({ backupHealth: { status: () => injectedHealth }, backupIntegrity: { status: () => injectedScan } }, () => epoch);
    for (const secret of ['private-provider-body', 'private-words', '/private-test-realm', 'private-capability']) expect(JSON.stringify(value)).not.toContain(secret);
  });
});
