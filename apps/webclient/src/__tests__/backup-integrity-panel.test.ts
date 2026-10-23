import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ArchiveBackupIntegrityStatus } from '@recued/contracts';
import { mountBackupIntegrity, type BackupIntegrityPorts } from '../settings/backup-integrity-panel.js';
import { mountRemoteBackups } from '../settings/remote-backups-panel.js';
import { pickerTestDom } from './helpers/file-download-picker-dom.js';

const initial: ArchiveBackupIntegrityStatus = { monitoring: 'active', destination: { connection_name: 'safe', destination_id: 'a'.repeat(64) }, next_run_at: 100,
  policy: { enabled: true, schedule: { cadence: 'weekly', hour_utc: 3, minute_utc: 0, weekday_utc: 0 } } };
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });
const setup = async () => {
  const { root, document } = pickerTestDom(); let current = structuredClone(initial);
  let now = 1_700_000_000_000;
  const get = vi.fn<BackupIntegrityPorts['get']>(async () => current);
  const save = vi.fn<BackupIntegrityPorts['save']>(async input => { current = { ...current, policy: input.policy }; return current; });
  const mounted = mountBackupIntegrity({ host: root as unknown as HTMLElement, document, ports: { get, save }, now: () => now }); disposals.push(() => mounted.dispose());
  const node = (name: string) => { const n = root.querySelector(`[data-backup-integrity-${name}]`); if (!n) throw new Error(name); return n; };
  await vi.waitFor(() => expect(node('save').disabled).toBe(false));
  return { root, node, mounted, get, save, now: (value: number) => { now = value; }, current: (next: ArchiveBackupIntegrityStatus) => { current = next; } };
};
describe('scheduled S3 check settings', () => {
  it.each([['cadence', '', 'Choose daily or weekly S3 checks.'], ['time', '', 'Enter a UTC time, such as 02:00.'], ['day', '', 'Choose a weekday for S3 checks.']] as const)(
    'focuses invalid %s without dispatch and clears its error when corrected', async (name, value, message) => {
      const h = await setup(), input = h.node(name), focus = vi.spyOn(input, 'focus');
      const previous = input.value; input.value = value; input.fire('input'); h.node('save').click();
      expect(h.save).not.toHaveBeenCalled(); expect(focus).toHaveBeenCalledTimes(1);
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(input.getAttribute('aria-describedby')).toBe(h.node(`${name}-error`).id);
      expect(h.node(`${name}-error`).textContent).toBe(message);
      await h.mounted.refresh(); expect(h.node(name)).toBe(input); expect(input.value).toBe(value);
      expect(focus).toHaveBeenCalledTimes(1);
      input.value = previous; input.fire('change');
      expect(input.getAttribute('aria-invalid')).toBeNull(); expect(input.getAttribute('aria-describedby')).toBeNull();
      expect(h.node(`${name}-error`).textContent).toBe('');
      h.node('save').click(); expect(h.save).toHaveBeenCalledTimes(1);
    });

  it('retains successful freshness on failures and preserves a focused draft through recovery', async () => {
    const h = await setup(); const first = h.node('last-refreshed').getAttribute('datetime');
    expect(first).toBe('2023-11-14T22:13:20.000Z');
    const input = h.node('time'); input.value = '17:45'; input.fire('input'); input.focus();
    let finish!: (value: ArchiveBackupIntegrityStatus) => void;
    h.get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    h.now(1_700_000_001_000); const reading = h.mounted.refresh();
    expect(h.node('refresh-status').textContent).toContain('Refreshing status…');
    expect(h.node('last-refreshed').getAttribute('datetime')).toBe(first);
    h.now(1_700_000_002_000); finish(initial); await reading;
    const accepted = h.node('last-refreshed').getAttribute('datetime');
    expect(accepted).toBe('2023-11-14T22:13:22.000Z');
    h.now(1_700_000_003_000); h.get.mockRejectedValueOnce(new Error('private provider body')); await h.mounted.refresh();
    expect(h.node('last-refreshed').getAttribute('datetime')).toBe(accepted);
    expect(h.node('refresh-status').textContent).toContain('Latest status refresh failed.');
    h.current({ ...initial, monitoring: 'unavailable', issue: 'settings_unavailable' }); await h.mounted.refresh();
    expect(h.node('last-refreshed').getAttribute('datetime')).toBe(accepted);
    expect(h.node('refresh-status').textContent).toContain('Latest status refresh failed.');
    h.current({ ...initial, monitoring: 'paused' }); await h.mounted.refresh();
    expect(h.node('last-refreshed').getAttribute('datetime')).toBe('2023-11-14T22:13:23.000Z');
    expect(input.value).toBe('17:45'); expect(input.focused).toBe(true); expect(h.node('time')).toBe(input);
    expect(h.root.textContent).not.toContain('private provider'); expect(h.save).not.toHaveBeenCalled();
  });

  it.each(['success', 'failure'] as const)('does not stamp an initial failure or a disposed %s reply', async outcome => {
    const { root, document } = pickerTestDom();
    const get = vi.fn<BackupIntegrityPorts['get']>().mockRejectedValueOnce(new Error('Initial unavailable'));
    const mounted = mountBackupIntegrity({ host: root as unknown as HTMLElement, document, ports: { get, save: vi.fn() } });
    disposals.push(() => mounted.dispose()); await vi.waitFor(() => expect(root.textContent).toContain('Latest status refresh failed.'));
    expect(root.querySelector('[data-backup-integrity-last-refreshed]')).toBeNull();
    let resolve!: (value: ArchiveBackupIntegrityStatus) => void, reject!: (error: Error) => void;
    get.mockImplementationOnce(() => new Promise((done, fail) => { resolve = done; reject = fail; }));
    const reading = mounted.refresh(); mounted.dispose(); const before = root.textContent;
    if (outcome === 'success') resolve(initial); else reject(new Error('Late private failure'));
    await reading; expect(root.textContent).toBe(before);
    expect(root.querySelector('[data-backup-integrity-last-refreshed]')).toBeNull();
  });

  it.each([true, false])('recovers from an uncertain save and an older failed read (old first: %s)', async oldFirst => {
    const h = await setup(), input = h.node('time');
    const previous = h.node('last-refreshed').getAttribute('datetime');
    let failRead!: (error: Error) => void, failSave!: (error: Error) => void;
    let latest!: (value: ArchiveBackupIntegrityStatus) => void;
    h.get.mockImplementationOnce(() => new Promise((_resolve, reject) => { failRead = reject; }));
    h.get.mockImplementationOnce(() => new Promise(resolve => { latest = resolve; }));
    h.save.mockImplementationOnce(() => new Promise((_resolve, reject) => { failSave = reject; }));
    const reading = h.mounted.refresh();
    input.value = '05:00'; input.fire('input'); h.node('save').click();
    input.value = '07:00'; input.fire('input'); input.focus();
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
    expect(input.value).toBe('07:00'); expect(input.focused).toBe(true); expect(h.node('time')).toBe(input);
    expect(h.node('refresh-status').textContent).not.toContain('failed');
    expect(h.save).toHaveBeenCalledTimes(1); expect(h.root.textContent).not.toContain('private');
  });

  it('explains full reads and coverage, submits only an explicit UTC policy, and validates before dispatch', async () => {
    const h = await setup(); expect(h.root.textContent).toContain('downloads the full copy'); expect(h.root.textContent).toContain('No recovery words are needed');
    for (const time of ['', '24:00', '12:60']) { h.node('time').value = time; h.node('save').click(); }
    expect(h.save).not.toHaveBeenCalled();
    h.node('cadence').value = 'daily'; h.node('time').value = '05:30'; h.node('day').value = '2'; h.node('enabled').checked = false; h.node('save').click();
    expect(h.save).toHaveBeenCalledExactlyOnceWith({ policy: { enabled: false, schedule: { cadence: 'daily', hour_utc: 5, minute_utc: 30, weekday_utc: 2 } } });
    await vi.waitFor(() => expect(h.node('feedback').textContent).toContain('schedule saved'));
    h.current({ ...initial, alert_pending: true, last_run: { operation_id: 'scan-id', destination_id: 'a'.repeat(64), started_at: 1, finished_at: 2,
      outcome: 'completed', total: 3, checked: 2, skipped: 1, failed: 0 } }); await h.mounted.refresh();
    expect(h.node('run').textContent).toContain('2 of 3 copies checked'); expect(h.node('run').textContent).toContain('1 busy or removed copies skipped');
    expect(h.node('alerts').textContent).toContain('awaiting notification delivery');
  });

  it('preserves input nodes, focus and drafts when refreshing scan results', async () => {
    const h = await setup(), input = h.node('time'); input.value = '17:45'; input.fire('input'); input.focus();
    h.current({ ...initial, monitoring: 'paused' }); await h.mounted.refresh();
    expect(h.node('time')).toBe(input); expect(input.value).toBe('17:45'); expect(input.focused).toBe(true);
    expect(h.node('status').textContent).toContain('paused');
  });

  it('fences polls before saves and keeps newer edits made while the save is in flight', async () => {
    const h = await setup(); let readReply = (_: ArchiveBackupIntegrityStatus) => {}, saveReply = (_: ArchiveBackupIntegrityStatus) => {};
    const firstTime = h.node('last-refreshed').getAttribute('datetime');
    let currentReply!: (value: ArchiveBackupIntegrityStatus) => void;
    h.get.mockImplementationOnce(() => new Promise(resolve => { readReply = resolve; }));
    h.get.mockImplementationOnce(() => new Promise(resolve => { currentReply = resolve; }));
    h.save.mockImplementationOnce(() => new Promise(resolve => { saveReply = resolve; }));
    const reading = h.mounted.refresh(); h.node('time').value = '05:00'; h.node('time').fire('input'); h.node('save').click();
    h.node('time').value = '07:00'; h.node('time').fire('input');
    const saved = { ...initial, policy: { ...initial.policy, schedule: { ...initial.policy.schedule, hour_utc: 5 } } }; h.current(saved); saveReply(saved);
    await vi.waitFor(() => expect(h.node('feedback').textContent).toContain('newer edits'));
    h.now(1_700_000_001_000); readReply(initial); await reading;
    expect(h.node('last-refreshed').getAttribute('datetime')).toBe(firstTime);
    expect(h.node('refresh-status').textContent).toContain('Refreshing status…');
    expect(h.get).toHaveBeenCalledTimes(3);
    h.now(1_700_000_002_000); currentReply(saved);
    await vi.waitFor(() => expect(h.node('last-refreshed').getAttribute('datetime')).toBe('2023-11-14T22:13:22.000Z'));
    expect(h.node('time').value).toBe('07:00');
    h.node('save').click(); expect(h.save).toHaveBeenLastCalledWith({ policy: { ...initial.policy, schedule: { ...initial.policy.schedule, hour_utc: 7 } } });
  });

  it('clears stale scan claims and blocks saves on unavailable state without replacing saved controls', async () => {
    const h = await setup();
    h.current({ ...initial, monitoring: 'unavailable', issue: 'settings_unavailable', policy: { ...initial.policy, enabled: false } }); await h.mounted.refresh();
    expect(h.node('save').disabled).toBe(true); expect(h.node('enabled').checked).toBe(true); expect(h.node('run').textContent).toBe('');
    h.current(initial); await h.mounted.refresh();
    h.get.mockRejectedValueOnce(new Error('private provider body')); await h.mounted.refresh();
    expect(h.node('save').disabled).toBe(true); expect(h.root.textContent).not.toContain('private provider');
    h.node('save').click(); expect(h.save).not.toHaveBeenCalled();
  });

  it('never resends uncertain writes or echoes errors and ignores late replies after disposal', async () => {
    const h = await setup(); h.save.mockRejectedValueOnce(new Error('private server path')); h.node('save').click();
    await vi.waitFor(() => expect(h.node('feedback').textContent).toContain('could not be confirmed'));
    await h.mounted.refresh(); expect(h.save).toHaveBeenCalledTimes(1); expect(h.root.textContent).not.toContain('private server');
    let reply = (_: ArchiveBackupIntegrityStatus) => {}; h.save.mockImplementationOnce(() => new Promise(resolve => { reply = resolve; }));
    h.node('save').click(); h.mounted.dispose(); const before = h.root.textContent; reply(initial); await Promise.resolve(); await Promise.resolve();
    expect(h.root.textContent).toBe(before); expect(h.node('save').disabled).toBe(true);
  });

  it('refreshes independently of a failed remote history read and leaves adjacent words untouched', async () => {
    const { root, document } = pickerTestDom(); let reconnect = () => {};
    const get = vi.fn(async () => initial);
    const mounted = mountRemoteBackups({ host: root as unknown as HTMLElement, document, onRestore: () => true, ports: {
      list: async () => { throw new Error('private history'); }, destinations: async () => ({ destinations: [] }), check: vi.fn(), retrieve: vi.fn(),
      integrity: { get, save: async input => ({ ...initial, policy: input.policy }) },
      unattended: { get: async () => ({ configured: false }), save: vi.fn() },
      onConnected: listener => { reconnect = listener; return () => {}; },
    } }); disposals.push(() => mounted.dispose());
    await vi.waitFor(() => expect(root.querySelector('[data-backup-integrity-save]')?.disabled).toBe(false));
    const words = root.querySelector('[data-unattended-words]')!; words.value = 'unsubmitted secret draft'; const calls = get.mock.calls.length;
    reconnect(); await vi.waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(calls));
    expect(words.value).toBe('unsubmitted secret draft'); expect(root.textContent).not.toContain('private history');
  });
});
