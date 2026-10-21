import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ArchiveUnattendedStatus, ArchiveUnattendedSettings, ArchiveRemoteDestination } from '@recued/contracts';
import { mountUnattendedBackups, type UnattendedBackupsPorts } from '../settings/unattended-backups-panel.js';
import { pickerTestDom } from './helpers/file-download-picker-dom.js';
const destination: ArchiveRemoteDestination = { connection_name: 'safe', destination_id: 'a'.repeat(64), bucket: 'backup-bucket', region: 'us-east-1', endpoint: 'https://s3.example.test', prefix: '' };
const settings: ArchiveUnattendedSettings = { enabled: true, connection_name: 'safe', destination_id: destination.destination_id, keep_last: 5,
  schedule: { cadence: 'daily', hour_utc: 2, minute_utc: 0, weekday_utc: 0 } };
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); vi.useRealTimers(); });
const setup = async (initial: ArchiveUnattendedStatus = { configured: false }) => {
  const { root, document } = pickerTestDom();
  let current = initial;
  const get = vi.fn(async () => current), save = vi.fn<UnattendedBackupsPorts['save']>(async input => { current = { configured: true, settings: input.settings }; return current; });
  const mounted = mountUnattendedBackups({ host: root as unknown as HTMLElement, document, ports: { get, save } });
  disposals.push(() => mounted.dispose()); mounted.destinations([destination]);
  const node = (name: string) => { const control = root.querySelector(`[data-unattended-${name}]`); if (!control) throw new Error(name); return control; };
  await vi.waitFor(() => expect(node('save').disabled).toBe(false));
  return { root, node, mounted, save, get, current: (value: ArchiveUnattendedStatus) => { current = value; } };
};
describe('unattended backup setup', () => {
  it('requires an explicit new selection after a saved destination changes, while still allowing pause', async () => {
    const h = await setup({ configured: true, settings });
    h.mounted.destinations([{ ...destination, bucket: 'changed-bucket', destination_id: 'b'.repeat(64) }]);
    await h.mounted.refresh(); h.node('save').click();
    expect(h.save).not.toHaveBeenCalled();
    h.node('enabled').checked = false; h.node('save').click();
    expect(h.save).toHaveBeenCalledWith({ settings: { ...settings, enabled: false } });
    await vi.waitFor(() => expect(h.node('save').disabled).toBe(false));
    h.node('enabled').checked = true; h.node('destination').value = 'safe'; h.node('destination').fire('change');
    h.node('save').click();
    expect(h.save).toHaveBeenLastCalledWith({ settings: { ...settings, destination_id: 'b'.repeat(64) } });
  });
  it('clears words before dispatch, saves a UTC schedule, and updates it later without words', async () => {
    const h = await setup(); h.node('destination').value = 'safe'; h.node('destination').fire('change'); h.node('words').value = 'synthetic setup words';
    h.node('save').click(); expect(h.node('words').value).toBe('');
    expect(h.save).toHaveBeenCalledWith({ settings, recoveryKey: 'synthetic setup words' });
    await vi.waitFor(() => expect(h.node('save').disabled).toBe(false));
    h.node('enabled').checked = false; h.node('save').click();
    expect(h.save).toHaveBeenLastCalledWith({ settings: { ...settings, enabled: false } });
  });
  it('preserves edits during polling, shows failure and alert status, and clears words on disposal', async () => {
    vi.useFakeTimers(); const h = await setup({ configured: true, settings });
    h.node('time').value = '06:45'; h.node('time').fire('input'); h.node('words').value = 'unsubmitted words';
    h.current({ configured: true, settings, alert_pending: true, last_run: { operation_id: 'fixture', started_at: 1, outcome: 'failed', issue: 'vault_unavailable' } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.node('time').value).toBe('06:45'); expect(h.node('words').value).toBe('unsubmitted words');
    expect(h.node('status').textContent).toContain('vault is locked'); expect(h.node('status').textContent).toContain('alert awaiting');
    h.mounted.dispose(); expect(h.node('words').value).toBe('');
  });
  it('leaves words cleared after a rejected save and ignores a late response after disposal', async () => {
    const h = await setup(); h.node('destination').value = 'safe'; h.node('destination').fire('change'); h.node('words').value = 'synthetic setup words';
    h.save.mockRejectedValueOnce(new Error('offline')); h.node('save').click();
    await vi.waitFor(() => expect(h.node('feedback').textContent).toContain('could not be saved'));
    expect(h.node('words').value).toBe('');
    let settle = (_: ArchiveUnattendedStatus) => {};
    h.save.mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
    h.node('words').value = 'synthetic setup words'; h.node('save').click(); h.mounted.dispose();
    settle({ configured: true, settings }); await Promise.resolve(); await Promise.resolve();
    expect(h.node('feedback').textContent).toBe('Saving the backup schedule…');
  });
  it('does not let an older status response overwrite a newly saved schedule', async () => {
    const h = await setup({ configured: true, settings }); let settle = (_: ArchiveUnattendedStatus) => {};
    h.get.mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
    const refreshing = h.mounted.refresh(); h.node('time').value = '06:45'; h.node('time').fire('input'); h.node('save').click();
    await vi.waitFor(() => expect(h.node('feedback').textContent).toContain('schedule saved'));
    settle({ configured: true, settings }); await refreshing;
    expect(h.node('time').value).toBe('06:45');
  });
  it('can pause a schedule after its storage connection becomes unavailable', async () => {
    const h = await setup({ configured: true, settings }); h.mounted.destinations([]);
    h.node('enabled').checked = false; h.node('save').click();
    expect(h.save).toHaveBeenCalledWith({ settings: { ...settings, enabled: false } });
  });
  it('preserves newer edits made while an earlier schedule save is pending', async () => {
    const h = await setup({ configured: true, settings }); let settle = (_: ArchiveUnattendedStatus) => {};
    h.save.mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
    h.node('time').value = '03:30'; h.node('time').fire('input'); h.node('save').click();
    h.node('time').value = '07:15'; h.node('time').fire('input');
    const saved = { configured: true, settings: { ...settings, schedule: { ...settings.schedule, hour_utc: 3, minute_utc: 30 } } };
    h.current(saved); settle(saved);
    await vi.waitFor(() => expect(h.node('save').disabled).toBe(false));
    expect(h.node('time').value).toBe('07:15');
    expect(h.node('feedback').textContent).toContain('newer edits');
    h.node('save').click();
    expect(h.save).toHaveBeenLastCalledWith({ settings: { ...settings, schedule: { ...settings.schedule, hour_utc: 7, minute_utc: 15 } } });
  });
});
