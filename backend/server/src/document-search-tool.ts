/** Content retrieval over saved files. Extraction uses document.read's ordinary
 * executor; this tool never calls a converter or reads a blob itself. */
import { createHash } from 'node:crypto';
import type { ChatDispatchContext, ChatDispatchResult, CollectionRecord } from '@recued/contracts';
import type { Tier1Handler } from '@recued/middleware/internal-tool-registry/index.js';
import { toFtsMatch } from '@recued/fts';
import { createDocumentReadHandler, documentReadPlanner } from './document-read-tool.js';
import { isCollectionReadGrantedForDispatch, type ChatToolHandlerDeps } from './chat-tool-handlers.js';
import { documentIndexAuthority, documentIndexUsable, type DocumentIndexEntry, type DocumentIndexStatus } from './storage/document-search-index.js';
import { registerResumedRunFinisher, takeResumedRunFinisher } from './resumed-run-finishers.js';
import { createReadScope, SPHERE_READ_REFUSAL } from './situations/read-scope.js';
import { sourceCitation, sourceCitationHint } from './chat-source-citations.js';
import type { Collection } from './collections/types.js';

const MAX_SCOPE_FILES = 5000;
const INDEX_BATCH = 5;
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const fileId = (value: unknown): value is string => typeof value === 'string' && /^file:[0-9a-f]{32}$/.test(value);
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const refused = (hint: string): ChatDispatchResult => ({ ok: true, result: { status: 'unavailable', matches: [], partial: true, hint } });

/** Reused before and after asynchronous reads so scope membership is never
 * inferred from a file still existing in storage (archived versions can exist). */
const savedScope = (files: Pick<Collection, 'get' | 'list'>, refs: readonly string[] | undefined) => {
  let rows: CollectionRecord[] = [], missing = 0, limited = false;
  if (refs) {
    limited = refs.length > MAX_SCOPE_FILES;
    for (const ref of refs.slice(0, MAX_SCOPE_FILES)) {
      const row = files.get(ref);
      if (row && fileId(row.record_id)) rows.push(row); else missing++;
    }
  } else {
    let before: { received_at: number; record_id: string } | undefined;
    while (rows.length <= MAX_SCOPE_FILES) {
      const limit = Math.min(500, MAX_SCOPE_FILES + 1 - rows.length);
      const page = files.list({ platform: 'file', slug: 'received', limit, ...(before ? { before } : {}) });
      rows.push(...page);
      if (page.length < limit) break;
      const last = page.at(-1)!;
      if (before?.record_id === last.record_id) break;
      before = { received_at: last.received_at, record_id: last.record_id };
    }
    limited = rows.length > MAX_SCOPE_FILES;
    rows = rows.slice(0, MAX_SCOPE_FILES).filter(row => fileId(row.record_id));
  }
  return { rows: rows.sort((a, b) => a.record_id.localeCompare(b.record_id)), missing, limited };
};

const permitted = (deps: ChatToolHandlerDeps, ctx: ChatDispatchContext): boolean => {
  if (!ctx.execution_source || !isCollectionReadGrantedForDispatch(deps, ctx, 'file')) return false;
  // Resolve again after every await: a read admitted earlier in this batch
  // does not license returning it after the source-read operation is revoked.
  if (deps.getReadGrantResolver?.()?.resolveForSource(ctx.execution_source).isVerbOpGranted('core.storage.data-file-read') === false) return false;
  const access = deps.getSituationAccess?.();
  try { return !access || !createReadScope(access, ctx.execution_source).limited; } catch { return false; }
};

export const documentExcerpt = (text: string, query: string): { excerpt: string; excerpt_offset: number } => {
  const words = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  const pattern = words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  let at = pattern ? new RegExp(pattern, 'iu').exec(text)?.index : undefined;
  if (at === undefined && pattern) {
    // FTS ignores accents. Locate that match too, then map its offset back to
    // the original text so excerpts preserve every original character.
    const fold = (value: string): string => value.normalize('NFD').replace(/\p{M}/gu, '');
    const foldedAt = new RegExp(fold(pattern), 'iu').exec(fold(text))?.index;
    if (foldedAt !== undefined) {
      let original = 0, folded = 0;
      for (const character of text) {
        if (folded >= foldedAt) break;
        original += character.length; folded += fold(character).length;
      }
      at = original;
    }
  }
  let start = Math.max(0, (at ?? 0) - 100), end = Math.min(text.length, start + 480);
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(text[start])) start--;
  if (end < text.length && /[\uDC00-\uDFFF]/u.test(text[end])) end--;
  return { excerpt: text.slice(start, end), excerpt_offset: start };
};

