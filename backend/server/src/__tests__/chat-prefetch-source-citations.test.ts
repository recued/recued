import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OWNER_CONTRACT_ID, TIER1_TOOL_DESCRIPTORS, type ExecutionSource, type SituationItem, type SituationResult } from '@recued/contracts';
import { piiEgress } from '@recued/gateway';
import type { EntityPromptPart, TurnContext } from '@recued/middleware';
import { createChatOrchestrator } from '../chat-orchestrator.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createReminderStore } from '../storage/reminder-store.js';
import { createContractStore } from '../storage/contract-store.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import { buildSituationSources, situationSourceAccess } from '../situations/sources.js';
import { createSituationQuery } from '../situations/query.js';
import { createSituationAccess } from '../situations/access.js';
import { createSituationPrefetch, renderSituationPrefetch, SITUATION_PREFETCH_MAX_BYTES } from '../situations/prefetch.js';
import { registerSituationPrefetchSourceCapture } from '../situations/prefetch-source-citations.js';
import { situationSourceCitations } from '../chat-situation-source-citations.js';
import { situationModelProjection } from '../situations/model-projection.js';
import { answerSourceCitations, sourceReadVersion, ASSET_COMPARISON_READ_GUIDANCE } from '../chat-source-citations.js';
import { createMetaFieldPrivacyResolver } from '../meta-field-privacy-resolver.js';
import { CANONICAL_PII_ENTITY_PRIVACY_TAGS } from '../canonical-pii-schemas.js';
import { createPiiEgressPlanForSession, renderEntityPartsForEgress } from '../chat-pii-egress.js';
import { createRetainablePromptPartValidator } from '../chat-pii-source.js';

const NOW = Date.parse('2026-10-25T16:00:00Z');
const ID = 'asset:prefetch-native';
const owner: ExecutionSource = { channel: 'chat', actor: 'user_self', user_id: 'owner', chat_session_id: 's' };
const dispose: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); dispose.splice(0).forEach(fn => fn()); });
const fixture = () => {
  const db = new Database(':memory:'); dispose.push(() => db.close()); ensureWorkEntitySchema(db); ensureChatSchema(db);
  const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const write = (as_of = 1577836800000) => work.writeAsset({ id: ID, source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' },
    name: 'Prefetch hose', attributes: { length: 'approximately 12 meters', private_note: 'ana@example.test' },
    readings: { length: { value: 11, unit: 'm', as_of, evidence: [] } } }, NOW);
  write();
  const contracts = createContractStore(db, { now: () => NOW }); const grants = createContractGrantEntryStore(contracts);
  let unlocked = true;
  const query = createSituationQuery({ now: () => NOW, sourceForCollection: situationSourceAccess,
    sources: buildSituationSources({ db, work, reminders: createReminderStore(db), calendars: () => [], timeZone: () => 'UTC', now: () => NOW })
      .filter(source => source.collection === 'asset') });
  const access = createSituationAccess({ query, contracts, now: () => NOW, isVaultUnlocked: () => unlocked });
  const resolver = createMetaFieldPrivacyResolver({ getEntitySchemas: () => [], getEntityPrivacyTags: () => CANONICAL_PII_ENTITY_PRIVACY_TAGS });
  const plan = () => createPiiEgressPlanForSession({ ledgerStore: piiEgress.createSessionLedgerStore(), resolver }, 's', 'chat');
  const prefetch = async (enabled = true) => {
    const state = new Map<string, unknown>(); const capture = enabled ? registerSituationPrefetchSourceCapture(state) : undefined;
    const parts: EntityPromptPart[] = []; const validate = createRetainablePromptPartValidator();
    const ctx = { source: owner, state, history: [{ role: 'user', text: 'What is saved for Prefetch hose?' }],
      prompt: { contribute: (part: Omit<EntityPromptPart, 'source'>) => {
        const stamped = { ...part, source: 'situation-prefetch' } as EntityPromptPart; validate(stamped);
        // Match the framework's retained JSON projection, which loses object identity.
        parts.push({ ...stamped, payload: JSON.parse(JSON.stringify(stamped.payload)) });
      } } } as unknown as TurnContext;
    await createSituationPrefetch({ getAccess: () => access }).prompt!(ctx);
    return { capture, parts };
  };
  return { db, work, write, contracts, grants, access, query, resolver, plan, prefetch, seal: () => { unlocked = false; } };
};
const rows = (blocks: readonly string[]) => blocks.flatMap(block => block.split('\n').flatMap(line => {
  try { const row = JSON.parse(line); return row && typeof row === 'object' ? [row as Record<string, any>] : []; } catch { return []; }
}));

