import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BackupWatchdogStatus } from '@recued/contracts';
import { mountBackupWatchdog, type BackupWatchdogPorts } from '../settings/backup-watchdog-panel.js';
import { mountRemoteBackups } from '../settings/remote-backups-panel.js';
import { pickerTestDom } from './helpers/file-download-picker-dom.js';

const initial: BackupWatchdogStatus = { configured: false, enabled: false, state: 'not_configured' };
const configured: BackupWatchdogStatus = { configured: true, enabled: true, state: 'acknowledged', last_attempt_at: 100, last_acknowledged_at: 101 };
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });
type SetupOptions = Pick<Parameters<typeof mountBackupWatchdog>[0], 'now' | 'onRefreshPendingChange'> & { drill?: BackupWatchdogPorts['drill'] };
const setup = async (value = initial, options: SetupOptions = {}) => {
  const { root, document } = pickerTestDom(); let current = structuredClone(value);
  const get = vi.fn<BackupWatchdogPorts['get']>(async () => current);
  const save = vi.fn<BackupWatchdogPorts['save']>(async input => {
    current = input.forget ? initial : { configured: current.configured || !!input.ping_url, enabled: input.enabled, state: input.enabled ? 'waiting' : 'paused' };
    return current;
  });
  const { drill, ...mountOptions } = options;
  const mount = mountBackupWatchdog({ host: root as unknown as HTMLElement, document, ports: { get, save, ...(drill ? { drill } : {}) }, ...mountOptions }); disposals.push(() => mount.dispose());
  const node = (name: string) => { const value = root.querySelector(`[data-backup-watchdog-${name}]`); if (!value) throw new Error(name); return value; };
  await vi.waitFor(() => expect(node('save').disabled).toBe(false));
  return { root, document, node, mount, get, save, current: (value: BackupWatchdogStatus) => { current = value; } };
};
describe('offline backup alert setup', () => {
  it.each(['error', 'unavailable', 'malformed'] as const)('retains the successful read time through a pending and %s refresh, then recovers', async outcome => {
    let now = 1_700_000_000_000;
    const pending = vi.fn(), h = await setup(configured, { now: () => now, onRefreshPendingChange: pending });
    const first = h.node('last-refreshed').getAttribute('datetime'), url = h.node('url'), focus = vi.spyOn(url, 'focus');
    expect(first).toBe('2023-11-14T22:13:20.000Z'); expect(h.node('receipt').textContent).toContain('Last ping acknowledgment:');
    let finish!: (value: BackupWatchdogStatus) => void, fail!: (error: Error) => void;
    h.get.mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
    url.value = 'https://draft.example/private-read-draft'; url.fire('input'); url.focus();
    const read = h.mount.refresh();
    expect(h.node('refresh-status').textContent).toContain('Refreshing monitor status…'); expect(pending).toHaveBeenLastCalledWith(true);
    expect(h.node('last-refreshed').getAttribute('datetime')).toBe(first); now += 1_000;
    if (outcome === 'error') fail(new Error('private provider read failure'));
    else finish(outcome === 'unavailable' ? { ...configured, state: 'unavailable' } : { ...configured, enabled: undefined } as unknown as BackupWatchdogStatus);
    await read;
    expect(pending).toHaveBeenLastCalledWith(false); expect(h.node('refresh-status').textContent).toContain('Latest monitor status refresh failed.');
    expect(h.node('last-refreshed').getAttribute('datetime')).toBe(first); expect(h.node('save').disabled).toBe(true);
    expect(h.node('receipt').textContent).toBe(''); expect(h.root.textContent).not.toContain('private provider');
    now += 1_000; await h.mount.refresh();
    expect(h.node('refresh-status').textContent).not.toContain('failed'); expect(h.node('last-refreshed').getAttribute('datetime')).toBe('2023-11-14T22:13:22.000Z');
    expect(h.node('url')).toBe(url); expect(url.value).toBe('https://draft.example/private-read-draft'); expect(focus).toHaveBeenCalledTimes(1);
    expect(h.save).not.toHaveBeenCalled();
  });

  it.each([
    { kind: 'save', oldFirst: true, readFails: false, writeFails: false },
    { kind: 'save', oldFirst: false, readFails: true, writeFails: true },
    { kind: 'drill', oldFirst: true, readFails: true, writeFails: false },
    { kind: 'drill', oldFirst: false, readFails: false, writeFails: true },
  ] as const)('keeps refresh pending across a superseded read and $kind action ($oldFirst, $readFails, $writeFails)', async ({ kind, oldFirst, readFails, writeFails }) => {
    let now = 1_700_000_000_000;
    const ready: BackupWatchdogStatus = { ...configured, configuration_revision: '12345678-1234-4234-8234-123456789abc' };
    let finishWrite!: (value: BackupWatchdogStatus) => void, failWrite!: (error: Error) => void;
    const writing = new Promise<BackupWatchdogStatus>((resolve, reject) => { finishWrite = resolve; failWrite = reject; });
    const start = vi.fn<NonNullable<BackupWatchdogPorts['drill']>['start']>(() => writing), pending = vi.fn();
    const h = await setup(ready, { now: () => now, onRefreshPendingChange: pending, drill: { start, update: async () => ready } });
    const first = h.node('last-refreshed').getAttribute('datetime'); pending.mockClear();
    let finishOld!: (value: BackupWatchdogStatus) => void, failOld!: (error: Error) => void, finishFresh!: (value: BackupWatchdogStatus) => void;
    h.get.mockImplementationOnce(() => new Promise((resolve, reject) => { finishOld = resolve; failOld = reject; }))
      .mockImplementationOnce(() => new Promise(resolve => { finishFresh = resolve; }));
    const reading = h.mount.refresh();
    if (kind === 'save') { h.save.mockImplementationOnce(() => writing); h.node('save').click(); }
    else { h.node('drill-review').click(); h.node('drill-start').click(); }
    expect(h.node('refresh-status').textContent).toContain('Waiting to refresh monitor status after the current action.');
    const url = h.node('url'); url.value = 'https://draft.example/private-newer-draft'; url.fire('input');
    const settleOld = () => readFails ? failOld(new Error('private old read failure')) : finishOld(initial);
    if (oldFirst) { settleOld(); await reading; expect(h.get).toHaveBeenCalledTimes(2); }
    now += 2_000;
    const next: BackupWatchdogStatus = kind === 'save' ? ready : { ...ready, state: 'drill_paused', drill: {
      operation_id: start.mock.calls[0]![0].operation_id, phase: 'paused', pause_minutes: 10,
      started_at: now, pause_until: now + 600_000, current_configuration: true,
    } };
    if (writeFails) failWrite(new Error('private uncertain action')); else finishWrite(next);
    await vi.waitFor(() => expect(h.node('feedback').textContent).toContain(writeFails ? 'could not be confirmed' : kind === 'save' ? 'saved' : 'updated'));
    if (!oldFirst) { settleOld(); await reading; }
    await vi.waitFor(() => expect(h.get).toHaveBeenCalledTimes(3));
    expect(h.node('last-refreshed').getAttribute('datetime')).toBe(first);
    expect(h.node('refresh-status').textContent).toContain('Refreshing monitor status…');
    expect(pending.mock.calls.every(([value]) => value === true)).toBe(true);
    now += 1_000; finishFresh(next);
    await vi.waitFor(() => expect(pending).toHaveBeenLastCalledWith(false));
    expect(h.node('last-refreshed').getAttribute('datetime')).toBe('2023-11-14T22:13:23.000Z');
    expect(h.node('url')).toBe(url); expect(url.value).toBe('https://draft.example/private-newer-draft');
    expect(kind === 'save' ? h.save : start).toHaveBeenCalledTimes(1);
    if (writeFails) expect(h.node('feedback').textContent).toContain('could not be confirmed');
  });

  it('clears pending refresh ownership on disposal and ignores a late reply', async () => {
    const pending = vi.fn(), h = await setup(configured, { now: () => 1_700_000_000_000, onRefreshPendingChange: pending });
    let finish!: (value: BackupWatchdogStatus) => void;
    h.get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const reading = h.mount.refresh(), prior = h.node('refresh-status').textContent;
    h.mount.dispose(); expect(pending).toHaveBeenLastCalledWith(false); pending.mockClear();
    finish(initial); await reading; expect(pending).not.toHaveBeenCalled(); expect(h.node('refresh-status').textContent).toBe(prior);
  });

  it('rejects an invalid monitor URL locally and focuses its inline error', async () => {
    const h = await setup(), url = h.node('url');
    h.node('enabled').checked = true; h.node('enabled').fire('change');
    url.value = 'http://monitor.example/private-token'; url.fire('input');
    expect(url.getAttribute('aria-invalid')).toBeNull(); h.node('save').click();
    expect(h.save).not.toHaveBeenCalled();
    expect(url.getAttribute('aria-invalid')).toBe('true'); expect(url.focused).toBe(true);
    expect(url.getAttribute('aria-describedby')).toBe(h.node('url-error').id);
    expect(h.node('url-error').textContent).toContain('HTTPS');
    expect(h.root.textContent).not.toContain('private-token');
    expect(h.node('feedback').textContent).not.toContain('could not be confirmed');
  });

  it('keeps URL validation through refresh and clears it on correction without taking focus', async () => {
    const h = await setup(), url = h.node('url'), focus = vi.spyOn(url, 'focus');
    h.node('enabled').checked = true; h.node('enabled').fire('change');
    url.value = 'https://monitor.example/ping?private=token'; url.fire('input'); h.node('save').click();
    const error = h.node('url-error'); expect(focus).toHaveBeenCalledTimes(1);
    await h.mount.refresh(); h.get.mockRejectedValueOnce(new Error('private read failure')); await h.mount.refresh();
    expect(h.node('url')).toBe(url); expect(h.node('url-error')).toBe(error);
    expect(url.getAttribute('aria-invalid')).toBe('true'); expect(focus).toHaveBeenCalledTimes(1);
    url.value = 'https://monitor.example/ping'; url.fire('input');
    expect(url.getAttribute('aria-invalid')).toBeNull(); expect(url.getAttribute('aria-describedby')).toBeNull();
    expect(error.textContent).toBe(''); expect(focus).toHaveBeenCalledTimes(1); expect(h.save).not.toHaveBeenCalled();
    await h.mount.refresh(); h.node('save').click();
    expect(h.save).toHaveBeenCalledExactlyOnceWith({ enabled: true, ping_url: 'https://monitor.example/ping' });
  });

  it('keeps the stored URL when a replacement is blank and allows removal despite an invalid draft', async () => {
    const h = await setup(configured), url = h.node('url');
    url.value = 'http://monitor.example/private'; url.fire('input'); h.node('save').click();
    expect(url.getAttribute('aria-invalid')).toBe('true'); expect(h.save).not.toHaveBeenCalled();
    url.value = '  '; url.fire('input'); expect(url.getAttribute('aria-invalid')).toBeNull();
    h.node('enabled').checked = false; h.node('enabled').fire('change'); h.node('save').click();
    expect(h.save).toHaveBeenCalledExactlyOnceWith({ enabled: false });
    await vi.waitFor(() => expect(h.node('save').disabled).toBe(false));
    url.value = 'http://monitor.example/another-private'; url.fire('input'); h.node('save').click();
    expect(url.getAttribute('aria-invalid')).toBe('true'); expect(h.save).toHaveBeenCalledTimes(1);
    h.node('remove').click(); expect(h.save).toHaveBeenLastCalledWith({ enabled: false, forget: true });
    expect(url.getAttribute('aria-invalid')).toBeNull(); expect(h.node('url-error').textContent).toBe('');
  });

  it('clears local validation on discard while keeping an uncertain-save warning', async () => {
    const h = await setup(configured), url = h.node('url');
    url.value = 'https://monitor.example/private'; url.fire('input');
    h.save.mockRejectedValueOnce(new Error('private write failure')); h.node('save').click();
    await vi.waitFor(() => expect(h.node('feedback').textContent).toContain('could not be confirmed'));
    await vi.waitFor(() => expect(h.node('save').disabled).toBe(false)); const warning = h.node('feedback').textContent;
    url.value = 'http://monitor.example/private'; url.fire('input'); h.node('save').click();
    expect(url.getAttribute('aria-invalid')).toBe('true'); expect(h.node('feedback').textContent).toBe(warning);
    h.node('discard').click(); expect(url.value).toBe(''); expect(url.getAttribute('aria-invalid')).toBeNull();
    expect(h.node('url-error').textContent).toBe(''); expect(h.node('feedback').textContent).toBe(warning);
    expect(h.save).toHaveBeenCalledTimes(1);
  });

  it('tracks actual edits and clears the pending indicator when values are reverted', async () => {
    const h = await setup(configured);
    expect(h.node('draft-status').textContent).toBe('No unsaved monitor changes.'); expect(h.node('discard').disabled).toBe(true);
    h.node('enabled').checked = false; h.node('enabled').fire('change');
    expect(h.node('draft-status').textContent).toBe('Unsaved monitor changes.'); expect(h.node('discard').disabled).toBe(false);
    h.node('enabled').checked = true; h.node('enabled').fire('change'); expect(h.node('discard').disabled).toBe(true);
    h.node('url').value = 'https://draft.example/token'; h.node('url').fire('input'); expect(h.node('discard').disabled).toBe(false);
    h.node('url').value = ''; h.node('url').fire('input'); await h.mount.refresh();
    expect(h.node('draft-status').textContent).toBe('No unsaved monitor changes.'); expect(h.node('discard').disabled).toBe(true);
    expect(h.save).not.toHaveBeenCalled();
  });

  it('discards to the latest confirmed checkbox value and clears the write-only draft without a write', async () => {
    const h = await setup(configured), url = h.node('url'), enabled = h.node('enabled');
    h.current({ ...configured, enabled: false, state: 'paused' }); await h.mount.refresh(); expect(enabled.checked).toBe(false);
    enabled.checked = true; enabled.fire('change'); url.value = 'https://draft.example/replacement'; url.fire('input'); h.node('discard').click();
    expect(enabled.checked).toBe(false); expect(url.value).toBe(''); expect(enabled.focused).toBe(true);
    expect(h.node('url')).toBe(url); expect(h.node('enabled')).toBe(enabled); expect(h.node('discard').disabled).toBe(true);
    expect(h.node('draft-status').textContent).toBe('No unsaved monitor changes.'); expect(h.save).not.toHaveBeenCalled();
    expect(h.root.textContent).not.toContain('https://draft.example/replacement');
  });

  it('can discard after a failed read without treating cached settings as fresh proof', async () => {
    const h = await setup(configured); h.node('enabled').checked = false; h.node('enabled').fire('change');
    h.node('url').value = 'https://draft.example/token'; h.node('url').fire('input');
    h.get.mockRejectedValueOnce(new Error('private read failure')); await h.mount.refresh();
    expect(h.node('discard').disabled).toBe(false); h.node('discard').click();
    expect(h.node('enabled').checked).toBe(true); expect(h.node('url').value).toBe('');
    expect(h.node('save').disabled).toBe(true); expect(h.node('status').textContent).toContain('could not be confirmed');
    expect(h.save).not.toHaveBeenCalled(); expect(h.root.textContent).not.toContain('private read failure');
  });

  it('preserves a newer checkbox edit during save while clearing the confirmed URL', async () => {
    const h = await setup(); let finish!: (value: BackupWatchdogStatus) => void;
    h.save.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    h.node('enabled').checked = true; h.node('enabled').fire('change'); h.node('url').value = 'https://draft.example/submitted'; h.node('url').fire('input'); h.node('save').click();
    h.node('enabled').checked = false; h.node('enabled').fire('change'); expect(h.node('discard').disabled).toBe(true);
    h.node('discard').click(); expect(h.node('url').value).toBe('https://draft.example/submitted');
    h.current(configured); finish(configured);
    await vi.waitFor(() => expect(h.node('save').disabled).toBe(false));
    expect(h.node('enabled').checked).toBe(false); expect(h.node('url').value).toBe(''); expect(h.node('discard').disabled).toBe(false);
    expect(h.node('feedback').textContent).toContain('newer edits'); h.node('discard').click();
    expect(h.node('enabled').checked).toBe(true); expect(h.node('feedback').textContent).not.toContain('newer edits');
    expect(h.node('draft-status').textContent).toBe('No unsaved monitor changes.'); expect(h.save).toHaveBeenCalledTimes(1);
  });

  it('clears a confirmed URL when edits return to the submitted value during save', async () => {
    const h = await setup(); let finish!: (value: BackupWatchdogStatus) => void;
    h.save.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    h.node('enabled').checked = true; h.node('enabled').fire('change'); h.node('url').value = 'https://draft.example/submitted'; h.node('url').fire('input'); h.node('save').click();
    h.node('url').value = 'https://draft.example/other'; h.node('url').fire('input');
    h.node('url').value = 'https://draft.example/submitted'; h.node('url').fire('input'); h.current(configured); finish(configured);
    await vi.waitFor(() => expect(h.node('save').disabled).toBe(false));
    expect(h.node('url').value).toBe(''); expect(h.node('discard').disabled).toBe(true);
    expect(h.node('feedback').textContent).not.toContain('newer edits'); expect(h.save).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('removal adopts the confirmed disabled value and preserves only a newer URL draft (%s)', async newer => {
    const h = await setup(configured); let finish!: (value: BackupWatchdogStatus) => void;
    h.node('url').value = 'https://draft.example/old'; h.node('url').fire('input');
    h.save.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); h.node('remove').click();
    if (newer) { h.node('url').value = 'https://draft.example/new'; h.node('url').fire('input'); }
    h.current(initial); finish(initial); await vi.waitFor(() => expect(h.node('save').disabled).toBe(false));
    expect(h.node('enabled').checked).toBe(false); expect(h.node('url').value).toBe(newer ? 'https://draft.example/new' : '');
    expect(h.node('discard').disabled).toBe(!newer); expect(h.node('feedback').textContent).toContain('Monitor removed.');
    expect(h.save).toHaveBeenCalledExactlyOnceWith({ enabled: false, forget: true });
  });

  it('keeps an uncertain write warning when its local replacement draft is discarded', async () => {
    const h = await setup(configured); h.node('url').value = 'https://draft.example/uncertain'; h.node('url').fire('input');
    h.save.mockImplementationOnce(async () => { throw new Error('private uncertain write'); }); h.node('save').click();
    await vi.waitFor(() => expect(h.node('feedback').textContent).toContain('could not be confirmed'));
    await vi.waitFor(() => expect(h.node('save').disabled).toBe(false));
    const warning = h.node('feedback').textContent; expect(h.node('url').value).toBe('https://draft.example/uncertain');
    h.node('discard').click(); expect(h.node('url').value).toBe(''); expect(h.node('feedback').textContent).toBe(warning);
    expect(h.node('draft-status').textContent).toBe('No unsaved monitor changes.'); expect(h.save).toHaveBeenCalledTimes(1);
  });

  it('updates an untouched checkbox independently of a replacement URL and clears obsolete local validation', async () => {
    const h = await setup(); h.node('enabled').checked = true; h.node('enabled').fire('change'); h.node('save').click();
    expect(h.node('url-error').textContent).toContain('Enter the monitor success-ping URL');
    h.current(configured); await h.mount.refresh(); expect(h.node('url-error').textContent).toBe('');
    expect(h.node('url').getAttribute('aria-invalid')).toBeNull();
    h.node('url').value = 'https://draft.example/replacement'; h.node('url').fire('input');
    h.current({ ...configured, enabled: false, state: 'paused' }); await h.mount.refresh();
    expect(h.node('enabled').checked).toBe(false); expect(h.node('url').value).toBe('https://draft.example/replacement');
    expect(h.node('discard').disabled).toBe(false); h.node('discard').click(); expect(h.node('enabled').checked).toBe(false);
    expect(h.save).not.toHaveBeenCalled();
  });

  it('requires one explicit URL, clears it only after confirmation and supports disable/forget without returning it', async () => {
    const h = await setup(); expect(h.root.textContent).toContain('another host'); expect(h.root.textContent).toContain('Your recovery key is not needed');
    h.node('enabled').checked = true; h.node('save').click(); expect(h.save).not.toHaveBeenCalled();
    h.node('url').value = 'https://monitor.example/private-token'; h.node('url').fire('input'); h.node('save').click();
    expect(h.save).toHaveBeenCalledExactlyOnceWith({ enabled: true, ping_url: 'https://monitor.example/private-token' });
    await vi.waitFor(() => expect(h.node('feedback').textContent).toContain('setup saved')); expect(h.node('url').value).toBe('');
    h.node('enabled').checked = false; h.node('save').click(); await vi.waitFor(() => expect(h.save).toHaveBeenCalledTimes(2));
    expect(h.save).toHaveBeenLastCalledWith({ enabled: false });
    await vi.waitFor(() => expect(h.node('save').disabled).toBe(false)); h.node('remove').click();
    await vi.waitFor(() => expect(h.node('feedback').textContent).toContain('Monitor removed'));
    expect(h.save).toHaveBeenLastCalledWith({ enabled: false, forget: true }); expect(h.node('remove').disabled).toBe(true);
  });

  it('preserves draft URL, nodes and focus across polling and read failures, while clearing stale acknowledgment claims', async () => {
    const h = await setup(), input = h.node('url'); input.value = 'https://draft.example/new-token'; input.fire('input'); input.focus();
    h.node('enabled').checked = true; h.node('enabled').fire('change'); h.current(configured); await h.mount.refresh();
    expect(h.node('url')).toBe(input); expect(input.focused).toBe(true); expect(input.value).toBe('https://draft.example/new-token');
    expect(h.node('receipt').textContent).toContain('acknowledgment');
    h.get.mockRejectedValueOnce(new Error('private endpoint URL')); await h.mount.refresh();
    expect(h.node('receipt').textContent).toBe(''); expect(h.node('save').disabled).toBe(true); expect(input.value).toBe('https://draft.example/new-token');
    expect(h.root.textContent).not.toContain('private endpoint URL'); await h.mount.refresh(); expect(h.node('save').disabled).toBe(false);
  });

  it('fences a stale poll and preserves a newer URL edited during a save', async () => {
    const h = await setup(); let readReply = (_: BackupWatchdogStatus) => {}, saveReply = (_: BackupWatchdogStatus) => {};
    h.get.mockImplementationOnce(() => new Promise(resolve => { readReply = resolve; }));
    h.save.mockImplementationOnce(() => new Promise(resolve => { saveReply = resolve; }));
    const reading = h.mount.refresh(); h.node('enabled').checked = true; h.node('url').value = 'https://first.example/token'; h.node('url').fire('input'); h.node('save').click();
    h.node('url').value = 'https://newer.example/token'; h.node('url').fire('input'); h.current(configured); saveReply(configured);
    await vi.waitFor(() => expect(h.node('feedback').textContent).toContain('newer edits'));
    readReply(initial); await reading; expect(h.node('url').value).toBe('https://newer.example/token'); expect(h.node('enabled').checked).toBe(true);
    expect(h.node('status').textContent).toContain('last ping was acknowledged');
  });

  it('preserves the secret draft after an uncertain save and refreshes the write-only status before another gesture', async () => {
    const h = await setup(); h.node('enabled').checked = true; h.node('url').value = 'https://monitor.example/token'; h.node('url').fire('input');
    h.save.mockImplementationOnce(async () => { h.current(configured); throw new Error('https://private.example/token'); }); h.node('save').click();
    await vi.waitFor(() => expect(h.node('feedback').textContent).toContain('could not be confirmed'));
    await vi.waitFor(() => expect(h.node('save').disabled).toBe(false));
    expect(h.node('url').value).toBe('https://monitor.example/token'); expect(h.save).toHaveBeenCalledTimes(1);
    expect(h.root.textContent).not.toContain('private.example');
  });

  it('clears the credential on disposal and rejects late replies', async () => {
    const h = await setup(); let reply = (_: BackupWatchdogStatus) => {};
    h.get.mockImplementationOnce(() => new Promise(resolve => { reply = resolve; }));
    const reading = h.mount.refresh(); h.node('url').value = 'https://draft.example/token'; h.mount.dispose();
    reply(configured); await reading; expect(h.node('url').value).toBe(''); expect(h.node('save').disabled).toBe(true); expect(h.node('receipt').textContent).toBe('');
  });

  it('keeps monitor reads independent from unavailable remote history', async () => {
    const { root, document } = pickerTestDom();
    const mounted = mountRemoteBackups({ host: root as unknown as HTMLElement, document, onRestore: () => false, ports: {
      destinations: async () => ({ destinations: [] }), list: async () => { throw new Error('private history'); },
      check: async () => { throw new Error('unused'); }, retrieve: async () => { throw new Error('unused'); },
      watchdog: { get: async () => configured, save: async () => configured },
    } }); disposals.push(() => mounted.dispose());
    await vi.waitFor(() => expect(root.textContent).toContain('last ping was acknowledged')); expect(root.textContent).not.toContain('private history');
  });
});
