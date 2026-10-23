import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BackupWatchdogDrill, BackupWatchdogStatus } from '@recued/contracts';
import { mountBackupWatchdog, type BackupWatchdogPorts } from '../settings/backup-watchdog-panel.js';
import { pickerTestDom } from './helpers/file-download-picker-dom.js';

const epoch = Date.UTC(2026, 9, 21), revision = '11111111-1111-4111-8111-111111111111';
const ready: BackupWatchdogStatus = { configured: true, enabled: true, state: 'acknowledged', configuration_revision: revision, last_acknowledged_at: epoch };
const record = (operation_id: string): BackupWatchdogDrill => ({ operation_id, phase: 'paused', pause_minutes: 10, started_at: epoch, pause_until: epoch + 600_000, current_configuration: true });
const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });
const setup = async () => {
  const { root, document } = pickerTestDom(); let current = structuredClone(ready);
  const get = vi.fn<BackupWatchdogPorts['get']>(async () => structuredClone(current));
  const save = vi.fn<BackupWatchdogPorts['save']>(async () => current);
  const start = vi.fn<NonNullable<BackupWatchdogPorts['drill']>['start']>(async input => {
    current = { ...ready, state: 'drill_paused', configuration_revision: '22222222-2222-4222-8222-222222222222', drill: { ...record(input.operation_id), pause_minutes: input.pause_minutes, pause_until: epoch + input.pause_minutes * 60_000 } }; return current;
  });
  const update = vi.fn<NonNullable<BackupWatchdogPorts['drill']>['update']>(async input => {
    if (!current.drill) throw new Error('missing fixture');
    current = { ...current, state: 'acknowledged', drill: { ...current.drill, phase: input.action === 'cancel' ? 'cancelled' : 'resuming', resumed_at: epoch + 60_000,
      ...(input.action === 'cancel' ? { finished_at: epoch + 60_000 } : { alert_reported_at: epoch + 60_000 }) } }; return current;
  });
  const mount = mountBackupWatchdog({ host: root as unknown as HTMLElement, document, ports: { get, save, drill: { start, update } } }); closes.push(() => mount.dispose());
  const node = (name: string) => { const node = root.querySelector(`[data-backup-watchdog-${name}]`); if (!node) throw new Error(name); return node; };
  await vi.waitFor(() => expect(node('drill-review').disabled).toBe(false));
  const begin = () => { node('drill-review').click(); node('drill-start').click(); };
  return { root, node, mount, get, save, start, update, begin, current: (value: BackupWatchdogStatus) => { current = value; } };
};

describe('guided monitor drill controls', () => {
  it('requires a review gesture and passes a bounded duration and current revision, then awaits both completion facts', async () => {
    const h = await setup(); h.node('drill-start').click(); expect(h.start).not.toHaveBeenCalled();
    h.node('drill-duration').value = '15'; h.node('drill-review').click();
    expect(h.node('drill-start').textContent).toContain('15 minutes'); h.node('drill-start').click();
    await vi.waitFor(() => expect(h.node('drill-status').textContent).toContain('Pings are paused until'));
    expect(h.start).toHaveBeenCalledExactlyOnceWith({ operation_id: expect.any(String), configuration_revision: revision, pause_minutes: 15 });
    expect(h.node('drill-facts').textContent).toContain('not confirmed by you'); expect(h.node('drill-facts').textContent).toContain('not acknowledged yet');
    h.node('drill-received').click(); await vi.waitFor(() => expect(h.node('drill-status').textContent).toContain('Waiting for an eligible ping'));
    expect(h.node('drill-facts').textContent).toContain('you reported receiving'); expect(h.node('drill-status').textContent).not.toContain('Drill complete');
    const operation_id = h.start.mock.calls[0]![0].operation_id;
    h.current({ ...ready, drill: { ...record(operation_id), phase: 'completed', resumed_at: epoch + 60_000, alert_reported_at: epoch + 60_000, ping_acknowledged_at: epoch + 120_000, finished_at: epoch + 120_000 } });
    await h.mount.refresh(); expect(h.node('drill-status').textContent).toContain('Drill complete'); expect(h.update).toHaveBeenCalledExactlyOnceWith({ operation_id, action: 'confirm_alert' });
  });

  it('preserves draft URL and focus during updates, clears stale drill claims on a failed read, and never retries an uncertain start', async () => {
    const h = await setup(); h.start.mockImplementationOnce(async input => {
      h.current({ ...ready, state: 'drill_paused', drill: record(input.operation_id) }); throw new Error('private endpoint');
    }); h.begin();
    await vi.waitFor(() => expect(h.node('feedback').textContent).toContain('could not be confirmed'));
    await vi.waitFor(() => expect(h.node('drill-cancel').disabled).toBe(false));
    expect(h.start).toHaveBeenCalledTimes(1);
    const url = h.node('url'); url.value = 'https://draft.example/private'; url.fire('input'); url.focus();
    h.node('drill-cancel').click(); await vi.waitFor(() => expect(h.node('drill-status').textContent).toContain('without a completed alert test'));
    expect(url.value).toBe('https://draft.example/private'); expect(url.focused).toBe(true); expect(h.node('url')).toBe(url);
    h.get.mockRejectedValueOnce(new Error('private')); await h.mount.refresh();
    expect(h.node('drill-status').textContent).toContain('could not be confirmed'); expect(h.node('drill-facts').textContent).toBe('');
    expect(h.node('drill-cancel').disabled).toBe(true); expect(h.root.textContent).not.toContain('private endpoint'); expect(h.start).toHaveBeenCalledTimes(1);
  });

  it('invalidates a review when setup is edited or replaced, and never attributes old drill success to the new setup', async () => {
    const h = await setup(); h.node('drill-review').click(); h.node('url').value = 'https://draft.example/token'; h.node('url').fire('input');
    h.node('drill-start').click(); expect(h.start).not.toHaveBeenCalled(); expect(h.node('drill-review').disabled).toBe(true);
    h.current({ ...ready, drill: { ...record('old'), phase: 'completed', resumed_at: epoch, alert_reported_at: epoch, ping_acknowledged_at: epoch, finished_at: epoch, current_configuration: false } });
    await h.mount.refresh(); expect(h.node('drill-status').textContent).toContain('previous monitor setup'); expect(h.node('drill-status').textContent).not.toContain('Drill complete');
  });

  it('fences a pre-start read, refreshes after it settles, and rejects late writes after disposal', async () => {
    const h = await setup(); let readReply = (_: BackupWatchdogStatus) => {};
    h.get.mockImplementationOnce(() => new Promise(resolve => { readReply = resolve; })); const read = h.mount.refresh(); h.begin();
    await vi.waitFor(() => expect(h.node('drill-status').textContent).toContain('Pings are paused until'));
    readReply(ready); await read; await vi.waitFor(() => expect(h.get).toHaveBeenCalledTimes(3));
    expect(h.node('drill-status').textContent).toContain('Pings are paused until');
    let updateReply = (_: BackupWatchdogStatus) => {}; h.update.mockImplementationOnce(() => new Promise(resolve => { updateReply = resolve; }));
    h.node('drill-cancel').click(); h.mount.dispose(); updateReply(ready); await Promise.resolve(); await Promise.resolve();
    expect(h.node('drill-review').disabled).toBe(true); expect(h.node('drill-status').textContent).not.toContain('Drill complete');
  });
});
