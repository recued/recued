/** Real owner Chat, encrypted persistence, native work reader and privacy.
 * Scripted models deliberately request no tools: preparation must do the read. */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TIER1_TOOL_DESCRIPTORS, type ChatDispatchContext, type ChatDispatchResult, type InternalToolRegistry, type ToolEntry } from '@recued/contracts';
import { piiEgress } from '@recued/gateway';
import { assetChatMessage } from '../../../../apps/webclient/src/chat/asset-context.js';
import { createChatOrchestrator, type BroadcastChatEvent } from '../chat-orchestrator.js';
import { buildChatTier1Handlers, isCollectionReadGrantedForDispatch, type ChatToolHandlerDeps } from '../chat-tool-handlers.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createReadGrantChecker } from '../read-grant-checker.js';
import { createContactStore } from '../storage/contact-store.js';
import { createContactKnownValueIndexBuilder } from '../chat-recall-index.js';
import { createMetaFieldPrivacyResolverFromLocalManifestStore } from '../meta-field-privacy-resolver.js';
import { createLocalManifestStore } from '../ingredient-authoring/local-manifest-store.js';
import { CANONICAL_PII_CATALOG_MANIFESTS, CANONICAL_PII_ENTITY_PRIVACY_TAGS, CANONICAL_PII_ENTITY_SCHEMAS } from '../canonical-pii-schemas.js';
import { sourceCitation, sourceCitationHint } from '../chat-source-citations.js';
import { withQueuedChatTurns } from '../chat-turn-queue.js';
import { localAssetReadVersion } from '../chat-asset-read-reuse.js';

const ASSET = 'asset:preparation';
const FILE = 'file:' + 'a'.repeat(32);
const PRIVATE_NAME = 'Mara Vale';
const PRIVATE_EMAIL = 'mara.vale@private.example';
const NOW = Date.parse('2026-10-24T12:00:00Z');
const disposals: Array<() => void> = [];
afterEach(() => { disposals.splice(0).forEach(close => close()); });

