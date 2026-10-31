import { type DocumentContentMatch, type DocumentContentSearchResult, type OwnerDocumentSearchReply, type OwnerDocumentSearchRequest } from '@recued/contracts';
import { e } from '@recued/ui-shared';
import { classifyRpcError, humanizeRpcError } from '../shell/rpc-error-copy.js';
import { serializeLogsRunAddress } from '../shell/route.js';

export const DOCUMENT_SEARCH_ACTION = 'document-search-';
export const DOCUMENT_SEARCH_FILE = 'data-document-search-file';
export const DOCUMENT_SEARCH_FOCUS = 'data-document-search-focus';
export interface DocumentSearchCallers {
  search(input: OwnerDocumentSearchRequest): Promise<OwnerDocumentSearchReply>;
  result(input: { request_id: string }): Promise<OwnerDocumentSearchReply>;
}
export interface DocumentSearchState {
  query: string;
  phase: 'idle' | 'searching' | 'held' | 'ready' | 'error' | 'changed';
  matches: readonly DocumentContentMatch[];
  result?: DocumentContentSearchResult;
  request?: OwnerDocumentSearchRequest;
  append?: boolean;
  run_id?: string;
  error?: string;
  unsupported?: boolean;
}
const empty = (query = ''): DocumentSearchState => ({ query, phase: 'idle', matches: [] });
const confirmed = (reply: OwnerDocumentSearchReply, request: OwnerDocumentSearchRequest) => {
  if (!reply || reply.request_id !== request.request_id || !['running', 'held', 'ready', 'unavailable', 'expired', 'changed'].includes(reply.state)) return false;
  const result = reply.result;
  if (reply.state === 'ready' && !result) return false;
  return !result || result.status === 'searched' && result.scope === 'all' && result.query === request.query
    && typeof result.scope_version === 'string' && Array.isArray(result.matches) && result.matches.length <= 20
    && result.matches.every(hit => /^file:[0-9a-f]{32}$/.test(hit.file_ref) && typeof hit.filename === 'string'
      && typeof hit.excerpt === 'string' && hit.excerpt.length <= 481 && typeof hit.content_hash === 'string')
    && result.coverage && (['files_in_scope', 'indexed', 'pending', 'unreadable', 'missing_converter', 'too_large', 'empty_extraction', 'unsupported_encoding', 'converted'] as const)
      .every(key => Number.isSafeInteger(result.coverage[key]) && result.coverage[key] >= 0)
    && typeof result.coverage.scope_limited === 'boolean' && typeof result.coverage.scope_changed === 'boolean';
};

