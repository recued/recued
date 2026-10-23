import { describe, expect, it, vi } from 'vitest';
import type { ArchiveBackupHealthStatus, ArchiveBackupIntegrityStatus } from '@recued/contracts';
import { createServerBackupHealthSource, SERVER_BACKUP_HEALTH_REFRESH_MS } from '../archive/server-backup-health.js';

const epoch = Date.UTC(2026, 9, 21);
const setup = () => {
  let at = epoch;
  const destination = { connection_name: 'private-s3-name', destination_id: 'a'.repeat(64) };
  const health: ArchiveBackupHealthStatus = { checked_at: at, monitoring: 'active', destination, policy: { alerts_enabled: true, backup_max_age_hours: 36, recovery_max_age_days: 30 }, alerts: [],
    backup: { state: 'current', operation_id: 'private-copy', created_at: at - 1000, verified_at: at - 500, due_at: at + 3600000 }, recovery: { state: 'waiting', due_at: at + 3600000 } };
  const integrity: ArchiveBackupIntegrityStatus = { monitoring: 'active', destination, policy: { enabled: true, schedule: { cadence: 'daily', hour_utc: 4, minute_utc: 0, weekday_utc: 0 } },
    next_run_at: at + 3600000, last_run: { operation_id: 'private-scan', destination_id: destination.destination_id, started_at: at - 1000, finished_at: at - 500, outcome: 'completed', total: 2, checked: 2, failed: 0, skipped: 0 } };
  const healthRead = vi.fn(() => ({ ...health, checked_at: at })), integrityRead = vi.fn(() => integrity);
  const source = createServerBackupHealthSource({ backupHealth: { status: healthRead }, backupIntegrity: { status: integrityRead } }, () => at);
  return { source, health, integrity, healthRead, integrityRead, advance: (ms: number) => { at += ms; } };
};
describe('cached heartbeat backup source', () => {
  it('excludes monitor observers on wider source objects to avoid recursively reading its own consumer', () => {
    const h = setup(), monitorRead = vi.fn(() => { throw new Error('A monitor status can read this source again'); });
    const widerSources = { backupHealth: { status: h.healthRead }, backupIntegrity: { status: h.integrityRead }, backupWatchdog: { status: monitorRead } };
    const source = createServerBackupHealthSource(widerSources, () => epoch);
    expect(source(true).backup_state).toBe('current'); expect(monitorRead).not.toHaveBeenCalled();
    expect(JSON.stringify(source())).not.toContain('watchdog');
  });
  it('allows the watchdog to force a fresh admission read within a heartbeat cache interval', () => {
    const h = setup(); h.source(); h.health.backup!.state = 'due';
    expect(h.source().backup_state).toBe('current'); expect(h.source(true).backup_state).toBe('due');
    expect(h.healthRead).toHaveBeenCalledTimes(2);
  });
  it('is lazy and reads full receipt observers at most once per minute, reporting age between reads', () => {
    const h = setup(); expect(h.healthRead).not.toHaveBeenCalled(); expect(h.integrityRead).not.toHaveBeenCalled();
    expect(h.source()).toEqual({ age_ms: 0, monitoring: 'active', backup_state: 'current', recovery_test_state: 'waiting', integrity: { monitoring: 'active', state: 'completed' } });
    h.health.backup!.state = 'due';
    for (let n = 1; n < 12; n++) { h.advance(5000); expect(h.source()).toMatchObject({ age_ms: n * 5000, backup_state: 'current' }); }
    expect(h.healthRead).toHaveBeenCalledTimes(1); expect(h.integrityRead).toHaveBeenCalledTimes(1);
    h.advance(5000); expect(h.source()).toMatchObject({ age_ms: 0, backup_state: 'due' }); expect(h.healthRead).toHaveBeenCalledTimes(2);
  });

  it('omits private metadata and returns detached state so a consumer cannot mutate the cache', () => {
    const h = setup(), first = h.source(); first.integrity.state = 'failed'; first.backup_state = 'unavailable';
    expect(h.source()).toMatchObject({ backup_state: 'current', integrity: { state: 'completed' } });
    const text = JSON.stringify(h.source()); for (const privateText of ['private-', 'aaaa', 'operation_id', 'due_at', 'next_run_at', 'created_at', 'checked', 'total', 'policy']) expect(text).not.toContain(privateText);
  });

  it('keeps source failures bounded and can recover after the next cache interval', () => {
    const h = setup(); h.healthRead.mockImplementationOnce(() => { throw new Error('private failure path'); });
    expect(h.source().monitoring).toBe('unavailable'); h.advance(SERVER_BACKUP_HEALTH_REFRESH_MS - 1); expect(h.source().monitoring).toBe('unavailable');
    h.advance(1); expect(h.source().monitoring).toBe('active');
    expect(createServerBackupHealthSource({}, () => epoch)()).toMatchObject({ age_ms: 0, monitoring: 'unavailable', integrity: { state: 'unavailable' } });
  });

  it('rereads after clock rollback rather than extending the lifetime of a future cached observation', () => {
    const h = setup(); h.source(); h.advance(-100); expect(h.source().age_ms).toBe(0); expect(h.healthRead).toHaveBeenCalledTimes(2);
  });
});
