import Database from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createStorageGate } from '@recued/storage-gate';
import { parseGrantEntry, type ChatDispatchContext, type CollectionRecord, type IngredientManifest } from '@recued/contracts';
import { buildChatTier1Handlers, type ChatToolHandlerDeps } from '../chat-tool-handlers.js';
import { createCollectionRegistry } from '../collections/registry.js';
import { createCollectionTable } from '../collections/table.js';
import type { Collection } from '../collections/types.js';
import { createDocumentSearchIndex, documentIndexAuthority } from '../storage/document-search-index.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createReadGrantChecker } from '../read-grant-checker.js';
import { takeResumedRunFinisher } from '../resumed-run-finishers.js';
import { stampExecuteResponseAuditRun, type ExecuteRequest, type ExecuteResponse } from '../types.js';
import { openDatabase } from '../open-database.js';
import { createInternalToolRegistry } from '@recued/middleware/internal-tool-registry/index.js';
import { buildInternalToolMcpAdapter } from '../mcp-internal-tools.js';
import { createFileAttachmentLifecycle } from '../storage/file-attachment-lifecycle.js';

const ctx: ChatDispatchContext = { channel: 'internal_function_call', session_id: 'chat-1', turn_id: 'turn-1',
  execution_source: { channel: 'chat', actor: 'user_self', user_id: 'local', chat_session_id: 'chat-1' } };
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const summary = (data: Record<string, unknown>): ExecuteResponse => ({ recipe_id: 'read-work-document', recipe_hash: 'hash', success: true,
  output: { render: [{ type: 'summary', data }], sidebar: [] }, steps: [], errors: [], duration_ms: 1 });
const converted = (text: string): ExecuteResponse => summary({ bytes_b64: Buffer.from(text).toString('base64') });
interface SearchBody {
  status: string; matches: Array<{ file_ref: string; excerpt: string; content_hash: string; source_ref: string }>;
  coverage: Record<string, number | boolean>; partial: boolean; matches_truncated: boolean; next_cursor?: string; next_offset?: number; hint: string;
}
const body = (result: unknown): SearchBody => (result as { result: SearchBody }).result;
let db: Database.Database;
let files: ReturnType<typeof createCollectionTable>;
let index: ReturnType<typeof createDocumentSearchIndex>;
let deps: ChatToolHandlerDeps;
let execute: ReturnType<typeof vi.fn<(request: ExecuteRequest) => Promise<ExecuteResponse>>>;
let attached: string[], installed: boolean, allowed: boolean, readOpAllowed: boolean, counter: number;
let textByRef: Map<string, string>;
let manifests: ReturnType<typeof createManifestRegistry>;
const add = (text: string, mime = 'text/plain'): CollectionRecord => {
  const id = `file:${String(++counter).padStart(32, '0')}`;
  const hash = sha(mime.startsWith('text/') ? text : `PDF source ${id}`);
  const row: CollectionRecord = { record_id: id, source_id: id, received_at: counter, modified_at: counter,
    size_bytes: Buffer.byteLength(text), blob_hash: hash,
    hot_fields: { filename: `scan-${counter}.bin`, mime_type: mime, content_hash: hash, archived: 0,
      media_class: 'document', size: Buffer.byteLength(text), origin: 'webclient_upload', scan_status: 'clean' } };
  files.upsert(row); textByRef.set(id, text); attached.push(id); return row;
};
const run = (args: Record<string, unknown>, context = ctx) => buildChatTier1Handlers(deps)['document.search']!(args, context);
const requestFile = (request: ExecuteRequest): string => {
  const value = request.config?.source;
  return typeof value === 'string' ? value : (value as { record_id: string }).record_id;
};
const isMetadata = (request: ExecuteRequest): boolean =>
  (request.recipe as { steps: Array<{ args?: { metadata_only?: boolean } }> }).steps[0]?.args?.metadata_only === true;
