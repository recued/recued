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
  return { root, document, node, mounted, get, save, now: (value: number) => { now = value; }, current: (next: ArchiveBackupHealthStatus) => { current = next; } };
};

describe('backup health panel', () => {
  it('does not report newer edits when they return to the submitted policy', async () => {
    const h = await setup(); let saved!: (value: ArchiveBackupHealthStatus) => void;
    h.save.mockImplementationOnce(() => new Promise(resolve => { saved = resolve; }));
    const input = h.node('hours'); input.value = '48'; input.fire('input'); h.node('save').click();
    input.value = '72'; input.fire('input'); input.value = '48'; input.fire('input');
    const value = { ...initial, policy: { ...initial.policy, backup_max_age_hours: 48 } }; h.current(value); saved(value);
    await vi.waitFor(() => expect(h.node('feedback').textContent).toBe('Health limits saved.'));
    expect(h.node('draft-status').textContent).toBe('No unsaved health limit changes.'); expect(h.node('discard').disabled).toBe(true);
    expect(h.save).toHaveBeenCalledTimes(1); expect(input.value).toBe('48');
  });

  it('recognizes reverted controls as clean and adopts a later confirmed policy without saving', async () => {
    const h = await setup(), input = h.node('hours');
    h.node('enabled').checked = false; h.node('enabled').fire('change'); expect(h.node('discard').disabled).toBe(false);
    h.node('enabled').checked = true; h.node('enabled').fire('change'); input.value = '48'; input.fire('input'); input.value = '036'; input.fire('input');
    h.node('days').value = '14'; h.node('days').fire('input'); h.node('days').value = '30'; h.node('days').fire('input');
    expect(h.node('draft-status').textContent).toBe('No unsaved health limit changes.'); expect(h.node('discard').disabled).toBe(true);
    h.current({ ...initial, policy: { alerts_enabled: false, backup_max_age_hours: 96, recovery_max_age_days: 14 } }); await h.mounted.refresh();
    expect(input.value).toBe('96'); expect(h.node('enabled').checked).toBe(false); expect(h.node('days').value).toBe('14'); expect(h.save).not.toHaveBeenCalled();
  });

  it('discards to the latest confirmed limits, resets validation and focuses alerts without a request', async () => {
    const h = await setup(), input = h.node('hours'); input.value = ''; input.fire('input'); h.node('days').value = '366'; h.node('days').fire('input'); h.node('save').click();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    h.current({ ...initial, policy: { alerts_enabled: false, backup_max_age_hours: 96, recovery_max_age_days: 14 } }); await h.mounted.refresh();
    const reads = h.get.mock.calls.length; h.node('discard').click();
    expect(input.value).toBe('96'); expect(h.node('days').value).toBe('14'); expect(h.node('enabled').checked).toBe(false);
    expect(h.node('enabled').focused).toBe(true); expect(h.node('hours')).toBe(input); expect(h.node('discard').disabled).toBe(true);
    for (const name of ['hours', 'days']) { expect(h.node(name).getAttribute('aria-invalid')).toBeNull(); expect(h.node(`${name}-error`).textContent).toBe(''); }
    expect(h.get).toHaveBeenCalledTimes(reads); expect(h.save).not.toHaveBeenCalled();
  });

  it('moves focus off Discard when a fresh policy matches the draft', async () => {
    const h = await setup(); h.node('hours').value = '48'; h.node('hours').fire('input'); h.node('discard').focus();
    let active = h.node('discard'); Object.defineProperty(h.document, 'activeElement', { get: () => active });
    const focus = vi.spyOn(h.node('enabled'), 'focus').mockImplementation(() => { active = h.node('enabled'); });
    h.current({ ...initial, policy: { ...initial.policy, backup_max_age_hours: 48 } }); await h.mounted.refresh();
    expect(h.node('discard').disabled).toBe(true); expect(focus).toHaveBeenCalledOnce(); expect(h.node('draft-status').textContent).toBe('No unsaved health limit changes.');
  });

  for (const uncertain of [false, true]) it(`preserves edits returned to the old policy during a save, then discards only after it settles (uncertain: ${uncertain})`, async () => {
    const h = await setup(); let saved!: (value: ArchiveBackupHealthStatus) => void, fail!: (error: Error) => void, latest!: (value: ArchiveBackupHealthStatus) => void;
    h.save.mockImplementationOnce(() => new Promise((resolve, reject) => { saved = resolve; fail = reject; })); h.get.mockImplementationOnce(() => new Promise(resolve => { latest = resolve; }));
    h.node('hours').value = '48'; h.node('hours').fire('input'); h.node('save').click(); h.node('hours').value = '36'; h.node('hours').fire('input');
    expect(h.node('discard').disabled).toBe(true); h.node('discard').click(); expect(h.node('hours').value).toBe('36');
    const value = { ...initial, policy: { ...initial.policy, backup_max_age_hours: 48 } }; if (uncertain) fail(new Error('lost reply')); else saved(value);
    await vi.waitFor(() => expect(h.get).toHaveBeenCalledTimes(2)); latest(value); await vi.waitFor(() => expect(h.node('save').disabled).toBe(false));
    expect(h.node('hours').value).toBe('36'); expect(h.node('discard').disabled).toBe(false); h.node('discard').click();
    expect(h.node('hours').value).toBe('48'); expect(h.node('feedback').textContent).toBe(uncertain ? 'Health limits could not be confirmed. Refresh before trying again.' : '');
    expect(h.save).toHaveBeenCalledTimes(1); expect(h.get).toHaveBeenCalledTimes(2);
  });

  it('allows local discard while reconciliation is pending without clearing its warning or enabling retry', async () => {
    const h = await setup(); let latest!: (value: ArchiveBackupHealthStatus) => void;
    h.save.mockRejectedValueOnce(new Error('lost reply')); h.get.mockImplementationOnce(() => new Promise(resolve => { latest = resolve; }));
    h.node('hours').value = '48'; h.node('hours').fire('input'); h.node('save').click(); await vi.waitFor(() => expect(h.get).toHaveBeenCalledTimes(2));
    const warning = h.node('feedback').textContent, beforeTime = h.node('last-refreshed').getAttribute('datetime'); h.node('discard').click();
    expect(h.node('hours').value).toBe('36'); expect(h.node('save').disabled).toBe(true); expect(h.node('feedback').textContent).toBe(warning);
    expect(h.node('last-refreshed').getAttribute('datetime')).toBe(beforeTime); expect(h.get).toHaveBeenCalledTimes(2);
    latest({ ...initial, policy: { ...initial.policy, backup_max_age_hours: 48 } }); await vi.waitFor(() => expect(h.node('save').disabled).toBe(false));
    expect(h.node('hours').value).toBe('48'); h.node('hours').value = ''; h.node('hours').fire('input'); h.node('save').click();
    expect(h.node('feedback').textContent).toBe(warning); h.node('discard').click();
    expect(h.node('hours').value).toBe('48'); expect(h.node('feedback').textContent).toBe(warning); expect(h.save).toHaveBeenCalledTimes(1); expect(h.get).toHaveBeenCalledTimes(2);
  });

  it.each(['error', 'unavailable'] as const)('keeps the last usable policy for Discard after a %s read', async outcome => {
    const h = await setup(); h.node('hours').value = '48'; h.node('hours').fire('input');
    if (outcome === 'error') h.get.mockRejectedValueOnce(new Error('private read'));
    else h.current({ ...initial, monitoring: 'unavailable', policy: { ...initial.policy, backup_max_age_hours: 96 } });
    await h.mounted.refresh(); const reads = h.get.mock.calls.length, feedback = h.node('refresh-status').textContent; h.node('discard').click();
    expect(h.node('hours').value).toBe('36'); expect(h.node('save').disabled).toBe(true); expect(h.node('refresh-status').textContent).toBe(feedback);
    expect(h.get).toHaveBeenCalledTimes(reads); expect(h.save).not.toHaveBeenCalled();
  });

  it('can discard an early edit before the first confirmed policy without inventing defaults', async () => {
    const { root, document } = pickerTestDom(); let latest!: (value: ArchiveBackupHealthStatus) => void;
    const get = vi.fn<BackupHealthPorts['get']>(() => new Promise(resolve => { latest = resolve; })), save = vi.fn();
    const mounted = mountBackupHealth({ host: root as unknown as HTMLElement, document, ports: { get, save } }); disposals.push(() => mounted.dispose());
    const input = root.querySelector('[data-backup-health-hours]')!, original = input.value; input.value = '48'; input.fire('input'); root.querySelector('[data-backup-health-discard]')!.click();
    expect(input.value).toBe(original); expect(save).not.toHaveBeenCalled(); expect(get).toHaveBeenCalledTimes(1); latest(initial);
    await vi.waitFor(() => expect(input.value).toBe('36')); expect(root.querySelector('[data-backup-health-discard]')!.disabled).toBe(true);
  });

  it.each(['error', 'sync-error', 'mismatch', 'malformed', 'unavailable'] as const)('blocks repeated saves until a fresh status reconciles a %s save reply', async outcome => {
    const h = await setup(); let latest!: (value: ArchiveBackupHealthStatus) => void;
    h.get.mockImplementationOnce(() => new Promise(resolve => { latest = resolve; }));
    h.save.mockImplementationOnce(input => {
      if (outcome === 'sync-error') throw new Error('private synchronous failure');
      if (outcome === 'error') return Promise.reject(new Error('private lost reply'));
      return Promise.resolve<ArchiveBackupHealthStatus>(outcome === 'mismatch' ? initial : { ...initial, policy: input.policy,
        monitoring: outcome === 'unavailable' ? 'unavailable' : 'unknown' as ArchiveBackupHealthStatus['monitoring'], issue: outcome === 'unavailable' ? 'settings_unavailable' : undefined });
    });
    const input = h.node('hours'); input.value = '48'; input.fire('input'); h.node('save').click();
    await vi.waitFor(() => expect(h.node('feedback').textContent).toContain('could not be confirmed'));
    expect(h.node('save').disabled).toBe(true); expect(h.get).toHaveBeenCalledTimes(2);
    input.value = '72'; input.fire('input'); input.focus(); h.node('save').click(); h.node('save').click();
    expect(h.save).toHaveBeenCalledTimes(1); const warning = h.node('feedback').textContent;
    latest({ ...initial, policy: { ...initial.policy, backup_max_age_hours: 48 } });
    await vi.waitFor(() => expect(h.node('save').disabled).toBe(false));
    expect(h.node('feedback').textContent).toBe(warning); expect(input.value).toBe('72'); expect(input.focused).toBe(true);
    h.node('save').click(); expect(h.save).toHaveBeenCalledTimes(2);
    expect(h.save).toHaveBeenLastCalledWith({ policy: { ...initial.policy, backup_max_age_hours: 72 } });
  });

  it.each(['malformed', 'unavailable'] as const)('preserves the submitted draft after a matching but %s save reply and a fresh read', async outcome => {
    const h = await setup(), input = h.node('hours'); let latest!: (value: ArchiveBackupHealthStatus) => void;
    h.get.mockImplementationOnce(() => new Promise(resolve => { latest = resolve; }));
    h.save.mockImplementationOnce(async ({ policy }) => ({ ...initial, policy,
      monitoring: outcome === 'unavailable' ? 'unavailable' : 'unknown' as ArchiveBackupHealthStatus['monitoring'], issue: outcome === 'unavailable' ? 'settings_unavailable' : undefined }));
    input.value = '48'; input.fire('input'); input.focus(); h.node('save').click();
    await vi.waitFor(() => expect(h.node('feedback').textContent).toContain('could not be confirmed')); latest(initial);
    await vi.waitFor(() => expect(h.node('save').disabled).toBe(false));
    expect(input.value).toBe('48'); expect(input.focused).toBe(true); expect(h.node('feedback').textContent).toContain('could not be confirmed');
    expect(h.save).toHaveBeenCalledTimes(1);
  });

  it.each(['error', 'unavailable', 'malformed', 'invalid-policy'] as const)('keeps an uncertain save blocked through a %s read and retains drafts and warnings during recovery', async outcome => {
    const h = await setup(), input = h.node('hours'); const first = h.node('last-refreshed').getAttribute('datetime');
    let latest!: (value: ArchiveBackupHealthStatus) => void, fail!: (error: Error) => void;
    h.get.mockImplementationOnce(() => new Promise((resolve, reject) => { latest = resolve; fail = reject; }));
    h.save.mockRejectedValueOnce(new Error('private lost reply')); input.value = '48'; input.fire('input'); h.node('save').click();
    await vi.waitFor(() => expect(h.get).toHaveBeenCalledTimes(2)); const warning = h.node('feedback').textContent;
    input.value = '72'; input.fire('input'); input.focus(); h.now(1_700_000_001_000);
    if (outcome === 'error') fail(new Error('private read failure'));
    else latest({ ...initial, monitoring: outcome === 'unavailable' ? 'unavailable' : outcome === 'malformed' ? 'unknown' as ArchiveBackupHealthStatus['monitoring'] : 'active',
      policy: { ...initial.policy, backup_max_age_hours: outcome === 'invalid-policy' ? 0 : 48 } });
    await vi.waitFor(() => expect(h.node('refresh-status').textContent).toContain('Latest status refresh failed.'));
    expect(h.node('save').disabled).toBe(true); expect(h.node('feedback').textContent).toBe(warning);
    expect(h.node('last-refreshed').getAttribute('datetime')).toBe(first); h.node('save').click(); expect(h.save).toHaveBeenCalledTimes(1);
    h.current({ ...initial, policy: { ...initial.policy, backup_max_age_hours: 48 } }); h.now(1_700_000_002_000); await h.mounted.refresh();
    expect(h.node('save').disabled).toBe(false); expect(h.node('feedback').textContent).toBe(warning);
    expect(h.node('last-refreshed').getAttribute('datetime')).toBe('2023-11-14T22:13:22.000Z');
    expect(h.node('hours')).toBe(input); expect(input.value).toBe('72'); expect(input.focused).toBe(true); expect(h.root.textContent).not.toContain('private');
  });

  it('does not enable retry or repaint after a reconciliation read arrives following disposal', async () => {
    const h = await setup(); let latest!: (value: ArchiveBackupHealthStatus) => void;
    h.get.mockImplementationOnce(() => new Promise(resolve => { latest = resolve; })); h.save.mockRejectedValueOnce(new Error('lost reply'));
    h.node('save').click(); await vi.waitFor(() => expect(h.get).toHaveBeenCalledTimes(2));
    h.mounted.dispose(); const before = h.root.textContent; latest(initial); await Promise.resolve(); await Promise.resolve();
    expect(h.node('save').disabled).toBe(true); expect(h.root.textContent).toBe(before); expect(h.save).toHaveBeenCalledTimes(1);
  });

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

  for (const readFails of [true, false]) it.each([true, false])(`recovers from an uncertain save and an older read (read fails: ${readFails}, old first: %s)`, async oldFirst => {
    const h = await setup(), input = h.node('hours');
    const previous = h.node('last-refreshed').getAttribute('datetime');
    let oldReply!: (value: ArchiveBackupHealthStatus) => void, failRead!: (error: Error) => void, failSave!: (error: Error) => void;
    let latest!: (value: ArchiveBackupHealthStatus) => void;
    h.get.mockImplementationOnce(() => new Promise((resolve, reject) => { oldReply = resolve; failRead = reject; }));
    h.get.mockImplementationOnce(() => new Promise(resolve => { latest = resolve; }));
    h.save.mockImplementationOnce(() => new Promise((_resolve, reject) => { failSave = reject; }));
    const reading = h.mounted.refresh();
    input.value = '48'; input.fire('input'); h.node('save').click();
    input.value = '72'; input.fire('input'); input.focus();
    const settleOld = () => readFails ? failRead(new Error('private stale read')) : oldReply(initial);
    if (oldFirst) {
      settleOld(); await reading;
      expect(h.node('refresh-status').textContent).toContain('Waiting to refresh status after the save.');
    }
    failSave(new Error('private uncertain save'));
    await vi.waitFor(() => expect(h.node('feedback').textContent).toContain('could not be confirmed'));
    expect(h.node('save').disabled).toBe(true); h.node('save').click(); expect(h.save).toHaveBeenCalledTimes(1);
    if (!oldFirst) { settleOld(); await reading; }
    expect(h.get).toHaveBeenCalledTimes(3);
    expect(h.node('save').disabled).toBe(true); h.node('save').click(); expect(h.save).toHaveBeenCalledTimes(1);
    expect(h.node('refresh-status').textContent).toContain('Refreshing status…');
    expect(h.node('last-refreshed').getAttribute('datetime')).toBe(previous);
    h.now(1_700_000_004_000); latest(initial);
    await vi.waitFor(() => expect(h.node('last-refreshed').getAttribute('datetime')).toBe('2023-11-14T22:13:24.000Z'));
    expect(input.value).toBe('72'); expect(input.focused).toBe(true); expect(h.node('hours')).toBe(input);
    expect(h.node('refresh-status').textContent).not.toContain('failed');
    expect(h.node('save').disabled).toBe(false); expect(h.node('feedback').textContent).toContain('could not be confirmed');
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