const fixture = (reuse = false) => {
  const db = new Database(':memory:'); disposals.push(() => db.close());
  ensureChatSchema(db); ensureWorkEntitySchema(db);
  const store = createChatStore(db, () => new Uint8Array(32).fill(31), () => undefined);
  store.createSession({ id: 's' }); store.setRollingBriefEnabled(true);
  const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const contacts = createContactStore(db);
  const person = contacts.upsertManual({ name: PRIVATE_NAME, email: PRIVATE_EMAIL }, NOW);
  work.writeAsset({ id: ASSET, source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' },
    name: 'Preparation hose', holder_contact: person.contact_id!, attributes: { length: 'about 25 meters' } }, NOW);
  const control = { allowed: true, opAllowed: true, linked: true, beforeRead: undefined as (() => Promise<void>) | undefined,
    afterAsset: undefined as (() => void) | undefined, afterDocument: undefined as (() => void) | undefined,
    documentStatus: 'read', partial: false, retryFirst: false, tier: 1 as 1 | 2, repeats: 0,
    beforeReply: undefined as (() => void) | undefined, mixedBatch: false,
    afterValidation: undefined as (() => Promise<void>) | undefined };
  const checker = createReadGrantChecker({ isGranted: () => control.allowed }, 'owner');
  const deps: ChatToolHandlerDeps = { getCollectionRegistry: () => undefined, getContactStore: () => contacts,
    getAuditLog: () => undefined, getEnrichmentStore: () => undefined,
    getRecipeStore: () => { throw new Error('Unexpected recipe'); }, getExecutorConfig: () => { throw new Error('Unexpected execution'); },
    getExecuteRecipe: () => undefined, getWorkEntityResolver: () => createWorkEntityResolver(work),
    getReadGrantResolver: () => ({ resolveForSource: () => checker, resolveForContract: () => checker }),
    getOpAdmissionGate: () => ({ isOpGranted: () => control.opAllowed, isFrozenByPause: () => false,
      isOwnerRecipeGranted: () => false, isOwnerGoverned: () => true }), now: () => NOW };
  const handlers = buildChatTier1Handlers(deps);
  const catalog: ToolEntry[] = (['work.read', 'document.read'] as const).map(name => ({ ...TIER1_TOOL_DESCRIPTORS[name], tier: 1 }));
  const dispatches: Array<{ name: string; args: unknown; ctx: ChatDispatchContext }> = [];
  const packets: Record<string, any>[] = [];
  const briefPackets: Record<string, any>[] = [];
  const events: BroadcastChatEvent[] = [];
  const order: string[] = [];
  let validations = 0;
  const registry: InternalToolRegistry = { list: () => catalog, listByTier: () => catalog,
    getByName: name => {
      const entry = catalog.find(row => row.name === name);
      return entry ? { ...entry, tier: name === 'work.read' ? control.tier : entry.tier } : null;
    }, subscribeRefresh: () => () => {},
    dispatch: async (name, args, ctx): Promise<ChatDispatchResult> => {
      dispatches.push({ name, args, ctx }); order.push(name); await control.beforeRead?.();
      if (name === 'work.read') {
        const result = await handlers['work.read']!(args, ctx);
        control.afterAsset?.(); return result;
      }
      if (!isCollectionReadGrantedForDispatch(deps, ctx, 'file')) return { ok: false, reason: 'kind_gated' };
      if (control.documentStatus === 'held') return { ok: true, run_id: 'held-document', run_held: { kind: 'approval' }, result: { status: 'held' } };
      if (control.documentStatus !== 'read') return { ok: true, result: { status: control.documentStatus } };
      const citation = sourceCitation({ kind: 'file', file_ref: FILE, collection_slug: 'received' },
        'Measurement note', 'b'.repeat(64), NOW);
      control.afterDocument?.();
      return { ok: true, source_citations: [citation], result: { status: 'read', file_ref: FILE,
        body: `Old measurement: 24 meters. Contact ${PRIVATE_NAME} at ${PRIVATE_EMAIL}.`,
        next_offset: control.partial ? 24000 : null, text_incomplete: control.partial, ...sourceCitationHint(citation) } };
    } };
  const orchestrator = createChatOrchestrator({ chatStore: store, registry,
    ...(reuse ? { revalidateAssetRead: async (id: string, version: string, ctx: ChatDispatchContext) => {
      validations += 1;
      const current = localAssetReadVersion(id, await handlers['work.read']!({ kind: 'asset', id }, ctx)) === version;
      await control.afterValidation?.();
      return current;
    } } : {}),
    currentAssetAttachment: () => control.linked,
    piiLedgerStore: piiEgress.createSessionLedgerStore(),
    getContactKnownValueIndex: createContactKnownValueIndexBuilder(() => contacts),
    fieldPrivacyResolver: createMetaFieldPrivacyResolverFromLocalManifestStore(createLocalManifestStore(db),
      CANONICAL_PII_ENTITY_SCHEMAS, CANONICAL_PII_CATALOG_MANIFESTS, CANONICAL_PII_ENTITY_PRIVACY_TAGS),
    selfSignature: { server_kind: 'recued', version: 'test', instance_id: 'test' },
    broadcast: { emit: event => { events.push(event); } }, now: () => NOW,
    executeAiCall: async (_manifest, input) => {
      const packet = JSON.parse(String(input['llm.prompt']));
      if ('tool_results_since' in packet) {
        order.push('brief'); briefPackets.push(packet);
        return { body: { intent: 'Read the selected current sources',
          constraints: packet.user_request.includes('amber falcon') ? ['Use amber falcon as the chat reference phrase.'] : [],
          findings: [], pending: [], completed: [] } };
      }
      order.push('model'); packets.push(packet);
      control.beforeReply?.();
      if (control.retryFirst && packets.length === 1) return { body: { response: 42, tool_calls: [], events: [] } };
      const read = packet.prior_tool_calls?.findLast((call: any) => call.tool_name === 'work.read');
      if (packets.length <= control.repeats && read) return { body: { response: '', events: [],
        tool_calls: [{ tool: 'work.read', args: read.args },
          ...(control.mixedBatch && packets.length === 1 ? [{ tool: 'unknown.operation', args: {} }] : [])] } };
      const length = read?.result?.entity?.attributes?.length;
      return { body: { response: length ? `Saved length: ${length} [source](${read.result.source_ref}).` : 'No current source.',
        events: [], tool_calls: [] } };
    },
  });
  const message = (question = 'What length is saved?', ids = [FILE]) =>
    assetChatMessage(question, { id: ASSET, name: 'Preparation hose', fileIds: ids, omittedFiles: 0 });
  const send = async (text = message(), extra = {}) => {
    const ack = await orchestrator.runTurn({ session_id: 's', message: text, picker_state: { current: 'self' }, ...extra });
    return (await store.listMessages('s')).find(row => row.role === 'assistant' && row.turn_id === ack.turn_id)!;
  };
  return { db, store, work, control, registry, orchestrator, message, send, packets, briefPackets, dispatches, events, order,
    validations: () => validations };
};

