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
  return { root, document, node, mounted, get, save, now: (value: number) => { now = value; }, current: (next: ArchiveBackupIntegrityStatus) => { current = next; } };
};
describe('scheduled S3 check settings', () => {
  it('does not report newer edits when they return to the submitted policy', async () => {
    const h = await setup(); let saved!: (value: ArchiveBackupIntegrityStatus) => void;
    h.save.mockImplementationOnce(() => new Promise(resolve => { saved = resolve; }));
    const input = h.node('time'); input.value = '05:00'; input.fire('input'); h.node('save').click();
    input.value = '07:00'; input.fire('input'); input.value = '05:00'; input.fire('input');
    const value = { ...initial, policy: { ...initial.policy, schedule: { ...initial.policy.schedule, hour_utc: 5 } } }; h.current(value); saved(value);
    await vi.waitFor(() => expect(h.node('feedback').textContent).toBe('S3 check schedule saved.'));
    expect(h.node('draft-status').textContent).toBe('No unsaved S3 check changes.'); expect(h.node('discard').disabled).toBe(true);
    expect(h.save).toHaveBeenCalledTimes(1); expect(input.value).toBe('05:00');
  });

  it('recognizes reverted controls as clean and adopts a later confirmed policy without saving', async () => {
    const h = await setup(), input = h.node('time');
    for (const [name, edited, original] of [['time', '05:00', '03:00'], ['cadence', 'daily', 'weekly'], ['day', '2', '0']]) {
      h.node(name!).value = edited!; h.node(name!).fire('input'); expect(h.node('discard').disabled).toBe(false); h.node(name!).value = original!; h.node(name!).fire('change');
    }
    h.node('enabled').checked = false; h.node('enabled').fire('change'); h.node('enabled').checked = true; h.node('enabled').fire('change');
    expect(h.node('draft-status').textContent).toBe('No unsaved S3 check changes.'); expect(h.node('discard').disabled).toBe(true);
    h.current({ ...initial, policy: { enabled: false, schedule: { cadence: 'daily', hour_utc: 4, minute_utc: 30, weekday_utc: 2 } } }); await h.mounted.refresh();
    expect(input.value).toBe('04:30'); expect(h.node('enabled').checked).toBe(false); expect(h.node('cadence').value).toBe('daily'); expect(h.node('day').value).toBe('2'); expect(h.save).not.toHaveBeenCalled();
  });

  it('discards to the latest confirmed schedule, resets validation and focuses enabled without a request', async () => {
    const h = await setup(), input = h.node('time'); input.value = ''; input.fire('input'); h.node('day').value = ''; h.node('day').fire('input'); h.node('save').click();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    h.current({ ...initial, policy: { enabled: false, schedule: { cadence: 'daily', hour_utc: 4, minute_utc: 30, weekday_utc: 2 } } }); await h.mounted.refresh();
    const reads = h.get.mock.calls.length; h.node('discard').click();
    expect(input.value).toBe('04:30'); expect(h.node('day').value).toBe('2'); expect(h.node('cadence').value).toBe('daily'); expect(h.node('enabled').checked).toBe(false);
    expect(h.node('enabled').focused).toBe(true); expect(h.node('time')).toBe(input); expect(h.node('discard').disabled).toBe(true);
    for (const name of ['time', 'day']) { expect(h.node(name).getAttribute('aria-invalid')).toBeNull(); expect(h.node(`${name}-error`).textContent).toBe(''); }
    expect(h.get).toHaveBeenCalledTimes(reads); expect(h.save).not.toHaveBeenCalled();
  });

  it('moves focus off Discard when a fresh policy matches the draft', async () => {
    const h = await setup(); h.node('time').value = '05:00'; h.node('time').fire('input'); h.node('discard').focus();
    let active = h.node('discard'); Object.defineProperty(h.document, 'activeElement', { get: () => active });
    const focus = vi.spyOn(h.node('enabled'), 'focus').mockImplementation(() => { active = h.node('enabled'); });
    h.current({ ...initial, policy: { ...initial.policy, schedule: { ...initial.policy.schedule, hour_utc: 5 } } }); await h.mounted.refresh();
    expect(h.node('discard').disabled).toBe(true); expect(focus).toHaveBeenCalledOnce(); expect(h.node('draft-status').textContent).toBe('No unsaved S3 check changes.');
  });

  for (const uncertain of [false, true]) it(`preserves edits returned to the old policy during a save, then discards only after it settles (uncertain: ${uncertain})`, async () => {
    const h = await setup(); let saved!: (value: ArchiveBackupIntegrityStatus) => void, fail!: (error: Error) => void, latest!: (value: ArchiveBackupIntegrityStatus) => void;
    h.save.mockImplementationOnce(() => new Promise((resolve, reject) => { saved = resolve; fail = reject; })); h.get.mockImplementationOnce(() => new Promise(resolve => { latest = resolve; }));
    h.node('time').value = '05:00'; h.node('time').fire('input'); h.node('save').click(); h.node('time').value = '03:00'; h.node('time').fire('input');
    expect(h.node('discard').disabled).toBe(true); h.node('discard').click(); expect(h.node('time').value).toBe('03:00');
    const value = { ...initial, policy: { ...initial.policy, schedule: { ...initial.policy.schedule, hour_utc: 5 } } }; if (uncertain) fail(new Error('lost reply')); else saved(value);
    await vi.waitFor(() => expect(h.get).toHaveBeenCalledTimes(2)); latest(value); await vi.waitFor(() => expect(h.node('save').disabled).toBe(false));
    expect(h.node('time').value).toBe('03:00'); expect(h.node('discard').disabled).toBe(false); h.node('discard').click();
    expect(h.node('time').value).toBe('05:00'); expect(h.node('feedback').textContent).toBe(uncertain ? 'The S3 check schedule could not be confirmed. Refresh before trying again.' : '');
    expect(h.save).toHaveBeenCalledTimes(1); expect(h.get).toHaveBeenCalledTimes(2);
  });

  it('allows local discard while reconciliation is pending without clearing its warning or enabling retry', async () => {
    const h = await setup(); let latest!: (value: ArchiveBackupIntegrityStatus) => void;
    h.save.mockRejectedValueOnce(new Error('lost reply')); h.get.mockImplementationOnce(() => new Promise(resolve => { latest = resolve; }));
    h.node('time').value = '05:00'; h.node('time').fire('input'); h.node('save').click(); await vi.waitFor(() => expect(h.get).toHaveBeenCalledTimes(2));
    const warning = h.node('feedback').textContent, beforeTime = h.node('last-refreshed').getAttribute('datetime'); h.node('discard').click();
    expect(h.node('time').value).toBe('03:00'); expect(h.node('save').disabled).toBe(true); expect(h.node('feedback').textContent).toBe(warning);
    expect(h.node('last-refreshed').getAttribute('datetime')).toBe(beforeTime); expect(h.get).toHaveBeenCalledTimes(2);
    latest({ ...initial, policy: { ...initial.policy, schedule: { ...initial.policy.schedule, hour_utc: 5 } } }); await vi.waitFor(() => expect(h.node('save').disabled).toBe(false));
    expect(h.node('time').value).toBe('05:00'); h.node('time').value = ''; h.node('time').fire('input'); h.node('save').click();
    expect(h.node('feedback').textContent).toBe(warning); h.node('discard').click();
    expect(h.node('time').value).toBe('05:00'); expect(h.node('feedback').textContent).toBe(warning); expect(h.save).toHaveBeenCalledTimes(1); expect(h.get).toHaveBeenCalledTimes(2);
  });

  it.each(['error', 'unavailable'] as const)('keeps the last usable policy for Discard after a %s read', async outcome => {
    const h = await setup(); h.node('time').value = '05:00'; h.node('time').fire('input');
    if (outcome === 'error') h.get.mockRejectedValueOnce(new Error('private read'));
    else h.current({ ...initial, monitoring: 'unavailable', policy: { ...initial.policy, schedule: { ...initial.policy.schedule, hour_utc: 9 } } });
    await h.mounted.refresh(); const reads = h.get.mock.calls.length, feedback = h.node('refresh-status').textContent; h.node('discard').click();
    expect(h.node('time').value).toBe('03:00'); expect(h.node('save').disabled).toBe(true); expect(h.node('refresh-status').textContent).toBe(feedback);
    expect(h.get).toHaveBeenCalledTimes(reads); expect(h.save).not.toHaveBeenCalled();
  });

  it('can discard an early edit before the first confirmed policy without inventing defaults', async () => {
    const { root, document } = pickerTestDom(); let latest!: (value: ArchiveBackupIntegrityStatus) => void;
    const get = vi.fn<BackupIntegrityPorts['get']>(() => new Promise(resolve => { latest = resolve; })), save = vi.fn();
    const mounted = mountBackupIntegrity({ host: root as unknown as HTMLElement, document, ports: { get, save } }); disposals.push(() => mounted.dispose());
    const input = root.querySelector('[data-backup-integrity-time]')!, original = input.value; input.value = '05:00'; input.fire('input'); root.querySelector('[data-backup-integrity-discard]')!.click();
    expect(input.value).toBe(original); expect(save).not.toHaveBeenCalled(); expect(get).toHaveBeenCalledTimes(1); latest(initial);
    await vi.waitFor(() => expect(input.value).toBe('03:00')); expect(root.querySelector('[data-backup-integrity-discard]')!.disabled).toBe(true);
  });

  it.each(['error', 'sync-error', 'mismatch', 'malformed', 'unavailable'] as const)('blocks repeated saves until a fresh status reconciles a %s save reply', async outcome => {
    const h = await setup(); let latest!: (value: ArchiveBackupIntegrityStatus) => void;
    h.get.mockImplementationOnce(() => new Promise(resolve => { latest = resolve; }));
    h.save.mockImplementationOnce(input => {
      if (outcome === 'sync-error') throw new Error('private synchronous failure');
      if (outcome === 'error') return Promise.reject(new Error('private lost reply'));
      return Promise.resolve<ArchiveBackupIntegrityStatus>(outcome === 'mismatch' ? initial : { ...initial, policy: input.policy,
        monitoring: outcome === 'unavailable' ? 'unavailable' : 'unknown' as ArchiveBackupIntegrityStatus['monitoring'], issue: outcome === 'unavailable' ? 'settings_unavailable' : undefined });
    });
    const input = h.node('time'); input.value = '05:00'; input.fire('input'); h.node('save').click();
    await vi.waitFor(() => expect(h.node('feedback').textContent).toContain('could not be confirmed'));
    expect(h.node('save').disabled).toBe(true); expect(h.get).toHaveBeenCalledTimes(2);
    input.value = '07:00'; input.fire('input'); input.focus(); h.node('save').click(); h.node('save').click();
    expect(h.save).toHaveBeenCalledTimes(1); const warning = h.node('feedback').textContent;
    latest({ ...initial, policy: { ...initial.policy, schedule: { ...initial.policy.schedule, hour_utc: 5 } } });
    await vi.waitFor(() => expect(h.node('save').disabled).toBe(false));
    expect(h.node('feedback').textContent).toBe(warning); expect(input.value).toBe('07:00'); expect(input.focused).toBe(true);
    h.node('save').click(); expect(h.save).toHaveBeenCalledTimes(2);
    expect(h.save).toHaveBeenLastCalledWith({ policy: { ...initial.policy, schedule: { ...initial.policy.schedule, hour_utc: 7 } } });
  });

  it.each(['malformed', 'unavailable'] as const)('preserves the submitted draft after a matching but %s save reply and a fresh read', async outcome => {
    const h = await setup(), input = h.node('time'); let latest!: (value: ArchiveBackupIntegrityStatus) => void;
    h.get.mockImplementationOnce(() => new Promise(resolve => { latest = resolve; }));
    h.save.mockImplementationOnce(async ({ policy }) => ({ ...initial, policy,
      monitoring: outcome === 'unavailable' ? 'unavailable' : 'unknown' as ArchiveBackupIntegrityStatus['monitoring'], issue: outcome === 'unavailable' ? 'settings_unavailable' : undefined }));
    input.value = '05:00'; input.fire('input'); input.focus(); h.node('save').click();
    await vi.waitFor(() => expect(h.node('feedback').textContent).toContain('could not be confirmed')); latest(initial);
    await vi.waitFor(() => expect(h.node('save').disabled).toBe(false));
    expect(input.value).toBe('05:00'); expect(input.focused).toBe(true); expect(h.node('feedback').textContent).toContain('could not be confirmed');
    expect(h.save).toHaveBeenCalledTimes(1);
  });

  it.each(['error', 'unavailable', 'malformed', 'invalid-policy'] as const)('keeps an uncertain save blocked through a %s read and retains drafts and warnings during recovery', async outcome => {
    const h = await setup(), input = h.node('time'); const first = h.node('last-refreshed').getAttribute('datetime');
    let latest!: (value: ArchiveBackupIntegrityStatus) => void, fail!: (error: Error) => void;
    h.get.mockImplementationOnce(() => new Promise((resolve, reject) => { latest = resolve; fail = reject; }));
    h.save.mockRejectedValueOnce(new Error('private lost reply')); input.value = '05:00'; input.fire('input'); h.node('save').click();
    await vi.waitFor(() => expect(h.get).toHaveBeenCalledTimes(2)); const warning = h.node('feedback').textContent;
    input.value = '07:00'; input.fire('input'); input.focus(); h.now(1_700_000_001_000);
    if (outcome === 'error') fail(new Error('private read failure'));
    else latest({ ...initial, monitoring: outcome === 'unavailable' ? 'unavailable' : outcome === 'malformed' ? 'unknown' as ArchiveBackupIntegrityStatus['monitoring'] : 'active',
      policy: { ...initial.policy, schedule: { ...initial.policy.schedule, hour_utc: outcome === 'invalid-policy' ? 24 : 5 } } });
    await vi.waitFor(() => expect(h.node('refresh-status').textContent).toContain('Latest status refresh failed.'));
    expect(h.node('save').disabled).toBe(true); expect(h.node('feedback').textContent).toBe(warning);
    expect(h.node('last-refreshed').getAttribute('datetime')).toBe(first); h.node('save').click(); expect(h.save).toHaveBeenCalledTimes(1);
    h.current({ ...initial, policy: { ...initial.policy, schedule: { ...initial.policy.schedule, hour_utc: 5 } } }); h.now(1_700_000_002_000); await h.mounted.refresh();
    expect(h.node('save').disabled).toBe(false); expect(h.node('feedback').textContent).toBe(warning);
    expect(h.node('last-refreshed').getAttribute('datetime')).toBe('2023-11-14T22:13:22.000Z');
    expect(h.node('time')).toBe(input); expect(input.value).toBe('07:00'); expect(input.focused).toBe(true); expect(h.root.textContent).not.toContain('private');
  });

  it('does not enable retry or repaint after a reconciliation read arrives following disposal', async () => {
    const h = await setup(); let latest!: (value: ArchiveBackupIntegrityStatus) => void;
    h.get.mockImplementationOnce(() => new Promise(resolve => { latest = resolve; })); h.save.mockRejectedValueOnce(new Error('lost reply'));
    h.node('save').click(); await vi.waitFor(() => expect(h.get).toHaveBeenCalledTimes(2));
    h.mounted.dispose(); const before = h.root.textContent; latest(initial); await Promise.resolve(); await Promise.resolve();
    expect(h.node('save').disabled).toBe(true); expect(h.root.textContent).toBe(before); expect(h.save).toHaveBeenCalledTimes(1);
  });

  it('accepts an equivalent saved policy with reordered fields without reporting uncertainty', async () => {
    const h = await setup(); let latest!: (value: ArchiveBackupIntegrityStatus) => void;
    h.get.mockImplementationOnce(() => new Promise(resolve => { latest = resolve; }));
    h.save.mockImplementationOnce(async input => ({ ...initial, policy: { schedule: { weekday_utc: input.policy.schedule.weekday_utc,
      minute_utc: input.policy.schedule.minute_utc, hour_utc: input.policy.schedule.hour_utc, cadence: input.policy.schedule.cadence }, enabled: input.policy.enabled } }));
    h.node('time').value = '05:00'; h.node('time').fire('input'); h.node('save').click();
    await vi.waitFor(() => expect(h.node('feedback').textContent).toBe('S3 check schedule saved.'));
    expect(h.node('save').disabled).toBe(false); latest(initial);
  });

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

  for (const readFails of [true, false]) it.each([true, false])(`recovers from an uncertain save and an older read (read fails: ${readFails}, old first: %s)`, async oldFirst => {
    const h = await setup(), input = h.node('time');
    const previous = h.node('last-refreshed').getAttribute('datetime');
    let oldReply!: (value: ArchiveBackupIntegrityStatus) => void, failRead!: (error: Error) => void, failSave!: (error: Error) => void;
    let latest!: (value: ArchiveBackupIntegrityStatus) => void;
    h.get.mockImplementationOnce(() => new Promise((resolve, reject) => { oldReply = resolve; failRead = reject; }));
    h.get.mockImplementationOnce(() => new Promise(resolve => { latest = resolve; }));
    h.save.mockImplementationOnce(() => new Promise((_resolve, reject) => { failSave = reject; }));
    const reading = h.mounted.refresh();
    input.value = '05:00'; input.fire('input'); h.node('save').click();
    input.value = '07:00'; input.fire('input'); input.focus();
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
    expect(input.value).toBe('07:00'); expect(input.focused).toBe(true); expect(h.node('time')).toBe(input);
    expect(h.node('refresh-status').textContent).not.toContain('failed');
    expect(h.node('save').disabled).toBe(false); expect(h.node('feedback').textContent).toContain('could not be confirmed');
    expect(h.save).toHaveBeenCalledTimes(1); expect(h.root.textContent).not.toContain('private');
  });

  it('explains full reads and coverage, submits only an explicit UTC policy, and validates before dispatch', async () => {
    const h = await setup(); expect(h.root.textContent).toContain('downloads the full copy'); expect(h.root.textContent).toContain('Your recovery key is not needed');
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
