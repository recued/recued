import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OWNER_CONTRACT_ID, TIER1_TOOL_DESCRIPTORS, type ChatDispatchContext, type ChatSourceCitation, type InternalToolRegistry, type ToolEntry } from '@recued/contracts';
import { piiEgress } from '@recued/gateway';
import { projectionRefreshRequests, MAX_PROJECTION_REFRESH_READS, createProjectionDemand, createProjectionVersionProbe } from '../chat-projection-refresh.js';
import { sourceCitation } from '../chat-source-citations.js';
import { createChatOrchestrator } from '../chat-orchestrator.js';
import { withQueuedChatTurns } from '../chat-turn-queue.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createReminderStore } from '../storage/reminder-store.js';
import { createContractStore } from '../storage/contract-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import { buildSituationSources, situationSourceAccess } from '../situations/sources.js';
import { createSituationQuery } from '../situations/query.js';
import { createSituationAccess } from '../situations/access.js';
import { createAssetFactContextReader } from '../situations/asset-fact-context.js';
import { buildChatTier1Handlers, type ChatToolHandlerDeps } from '../chat-tool-handlers.js';
import { createMetaFieldPrivacyResolverFromLocalManifestStore } from '../meta-field-privacy-resolver.js';
import { createLocalManifestStore } from '../ingredient-authoring/local-manifest-store.js';
import { CANONICAL_PII_CATALOG_MANIFESTS, CANONICAL_PII_ENTITY_PRIVACY_TAGS, CANONICAL_PII_ENTITY_SCHEMAS } from '../canonical-pii-schemas.js';

const NOW = Date.parse('2026-10-25T12:00:00Z');
const ID = 'asset:refresh';
const projection = (id = ID, field = 'readings.length', at = NOW) => sourceCitation({ kind: 'asset_projection', asset_id: id,
  projection: { kind: 'field', field } }, 'Saved length', 'a'.repeat(64), at);
const link = (source: { id: string }) => `[saved](#source/${source.id})`;
const answer = (source: { id: string }) => ({ role: 'assistant', content: link(source) });
const fieldRequest = { context: { root: { kind: 'field', asset_id: ID, group: 'readings', field: 'length' } } };

describe('kept projection refresh selection', () => {
  it('uses only kept native projection identities referenced by the latest answer or carried brief', () => {
    const source = projection(); const other = projection('asset:other');
    expect(projectionRefreshRequests([source, other], [answer(source)], null, NOW)).toEqual({ requests: [fieldRequest], omitted: 0 });
    expect(projectionRefreshRequests([source], [], { findings: [link(source)] }, NOW).requests).toEqual([fieldRequest]);
    expect(projectionRefreshRequests([source], [answer(source), { role: 'assistant', content: 'New unrelated answer' }], null, NOW).requests).toEqual([]);
    expect(projectionRefreshRequests([], [answer(source)], null, NOW).requests).toEqual([]);
  });

  it('does not discover identities from user/tool prose, plain IDs, files or full-asset citations', () => {
    const source = projection(); const full = sourceCitation({ kind: 'asset', asset_id: ID }, 'Full', 'a'.repeat(64), NOW);
    for (const tail of [[{ role: 'user', content: link(source) }], [{ role: 'tool', content: link(source) }], [{ role: 'assistant', content: ID }]])
      expect(projectionRefreshRequests([source], tail, null, NOW).requests).toEqual([]);
    expect(projectionRefreshRequests([full], [answer(full)], null, NOW).requests).toEqual([]);
    expect(projectionRefreshRequests([{ ...source, projection: { kind: 'field', field: 'readings.__proto__' } }], [answer(source)], null, NOW).requests).toEqual([]);
  });

  it('deduplicates versions of each scope, preserves field scope, and bounds automatic reads', () => {
    const first = projection(); const newer = { ...first, id: 'src_' + 'b'.repeat(24), read_at: NOW + 1 };
    expect(projectionRefreshRequests([first, newer], [{ role: 'assistant', content: link(first) + link(newer) }], null, NOW).requests).toEqual([fieldRequest]);
    const many = Array.from({ length: MAX_PROJECTION_REFRESH_READS + 2 }, (_, i) => projection(`asset:${i}`));
    const selected = projectionRefreshRequests(many, [{ role: 'assistant', content: many.map(link).join(' ') }], null, NOW);
    expect(selected.requests).toHaveLength(MAX_PROJECTION_REFRESH_READS); expect(selected.omitted).toBe(2);
  });

  it('keeps details a bounded subject query rather than a complete asset read', () => {
    const source = sourceCitation({ kind: 'asset_projection', asset_id: ID, projection: { kind: 'details' } }, 'Saved facts', 'b'.repeat(64), NOW);
    expect(projectionRefreshRequests([source], [answer(source)], null, NOW).requests).toEqual([
      { time: NOW, subjects: [{ collection: 'asset', id: ID }], limit_clusters: 1, limit_items: 8 },
    ]);
  });
});

