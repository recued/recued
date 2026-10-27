import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatSourceCitationsOf, type AssetRule, type ChatDispatchContext, type ChatDispatchResult, type ChatSourceCitation, type SituationResult } from '@recued/contracts';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createContractStore } from '../storage/contract-store.js';
import { createSituationAccess } from '../situations/access.js';
import { assetContextWriters, createAssetFactContextReader } from '../situations/asset-fact-context.js';
import { situationModelProjection } from '../situations/model-projection.js';
import { visibleSourceFacts, renderSourceFacts } from '../chat-source-facts.js';
import { situationSourceCitations } from '../chat-situation-source-citations.js';
import { buildChatTier1Handlers, type ChatToolHandlerDeps } from '../chat-tool-handlers.js';
import { createProjectionDemand, createProjectionVersionProbe } from '../chat-projection-refresh.js';
import { answerSourceCitations, priorSourceReads } from '../chat-source-citations.js';
import { piiEgress } from '@recued/gateway';
import { createMetaFieldPrivacyResolver } from '../meta-field-privacy-resolver.js';
import { CANONICAL_PII_ENTITY_PRIVACY_TAGS } from '../canonical-pii-schemas.js';
import { createPiiEgressPlanForSession, wrapExecuteAiCallForPii } from '../chat-pii-egress.js';

const NOW = Date.parse('2026-10-26T12:00:00Z');
const ID = 'asset:graph-private';
const ctx: ChatDispatchContext = { channel: 'internal_function_call', execution_source: { channel: 'chat', actor: 'user_self', user_id: 'owner', chat_session_id: 'graph' } };
const close: Array<() => void> = []; afterEach(() => close.splice(0).forEach(fn => fn()));
const fixture = () => {
  const db = new Database(':memory:'); close.push(() => db.close()); ensureWorkEntitySchema(db);
  const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const rule: AssetRule = { id: 'private_rule_id', title: 'Check length', enabled: true, muted: false, pinned: true, consequence: 'routine',
    when: { kind: 'objective', field: 'length', target: 30, unit: 'm', direction: 'rising', mode: 'condition', lead_days: 0 },
    reaction: { notify: true, emit: false, occurrence: 'action' }, schedule: { before: [], on_day: true }, expiry_policy: 'strict_expire' };
  work.writeAsset({ id: ID, source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' }, name: 'Graph hose', attributes: { note: 'about 25 meters' },
    readings: { length: { value: 25, unit: 'm', as_of: 1609459200000, evidence: [{ collection: 'asset', id: ID, field: 'attributes.note', value: 'about 25 meters' }] } }, rules: [rule] }, NOW);
  let time = NOW; let name = 'Current writer'; let unlocked = true;
  const native = createAssetFactContextReader({ work, writers: assetContextWriters(db, () => name), now: () => time, snapshot: read => db.transaction(read)() });
  const access = createSituationAccess({ contracts: createContractStore(db), query: async (): Promise<SituationResult> => ({ clusters: [], omitted: 0, ambiguous: [] }),
    factContext: native, now: () => time, isVaultUnlocked: () => unlocked });
  const deps: ChatToolHandlerDeps = { getCollectionRegistry: () => undefined, getContactStore: () => undefined, getAuditLog: () => undefined, getEnrichmentStore: () => undefined,
    getRecipeStore: () => { throw new Error('Unexpected recipe'); }, getExecutorConfig: () => { throw new Error('Unexpected execution'); },
    getExecuteRecipe: () => undefined, getSituationAccess: () => access, now: () => time };
  const query = (args: Record<string, unknown>) => buildChatTier1Handlers(deps)['situation.query']!(args, ctx);
  const request = { context: { root: { kind: 'rule', asset_id: ID, rule_id: rule.id } } };
  const read = async () => { const result = await query(request); if (!result.ok) throw new Error(result.detail ?? result.reason); return result; };
  const binding = { id: 'binding', asset_id: ID, actor_ref: 'recipe:writer', source_ref: 'fixture', fields: ['readings.length'], enabled: true };
  return { db, work, native, access, query, read, request, rule, binding, tick: () => time++, rename: () => { name = 'Renamed writer'; }, lock: () => { unlocked = false; } };
};
const source = (result: ChatDispatchResult, kind: 'field' | 'context') => {
  if (!result.ok) throw new Error(result.detail ?? result.reason);
  const found = chatSourceCitationsOf(result.source_citations).find((item): item is Extract<ChatSourceCitation, { kind: 'asset_projection' }> => item.kind === 'asset_projection' && item.projection.kind === kind);
  if (!found) throw new Error(`Expected native ${kind} citation`); return found;
};