describe('native saved sources in ordinary Chat prefetch', () => {
  it('cites only native retained details that actually reach an effective protected packet', async () => {
    const f = fixture(); const { capture, parts } = await f.prefetch();
    expect(capture!.sources()).toEqual([]);
    capture!.retain(parts);
    const blocks = renderEntityPartsForEgress(parts, f.plan()); const row = rows(blocks)[0]!;
    // D-325 — this advice must reach the protected prefetch packet, before
    // any tool read. Defining it only in a post-read hint does not route an ask.
    expect(blocks.join('\n')).toContain(ASSET_COMPARISON_READ_GUIDANCE);
    expect(Buffer.byteLength(blocks.join('\n'))).toBeLessThanOrEqual(SITUATION_PREFETCH_MAX_BYTES);
    expect(row.citation_source).toMatchObject({ source_kind: 'asset_projection', projection: { kind: 'details' }, result_paths: ['/details'], read_at: NOW });
    expect(row.citation_source.citation).toBe(`[source](${row.citation_source.source_ref})`);
    expect(JSON.stringify(blocks)).not.toContain(ID); expect(JSON.stringify(blocks)).not.toContain('ana@example.test');
    capture!.observe(JSON.stringify({ user_message: 'Saved values?', prefetch_context: blocks }));
    const source = capture!.sources()[0]!;
    expect(source).toMatchObject({ kind: 'asset_projection', asset_id: ID });
    expect(answerSourceCitations('self', [], [], `11 m ${row.citation_source.citation}`, capture!.sources())).toEqual([source]);
    expect(answerSourceCitations('self', [], [], 'An unrelated answer', capture!.sources())).toEqual([]);
    expect(answerSourceCitations('self', [], [], row.citation_source.source_ref, capture!.sources())).toEqual([]);
  });

  it('rejects copied or changed objects and altered source-looking metadata', async () => {
    const f = fixture(); const capture = registerSituationPrefetchSourceCapture(new Map());
    const native = await f.access.prefetch('Prefetch hose', owner, new AbortController().signal, true);
    const item = native.clusters[0]!.items[0]!;
    expect(capture.describe(JSON.parse(JSON.stringify(item)))).toBeUndefined();
    expect(capture.describe({ ...item, ref: { collection: 'asset', id: 'different' } })).toBeUndefined();
    const hint = capture.describe(item)!; expect(hint).toBeDefined();
    expect(capture.retain([{ source: 'situation-prefetch', role: 'entity', entity: 'situation_item',
      payload: [{ ...item, citation_source: hint }], render: rows => renderSituationPrefetch(rows, 1, false) }])).toHaveLength(1);
    capture.observe(JSON.stringify({ user_message: 'Saved?', prefetch_context: [JSON.stringify({ ...item, citation_source: { ...hint, read_version: 'f'.repeat(64) } })] }));
    expect(capture.sources()).toEqual([]);
    item.details!.attributes = { length: 'forged value' };
    expect(capture.describe(item)).toBeUndefined();
  });

  it('drops a contribution whose retained details changed before protection', async () => {
    const f = fixture(); const { capture, parts } = await f.prefetch();
    const payload = JSON.parse(JSON.stringify(parts[0]!.payload));
    payload[0].details.readings.length.value = 999;
    expect(capture!.retain([{ ...parts[0]!, payload }])).toEqual([]);
    capture!.observe(JSON.stringify({ user_message: 'Saved?', prefetch_context: renderEntityPartsForEgress(parts, f.plan()) }));
    expect(capture!.sources()).toEqual([]);
  });

  it('leaves all other surfaces and an unregistered speculative prefetch uncitable', async () => {
    const f = fixture(); const { parts } = await f.prefetch(false);
    expect(rows(renderEntityPartsForEgress(parts, f.plan()))[0]).not.toHaveProperty('citation_source');
    for (const surface of ['today', 'digest', 'prefetch', 'push'] as const) {
      const result = await f.query({ time: NOW, text: 'Prefetch hose', surface }, f.access.context(owner));
      expect(situationSourceCitations(result, situationModelProjection(result))).not.toHaveProperty('source_citations');
    }
    const door = createContractDefinitionStore(f.contracts, { now: () => NOW }).mint({ minted_by: 'owner', display_name: 'Prefetch door', scope: {} });
    for (const key of ['core.situation.prefetch', 'core.work-entity.read', 'data.asset']) f.grants.set(door.contract_id, key, true, NOW);
    const source: ExecutionSource = { channel: 'chat', actor: 'user_self', user_id: 'owner', chat_session_id: 's', contract_id: door.contract_id };
    const result = await f.access.prefetch('Prefetch hose', source, new AbortController().signal, true);
    expect(situationSourceCitations(result, situationModelProjection(result))).not.toHaveProperty('source_citations');
  });

  it('withholds values and citations for denied, locked, revoked-during-read or aborted prefetch', async () => {
    const f = fixture(); f.grants.set(OWNER_CONTRACT_ID, 'data.asset', false, NOW);
    expect((await f.prefetch()).parts).toEqual([]);
    f.grants.set(OWNER_CONTRACT_ID, 'data.asset', true, NOW); f.seal(); expect((await f.prefetch()).parts).toEqual([]);
    const g = fixture(); const revoked = createSituationAccess({ contracts: g.contracts, now: () => NOW, isVaultUnlocked: () => true,
      query: async (input, context) => { const result = await g.query(input, context); g.grants.set(OWNER_CONTRACT_ID, 'core.situation.prefetch', false, NOW); return result; } });
    await expect(revoked.prefetch('Prefetch hose', owner, new AbortController().signal, true)).rejects.toThrow(/permissions changed|does not grant/u);
    g.grants.set(OWNER_CONTRACT_ID, 'core.situation.prefetch', true, NOW);
    const controller = new AbortController(); controller.abort();
    await expect(g.access.prefetch('Prefetch hose', owner, controller.signal, true)).rejects.toThrow();
  });

  it('keeps legacy data rows when metadata or alias expansion cannot fit', async () => {
    const f = fixture(); const { parts, capture } = await f.prefetch();
    const original = parts[0]!.payload[0]!;
    const { citation_source, ...bare } = original;
    const large = { ...bare, what: { ...(bare.what as object), value: 'x'.repeat(3500) } };
    const plain = renderSituationPrefetch([large], 1, false);
    const enriched = renderSituationPrefetch([{ ...large, citation_source }], 1, false);
    expect(rows(enriched ? [enriched] : [])[0]?.details).toEqual(rows([plain])[0]?.details);
    expect(Buffer.byteLength(enriched)).toBeLessThanOrEqual(SITUATION_PREFETCH_MAX_BYTES);
    // This value reaches the legacy cap, leaving no room for the citation guide.
    let value = large;
    while (Buffer.byteLength(renderSituationPrefetch([value], 1, false)) < 5300) value = { ...value, what: { ...value.what, value: value.what.value + 'x'.repeat(50) } };
    const capped = renderSituationPrefetch([{ ...value, citation_source }], 1, false);
    expect(rows([capped])[0]).not.toHaveProperty('citation_source');
    expect(rows([capped])[0]?.details).toEqual(rows([renderSituationPrefetch([value], 1, false)])[0]?.details);
    capture!.observe(JSON.stringify({ user_message: 'Saved?', prefetch_context: [capped] })); expect(capture!.sources()).toEqual([]);
    expect(renderEntityPartsForEgress(parts, undefined)).toEqual([]);
    const noop = { ...f.plan(), resolver: piiEgress.noopFieldPrivacyResolver };
    expect(renderEntityPartsForEgress(parts, noop)).toEqual([]);
  });

  it('persists cited native prefetch through real owner Chat without a dispatch and refreshes after a clock edit', async () => {
    const f = fixture(); const key = () => new Uint8Array(32).fill(63);
    const store = createChatStore(f.db, key, () => undefined); store.createSession({ id: 's' }); store.setRollingBriefEnabled(false);
    const dispatch = vi.fn(async () => ({ ok: false as const, reason: 'not_implemented' as const })); const packets: any[] = [];
    const queryTool = { ...TIER1_TOOL_DESCRIPTORS['situation.query'], tier: 1 as const };
    const create = () => createChatOrchestrator({ chatStore: createChatStore(f.db, key, () => undefined), getSituationAccess: () => f.access,
      registry: { list: () => [queryTool], listByTier: () => [queryTool], getByName: name => name === 'situation.query' ? queryTool : null, dispatch, subscribeRefresh: () => () => {} },
      piiLedgerStore: piiEgress.createSessionLedgerStore(), fieldPrivacyResolver: f.resolver,
      selfSignature: { server_kind: 'recued', version: 'test', instance_id: 'test' }, broadcast: { emit: () => {} }, now: () => NOW,
      executeAiCall: async (_manifest, input) => {
        const packet = JSON.parse(String(input['llm.prompt'])); packets.push(packet);
        const row = rows(packet.prefetch_context ?? [])[0]; const source = row?.citation_source;
        return { body: { response: source ? `Saved 11 m, as_of ${row!.details.readings.length.as_of} ${source.citation}` : 'No citable view', events: [], tool_calls: [] } };
      } });
    const send = async (read_only = false) => { const ack = await create().runTurn({ session_id: 's', message: 'What is saved for Prefetch hose?', picker_state: { current: 'self' }, ...(read_only ? { read_only: true } : {}) });
      return (await store.listMessages('s')).find(row => row.turn_id === ack.turn_id && row.role === 'assistant')!; };
    const first = await send(); expect(first.source_citations).toHaveLength(1); expect(first.content).toContain('1577836800000');
    const before = first.source_citations![0]!.read_version;
    const unchanged = await send(); expect(unchanged.source_citations?.[0]?.read_version).toBe(before);
    expect(dispatch).not.toHaveBeenCalled();
    f.write(1640995200000); const second = await send();
    expect(second.content).toContain('1640995200000'); expect(second.source_citations![0]!.read_version).not.toBe(before);
    const third = await send(true); expect(third.source_citations ?? []).toEqual([]);
    expect(packets.at(-1).prefetch_context.join('\n')).not.toContain('citation_source');
    expect(dispatch).not.toHaveBeenCalled();
    const raw = f.db.prepare<[], { metadata_blob: string | null; content_encrypted: Buffer }>('SELECT metadata_blob,content_encrypted FROM chat_messages').all();
    const encrypted = raw.map(row => String(row.metadata_blob) + row.content_encrypted.toString('utf8')).join('\n');
    expect(encrypted).not.toContain(first.source_citations![0]!.id); expect(encrypted).not.toContain('Saved 11 m');
  });
});
