import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ArchiveBackupHealthStatus, ArchiveRemoteBackup } from '@recued/contracts';
import { mountBackupHealth, type BackupHealthPorts } from '../settings/backup-health-panel.js';
import { mountRemoteBackups } from '../settings/remote-backups-panel.js';
import { pickerTestDom } from './helpers/file-download-picker-dom.js';

const initial: ArchiveBackupHealthStatus = { checked_at: 1, monitoring: 'active', destination: { connection_name: 'safe', destination_id: 'a'.repeat(64) }, watched_since: 1,
  policy: { alerts_enabled: true, backup_max_age_hours: 36, recovery_max_age_days: 30 }, alerts: [], backup: { state: 'waiting', due_at: 100 }, recovery: { state: 'waiting', due_at: 200 } };
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); vi.useRealTimers(); });
const setup = async (value = initial) => {
  const { root, document } = pickerTestDom(); let current = structuredClone(value);
  const get = vi.fn<BackupHealthPorts['get']>(async () => current);
  const save = vi.fn<BackupHealthPorts['save']>(async input => { current = { ...current, policy: input.policy }; return current; });
  const mounted = mountBackupHealth({ host: root as unknown as HTMLElement, document, ports: { get, save } }); disposals.push(() => mounted.dispose());
  const node = (name: string) => { const n = root.querySelector(`[data-backup-health-${name}]`); if (!n) throw new Error(name); return n; };
  await vi.waitFor(() => expect(node('save').disabled).toBe(false));
  return { root, node, mounted, get, save, current: (next: ArchiveBackupHealthStatus) => { current = next; } };
};