describe('native relationship citation authority', () => {
  it('separates graph and saved-value scopes, keeps read time out of the version, and hides retained root locators', async () => {
    const f = fixture(); const first = await f.read(); const graph = source(first, 'context'); const field = source(first, 'field');
    const body = first.result as any;
    expect(body.citation_sources.find((item: any) => item.source_ref === `#source/${graph.id}`)).toMatchObject({ projection: { kind: 'context' }, result_paths: ['/fact_context'] });
    expect(body.citation_sources.find((item: any) => item.source_ref === `#source/${field.id}`).result_paths).toEqual(['/fact_context/nodes/1/value', '/fact_context/nodes/1/known']);
    expect(graph.id).not.toBe(field.id); expect(body.fact_context.writer_check.execution_status).toBe('not_checked');
    const attached = answerSourceCitations('self', [{ tool_name: 'situation.query', result: first }], [], `[fact](#source/${field.id})`);
    expect(attached).toEqual([field]);
    expect(answerSourceCitations('self', [{ tool_name: 'situation.query', result: first }], [], `[relationships](#source/${graph.id})`)).toContainEqual(graph);
    f.tick(); const next = source(await f.read(), 'context'); expect(next.read_version).toBe(graph.read_version); expect(next.read_at).not.toBe(graph.read_at);
    const prior = priorSourceReads([graph], { chat_tail: [{ content: `[relationships](#source/${graph.id})` }], user_message: 'Check it again' });
    expect(prior?.sources[0]?.projection).toEqual({ kind: 'context' }); expect(JSON.stringify(prior)).not.toContain('private_rule_id');
    const resolver = createMetaFieldPrivacyResolver({ getEntitySchemas: () => [], getEntityPrivacyTags: () => CANONICAL_PII_ENTITY_PRIVACY_TAGS });
    const plan = createPiiEgressPlanForSession({ ledgerStore: piiEgress.createSessionLedgerStore(), resolver }, 'graph-private', 'chat'); let sent = '';
    await wrapExecuteAiCallForPii(async (_manifest, input) => { sent = String(input['llm.prompt']); return { body: { response: 'ok', events: [], tool_calls: [] } }; }, plan)
      ({} as never, { 'llm.prompt': JSON.stringify({ prior_tool_calls: [{ tool_name: 'situation.query', result: body }], prior_source_reads: prior }) });
    expect(sent).not.toContain(ID); expect(sent).not.toContain('private_rule_id'); expect(sent).toContain('/fact_context'); expect(sent).not.toContain('__entity');
    for (const root of [{ kind: 'rule', rule_id: f.rule.id, asset_id: ID }, { kind: 'writer', binding_id: 'binding' }, { kind: 'rule', rule_id: f.rule.id, owner: true }])
      expect(chatSourceCitationsOf([{ ...graph, projection: { kind: 'context', root } }])).toEqual([]);
  });

  it('aliases native fact text through the actual privacy wrapper while preserving opaque selectors', async () => {
    const f = fixture();
    f.work.writeAsset({ id: ID, source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' }, name: 'Mara [Example]',
      rules: [{ ...f.rule, title: 'Call mara_updates@private.example' }] }, NOW);
    const native = await f.read(); const body = native.result as any;
    const observed = { tool_name: 'situation.query', tier: 1 as const, status: 'ok' as const, args: {}, result: body, started_at: NOW, completed_at: NOW };
    expect(visibleSourceFacts([observed], [observed]).active).toBe(true);
    const resolver = createMetaFieldPrivacyResolver({ getEntitySchemas: () => [], getEntityPrivacyTags: () => CANONICAL_PII_ENTITY_PRIVACY_TAGS });
    const plan = createPiiEgressPlanForSession({ ledgerStore: piiEgress.createSessionLedgerStore(), resolver }, 'graph-facts-private', 'chat');
    piiEgress.aliasPacketForEgress({ ledger: plan.ledger, packet: { name: 'Mara [Example]', email: 'mara_updates@private.example' }, mode: 'alias',
      resolver: () => [{ path: 'name', kind: 'name' }, { path: 'email', kind: 'email' }] });
    let sent = '';
    await wrapExecuteAiCallForPii(async (_manifest, input) => { sent = String(input['llm.prompt']); return { body: { response: 'ok', events: [], tool_calls: [] } }; }, plan)
      ({} as never, { 'llm.prompt': JSON.stringify({ prior_tool_calls: [observed] }) });
    expect(sent).not.toContain('Mara'); expect(sent).not.toContain('private.example');
    expect(sent).not.toContain('private_rule_id'); expect(sent).not.toContain('__entity');
    for (const row of body.source_facts) expect(sent).toContain(row.id);
  });

  it('binds a derived comparison to native operands and invalidates it on a rule-only correction', async () => {
    const f = fixture();
    const select = (result: ChatDispatchResult) => {
      if (!result.ok) throw new Error('native read failed');
      const call = { tool_name: 'situation.query', tier: 1 as const, status: 'ok' as const, args: {}, result: result.result, started_at: NOW, completed_at: NOW };
      const selection = visibleSourceFacts([call], [call]); const fact = [...selection.facts.values()].find(row => row.kind === 'comparison')!;
      return { selection, fact };
    };
    const first = await f.read(); const old = select(first); const field = source(first, 'field'); const original = f.work.readAsset(ID)!.readings;
    const answer = (id: string, selection: ReturnType<typeof select>['selection']) => renderSourceFacts({ response: '', events: [], tool_calls: [], source_answer: { facts: [id] } }, selection);
    expect(answer(old.fact.id, old.selection)).toContain('5 m below the declared rising target of 30 m');
    if (f.rule.when.kind !== 'objective') throw new Error('fixture');
    f.work.writeAsset({ id: ID, source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' }, rules: [{ ...f.rule, when: { ...f.rule.when, target: 20, direction: 'falling' } }] }, NOW + 1);
    const next = await f.read(); const updated = select(next);
    expect(f.work.readAsset(ID)!.readings).toEqual(original); expect(source(next, 'field').read_version).toBe(field.read_version);
    expect(source(next, 'context').read_version).not.toBe(source(first, 'context').read_version);
    expect(answer(old.fact.id, updated.selection)).toBeUndefined();
    expect(answer(updated.fact.id, updated.selection)).toContain('5 m above the declared falling target of 20 m');
    expect(updated.fact.sources.map(row => row.id)).toEqual([source(next, 'field').id, source(next, 'context').id]);
  });

  it('versions registrations, manual priority, rule configuration and writer labels independently of the unchanged field', async () => {
    const f = fixture(); const first = await f.read(); const field = source(first, 'field'); let graph = source(first, 'context');
    const assertChanged = async () => { const result = await f.read(); const next = source(result, 'context');
      expect(next.read_version).not.toBe(graph.read_version); expect(source(result, 'field').read_version).toBe(field.read_version); graph = next; };
    f.work.bindAssetObservations(f.binding); await assertChanged();
    const asset = f.work.readAsset(ID)!;
    f.work.allowAssetAutomaticUpdates({ id: ID, path: 'readings.length', expected: { value: asset.readings.length!, source: asset.field_sources['readings.length']! } }, NOW + 1); await assertChanged();
    f.rename(); await assertChanged();
    f.work.bindAssetObservations({ ...f.binding, enabled: false }); await assertChanged();
    f.work.writeAsset({ id: ID, source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' }, rules: [{ ...f.rule, title: 'Revised check' }] }, NOW + 2); await assertChanged();
  });

  it('refuses graph lookalikes and mutations but attests an honest bounded model subset', async () => {
    const f = fixture();
    const native = await f.access.read(f.request, ctx.execution_source!);
    const clone = structuredClone(native); expect(situationSourceCitations(clone, situationModelProjection(clone))).not.toHaveProperty('source_citations');
    const changed = situationModelProjection(native); changed.fact_context!.writer_check!.enabled_count = 99;
    expect(situationSourceCitations(native, changed).source_citations?.some(item => item.kind === 'asset_projection' && item.projection.kind === 'context')).toBe(false);
    const many = Array.from({ length: 40 }, (_, i) => ({ ...f.rule, id: `rule_${i}`, title: 'Check ' + 'length '.repeat(15) }));
    f.work.writeAsset({ id: ID, source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' }, rules: many }, NOW + 1);
    const bounded = await f.access.read({ context: { root: { kind: 'field', asset_id: ID, group: 'readings', field: 'length' } } }, ctx.execution_source!);
    const rendered = situationModelProjection(bounded); expect(rendered.fact_context!.completeness).toBe('partial');
    const result = situationSourceCitations(bounded, rendered);
    expect(result.source_citations?.some(item => item.kind === 'asset_projection' && item.projection.kind === 'context')).toBe(true);
    rendered.fact_context!.omitted = []; rendered.fact_context!.completeness = 'complete';
    expect(situationSourceCitations(bounded, rendered).source_citations?.some(item => item.kind === 'asset_projection' && item.projection.kind === 'context')).toBe(false);
  });

  it('revalidates graph citations through current native context rather than a matching scalar field version', async () => {
    const f = fixture(); const first = await f.read(); const graph = source(first, 'context');
    const fieldVersion = vi.fn(async () => source(first, 'field').read_version); const query = vi.fn(f.query);
    const probe = createProjectionVersionProbe({ query, fieldVersion, admit: () => true, now: () => NOW });
    expect(await probe(graph, ctx)).toBe(true); expect(fieldVersion).not.toHaveBeenCalled();
    f.work.bindAssetObservations(f.binding); expect(await probe(graph, ctx)).toBe(false);
    const demand = createProjectionDemand([graph]); const read = vi.fn(f.query);
    expect(await demand.check(`[relationships](#source/${graph.id})`, [], read, NOW, kept => probe(kept, ctx))).toEqual({ revise: true, limited: false });
    expect(read).toHaveBeenCalledWith(f.request);
    f.lock(); expect(await probe(graph, ctx)).toBe(false);
  });
});
