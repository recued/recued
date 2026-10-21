import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ArchiveRemoteBackup, ArchiveRestoreDrill } from '@recued/contracts';
import { mountRestoreDrills, type RestoreDrillsPorts } from '../settings/restore-drills-panel.js';
import { mountRemoteBackups } from '../settings/remote-backups-panel.js';
import { pickerTestDom } from './helpers/file-download-picker-dom.js';
const backup: ArchiveRemoteBackup = { operation_id: '12345678-1234-4234-8234-123456789abc', job_id: 'arx-fixture',
  destination: { connection_name: 'safe', destination_id: 'a'.repeat(64), bucket: 'backup-bucket', region: 'us-east-1', endpoint: 'https://s3.example.test', prefix: '' },
  object_key: 'fixture', created_at: 1, state: 'verified', keep_last: 5, sha256: 'b'.repeat(64), bytes: 1000 };
const result = (input: { operation_id: string; backup_operation_id: string }): ArchiveRestoreDrill => ({ operation_id: input.operation_id,
  backup_operation_id: input.backup_operation_id, destination_id: backup.destination.destination_id, archive_sha256: backup.sha256!, archive_bytes: 1000, started_at: 1, state: 'retrieving' });
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); vi.useRealTimers(); });
const setup = async (initial: ArchiveRestoreDrill[] = []) => {
  const { root, document } = pickerTestDom(); let current = initial;
  const list = vi.fn(async () => ({ drills: current }));
  const start = vi.fn<RestoreDrillsPorts['start']>(async input => { const row = result(input); current = [row]; return row; });
  const cancel = vi.fn<RestoreDrillsPorts['cancel']>(async input => {
    const row = { ...current.find(r => r.operation_id === input.operation_id)!, cancel_requested_at: 2 };
    current = current.map(r => r.operation_id === row.operation_id ? row : r); return row;
  });
  const cleanup = vi.fn<RestoreDrillsPorts['cleanup']>(async input => {
    const row = { ...current.find(r => r.operation_id === input.operation_id)!, cleanup_completed_at: 3 };
    delete row.cleanup_pending; current = current.map(r => r.operation_id === row.operation_id ? row : r); return row;
  });
  const mounted = mountRestoreDrills({ host: root as unknown as HTMLElement, document, ports: { list, start, cancel, cleanup } }); disposals.push(() => mounted.dispose());
  const node = (name: string) => { const control = root.querySelector(`[data-drill-${name}]`); if (!control) throw new Error(name); return control; };
  mounted.choose(backup); await vi.waitFor(() => expect(node('start').disabled).toBe(initial.some(row => !['failed', 'succeeded'].includes(row.state) || row.cleanup_pending)));
  return { root, node, mounted, start, list, cancel, cleanup, current: (rows: ArchiveRestoreDrill[]) => { current = rows; } };
};
describe('isolated recovery test panel', () => {
  it('pins the selected backup, clears words before dispatch, and never replays them during polling', async () => {
    const h = await setup(); h.node('words').value = 'synthetic recovery words';
    h.node('form').fire('submit'); expect(h.node('words').value).toBe('');
    expect(h.start).toHaveBeenCalledWith({ operation_id: expect.any(String), backup_operation_id: backup.operation_id, recoveryKey: 'synthetic recovery words' });
    await vi.waitFor(() => expect(h.node('history').textContent).toContain('Reading the remote copy'));
    await h.mounted.refresh(); expect(h.start).toHaveBeenCalledTimes(1); expect(h.node('start').disabled).toBe(true);
    expect(h.node('selected').textContent).toContain(backup.sha256);
  });
  it('shows durable recovery evidence after remount and permits another test only after terminal status', async () => {
    const receipt = result({ operation_id: '22345678-1234-4234-8234-123456789abc', backup_operation_id: backup.operation_id });
    const h = await setup([receipt]); expect(h.node('start').disabled).toBe(true);
    h.current([{ ...receipt, state: 'succeeded', finished_at: 2, checks: { version: 1, server_version: '0.2.0', database_integrity: 'ok',
      foreign_keys: 'ok', local_boot_key: 'ok', database_bytes: 500, restored_blob_records: 3, referenced_blobs: 3, blob_bytes: 45 } }]);
    await h.mounted.refresh();
    expect(h.node('history').textContent).toContain('3 referenced blobs (45 bytes) passed');
    expect(h.node('history').textContent).toContain('Temporary realm removed'); expect(h.node('start').disabled).toBe(false);
  });
  it('preserves an unsubmitted word draft during refresh and clears it when changing selection or leaving', async () => {
    const h = await setup(); h.node('words').value = 'unsubmitted words'; await h.mounted.refresh();
    expect(h.node('words').value).toBe('unsubmitted words');
    h.mounted.choose({ ...backup, operation_id: '32345678-1234-4234-8234-123456789abc' }); expect(h.node('words').value).toBe('');
    h.node('words').value = 'another draft'; h.mounted.dispose(); expect(h.node('words').value).toBe(''); expect(h.node('words').disabled).toBe(true);
  });
  it('does not resend after an uncertain request or let a late reply touch a disposed view', async () => {
    const h = await setup(); h.start.mockRejectedValueOnce(new Error('offline'));
    h.node('words').value = 'synthetic words'; h.node('form').fire('submit');
    await vi.waitFor(() => expect(h.node('feedback').textContent).toContain('could not be confirmed'));
    await h.mounted.refresh(); expect(h.start).toHaveBeenCalledTimes(1); expect(h.node('words').value).toBe('');
    let settle = (_: ArchiveRestoreDrill) => {};
    h.start.mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
    h.node('words').value = 'synthetic words'; h.node('form').fire('submit');
    expect(h.mounted.choose({ ...backup, operation_id: '32345678-1234-4234-8234-123456789abc' })).toBe(false);
    h.mounted.dispose(); const before = h.root.textContent;
    settle(result(h.start.mock.calls[1]![0])); await Promise.resolve(); await Promise.resolve();
    expect(h.root.textContent).toBe(before); expect(h.node('words').value).toBe('');
  });
  it('blocks a start when history is unavailable, displays failures, and recovers on refresh', async () => {
    const receipt = { ...result({ operation_id: '22345678-1234-4234-8234-123456789abc', backup_operation_id: backup.operation_id }), state: 'failed' as const, finished_at: 2, issue: 'cleanup_failed' as const };
    const h = await setup([{ ...receipt, cleanup_pending: true }]); expect(h.node('history').textContent).toContain('failed to remove its temporary realm');
    expect(h.node('start').disabled).toBe(true);
    h.list.mockRejectedValueOnce(new Error('offline')); await h.mounted.refresh();
    expect(h.node('start').disabled).toBe(true);
    h.node('words').value = 'synthetic words'; h.node('form').fire('submit'); expect(h.start).not.toHaveBeenCalled();
    h.current([receipt]); await h.mounted.refresh(); expect(h.node('start').disabled).toBe(false);
  });
  it('explains a refused start without showing raw error text or keeping its words', async () => {
    const h = await setup(); h.start.mockRejectedValueOnce({ code: 'invalid_args', message: 'synthetic raw words must not appear' });
    h.node('words').value = 'incomplete words'; h.node('form').fire('submit');
    await vi.waitFor(() => expect(h.node('feedback').textContent).toContain('complete 24 recovery words'));
    expect(h.node('words').value).toBe(''); expect(h.root.textContent).not.toContain('synthetic raw words'); expect(h.start).toHaveBeenCalledTimes(1);
  });
  it('chooses the exact remote history row without invoking live restore or retrieval', async () => {
    const { root, document } = pickerTestDom(); const onRestore = vi.fn(), retrieve = vi.fn();
    const start = vi.fn<RestoreDrillsPorts['start']>(async input => result(input));
    const mount = mountRemoteBackups({ host: root as unknown as HTMLElement, document, onRestore, ports: {
      destinations: async () => ({ destinations: [backup.destination] }), list: async () => ({ backups: [backup] }),
      check: async () => backup, retrieve, drills: { list: async () => ({ drills: [] }), start, cancel: vi.fn(), cleanup: vi.fn() },
    } }); disposals.push(() => mount.dispose());
    await vi.waitFor(() => expect(root.querySelector('[data-remote-backup-drill]')).not.toBeNull());
    root.querySelector('[data-remote-backup-drill]')!.click();
    await vi.waitFor(() => expect(root.querySelector('[data-drill-start]')!.disabled).toBe(false));
    root.querySelector('[data-drill-words]')!.value = 'synthetic words'; root.querySelector('[data-drill-form]')!.fire('submit');
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ backup_operation_id: backup.operation_id }));
    expect(onRestore).not.toHaveBeenCalled(); expect(retrieve).not.toHaveBeenCalled();
  });

  it('cancels a remounted exact receipt without words or a restart, and never resends the control while polling', async () => {
    const receipt = result({ operation_id: '22345678-1234-4234-8234-123456789abc', backup_operation_id: backup.operation_id });
    const h = await setup([receipt]); h.node('words').value = 'unsubmitted draft';
    const button = h.node('cancel'); button.click(); button.click();
    expect(h.cancel).toHaveBeenCalledExactlyOnceWith({ operation_id: receipt.operation_id }); expect(h.start).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(h.node('history').textContent).toContain('Cancellation requested'));
    await h.mounted.refresh(); expect(h.cancel).toHaveBeenCalledTimes(1); expect(h.node('cancel')).toBe(button);
    expect(button.disabled).toBe(true); expect(h.node('words').value).toBe('unsubmitted draft');
    h.current([{ ...receipt, state: 'failed', issue: 'cancelled', finished_at: 3, cancel_requested_at: 2 }]);
    await h.mounted.refresh(); expect(h.node('start').disabled).toBe(false); expect(h.node('history').textContent).toContain('Recovery test cancelled');
  });

  it('retries pending cleanup without changing the failed verdict or clearing a newer word draft', async () => {
    const receipt: ArchiveRestoreDrill = { ...result({ operation_id: '22345678-1234-4234-8234-123456789abc', backup_operation_id: backup.operation_id }),
      state: 'failed', issue: 'cleanup_failed', cleanup_pending: true, finished_at: 2 };
    const h = await setup([receipt]); h.node('words').value = 'unsubmitted draft'; h.node('cleanup').click();
    expect(h.cleanup).toHaveBeenCalledExactlyOnceWith({ operation_id: receipt.operation_id });
    await vi.waitFor(() => expect(h.node('history').textContent).toContain('test remains failed'));
    await vi.waitFor(() => expect(h.node('start').disabled).toBe(false)); expect(h.node('words').value).toBe('unsubmitted draft');
    expect(h.cancel).not.toHaveBeenCalled(); expect(h.start).not.toHaveBeenCalled();
  });

  it('discards a list reply from before a control and keeps duplicate controls blocked until reconciliation', async () => {
    const receipt = result({ operation_id: '22345678-1234-4234-8234-123456789abc', backup_operation_id: backup.operation_id });
    const h = await setup([receipt]);
    let listReply = (_: { drills: ArchiveRestoreDrill[] }) => {}, cancelReply = (_: ArchiveRestoreDrill) => {};
    h.list.mockImplementationOnce(() => new Promise(resolve => { listReply = resolve; }));
    h.cancel.mockImplementationOnce(() => new Promise(resolve => { cancelReply = resolve; }));
    const refresh = h.mounted.refresh(); h.node('cancel').click();
    listReply({ drills: [receipt] }); await refresh;
    h.node('cancel').click(); expect(h.cancel).toHaveBeenCalledTimes(1); expect(h.node('start').disabled).toBe(true);
    const requested = { ...receipt, cancel_requested_at: 2 }; h.current([requested]); cancelReply(requested);
    await vi.waitFor(() => expect(h.node('history').textContent).toContain('Cancellation requested'));
    await h.mounted.refresh(); expect(h.node('cancel').disabled).toBe(true); expect(h.cancel).toHaveBeenCalledTimes(1);
  });

  it('reconciles an uncertain cancellation without exposing error bodies or automatically repeating it', async () => {
    const receipt = result({ operation_id: '22345678-1234-4234-8234-123456789abc', backup_operation_id: backup.operation_id });
    const h = await setup([receipt]);
    h.cancel.mockImplementationOnce(async () => { h.current([{ ...receipt, cancel_requested_at: 2 }]); throw new Error('private provider response'); });
    h.node('cancel').click();
    await vi.waitFor(() => expect(h.node('feedback').textContent).toContain('could not be confirmed'));
    await vi.waitFor(() => expect(h.node('history').textContent).toContain('Cancellation requested'));
    expect(h.root.textContent).not.toContain('private provider'); expect(h.cancel).toHaveBeenCalledTimes(1); expect(h.node('cancel').disabled).toBe(true);
  });

  it('shows a finished result when cancellation arrives after the test ended', async () => {
    const receipt = result({ operation_id: '22345678-1234-4234-8234-123456789abc', backup_operation_id: backup.operation_id });
    const done: ArchiveRestoreDrill = { ...receipt, state: 'failed', issue: 'integrity_failed', finished_at: 2 };
    const h = await setup([receipt]);
    h.cancel.mockImplementationOnce(async () => { h.current([done]); return done; });
    h.node('cancel').click(); await vi.waitFor(() => expect(h.node('feedback').textContent).toContain('This test has ended'));
    await vi.waitFor(() => expect(h.node('start').disabled).toBe(false));
    expect(h.node('history').textContent).toContain('referenced blobs failed a check');
    expect(h.node('history').textContent).not.toContain('Cancellation requested');
  });

  it('rejects a cleanup reply for another test and ignores a control reply after disposal', async () => {
    const receipt: ArchiveRestoreDrill = { ...result({ operation_id: '22345678-1234-4234-8234-123456789abc', backup_operation_id: backup.operation_id }),
      state: 'failed', issue: 'cleanup_failed', cleanup_pending: true, finished_at: 2 };
    const h = await setup([receipt]); h.cleanup.mockResolvedValueOnce({ ...receipt, operation_id: '32345678-1234-4234-8234-123456789abc' });
    h.node('cleanup').click(); await vi.waitFor(() => expect(h.node('feedback').textContent).toContain('could not be confirmed'));
    await h.mounted.refresh(); expect(h.node('start').disabled).toBe(true);
    let reply = (_: ArchiveRestoreDrill) => {};
    h.cleanup.mockImplementationOnce(() => new Promise(resolve => { reply = resolve; }));
    h.node('cleanup').click(); h.mounted.dispose(); const before = h.root.textContent;
    reply({ ...receipt, cleanup_pending: undefined, cleanup_completed_at: 3 }); await Promise.resolve(); await Promise.resolve();
    expect(h.root.textContent).toBe(before); expect(h.cleanup).toHaveBeenCalledTimes(2);
  });
});