describe('projection demand version checks', () => {
  const result = (source = projection()) => ({ ok: true as const, source_citations: [source], result: {} });
  it('does not read because a kept source exists without actual draft use', async () => {
    const read = vi.fn(async () => result());
    expect(await createProjectionDemand([projection()]).check('We can keep talking.', [], read, NOW)).toEqual({ revise: false, limited: false });
    expect(read).not.toHaveBeenCalled();
  });
  it('uses an exact current scope receipt without an additional query', async () => {
    const source = projection(); const read = vi.fn(async () => result());
    expect(await createProjectionDemand([source]).check(link(source), [{ ...source, read_at: NOW + 1 }], read, NOW)).toEqual({ revise: false, limited: false });
    expect(read).not.toHaveBeenCalled();
  });
  it('validates unchanged versions through a single native query, not timestamps', async () => {
    const source = projection(); const read = vi.fn(async () => result()); const demand = createProjectionDemand([source]);
    expect((await demand.check(link(source), [], read, NOW)).revise).toBe(false);
    await demand.check(link(source), [], read, NOW); expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(fieldRequest);
  });
  it('revises a draft when the exact value version changes despite the same read time', async () => {
    const source = projection(); const changed = { ...source, read_version: 'b'.repeat(64) };
    const read = vi.fn(async () => result(changed));
    expect((await createProjectionDemand([source]).check(link(source), [], read, NOW)).revise).toBe(true);
  });
  it('does not reuse a draft that names the old read clock', async () => {
    const source = projection(); const read = vi.fn(async () => result({ ...source, read_at: NOW + 1 }));
    expect((await createProjectionDemand([source]).check(link(source) + ` read_at ${NOW}`, [], read, NOW)).revise).toBe(true);
  });
  it('does not widen a field receipt to a different asset or scope', async () => {
    const source = projection(); const read = vi.fn(async () => result());
    await createProjectionDemand([source]).check(link(source), [projection('asset:other'), projection(ID, 'attributes.length')], read, NOW);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it.each(['failed', 'held', 'unattested'] as const)('requires a revised answer for %s current evidence', async kind => {
    const source = projection(); const read = async () => kind === 'failed' ? { ok: false as const, reason: 'execution_error' as const }
      : kind === 'held' ? { ...result(), run_held: { kind: 'approval' as const } } : { ok: true as const, result: { refused: true } };
    expect((await createProjectionDemand([source]).check(link(source), [], read, NOW)).revise).toBe(true);
  });
  it('revalidates a previously checked scope after a write barrier', async () => {
    const source = projection(); let current = source;
    const read = vi.fn(async () => result(current)); const demand = createProjectionDemand([source]);
    expect((await demand.check(link(source), [], read, NOW)).revise).toBe(false);
    current = { ...source, read_version: 'b'.repeat(64) }; demand.invalidate();
    expect((await demand.check(link(source), [], read, NOW)).revise).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('keeps the read cap across write invalidation', async () => {
    const sources = Array.from({ length: MAX_PROJECTION_REFRESH_READS + 1 }, (_, i) => projection(`asset:${i}`));
    const read = vi.fn(async () => ({ ok: true as const, result: { refused: true } }));
    const demand = createProjectionDemand(sources);
    await demand.check(sources.slice(0, MAX_PROJECTION_REFRESH_READS).map(link).join(' '), [], read, NOW);
    demand.invalidate(); expect((await demand.check(link(sources.at(-1)!), [], read, NOW)).limited).toBe(true);
    expect(read).toHaveBeenCalledTimes(MAX_PROJECTION_REFRESH_READS);
  });

  it('validates through a probe without recording a result or changing the original read clock', async () => {
    const source = projection(); const read = vi.fn(async () => result());
    const probe = vi.fn(async () => true); const demand = createProjectionDemand([source]);
    expect(await demand.check(link(source) + ` read_at ${source.read_at}`, [], read, NOW + 1000, probe)).toEqual({ revise: false, limited: false });
    await demand.check(link(source), [], read, NOW + 1000, probe);
    expect(probe).toHaveBeenCalledTimes(1); expect(probe).toHaveBeenCalledWith(source);
    expect(read).not.toHaveBeenCalled();
  });

  it('skips a probe when exact current evidence is already exposed', async () => {
    const source = projection(); const read = vi.fn(async () => result()); const probe = vi.fn(async () => true);
    await createProjectionDemand([source]).check(link(source), [source], read, NOW, probe);
    expect(probe).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
  });

  it('falls back to ordinary dispatch on a changed probe', async () => {
    const source = projection(); const read = vi.fn(async () => result({ ...source, read_version: 'b'.repeat(64) }));
    const probe = vi.fn(async () => false);
    expect((await createProjectionDemand([source]).check(link(source), [], read, NOW, probe)).revise).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1); expect(read).toHaveBeenCalledWith(fieldRequest);
  });

  it('bounds successful probes across write invalidation', async () => {
    const source = projection(); const demand = createProjectionDemand([source]);
    const probe = vi.fn(async () => true); const read = vi.fn(async () => result());
    for (let i = 0; i < MAX_PROJECTION_REFRESH_READS; i++) {
      expect((await demand.check(link(source), [], read, NOW, probe)).limited).toBe(false); demand.invalidate();
    }
    expect((await demand.check(link(source), [], read, NOW, probe)).limited).toBe(true);
    expect(probe).toHaveBeenCalledTimes(MAX_PROJECTION_REFRESH_READS); expect(read).not.toHaveBeenCalled();
  });
});

describe('governed native projection version probe', () => {
  const ctx: ChatDispatchContext = { channel: 'internal_function_call', session_id: 'probe', turn_id: 'probe' };
  it('uses the exact native field query and rechecks admission after it returns', async () => {
    let admitted = true;
    const query = vi.fn(async () => { admitted = false; return { ok: true as const, result: {}, source_citations: [projection()] }; });
    const probe = createProjectionVersionProbe({ query, admit: () => admitted, now: () => NOW });
    expect(await probe(projection(), ctx)).toBe(false); expect(query).toHaveBeenCalledWith(fieldRequest, ctx);
    await probe(projection(), ctx); expect(query).toHaveBeenCalledTimes(1);
  });

  it.each(['failed', 'held', 'run_failed', 'unattested', 'asset', 'scope', 'version'] as const)('does not accept %s evidence', async kind => {
    const current = projection(kind === 'asset' ? 'asset:other' : ID, kind === 'scope' ? 'readings.width' : 'readings.length');
    const query = vi.fn(async () => kind === 'failed' ? { ok: false as const, reason: 'execution_error' as const }
      : { ok: true as const, result: kind === 'held' ? { awaiting_approval: true } : {},
        ...(kind === 'run_failed' ? { run_failed: { detail: 'Failed native read' } } : {}),
        ...(kind === 'unattested' ? {} : { source_citations: [kind === 'version' ? { ...current, read_version: 'b'.repeat(64) } : current] }) });
    const probe = createProjectionVersionProbe({ query, admit: () => true, now: () => NOW });
    expect(await probe(projection(), ctx)).toBe(false);
  });
});

const dispose: Array<() => void> = [];
afterEach(() => { dispose.splice(0).forEach(close => close()); });
let sequence = 0;
const fixture = (details = false, probeEnabled = false) => {
  const clock = { time: NOW };
  const db = new Database(':memory:'); dispose.push(() => db.close()); ensureChatSchema(db); ensureWorkEntitySchema(db);
  const store = createChatStore(db, () => new Uint8Array(32).fill(29), () => undefined);
  const sid = `projection-refresh-${++sequence}`; store.createSession({ id: sid }); store.setRollingBriefEnabled(true);
  const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const write = (as_of = 1609459200000, value = 25) => work.writeAsset({ id: ID, source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' },
    name: 'Refresh hose', attributes: { length: 'about 25 meters', contact: 'mara@private.example' },
    readings: { length: { value, unit: 'm', as_of, evidence: [] } } }, NOW);
  write();
  const contracts = createContractStore(db); const grants = createContractGrantEntryStore(contracts);
  const sources = buildSituationSources({ db, work, reminders: createReminderStore(db), calendars: () => [], now: () => clock.time, timeZone: () => 'UTC' }).filter(source => source.collection === 'asset');
  const query = createSituationQuery({ sources, now: () => clock.time, sourceForCollection: situationSourceAccess });
  const control = { unlocked: true, followup: false, firstRetry: false, retryAfterRead: false, neutral: false, intermediate: false, explicitRead: false, beforeRead: undefined as (() => Promise<void>) | undefined, beforeProbe: undefined as (() => Promise<void>) | undefined };
  const access = createSituationAccess({ contracts, query, factContext: createAssetFactContextReader({ work, now: () => clock.time,
    snapshot: read => db.transaction(read)() }), now: () => clock.time, isVaultUnlocked: () => control.unlocked });
  const deps: ChatToolHandlerDeps = { getCollectionRegistry: () => undefined, getContactStore: () => undefined, getAuditLog: () => undefined,
    getEnrichmentStore: () => undefined, getRecipeStore: () => { throw new Error('Unexpected recipe'); },
    getExecutorConfig: () => { throw new Error('Unexpected execution'); }, getExecuteRecipe: () => undefined, getSituationAccess: () => access, now: () => NOW };
  const handler = buildChatTier1Handlers(deps)['situation.query']!;
  const probe = createProjectionVersionProbe({ query: handler, admit: () => true, now: () => clock.time });
  const probes: ChatDispatchContext[] = [];
  const catalog: ToolEntry[] = (['situation.query', 'work.search'] as const).map(name => ({ ...TIER1_TOOL_DESCRIPTORS[name], tier: 1 }));
  const dispatches: Array<{ args: unknown; ctx: ChatDispatchContext }> = []; const packets: any[] = []; const briefPackets: any[] = []; const order: string[] = [];
  const registry: InternalToolRegistry = { list: () => catalog, listByTier: () => catalog, getByName: name => catalog.find(row => row.name === name) ?? null,
    subscribeRefresh: () => () => {}, dispatch: async (name, args, ctx) => { if (name === 'work.search') { order.push('search'); return { ok: true, result: { entities: [], total: 0 } }; } expect(name).toBe('situation.query'); order.push('read'); dispatches.push({ args, ctx }); await control.beforeRead?.(); return handler(args, ctx); } };
  const create = () => createChatOrchestrator({ chatStore: store, registry, now: () => clock.time,
    ...(probeEnabled ? { revalidateProjectionRead: async (source: Extract<ChatSourceCitation, { kind: 'asset_projection' }>, ctx: ChatDispatchContext) => {
      order.push('probe'); probes.push(ctx); await control.beforeProbe?.(); return probe(source, ctx);
    } } : {}),
    piiLedgerStore: piiEgress.createSessionLedgerStore(),
    fieldPrivacyResolver: createMetaFieldPrivacyResolverFromLocalManifestStore(createLocalManifestStore(db),
      CANONICAL_PII_ENTITY_SCHEMAS, CANONICAL_PII_CATALOG_MANIFESTS, CANONICAL_PII_ENTITY_PRIVACY_TAGS),
    selfSignature: { server_kind: 'recued', version: 'test', instance_id: 'test' }, broadcast: { emit: () => {} },
    executeAiCall: async (_manifest, input) => {
      const packet = JSON.parse(String(input['llm.prompt']));
      if ('tool_results_since' in packet) { briefPackets.push(packet); return { body: { intent: 'Inspect saved length', constraints: ['Keep amber falcon as our reference phrase.'],
        findings: ['Earlier saved length was 25 m, observed at 1609459200000.'], pending: [], completed: [] } }; }
      order.push('model'); packets.push(packet);
      if (control.firstRetry) { control.firstRetry = false; return { body: { response: 42 } }; }
      if (control.neutral) return { body: { reasoning: `Earlier [source](${packet.prior_source_reads?.sources?.[0]?.source_ref}) is unrelated here.`, response: 'We can keep talking.', events: [], tool_calls: [] } };
      const call = [...packet.prior_tool_calls ?? []].reverse().find((call: any) => call.tool_name === 'situation.query');
      if (call && control.retryAfterRead) { control.retryAfterRead = false; return { body: { response: 42 } }; }
      if (!call && !control.followup) return { body: { response: '', events: [], tool_calls: [{ tool: 'situation.query', args: details
        ? { time: NOW, subjects: [{ collection: 'asset', id: ID }], limit_clusters: 1, limit_items: 8 } : fieldRequest }] } };
      if (control.intermediate && control.followup && !call && !packet.prior_tool_calls?.some((row: any) => row.tool_name === 'work.search')) return { body: { response: '', events: [], tool_calls: [{ tool: 'work.search', args: { kind: 'asset', query: ID } }] } };
      if (control.explicitRead && control.followup && !call) return { body: { response: '', events: [], tool_calls: [{ tool: 'situation.query', args: fieldRequest }] } };
      const historical = packet.prior_source_reads?.sources?.find((source: any) => source.kind === 'asset_projection');
      if (!call && control.followup && historical) return { body: { response: `Saved {\"value\":25,\"unit\":\"m\",\"as_of\":1609459200000} [saved](${historical.source_ref}). amber falcon`, events: [], tool_calls: [] } };
      const source = call?.result?.citation_sources?.[0];
      const value = details ? call?.result?.clusters?.[0]?.items?.[0]?.details?.readings?.length : call?.result?.fact_context?.nodes?.[0]?.value;
      return { body: { response: value && source ? `Saved ${JSON.stringify(value)} ${link({ id: source.source_ref.slice(8) })}. amber falcon`
        : 'No current saved view is available. amber falcon', events: [], tool_calls: [] } };
    },
  });
  let engine = create();
  const send = async (extra = {}) => {
    const ack = await engine.runTurn({ session_id: sid, message: control.followup ? 'What is saved now? Repeat our reference phrase.' : `Read ${ID} using situation.query. Our phrase is amber falcon.`, picker_state: { current: 'self' }, ...extra });
    return (await store.listMessages(sid)).find(row => row.role === 'assistant' && row.turn_id === ack.turn_id)!;
  };
  return { db, store, work, write, grants, control, clock, probes, send, packets, briefPackets, dispatches, order, sid, get engine() { return engine; }, reopen() { engine = create(); control.followup = true; } };
};

describe('projection refresh through actual owner Chat and native readers', () => {
  it.each([false, true])('refreshes %s details mode after encrypted carry reload and a clock-only edit without changing the asset timestamp', async details => {
    const f = fixture(details); const first = await f.send(); const timestamp = f.work.readAsset(ID)!.updated_at;
    expect(first.source_citations?.[0]?.kind).toBe('asset_projection');
    f.write(1640995200000); f.reopen(); const before = f.order.length;
    const current = await f.send(); expect(f.order.slice(before)).toEqual(['model', 'read', 'model']);
    expect(current.content).toContain('1640995200000'); expect(current.content).not.toContain('1609459200000');
    expect(current.source_citations?.[0]?.read_version).not.toBe(first.source_citations?.[0]?.read_version);
    expect(current.content).toContain('amber falcon'); expect(await f.store.readSessionBrief(`projection-refresh-${sequence}`)).toContain('amber falcon');
    expect(f.work.readAsset(ID)!.updated_at).toBe(timestamp);
    expect(f.dispatches).toHaveLength(2); expect(f.dispatches[1]!.ctx.execution_source).toMatchObject({ channel: 'chat', actor: 'user_self' });
    expect(f.packets.at(-1)!.output_feedback).toContain('remain historical');
    expect(JSON.stringify(f.packets)).not.toContain('mara@private.example');
  });

  it('validates an unchanged cited view without a second synthesis', async () => {
    const f = fixture(); await f.send(); f.reopen(); const before = f.order.length;
    const result = await f.send(); expect(f.order.slice(before)).toEqual(['model', 'read']);
    expect(result.content).toContain('1609459200000'); expect(result.source_citations).toHaveLength(1);
  });

  it.each([false, true])('probes unchanged native %s details after encrypted carry reload without a new result or brief', async details => {
    const f = fixture(details, true); const first = await f.send();
    const brief = await f.store.readSessionBrief(f.sid); const briefs = f.briefPackets.length;
    const asset = f.work.readAsset(ID); f.clock.time += 10_000; f.reopen(); const before = f.order.length;
    const result = await f.send();
    expect(f.order.slice(before)).toEqual(['model', 'probe']);
    expect(f.probes).toHaveLength(1); expect(f.probes[0]!.execution_source).toMatchObject({ channel: 'chat', actor: 'user_self' });
    expect(f.dispatches).toHaveLength(1); expect(result.tool_calls ?? []).toEqual([]);
    expect(result.source_citations).toEqual(first.source_citations);
    expect(f.briefPackets).toHaveLength(briefs); expect(await f.store.readSessionBrief(f.sid)).toBe(brief);
    expect(f.work.readAsset(ID)).toEqual(asset); expect(result.content).toContain('amber falcon');
    expect(f.packets.at(-1)!.prior_tool_calls?.some((call: any) => call.tool_name === 'situation.query')).not.toBe(true);
  });

  it.each([false, true])('dispatches changed %s details after a probe, including clock-only and zero-value edits', async details => {
    const f = fixture(details, true); const first = await f.send(); const stamp = f.work.readAsset(ID)!.updated_at;
    f.write(1704067200000, 0); f.reopen(); const before = f.order.length;
    const result = await f.send();
    expect(f.order.slice(before)).toEqual(['model', 'probe', 'read', 'model']);
    expect(f.probes).toHaveLength(1); expect(f.dispatches).toHaveLength(2);
    expect(result.content).toContain('"value":0'); expect(result.content).toContain('1704067200000');
    expect(result.source_citations![0]!.read_version).not.toBe(first.source_citations![0]!.read_version);
    expect(f.work.readAsset(ID)!.updated_at).toBe(stamp);
  });

  it('detects a clock-only field edit even when its value and record timestamp match', async () => {
    const f = fixture(false, true); const first = await f.send(); f.write(1640995200000); f.reopen();
    const result = await f.send();
    expect(f.probes).toHaveLength(1); expect(f.dispatches).toHaveLength(2);
    expect(result.content).toContain('1640995200000'); expect(result.content).not.toContain('1609459200000');
    expect(result.source_citations![0]!.read_version).not.toBe(first.source_citations![0]!.read_version);
  });

  it.each(['operation', 'collection', 'vault', 'deleted'] as const)('dispatches the actual refusal after a failed probe: %s', async kind => {
    const f = fixture(false, true); await f.send(); f.reopen();
    if (kind === 'operation') f.grants.set(OWNER_CONTRACT_ID, 'core.situation.read', false, NOW);
    if (kind === 'collection') f.grants.set(OWNER_CONTRACT_ID, 'data.asset', false, NOW);
    if (kind === 'vault') f.control.unlocked = false;
    if (kind === 'deleted') f.db.prepare('UPDATE data_asset SET deleted_at=? WHERE id=?').run(NOW, ID);
    const result = await f.send();
    expect(f.probes).toHaveLength(1); expect(f.dispatches).toHaveLength(2);
    expect(result.content).toContain('No current saved view'); expect(result.content).not.toContain('1609459200000');
    expect(result.source_citations ?? []).toEqual([]);
  });

  it.each(['changed', 'denied'] as const)('retains the dispatched evidence through a format repair after a failed probe: %s', async mode => {
    const f = fixture(false, true); await f.send(); f.reopen(); f.control.retryAfterRead = true;
    if (mode === 'changed') f.write(1704067200000, 0);
    else f.grants.set(OWNER_CONTRACT_ID, 'data.asset', false, NOW);
    const result = await f.send(); expect(f.probes).toHaveLength(1); expect(f.dispatches).toHaveLength(2);
    if (mode === 'changed') expect(result.content).toContain('"value":0');
    else expect(result.content).toContain('No current saved view');
  });

  it.each(['unrelated', 'read_only', 'explicit'] as const)('avoids unnecessary probes for %s turns', async mode => {
    const f = fixture(false, true); await f.send(); f.reopen();
    if (mode === 'unrelated') f.control.neutral = true;
    if (mode === 'explicit') f.control.explicitRead = true;
    await f.send(mode === 'read_only' ? { read_only: true } : {});
    expect(f.probes).toHaveLength(0); expect(f.dispatches).toHaveLength(mode === 'explicit' ? 2 : 1);
  });

  it('records a demanded read and its provenance when a tool loop is already active', async () => {
    const f = fixture(); await f.send(); f.write(1672531200000); f.reopen(); f.control.intermediate = true;
    const before = f.order.length; const result = await f.send();
    expect(f.order.slice(before)).toEqual(['model', 'search', 'model', 'read', 'model']);
    expect(result.content).toContain('1672531200000'); expect(result.source_citations).toHaveLength(1);
    expect(result.tool_calls).toHaveLength(2);
    expect(f.dispatches).toHaveLength(2);
  });

  it('does not duplicate a native query already requested by the model in this turn', async () => {
    const f = fixture(); await f.send(); f.reopen(); f.control.explicitRead = true;
    const before = f.order.length; const result = await f.send();
    expect(f.order.slice(before)).toEqual(['model', 'read', 'model']);
    expect(f.dispatches).toHaveLength(2); expect(result.source_citations).toHaveLength(1);
  });

  it('returns a corrected zero and reuses the one fresh dispatch during a model format retry', async () => {
    const f = fixture(); await f.send(); f.write(1672531200000, 0); f.reopen(); f.control.firstRetry = true;
    const before = f.dispatches.length; const answer = await f.send();
    expect(answer.content).toContain('"value":0'); expect(answer.content).toContain('1672531200000');
    expect(f.dispatches.length - before).toBe(1); expect(f.packets.at(-1)!.output_feedback).toContain('fresh scoped');
  });

  it.each(['changed', 'denied'] as const)('keeps demanded evidence on a format retry after the read: %s', async mode => {
    const f = fixture(); await f.send(); f.reopen(); f.control.retryAfterRead = true;
    if (mode === 'changed') f.write(1704067200000, 0);
    else f.grants.set(OWNER_CONTRACT_ID, 'data.asset', false, NOW);
    const result = await f.send();
    expect(f.dispatches).toHaveLength(2);
    if (mode === 'changed') { expect(result.content).toContain('1704067200000'); expect(result.content).toContain('"value":0'); }
    else { expect(result.content).toContain('No current saved view'); expect(result.source_citations ?? []).toEqual([]); }
  });

  it.each(['operation', 'collection', 'vault', 'deleted'] as const)('retains a refused current read instead of silently treating earlier values as current: %s', async kind => {
    const f = fixture(); await f.send(); f.reopen();
    if (kind === 'operation') f.grants.set(OWNER_CONTRACT_ID, 'core.situation.read', false, NOW);
    if (kind === 'collection') f.grants.set(OWNER_CONTRACT_ID, 'data.asset', false, NOW);
    if (kind === 'vault') f.control.unlocked = false;
    if (kind === 'deleted') f.db.prepare('UPDATE data_asset SET deleted_at=? WHERE id=?').run(NOW, ID);
    const result = await f.send(); expect(result.content).toContain('No current saved view'); expect(result.source_citations ?? []).toEqual([]);
    expect(f.dispatches).toHaveLength(2); expect(f.packets.at(-1)!.output_feedback).toContain('failed, missing, omitted or trimmed');
  });

  it.each([false, true])('stops before revised model and answer egress when cancelled during demand validation (probe %s)', async probe => {
    const f = fixture(false, probe); await f.send(); f.reopen();
    let release!: () => void; let entered!: () => void; let finished!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const settled = new Promise<void>(resolve => { finished = resolve; });
    f.control[probe ? 'beforeProbe' : 'beforeRead'] = async () => { entered(); await blocked; };
    const engine = f.engine;
    const queued = withQueuedChatTurns({ ...engine, runTurn: async input => {
      try { return await engine.runTurn(input); } finally { finished(); }
    } }, { db: f.db, store: f.store, pollMs: 5 });
    const count = f.packets.length;
    const turn = queued.runTurn({ session_id: f.sid, message: 'What is saved now?', picker_state: { current: 'self' } });
    try {
      await started;
      const running = (await queued.turnQueue!.snapshot(f.sid)).turns.find(row => row.status === 'running')!;
      await queued.turnQueue!.cancel(f.sid, running.turn_id); release(); await turn; await settled;
      expect(f.packets).toHaveLength(count + 1);
      expect((await f.store.listMessages(f.sid)).filter(row => row.role === 'assistant')).toHaveLength(1);
    } finally { release(); queued.turnQueue!.close(); await new Promise(resolve => setImmediate(resolve)); }
  });

  it('leaves read-only owner turns outside automatic refresh', async () => {
    const f = fixture(); await f.send(); f.reopen(); const before = f.dispatches.length;
    await f.send({ read_only: true }); expect(f.dispatches).toHaveLength(before);
  });

  it('does no automatic read or closing brief for an unrelated answer', async () => {
    const f = fixture(); await f.send(); f.reopen(); f.control.neutral = true; const briefs = f.briefPackets.length;
    const result = await f.send();
    expect(f.dispatches).toHaveLength(1); expect(f.briefPackets).toHaveLength(briefs); expect(result.content).toBe('We can keep talking.');
    expect(result.source_citations ?? []).toEqual([]);
  });
});
