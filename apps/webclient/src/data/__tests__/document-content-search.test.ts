import { expect, it, vi } from 'vitest';
import type { DocumentContentSearchResult, OwnerDocumentSearchReply, OwnerDocumentSearchRequest } from '@recued/contracts';
import { createDocumentContentSearch, renderDocumentContentSearch } from '../document-content-search.js';

const file = (n: number) => ({ file_ref: `file:${String(n).padStart(32, '0')}`, filename: `terms-${n}.txt`,
  content_hash: String(n).repeat(64), converter: 'text', extraction_complete: true, excerpt: 'Renewal needs notice.', excerpt_offset: 0 });
const result = (patch: Partial<DocumentContentSearchResult> = {}): DocumentContentSearchResult => ({ status: 'searched', query: 'renewal', scope: 'all', scope_version: 'scope-1',
  matches: [file(1)], coverage: { files_in_scope: 6, indexed: 6, pending: 0, unreadable: 0, missing_converter: 0, too_large: 0,
    empty_extraction: 0, unsupported_encoding: 0, converted: 0, scope_limited: false, scope_changed: false },
  partial: false, matches_truncated: false, hint: '', ...patch });
const ready = (request: OwnerDocumentSearchRequest, value = result()): OwnerDocumentSearchReply => ({ request_id: request.request_id, state: 'ready', result: value });

it('continues the same search, deduplicates repeated hits and discards older-scope excerpts when files change', async () => {
  const search = vi.fn(async (request: OwnerDocumentSearchRequest) => ready(request));
  search.mockImplementationOnce(async request => ready(request, result({ next_cursor: 'prepare-next', partial: true,
    coverage: { ...result().coverage, indexed: 1, pending: 5 } })));
  search.mockImplementationOnce(async request => ready(request, result({ matches: [file(1), file(2)], next_offset: 10 })));
  search.mockImplementationOnce(async request => ready(request, result({ matches: [file(3)], scope_version: 'scope-2' })));
  const surface = createDocumentContentSearch({ search, result: vi.fn() }, vi.fn());
  surface.setQuery('renewal'); expect(search).not.toHaveBeenCalled();
  await surface.start();
  expect(renderDocumentContentSearch(surface.state(), 'data-action')).toContain('5 pending');
  await surface.start('cursor');
  expect(search.mock.calls[1]![0]).toMatchObject({ query: 'renewal', cursor: 'prepare-next' });
  expect(surface.state().matches.map(hit => hit.file_ref)).toEqual([file(1).file_ref, file(2).file_ref]);
  await surface.start('offset');
  expect(search.mock.calls[2]![0]).toMatchObject({ offset: 10 });
  expect(surface.state().matches.map(hit => hit.file_ref)).toEqual([file(3).file_ref]);
  surface.dispose();
});

it('retires late-query replies and checks a timed-out request without submitting the search again', async () => {
  let release!: (reply: OwnerDocumentSearchReply) => void;
  const search = vi.fn(async (request: OwnerDocumentSearchRequest) => ready(request, result({ query: request.query })));
  search.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  search.mockRejectedValueOnce({ code: 'timeout', message: 'Reply lost' });
  const get = vi.fn(async ({ request_id }: { request_id: string }) => ({ request_id, state: 'ready' as const, result: result({ query: 'notice', matches: [file(2)] }) }));
  const surface = createDocumentContentSearch({ search, result: get }, vi.fn());
  surface.setQuery('renewal'); const first = surface.start();
  surface.setQuery('notice'); release(ready(search.mock.calls[0]![0])); await first;
  expect(surface.state()).toMatchObject({ query: 'notice', phase: 'idle', matches: [] });
  await surface.start(); expect(surface.state().phase).toBe('error');
  const request = search.mock.calls[1]![0]; await surface.retry();
  expect(get).toHaveBeenCalledWith({ request_id: request.request_id }); expect(search).toHaveBeenCalledTimes(2);
  expect(surface.state()).toMatchObject({ phase: 'ready', matches: [file(2)] });
  search.mockRejectedValueOnce({ code: 'invalid_args', message: 'Enter a search word.' });
  await surface.start(); expect(surface.state().request).toBeUndefined();
  await surface.retry(); expect(surface.state().phase).toBe('ready');
  expect(search).toHaveBeenCalledTimes(4); expect(get).toHaveBeenCalledTimes(1);
  surface.dispose();
});

it('clears partial excerpts when a waiting search ends without a usable result', async () => {
  const search = vi.fn(async (request: OwnerDocumentSearchRequest): Promise<OwnerDocumentSearchReply> => ({
    request_id: request.request_id, state: 'held', run_id: 'waiting-reader', result: result({ partial: true }),
  }));
  const get = vi.fn(async ({ request_id }: { request_id: string }): Promise<OwnerDocumentSearchReply> => ({
    request_id, state: 'unavailable', message: 'This search was declined or stopped. Start a new search to try again.',
  }));
  const surface = createDocumentContentSearch({ search, result: get }, vi.fn());
  surface.setQuery('renewal'); await surface.start();
  expect(surface.state()).toMatchObject({ phase: 'held', matches: [file(1)] });
  await surface.check();
  expect(surface.state()).toMatchObject({ phase: 'error', matches: [] });
  expect(surface.state().request).toBeUndefined();
  expect(surface.state().result).toBeUndefined();
  expect(renderDocumentContentSearch(surface.state(), 'data-action')).not.toContain(file(1).excerpt);
  expect(search).toHaveBeenCalledTimes(1);
  surface.dispose();
});
