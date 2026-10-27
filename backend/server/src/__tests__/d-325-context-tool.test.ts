import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseAssetFactContextRequest, SITUATION_CONTEXT_MAX_BYTES, type AssetFactContext, type ExecutionSource, type SituationResult } from '@recued/contracts';
import { piiEgress } from '@recued/gateway';
import { createContractStore } from '../storage/contract-store.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createAssetFactContextReader } from '../situations/asset-fact-context.js';
import { createSituationAccess } from '../situations/access.js';
import { situationModelProjection } from '../situations/model-projection.js';
import { createMetaFieldPrivacyResolver } from '../meta-field-privacy-resolver.js';
import { CANONICAL_PII_ENTITY_PRIVACY_TAGS } from '../canonical-pii-schemas.js';
import { createPiiEgressPlanForSession, wrapExecuteAiCallForPii } from '../chat-pii-egress.js';

const at = Date.parse('2026-10-23T12:00:00Z');
const owner: ExecutionSource = { channel: 'chat', actor: 'user_self', user_id: 'owner', chat_session_id: 'context-test' };
const close: Array<() => void> = []; afterEach(() => { vi.restoreAllMocks(); close.splice(0).forEach(fn => fn()); });
const fixture = () => {
  const db = new Database(':memory:'); close.push(() => db.close()); ensureWorkEntitySchema(db);
  const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  work.writeAsset({ id: 'asset-private-identifier', source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner-private-source' },
    name: 'Passport for Ana Example', attributes: { note: 'Call Ana Example at ana@example.test', length: 'about 25 meters' },
    readings: { length: { value: 25, unit: 'm', as_of: at - 60_000, evidence: [{ collection: 'asset', id: 'asset-private-identifier', field: 'attributes.length', value: 'about 25 meters' }] } } }, at);
  const contracts = createContractStore(db, { now: () => at }); const entries = createContractGrantEntryStore(contracts);
  const root = { kind: 'field' as const, asset_id: 'asset-private-identifier', group: 'attributes' as const, field: 'note' };
  const query = vi.fn(async (): Promise<SituationResult> => ({ clusters: [], omitted: 0, ambiguous: [] }));
  const factContext = vi.fn(createAssetFactContextReader({ work, now: () => at, snapshot: read => db.transaction(read)(), referenceSphere: () => 'personal' }));
  let unlocked = true;
  const access = createSituationAccess({ contracts, query, factContext, now: () => at, isVaultUnlocked: () => unlocked });
  const door = (spheres?: ('personal' | 'professional')[]): Extract<ExecutionSource, { channel: 'mcp' }> => {
    const definition = createContractDefinitionStore(contracts, { now: () => at }).mint({ minted_by: 'owner', display_name: 'Context test', scope: {}, ...(spheres ? { read_spheres: spheres } : {}) });
    for (const key of ['core.situation.read', 'core.work-entity.read', 'data.asset']) entries.set(definition.contract_id, key, true, at);
    return { channel: 'mcp', actor: 'contracted_user', agent_id: 'agent', tool_call_id: 'call', mcp_token_id: 'token', contract_id: definition.contract_id };
  };
  return { db, work, contracts, entries, root, query, factContext, access, door, seal: () => { unlocked = false; } };
};