describe('selected asset preparation through owner Chat', () => {
  it('revalidates repeated reads without recording or dispatching the same Chat tool twice', async () => {
    const f = fixture(true); f.control.repeats = 2;
    const answer = await f.send(); expect(answer.content).toContain('about 25 meters');
    expect(f.dispatches).toHaveLength(1); expect(f.validations()).toBe(2);
    expect(f.packets).toHaveLength(3); expect(f.packets[1]!.output_feedback).toContain('source version were rechecked');
    expect(f.packets[2]!.prior_tool_calls.filter((call: any) => call.tool_name === 'work.read')).toHaveLength(1);
    expect(answer.tool_calls).toHaveLength(1); expect(f.briefPackets).toHaveLength(1);
  });

  it('dispatches a new current read after an owner edit between model rounds', async () => {
    const f = fixture(true); f.control.repeats = 1;
    f.control.beforeReply = () => { if (f.packets.length === 1) f.work.writeAsset({ id: ASSET,
      source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' }, attributes: { length: 'around 31 meters' } }, NOW + 1); };
    expect((await f.send()).content).toContain('around 31 meters');
    expect(f.dispatches).toHaveLength(2); expect(f.validations()).toBe(1);
    expect(f.packets[1]!.prior_tool_calls.filter((call: any) => call.tool_name === 'work.read')).toHaveLength(2);
  });

  it.each(['collection', 'operation'] as const)('rechecks %s grants before suppressing a duplicate', async grant => {
    const f = fixture(true); f.control.repeats = 1;
    f.control.beforeReply = () => { if (grant === 'collection') f.control.allowed = false; else f.control.opAllowed = false; };
    const answer = await f.send(); expect(answer.content).not.toContain('25 meters');
    expect(f.validations()).toBe(1); expect(f.dispatches).toHaveLength(2);
  });

  it('checks the full native result version even when the asset timestamp stays unchanged', async () => {
    const f = fixture(true); f.control.repeats = 1;
    f.control.beforeReply = () => { if (f.packets.length === 1) {
      f.work.writeAsset({ id: ASSET, source_id: 'recued.asset',
        source: { kind: 'owner', ref: 'owner' }, attributes: { length: 'about 42 meters' } }, NOW);
    } };
    await f.send();
    const before = f.packets[0]!.prior_tool_calls[0].result;
    const after = f.packets[1]!.prior_tool_calls.at(-1).result;
    expect(after.entity.updated_at).toBe(before.entity.updated_at);
    expect(after.read_version).not.toBe(before.read_version);
    expect(f.dispatches).toHaveLength(2); expect(f.validations()).toBe(1);
    expect(after.entity.attributes.length).toBe('about 42 meters');
  });

  it('invalidates prior reads for the whole mixed batch and does not remember its read', async () => {
    const f = fixture(true); f.control.repeats = 2; f.control.mixedBatch = true;
    expect((await f.send()).content).toContain('about 25 meters');
    expect(f.dispatches.filter(call => call.name === 'work.read')).toHaveLength(3);
    expect(f.validations()).toBe(0);
  });

  it('stops after cancellation during version validation without another model call or answer', async () => {
    const f = fixture(true); f.control.repeats = 1; let release!: () => void; let finished!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const settled = new Promise<void>(resolve => { finished = resolve; });
    f.control.afterValidation = () => blocked;
    const queued = withQueuedChatTurns({ ...f.orchestrator, runTurn: async input => {
      try { return await f.orchestrator.runTurn(input); } finally { finished(); }
    } }, { db: f.db, store: f.store, pollMs: 5 });
    try {
      const turn = queued.runTurn({ session_id: 's', message: f.message(), picker_state: { current: 'self' } });
      await vi.waitFor(() => expect(f.validations()).toBe(1));
      const [running] = (await queued.turnQueue!.snapshot('s')).turns;
      await queued.turnQueue!.cancel('s', running!.turn_id); release(); await turn; await settled;
      expect(f.packets).toHaveLength(1); expect(f.dispatches).toHaveLength(1);
      expect((await f.store.listMessages('s')).filter(row => row.role === 'assistant')).toEqual([]);
    } finally { release(); queued.turnQueue!.close(); await new Promise(resolve => setImmediate(resolve)); }
  });

  it('reads the real current asset before the first model call, retaining citations and normal closing capture', async () => {
    const f = fixture(); const answer = await f.send();
    expect(f.order).toEqual(['work.read', 'model', 'brief']);
    expect(answer.content).toContain('about 25 meters');
    expect(answer.source_citations).toEqual([expect.objectContaining({ kind: 'asset', asset_id: ASSET })]);
    expect(f.dispatches[0]?.ctx.execution_source).toMatchObject({ channel: 'chat', actor: 'user_self', chat_session_id: 's' });
    expect(f.dispatches[0]?.ctx.dispatch_depth).toBe(0);
    expect(await f.store.readSessionBrief('s')).toContain('Read the selected current sources');
  });

  it('reads a single requested current attachment, aliases its contents, and keeps source kinds distinct', async () => {
    const f = fixture(); const answer = await f.send(f.message('Compare the saved length with the attached note.'));
    expect(f.order).toEqual(['work.read', 'document.read', 'model', 'brief']);
    expect(JSON.stringify(f.packets)).not.toContain(PRIVATE_NAME);
    expect(JSON.stringify(f.packets)).not.toContain(PRIVATE_EMAIL);
    const calls = f.packets[0]!.prior_tool_calls;
    expect(calls.map((call: any) => call.result.source_kind)).toEqual(['asset', 'file']);
    expect(calls[1].result.read_version).toBe('b'.repeat(64));
    expect(answer.source_citations?.map(source => source.kind).sort()).toEqual(['asset', 'file']);
  });

  it('does not automatically open files that are not requested or have an ambiguous roster', async () => {
    const f = fixture();
    await f.send();
    await f.send(f.message('Read the attached notes.', [FILE, 'file:' + 'c'.repeat(32)]));
    expect(f.dispatches.map(call => call.name)).toEqual(['work.read', 'work.read']);
  });

  it('rereads after correction rather than treating an earlier answer or brief as current', async () => {
    const f = fixture(); await f.send();
    f.work.writeAsset({ id: ASSET, source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' },
      attributes: { length: 'around 31 meters' } }, NOW + 1);
    expect((await f.send()).content).toContain('around 31 meters');
    expect(f.dispatches.filter(call => call.name === 'work.read')).toHaveLength(2);
  });

  it('retains fresh observations across a malformed-model retry without repeating source dispatch', async () => {
    const f = fixture(); f.control.retryFirst = true;
    expect((await f.send()).content).toContain('about 25 meters');
    expect(f.packets).toHaveLength(2);
    expect(f.packets[1]!.prior_tool_calls).toMatchObject([{ tool_name: 'work.read', status: 'ok' }]);
    expect(f.dispatches).toHaveLength(1);
  });

  it('preserves a document page boundary instead of claiming the whole file was read', async () => {
    const f = fixture(); f.control.partial = true;
    await f.send(f.message('Read the attached document.'));
    const read = f.packets[0]!.prior_tool_calls.find((call: any) => call.tool_name === 'document.read');
    expect(read.result).toMatchObject({ next_offset: 24000, text_incomplete: true, read_version: 'b'.repeat(64) });
    expect(f.dispatches).toHaveLength(2);
  });

  it.each(['collection', 'operation'] as const)('stops before the answer model when native %s grants deny the read', async kind => {
    const f = fixture();
    if (kind === 'collection') f.control.allowed = false;
    else f.control.opAllowed = false;
    expect((await f.send()).content).toContain('could not read');
    expect(f.dispatches).toHaveLength(1);
    expect(f.packets).toHaveLength(0);
  });

  it('captures new owner statements durably even when the current source read fails', async () => {
    const f = fixture(); f.control.allowed = false;
    const message = f.message('Use amber falcon as our chat reference phrase. What length is saved?');
    expect((await f.send(message)).content).toContain('could not read');
    expect(f.order).toEqual(['work.read', 'brief']);
    expect(f.packets).toHaveLength(0);
    expect(f.briefPackets[0]!.user_request).toBe(message);
    const reopened = createChatStore(f.db, () => new Uint8Array(32).fill(31), () => undefined);
    expect(await reopened.readSessionBrief('s')).toContain('Use amber falcon as the chat reference phrase.');
  });

  it('rechecks file grants when access changes after the asset read', async () => {
    const f = fixture(); f.control.afterAsset = () => { f.control.allowed = false; };
    expect((await f.send(f.message('Read the attached note.'))).content).toContain('could not finish reading');
    expect(f.packets).toHaveLength(0);
    expect(f.dispatches.map(call => call.name)).toEqual(['work.read', 'document.read']);
  });

  it.each(['before', 'during'] as const)('does not compare a file detached %s reading', async timing => {
    const f = fixture();
    if (timing === 'before') f.control.linked = false;
    else f.control.afterDocument = () => { f.control.linked = false; };
    const answer = await f.send(f.message('Compare with the attached note.'));
    expect(answer.content).toContain('linked file list changed');
    expect(f.packets).toHaveLength(0);
    expect(f.dispatches).toHaveLength(timing === 'before' ? 1 : 2);
  });

  it.each(['unavailable', 'needs_pack', 'held'] as const)('does not answer from older context after document status %s', async status => {
    const f = fixture(); f.control.documentStatus = status;
    expect((await f.send(f.message('Read the attached note.'))).content).toContain('could not finish reading');
    expect(f.packets).toHaveLength(0);
  });

  it.each(['ordinary', 'future', 'extended', 'special', 'non-native'] as const)('keeps %s input on normal model-led retrieval', async kind => {
    const f = fixture();
    if (kind === 'non-native') f.control.tier = 2;
    const text = kind === 'ordinary' ? 'What length is saved?' : kind === 'future' ? f.message().replace('"version":1', '"version":2')
      : kind === 'extended' ? f.message() + '\nDo something else.' : f.message();
    await f.send(text, kind === 'special' ? { read_only: true } : {});
    expect(f.dispatches).toHaveLength(0);
    expect(f.packets).toHaveLength(1);
  });

  it('does not call the model or finalize an answer after cancellation during preparation', async () => {
    const f = fixture(); let release!: () => void; let finished!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const settled = new Promise<void>(resolve => { finished = resolve; });
    f.control.beforeRead = () => blocked;
    const queued = withQueuedChatTurns({ ...f.orchestrator, runTurn: async input => {
      try { return await f.orchestrator.runTurn(input); } finally { finished(); }
    } }, { db: f.db, store: f.store, pollMs: 5 });
    try {
      const turn = queued.runTurn({ session_id: 's', message: f.message(), picker_state: { current: 'self' } });
      await vi.waitFor(() => expect(f.dispatches).toHaveLength(1));
      const [running] = (await queued.turnQueue!.snapshot('s')).turns;
      await queued.turnQueue!.cancel('s', running!.turn_id); release(); await turn; await settled;
      expect(f.packets).toHaveLength(0);
      expect((await f.store.listMessages('s')).filter(row => row.role === 'assistant')).toEqual([]);
      expect(f.events.some(event => event.kind === 'chat.token_streamed')).toBe(false);
    } finally { release(); queued.turnQueue!.close(); await new Promise(resolve => setImmediate(resolve)); }
  });
});
