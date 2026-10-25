import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BackupWatchdogDrill, BackupWatchdogStatus } from '@recued/contracts';
import { mountBackupWatchdog, type BackupWatchdogPorts } from '../settings/backup-watchdog-panel.js';
import { PickerElement } from './helpers/file-download-picker-dom.js';

const epoch = Date.UTC(2026, 9, 21), revision = '11111111-1111-4111-8111-111111111111';
const ready: BackupWatchdogStatus = { configured: true, enabled: true, state: 'acknowledged', configuration_revision: revision, last_acknowledged_at: epoch };
const record = (operation_id: string): BackupWatchdogDrill => ({ operation_id, phase: 'paused', pause_minutes: 10, started_at: epoch, pause_until: epoch + 600_000, current_configuration: true });
const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });
const setup = async () => {
  let focused: Element | undefined;
  class Element extends PickerElement {
    hidden = false;
    override focus(): void { if (focused) focused.focused = false; focused = this; super.focus(); }
  }
  const root = new Element();
  const document = { createElement: () => new Element(), get activeElement() { return focused; }, body: root } as unknown as Document;
  let current = structuredClone(ready);
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
  return { root, document, node, mount, get, save, start, update, begin, current: (value: BackupWatchdogStatus) => { current = value; } };
};

describe('guided monitor drill controls', () => {
  it('re-enables the alert drill when setup edits return to the confirmed values', async () => {
    const h = await setup(), enabled = h.node('enabled'), url = h.node('url');
    enabled.checked = false; enabled.fire('change'); expect(h.node('drill-review').disabled).toBe(true);
    enabled.checked = true; enabled.fire('change'); expect(h.node('drill-review').disabled).toBe(false);
    url.value = 'https://draft.example/replacement'; url.fire('input'); expect(h.node('drill-review').disabled).toBe(true);
    url.value = ''; url.fire('input'); await h.mount.refresh(); expect(h.node('drill-review').disabled).toBe(false);
    expect(h.save).not.toHaveBeenCalled(); expect(h.start).not.toHaveBeenCalled(); expect(h.update).not.toHaveBeenCalled();
  });

  it('moves focus between review and confirmation without starting a drill', async () => {
    const h = await setup(); h.node('drill-duration').value = '15';
    h.node('drill-review').focus(); h.node('drill-review').click();
    expect(h.document.activeElement).toBe(h.node('drill-start'));
    expect(h.node('drill-start').textContent).toContain('15 minutes');
    h.node('drill-back').focus(); h.node('drill-back').click();
    expect(h.document.activeElement).toBe(h.node('drill-review'));
    expect(h.node('drill-duration').value).toBe('15');
    expect(h.start).not.toHaveBeenCalled(); expect(h.update).not.toHaveBeenCalled();
  });

  it('keeps focused confirmation through a poll, then uses status when a new setup invalidates review', async () => {
    const h = await setup(); h.node('drill-review').click(); const confirm = h.node('drill-start');
    await h.mount.refresh(); expect(h.document.activeElement).toBe(confirm); expect(h.node('drill-start')).toBe(confirm);
    h.current({ ...ready, configuration_revision: '22222222-2222-4222-8222-222222222222' }); await h.mount.refresh();
    expect(h.document.activeElement).toBe(h.node('drill-status')); expect(h.node('drill-status').getAttribute('tabindex')).toBe('-1');
    expect(confirm).toHaveProperty('hidden', true); expect(h.start).not.toHaveBeenCalled();
    const url = h.node('url'); url.focus(); url.value = 'https://draft.example/token'; url.fire('input');
    await h.mount.refresh(); expect(h.document.activeElement).toBe(url); expect(url.value).toBe('https://draft.example/token');
  });

  it.each(['review', 'start', 'back', 'duration', 'received', 'cancel'] as const)('keeps focus in the drill when a passive update removes or disables %s', async control => {
    const h = await setup();
    if (control === 'start' || control === 'back') h.node('drill-review').click();
    if (control === 'received' || control === 'cancel') {
      h.current({ ...ready, state: 'drill_paused', drill: record('22345678-1234-4234-8234-123456789abc') }); await h.mount.refresh();
    }
    h.node(`drill-${control}`).focus();
    if (control === 'duration') h.current({ ...ready, state: 'drill_paused', drill: record('22345678-1234-4234-8234-123456789abc') });
    else h.get.mockRejectedValueOnce(new Error('private failed read'));
    await h.mount.refresh();
    expect(h.document.activeElement).toBe(h.node('drill-status'));
    expect(h.root.textContent).not.toContain('private failed read');
    expect(h.start).not.toHaveBeenCalled(); expect(h.update).not.toHaveBeenCalled();
  });

  it('uses status when Go back cannot return to an enabled launch button', async () => {
    const h = await setup(); h.node('drill-review').click();
    h.current({ ...ready, state: 'blocked', issue: 'backup_not_current' }); await h.mount.refresh();
    h.node('drill-back').focus(); h.node('drill-back').click();
    expect(h.node('drill-review').disabled).toBe(true); expect(h.document.activeElement).toBe(h.node('drill-status'));
    expect(h.start).not.toHaveBeenCalled();
  });

  for (const action of ['start', 'confirm_alert', 'cancel'] as const) for (const outcome of ['success', 'failure'] as const) {
    it(`keeps a pending ${action} on status and preserves unrelated focus after its ${outcome} reply`, async () => {
      const h = await setup(); let resolve!: (value: BackupWatchdogStatus) => void, reject!: (error: Error) => void;
      const pending = new Promise<BackupWatchdogStatus>((done, fail) => { resolve = done; reject = fail; });
      let operation_id: string;
      if (action === 'start') {
        h.start.mockImplementationOnce(() => pending); h.node('drill-review').click(); h.node('drill-start').click();
        operation_id = h.start.mock.calls[0]![0].operation_id;
      } else {
        operation_id = '22345678-1234-4234-8234-123456789abc';
        h.current({ ...ready, state: 'drill_paused', drill: record(operation_id) }); await h.mount.refresh();
        h.update.mockImplementationOnce(() => pending);
        const control = h.node(action === 'cancel' ? 'drill-cancel' : 'drill-received'); control.focus(); control.click();
      }
      expect(h.document.activeElement).toBe(h.node('drill-status'));
      expect(h.node('drill-status').textContent).toBe('Updating the monitor alert drill…');
      const url = h.node('url'); url.focus(); url.value = 'https://draft.example/newer-token'; url.fire('input');
      const applied: BackupWatchdogStatus = action === 'start' ? { ...ready, state: 'drill_paused', drill: record(operation_id) }
        : { ...ready, drill: { ...record(operation_id), phase: action === 'cancel' ? 'cancelled' : 'resuming', resumed_at: epoch + 60_000,
          ...(action === 'cancel' ? { finished_at: epoch + 60_000 } : { alert_reported_at: epoch + 60_000 }) } };
      h.current(applied);
      if (outcome === 'success') resolve(applied); else reject(new Error('private uncertain action'));
      await vi.waitFor(() => expect(h.node('feedback').textContent).toContain(outcome === 'success' ? 'Alert drill updated.' : 'could not be confirmed'));
      await vi.waitFor(() => expect(h.node('drill-cancel').disabled).toBe(action === 'cancel'));
      expect(h.document.activeElement).toBe(url); expect(url.value).toBe('https://draft.example/newer-token');
      expect(h.start).toHaveBeenCalledTimes(action === 'start' ? 1 : 0); expect(h.update).toHaveBeenCalledTimes(action === 'start' ? 0 : 1);
      expect(h.root.textContent).not.toContain('private uncertain action');
    });
  }

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
    h.node('drill-cancel').focus(); h.node('drill-cancel').click(); h.node('url').focus();
    const focused = h.document.activeElement;
    h.mount.dispose(); updateReply(ready); await Promise.resolve(); await Promise.resolve();
    expect(h.document.activeElement).toBe(focused);
    expect(h.node('drill-review').disabled).toBe(true); expect(h.node('drill-status').textContent).not.toContain('Drill complete');
  });
});