describe('explicit situation tool relationship context', () => {
  it('uses the narrow reader on explicit context and leaves ordinary queries unchanged', async () => {
    const f = fixture(); const result = await f.access.read({ context: { root: f.root } }, owner);
    expect(result.fact_context?.nodes[0]).toMatchObject({ value: 'Call Ana Example at ana@example.test' });
    expect(f.query).not.toHaveBeenCalled(); expect(f.factContext).toHaveBeenCalledTimes(1);
    await f.access.read({ time: at }, owner); expect(f.query).toHaveBeenCalledTimes(1); expect(f.factContext).toHaveBeenCalledTimes(1);
  });

  it('accepts no caller-supplied owner, sphere or mixed query authority', async () => {
    const f = fixture();
    for (const input of [
      { context: { root: f.root }, time: at },
      { context: { root: f.root }, owner: true },
      { context: { root: { ...f.root, owner: true } } },
      { context: { root: f.root, spheres: ['personal'] } },
    ]) await expect(f.access.read(input, owner)).rejects.toThrow();
    expect(f.factContext).not.toHaveBeenCalled();
    expect(() => parseAssetFactContextRequest({ root: { ...f.root, field: 'document_details' } })).toThrow();
  });

  it('keeps source grants and selected spheres on model context and never reuses the owner packet', async () => {
    const f = fixture(); await f.access.read({ context: { root: f.root } }, owner);
    const allowed = f.door(['personal']); const scoped = await f.access.read({ context: { root: f.root } }, allowed);
    expect(scoped.fact_context?.nodes[0]).toMatchObject({ source: null, source_restricted: true });
    await expect(f.access.read({ context: { root: f.root } }, f.door(['professional']))).rejects.toThrow('permissions');
    f.entries.set(allowed.contract_id!, 'data.asset', false, at);
    await expect(f.access.read({ context: { root: f.root } }, allowed)).rejects.toThrow('permissions');
    f.seal(); await expect(f.access.read({ context: { root: f.root } }, owner)).rejects.toThrow('Unlock');
  });

  it('rechecks current authority after an asynchronous read finishes', async () => {
    const f = fixture(); const source = f.door(['personal']);
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
    const access = createSituationAccess({ contracts: f.contracts, query: f.query, now: () => at, isVaultUnlocked: () => true,
      factContext: async (input, context) => { const packet = f.factContext(input, context); entered(); await gate; return packet; } });
    const pending = access.read({ context: { root: f.root } }, source); await started;
    f.entries.set(source.contract_id!, 'data.asset', false, at); release();
    await expect(pending).rejects.toThrow('Permissions changed');
  });

  it('tags nested identities and content through the actual chat egress wrapper', async () => {
    const f = fixture(); const canonical = await f.access.read({ context: { root: f.root } }, owner);
    const projected = situationModelProjection(canonical);
    const resolver = createMetaFieldPrivacyResolver({ getEntitySchemas: () => [], getEntityPrivacyTags: () => CANONICAL_PII_ENTITY_PRIVACY_TAGS });
    const plan = createPiiEgressPlanForSession({ ledgerStore: piiEgress.createSessionLedgerStore(), resolver }, 'context-test', 'chat');
    piiEgress.aliasPacketForEgress({ ledger: plan.ledger, packet: { name: 'Ana Example', email: 'ana@example.test' }, mode: 'alias', resolver: () => [
      { path: 'name', kind: 'name' }, { path: 'email', kind: 'email' },
    ] });
    let sent = '';
    await wrapExecuteAiCallForPii(async (_manifest, input) => { sent = String(input['llm.prompt']); return { body: { response: 'ok', events: [], tool_calls: [] } }; }, plan)
      ({} as never, { 'llm.prompt': JSON.stringify({ user_message: 'Explain the saved note', prior_tool_calls: [{ tool_name: 'situation.query', result: projected }] }) });
    expect(sent).not.toContain('Ana Example'); expect(sent).not.toContain('ana@example.test'); expect(sent).not.toContain('asset-private-identifier'); expect(sent).not.toContain('owner-private-source');
    expect(sent).toContain('pii.'); expect(JSON.stringify(canonical)).toContain('ana@example.test');
    expect(sent).not.toContain('__entity');
    const packet = JSON.parse(sent) as { prior_tool_calls: Array<{ result: SituationResult }> };
    expect(Buffer.byteLength(JSON.stringify(packet.prior_tool_calls[0]!.result.fact_context), 'utf8')).toBeLessThanOrEqual(SITUATION_CONTEXT_MAX_BYTES);
  });

  it('keeps marker bytes within the model budget and preserves honest partial coverage', () => {
    const f = fixture(); const root = { ...f.root, field: 'length' };
    const packet: AssetFactContext = { root, asset: { id: root.asset_id, name: 'Pump' }, nodes: Array.from({ length: 30 }, (_, i) => ({ kind: 'field', ref: i === 0 ? root : { ...root, field: `field_${i}` }, label: `Field ${i}`, value: '測'.repeat(50), known: true, source: null })),
      edges: [], read_at: at, freshness: 'current', completeness: 'complete', omitted: [], missing: [] };
    packet.nodes.push({ kind: 'writer', ref: { kind: 'writer', asset_id: root.asset_id, binding_id: 'writer' }, name: 'Registered writer', enabled: true });
    packet.writer_check = { scope: 'enabled_bindings', field: 'attributes.length', status: 'complete', enabled_count: 1 };
    const result = situationModelProjection({ clusters: [], omitted: 0, ambiguous: [], fact_context: packet });
    expect(Buffer.byteLength(JSON.stringify(result.fact_context), 'utf8')).toBeLessThanOrEqual(SITUATION_CONTEXT_MAX_BYTES);
    expect(result.fact_context?.completeness).toBe('partial'); expect(result.fact_context?.omitted).toContain('byte_budget');
    expect(result.fact_context?.writer_check).toEqual({ scope: 'enabled_bindings', field: 'attributes.length', status: 'partial' });
  });
});