export const createDocumentContentSearch = (callers: DocumentSearchCallers | undefined, changed: () => void) => {
  let state = empty(), generation = 0, disposed = false, active = true, busy = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopTimer = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const schedule = () => {
    stopTimer();
    if (!disposed && active && callers && state.request && ['held', 'searching'].includes(state.phase)) {
      timer = setTimeout(() => { timer = undefined; void check(); }, 2000);
    }
  };
  const receive = (reply: OwnerDocumentSearchReply, request: OwnerDocumentSearchRequest) => {
    if (!confirmed(reply, request)) throw new Error('The file-content search result could not be confirmed. Check this search before trying again.');
    const result = reply.result;
    if (reply.state === 'changed' || reply.state === 'expired') {
      state = { query: state.query, phase: 'changed', matches: [], error: reply.message ?? 'Restart the file-content search.' }; return;
    }
    if (reply.state === 'unavailable') {
      state = { query: state.query, phase: 'error', matches: [], error: reply.message ?? 'The saved files could not be searched.' }; return;
    }
    const keep = Boolean(state.append && result && state.result?.scope_version === result.scope_version && !result.coverage.scope_changed);
    let matches = result ? [...(keep ? state.matches : []), ...result.matches] : [...state.matches];
    const seen = new Set<string>(); matches = matches.filter(hit => { const key = `${hit.file_ref}:${hit.content_hash}`; if (seen.has(key)) return false; seen.add(key); return true; });
    state = { ...state, matches, ...(result ? { result } : {}), run_id: reply.run_id,
      phase: reply.state === 'held' ? 'held' : reply.state === 'running' ? 'searching' : 'ready', error: reply.message };
  };
  const read = async (request: OwnerDocumentSearchRequest, checking: boolean) => {
    if (!callers || disposed || busy) return;
    const mine = generation; busy = true; stopTimer();
    try {
      const reply = await (checking ? callers.result({ request_id: request.request_id }) : callers.search(request));
      if (disposed || mine !== generation) return;
      receive(reply, request);
    } catch (cause) {
      if (disposed || mine !== generation) return;
      const code = classifyRpcError(cause).code, unsupported = code === 'unknown_method';
      const refused = !checking && code !== null && ['invalid_args', 'forbidden', 'unauthorized', 'not_configured', 'unknown_method', 'conflict'].includes(code);
      state = { ...state, phase: 'error', unsupported, request: refused ? undefined : state.request,
        error: unsupported ? 'Update your Recued server to search saved document contents here.' : humanizeRpcError(cause) };
    } finally {
      if (!disposed && mine === generation) { busy = false; changed(); schedule(); }
    }
  };
  const check = async () => { if (state.request) await read(state.request, true); };
  const start = async (mode: 'new' | 'cursor' | 'offset' = 'new') => {
    if (!callers || disposed || busy || !state.query.trim() || state.unsupported) return;
    if (state.query.length > 512) { state = { ...state, phase: 'error', request: undefined, error: 'Use 512 characters or fewer for a file-content search.' }; changed(); return; }
    if (mode === 'cursor' && !state.result?.next_cursor || mode === 'offset' && state.result?.next_offset === undefined) return;
    const request: OwnerDocumentSearchRequest = { request_id: crypto.randomUUID(), query: state.query.trim(),
      ...(mode === 'cursor' ? { cursor: state.result!.next_cursor } : {}), ...(mode === 'offset' ? { offset: state.result!.next_offset } : {}) };
    generation++; stopTimer(); state = { ...state, phase: 'searching', request, append: mode !== 'new', error: undefined, run_id: undefined,
      ...(mode === 'new' ? { matches: [], result: undefined } : {}) };
    changed(); await read(request, false);
  };
  return {
    available: () => Boolean(callers), state: () => state,
    setQuery(query: string) { const next = query.trim(); if (next === state.query) return; generation++; busy = false; stopTimer(); state = empty(next); },
    start, check,
    retry: async () => { if (state.request && state.phase === 'error') await check(); else await start(); },
    snapshot: () => ({ ...state, matches: [...state.matches] }),
    restore(saved: DocumentSearchState | undefined) { if (!saved) return; generation++; busy = false; stopTimer(); state = { ...saved, matches: [...saved.matches] };
      if (active && state.request) timer = setTimeout(() => { timer = undefined; void check(); }, 0); },
    setActive(value: boolean) { if (active === value) return; active = value; stopTimer();
      if (value && state.request) timer = setTimeout(() => { timer = undefined; void check(); }, 0); },
    dispose() { disposed = true; generation++; stopTimer(); },
  };
};