const executeFile = async (request: ExecuteRequest): Promise<ExecuteResponse> => {
  const id = requestFile(request), file = deps.getCollectionRegistry()!.get('file', 'received')!.get(id);
  if (!file) return summary({});
  return isMetadata(request) ? summary({ blob_hash: file.blob_hash })
    : summary({ bytes_b64: Buffer.from(textByRef.get(id) ?? '').toString('base64'), blob_hash: file.blob_hash });
};

beforeEach(() => {
  db = new Database(':memory:');
  files = createCollectionTable({ db, platform: 'file', slug: 'received', ftsTextFor: () => '' });
  index = createDocumentSearchIndex(db);
  const registry = createCollectionRegistry();
  const collection: Collection = { platform: 'file', slug: 'received', get: files.get, list: files.list, search: files.search,
    upsert: files.upsert, delete: id => files.delete(id) !== null,
    gate: createStorageGate({ quota: 10000000, reservePct: 0, surface: 'test:file' }),
    health: () => ({ platform: 'file', slug: 'received', last_indexed_at: 1, pending_queue_size: 0, error_count_24h: 0, state: 'idle' }),
    sync: { start: async () => {}, stop: async () => {} }, close: async () => {}, runRetention: async () => { throw new Error('No retention'); } };
  registry.register(collection);
  attached = []; installed = true; allowed = true; readOpAllowed = true; counter = 0; textByRef = new Map();
  manifests = createManifestRegistry('/nonexistent');
  for (const name of ['markitdown', 'docling']) {
    const manifest: IngredientManifest = { slug: `${name}-catalog`, name, description: 'Document conversion', author: 'recued-core',
      kind: 'connection', version: 1, category: 'data', risk_tier: 'write', input: {}, output: {},
      operations: { 'document.to_markdown': { operation_id: 'document.to_markdown', risk_tier: 'write', description: 'Convert document' } } };
    manifests.register(manifest);
  }
  execute = vi.fn(executeFile);
  const checker = () => createReadGrantChecker({ isGranted: (_id, entry, fallback) => {
    if (entry === 'core.storage.data-file-read') return readOpAllowed;
    const grant = parseGrantEntry(entry); return grant.kind === 'collection' ? allowed && grant.value === 'file' : fallback;
  } }, 'owner');
  deps = { getCollectionRegistry: () => registry, getContactStore: () => undefined, getAuditLog: () => undefined,
    getEnrichmentStore: () => undefined, getRecipeStore: () => { throw new Error('No stored recipe lookup'); },
    getExecutorConfig: () => ({ manifests }) as ReturnType<ChatToolHandlerDeps['getExecutorConfig']>, getExecuteRecipe: () => execute,
    getDocumentSearchIndex: () => index, getChatStore: () => ({ listMessages: async () => [{ attachments: attached.map(file_id => ({ file_id })) }] }),
    documentPacks: () => installed ? ['markitdown', 'docling'].map(name => ({ segments: [name], value: { publisher: 'recued-core', ingredient_ids: [`${name}-catalog`] } })) : [],
    getReadGrantResolver: () => ({ resolveForContract: checker, resolveForSource: checker }) };
});
afterEach(() => db.close());