describe('backup health panel', () => {
  it('distinguishes missing first evidence from current proof and saves only bounded age limits', async () => {
    const h = await setup(); expect(h.node('backup').textContent).toContain('Waiting for the first verified backup');
    expect(h.node('recovery').textContent).toContain('Waiting for the first passing recovery test');
    h.node('hours').value = '48'; h.node('hours').fire('input'); h.node('days').value = '14'; h.node('days').fire('input');
    h.node('save').click();
    expect(h.save).toHaveBeenCalledExactlyOnceWith({ policy: { alerts_enabled: true, backup_max_age_hours: 48, recovery_max_age_days: 14 } });
    await vi.waitFor(() => expect(h.node('feedback').textContent).toBe('Health limits saved.'));
    await h.mounted.refresh(); expect(h.save).toHaveBeenCalledTimes(1); expect(h.root.textContent).toContain('may cover an older copy');
  });

  it('refreshes evidence and delivery status without repainting unsaved inputs', async () => {
    const h = await setup(); const input = h.node('hours'); input.value = '72'; input.fire('input');
    h.current({ ...initial, backup: { state: 'due', created_at: 1, verified_at: 2, operation_id: 'copy-id', due_at: 100 },
      recovery: { state: 'unavailable', issue: 'clock_changed' }, alerts: [{ kind: 'backup_overdue', first_detected_at: 3, delivery: 'pending' }] });
    await h.mounted.refresh();
    expect(h.node('hours')).toBe(input); expect(input.value).toBe('72'); expect(h.node('backup').textContent).toContain('Backup overdue');
    expect(h.node('backup').textContent).toContain('copy-id'); expect(h.node('recovery').textContent).toContain('Check the server clock');
    expect(h.node('alerts').textContent).toContain('awaiting notification delivery');
  });

  it('validates limits before dispatch and lets the owner disable notifications without any recovery input', async () => {
    const h = await setup();
    for (const [name, value] of [['hours', '0'], ['hours', '8761'], ['hours', '1.5'], ['days', '366']]) {
      h.node('hours').value = '36'; h.node('days').value = '30'; h.node(name!).value = value!; h.node('save').click();
    }
    expect(h.save).not.toHaveBeenCalled();
    h.node('hours').value = '36'; h.node('days').value = '30'; h.node('enabled').checked = false; h.node('save').click();
    expect(h.save).toHaveBeenCalledExactlyOnceWith({ policy: { ...initial.policy, alerts_enabled: false } });
    await vi.waitFor(() => expect(h.node('alerts').textContent).toContain('Health alerts are off'));
  });

  it('discards a poll started before a save and preserves a newer draft made during that save', async () => {
    const h = await setup(); let readReply = (_: ArchiveBackupHealthStatus) => {}, saveReply = (_: ArchiveBackupHealthStatus) => {};
    h.get.mockImplementationOnce(() => new Promise(resolve => { readReply = resolve; }));
    h.save.mockImplementationOnce(() => new Promise(resolve => { saveReply = resolve; }));
    const reading = h.mounted.refresh(); h.node('hours').value = '48'; h.node('hours').fire('input'); h.node('save').click();
    h.node('hours').value = '72'; h.node('hours').fire('input');
    const saved = { ...initial, policy: { ...initial.policy, backup_max_age_hours: 48 } }; h.current(saved); saveReply(saved);
    await vi.waitFor(() => expect(h.node('feedback').textContent).toContain('newer edits'));
    readReply(initial); await reading;
    expect(h.node('hours').value).toBe('72'); expect(h.save).toHaveBeenCalledTimes(1);
    h.node('save').click(); expect(h.save).toHaveBeenLastCalledWith({ policy: { ...initial.policy, backup_max_age_hours: 72 } });
  });

  it('clears stale health claims on a read failure and never echoes a raw save error or resends it', async () => {
    const h = await setup({ ...initial, backup: { state: 'current', created_at: 1, due_at: 100 } });
    expect(h.node('backup').textContent).toContain('within the age limit');
    h.get.mockRejectedValueOnce(new Error('private provider body')); await h.mounted.refresh();
    expect(h.node('save').disabled).toBe(true); expect(h.node('backup').textContent).toBe(''); expect(h.root.textContent).not.toContain('private provider');
    await h.mounted.refresh(); h.save.mockRejectedValueOnce(new Error('secret raw server path')); h.node('save').click();
    await vi.waitFor(() => expect(h.node('feedback').textContent).toContain('could not be confirmed'));
    await h.mounted.refresh(); expect(h.save).toHaveBeenCalledTimes(1); expect(h.root.textContent).not.toContain('secret raw');
  });

  it('shows unavailable settings without enabling overwrite and ignores a late reply after disposal', async () => {
    const h = await setup();
    for (const issue of ['settings_unavailable', 'schedule_unavailable'] as const) {
      h.current({ ...initial, policy: { ...initial.policy, backup_max_age_hours: 192 }, monitoring: 'unavailable', issue, backup: undefined, recovery: undefined });
      await h.mounted.refresh(); expect(h.node('save').disabled).toBe(true); h.node('save').click(); expect(h.save).not.toHaveBeenCalled();
      expect(h.node('hours').value).toBe('36');
    }
    h.current(initial); await h.mounted.refresh();
    let reply = (_: ArchiveBackupHealthStatus) => {}; h.save.mockImplementationOnce(() => new Promise(resolve => { reply = resolve; }));
    h.node('save').click(); h.mounted.dispose(); const before = h.root.textContent; reply(initial); await Promise.resolve(); await Promise.resolve();
    expect(h.root.textContent).toBe(before); expect(h.node('save').disabled).toBe(true);
  });

  it('continues health refreshes when remote history fails and leaves adjacent recovery words untouched', async () => {
    const { root, document } = pickerTestDom();
    const backup: ArchiveRemoteBackup = { operation_id: '12345678-1234-4234-8234-123456789abc', job_id: 'arx-fixture', created_at: 1, object_key: 'fixture', keep_last: 5,
      destination: { connection_name: 'safe', destination_id: 'a'.repeat(64), endpoint: 'https://fixture.invalid', bucket: 'fixture', region: 'us-east-1', prefix: '' }, state: 'verified', sha256: 'b'.repeat(64), bytes: 100 };
    const get = vi.fn(async () => initial), list = vi.fn(async () => ({ backups: [backup] })); let reconnect = () => {};
    const mounted = mountRemoteBackups({ host: root as unknown as HTMLElement, document, onRestore: () => true, ports: {
      list, destinations: async () => ({ destinations: [backup.destination] }), check: async () => backup, retrieve: vi.fn(),
      health: { get, save: async input => ({ ...initial, policy: input.policy }) },
      drills: { list: async () => ({ drills: [] }), start: vi.fn(), cancel: vi.fn(), cleanup: vi.fn() },
      onConnected: listener => { reconnect = listener; return () => {}; },
    } }); disposals.push(() => mounted.dispose());
    await vi.waitFor(() => expect(root.querySelector('[data-remote-backup-drill]')).not.toBeNull());
    root.querySelector('[data-remote-backup-drill]')!.click();
    const words = root.querySelector('[data-drill-words]')!; words.value = 'new unsubmitted draft';
    list.mockRejectedValueOnce(new Error('private remote history')); const calls = get.mock.calls.length;
    reconnect(); await vi.waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(calls));
    expect(words.value).toBe('new unsubmitted draft'); expect(root.textContent).not.toContain('private remote history');
  });
});
