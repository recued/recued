import { describe, expect, it } from 'vitest';
import { serverBackupHealthView, SERVER_BACKUP_HEALTH_STALE_MS, type ServerBackupHealthSnapshot } from '../server-backup-health.js';
import { computePillState, type ServerHeartbeatSnapshot } from '../server-pill.js';

const healthy = (): ServerBackupHealthSnapshot => ({ age_ms: 0, monitoring: 'active', backup_state: 'current', recovery_test_state: 'current', integrity: { monitoring: 'active', state: 'completed' } });
const now = 1_000_000;
const heartbeat = (backup_health: ServerBackupHealthSnapshot, extra: Partial<ServerHeartbeatSnapshot> = {}): ServerHeartbeatSnapshot => ({ server_id: 'fixture', last_seen_at: now, lifecycle_state: 'running', backup_health, ...extra });
describe('server backup summaries', () => {
  it('preserves older servers and renders healthy/waiting states without manufacturing warnings', () => {
    expect(serverBackupHealthView(undefined)).toBeUndefined();
    expect(serverBackupHealthView(healthy())).toMatchObject({ warnings: [], rows: ['Backup within age limit', 'Recovery test within age limit', 'Last S3 scan completed'] });
    const waiting = { ...healthy(), backup_state: 'waiting', recovery_test_state: 'waiting', integrity: { monitoring: 'active', state: 'not_checked' } };
    expect(serverBackupHealthView(waiting)?.warnings).toEqual([]);
    expect(serverBackupHealthView({ ...waiting, integrity: { monitoring: 'active', state: 'empty' } })?.rows).toContain('Last S3 scan selected no copies');
  });

  it('keeps backup age, recovery age and failed/partial scans independent', () => {
    const overdue = { ...healthy(), backup_state: 'due', recovery_test_state: 'due', integrity: { monitoring: 'active', state: 'failed' } };
    expect(serverBackupHealthView(overdue)?.warnings).toEqual(['backup_overdue', 'recovery_stale', 'integrity_failed']);
    expect(serverBackupHealthView({ ...healthy(), integrity: { monitoring: 'paused', state: 'partial' } })?.warnings).toEqual(['integrity_partial']);
    expect(serverBackupHealthView({ ...healthy(), integrity: { monitoring: 'paused', state: 'failed' } })?.warnings).toEqual(['integrity_failed']);
    expect(serverBackupHealthView({ ...healthy(), integrity: { monitoring: 'paused', state: 'not_checked' } })?.warnings).toEqual([]);
  });

  it('keeps paused/unconfigured backup schedules neutral without claiming a healthy backup', () => {
    for (const monitoring of ['paused', 'not_configured']) {
      const view = serverBackupHealthView({ ...healthy(), monitoring, backup_state: 'due' })!;
      expect(view.warnings).toEqual([]); expect(view.rows).toHaveLength(1); expect(view.rows[0]).toContain(monitoring === 'paused' ? 'paused' : 'not configured');
    }
  });

  it('treats missing evidence, failed observation, malformed and unknown states as unavailable', () => {
    expect(serverBackupHealthView({ ...healthy(), backup_state: undefined })?.warnings).toContain('evidence_unavailable');
    expect(serverBackupHealthView({ ...healthy(), integrity: { monitoring: 'unavailable', state: 'completed' } })?.warnings).toEqual(['integrity_unavailable']);
    for (const bad of [null, {}, [], 'private body', { ...healthy(), age_ms: -1 }, { ...healthy(), age_ms: NaN }, { ...healthy(), monitoring: 'private secret' },
      { ...healthy(), backup_state: '<img src=x onerror=alert(1)>' }, { ...healthy(), integrity: null }, { ...healthy(), integrity: { monitoring: 'active', state: 'unknown-new-code' } }]) {
      expect(serverBackupHealthView(bad)).toEqual({ warnings: ['evidence_unavailable'], rows: ['Backup status unavailable'], aria: 'Backup status unavailable' });
    }
  });

  it('expires cached observations using server age plus local time since heartbeat receipt', () => {
    const value = { ...healthy(), age_ms: SERVER_BACKUP_HEALTH_STALE_MS - 1000 };
    expect(serverBackupHealthView(value, 999)?.warnings).toEqual([]);
    expect(serverBackupHealthView(value, 1000)?.warnings).toEqual(['evidence_unavailable']);
    for (const elapsed of [-1, Infinity, NaN]) expect(serverBackupHealthView(healthy(), elapsed)?.warnings).toEqual(['evidence_unavailable']);
  });

  it('adds amber attention while preserving every existing higher-priority tier', () => {
    const backup = { ...healthy(), backup_state: 'due' as const };
    expect(computePillState(heartbeat(backup), now)).toMatchObject({ dot: 'amber', label: 'attention', aria: 'Server attention — Backup overdue' });
    expect(computePillState(heartbeat(backup, { last_seen_at: 0 }), now).label).toBe('offline');
    expect(computePillState(heartbeat(backup, { crash_halt_active: true }), now).dot).toBe('red');
    expect(computePillState(heartbeat(backup, { paused: true }), now).glyph).toBe('pause');
    expect(computePillState(heartbeat(backup, { lifecycle_state: 'restarting' }), now).label).toBe('busy');
    for (const worst_state of ['halted', 'writes_blocked', 'pressure_managed'] as const) {
      expect(computePillState(heartbeat(backup, { pressure_details: { worst_state, per_surface: [] } }), now).aria).not.toContain('Backup');
    }
    expect(computePillState(heartbeat(backup, { reclaim_in_flight: true }), now).label).toBe('busy');
    expect(computePillState(heartbeat(healthy()), now).label).toBe('running');
  });
});
