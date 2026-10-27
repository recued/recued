import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatSourceCitationsOf, type ChatDispatchContext, type ExecutionSource, type SituationResult } from '@recued/contracts';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createReminderStore } from '../storage/reminder-store.js';
import { createContractStore } from '../storage/contract-store.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import { buildSituationSources, situationSourceAccess } from '../situations/sources.js';
import { createSituationQuery } from '../situations/query.js';
import { createSituationAccess } from '../situations/access.js';
import { createAssetFactContextReader } from '../situations/asset-fact-context.js';
import { situationModelProjection } from '../situations/model-projection.js';
import { situationSourceCitations } from '../chat-situation-source-citations.js';
import { buildChatTier1Handlers, type ChatToolHandlerDeps } from '../chat-tool-handlers.js';
import { answerSourceCitations, priorSourceReads } from '../chat-source-citations.js';
import { assetRereadForRead } from '../chat-asset-fresh-read.js';
import { localAssetReadVersion } from '../chat-asset-read-reuse.js';
import { createMetaFieldPrivacyResolver } from '../meta-field-privacy-resolver.js';
import { CANONICAL_PII_ENTITY_PRIVACY_TAGS } from '../canonical-pii-schemas.js';
import { createPiiEgressPlanForSession, wrapExecuteAiCallForPii } from '../chat-pii-egress.js';
import { piiEgress } from '@recued/gateway';

const NOW = Date.parse('2026-10-25T12:00:00Z');
const ID = 'asset:projection-private';
const owner: ExecutionSource = { channel: 'chat', actor: 'user_self', user_id: 'owner', chat_session_id: 'projection' };
const ctx: ChatDispatchContext = { channel: 'internal_function_call', execution_source: owner };
const close: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); close.splice(0).forEach(fn => fn()); });

const fixture = () => {
  const db = new Database(':memory:'); close.push(() => db.close()); ensureWorkEntitySchema(db);
  const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const write = (as_of = 1609459200000) => work.writeAsset({ id: ID, source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' },
    name: 'Projection hose', attributes: { length: 'about 25 meters', private_note: 'Call Ana Example at ana@example.test' },
    readings: { length: { value: 25, unit: 'm', as_of, evidence: [] } } }, NOW);
  write();
  const sources = buildSituationSources({ db, work, reminders: createReminderStore(db), calendars: () => [], now: () => NOW, timeZone: () => 'UTC' })
    .filter(source => source.collection === 'asset');
  const query = createSituationQuery({ sources, now: () => NOW, sourceForCollection: situationSourceAccess });
  const contracts = createContractStore(db, { now: () => NOW }); const grants = createContractGrantEntryStore(contracts);
  let unlocked = true;
  const contextReader = createAssetFactContextReader({ work, now: () => NOW, snapshot: read => db.transaction(read)(), referenceSphere: () => 'personal' });
  const access = createSituationAccess({ contracts, query, factContext: contextReader, now: () => NOW, isVaultUnlocked: () => unlocked });
  const deps: ChatToolHandlerDeps = {
    getCollectionRegistry: () => undefined, getContactStore: () => undefined, getAuditLog: () => undefined, getEnrichmentStore: () => undefined,
    getRecipeStore: () => { throw new Error('Unexpected recipe'); }, getExecutorConfig: () => { throw new Error('Unexpected execution'); },
    getExecuteRecipe: () => undefined, getSituationAccess: () => access, now: () => NOW,
  };
  const handlers = buildChatTier1Handlers(deps);
  const details = { time: NOW, text: 'Projection' };
  const field = (name = 'length', group: 'attributes' | 'readings' = 'readings') =>
    ({ context: { root: { kind: 'field', asset_id: ID, group, field: name } } });
  const dispatch = (input: unknown = details, source: ExecutionSource = owner) => handlers['situation.query']!(input, { ...ctx, execution_source: source });
  const run = async (input: unknown = details, source: ExecutionSource = owner) => {
    const result = await dispatch(input, source);
    if (!result.ok) throw new Error(result.detail ?? result.reason);
    return result;
  };
  const door = (spheres?: ('personal' | 'professional')[]) => {
    const def = createContractDefinitionStore(contracts, { now: () => NOW }).mint({ minted_by: 'owner', display_name: 'Projection', scope: {},
      ...(spheres ? { read_spheres: spheres } : {}) });
    for (const key of ['core.situation.read', 'core.work-entity.read', 'data.asset']) grants.set(def.contract_id, key, true, NOW);
    return { channel: 'mcp' as const, actor: 'contracted_user' as const, agent_id: 'agent', tool_call_id: 'call', mcp_token_id: 'token', contract_id: def.contract_id };
  };
  return { db, work, write, access, query, contracts, deps, details, field, run, dispatch, door, grants, contextReader, seal: () => { unlocked = false; } };
};