export const renderDocumentContentSearch = (state: DocumentSearchState | undefined, actionAttr: string): string => {
  if (!state?.query) return '';
  const button = (name: string, text: string) => `<button type="button" class="data-button" ${actionAttr}="${DOCUMENT_SEARCH_ACTION}${name}" ${DOCUMENT_SEARCH_FOCUS}="${name}">${e(text)}</button>`;
  const result = state.result, c = result?.coverage;
  const pending = state.phase === 'searching';
  const skipped = c ? c.unreadable + c.missing_converter + c.too_large + c.empty_extraction + c.unsupported_encoding : 0;
  const coverage = c ? `<p class="rq-hint" role="status">${c.indexed} of ${c.files_in_scope} saved files prepared${c.pending ? ` · ${c.pending} pending` : ''}${skipped ? ` · ${skipped} could not be searched` : ''}.</p>
    ${c.missing_converter ? `<p class="rq-hint">${c.missing_converter} ${c.missing_converter === 1 ? 'file needs' : 'files need'} an installed and authorized MarkItDown or Docling reader.</p>` : ''}
    ${c.unreadable || c.too_large || c.empty_extraction || c.unsupported_encoding ? `<p class="rq-hint">${[
      c.unreadable ? `${c.unreadable} unreadable` : '', c.too_large ? `${c.too_large} too large` : '',
      c.empty_extraction ? `${c.empty_extraction} with no extracted text` : '', c.unsupported_encoding ? `${c.unsupported_encoding} with unsupported text encoding` : '',
    ].filter(Boolean).join(' · ')}.</p>` : ''}
    ${c.converted ? '<p class="rq-hint">Converted text may omit content from images or complex layouts.</p>' : ''}
    ${c.scope_limited ? '<p class="rq-hint">This search reached the saved-file scope limit.</p>' : ''}
    ${c.scope_changed ? '<p class="rq-hint">Saved files changed during this search. Restart to search the current files.</p>' : ''}
    ${result?.index_unavailable ? '<p class="rq-hint">The document index is unavailable. You can still open individual files.</p>' : ''}` : '';
  return `<section class="rq-document-search" aria-label="Document contents"><h3 ${DOCUMENT_SEARCH_FOCUS}="heading" tabindex="-1">Document contents</h3>
    <p class="rq-hint">Find words inside saved files on this server. Connected-drive placeholders are not downloaded.</p>
    ${state.phase === 'idle' ? button('start', 'Search file contents') : ''}
    ${pending ? '<p role="status" class="rq-hint">Searching saved file contents… Other search results remain available.</p>' : ''}
    ${coverage}
    ${state.error ? `<p class="${state.phase === 'error' || state.phase === 'changed' ? 'rq-error' : 'rq-hint'}" role="${state.phase === 'error' || state.phase === 'changed' ? 'alert' : 'status'}">${e(state.error)}</p>` : ''}
    ${state.matches.length ? `<ul class="rq-rows">${state.matches.map(hit => `<li class="rq-document-hit"><button type="button" class="rq-row-btn" ${actionAttr}="${DOCUMENT_SEARCH_ACTION}open" ${DOCUMENT_SEARCH_FILE}="${e(hit.file_ref)}" ${DOCUMENT_SEARCH_FOCUS}="${e(hit.file_ref)}"><strong>${e(hit.filename)}</strong><span class="rq-document-open">Open file</span><span class="rq-document-excerpt">${e(hit.excerpt)}</span></button></li>`).join('')}</ul>` : result && !pending && state.phase !== 'held' ? `<p class="rq-hint">${result.partial ? 'No matches in the text searched so far. Some files or content could not be searched.' : 'No matches in the searched saved-file text.'}</p>` : ''}
    <div class="rq-document-actions">${state.phase === 'held' ? (state.run_id ? `<a class="data-button" ${DOCUMENT_SEARCH_FOCUS}="review" href="${e(serializeLogsRunAddress({ runId: state.run_id }))}" target="_blank" rel="noopener">Review waiting action (new tab)</a>` : '') + button('check', 'Check search')
      : state.phase === 'error' && !state.unsupported ? button('retry', state.request ? 'Check search' : 'Try again')
      : state.phase === 'changed' ? button('start', 'Restart search')
      : state.phase === 'ready' ? `${result?.next_cursor ? button('continue', 'Search more files') : ''}${result?.next_offset !== undefined ? button('more', 'More matches') : ''}${button('start', 'Search again')}` : ''}</div>
  </section>`;
};

export const DOCUMENT_SEARCH_STYLES = `
.rq-document-search { margin:16px 0; padding:16px; border:1px solid var(--border); border-radius:10px; min-width:0; }
.rq-document-search h3 { margin:0 0 8px; }
.rq-document-actions { display:flex; flex-wrap:wrap; gap:8px; }
.rq-document-hit { list-style:none; border-top:1px solid var(--border); min-width:0; }
.rq-document-hit .rq-row-btn { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:8px; width:100%; text-align:left; }
.rq-document-hit strong,.rq-document-excerpt { overflow-wrap:anywhere; min-width:0; }
.rq-document-open { font-size:12px; color:var(--text-muted); }
.rq-document-excerpt { grid-column:1/-1; white-space:pre-wrap; }
@media(max-width:600px) { .rq-document-search { padding:12px; }.rq-document-actions .data-button { min-height:42px; } }
`;
