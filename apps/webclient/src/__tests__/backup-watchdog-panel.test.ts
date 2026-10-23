import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BackupWatchdogStatus } from '@recued/contracts';
import { mountBackupWatchdog, type BackupWatchdogPorts } from '../settings/backup-watchdog-panel.js';
import { mountRemoteBackups } from '../settings/remote-backups-panel.js';
import { pickerTestDom } from './helpers/file-download-picker-dom.js';

const initial: BackupWatchdogStatus = { configured: false, enabled: false, state: 'not_configured' };
const configured: BackupWatchdogStatus = { configured: true, enabled: true, state: 'acknowledged', last_attempt_at: 100, last_acknowledged_at: 101 };
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });
const setup = async () => {
  const { root, document } = pickerTestDom(); let current = structuredClone(initial);
  const get = vi.fn<BackupWatchdogPorts['get']>(async () => current);
  const save = vi.fn<BackupWatchdogPorts['save']>(async input => {
    current = input.forget ? initial : { configured: current.configured || !!input.ping_url, enabled: input.enabled, state: input.enabled ? 'waiting' : 'paused' };
    return current;
  });
  const mount = mountBackupWatchdog({ host: root as unknown as HTMLElement, document, ports: { get, save } }); disposals.push(() => mount.dispose());
  const node = (name: string) => { const value = root.querySelector(`[data-backup-watchdog-${name}]`); if (!value) throw new Error(name); return value; };
  await vi.waitFor(() => expect(node('save').disabled).toBe(false));
  return { root, document, node, mount, get, save, current: (value: BackupWatchdogStatus) => { current = value; } };
};
describe('offline backup alert setup', () => {
  it('requires one explicit URL, clears it only after confirmation and supports disable/forget without returning it', async () => {
    const h = await setup(); expect(h.root.textContent).toContain('another host'); expect(h.root.textContent).toContain('No recovery words');
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
