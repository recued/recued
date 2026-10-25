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
  let now = 1_700_000_000_000;
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
  const mounted = mountRestoreDrills({ host: root as unknown as HTMLElement, document, ports: { list, start, cancel, cleanup }, now: () => now }); disposals.push(() => mounted.dispose());
  const node = (name: string) => { const control = root.querySelector(`[data-drill-${name}]`); if (!control) throw new Error(name); return control; };
  mounted.choose(backup); await vi.waitFor(() => expect(node('start').disabled).toBe(initial.some(row => !['failed', 'succeeded'].includes(row.state) || row.cleanup_pending)));
  await vi.waitFor(() => expect(node('refresh').getAttribute('aria-busy')).toBe('false'));
  return { root, document, node, mounted, start, list, cancel, cleanup, current: (rows: ArchiveRestoreDrill[]) => { current = rows; }, now: (value: number) => { now = value; } };
};
describe('isolated recovery test panel', () => {
  it('reconciles matching metadata without resetting a draft, errors, focus or request feedback', async () => {
    const h = await setup(), words = h.node('words'); h.node('form').fire('submit');
    const description = words.getAttribute('aria-describedby'); words.value = 'synthetic unsent words';
    const focus = vi.spyOn(words, 'focus'), reads = h.list.mock.calls.length, feedback = h.node('feedback').textContent;
    const updated = { ...structuredClone(backup), keep_last: 8, destination: { ...backup.destination, connection_name: 'renamed storage' } };
    h.mounted.backups([updated]); expect(words.value).toBe('synthetic unsent words'); expect(h.node('words')).toBe(words);
    expect(words.getAttribute('aria-invalid')).toBe('true'); expect(words.getAttribute('aria-describedby')).toBe(description);
    expect(h.node('selected').textContent).toContain('renamed storage'); expect(h.node('feedback').textContent).toBe(feedback);
    expect(focus).not.toHaveBeenCalled(); expect(h.list).toHaveBeenCalledTimes(reads); expect(h.start).not.toHaveBeenCalled();
    updated.sha256 = 'c'.repeat(64); h.mounted.backups([updated]); expect(words.value).toBe(''); expect(words.disabled).toBe(true);
  });

  const staleBackups: Array<[string, ArchiveRemoteBackup[]]> = [
    ['missing', []],
    ['pruning', [{ ...backup, state: 'pruning' }]],
    ['pruned', [{ ...backup, state: 'pruned' }]],
    ['unconfirmed', [{ ...backup, state: 'unconfirmed' }]],
    ['storage', [{ ...backup, destination: { ...backup.destination, destination_id: 'c'.repeat(64) } }]],
    ['object', [{ ...backup, object_key: 'other-archive' }]],
    ['checksum', [{ ...backup, sha256: 'c'.repeat(64) }]],
    ['size', [{ ...backup, bytes: 1001 }]],
    ['missing checksum', [{ ...backup, sha256: undefined }]],
    ['missing size', [{ ...backup, bytes: undefined }]],
  ];
  it.each(staleBackups)('clears a stale %s selection and requires an explicit new choice without replaying', async (_reason, backups) => {
    const h = await setup(), words = h.node('words'); h.node('form').fire('submit');
    words.value = 'synthetic private draft'; const focus = vi.spyOn(h.node('selected'), 'focus');
    Object.defineProperty(h.document, 'activeElement', { get: () => words });
    h.mounted.backups(backups); expect(words.value).toBe(''); expect(words.disabled).toBe(true); expect(h.node('start').disabled).toBe(true);
    expect(words.getAttribute('aria-invalid')).toBeNull(); expect(words.getAttribute('aria-describedby')).toBeNull(); expect(h.node('words-error')).toHaveProperty('hidden', true);
    expect(h.node('feedback').textContent).toBe(''); expect(h.node('selected').textContent).toContain('Saved copies'); expect(focus).toHaveBeenCalledOnce();
    h.mounted.backups([structuredClone(backup)]); await h.mounted.refresh(); h.node('form').fire('submit');
    expect(h.node('start').disabled).toBe(true); expect(words.value).toBe(''); expect(h.start).not.toHaveBeenCalled(); expect(focus).toHaveBeenCalledOnce();
    expect(h.mounted.choose(structuredClone(backup))).toBe(true); expect(words.disabled).toBe(false); expect(h.node('start').disabled).toBe(false);
  });

  it('does not take outside focus when invalidating a selection or accept updates after disposal', async () => {
    const h = await setup(); Object.defineProperty(h.document, 'activeElement', { get: () => h.node('refresh') });
    const focus = vi.spyOn(h.node('selected'), 'focus'); h.node('words').value = 'synthetic private draft'; h.mounted.backups([]);
    expect(focus).not.toHaveBeenCalled(); h.mounted.choose(backup); h.mounted.dispose(); const before = h.root.textContent;
    h.mounted.backups([]); h.mounted.backups([backup]); expect(h.root.textContent).toBe(before); expect(h.node('words').value).toBe('');
  });

  it.each(['invalid_args', 'unknown', 'success'] as const)('keeps selection invalidated when an in-flight start later returns %s', async outcome => {
    const h = await setup(), words = h.node('words'); let resolve!: (row: ArchiveRestoreDrill) => void, reject!: (error: unknown) => void;
    h.start.mockImplementationOnce(() => new Promise((done, fail) => { resolve = done; reject = fail; }));
    words.value = 'synthetic submitted words'; h.node('form').fire('submit'); expect(words.value).toBe('');
    words.value = 'synthetic newer autofill'; words.fire('input'); h.mounted.backups([]);
    const selected = h.node('selected').textContent, focus = vi.spyOn(words, 'focus'); expect(words.value).toBe('');
    if (outcome === 'success') resolve(result(h.start.mock.calls[0]![0]));
    else reject(outcome === 'invalid_args' ? { code: 'invalid_args' } : new Error('private request detail'));
    await vi.waitFor(() => expect(h.node('feedback').textContent).toContain(outcome === 'success' ? 'server is running' : outcome === 'invalid_args' ? 'Choose a verified backup' : 'could not be confirmed'));
    h.mounted.backups([backup]); await h.mounted.refresh();
    expect(h.node('selected').textContent).toBe(selected); expect(words.value).toBe(''); expect(words.disabled).toBe(true); expect(h.node('start').disabled).toBe(true);
    expect(words.getAttribute('aria-invalid')).toBeNull(); expect(focus).not.toHaveBeenCalled(); expect(h.start).toHaveBeenCalledOnce();
    expect(h.root.textContent).not.toContain('private request detail');
  });

  it('preserves a settled unconfirmed request warning when the selected copy disappears', async () => {
    const h = await setup(); h.start.mockRejectedValueOnce(new Error('private request failure'));
    h.node('words').value = 'synthetic submitted words'; h.node('form').fire('submit');
    await vi.waitFor(() => expect(h.node('start').disabled).toBe(false));
    const warning = h.node('feedback').textContent; expect(warning).toContain('could not be confirmed');
    h.node('words').value = 'synthetic unsent words'; h.mounted.backups([]);
    expect(h.node('words').value).toBe(''); expect(h.node('feedback').textContent).toBe(warning); expect(h.node('start').disabled).toBe(true);
    await h.mounted.refresh(); expect(h.node('feedback').textContent).toBe(warning); expect(h.start).toHaveBeenCalledOnce();
  });

  it('preserves the draft when reselecting the same archive and updates display metadata without making requests', async () => {
    const h = await setup(), words = h.node('words'), focus = vi.spyOn(words, 'focus');
    words.value = 'synthetic unsubmitted words'; words.fire('input');
    const feedback = h.node('feedback').textContent, reads = h.list.mock.calls.length;
    const updated = { ...structuredClone(backup), keep_last: 8, verified_at: 4,
      destination: { ...backup.destination, connection_name: 'renamed storage' } };
    expect(h.mounted.choose(updated)).toBe(true); expect(h.mounted.choose(structuredClone(updated))).toBe(true);
    expect(words.value).toBe('synthetic unsubmitted words'); expect(h.node('words')).toBe(words); expect(focus).toHaveBeenCalledTimes(2);
    expect(h.node('feedback').textContent).toBe(feedback); expect(h.node('selected').textContent).toContain('renamed storage');
    expect(h.list).toHaveBeenCalledTimes(reads); expect(h.start).not.toHaveBeenCalled(); expect(h.cancel).not.toHaveBeenCalled(); expect(h.cleanup).not.toHaveBeenCalled();
    updated.sha256 = 'c'.repeat(64); h.mounted.choose(updated);
    expect(words.value).toBe(''); expect(h.node('selected').textContent).toContain(updated.sha256);
  });

  it('keeps the required field error when reselecting the same backup and clears it when corrected', async () => {
    const h = await setup(), words = h.node('words'); h.node('form').fire('submit');
    const description = words.getAttribute('aria-describedby');
    expect(words.getAttribute('aria-invalid')).toBe('true'); h.mounted.choose(structuredClone(backup));
    expect(words.getAttribute('aria-invalid')).toBe('true'); expect(words.getAttribute('aria-describedby')).toBe(description);
    expect(h.node('words-error').textContent).toContain('Enter the backup');
    words.value = 'synthetic corrected words'; words.fire('input');
    expect(words.getAttribute('aria-invalid')).toBeNull(); expect(h.node('words-error')).toHaveProperty('hidden', true); expect(h.start).not.toHaveBeenCalled();
  });

  it('keeps a rejected word error and feedback across reselection until the words are corrected', async () => {
    const h = await setup(), words = h.node('words'); h.start.mockRejectedValueOnce({ code: 'invalid_args' });
    words.value = 'synthetic rejected words'; h.node('form').fire('submit');
    await vi.waitFor(() => expect(h.node('start').disabled).toBe(false));
    const feedback = h.node('feedback').textContent, description = words.getAttribute('aria-describedby');
    expect(feedback).toContain('request was rejected'); h.mounted.choose(structuredClone(backup));
    expect(words.value).toBe(''); expect(words.getAttribute('aria-invalid')).toBe('true'); expect(words.getAttribute('aria-describedby')).toBe(description);
    expect(h.node('feedback').textContent).toBe(feedback); expect(h.node('words-error').textContent).toContain('all 24 words');
    words.value = 'synthetic corrected words'; words.fire('input');
    expect(words.getAttribute('aria-invalid')).toBeNull(); expect(h.node('feedback').textContent).toBe(''); expect(h.start).toHaveBeenCalledOnce();
  });

  it('preserves an uncertain outcome and newer words across reselection without bypassing failed receipt reads or replaying', async () => {
    const h = await setup(), words = h.node('words'); let rejectRead!: (error: Error) => void;
    h.list.mockImplementationOnce(() => new Promise((_done, fail) => { rejectRead = fail; }));
    h.start.mockImplementationOnce(() => { expect(words.value).toBe(''); return Promise.reject(new Error('private transport detail')); });
    words.value = 'synthetic submitted words'; h.node('form').fire('submit');
    await vi.waitFor(() => expect(h.list).toHaveBeenCalledTimes(2));
    const warning = h.node('feedback').textContent; expect(warning).toContain('could not be confirmed');
    words.value = 'synthetic newer draft'; words.fire('input'); h.mounted.choose(structuredClone(backup));
    expect(words.value).toBe('synthetic newer draft'); expect(h.node('feedback').textContent).toBe(warning);
    expect(h.node('start').disabled).toBe(true); h.node('form').fire('submit'); expect(h.start).toHaveBeenCalledOnce();
    rejectRead(new Error('private receipt failure')); await vi.waitFor(() => expect(h.node('refresh-status').textContent).toContain('could not be checked'));
    h.mounted.choose(structuredClone(backup)); expect(h.node('start').disabled).toBe(true); expect(words.value).toBe('synthetic newer draft');
    expect(h.node('feedback').textContent).toBe(warning); h.node('form').fire('submit'); expect(h.start).toHaveBeenCalledOnce();
    await h.mounted.refresh(); h.mounted.choose(structuredClone(backup));
    expect(h.node('start').disabled).toBe(false); expect(words.value).toBe('synthetic newer draft'); expect(h.node('feedback').textContent).toBe(warning);
    expect(h.start).toHaveBeenCalledOnce(); h.node('form').fire('submit');
    expect(words.value).toBe(''); expect(h.start).toHaveBeenCalledTimes(2);
    expect(h.start.mock.calls[1]![0]).toMatchObject({ backup_operation_id: backup.operation_id, recoveryKey: 'synthetic newer draft' });
    expect(h.start.mock.calls[1]![0].operation_id).not.toBe(h.start.mock.calls[0]![0].operation_id);
  });

  it.each([
    ['backup identifier', { ...backup, operation_id: '32345678-1234-4234-8234-123456789abc' }],
    ['storage identity', { ...backup, destination: { ...backup.destination, destination_id: 'c'.repeat(64) } }],
    ['object location', { ...backup, object_key: 'different-archive' }],
    ['checksum', { ...backup, sha256: 'c'.repeat(64) }],
    ['byte count', { ...backup, bytes: 1001 }],
  ] as const)('clears words and validation when the selected %s changes', async (_name, changed) => {
    const h = await setup(), words = h.node('words'); h.node('form').fire('submit');
    expect(words.getAttribute('aria-invalid')).toBe('true'); words.value = 'synthetic unsent words';
    expect(h.mounted.choose(structuredClone(changed))).toBe(true);
    expect(words.value).toBe(''); expect(words.getAttribute('aria-invalid')).toBeNull(); expect(words.getAttribute('aria-describedby')).toBeNull();
    expect(h.node('words-error')).toHaveProperty('hidden', true); expect(h.node('feedback').textContent).toContain('Enter the recovery key');
    expect(h.start).not.toHaveBeenCalled();
  });

  it.each(['sha256', 'bytes'] as const)('clears a draft conservatively when %s is absent from both selected views', async field => {
    const h = await setup(), incomplete = structuredClone(backup); delete incomplete[field];
    h.mounted.choose(incomplete); h.node('words').value = 'synthetic unsent words';
    expect(h.mounted.choose(structuredClone(incomplete))).toBe(true); expect(h.node('words').value).toBe(''); expect(h.start).not.toHaveBeenCalled();
  });

  it('rejects same-backup reselection during dispatch and after disposal', async () => {
    const h = await setup(), words = h.node('words'); let reject!: (error: unknown) => void;
    h.start.mockImplementationOnce(() => new Promise((_done, fail) => { reject = fail; }));
    words.value = 'synthetic submitted words'; h.node('form').fire('submit');
    words.value = 'synthetic newer autofill'; words.fire('input'); const feedback = h.node('feedback').textContent;
    expect(h.mounted.choose(structuredClone(backup))).toBe(false); expect(words.value).toBe('synthetic newer autofill'); expect(h.node('feedback').textContent).toBe(feedback);
    h.mounted.dispose(); const before = h.root.textContent; expect(h.mounted.choose(structuredClone(backup))).toBe(false);
    reject({ code: 'invalid_args' }); await Promise.resolve(); await Promise.resolve();
    expect(words.value).toBe(''); expect(words.disabled).toBe(true); expect(h.root.textContent).toBe(before); expect(h.start).toHaveBeenCalledOnce();
  });

  it.each(['', '   '])('links an empty word error to the field and focuses it without starting a test (%j)', async value => {
    const h = await setup(), words = h.node('words'), focus = vi.spyOn(words, 'focus');
    words.value = value; h.node('form').fire('submit');
    expect(words.value).toBe(''); expect(words.getAttribute('aria-invalid')).toBe('true');
    const error = h.node('words-error');
    expect(error.textContent).toBe('Enter the backup’s 24-word recovery key.'); expect(error).toHaveProperty('hidden', false);
    expect(words.getAttribute('aria-describedby')).toBe(error.id); expect(focus).toHaveBeenCalledOnce(); expect(h.start).not.toHaveBeenCalled();
    words.value = 'corrected synthetic words'; words.fire('input');
    expect(words.getAttribute('aria-invalid')).toBeNull(); expect(words.getAttribute('aria-describedby')).toBeNull();
    expect(error).toHaveProperty('hidden', true); expect(focus).toHaveBeenCalledOnce(); expect(h.start).not.toHaveBeenCalled();
  });

  for (const origin of ['words', 'start']) for (const synchronous of [true, false]) {
    it(`returns a rejected request to enabled words from ${origin} (synchronous: ${synchronous}) while receipt reads still block retry`, async () => {
      const h = await setup(), words = h.node('words');
      Object.defineProperty(h.document, 'activeElement', { get: () => h.node(origin) });
      const focus = vi.spyOn(words, 'focus').mockImplementation(() => { expect(words.disabled).toBe(false); });
      h.list.mockImplementationOnce(() => new Promise(() => {}));
      h.start.mockImplementationOnce(() => {
        expect(words.value).toBe(''); expect(words.disabled).toBe(true);
        const error = { code: 'invalid_args', message: 'private rejected phrase' };
        if (synchronous) throw error;
        return Promise.reject(error);
      });
      words.value = 'synthetic incomplete words'; h.node('form').fire('submit');
      await vi.waitFor(() => expect(focus).toHaveBeenCalledOnce());
      expect(words.getAttribute('aria-invalid')).toBe('true'); expect(words.getAttribute('aria-describedby')).toBe(h.node('words-error').id);
      expect(h.node('start').disabled).toBe(true); expect(h.node('refresh-status').textContent).toContain('Refreshing recovery receipts');
      expect(h.root.textContent).not.toContain('private rejected phrase');
      words.value = 'synthetic corrected words'; words.fire('input');
      expect(words.getAttribute('aria-invalid')).toBeNull(); expect(h.node('words-error')).toHaveProperty('hidden', true);
      expect(h.node('feedback').textContent).toBe(''); h.node('form').fire('submit'); expect(h.start).toHaveBeenCalledOnce();
    });
  }

  it('marks a late rejection without taking focus from another control', async () => {
    const h = await setup(), words = h.node('words'); let active = h.node('start');
    Object.defineProperty(h.document, 'activeElement', { get: () => active });
    const focus = vi.spyOn(words, 'focus'); let reject!: (error: unknown) => void;
    h.start.mockImplementationOnce(() => new Promise((_done, fail) => { reject = fail; }));
    words.value = 'synthetic incomplete words'; h.node('form').fire('submit'); active = h.node('refresh');
    reject({ code: 'invalid_args' });
    await vi.waitFor(() => expect(words.getAttribute('aria-invalid')).toBe('true'));
    expect(focus).not.toHaveBeenCalled(); await h.mounted.refresh();
    expect(words.getAttribute('aria-invalid')).toBe('true'); expect(focus).not.toHaveBeenCalled(); expect(h.start).toHaveBeenCalledOnce();
  });

  it('keeps a newer input draft and focus when an older submission is rejected', async () => {
    const h = await setup(), words = h.node('words');
    Object.defineProperty(h.document, 'activeElement', { get: () => h.node('start') });
    const focus = vi.spyOn(words, 'focus'); let reject!: (error: unknown) => void;
    h.start.mockImplementationOnce(() => new Promise((_done, fail) => { reject = fail; }));
    words.value = 'synthetic submitted words'; h.node('form').fire('submit');
    words.value = 'synthetic newer draft'; words.fire('input'); reject({ code: 'invalid_args' });
    await vi.waitFor(() => expect(h.node('feedback').textContent).toContain('Your newer entry has not been sent.'));
    expect(words.value).toBe('synthetic newer draft'); expect(words.getAttribute('aria-invalid')).toBeNull();
    expect(h.node('words-error')).toHaveProperty('hidden', true); expect(focus).not.toHaveBeenCalled(); expect(h.start).toHaveBeenCalledOnce();
  });

  it('keeps an uncertain-request warning through editing, required validation and receipt refresh', async () => {
    const h = await setup(), words = h.node('words'); h.start.mockRejectedValueOnce(new Error('private transport detail'));
    words.value = 'synthetic submitted words'; h.node('form').fire('submit');
    await vi.waitFor(() => expect(h.node('start').disabled).toBe(false));
    const warning = h.node('feedback').textContent; expect(warning).toContain('could not be confirmed');
    words.value = 'synthetic corrected words'; words.fire('input'); expect(h.node('feedback').textContent).toBe(warning);
    words.value = ''; words.fire('input'); h.node('form').fire('submit');
    expect(words.getAttribute('aria-invalid')).toBe('true'); expect(h.node('feedback').textContent).toBe(warning);
    await h.mounted.refresh(); expect(h.node('feedback').textContent).toBe(warning);
    expect(words.getAttribute('aria-invalid')).toBe('true'); expect(h.start).toHaveBeenCalledOnce();
  });

  it('resets field errors for a new selection and ignores rejected submissions after disposal', async () => {
    const h = await setup(), words = h.node('words'); h.node('form').fire('submit');
    expect(words.getAttribute('aria-invalid')).toBe('true'); words.value = 'synthetic unsent draft';
    h.mounted.choose({ ...backup, operation_id: '32345678-1234-4234-8234-123456789abc' });
    expect(words.value).toBe(''); expect(words.getAttribute('aria-invalid')).toBeNull(); expect(h.node('words-error')).toHaveProperty('hidden', true);
    let reject!: (error: unknown) => void; h.start.mockImplementationOnce(() => new Promise((_done, fail) => { reject = fail; }));
    words.value = 'synthetic submitted words'; h.node('form').fire('submit'); h.mounted.dispose();
    const before = h.root.textContent, focus = vi.spyOn(words, 'focus'); reject({ code: 'invalid_args' });
    await Promise.resolve(); await Promise.resolve(); words.fire('input'); h.node('form').fire('submit');
    expect(h.root.textContent).toBe(before); expect(words.value).toBe(''); expect(words.disabled).toBe(true);
    expect(words.getAttribute('aria-invalid')).toBeNull(); expect(focus).not.toHaveBeenCalled(); expect(h.start).toHaveBeenCalledOnce();
  });

  it('separates failed reads from action feedback and clears the read error on retry without losing drafts', async () => {
    const h = await setup(), words = h.node('words'), selected = h.node('selected').textContent;
    const first = h.node('last-refreshed').getAttribute('datetime'), feedback = h.node('feedback').textContent;
    expect(first).toBe('2023-11-14T22:13:20.000Z'); expect(h.node('empty')).toHaveProperty('hidden', false);
    words.value = 'unsubmitted private draft'; words.focus();
    let reject!: (error: Error) => void;
    h.list.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    h.node('refresh').click(); h.node('refresh').click();
    expect(h.list).toHaveBeenCalledTimes(2); expect(h.node('refresh').disabled).toBe(false);
    expect(h.node('refresh').getAttribute('aria-busy')).toBe('true'); expect(h.node('refresh').getAttribute('aria-disabled')).toBe('true');
    expect(h.node('refresh-status').textContent).toContain('Refreshing recovery receipts…');
    expect(h.node('last-refreshed').getAttribute('datetime')).toBe(first);
    reject(new Error('private provider response'));
    await vi.waitFor(() => expect(h.node('refresh-status').textContent).toContain('Recovery receipts could not be checked.'));
    expect(h.node('feedback').textContent).toBe(feedback); expect(h.node('start').disabled).toBe(true);
    expect(h.node('last-refreshed').getAttribute('datetime')).toBe(first); expect(h.node('empty')).toHaveProperty('hidden', true);
    h.now(1_700_000_002_000); h.node('refresh').click();
    await vi.waitFor(() => expect(h.node('refresh').getAttribute('aria-busy')).toBe('false'));
    expect(h.node('refresh-status').textContent).not.toContain('could not be checked');
    expect(h.node('last-refreshed').getAttribute('datetime')).toBe('2023-11-14T22:13:22.000Z');
    expect(h.node('start').disabled).toBe(false); expect(h.node('feedback').textContent).toBe(feedback);
    expect(h.node('words')).toBe(words); expect(words.value).toBe('unsubmitted private draft'); expect(words.focused).toBe(true);
    expect(h.node('selected').textContent).toBe(selected); expect(h.root.textContent).not.toContain('private provider response');
    expect(h.root.textContent).not.toContain('unsubmitted private draft');
    expect(h.start).not.toHaveBeenCalled(); expect(h.cancel).not.toHaveBeenCalled(); expect(h.cleanup).not.toHaveBeenCalled();
  });

  it.each(['success', 'failure'] as const)('does not fabricate initial freshness or accept a disposed %s read', async outcome => {
    const { root, document } = pickerTestDom();
    const list = vi.fn<RestoreDrillsPorts['list']>().mockRejectedValueOnce(new Error('private initial failure'));
    const mounted = mountRestoreDrills({ host: root as unknown as HTMLElement, document, ports: { list, start: vi.fn(), cancel: vi.fn(), cleanup: vi.fn() } });
    disposals.push(() => mounted.dispose());
    await vi.waitFor(() => expect(root.querySelector('[data-drill-refresh-status]')!.textContent).toContain('could not be checked'));
    expect(root.querySelector('[data-drill-last-refreshed]')).toBeNull();
    let resolve!: (value: { drills: ArchiveRestoreDrill[] }) => void, reject!: (error: Error) => void;
    list.mockImplementationOnce(() => new Promise((done, fail) => { resolve = done; reject = fail; }));
    const reading = mounted.refresh(); mounted.dispose(); const before = root.textContent;
    if (outcome === 'success') resolve({ drills: [] }); else reject(new Error('private late failure'));
    await reading; expect(root.textContent).toBe(before); expect(root.querySelector('[data-drill-last-refreshed]')).toBeNull();
    expect(root.querySelector('[data-drill-refresh]')!.getAttribute('aria-busy')).toBe('false');
  });

  for (const action of ['cancel', 'cleanup'] as const) for (const oldFirst of [true, false]) for (const oldOutcome of ['success', 'failure'] as const) {
    it(`fences a pre-${action} ${oldOutcome} read without stamping it (old first: ${oldFirst})`, async () => {
      const active = result({ operation_id: '22345678-1234-4234-8234-123456789abc', backup_operation_id: backup.operation_id });
      const receipt: ArchiveRestoreDrill = action === 'cancel' ? active : { ...active, state: 'failed', issue: 'cleanup_failed', cleanup_pending: true, finished_at: 2 };
      const h = await setup([receipt]), first = h.node('last-refreshed').getAttribute('datetime');
      let oldResolve!: (value: { drills: ArchiveRestoreDrill[] }) => void, oldReject!: (error: Error) => void;
      let freshResolve!: (value: { drills: ArchiveRestoreDrill[] }) => void, actionResolve!: (value: ArchiveRestoreDrill) => void;
      h.list.mockImplementationOnce(() => new Promise((done, fail) => { oldResolve = done; oldReject = fail; }));
      h.list.mockImplementationOnce(() => new Promise(done => { freshResolve = done; }));
      h[action].mockImplementationOnce(() => new Promise(done => { actionResolve = done; }));
      const reading = h.mounted.refresh(); h.node(action).click();
      const selected = h.node('selected').textContent; h.node('words').value = 'unsubmitted draft';
      const finishOld = async () => {
        h.now(1_700_000_001_000);
        if (oldOutcome === 'success') oldResolve({ drills: [receipt] }); else oldReject(new Error('private stale failure'));
        await reading;
        expect(h.node('last-refreshed').getAttribute('datetime')).toBe(first);
        expect(h.node('refresh-status').textContent).not.toContain('could not be checked');
      };
      if (oldFirst) {
        await finishOld(); expect(h.node('refresh-status').textContent).toContain('Waiting to refresh recovery receipts after the current action.');
      }
      const acknowledged = { ...receipt, ...(action === 'cancel' ? { cancel_requested_at: 3 } : { cleanup_completed_at: 3 }) };
      if (action === 'cleanup') delete acknowledged.cleanup_pending;
      h.current([acknowledged]); actionResolve(acknowledged);
      const message = action === 'cancel' ? 'Cancellation requested.' : 'Temporary files are gone.';
      await vi.waitFor(() => expect(h.node('feedback').textContent).toContain(message));
      if (!oldFirst) await finishOld();
      expect(h.list).toHaveBeenCalledTimes(3); expect(h.node('refresh').getAttribute('aria-busy')).toBe('true');
      expect(h.node('last-refreshed').getAttribute('datetime')).toBe(first);
      h.now(1_700_000_005_000); freshResolve({ drills: [acknowledged] });
      await vi.waitFor(() => expect(h.node('refresh').getAttribute('aria-busy')).toBe('false'));
      expect(h.node('last-refreshed').getAttribute('datetime')).toBe('2023-11-14T22:13:25.000Z');
      expect(h.node('feedback').textContent).toContain(message); expect(h.node('words').value).toBe('unsubmitted draft');
      expect(h.node('selected').textContent).toBe(selected); expect(h.root.textContent).not.toContain('private stale failure');
      expect(h[action]).toHaveBeenCalledTimes(1); expect(h.start).not.toHaveBeenCalled();
    });
  }

  it.each(['success', 'failure'] as const)('waits for an in-flight start and keeps its %s message through a failed receipt read and retry', async outcome => {
    const h = await setup(), first = h.node('last-refreshed').getAttribute('datetime');
    let startResolve!: (value: ArchiveRestoreDrill) => void, startReject!: (error: Error) => void, readReject!: (error: Error) => void;
    h.start.mockImplementationOnce(() => new Promise((done, fail) => { startResolve = done; startReject = fail; }));
    h.list.mockImplementationOnce(() => new Promise((_done, fail) => { readReject = fail; }));
    h.node('words').value = 'synthetic words'; h.node('form').fire('submit');
    expect(h.node('words').value).toBe(''); await h.mounted.refresh(); h.node('refresh').click();
    expect(h.list).toHaveBeenCalledTimes(1); expect(h.node('refresh-status').textContent).toContain('Waiting to refresh recovery receipts');
    h.now(1_700_000_001_000);
    if (outcome === 'success') { const receipt = result(h.start.mock.calls[0]![0]); h.current([receipt]); startResolve(receipt); }
    else startReject(new Error('private uncertain start'));
    await vi.waitFor(() => expect(h.list).toHaveBeenCalledTimes(2));
    const feedback = h.node('feedback').textContent;
    expect(feedback).toContain(outcome === 'success' ? 'server is running the test' : 'could not be confirmed');
    expect(h.node('last-refreshed').getAttribute('datetime')).toBe(first);
    h.node('words').value = 'new unsubmitted draft'; readReject(new Error('private receipt failure'));
    await vi.waitFor(() => expect(h.node('refresh-status').textContent).toContain('could not be checked'));
    expect(h.node('feedback').textContent).toBe(feedback); expect(h.node('last-refreshed').getAttribute('datetime')).toBe(first);
    h.now(1_700_000_003_000); await h.mounted.refresh();
    expect(h.node('refresh-status').textContent).not.toContain('could not be checked');
    expect(h.node('last-refreshed').getAttribute('datetime')).toBe('2023-11-14T22:13:23.000Z');
    expect(h.node('feedback').textContent).toBe(feedback); expect(h.node('words').value).toBe('new unsubmitted draft');
    expect(h.start).toHaveBeenCalledTimes(1); expect(h.root.textContent).not.toContain('private uncertain start');
    expect(h.root.textContent).not.toContain('private receipt failure');
  });

  it('updates the empty-history message independently of selection and action feedback', async () => {
    const h = await setup(), feedback = h.node('feedback').textContent;
    expect(h.node('empty')).toHaveProperty('hidden', false);
    h.current([{ ...result({ operation_id: '22345678-1234-4234-8234-123456789abc', backup_operation_id: backup.operation_id }), state: 'failed', finished_at: 2, issue: 'cancelled' }]);
    await h.mounted.refresh(); expect(h.node('empty')).toHaveProperty('hidden', true); expect(h.node('feedback').textContent).toBe(feedback);
    h.current([]); await h.mounted.refresh(); expect(h.node('empty')).toHaveProperty('hidden', false); expect(h.node('feedback').textContent).toBe(feedback);
  });

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
    expect(h.root.textContent).not.toContain('Recovery receipts could not be checked.');
  });
  it('explains a refused start without showing raw error text or keeping its words', async () => {
    const h = await setup(); h.start.mockRejectedValueOnce({ code: 'invalid_args', message: 'synthetic raw words must not appear' });
    h.node('words').value = 'incomplete words'; h.node('form').fire('submit');
    await vi.waitFor(() => expect(h.node('words').getAttribute('aria-invalid')).toBe('true'));
    expect(h.node('words-error').textContent).toContain('all 24 words of this backup’s recovery key');
    expect(h.node('feedback').textContent).toContain('request was rejected');
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