export const createDocumentSearchHandler = (deps: ChatToolHandlerDeps): Tier1Handler => {
  const read = createDocumentReadHandler(deps);
  return async (raw, ctx) => {
    const args = object(raw);
    const scope = args?.scope === undefined ? 'session' : args.scope;
    const converter = args?.converter === undefined ? 'auto' : args.converter;
    const limit = args?.limit ?? 10, offset = args?.offset ?? 0;
    if (!args || Object.keys(args).some(key => !['query', 'scope', 'file_refs', 'converter', 'limit', 'offset', 'cursor'].includes(key))
      || typeof args.query !== 'string' || !args.query.trim() || args.query.length > 512 || !toFtsMatch(args.query)
      || (scope !== 'session' && scope !== 'all') || (converter !== 'auto' && converter !== 'markitdown' && converter !== 'docling')
      || !Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 20
      || !Number.isInteger(offset) || Number(offset) < 0 || Number(offset) > 5000
      || (args.cursor !== undefined && (typeof args.cursor !== 'string' || args.cursor.length > 1024))
      || (args.file_refs !== undefined && (!Array.isArray(args.file_refs) || !args.file_refs.length || args.file_refs.length > 200 || !args.file_refs.every(fileId)))) {
      return { ok: true, result: { status: 'invalid_arguments', hint: 'Use a nonblank text query, session or all scope, up to 200 exact saved file_refs, a supported converter, limit 1–20 and offset 0–5000. Copy a returned cursor unchanged.' } };
    }
    if (!permitted(deps, ctx)) return refused(`File content access is unavailable. ${SPHERE_READ_REFUSAL}`);
    const index = deps.getDocumentSearchIndex?.(), files = deps.getCollectionRegistry()?.get('file', 'received');
    if (!index || !files) return refused('The saved document index is unavailable on this server.');
    index.installLifecycleTriggers();
    const query = args.query.trim(), authority = documentIndexAuthority(ctx);
    const plan = documentReadPlanner(deps, String(converter));
    const selected = args.file_refs === undefined ? undefined : [...new Set(args.file_refs as string[])].sort();
    let sessionRefs: Set<string> | undefined;
    if (scope === 'session') {
      const chat = deps.getChatStore?.();
      if (!chat || !ctx.session_id) return refused('Session search needs a conversation. Use scope=all only when the user asks to search saved files outside this conversation.');
      sessionRefs = new Set((await chat.listMessages(ctx.session_id)).flatMap(message => (message.attachments ?? []).map(file => file.file_id)));
      if (!permitted(deps, ctx)) return refused('File access changed while reading the conversation.');
      if (selected?.some(ref => !sessionRefs!.has(ref))) return refused('A selected file is outside this conversation. The search scope was not widened.');
    }
    const refs = selected ?? (sessionRefs ? [...sessionRefs].sort() : undefined);
    const initialScope = savedScope(files, refs);
    const { rows } = initialScope;
    const signature = hash([authority, query, scope, scope === 'session' ? ctx.session_id : null, selected, converter]);
    let after = '';
    if (args.cursor !== undefined) {
      try {
        const cursor = object(JSON.parse(Buffer.from(String(args.cursor), 'base64url').toString('utf8')));
        if (cursor?.signature !== signature || !fileId(cursor.after)) throw new Error('Wrong search');
        after = cursor.after;
      } catch { return refused('This cursor belongs to a different search or authority. Restart without it.'); }
    }
    const fingerprintByRef = new Map(rows.map(row => [row.record_id, plan(row).key]));
    const rowByRef = new Map(rows.map(row => [row.record_id, row]));
    const admitted = new Map<string, string>();
    const delivered = new Map<string, DocumentIndexEntry>();
    const candidateOffsets = new Map<string, number>();
    const unconfirmed = new Set<string>();
    let nextAfter: string | undefined, batch = 0, conversions = 0;
    let continuationOffset: number | undefined;
    let indexUnavailable = false;
    const start = Date.now();
    let validationPlan = plan;
    const current = (entry: { file_ref: string; fingerprint: string }): boolean => {
      const row = files.get(entry.file_ref);
      return !!row && rowByRef.has(entry.file_ref) && validationPlan(row).key === entry.fingerprint;
    };
    const finish = async (): Promise<ChatDispatchResult> => {
      let liveSessionRefs: Set<string> | undefined;
      if (scope === 'session') {
        const chat = deps.getChatStore?.();
        if (!chat || !ctx.session_id) return refused('The conversation is no longer available.');
        liveSessionRefs = new Set((await chat.listMessages(ctx.session_id)).flatMap(message => (message.attachments ?? []).map(file => file.file_id)));
      }
      if (!permitted(deps, ctx) || documentIndexAuthority(ctx) !== authority) return refused('Permissions changed during the search. No document text is returned.');
      const latestScope = savedScope(files, selected ?? (liveSessionRefs ? [...liveSessionRefs].sort() : undefined));
      const liveRefs = new Set(latestScope.rows.map(row => row.record_id));
      const scopeChanged = latestScope.limited !== initialScope.limited || latestScope.missing !== initialScope.missing
        || latestScope.rows.length !== rows.length || latestScope.rows.some(row => !rowByRef.has(row.record_id));
      const latestPlan = documentReadPlanner(deps, String(converter));
      validationPlan = latestPlan;
      const states = new Map(index.states(authority).map(state => [state.fingerprint, state]));
      const coverage = { files_in_scope: latestScope.rows.length + latestScope.missing, indexed: 0, pending: 0, unreadable: latestScope.missing,
        missing_converter: 0, too_large: 0, empty_extraction: 0, unsupported_encoding: 0, converted: 0,
        scope_limited: latestScope.limited, scope_changed: scopeChanged };
      for (const row of latestScope.rows) {
        if (unconfirmed.has(row.record_id)) { coverage.unreadable++; continue; }
        const state = states.get(latestPlan(row).key);
        if (!documentIndexUsable(state, (deps.now ?? Date.now)())) coverage.pending++;
        else if (state) { coverage[state.status]++; if (state.status === 'indexed' && !state.extraction_complete) coverage.converted++; }
      }
      const citations = [...delivered.values()].filter(entry => liveRefs.has(entry.file_ref) && current(entry)).map(entry => {
        const row = files.get(entry.file_ref)!;
        const citation = sourceCitation({ kind: 'file', file_ref: entry.file_ref, collection_slug: 'received', content_hash: entry.content_hash },
          String(row.hot_fields.filename ?? 'Document'), entry.read_version, (deps.now ?? Date.now)());
        return { entry, row, citation };
      });
      const matchesTruncated = citations.length > Number(limit);
      const canContinue = !scopeChanged && !indexUnavailable;
      const nextOffset = !canContinue ? undefined : matchesTruncated ? candidateOffsets.get(citations[Number(limit)]!.entry.file_ref) : continuationOffset;
      const resumeAfter = canContinue ? nextAfter : undefined;
      const visible = citations.slice(0, Number(limit));
      const partial = latestScope.limited || scopeChanged || coverage.pending > 0 || coverage.unreadable > 0 || coverage.missing_converter > 0
        || coverage.too_large > 0 || coverage.empty_extraction > 0 || coverage.unsupported_encoding > 0 || coverage.converted > 0;
      return { ok: true, source_citations: visible.map(hit => hit.citation),
        ...(coverage.missing_converter ? { missing_packs: converter === 'auto' ? ['recued-core.markitdown', 'recued-core.docling'] : [`recued-core.${String(converter)}`] } : {}),
        result: { status: 'searched', query, scope, matches: visible.map(({ entry, row, citation }) => ({
          file_ref: entry.file_ref, filename: row.hot_fields.filename, content_hash: entry.content_hash,
          converter: entry.converter, extraction_complete: entry.extraction_complete, ...documentExcerpt(entry.text, query), ...sourceCitationHint(citation),
        })), coverage, partial, matches_truncated: matchesTruncated,
        ...(indexUnavailable ? { index_unavailable: true } : {}),
        ...(nextOffset !== undefined ? { next_offset: nextOffset } : {}),
        ...(resumeAfter ? { next_cursor: Buffer.from(JSON.stringify({ signature, after: resumeAfter })).toString('base64url') } : {}),
        hint: (coverage.files_in_scope === 0 ? 'There are no saved files in the requested scope. '
          : visible.length === 0 ? 'No matches were found in the indexed text for this scope. ' : '')
          + 'Matches are excerpts, not complete document readings. Use document.read for context. '
          + (resumeAfter ? 'Continue with next_cursor and the same query, scope and converter to prepare remaining files. ' : '')
          + (nextOffset !== undefined ? 'Use next_offset to check further indexed candidates; each is verified before returning text. ' : '')
          + (scopeChanged ? 'Files entered or left this scope while searching. Restart without a cursor or offset to cover the current scope. ' : '')
          + (partial ? 'Coverage is incomplete. Do not treat no matches as proof that every relevant document lacks the text. ' : '')
          + (indexUnavailable ? 'The search index is unavailable. document.read can still read an exact file; repeating this search may not restore the index. ' : '')
          + (coverage.pending && !resumeAfter && !scopeChanged && !indexUnavailable ? 'Restart the search or narrow file_refs; the bounded index may have evicted earlier text. ' : '')
          + 'Remote-only files are not downloaded. Install or authorize a missing converter explicitly; nothing is installed by this search.' } };
    };
    const receive = (row: CollectionRecord, result: ChatDispatchResult): void => {
      validationPlan = documentReadPlanner(deps, String(converter));
      const payload = result.ok ? object(result.result) : undefined;
      const fingerprint = fingerprintByRef.get(row.record_id)!;
      if (payload?.search_index_unavailable === true) { indexUnavailable = true; unconfirmed.add(row.record_id); return; }
      if (payload?.status === 'read' && current({ file_ref: row.record_id, fingerprint })) admitted.set(row.record_id, fingerprint);
      else if (!result.ok || result.run_failed || !['empty_extraction', 'too_large', 'needs_pack', 'unsupported_encoding', 'unsupported', 'unavailable'].includes(String(payload?.status))) unconfirmed.add(row.record_id);
      else if (permitted(deps, ctx) && current({ file_ref: row.record_id, fingerprint })) {
        // A transient failure to re-admit a cached candidate must not remove
        // it from FTS and shift the offset past a later, still-readable hit.
        // Every future request re-admits it; source mutations still delete it.
        if (index.hasIndexed(authority, fingerprint)) { unconfirmed.add(row.record_id); return; }
        const status: DocumentIndexStatus = payload?.status === 'needs_pack' ? 'missing_converter'
          : payload?.status === 'too_large' ? 'too_large' : payload?.status === 'empty_extraction' ? 'empty_extraction'
            : payload?.status === 'unsupported_encoding' ? 'unsupported_encoding' : 'unreadable';
        index.put({ authority, fingerprint, file_ref: row.record_id, content_hash: row.blob_hash ?? String(row.hot_fields.content_hash ?? ''),
          status, text: '', converter: String(converter), read_version: '', extraction_complete: false, updated_at: (deps.now ?? Date.now)() });
      }
    };
    const held = async (row: CollectionRecord, outcome: ChatDispatchResult): Promise<ChatDispatchResult | undefined> => {
      if (!outcome.ok || !outcome.run_held || !outcome.run_id) return undefined;
      const original = takeResumedRunFinisher(outcome.run_id);
      if (original) registerResumedRunFinisher(outcome.run_id, { tool_name: 'document.search', finish: async response => {
        const result = await original.finish(response);
        receive(row, result);
        if (admitted.has(row.record_id)) for (const hit of index.search(authority, [fingerprintByRef.get(row.record_id)!], query, 1)) delivered.set(hit.file_ref, hit);
        const complete = await finish();
        return result.ok && complete.ok ? { ...complete, ...(result.run_failed ? { run_failed: result.run_failed } : {}) } : result;
      } });
      const partial = await finish();
      return { ...outcome, ...(partial.ok ? { result: partial.result } : {}) };
    };
    const states = new Map(index.states(authority).map(state => [state.fingerprint, state]));
    let last = after;
    for (const row of rows) {
      if (row.record_id <= after) continue;
      const profile = plan(row), state = states.get(profile.key);
      if (documentIndexUsable(state, (deps.now ?? Date.now)())) { last = row.record_id; continue; }
      if (batch >= INDEX_BATCH || (profile.converter !== undefined && conversions >= 1) || Date.now() - start >= 10000) { nextAfter = last || undefined; break; }
      batch++; if (profile.converter) conversions++;
      last = row.record_id;
      nextAfter = rows.some(other => other.record_id > last) ? last : undefined;
      const outcome = await read({ file_ref: row.record_id, converter }, ctx);
      if (!permitted(deps, ctx)) return refused('File access changed during extraction.');
      const pause = await held(row, outcome); if (pause) return pause;
      receive(row, outcome);
      nextAfter = undefined;
      if (indexUnavailable) break;
    }
    const eligible = rows.map(row => ({ file_ref: row.record_id, fingerprint: fingerprintByRef.get(row.record_id)! })).filter(current);
    const candidates = index.search(authority, eligible.map(row => row.fingerprint), query, Number(limit) + 1, Number(offset));
    // Admit the pagination sentinel too; an unreadable cached candidate must
    // not claim that another accessible match exists.
    for (const [position, hit] of candidates.entries()) {
      candidateOffsets.set(hit.file_ref, Number(offset) + position);
      continuationOffset = position < candidates.length - 1 || candidates.length > Number(limit) ? Number(offset) + position + 1 : undefined;
      if (!admitted.has(hit.file_ref)) {
        // Another search can evict text between our query and this await.
        // Leave it pending rather than starting an unbudgeted conversion.
        if (!index.hasIndexed(authority, hit.fingerprint)) continue;
        const row = rowByRef.get(hit.file_ref)!;
        const outcome = await read({ file_ref: hit.file_ref, converter }, ctx);
        if (!permitted(deps, ctx)) return refused('File access changed while verifying a match.');
        const pause = await held(row, outcome); if (pause) return pause;
        receive(row, outcome);
      }
      if (admitted.has(hit.file_ref) && current(hit)) delivered.set(hit.file_ref, hit);
    }
    return finish();
  };
};
