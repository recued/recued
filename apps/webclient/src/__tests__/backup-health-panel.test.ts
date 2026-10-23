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
  let now = 1_700_000_000_000;
  const get = vi.fn<BackupHealthPorts['get']>(async () => current);
  const save = vi.fn<BackupHealthPorts['save']>(async input => { current = { ...current, policy: input.policy }; return current; });
  const mounted = mountBackupHealth({ host: root as unknown as HTMLElement, document, ports: { get, save }, now: () => now }); disposals.push(() => mounted.dispose());
  const node = (name: string) => { const n = root.querySelector(`[data-backup-health-${name}]`); if (!n) throw new Error(name); return n; };
  await vi.waitFor(() => expect(node('save').disabled).toBe(false));
  return { root, node, mounted, get, save, now: (value: number) => { now = value; }, current: (next: ArchiveBackupHealthStatus) => { current = next; } };
};

describe('backup health panel', () => {
  it('identifies both invalid limits, focuses the first, and clears only corrected errors through refresh', async () => {
    const h = await setup(), hours = h.node('hours'), days = h.node('days');
    hours.value = ''; hours.fire('input'); days.value = '366'; days.fire('input');
    const focusHours = vi.spyOn(hours, 'focus'), focusDays = vi.spyOn(days, 'focus');
    h.node('save').click(); expect(h.save).not.toHaveBeenCalled();
    expect(focusHours).toHaveBeenCalledTimes(1); expect(focusDays).not.toHaveBeenCalled();
    for (const name of ['hours', 'days']) {
      expect(h.node(name).getAttribute('aria-invalid')).toBe('true');
      expect(h.node(name).getAttribute('aria-describedby')).toBe(h.node(`${name}-error`).id);
    }
    expect(h.node('hours-error').textContent).toBe('Enter a whole number from 1 to 8760 hours.');
    expect(h.node('days-error').textContent).toBe('Enter a whole number from 1 to 365 days.');
    await h.mounted.refresh(); expect(hours.value).toBe(''); expect(days.value).toBe('366');
    expect(h.node('hours')).toBe(hours); expect(focusHours).toHaveBeenCalledTimes(1);
    hours.value = '72'; hours.fire('input');
    expect(hours.getAttribute('aria-invalid')).toBeNull(); expect(hours.getAttribute('aria-describedby')).toBeNull();
    expect(h.node('hours-error').textContent).toBe(''); expect(days.getAttribute('aria-invalid')).toBe('true');
    h.node('save').click(); expect(focusDays).toHaveBeenCalledTimes(1);
    days.value = '14'; days.fire('change'); expect(days.getAttribute('aria-invalid')).toBeNull();
    h.node('save').click(); expect(h.save).toHaveBeenCalledExactlyOnceWith({ policy: { alerts_enabled: true, backup_max_age_hours: 72, recovery_max_age_days: 14 } });
  });

  it('stamps accepted completion and retains that time through pending, failed, and unavailable reads', async () => {
    const h = await setup(); const first = h.node('last-refreshed').getAttribute('datetime');
    expect(first).toBe('2023-11-14T22:13:20.000Z');
    const input = h.node('hours'); input.value = '72'; input.fire('input'); input.focus();
    let finish!: (value: ArchiveBackupHealthStatus) => void;
    h.get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    h.now(1_700_000_001_000); const reading = h.mounted.refresh();
    expect(h.node('refresh-status').textContent).toContain('Refreshing status…');
    expect(h.node('last-refreshed').getAttribute('datetime')).toBe(first);
    h.now(1_700_000_002_000); finish(initial); await reading;
    const accepted = h.node('last-refreshed').getAttribute('datetime');
    expect(accepted).toBe('2023-11-14T22:13:22.000Z');
    h.now(1_700_000_003_000); h.get.mockRejectedValueOnce(new Error('private provider path')); await h.mounted.refresh();
    expect(h.node('refresh-status').textContent).toContain('Latest status refresh failed.');
    expect(h.node('last-refreshed').getAttribute('datetime')).toBe(accepted);
    h.current({ ...initial, monitoring: 'unavailable', issue: 'settings_unavailable' }); await h.mounted.refresh();
    expect(h.node('last-refreshed').getAttribute('datetime')).toBe(accepted);
    expect(h.node('refresh-status').textContent).toContain('Latest status refresh failed.');
    h.current({ ...initial, monitoring: 'paused' }); await h.mounted.refresh();
    expect(h.node('last-refreshed').getAttribute('datetime')).toBe('2023-11-14T22:13:23.000Z');
    expect(h.node('refresh-status').textContent).not.toContain('failed');
    expect(input.value).toBe('72'); expect(input.focused).toBe(true); expect(h.node('hours')).toBe(input);
    expect(h.root.textContent).not.toContain('private provider'); expect(h.save).not.toHaveBeenCalled();
  });

  it.each(['success', 'failure'] as const)('leaves initial failure and disposed %s reads without a fabricated timestamp', async outcome => {
    const { root, document } = pickerTestDom();
    const get = vi.fn<BackupHealthPorts['get']>().mockRejectedValueOnce(new Error('Initial unavailable'));
    const mounted = mountBackupHealth({ host: root as unknown as HTMLElement, document, ports: { get, save: vi.fn() } });
    disposals.push(() => mounted.dispose()); await vi.waitFor(() => expect(root.textContent).toContain('Latest status refresh failed.'));
    expect(root.querySelector('[data-backup-health-last-refreshed]')).toBeNull();
    let resolve!: (value: ArchiveBackupHealthStatus) => void, reject!: (error: Error) => void;
    get.mockImplementationOnce(() => new Promise((done, fail) => { resolve = done; reject = fail; }));
    const reading = mounted.refresh(); mounted.dispose(); const before = root.textContent;
    if (outcome === 'success') resolve(initial); else reject(new Error('Late private failure'));
    await reading; expect(root.textContent).toBe(before);
    expect(root.querySelector('[data-backup-health-last-refreshed]')).toBeNull();
  });

  it.each([true, false])('recovers from an uncertain save and an older failed read (old first: %s)', async oldFirst => {
    const h = await setup(), input = h.node('hours');
    const previous = h.node('last-refreshed').getAttribute('datetime');
    let failRead!: (error: Error) => void, failSave!: (error: Error) => void;
    let latest!: (value: ArchiveBackupHealthStatus) => void;
    h.get.mockImplementationOnce(() => new Promise((_resolve, reject) => { failRead = reject; }));
    h.get.mockImplementationOnce(() => new Promise(resolve => { latest = resolve; }));
    h.save.mockImplementationOnce(() => new Promise((_resolve, reject) => { failSave = reject; }));
    const reading = h.mounted.refresh();
    input.value = '48'; input.fire('input'); h.node('save').click();
    input.value = '72'; input.fire('input'); input.focus();
    if (oldFirst) {
      failRead(new Error('private stale read')); await reading;
      expect(h.node('refresh-status').textContent).toContain('Waiting to refresh status after the save.');
    }
    failSave(new Error('private uncertain save'));
    await vi.waitFor(() => expect(h.node('feedback').textContent).toContain('could not be confirmed'));
    if (!oldFirst) { failRead(new Error('private stale read')); await reading; }
    expect(h.get).toHaveBeenCalledTimes(3);
    expect(h.node('refresh-status').textContent).toContain('Refreshing status…');
    expect(h.node('last-refreshed').getAttribute('datetime')).toBe(previous);
    h.now(1_700_000_004_000); latest(initial);
    await vi.waitFor(() => expect(h.node('last-refreshed').getAttribute('datetime')).toBe('2023-11-14T22:13:24.000Z'));
    expect(input.value).toBe('72'); expect(input.focused).toBe(true); expect(h.node('hours')).toBe(input);
    expect(h.node('refresh-status').textContent).not.toContain('failed');
    expect(h.save).toHaveBeenCalledTimes(1); expect(h.root.textContent).not.toContain('private');
  });

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
    const firstTime = h.node('last-refreshed').getAttribute('datetime');
    let currentReply!: (value: ArchiveBackupHealthStatus) => void;
    h.get.mockImplementationOnce(() => new Promise(resolve => { readReply = resolve; }));
    h.get.mockImplementationOnce(() => new Promise(resolve => { currentReply = resolve; }));
    h.save.mockImplementationOnce(() => new Promise(resolve => { saveReply = resolve; }));
    const reading = h.mounted.refresh(); h.node('hours').value = '48'; h.node('hours').fire('input'); h.node('save').click();
    h.node('hours').value = '72'; h.node('hours').fire('input');
    const saved = { ...initial, policy: { ...initial.policy, backup_max_age_hours: 48 } }; h.current(saved); saveReply(saved);
    await vi.waitFor(() => expect(h.node('feedback').textContent).toContain('newer edits'));
    h.now(1_700_000_001_000); readReply(initial); await reading;
    expect(h.node('last-refreshed').getAttribute('datetime')).toBe(firstTime);
    expect(h.node('refresh-status').textContent).toContain('Refreshing status…');
    expect(h.get).toHaveBeenCalledTimes(3);
    h.now(1_700_000_002_000); currentReply(saved);
    await vi.waitFor(() => expect(h.node('last-refreshed').getAttribute('datetime')).toBe('2023-11-14T22:13:22.000Z'));
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
