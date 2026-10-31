import { describe, expect, it, vi } from 'vitest';
import type { FileAttachmentListResult, FileAttachmentSelection } from '@recued/contracts';
import { createSavedFileBrowser, renderSavedFileSearch, type SavedFileListCaller } from '../saved-file-browser.js';

const file = (id: string): FileAttachmentSelection => ({ file_id: id, filename: `${id}.pdf`, mime_type: 'application/pdf',
  media_class: 'document', size: 10, selection_revision: 'a'.repeat(64) });
const page = (ids: string[], cursor?: string): FileAttachmentListResult => ({ files: ids.map(file), ...(cursor ? { next_cursor: cursor } : {}) });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

describe('saved-file browser read ownership', () => {
  it('pages confirmed search and archive filters, deduplicates overlaps and refuses concurrent page walks', async () => {
    const next = deferred<FileAttachmentListResult>();
    const list = vi.fn<SavedFileListCaller>().mockResolvedValueOnce(page(['one'], 'next')).mockReturnValueOnce(next.promise);
    const browser = createSavedFileBrowser(list, () => {});
    await browser.search(' invoice ', true);
    const more = browser.more(); await browser.more();
    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls).toEqual([[{ query: 'invoice', archived: true, limit: 30 }], [{ query: 'invoice', archived: true, cursor: 'next', limit: 30 }]]);
    next.resolve(page(['one', 'older'])); await more;
    expect(browser.snapshot()).toMatchObject({ files: [{ file_id: 'one' }, { file_id: 'older' }], query: 'invoice', archived: true, canLoadMore: false });
  });

  it('a failed page keeps confirmed rows and retries the same cursor without restarting', async () => {
    const list = vi.fn<SavedFileListCaller>().mockResolvedValueOnce(page(['one'], 'next'))
      .mockRejectedValueOnce(new Error('Interrupted')).mockResolvedValueOnce(page(['two']));
    const browser = createSavedFileBrowser(list, () => {});
    await browser.search('', false); await browser.more();
    expect(browser.snapshot()).toMatchObject({ files: [{ file_id: 'one' }], cursor: 'next', error: expect.any(String) });
    await browser.retry();
    expect(list.mock.calls[2]).toEqual(list.mock.calls[1]);
    expect(browser.snapshot()).toMatchObject({ files: [{ file_id: 'one' }, { file_id: 'two' }], error: undefined, loading: false });
  });

  it('a failed replacement keeps the old scope label and cannot page it under the unanswered filters', async () => {
    const list = vi.fn<SavedFileListCaller>().mockResolvedValueOnce(page(['one'], 'old'))
      .mockRejectedValueOnce(new Error('Interrupted')).mockResolvedValueOnce(page(['new']));
    const browser = createSavedFileBrowser(list, () => {});
    await browser.search('old', false); await browser.search('new', true);
    expect(browser.snapshot()).toMatchObject({ query: 'old', archived: false, files: [{ file_id: 'one' }], canLoadMore: false });
    expect(renderSavedFileSearch(browser.snapshot(), 'new', 'data-action')).toContain('for “old”');
    await browser.more(); expect(list).toHaveBeenCalledTimes(2);
    await browser.retry(); expect(list.mock.calls[2]).toEqual([{ query: 'new', archived: true, limit: 30 }]);
    expect(browser.snapshot()).toMatchObject({ query: 'new', archived: true, files: [{ file_id: 'new' }] });
  });

  it('new searches supersede a pending first page or append; navigation and disposal retire their replies', async () => {
    const first = deferred<FileAttachmentListResult>(); const append = deferred<FileAttachmentListResult>();
    const retired = deferred<FileAttachmentListResult>(); const disposed = deferred<FileAttachmentListResult>();
    const list = vi.fn<SavedFileListCaller>().mockReturnValueOnce(first.promise).mockResolvedValueOnce(page(['current'], 'next'))
      .mockReturnValueOnce(append.promise).mockResolvedValueOnce(page(['new'])).mockReturnValueOnce(retired.promise).mockReturnValueOnce(disposed.promise);
    const changed = vi.fn(); const browser = createSavedFileBrowser(list, changed);
    const initial = browser.search('', false); await browser.search('current', false);
    first.resolve(page(['wrong'])); await initial;
    expect(browser.snapshot().files.map(f => f.file_id)).toEqual(['current']);
    const more = browser.more(); await browser.search('new', false); append.resolve(page(['wrong'])); await more;
    expect(browser.snapshot().files.map(f => f.file_id)).toEqual(['new']);
    const oldSource = browser.search('away', false); browser.reset(); const paints = changed.mock.calls.length;
    retired.resolve(page(['wrong'])); await oldSource;
    expect(browser.snapshot().files).toEqual([]); expect(changed).toHaveBeenCalledTimes(paints);
    const last = browser.search('closed', false); browser.dispose(); const closedPaints = changed.mock.calls.length;
    disposed.resolve(page(['wrong'])); await last; expect(changed).toHaveBeenCalledTimes(closedPaints);
  });

  it('opening a file cancels an append without losing the confirmed page or its cursor', async () => {
    const pending = deferred<FileAttachmentListResult>();
    const list = vi.fn<SavedFileListCaller>().mockResolvedValueOnce(page(['one'], 'next')).mockReturnValueOnce(pending.promise);
    const browser = createSavedFileBrowser(list, () => {});
    await browser.search('invoice', false); const more = browser.more(); browser.cancel();
    pending.resolve(page(['late'])); await more;
    expect(browser.snapshot()).toMatchObject({ query: 'invoice', files: [{ file_id: 'one' }], cursor: 'next', loading: false, canLoadMore: true });
  });

  it('rejects non-advancing pages and identifies older servers without erasing their confirmed files', async () => {
    const list = vi.fn<SavedFileListCaller>().mockResolvedValueOnce(page(['one'], 'same'))
      .mockResolvedValueOnce(page(['two'], 'same')).mockRejectedValueOnce(Object.assign(new Error('Unknown rpc method'), { code: 'unknown_method' }));
    const browser = createSavedFileBrowser(list, () => {});
    await browser.search('', false); await browser.more();
    expect(browser.snapshot()).toMatchObject({ files: [{ file_id: 'one' }], cursor: 'same', error: expect.any(String) });
    await browser.retry();
    expect(browser.snapshot()).toMatchObject({ unsupported: true, files: [{ file_id: 'one' }], canLoadMore: false });
    expect(renderSavedFileSearch(browser.snapshot(), '', 'data-action')).toContain('Update your Recued server');
  });

  it('keeps older-server fallback active after a failed capability check until a page succeeds', async () => {
    const list = vi.fn<SavedFileListCaller>()
      .mockRejectedValueOnce(Object.assign(new Error('Unknown rpc method'), { code: 'unknown_method' }))
      .mockRejectedValueOnce(new Error('Connection interrupted')).mockResolvedValueOnce(page(['upgraded']));
    const browser = createSavedFileBrowser(list, () => {});
    await browser.search('', false);
    expect(browser.snapshot()).toMatchObject({ unsupported: true, pages: 0 });
    await browser.search('', false);
    expect(browser.snapshot()).toMatchObject({ unsupported: true, error: expect.any(String), pages: 0 });
    await browser.retry();
    expect(browser.snapshot()).toMatchObject({ unsupported: false, error: undefined, files: [{ file_id: 'upgraded' }], pages: 1 });
  });
});
