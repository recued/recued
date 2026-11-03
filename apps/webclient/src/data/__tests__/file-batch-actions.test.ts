import { describe, expect, it, vi } from 'vitest';
import type { FileAttachmentSelection, FileLifecycleMutation, FileLifecyclePreview } from '@recued/contracts';
import { createFileBatchActions, FILE_BATCH_LIMIT } from '../file-batch-actions.js';

const file = (index: number): FileAttachmentSelection => ({ file_id: `file:${index.toString(16).padStart(32, '0')}`,
  filename: `File ${index}.pdf`, mime_type: 'application/pdf', media_class: 'document', size: 10, selection_revision: 'selected' });
const rig = (count = 3, archived = false) => {
  let files = Array.from({ length: count }, (_, i) => file(i + 1)), active = true, ready = true;
  const stored = new Map<string, FileLifecyclePreview>(files.map(row => [row.file_id, { record_id: row.file_id,
    filename: row.filename, revision: 'reviewed', archived, deleted: false, can_restore: archived,
    message_count: 2, conversation_count: 1, queued_count: 0, delivery_count: 0, in_use: false, usages: [], usages_truncated: false }]));
  const usage = vi.fn(async ({ record_id }: { record_id: string }) => {
    const value = stored.get(record_id); if (!value) throw new Error('File unavailable'); return { ...value };
  });
  const mutate = vi.fn(async (input: FileLifecycleMutation) => {
    const value = stored.get(input.record_id)!;
    if (value.revision !== input.revision) throw new Error('File usage changed. Review again.');
    const next = { ...value, archived: input.action === 'archive', can_restore: input.action === 'archive', revision: value.revision + ':changed' };
    stored.set(input.record_id, next); return { ...next };
  });
  const c = createFileBatchActions({ files: () => files, archived: () => archived, active: () => active, ready: () => ready,
    usage, mutate, changed: vi.fn(), confirmed: id => { files = files.filter(row => row.file_id !== id); } });
  const command = async (key: string) => { c.handleAction('file-batch-' + key); await c.whenSettled(); };
  return { c, command, stored, usage, mutate, visible: (rows: FileAttachmentSelection[]) => { files = rows; },
    active: (value: boolean) => { active = value; }, ready: (value: boolean) => { ready = value; } };
};