describe('native situation saved-field provenance', () => {
  it('cites the actual bounded saved details without labeling the situation or asset complete', async () => {
    const f = fixture(); const result = await f.run();
    expect(result.ok).toBe(true);
    expect(result.source_citations).toEqual([expect.objectContaining({ kind: 'asset_projection', asset_id: ID, projection: { kind: 'details' } })]);
    const body = result.result as any;
    expect(body.clusters[0].items[0].details.attributes.length).toBe('about 25 meters');
    expect(body.citation_sources[0].result_paths).toEqual(['/clusters/0/items/0/details']);
    expect(body.citation_hint).toContain('not a complete asset');
    expect(body.citation_hint).toContain('computed situation dimension');
    expect(result.source_citations?.[0]?.read_at).toBe(NOW);
  });

  it('leaves speculative prefetch outside explicit-query citation authority', async () => {
    const f = fixture();
    const native = await f.query({ time: NOW, text: 'Projection', surface: 'prefetch' }, f.access.context(owner, 'core.situation.prefetch'));
    expect(native.clusters).not.toHaveLength(0);
    expect(situationSourceCitations(native, situationModelProjection(native))).not.toHaveProperty('source_citations');
  });

  it('withholds native receipts if authority changes after the query read', async () => {
    const f = fixture(); const source = f.door();
    const access = createSituationAccess({ contracts: f.contracts, now: () => NOW, isVaultUnlocked: () => true,
      query: async (query, context) => {
        const result = await f.query(query, context); f.grants.set(source.contract_id, 'data.asset', false, NOW); return result;
      } });
    const handler = buildChatTier1Handlers({ ...f.deps, getSituationAccess: () => access })['situation.query']!;
    const result = await handler(f.details, { ...ctx, execution_source: source });
    expect(result).not.toHaveProperty('source_citations');
    expect(result).toMatchObject({ ok: true, result: { refused: true } });
  });

  it('binds a context citation only to the returned saved field value and known flag', async () => {
    const f = fixture(); const result = await f.run(f.field()); const body = result.result as any;
    expect(body.fact_context.nodes[0].value).toEqual({ value: 25, unit: 'm', as_of: 1609459200000 });
    expect(result.source_citations?.filter(source => source.kind === 'asset_projection' && source.projection.kind === 'field')).toEqual([expect.objectContaining({ kind: 'asset_projection', projection: { kind: 'field', field: 'readings.length' }, label: 'Projection hose · length' })]);
    expect(body.citation_sources[0].result_paths).toEqual(['/fact_context/nodes/0/value', '/fact_context/nodes/0/known']);
    expect(body.citation_sources[0]).not.toHaveProperty('asset_id');
    expect(Buffer.byteLength(JSON.stringify(body.fact_context))).toBeLessThanOrEqual(6000);
  });

  it('changes the projected version for an as_of-only edit even when the asset timestamp and quantity stay fixed', async () => {
    const f = fixture(); const before = await f.run(f.field()); const asset = f.work.readAsset(ID)!;
    f.write(1640995200000); const after = await f.run(f.field());
    expect(f.work.readAsset(ID)!.updated_at).toBe(asset.updated_at);
    expect(after.source_citations?.[0]?.read_version).not.toBe(before.source_citations?.[0]?.read_version);
    expect((after.result as any).fact_context.nodes[0].value).toEqual({ value: 25, unit: 'm', as_of: 1640995200000 });
  });

  it('keeps the field version scoped when an unrelated saved value changes', async () => {
    const f = fixture(); const before = await f.run(f.field()); const previousDetails = await f.run();
    f.work.writeAsset({ id: ID, source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' }, attributes: { unrelated: 'new' } }, NOW + 1);
    const after = await f.run(f.field());
    expect(after.source_citations?.[0]?.read_version).toBe(before.source_citations?.[0]?.read_version);
    expect((await f.run()).source_citations?.[0]?.read_version).not.toBe(previousDetails.source_citations?.[0]?.read_version);
  });

  it.each([false, 0, '', null])('preserves an explicit field value %s and its known state', async value => {
    const f = fixture(); f.work.writeAsset({ id: ID, source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' }, attributes: { sample: value } }, NOW);
    const result = await f.run(f.field('sample', 'attributes'));
    expect((result.result as any).fact_context.nodes[0]).toMatchObject({ value, known: value !== null });
    expect(result.source_citations?.filter(source => source.kind === 'asset_projection' && source.projection.kind === 'field')).toHaveLength(1);
  });

  it('does not cite a value omitted by the context byte budget or unsupported-value guard', async () => {
    const f = fixture();
    for (const value of ['x'.repeat(10_000), { nested: 'not a plain field value' }]) {
      f.work.writeAsset({ id: ID, source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' }, attributes: { large: value } }, NOW);
      const result = await f.run(f.field('large', 'attributes'));
      expect((result.result as any).fact_context.nodes[0]).toMatchObject({ value: null, known: true, value_omitted: true });
      expect(result.source_citations?.some(source => source.kind === 'asset_projection' && source.projection.kind === 'field')).toBe(false);
      expect(result.source_citations).toHaveLength(1); // The graph attests the explicit omission, not its placeholder value.
    }
  });

  it('rejects serialized lookalikes, changed views and mismatched asset identities', async () => {
    const f = fixture(); const native = await f.access.read(f.details, owner);
    const clone: SituationResult = structuredClone(native);
    expect(situationSourceCitations(clone, situationModelProjection(clone))).not.toHaveProperty('source_citations');
    const changed = situationModelProjection(native); changed.clusters[0]!.items[0]!.ref = { collection: 'asset', id: 'someone-else' };
    expect(situationSourceCitations(native, changed)).not.toHaveProperty('source_citations');
    native.clusters[0]!.items[0]!.details!.attributes!.length = 'invented';
    expect(situationSourceCitations(native, situationModelProjection(native))).not.toHaveProperty('source_citations');
  });

  it('leaves computed dimensions, graph edges and copied evidence outside a genuine details citation', async () => {
    const f = fixture(); const native = await f.access.read(f.details, owner);
    const item = native.clusters[0]!.items[0]!;
    item.kind = 'asset_rule'; item.basis = 'derived'; item.when = { value: { from: 1, to: 2 }, basis: 'derived', verdict: 'match', evidence: [] };
    const result = situationSourceCitations(native, situationModelProjection(native));
    expect(result.source_citations).toHaveLength(1);
    expect((result.result as any).citation_sources[0].result_paths).toEqual(['/clusters/0/items/0/details']);
    const untrusted: SituationResult = { clusters: [], omitted: 0, ambiguous: [], fact_context: {
      root: { kind: 'field', asset_id: ID, group: 'readings', field: 'length' }, asset: { id: ID, name: 'Copy' },
      nodes: [{ kind: 'field', ref: { kind: 'field', asset_id: ID, group: 'readings', field: 'length' }, label: 'Length', value: 99, known: true, source: null }],
      edges: [], read_at: NOW, freshness: 'current', completeness: 'complete', omitted: [], missing: [] } };
    expect(situationSourceCitations(untrusted, situationModelProjection(untrusted))).not.toHaveProperty('source_citations');
  });

  it('deduplicates repeated native views and reports unique projections beyond the source cap', async () => {
    const f = fixture();
    for (let n = 0; n < 21; n++) f.work.writeAsset({ id: `other-${n}`, source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' }, name: `Projection ${n}`, attributes: { value: n } }, NOW);
    const native = await f.access.read(f.details, owner);
    const last = native.clusters.at(-1)!; last.items.push(last.items[0]!);
    const result = situationSourceCitations(native, situationModelProjection(native));
    expect(result.source_citations).toHaveLength(20);
    expect((result.result as any).citations_omitted).toBe(2);
  });

  it.each(['operation', 'collection', 'sphere', 'locked'] as const)('keeps %s denials from minting citations', async mode => {
    const f = fixture(); const source = f.door(mode === 'sphere' ? ['professional'] : undefined);
    if (mode === 'operation') f.grants.set(source.contract_id, 'core.situation.read', false, NOW);
    if (mode === 'collection') f.grants.set(source.contract_id, 'data.asset', false, NOW);
    if (mode === 'locked') f.seal();
    const result = await f.dispatch(mode === 'sphere' ? f.field() : f.details, source);
    expect(result).not.toHaveProperty('source_citations');
  });

  it('keeps projection identities typed in history and resolves an explicit full reread by identity only', async () => {
    const f = fixture(); const result = await f.run(f.field()); const source = result.source_citations![0]!;
    const answer = `[saved fact](#source/${source.id})`;
    expect(answerSourceCitations('self', [{ tool_name: 'situation.query', result }], [], answer)).toEqual([source]);
    expect(answerSourceCitations('peer', [{ tool_name: 'situation.query', result }], [], answer)).toEqual([]);
    expect(answerSourceCitations('self', [{ tool_name: 'work.read', result }], [], answer)).toEqual([]);
    expect(localAssetReadVersion(ID, result)).toBeUndefined();
    expect(answerSourceCitations('self', [{ tool_name: 'situation.query', result: { ...result, run_held: { kind: 'approval' } } }], [], answer)).toEqual([]);
    const prior = priorSourceReads([source], { chat_tail: [{ content: answer }], user_message: 'Use the same fact' });
    expect(prior?.sources[0]).toMatchObject({ kind: 'asset_projection', asset_id: ID, projection: { kind: 'field', field: 'readings.length' } });
    expect(prior?.guidance).toContain('not a complete asset');
    expect(assetRereadForRead('Read the current asset again.', [{ role: 'assistant', content: answer }], [source], true)?.context.id).toBe(ID);
  });

  it('validates the closed projection scope without widening it into a complete asset', async () => {
    const f = fixture(); const source = (await f.run(f.field())).source_citations![0]!;
    expect(chatSourceCitationsOf([{ ...source, href: 'javascript:alert(1)' }])).toEqual([source]);
    for (const projection of [undefined, { kind: 'complete' }, { kind: 'details', field: 'readings.length' },
      { kind: 'field', field: 'readings.length.extra' }, { kind: 'field', field: 'readings.length', owner: true }]) {
      expect(chatSourceCitationsOf([{ ...source, projection }])).toEqual([]);
    }
  });

  it('aliases identifiers and content through the real egress wrapper while leaving citation paths opaque', async () => {
    const f = fixture(); const result = await f.run();
    const resolver = createMetaFieldPrivacyResolver({ getEntitySchemas: () => [], getEntityPrivacyTags: () => CANONICAL_PII_ENTITY_PRIVACY_TAGS });
    const plan = createPiiEgressPlanForSession({ ledgerStore: piiEgress.createSessionLedgerStore(), resolver }, 'projection', 'chat');
    piiEgress.aliasPacketForEgress({ ledger: plan.ledger, packet: { name: 'Ana Example', email: 'ana@example.test' }, mode: 'alias',
      resolver: () => [{ path: 'name', kind: 'name' }, { path: 'email', kind: 'email' }] });
    let packet = '';
    await wrapExecuteAiCallForPii(async (_manifest, input) => { packet = String(input['llm.prompt']); return { body: { response: 'ok', events: [], tool_calls: [] } }; }, plan)
      ({} as never, { 'llm.prompt': JSON.stringify({ user_message: 'Explain the saved facts', prior_tool_calls: [{ tool_name: 'situation.query', result: result.result }] }) });
    expect(packet).not.toContain(ID); expect(packet).not.toContain('Ana Example'); expect(packet).not.toContain('ana@example.test');
    expect(packet).toContain('/clusters/0/items/0/details'); expect(packet).toContain('#source/src_'); expect(packet).not.toContain('__entity');
  });
});
