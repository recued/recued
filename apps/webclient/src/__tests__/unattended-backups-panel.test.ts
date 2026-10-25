import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ArchiveUnattendedStatus, ArchiveUnattendedSettings, ArchiveRemoteDestination } from '@recued/contracts';
import { mountUnattendedBackups, type UnattendedBackupsPorts } from '../settings/unattended-backups-panel.js';
import { pickerTestDom } from './helpers/file-download-picker-dom.js';
const destination: ArchiveRemoteDestination = { connection_name: 'safe', destination_id: 'a'.repeat(64), bucket: 'backup-bucket', region: 'us-east-1', endpoint: 'https://s3.example.test', prefix: '' };
const settings: ArchiveUnattendedSettings = { enabled: true, connection_name: 'safe', destination_id: destination.destination_id, keep_last: 5,
  schedule: { cadence: 'daily', hour_utc: 2, minute_utc: 0, weekday_utc: 0 } };
const submitted: ArchiveUnattendedSettings = { ...settings, schedule: { ...settings.schedule, hour_utc: 3, minute_utc: 30 } };
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); vi.useRealTimers(); });
type SetupOptions = Pick<Parameters<typeof mountUnattendedBackups>[0], 'now' | 'onRefreshPendingChange'>;
const setup = async (initial: ArchiveUnattendedStatus = { configured: false }, options: SetupOptions = {}) => {
  const { root, document } = pickerTestDom();
  let current = initial;
  const get = vi.fn(async () => current), save = vi.fn<UnattendedBackupsPorts['save']>(async input => { current = { configured: true, settings: input.settings }; return current; });
  const mounted = mountUnattendedBackups({ host: root as unknown as HTMLElement, document, ports: { get, save }, ...options });
  disposals.push(() => mounted.dispose()); mounted.destinations([destination]);
  const node = (name: string) => { const control = root.querySelector(`[data-unattended-${name}]`); if (!control) throw new Error(name); return control; };
  await vi.waitFor(() => expect(node('save').disabled).toBe(false));
  return { root, node, mounted, save, get, current: (value: ArchiveUnattendedStatus) => { current = value; } };
};
describe('unattended backup setup', () => {
  it('shows initial progress without inventing a successful status-read time', async () => {
    const { root, document } = pickerTestDom(); let finish!: (value: ArchiveUnattendedStatus) => void;
    const pending = vi.fn(), save = vi.fn();
    const mounted = mountUnattendedBackups({ host: root as unknown as HTMLElement, document, now: () => 1_700_000_000_000,
      onRefreshPendingChange: pending, ports: { get: () => new Promise(resolve => { finish = resolve; }), save } });
    disposals.push(() => mounted.dispose());
    expect(root.querySelector('[data-unattended-refresh-status]')!.textContent).toContain('Refreshing schedule status… No successful schedule status refresh yet.');
    expect(root.querySelector('[data-unattended-last-refreshed]')).toBeNull(); expect(pending).toHaveBeenLastCalledWith(true);
    finish({ configured: false }); await vi.waitFor(() => expect(pending).toHaveBeenLastCalledWith(false));
    expect(root.querySelector('[data-unattended-last-refreshed]')!.getAttribute('datetime')).toBe('2023-11-14T22:13:20.000Z'); expect(save).not.toHaveBeenCalled();
  });

  it.each(['error', 'malformed'] as const)('keeps the last successful read time through a pending and %s read, then recovers', async outcome => {
    let now = 1_700_000_000_000; const pending = vi.fn();
    const h = await setup({ configured: true, settings }, { now: () => now, onRefreshPendingChange: pending });
    const first = h.node('last-refreshed').getAttribute('datetime'), input = h.node('time'), focus = vi.spyOn(input, 'focus');
    input.value = '03:30'; input.fire('input'); input.focus(); h.node('words').value = 'synthetic unsubmitted words'; h.node('words').fire('input');
    let finish!: (value: ArchiveUnattendedStatus) => void, fail!: (error: Error) => void;
    h.get.mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
    const reading = h.mounted.refresh(); expect(h.node('refresh-status').textContent).toContain('Refreshing schedule status…');
    expect(h.node('last-refreshed').getAttribute('datetime')).toBe(first); expect(pending).toHaveBeenLastCalledWith(true); now += 1_000;
    if (outcome === 'error') fail(new Error('private status failure')); else finish({ configured: true }); await reading;
    expect(h.node('refresh-status').textContent).toContain('Latest schedule status refresh failed.'); expect(pending).toHaveBeenLastCalledWith(false);
    expect(h.node('last-refreshed').getAttribute('datetime')).toBe(first); expect(h.node('save').disabled).toBe(true);
    now += 1_000; await h.mounted.refresh();
    expect(h.node('last-refreshed').getAttribute('datetime')).toBe('2023-11-14T22:13:22.000Z'); expect(h.node('refresh-status').textContent).not.toContain('failed');
    expect(h.node('time')).toBe(input); expect(input.value).toBe('03:30'); expect(h.node('words').value).toBe('synthetic unsubmitted words');
    expect(focus).toHaveBeenCalledTimes(1); expect(h.save).not.toHaveBeenCalled(); expect(h.root.textContent).not.toContain('private status');
  });

  it('keeps reconciliation progress and uncertainty when local drafts are discarded', async () => {
    let now = 1_700_000_000_000; const pending = vi.fn();
    const h = await setup({ configured: true, settings }, { now: () => now, onRefreshPendingChange: pending });
    let finish!: (value: ArchiveUnattendedStatus) => void; h.get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    h.save.mockRejectedValueOnce(new Error('lost reply')); h.node('time').value = '03:30'; h.node('time').fire('input'); h.node('save').click();
    await vi.waitFor(() => expect(h.node('refresh-status').textContent).toContain('Refreshing schedule status…'));
    const warning = h.node('feedback').textContent; h.node('words').value = 'synthetic discarded words'; h.node('words').fire('input'); h.node('discard').click();
    expect(pending).toHaveBeenLastCalledWith(true); expect(h.node('save').disabled).toBe(true); expect(h.node('feedback').textContent).toBe(warning);
    expect(h.node('last-refreshed').getAttribute('datetime')).toBe('2023-11-14T22:13:20.000Z'); expect(h.node('words').value).toBe('');
    now += 1_000; finish({ configured: true, settings: submitted }); await vi.waitFor(() => expect(pending).toHaveBeenLastCalledWith(false));
    expect(h.node('last-refreshed').getAttribute('datetime')).toBe('2023-11-14T22:13:21.000Z'); expect(h.node('feedback').textContent).toBe(warning);
    expect(h.node('time').value).toBe('03:30'); expect(h.save).toHaveBeenCalledTimes(1);
  });

  it('releases pending progress on disposal and ignores a late read', async () => {
    const pending = vi.fn(), h = await setup({ configured: true, settings }, { now: () => 1_700_000_000_000, onRefreshPendingChange: pending });
    let finish!: (value: ArchiveUnattendedStatus) => void; h.get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const reading = h.mounted.refresh(), prior = h.node('refresh-status').textContent;
    h.mounted.dispose(); expect(pending).toHaveBeenLastCalledWith(false); pending.mockClear(); finish({ configured: false }); await reading;
    expect(pending).not.toHaveBeenCalled(); expect(h.node('refresh-status').textContent).toBe(prior);
    expect(h.node('last-refreshed').getAttribute('datetime')).toBe('2023-11-14T22:13:20.000Z');
  });

  it('adopts a new confirmed schedule after edits are reverted without saving', async () => {
    const h = await setup({ configured: true, settings });
    h.node('time').value = '03:30'; h.node('time').fire('input'); h.node('time').value = '02:00'; h.node('time').fire('input');
    h.current({ configured: true, settings: { ...settings, schedule: { ...settings.schedule, hour_utc: 4 } } });
    await h.mounted.refresh(); expect(h.node('time').value).toBe('04:00'); expect(h.save).not.toHaveBeenCalled();
  });

  it('tracks actual public edits and treats recovery words as a write-only draft', async () => {
    const h = await setup({ configured: true, settings });
    expect(h.node('draft-status').textContent).toBe('No unsaved schedule changes.'); expect(h.node('discard').disabled).toBe(true);
    for (const [name, changed, original] of [['time', '03:30', '02:00'], ['keep', '8', '5'], ['cadence', 'weekly', 'daily'], ['day', '2', '0'], ['words', 'synthetic draft words', '']]) {
      h.node(name!).value = changed!; h.node(name!).fire('input'); expect(h.node('discard').disabled).toBe(false);
      expect(h.node('draft-status').textContent).toBe('Unsaved schedule changes.');
      h.node(name!).value = original!; h.node(name!).fire('input'); expect(h.node('discard').disabled).toBe(true);
    }
    h.node('enabled').checked = false; h.node('enabled').fire('change'); expect(h.node('discard').disabled).toBe(false);
    h.node('enabled').checked = true; h.node('enabled').fire('change'); expect(h.node('discard').disabled).toBe(true);
    h.node('keep').value = '05'; h.node('keep').fire('input'); expect(h.node('discard').disabled).toBe(true);
    h.node('words').value = ' '; h.node('words').fire('input'); expect(h.node('discard').disabled).toBe(false);
    h.node('discard').click(); expect(h.node('words').value).toBe(''); expect(h.save).not.toHaveBeenCalled();
  });

  it('discards to the latest confirmed schedule, clears words and validation, and sends no request', async () => {
    const h = await setup({ configured: true, settings }), time = h.node('time');
    time.value = ''; time.fire('input'); h.node('save').click(); expect(time.getAttribute('aria-invalid')).toBe('true');
    h.node('words').value = 'synthetic local words'; h.node('words').fire('input');
    const latest = { ...settings, enabled: false, keep_last: 9, schedule: { cadence: 'weekly' as const, hour_utc: 4, minute_utc: 15, weekday_utc: 2 } };
    h.current({ configured: true, settings: latest }); await h.mounted.refresh(); expect(time.value).toBe('');
    const reads = h.get.mock.calls.length; h.node('discard').click();
    expect(h.node('time')).toBe(time); expect(time.value).toBe('04:15'); expect(time.getAttribute('aria-invalid')).toBeNull();
    expect(h.node('enabled').checked).toBe(false); expect(h.node('enabled').focused).toBe(true);
    expect(h.node('keep').value).toBe('9'); expect(h.node('day').value).toBe('2'); expect(h.node('cadence').value).toBe('weekly');
    expect(h.node('words').value).toBe(''); expect(h.node('discard').disabled).toBe(true); expect(h.node('feedback').textContent).toBe('');
    expect(h.get).toHaveBeenCalledTimes(reads); expect(h.save).not.toHaveBeenCalled(); expect(h.root.textContent).not.toContain('synthetic local words');
  });

  it('restores first-setup defaults and clears all local validation without saving', async () => {
    const h = await setup(); h.node('time').value = ''; h.node('time').fire('input'); h.node('keep').value = '31'; h.node('keep').fire('input');
    h.node('words').value = 'synthetic setup draft'; h.node('words').fire('input'); h.node('save').click();
    h.node('discard').click();
    for (const name of ['destination', 'time', 'keep', 'words']) expect(h.node(name).getAttribute('aria-invalid')).toBeNull();
    expect(h.node('enabled').checked).toBe(true); expect(h.node('destination').value).toBe(''); expect(h.node('time').value).toBe('02:00');
    expect(h.node('keep').value).toBe('5'); expect(h.node('cadence').value).toBe('daily'); expect(h.node('day').value).toBe('0');
    expect(h.node('words').value).toBe(''); expect(h.node('draft-status').textContent).toBe('No unsaved schedule changes.'); expect(h.save).not.toHaveBeenCalled();
  });

  it('can discard after a failed read without turning cached settings into permission to save', async () => {
    const h = await setup({ configured: true, settings }); h.node('time').value = '03:30'; h.node('time').fire('input');
    h.get.mockRejectedValueOnce(new Error('private read failure')); await h.mounted.refresh(); const status = h.node('status').textContent;
    h.node('discard').click(); expect(h.node('time').value).toBe('02:00'); expect(h.node('save').disabled).toBe(true);
    expect(h.node('status').textContent).toBe(status); expect(h.node('discard').disabled).toBe(true); expect(h.save).not.toHaveBeenCalled();
  });

  it('keeps uncertainty and the retry block when drafts are discarded before reconciliation', async () => {
    const h = await setup({ configured: true, settings }); let finish!: (value: ArchiveUnattendedStatus) => void;
    h.get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); h.save.mockRejectedValueOnce(new Error('lost reply'));
    h.node('time').value = '03:30'; h.node('time').fire('input'); h.node('words').value = 'synthetic submitted words'; h.node('save').click();
    await vi.waitFor(() => expect(h.node('feedback').textContent).toContain('could not be confirmed'));
    const warning = h.node('feedback').textContent; h.node('words').value = 'synthetic newer words'; h.node('words').fire('input');
    h.node('discard').click(); expect(h.node('words').value).toBe(''); expect(h.node('time').value).toBe('02:00');
    expect(h.node('save').disabled).toBe(true); expect(h.node('feedback').textContent).toBe(warning);
    finish({ configured: true, settings: submitted }); await vi.waitFor(() => expect(h.node('save').disabled).toBe(false));
    expect(h.node('time').value).toBe('03:30'); expect(h.node('discard').disabled).toBe(true); expect(h.node('feedback').textContent).toBe(warning);
    expect(h.save).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('preserves later edits reverted to the old value while saving (uncertain: %s)', async uncertain => {
    const h = await setup({ configured: true, settings }); let finish!: (value: ArchiveUnattendedStatus) => void, fail!: (error: Error) => void;
    h.save.mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
    h.node('time').value = '03:30'; h.node('time').fire('input'); h.node('save').click();
    h.node('time').value = '02:00'; h.node('time').fire('input'); expect(h.node('discard').disabled).toBe(true);
    h.node('words').value = 'synthetic newer words'; h.node('words').fire('input'); h.node('discard').click();
    expect(h.node('words').value).toBe('synthetic newer words'); h.current({ configured: true, settings: submitted });
    if (uncertain) fail(new Error('lost reply')); else finish({ configured: true, settings: submitted });
    await vi.waitFor(() => expect(h.node('save').disabled).toBe(false));
    expect(h.node('time').value).toBe('02:00'); expect(h.node('words').value).toBe('synthetic newer words'); expect(h.node('discard').disabled).toBe(false);
    h.node('discard').click(); expect(h.node('time').value).toBe('03:30'); expect(h.node('words').value).toBe('');
    if (uncertain) expect(h.node('feedback').textContent).toContain('could not be confirmed');
    else expect(h.node('feedback').textContent).toBe('');
  });

  it('does not report newer edits when values return to the submitted schedule before confirmation', async () => {
    const h = await setup({ configured: true, settings }); let finish!: (value: ArchiveUnattendedStatus) => void;
    h.save.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    h.node('time').value = '03:30'; h.node('time').fire('input'); h.node('save').click();
    h.node('time').value = '07:15'; h.node('time').fire('input'); h.node('time').value = '03:30'; h.node('time').fire('input');
    h.current({ configured: true, settings: submitted }); finish({ configured: true, settings: submitted });
    await vi.waitFor(() => expect(h.node('save').disabled).toBe(false));
    expect(h.node('draft-status').textContent).toBe('No unsaved schedule changes.'); expect(h.node('feedback').textContent).not.toContain('newer edits');
  });

  it('keeps a public edit back to the old value when an uncertain save is reconciled', async () => {
    const h = await setup({ configured: true, settings }); let fail!: (error: Error) => void;
    h.save.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    h.node('time').value = '03:30'; h.node('time').fire('input'); h.node('save').click();
    h.node('time').value = '02:00'; h.node('time').fire('input'); expect(h.node('draft-status').textContent).toBe('No unsaved schedule changes.');
    h.current({ configured: true, settings: submitted }); fail(new Error('lost reply'));
    await vi.waitFor(() => expect(h.node('feedback').textContent).toContain('could not be confirmed'));
    await vi.waitFor(() => expect(h.node('save').disabled).toBe(false));
    expect(h.node('time').value).toBe('02:00'); expect(h.node('draft-status').textContent).toBe('Unsaved schedule changes.');
    h.node('discard').click(); expect(h.node('time').value).toBe('03:30'); expect(h.save).toHaveBeenCalledTimes(1);
  });

  it('restores a stale destination binding without silently selecting its same-name replacement', async () => {
    const h = await setup({ configured: true, settings }); h.node('time').value = '03:30'; h.node('time').fire('input');
    h.mounted.destinations([{ ...destination, destination_id: 'b'.repeat(64) }]); h.node('discard').click();
    expect(h.node('destination').value).toBe('stale:safe'); expect(h.node('discard').disabled).toBe(true);
    h.node('save').click(); expect(h.save).not.toHaveBeenCalled(); expect(h.node('destination').getAttribute('aria-invalid')).toBe('true');
    h.node('destination').value = 'safe'; h.node('destination').fire('change'); expect(h.node('discard').disabled).toBe(false);
    h.node('save').click(); expect(h.save).toHaveBeenCalledExactlyOnceWith({ settings: { ...settings, destination_id: 'b'.repeat(64) } });
  });


  it('keeps the submitted draft when a save reply does not confirm its settings', async () => {
    const h = await setup({ configured: true, settings });
    h.save.mockResolvedValueOnce({ configured: true, settings });
    h.node('time').value = '03:30'; h.node('time').fire('input'); h.node('save').click();
    await vi.waitFor(() => expect(h.node('save').disabled).toBe(false));
    expect(h.node('time').value).toBe('03:30');
    expect(h.node('feedback').textContent).toContain('could not be confirmed');
    expect(h.node('feedback').textContent).not.toContain('schedule saved'); expect(h.save).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['enabled', { ...submitted, enabled: false }],
    ['connection name', { ...submitted, connection_name: 'other' }],
    ['destination identity', { ...submitted, destination_id: 'b'.repeat(64) }],
    ['retention', { ...submitted, keep_last: 6 }],
    ['cadence', { ...submitted, schedule: { ...submitted.schedule, cadence: 'weekly' } }],
    ['hour', { ...submitted, schedule: { ...submitted.schedule, hour_utc: 4 } }],
    ['minute', { ...submitted, schedule: { ...submitted.schedule, minute_utc: 45 } }],
    ['weekday', { ...submitted, schedule: { ...submitted.schedule, weekday_utc: 1 } }],
    ['missing settings', undefined],
    ['missing schedule', { ...submitted, schedule: undefined }],
  ] as const)('treats a %s mismatch as unconfirmed and waits for a fresh read without losing drafts', async (_name, returned) => {
    const h = await setup({ configured: true, settings }); let finish!: (value: ArchiveUnattendedStatus) => void;
    h.save.mockResolvedValueOnce({ configured: true, settings: returned } as ArchiveUnattendedStatus);
    h.get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    h.node('time').value = '03:30'; h.node('time').fire('input'); h.node('words').value = 'synthetic replacement words'; h.node('save').click();
    await vi.waitFor(() => expect(h.node('feedback').textContent).toContain('could not be confirmed'));
    expect(h.node('save').disabled).toBe(true); expect(h.node('time').value).toBe('03:30'); expect(h.node('words').value).toBe('');
    h.node('save').click(); expect(h.save).toHaveBeenCalledTimes(1); finish({ configured: true, settings });
    await vi.waitFor(() => expect(h.node('save').disabled).toBe(false));
    expect(h.node('time').value).toBe('03:30'); expect(h.node('feedback').textContent).toContain('could not be confirmed');
    expect(h.root.textContent).not.toContain('synthetic replacement words'); expect(h.save).toHaveBeenCalledTimes(1);
  });

  it('accepts matching settings in a different property order and retains newer edits', async () => {
    const h = await setup({ configured: true, settings }); let finish!: (value: ArchiveUnattendedStatus) => void;
    h.save.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    h.node('time').value = '03:30'; h.node('time').fire('input'); h.node('save').click();
    h.node('keep').value = '8'; h.node('keep').fire('input');
    const confirmed: ArchiveUnattendedStatus = { configured: true, settings: { schedule: {
      weekday_utc: 0, minute_utc: 30, hour_utc: 3, cadence: 'daily',
    }, keep_last: 5, destination_id: settings.destination_id, connection_name: 'safe', enabled: true } };
    h.current(confirmed); finish(confirmed);
    await vi.waitFor(() => expect(h.node('save').disabled).toBe(false));
    expect(h.node('feedback').textContent).toContain('newer edits'); expect(h.node('keep').value).toBe('8'); expect(h.node('time').value).toBe('03:30');
  });

  it.each(['error', 'malformed'] as const)('blocks retry after an uncertain save and %s reconciliation until a valid read arrives', async outcome => {
    const h = await setup({ configured: true, settings }); let fail!: (error: Error) => void, finish!: (value: ArchiveUnattendedStatus) => void;
    h.get.mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
    h.save.mockRejectedValueOnce(new Error('private transport failure'));
    h.node('time').value = '03:30'; h.node('time').fire('input'); h.node('words').value = 'synthetic submitted words'; h.node('save').click();
    await vi.waitFor(() => expect(h.node('feedback').textContent).toContain('could not be confirmed'));
    h.node('time').value = '07:15'; h.node('time').fire('input'); h.node('words').value = 'synthetic newer words'; h.node('words').fire('input');
    if (outcome === 'error') fail(new Error('private status failure')); else finish({ configured: true });
    await vi.waitFor(() => expect(h.node('status').textContent).toContain('could not be checked'));
    expect(h.node('save').disabled).toBe(true); h.mounted.destinations([destination]); h.node('save').click(); expect(h.save).toHaveBeenCalledTimes(1);
    h.current({ configured: true, settings: submitted }); await h.mounted.refresh();
    expect(h.node('save').disabled).toBe(false); expect(h.node('time').value).toBe('07:15'); expect(h.node('words').value).toBe('synthetic newer words');
    expect(h.node('feedback').textContent).toContain('could not be confirmed'); expect(h.root.textContent).not.toContain('private transport');
  });

  it('does not confirm a recovery-key replacement from matching public settings or replay its words', async () => {
    const h = await setup({ configured: true, settings });
    h.node('words').value = 'synthetic replacement words'; h.node('words').fire('input');
    h.save.mockRejectedValueOnce(new Error('lost reply')); h.node('save').click();
    await vi.waitFor(() => expect(h.node('feedback').textContent).toContain('could not be confirmed'));
    await vi.waitFor(() => expect(h.node('save').disabled).toBe(false)); await h.mounted.refresh();
    expect(h.node('words').value).toBe(''); expect(h.save).toHaveBeenCalledTimes(1);
    expect(h.node('feedback').textContent).toContain('could not be confirmed'); h.node('save').click();
    expect(h.save).toHaveBeenLastCalledWith({ settings }); expect(h.save).toHaveBeenCalledTimes(2);
  });

  it('retains an uncertain-save warning when fresh first-setup status requires words again', async () => {
    const h = await setup(); h.node('destination').value = 'safe'; h.node('destination').fire('change'); h.node('words').value = 'synthetic initial words';
    h.save.mockResolvedValueOnce({ configured: false }); h.node('save').click();
    await vi.waitFor(() => expect(h.node('feedback').textContent).toContain('could not be confirmed'));
    await vi.waitFor(() => expect(h.node('save').disabled).toBe(false)); h.node('save').click();
    expect(h.node('words-error').textContent).toContain('Enter your recovery key');
    expect(h.node('feedback').textContent).toContain('could not be confirmed'); expect(h.node('words').value).toBe(''); expect(h.save).toHaveBeenCalledTimes(1);
  });

  it('handles a synchronous save failure without retaining or repeating the submitted words', async () => {
    const h = await setup({ configured: true, settings }); h.node('words').value = 'synthetic private words';
    h.save.mockImplementationOnce(() => { throw new Error('synthetic private words'); });
    expect(() => h.node('save').click()).not.toThrow();
    await vi.waitFor(() => expect(h.node('feedback').textContent).toContain('could not be confirmed'));
    expect(h.node('words').value).toBe(''); expect(h.root.textContent).not.toContain('synthetic private words'); expect(h.save).toHaveBeenCalledTimes(1);
  });

  for (const oldFirst of [true, false]) for (const readFails of [true, false]) for (const writeFails of [true, false]) {
    it(`reconciles a superseded read immediately (old first: ${oldFirst}, read fails: ${readFails}, write fails: ${writeFails})`, async () => {
      let now = 1_700_000_000_000; const pending = vi.fn();
      const h = await setup({ configured: true, settings }, { now: () => now, onRefreshPendingChange: pending });
      const first = h.node('last-refreshed').getAttribute('datetime'); pending.mockClear();
      let oldReply!: (value: ArchiveUnattendedStatus) => void, oldFailure!: (error: Error) => void, freshReply!: (value: ArchiveUnattendedStatus) => void;
      h.get.mockImplementationOnce(() => new Promise((resolve, reject) => { oldReply = resolve; oldFailure = reject; }))
        .mockImplementationOnce(() => new Promise(resolve => { freshReply = resolve; }));
      const reading = h.mounted.refresh(); let saved!: (value: ArchiveUnattendedStatus) => void, saveFailure!: (error: Error) => void;
      h.save.mockImplementationOnce(() => new Promise((resolve, reject) => { saved = resolve; saveFailure = reject; }));
      h.node('time').value = '03:30'; h.node('time').fire('input'); h.node('words').value = 'synthetic submitted words'; h.node('save').click();
      expect(h.node('refresh-status').textContent).toContain('Waiting to refresh schedule status after the save.');
      h.node('keep').value = '8'; h.node('keep').fire('input');
      const settleOld = () => readFails ? oldFailure(new Error('private old read')) : oldReply({ configured: true, settings });
      if (oldFirst) { settleOld(); await reading; expect(h.get).toHaveBeenCalledTimes(2); }
      now += 2_000; if (writeFails) saveFailure(new Error('private unknown write')); else saved({ configured: true, settings: submitted });
      await vi.waitFor(() => expect(h.node('feedback').textContent).toContain(writeFails ? 'could not be confirmed' : 'newer edits'));
      if (!oldFirst) { expect(h.get).toHaveBeenCalledTimes(2); settleOld(); await reading; }
      await vi.waitFor(() => expect(h.get).toHaveBeenCalledTimes(3));
      expect(h.node('last-refreshed').getAttribute('datetime')).toBe(first); expect(h.node('refresh-status').textContent).toContain('Refreshing schedule status…');
      expect(pending.mock.calls.every(([value]) => value === true)).toBe(true);
      if (writeFails) expect(h.node('save').disabled).toBe(true);
      expect(h.node('time').value).toBe('03:30'); expect(h.node('keep').value).toBe('8'); expect(h.node('words').value).toBe('');
      now += 1_000; freshReply({ configured: true, settings: submitted }); await vi.waitFor(() => expect(h.node('save').disabled).toBe(false));
      expect(pending).toHaveBeenLastCalledWith(false); expect(h.node('last-refreshed').getAttribute('datetime')).toBe('2023-11-14T22:13:23.000Z');
      expect(h.node('time').value).toBe('03:30'); expect(h.node('keep').value).toBe('8'); expect(h.save).toHaveBeenCalledTimes(1);
      if (writeFails) expect(h.node('feedback').textContent).toContain('could not be confirmed');
    });
  }

  it('marks all setup errors in field order, preserves drafts, and never echoes recovery words', async () => {
    const h = await setup(); h.node('time').value = ''; h.node('time').fire('input');
    h.node('keep').value = '31'; h.node('keep').fire('input');
    const focus = vi.spyOn(h.node('destination'), 'focus'); h.node('save').click();
    expect(focus).toHaveBeenCalledTimes(1); expect(h.save).not.toHaveBeenCalled();
    for (const name of ['destination', 'time', 'keep', 'words']) {
      expect(h.node(name).getAttribute('aria-invalid')).toBe('true');
      expect(h.node(name).getAttribute('aria-describedby')).toBe(h.node(`${name}-error`).id);
    }
    h.node('words').value = 'synthetic private draft'; h.node('words').fire('input');
    expect(h.node('words').getAttribute('aria-invalid')).toBeNull();
    await h.mounted.refresh(); expect(h.node('time').value).toBe(''); expect(h.node('keep').value).toBe('31');
    expect(h.node('words').value).toBe('synthetic private draft'); expect(focus).toHaveBeenCalledTimes(1);
    h.node('destination').value = 'safe'; h.node('destination').fire('change');
    expect(h.node('destination').getAttribute('aria-invalid')).toBeNull();
    h.node('time').value = '06:45'; h.node('time').fire('input'); h.node('keep').value = '5'; h.node('keep').fire('change');
    h.node('save').click(); expect(h.node('words').value).toBe('');
    expect(h.save).toHaveBeenCalledExactlyOnceWith({ settings: { ...settings, schedule: { ...settings.schedule, hour_utc: 6, minute_utc: 45 } }, recoveryKey: 'synthetic private draft' });
    h.node('keep').fire('input'); expect(h.node('words').getAttribute('aria-invalid')).toBeNull();
    expect(h.root.textContent).not.toContain('synthetic private draft');
  });

  it.each([['cadence', 'monthly'], ['time', '24:00'], ['time', '12:60'], ['day', ''], ['day', '7'], ['keep', '1.5']] as const)(
    'blocks malformed %s %j before dispatch', async (name, value) => {
      const h = await setup({ configured: true, settings }), input = h.node(name), focus = vi.spyOn(input, 'focus');
      input.value = value; input.fire('change'); h.node('save').click();
      expect(h.save).not.toHaveBeenCalled(); expect(focus).toHaveBeenCalledTimes(1);
      expect(input.getAttribute('aria-invalid')).toBe('true');
    });

  it('clears a stale destination error when pausing an existing schedule', async () => {
    const h = await setup({ configured: true, settings }); h.mounted.destinations([]); h.node('save').click();
    expect(h.node('destination').getAttribute('aria-invalid')).toBe('true');
    h.node('enabled').checked = false; h.node('enabled').fire('change');
    expect(h.node('destination').getAttribute('aria-invalid')).toBeNull();
    h.node('save').click(); expect(h.save).toHaveBeenCalledExactlyOnceWith({ settings: { ...settings, enabled: false } });
  });

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
    await vi.waitFor(() => expect(h.node('feedback').textContent).toContain('could not be confirmed'));
    await vi.waitFor(() => expect(h.node('save').disabled).toBe(false));
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