describe('reviewed saved-file batches', () => {
  it('reviews only selected, still-shown local files and bounds one batch without writing before confirmation', async () => {
    const r = rig(FILE_BATCH_LIMIT + 5);
    r.c.handleAction('file-batch-all'); await r.command('review');
    expect(r.usage).toHaveBeenCalledTimes(FILE_BATCH_LIMIT); expect(r.mutate).not.toHaveBeenCalled();
    await r.command('back'); r.visible([file(2), file(3), { ...file(4), file_id: 'file:remote:provider:id' }]);
    r.ready(false); await r.command('review'); expect(r.usage).toHaveBeenCalledTimes(FILE_BATCH_LIMIT);
    r.ready(true); await r.command('review');
    expect(r.c.snapshot().map(row => row.file.file_id)).toEqual([file(2).file_id, file(3).file_id]);
    r.ready(false); await r.command('confirm'); expect(r.mutate).not.toHaveBeenCalled();
    r.ready(true);
    await r.command('confirm');
    expect(r.mutate.mock.calls.map(([input]) => input.record_id)).toEqual([file(2).file_id, file(3).file_id]);
  });

  it('keeps reviewed revisions and checks historical or lost receipts without resubmitting writes', async () => {
    const r = rig(); const save = r.mutate.getMockImplementation()!;
    r.mutate.mockImplementation(async input => {
      const out = await save(input);
      if (input.record_id === file(1).file_id) r.stored.set(input.record_id, { ...out, archived: false,
        filename: 'Renamed after review.pdf', revision: 'reversed elsewhere' });
      if (input.record_id === file(3).file_id) throw new Error('Reply lost after commit');
      return out;
    });
    r.c.handleAction('file-batch-all'); await r.command('review');
    r.stored.set(file(2).file_id, { ...r.stored.get(file(2).file_id)!, revision: 'changed after review' });
    const first = r.command('confirm'); r.c.handleAction('file-batch-confirm'); await first;
    expect(r.c.snapshot().map(row => row.state)).toEqual(['unconfirmed', 'unconfirmed', 'confirmed']);
    expect(r.c.snapshot()[0]?.file.filename).toBe('Renamed after review.pdf');
    expect(r.c.snapshot()[0]?.preview?.filename).toBe(file(1).filename);
    expect(r.mutate.mock.calls.map(([input]) => input.revision)).toEqual(['reviewed', 'reviewed', 'reviewed']);
    expect(r.stored.get(file(2).file_id)?.archived).toBe(false);
    await r.command('check'); expect(r.mutate).toHaveBeenCalledTimes(3);
    r.stored.set(file(1).file_id, { ...r.stored.get(file(1).file_id)!, archived: true });
    r.stored.set(file(2).file_id, { ...r.stored.get(file(2).file_id)!, archived: true });
    await r.command('check'); expect(r.c.snapshot().every(row => row.state === 'confirmed')).toBe(true);
    expect(r.mutate).toHaveBeenCalledTimes(3);
  });

  it('restores only reviewed, restorable files and leaves unavailable or mismatched previews unchanged', async () => {
    const r = rig(4, true); const read = r.usage.getMockImplementation()!;
    r.stored.set(file(2).file_id, { ...r.stored.get(file(2).file_id)!, can_restore: undefined });
    r.stored.set(file(3).file_id, { ...r.stored.get(file(3).file_id)!, deleted: true, can_restore: false });
    r.usage.mockImplementation(async input => input.record_id === file(4).file_id
      ? { ...await read(input), record_id: file(1).file_id } : read(input));
    r.c.handleAction('file-batch-all'); await r.command('review');
    expect(r.c.snapshot().map(row => row.state)).toEqual(['ready', 'skipped', 'skipped', 'failed']);
    await r.command('confirm');
    expect(r.mutate).toHaveBeenCalledExactlyOnceWith({ record_id: file(1).file_id, action: 'restore', revision: 'reviewed' });
    expect(r.stored.get(file(1).file_id)?.archived).toBe(false);
  });

  it('stops before the next file, keeps unread outcomes unconfirmed and retires disposed reviews before any write', async () => {
    const r = rig(2); const read = r.usage.getMockImplementation()!;
    r.c.handleAction('file-batch-all'); await r.command('review');
    let release!: () => void;
    r.mutate.mockImplementationOnce(() => new Promise((_resolve, reject) => { release = () => reject(new Error('Lost response')); }));
    r.usage.mockRejectedValueOnce(new Error('Read unavailable'));
    const pending = r.command('confirm'); await vi.waitFor(() => expect(r.mutate).toHaveBeenCalledTimes(1));
    r.c.handleAction('file-batch-confirm'); r.c.handleAction('file-batch-check');
    let applied = false;
    const applying = r.c.whenSettled().then(() => { applied = true; });
    await Promise.resolve(); expect(applied).toBe(false);
    r.c.handleAction('file-batch-stop'); release(); await pending;
    await applying; expect(applied).toBe(true);
    expect(r.c.snapshot().map(row => row.state)).toEqual(['unconfirmed', 'skipped']);
    r.usage.mockImplementation(read); await r.command('check'); expect(r.mutate).toHaveBeenCalledTimes(1);
    const retired = rig(); let answer!: (value: FileLifecyclePreview) => void;
    retired.usage.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    retired.c.handleAction('file-batch-all'); const review = retired.command('review');
    retired.c.handleAction('file-batch-review');
    let reviewed = false;
    const reading = retired.c.whenSettled().then(() => { reviewed = true; });
    await Promise.resolve(); expect(reviewed).toBe(false);
    retired.c.dispose();
    answer(retired.stored.get(file(1).file_id)!); await review; retired.c.handleAction('file-batch-confirm');
    await reading; expect(reviewed).toBe(true);
    expect(retired.mutate).not.toHaveBeenCalled(); expect(retired.usage).toHaveBeenCalledTimes(1);
  });
});
