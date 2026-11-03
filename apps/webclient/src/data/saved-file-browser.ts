import type { CollectionRecord, FileAttachmentListRequest, FileAttachmentListResult, FileAttachmentSelection } from '@recued/contracts';
import { classifyRpcError, humanizeRpcError } from '../shell/rpc-error-copy.js';
import { e } from '@recued/ui-shared';

export type SavedFileListCaller = (args: FileAttachmentListRequest) => Promise<FileAttachmentListResult>;
export const SAVED_FILE_PAGE_SIZE = 30;

/** List metadata only. Opening a row still reads its complete collection record;
 * these placeholders never supply the detail's timestamps or provenance. */
export const savedFileRecord = (file: FileAttachmentSelection): CollectionRecord => ({
  record_id: file.file_id, source_id: file.file_id, received_at: 0, modified_at: 0, size_bytes: file.size,
  hot_fields: { filename: file.filename, mime_type: file.mime_type, size: file.size, media_class: file.media_class },
});

type Attempt = { query: string; archived: boolean; cursor?: string };

/** A page belongs to its confirmed filters. A failed replacement keeps that
 * page, with its old filter label; it must never look like results for new text. */
export const createSavedFileBrowser = (list: SavedFileListCaller | undefined, changed: () => void) => {
  let generation = 0;
  let disposed = false;
  let files: FileAttachmentSelection[] = [];
  let query = '';
  let archived = false;
  let cursor: string | undefined;
  let pages = 0;
  let loading = false;
  let failed: Attempt | undefined;
  let error: string | undefined;
  let unsupported = false;
  const snapshot = () => ({ files, query, archived, cursor, pages, loading, error, unsupported,
    canLoadMore: !!cursor && !unsupported && !loading && (!failed || failed.cursor !== undefined) });
  const load = async (attempt: Attempt): Promise<void> => {
    if (disposed || !list || (attempt.cursor !== undefined && loading)) return;
    const at = ++generation;
    loading = true; error = undefined; failed = undefined; changed();
    try {
      const result = await list({ ...attempt, limit: SAVED_FILE_PAGE_SIZE });
      if (disposed || at !== generation) return;
      if (!Array.isArray(result.files) || (result.next_cursor !== undefined
        && (typeof result.next_cursor !== 'string' || result.next_cursor.length === 0
          || result.next_cursor === attempt.cursor || result.files.length === 0))) {
        throw new Error('The saved-file page could not be confirmed. Try again.');
      }
      const merged = new Map((attempt.cursor === undefined ? [] : files).map(file => [file.file_id, file]));
      for (const file of result.files) if (!merged.has(file.file_id)) merged.set(file.file_id, file);
      files = [...merged.values()];
      unsupported = false;
      query = attempt.query; archived = attempt.archived; cursor = result.next_cursor;
      pages = attempt.cursor === undefined ? 1 : pages + 1;
    } catch (cause) {
      if (disposed || at !== generation) return;
      const missingMethod = classifyRpcError(cause).code === 'unknown_method';
      // A failed capability recheck is not evidence that an older server now
      // supports this read. Keep its confirmed fallback until a page succeeds.
      if (missingMethod) unsupported = true;
      else { error = humanizeRpcError(cause); failed = attempt; }
    } finally {
      if (!disposed && at === generation) { loading = false; changed(); }
    }
  };
  return {
    snapshot,
    search: (text: string, showArchived: boolean) => load({ query: text.trim(), archived: showArchived }),
    more: () => cursor && snapshot().canLoadMore ? load({ query, archived, cursor }) : Promise.resolve(),
    retry: () => failed ? load(failed) : Promise.resolve(),
    // Navigation retires reads without replacing the confirmed page or cursor.
    cancel() { generation++; loading = false; },
    reset() {
      generation++; loading = false; files = []; query = ''; archived = false;
      cursor = undefined; pages = 0; error = undefined; failed = undefined; unsupported = false;
    },
    rename(id: string, filename: string) {
      // Keep a confirmed name if the next list read fails. Retire pending reads;
      // the keyset cursor still safely resumes after its original time/id even
      // when a loaded row moves earlier in the server's modified_at order.
      generation++; loading = false;
      const fold = (text: string): string => text.replace(/[A-Z]/g, char => char.toLowerCase()); // SQLite lower().
      files = files.map(file => file.file_id === id ? { ...file, filename } : file)
        .filter(file => !query || fold(file.filename).includes(fold(query)));
    },
    remove(ids: ReadonlySet<string>) { files = files.filter(file => !ids.has(file.file_id)); },
    dispose() { disposed = true; generation++; },
  };
};

type SavedFileState = ReturnType<ReturnType<typeof createSavedFileBrowser>['snapshot']>;
export const renderSavedFileSearch = (state: SavedFileState, input: string, action: string, locked = false): string => {
  if (state.unsupported) return `<p role="status">Update your Recued server to search saved files and load more results.
    <button type="button" class="data-button" ${action}="file-saved-check"${state.loading ? ' aria-disabled="true" aria-busy="true"' : ''}>${state.loading ? 'Checking…' : 'Check again'}</button></p>`;
  const scope = `${state.archived ? 'archived saved file' : 'saved file'}${state.files.length === 1 ? '' : 's'}`;
  return `<div data-saved-file-search>
    <label>Search file names <input class="data-input" type="search" maxlength="200"
      aria-label="Search saved files" ${action}="file-saved-query" value="${e(input)}"${locked ? ' disabled' : ''} /></label>
    <button type="button" class="data-button" ${action}="file-saved-search"${locked ? ' disabled' : ''}>Search files</button>
    <p role="status" data-saved-file-status>${state.pages > 0
      ? `${state.files.length} ${scope} shown${state.query ? ` for “${e(state.query)}”` : ''}.${state.loading ? ' Loading…' : ''}`
      : state.loading ? 'Loading saved files…' : ''}</p>
  </div>`;
};

export const renderSavedFileFooter = (state: SavedFileState, action: string, hasConfirmedResults = state.pages > 0, locked = false): string => state.error
  ? `<p role="alert">Saved files could not be loaded. ${e(state.error)}${hasConfirmedResults ? ' The previous results are still shown.' : ''}
      <button type="button" class="data-button" ${action}="file-saved-retry"${locked ? ' disabled' : ''}>Retry</button></p>`
  : state.cursor && !state.unsupported
    ? `<button type="button" class="data-button" ${action}="file-saved-more"${locked ? ' disabled' : ''}${state.loading ? ' aria-disabled="true" aria-busy="true"' : ''}>${state.loading ? 'Loading…' : 'Load more files'}</button>`
    : '';