describe('saved document content search', () => {
  it('finds text beyond the first reader page and returns a literal bounded excerpt with the pinned source', async () => {
    const text = 'Ordinary introduction. '.repeat(2500) + 'Cancellation requires 60 days notice. 🦊';
    const file = add(text);
    const result = body(await run({ query: '60 days' }));
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({ file_ref: file.record_id, content_hash: sha(text) });
    expect(result.matches[0]!.excerpt).toContain('60 days notice');
    expect(result.matches[0]!.excerpt.length).toBeLessThanOrEqual(481);
    expect(text).toContain(result.matches[0]!.excerpt);
    expect(result.coverage).toMatchObject({ indexed: 1, pending: 0 });
    expect(result.partial).toBe(false);
  });

  it('reuses durable text across handler recreation and owner conversations, but re-admits file reads', async () => {
    add('Renewal requires notice.', 'application/pdf');
    await run({ query: 'renewal', scope: 'all' });
    index = createDocumentSearchIndex(db);
    execute.mockClear();
    const other: ChatDispatchContext = { ...ctx, session_id: 'chat-2', execution_source: { channel: 'chat', actor: 'user_self', user_id: 'local', chat_session_id: 'chat-2' } };
    expect(body(await run({ query: 'renewal', scope: 'all' }, other)).matches).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(isMetadata(execute.mock.calls[0]![0])).toBe(true);
    allowed = false; execute.mockClear();
    expect(JSON.stringify(await run({ query: 'renewal', scope: 'all' }, other))).not.toContain('requires notice');
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps session defaults narrow and refuses explicit references outside the conversation', async () => {
    const mine = add('Renewal terms.'); const other = add('Private renewal terms.');
    attached = [mine.record_id];
    expect(body(await run({ query: 'renewal' })).matches.map(row => row.file_ref)).toEqual([mine.record_id]);
    expect(body(await run({ query: 'renewal', file_refs: [other.record_id] })).status).toBe('unavailable');
    expect(body(await run({ query: 'renewal', scope: 'all' })).matches).toHaveLength(2);
  });

  it('rejects malformed scope and converter values before reading any file', async () => {
    add('Private renewal terms.'); attached = [];
    for (const args of [{ scope: ['session'] }, { scope: ['all'] }, { scope: null }, { converter: ['auto'] }, { converter: null }]) {
      expect(body(await run({ query: 'renewal', ...args })).status).toBe('invalid_arguments');
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['session', 'all'])('reports files added to %s scope during reading as incomplete coverage', async scope => {
    add('Other material.');
    execute.mockImplementationOnce(async request => { const result = await executeFile(request); add('Renewal notice.'); return result; });
    const first = body(await run({ query: 'renewal', scope }));
    expect(first.coverage).toMatchObject({ files_in_scope: 2, pending: 1, scope_changed: true });
    expect(first.partial).toBe(true);
    expect(first.next_cursor).toBeUndefined(); expect(first.next_offset).toBeUndefined();
    const next = body(await run({ query: 'renewal', scope }));
    expect(next.matches).toHaveLength(1); expect(next.partial).toBe(false);
  });

  it('does not reuse extraction admitted for another contract identity or version', async () => {
    add('Renewal contract.', 'application/pdf'); await run({ query: 'renewal', scope: 'all' });
    const external: ChatDispatchContext = { channel: 'mcp_wire', mcp_token_id: 'token',
      execution_source: { channel: 'mcp', actor: 'contracted_user', agent_id: 'agent', mcp_token_id: 'token', contract_id: 'customer', tool_call_id: 'tool-1' },
      contract_snapshot: { contract_id: 'customer', contract_version: 'v1', allowed_tools: [], approval_required: [], scope_restrictions: [], resolved_at: 1 } };
    execute.mockClear(); await run({ query: 'renewal', scope: 'all' }, external);
    expect(isMetadata(execute.mock.calls[0]![0])).toBe(false);
    execute.mockClear();
    await run({ query: 'renewal', scope: 'all' }, { ...external, contract_snapshot: { ...external.contract_snapshot!, contract_version: 'v2' } });
    expect(isMetadata(execute.mock.calls[0]![0])).toBe(false);
  });

  it('invalidates text and FTS rows immediately on source replacement and deletion', async () => {
    const file = add('Old cancellation terms.'); await run({ query: 'cancellation' });
    expect(index.states(documentIndexAuthority(ctx))).toHaveLength(1);
    files.upsert({ ...file, blob_hash: sha('New renewal terms.'), hot_fields: { ...file.hot_fields, content_hash: sha('New renewal terms.') } });
    expect(index.states(documentIndexAuthority(ctx))).toHaveLength(0);
    textByRef.set(file.record_id, 'New renewal terms.');
    expect(body(await run({ query: 'cancellation' })).matches).toHaveLength(0);
    expect(body(await run({ query: 'renewal' })).matches).toHaveLength(1);
    files.delete(file.record_id);
    expect(db.prepare('SELECT count(*) AS n FROM document_search_fts').get()).toEqual({ n: 0 });
    expect(body(await run({ query: 'renewal' })).coverage.unreadable).toBe(1);
  });

  it('never publishes an extraction that finished after its source changed', async () => {
    const file = add('Superseded secret.');
    execute.mockImplementationOnce(async request => {
      const result = await executeFile(request);
      files.upsert({ ...file, blob_hash: sha('Replacement'), hot_fields: { ...file.hot_fields, content_hash: sha('Replacement') } });
      return result;
    });
    const result = await run({ query: 'secret' });
    expect(JSON.stringify(result)).not.toContain('Superseded secret');
    expect(body(result).partial).toBe(true);
    expect(index.states(documentIndexAuthority(ctx))).toHaveLength(0);
  });

  it('rechecks permission and session membership after asynchronous reads', async () => {
    add('Confidential words.');
    execute.mockImplementationOnce(async request => { const result = await executeFile(request); allowed = false; return result; });
    expect(JSON.stringify(await run({ query: 'confidential' }))).not.toContain('Confidential words');
    expect(index.states(documentIndexAuthority(ctx))).toHaveLength(0);
    allowed = true;
    execute.mockImplementationOnce(async request => { const result = await executeFile(request); attached = []; return result; });
    expect(body(await run({ query: 'confidential' })).matches).toHaveLength(0);
  });

  it('continues bounded preparation without skipping files and rejects cursors for other searches', async () => {
    for (let i = 0; i < 8; i++) add(i === 7 ? 'Hidden renewal condition.' : 'Other material.');
    const first = body(await run({ query: 'renewal' }));
    expect(first.coverage).toMatchObject({ indexed: 5, pending: 3 }); expect(first.next_cursor).toBeTruthy();
    expect(first.partial).toBe(true);
    expect(body(await run({ query: 'other', cursor: first.next_cursor })).status).toBe('unavailable');
    const second = body(await run({ query: 'renewal', cursor: first.next_cursor }));
    expect(second.coverage).toMatchObject({ indexed: 8, pending: 0 });
    expect(second.matches[0]!.excerpt).toContain('Hidden renewal condition');
    expect(second.next_cursor).toBeUndefined();
  });

  it('withholds earlier hits when the read operation is revoked during a later read', async () => {
    add('First confidential clause.'); add('Second confidential clause.');
    await run({ query: 'confidential' });
    execute.mockImplementationOnce(executeFile).mockImplementationOnce(async request => {
      const result = await executeFile(request); readOpAllowed = false; return result;
    });
    const result = await run({ query: 'confidential' });
    expect(body(result).status).toBe('unavailable');
    expect(JSON.stringify(result)).not.toContain('confidential clause');
  });

  it('runs at most one converter per preparation batch and continues to the next document', async () => {
    add('First renewal clause.', 'application/pdf'); add('Second renewal clause.', 'application/pdf');
    const first = body(await run({ query: 'renewal' }));
    expect(first.coverage).toMatchObject({ indexed: 1, pending: 1 });
    expect(execute.mock.calls.filter(([request]) => !isMetadata(request))).toHaveLength(1);
    execute.mockClear();
    const second = body(await run({ query: 'renewal', cursor: first.next_cursor }));
    expect(second.matches).toHaveLength(2);
    expect(second.coverage).toMatchObject({ indexed: 2, pending: 0, converted: 2 });
    expect(second.partial).toBe(true);
    expect(execute.mock.calls.filter(([request]) => !isMetadata(request))).toHaveLength(1);
  });

  it('reports missing converters, unreadable sources, empty extraction and oversize files separately', async () => {
    installed = false;
    add('Document', 'application/pdf');
    const empty = add('');
    const large = add('Too large'); files.upsert({ ...large, size_bytes: 26 * 1024 * 1024 });
    const unreadable = add('Cannot read');
    execute.mockImplementation(async request => requestFile(request) === unreadable.record_id ? summary({}) : executeFile(request));
    const result = body(await run({ query: 'nothing' }));
    expect(result.coverage).toMatchObject({ missing_converter: 1, empty_extraction: 1, too_large: 1, unreadable: 1 });
    expect(result.partial).toBe(true); expect(result.hint).not.toContain('there are no matching records');
    expect(result.matches).toHaveLength(0);
    expect(files.get(empty.record_id)).not.toBeNull();
  });

  it('recovers missing-converter entries when a reader is installed and retires changed converter profiles', async () => {
    add('Renewal document.', 'application/pdf'); installed = false;
    expect(body(await run({ query: 'renewal' })).coverage.missing_converter).toBe(1);
    installed = true;
    expect(body(await run({ query: 'renewal' })).matches).toHaveLength(1);
    execute.mockClear();
    const old = manifests.get('markitdown-catalog')!;
    manifests.register({ ...old, version: 2 });
    expect(body(await run({ query: 'renewal' })).matches).toHaveLength(1);
    expect(isMetadata(execute.mock.calls[0]![0])).toBe(false);
  });

  it('searches literal reserved words and unspaced scripts without treating user text as query syntax', async () => {
    add('OR reserved word. 合同续约通知。');
    expect(body(await run({ query: 'OR' })).matches).toHaveLength(1);
    expect(body(await run({ query: '续约' })).matches).toHaveLength(1);
    expect(body(await run({ query: 'missing OR reserved' })).matches).toHaveLength(0);
    expect(body(await run({ query: '"' })).status).toBe('invalid_arguments');
  });

  it('keeps direct text independent of a missing explicitly requested converter', async () => {
    installed = false; add('Renewal clause.');
    const missing = await run({ query: 'renewal', converter: 'docling' });
    expect(missing).toMatchObject({ missing_packs: ['recued-core.docling'], result: { coverage: { missing_converter: 1 } } });
    const direct = body(await run({ query: 'renewal' }));
    expect(direct.matches[0]!.excerpt).toBe('Renewal clause.');
    expect(direct.coverage).toMatchObject({ indexed: 1, missing_converter: 0 });
    expect(direct.partial).toBe(false);
  });

  it('centres an accent-insensitive hit on the original text beyond the opening excerpt', async () => {
    const text = 'Opening material. '.repeat(1000) + 'Cafe\u0301 renewal notice.';
    add(text);
    const hit = body(await run({ query: 'cafe' })).matches[0]!;
    expect(hit.excerpt).toContain('Cafe\u0301 renewal notice.');
    expect(text).toContain(hit.excerpt);
    const accented = add('Opening material. '.repeat(1000) + 'Café renewal notice.');
    expect(body(await run({ query: 'cafe', file_refs: [accented.record_id] })).matches[0]!.excerpt).toContain('Café renewal notice.');
  });

  it('enumerates beyond one collection page and reports the scope ceiling without claiming complete coverage', async () => {
    const oldest = add('Oldest renewal notice.');
    db.transaction(() => { for (let i = 0; i < 500; i++) add('Other material.'); })();
    const first = body(await run({ query: 'renewal', scope: 'all' }));
    expect(first.matches[0]!.file_ref).toBe(oldest.record_id);
    expect(first.coverage).toMatchObject({ files_in_scope: 501, scope_limited: false });
    db.transaction(() => { for (let i = 0; i < 4500; i++) add('Other material.'); })();
    const limited = body(await run({ query: 'renewal', scope: 'all' }));
    expect(limited.coverage).toMatchObject({ files_in_scope: 5000, scope_limited: true });
    expect(limited.partial).toBe(true);
  });

  it('keeps index eviction visible as incomplete coverage and never evicts source files', async () => {
    index = createDocumentSearchIndex(db, { maxTextBytes: 35, maxEntries: 2 });
    add('First renewal clause.'); add('Second renewal clause.');
    const result = body(await run({ query: 'renewal' }));
    expect(result.coverage).toMatchObject({ indexed: 1, pending: 1 });
    expect(result.partial).toBe(true);
    expect(files.list({ platform: 'file', slug: 'received', limit: 10 })).toHaveLength(2);
  });

  it('verifies cached matches again and paginates indexed results', async () => {
    for (let i = 0; i < 3; i++) add(`Renewal paragraph ${i}.`);
    const first = body(await run({ query: 'renewal', limit: 2 }));
    expect(first.matches).toHaveLength(2); expect(first.next_offset).toBe(2);
    execute.mockClear();
    const second = body(await run({ query: 'renewal', limit: 2, offset: first.next_offset }));
    expect(second.matches).toHaveLength(1);
    expect(first.matches.map(row => row.file_ref)).not.toContain(second.matches[0]!.file_ref);
    expect(execute.mock.calls.every(([request]) => isMetadata(request))).toBe(true);
  });

  it('can restore an evicted index entry from an admitted in-memory conversion', async () => {
    index = createDocumentSearchIndex(db, { maxEntries: 1 });
    const first = add('First renewal clause.', 'application/pdf');
    const second = add('Second renewal clause.', 'application/pdf');
    const handler = buildChatTier1Handlers(deps)['document.search']!;
    const search = (ref: string) => handler({ query: 'renewal', file_refs: [ref] }, ctx);
    await search(first.record_id); await search(second.record_id); execute.mockClear();
    const result = body(await search(first.record_id));
    expect(result.matches[0]!.file_ref).toBe(first.record_id);
    expect(result.coverage).toMatchObject({ indexed: 1, pending: 0 });
    expect(execute.mock.calls.every(([request]) => isMetadata(request))).toBe(true);
  });

  it('does not advertise an unreadable pagination candidate as another match', async () => {
    const first = add('Renewal paragraph.'); const second = add('Renewal paragraph.');
    const third = add('Renewal paragraph.');
    await run({ query: 'renewal' });
    execute.mockImplementation(async request => requestFile(request) === second.record_id ? summary({}) : executeFile(request));
    const result = body(await run({ query: 'renewal', limit: 1 }));
    expect(result.matches.map(hit => hit.file_ref)).toEqual([first.record_id]);
    expect(result.matches_truncated).toBe(false);
    expect(result.next_offset).toBe(2);
    expect(result.coverage.unreadable).toBe(1); expect(result.partial).toBe(true);
    expect(body(await run({ query: 'renewal', limit: 1, offset: result.next_offset })).matches.map(hit => hit.file_ref)).toEqual([third.record_id]);
  });

  it('does not skip later matches when a cached source temporarily fails to read', async () => {
    const first = add('Renewal paragraph.'); const second = add('Renewal paragraph.'); const third = add('Renewal paragraph.');
    await run({ query: 'renewal' });
    execute.mockImplementation(async request => { if (requestFile(request) === second.record_id) throw new Error('Temporary read failure'); return executeFile(request); });
    const page = body(await run({ query: 'renewal', limit: 1 }));
    expect(page.matches.map(hit => hit.file_ref)).toEqual([first.record_id]);
    expect(page.coverage.unreadable).toBe(1);
    expect(body(await run({ query: 'renewal', limit: 1, offset: page.next_offset })).matches.map(hit => hit.file_ref)).toEqual([third.record_id]);
  });

  it('keeps the converter budget when cached candidates are evicted before verification', async () => {
    const first = add('Renewal paragraph.', 'application/pdf'); await run({ query: 'renewal', file_refs: [first.record_id] });
    const second = add('Renewal paragraph.', 'application/pdf'); await run({ query: 'renewal', file_refs: [second.record_id] });
    const third = add('Renewal paragraph.', 'application/pdf');
    const search = index.search;
    vi.spyOn(index, 'search').mockImplementationOnce((...args) => {
      const hits = search(...args); index.deleteFile(first.record_id); index.deleteFile(second.record_id); return hits;
    });
    execute.mockClear();
    const result = body(await run({ query: 'renewal' }));
    expect(execute.mock.calls.filter(([request]) => !isMetadata(request))).toHaveLength(1);
    expect(result.matches.map(hit => hit.file_ref)).toEqual([third.record_id]);
    expect(result.coverage.pending).toBe(2); expect(result.partial).toBe(true);
  });

  it('rebuilds a stale token index from saved text without reading the sources again', async () => {
    add('合同续约通知。'); await run({ query: '续约' });
    db.prepare('UPDATE document_search_fts SET text=?').run('old token format');
    db.prepare("UPDATE document_search_meta SET value=0 WHERE key='fts_format'").run();
    index = createDocumentSearchIndex(db); execute.mockClear();
    expect(body(await run({ query: '续约' })).matches).toHaveLength(1);
    expect(execute.mock.calls.every(([request]) => isMetadata(request))).toBe(true);
  });

  it('finishes an approved conversion as a bounded search result, without exposing the raw output', async () => {
    const file = add('Renewal requires sixty days notice.', 'application/pdf');
    execute.mockImplementationOnce(async () => stampExecuteResponseAuditRun({ ...summary({}), success: false, awaiting_approval: true }, 'search-held-1'));
    const held = await run({ query: 'renewal' });
    expect(held).toMatchObject({ ok: true, run_held: { kind: 'approval' }, run_id: 'search-held-1' });
    const finisher = takeResumedRunFinisher('search-held-1')!;
    expect(finisher.tool_name).toBe('document.search');
    const result = await finisher.finish(converted(textByRef.get(file.record_id)!));
    expect(body(result).matches[0]).toMatchObject({ file_ref: file.record_id, excerpt: 'Renewal requires sixty days notice.' });
    expect(JSON.stringify(result)).not.toContain('bytes_b64');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('withholds approved text when access is revoked while the converter waits', async () => {
    add('Secret approval text.', 'application/pdf');
    execute.mockImplementationOnce(async () => stampExecuteResponseAuditRun({ ...summary({}), success: false, awaiting_approval: true }, 'search-held-2'));
    await run({ query: 'secret' });
    allowed = false;
    const result = await takeResumedRunFinisher('search-held-2')!.finish(converted('Secret approval text.'));
    expect(JSON.stringify(result)).not.toContain('Secret approval text');
    expect(body(result).matches).toEqual([]);
    expect(index.states(documentIndexAuthority(ctx))).toHaveLength(0);
  });

  it('withholds a library match archived while its conversion awaits approval', async () => {
    const file = add('Renewal terms.', 'application/pdf');
    deps.getCollectionRegistry()!.get('file', 'received')!.list = query => files.list(query).filter(row => row.hot_fields.archived !== 1);
    execute.mockImplementationOnce(async () => stampExecuteResponseAuditRun({ ...summary({}), success: false, awaiting_approval: true }, 'search-archived'));
    await run({ query: 'renewal', scope: 'all' });
    files.upsert({ ...file, hot_fields: { ...file.hot_fields, archived: 1 } });
    const result = body(await takeResumedRunFinisher('search-archived')!.finish(converted('Renewal terms.')));
    expect(result.matches).toEqual([]);
    expect(result.coverage.scope_changed).toBe(true); expect(result.partial).toBe(true);
  });

  it.each(['open', 'get', 'put'] as const)('still reads a document when the optional search cache fails to %s', async operation => {
    const file = add('Readable renewal terms.');
    if (operation === 'open') deps.getDocumentSearchIndex = () => { throw new Error('Index unavailable'); };
    else vi.spyOn(index, operation).mockImplementation(() => { throw new Error('Index unavailable'); });
    const result = await buildChatTier1Handlers(deps)['document.read']!({ file_ref: file.record_id }, ctx);
    expect(result).toMatchObject({ ok: true, result: { status: 'read', body: 'Readable renewal terms.', search_index_unavailable: true } });
    if (operation === 'put') {
      expect(await run({ query: 'renewal' })).toMatchObject({ result: { index_unavailable: true, partial: true, coverage: { unreadable: 1 } } });
    }
  });

  it('persists searchable text only inside the encrypted realm database and survives reopening', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'recued-document-index-'));
    const path = join(directory, 'realm.db'), key = randomBytes(32);
    const secret = 'PRIVATE_DOCUMENT_TEXT_42f96d61 cancellation notice';
    let encrypted: Database.Database | undefined;
    try {
      encrypted = await openDatabase(path, { databaseKey: key });
      const stored = createDocumentSearchIndex(encrypted);
      stored.put({ authority: 'owner', fingerprint: 'fingerprint', file_ref: 'file:11111111111111111111111111111111', content_hash: sha(secret),
        text: secret, status: 'indexed', converter: 'text', read_version: sha(secret), extraction_complete: true, updated_at: 1 });
      encrypted.close(); encrypted = undefined;
      const bytes = readFileSync(path);
      expect(bytes.includes(Buffer.from(secret))).toBe(false);
      expect(bytes.subarray(0, 16).toString()).not.toBe('SQLite format 3\u0000');
      encrypted = await openDatabase(path, { databaseKey: key });
      const reopened = createDocumentSearchIndex(encrypted);
      expect(reopened.search('owner', ['fingerprint'], 'cancellation', 10)[0]?.text).toBe(secret);
    } finally { encrypted?.close(); key.fill(0); rmSync(directory, { recursive: true, force: true }); }
  });

  it('searches immutable conversation versions and removes their text when the last binding is released', async () => {
    const original = add('Retained cancellation terms.');
    const lifecycle = createFileAttachmentLifecycle(db);
    lifecycle.register('received', files.tableName);
    const prepared = lifecycle.prepare([{ file_id: original.record_id, media_class: 'document' }]);
    lifecycle.bind('message', 'message-1', 'chat-1', prepared);
    const retained = prepared.files[0]!.attachment.file_id;
    deps.getCollectionRegistry()!.get('file', 'received')!.get = id => lifecycle.getVersion(id) ?? files.get(id);
    attached = [retained]; textByRef.set(retained, textByRef.get(original.record_id)!);
    files.upsert({ ...original, blob_hash: sha('Replacement'), hot_fields: { ...original.hot_fields, content_hash: sha('Replacement'), archived: 1 } });
    const result = body(await run({ query: 'cancellation' }));
    expect(result.matches[0]!.file_ref).toBe(retained);
    expect(result.matches[0]!.content_hash).toBe(original.blob_hash);
    db.prepare('DELETE FROM file_attachment_bindings WHERE owner_id=?').run('message-1');
    expect(lifecycle.getVersion(retained)).toBeNull();
    expect(index.states(documentIndexAuthority(ctx))).toHaveLength(0);
    expect(db.prepare('SELECT count(*) AS n FROM document_search_fts').get()).toEqual({ n: 0 });
  });

  it('discovers and calls the same search through the MCP adapter with external authority intact', async () => {
    add('External renewal lookup.');
    const source = { channel: 'mcp' as const, actor: 'contracted_user' as const, agent_id: 'agent', contract_id: 'customer', mcp_token_id: 'token', tool_call_id: 'tool-1' };
    const snapshot = { contract_id: 'customer', contract_version: 'v1', allowed_tools: [], approval_required: [], scope_restrictions: [], resolved_at: 1 };
    const adapter = buildInternalToolMcpAdapter({ registry: createInternalToolRegistry({ tier1Handlers: buildChatTier1Handlers(deps) }),
      mcp_token_id: 'token', execution_source: source, contract_snapshot: snapshot });
    expect(adapter.listTools().find(tool => tool.name === 'document.search')?._meta.classification).toBe('read');
    expect(body(await adapter.callTool('document.search', { query: 'renewal' })).status).toBe('unavailable');
    const result = body(await adapter.callTool('document.search', { query: 'renewal', scope: 'all' }));
    expect(result.matches).toHaveLength(1);
    expect(execute.mock.calls[0]![0]).toMatchObject({ execution_source: source, contract_snapshot: snapshot, trigger_source: 'mcp' });
  });
});
