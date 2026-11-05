/** D-338 — a situation item says when it happens on the turn's clock (`when_text`), in the
 *  tool's result and in the chat's lookup, as `calendar.search` says it of an event.
 *  Live (2026-11-04, qwen3.7-plus), given only epoch ms, an Agenda suggestions run put every
 *  one of the owner's meetings an hour early. Through the real query, handler, orchestrator,
 *  chat checks and privacy egress; the model is a stub that records what it was sent. */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zonedWallClockToEpochMs, type ExecutionSource, type SituationFact, type SituationItem } from '@recued/contracts';
import { piiEgress } from '@recued/gateway';
import { createContractStore, type ContractStore } from '../storage/contract-store.js';
import { createSituationQuery } from '../situations/query.js';
import { createSituationAccess } from '../situations/access.js';
import { situationWhenText } from '../situations/model-projection.js';
import { CHAT_TURN_TIME_ZONE_STATE_KEY, chatTurnTimeZoneOf } from '../chat-clock.js';
import { createMetaFieldPrivacyResolverFromLocalManifestStore } from '../meta-field-privacy-resolver.js';
import { CANONICAL_PII_CATALOG_MANIFESTS, CANONICAL_PII_ENTITY_PRIVACY_TAGS, CANONICAL_PII_ENTITY_SCHEMAS } from '../canonical-pii-schemas.js';
import { createPiiEgressPlanForSession, wrapExecuteAiCallForPii } from '../chat-pii-egress.js';
import { createChatOrchestrator } from '../chat-orchestrator.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createLocalManifestStore } from '../ingredient-authoring/local-manifest-store.js';
import { buildChatTier1Handlers, type ChatToolHandlerDeps } from '../chat-tool-handlers.js';

const at = Date.parse('2026-10-19T12:00:00Z');
const owner: ExecutionSource = { channel: 'chat', actor: 'user_self', user_id: 'owner', chat_session_id: 's' };
const LA = 'America/Los_Angeles';
// The dentist at 09:00–10:00 on Tuesday 20 October in Los Angeles (16:00–17:00 UTC).
const dentist = { from: Date.parse('2026-10-20T16:00:00Z'), to: Date.parse('2026-10-20T17:00:00Z') };
const item = (when: { from: number; to: number } | null, when_day?: string): Pick<SituationItem, 'when' | 'when_day'> => ({
  when: { value: when, verdict: 'match', basis: 'declared', evidence: [] }, ...(when_day ? { when_day } : {}) });
/** Midnight starting `day` in Los Angeles, which is how a whole day's window is stored for a server there. */
const laMidnight = (day: string) => zonedWallClockToEpochMs(day, LA)!;

describe('D-338 situationWhenText', () => {
  it('writes a timed item on the turn\'s clock, with the offset of its own date', () => {
    expect(situationWhenText(item(dentist), LA)).toBe('2026-10-20 09:00–10:00 (UTC-07:00)');
    expect(situationWhenText(item(dentist), 'Asia/Tokyo')).toBe('2026-10-21 01:00–02:00 (UTC+09:00)');
    // A December item read in October carries December's offset.
    expect(situationWhenText(item({ from: Date.parse('2026-12-01T17:00:00Z'), to: Date.parse('2026-12-01T18:00:00Z') }), LA))
      .toBe('2026-12-01 09:00–10:00 (UTC-08:00)');
  });

  it('names both days of an item that runs past midnight, and one moment for an instant', () => {
    expect(situationWhenText(item({ from: Date.parse('2026-10-21T06:00:00Z'), to: Date.parse('2026-10-21T09:00:00Z') }), LA))
      .toBe('2026-10-20 23:00 – 2026-10-21 02:00 (UTC-07:00)');
    const due = Date.parse('2026-10-21T00:30:00Z');
    expect(situationWhenText(item({ from: due, to: due }), LA)).toBe('2026-10-20 17:30 (UTC-07:00)');
  });

  it('keeps a declared whole day\'s own label, and names the last of several across a clock change', () => {
    expect(situationWhenText(item({ from: laMidnight('2026-10-20'), to: laMidnight('2026-10-21') }, '2026-10-20'), LA)).toBe('2026-10-20, all day');
    // The label is the day's in every zone: east of the server it is not the day after.
    expect(situationWhenText(item({ from: laMidnight('2026-10-20'), to: laMidnight('2026-10-21') }, '2026-10-20'), 'Asia/Tokyo')).toBe('2026-10-20, all day');
    // Three days, 31 October to 2 November; Los Angeles leaves summer time on 1 November.
    const three = { from: laMidnight('2026-10-31'), to: laMidnight('2026-11-03') };
    expect(three.to - three.from).toBe(3 * 86_400_000 + 3_600_000);
    expect(situationWhenText(item(three, '2026-10-31'), LA)).toBe('2026-10-31 – 2026-11-02, all day');
    // A trip's check is labelled with its entry day; the trip's own hours are not whole days.
    expect(situationWhenText(item({ from: Date.parse('2026-11-14T16:00:00Z'), to: Date.parse('2026-11-22T02:00:00Z') }, '2026-11-14'), LA))
      .toBe('2026-11-14, all day');
  });

  it('says nothing without a zone, or without a time', () => {
    expect(situationWhenText(item(dentist), undefined)).toBeUndefined();
    expect(situationWhenText(item(null), LA)).toBeUndefined();
  });

  it('reads the turn\'s zone from its state, and never throws on a state that holds none', () => {
    expect(chatTurnTimeZoneOf(new Map([[CHAT_TURN_TIME_ZONE_STATE_KEY, LA]]))).toBe(LA);
    // The lookup reads it inside the block whose catch withholds every row.
    for (const state of [undefined, {}, new Map(), new Map([[CHAT_TURN_TIME_ZONE_STATE_KEY, 7]])]) expect(chatTurnTimeZoneOf(state)).toBeUndefined();
  });
});

let db: Database.Database; let contracts: ContractStore;
beforeEach(() => { db = new Database(':memory:'); contracts = createContractStore(db, { now: () => at }); });
afterEach(() => db.close());
const fact = (id: string, title: string, when: { from: number; to: number }, patch: Partial<SituationFact> = {}): SituationFact => ({
  ref: { collection: 'calendar', id: `work:${id}` }, title, kind: 'calendar', basis: 'declared', when, act_by: when.from, valid_until: when.to,
  people: [], subjects: [], related: [], evidence: [{ collection: 'calendar', id: `work:${id}` }], updated_at: at, consequence: 'routine', ...patch });
const accessOver = (facts: SituationFact[]) => {
  const query = createSituationQuery({ now: () => at, sources: [{ id: 'calendar', collection: 'calendar', verb_op: 'core.work-entity.read', read: vi.fn(() => facts) }],
    sourceForCollection: collection => ({ verb_op: 'core.work-entity.read', collection }) });
  return createSituationAccess({ contracts, query, now: () => at, isVaultUnlocked: () => true });
};
type Items = { clusters: Array<{ items: Array<{ what: { value: string }; when_text?: string }> }> };
const itemsOf = (result: unknown) => (result as Items).clusters.flatMap(cluster => cluster.items);
const resolver = () => createMetaFieldPrivacyResolverFromLocalManifestStore(createLocalManifestStore(db),
  CANONICAL_PII_ENTITY_SCHEMAS, CANONICAL_PII_CATALOG_MANIFESTS, CANONICAL_PII_ENTITY_PRIVACY_TAGS);

describe('D-338 situation.query writes each item\'s time on the turn\'s clock', () => {
  const week = { time: { from: Date.parse('2026-10-20T07:00:00Z'), to: Date.parse('2026-10-27T07:00:00Z') } };

  it('in the zone the dispatch carries, and not at all for a caller with its own clock', async () => {
    const access = accessOver([fact('dentist', 'Dentist', dentist), fact('offsite', 'Team offsite',
      { from: laMidnight('2026-10-22'), to: laMidnight('2026-10-24') }, { when_day: '2026-10-22' })]);
    const handlers = buildChatTier1Handlers({ getSituationAccess: () => access } as ChatToolHandlerDeps);
    const turn = await handlers['situation.query']!(week, { execution_source: owner, time_zone: LA } as never) as { ok: true; result: unknown };
    expect(Object.fromEntries(itemsOf(turn.result).map(row => [row.what.value, row.when_text]))).toEqual({
      Dentist: '2026-10-20 09:00–10:00 (UTC-07:00)', 'Team offsite': '2026-10-22 – 2026-10-23, all day' });
    const mcp = await handlers['situation.query']!(week, { execution_source: owner } as never) as { ok: true; result: unknown };
    expect(itemsOf(mcp.result).map(row => row.when_text)).toEqual([undefined, undefined]);
  });

  it('reaches the model as written, through the privacy egress', async () => {
    const handlers = buildChatTier1Handlers({ getSituationAccess: () => accessOver([fact('dentist', 'Dentist', dentist)]) } as ChatToolHandlerDeps);
    const tool = await handlers['situation.query']!(week, { execution_source: owner, time_zone: LA } as never) as { ok: true; result: unknown };
    const plan = createPiiEgressPlanForSession({ ledgerStore: piiEgress.createSessionLedgerStore(), resolver: resolver() }, 's', 'chat');
    let sent = '';
    await wrapExecuteAiCallForPii(async (_manifest, request) => { sent = String(request['llm.prompt']); return { body: { response: 'ok', events: [], tool_calls: [] } }; }, plan)(
      {} as never, { 'llm.prompt': JSON.stringify({ user_message: 'What is on this week?',
        prior_tool_calls: [{ tool_name: 'situation.query', tier: 1, args: week, status: 'ok', result: tool.result }] }) });
    expect(sent).toContain('"when_text":"2026-10-20 09:00–10:00 (UTC-07:00)"');
  });
});

describe('D-338 the chat\'s lookup writes each row\'s time on the turn\'s clock', () => {
  /** One chat turn through the real orchestrator, its checks and privacy egress; what the model was sent. */
  const turn = async (time_zone: string | undefined, serverTimeZone?: string) => {
    const chatDb = new Database(':memory:'); ensureChatSchema(chatDb);
    const chatStore = createChatStore(chatDb); chatStore.setRollingBriefEnabled(false);
    const sent: string[] = []; let ids = 0;
    const orchestrator = createChatOrchestrator({ chatStore, broadcast: { emit: () => undefined },
      registry: { list: () => [], listByTier: () => [], getByName: () => null, dispatch: async () => ({ ok: false, reason: 'not_implemented' }),
        subscribeRefresh: () => () => undefined },
      selfSignature: { server_kind: 'recued', version: '1.0.0', instance_id: 'inst-test' }, mintId: () => `id-${++ids}`, now: () => at,
      getSituationAccess: () => accessOver([fact('dentist', 'Dentist appointment', dentist)]),
      ...(serverTimeZone ? { serverTimeZone: () => serverTimeZone } : {}),
      piiLedgerStore: piiEgress.createSessionLedgerStore(), fieldPrivacyResolver: resolver(),
      executeAiCall: async (_manifest, request) => {
        sent.push(String(request['llm.prompt'])); return { body: { response: 'At nine.', events: [], tool_calls: [] } };
      } });
    chatStore.createSession({ id: 's', now: at });
    // The lookup's budget is real time; hold the clock so a loaded machine cannot spend it.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      await orchestrator.runTurn({ session_id: 's', message: 'When is the dentist appointment?', picker_state: { current: 'self' },
        ...(time_zone ? { time_zone } : {}) });
    } finally { vi.useRealTimers(); chatDb.close(); }
    expect(sent).toHaveLength(1);
    const packet = JSON.parse(sent[0]!) as { prefetch_context?: string[]; current_date?: string };
    const rows = (packet.prefetch_context ?? []).join('\n').split('\n').filter(line => line.startsWith('{'))
      .map(line => JSON.parse(line) as { what: { value: string }; when_text?: string });
    return { rows, current_date: packet.current_date };
  };

  it('in the owner\'s zone when their app names it, on the clock the turn\'s date is in', async () => {
    const { rows, current_date } = await turn(LA);
    expect(rows.map(row => [row.what.value, row.when_text])).toEqual([['Dentist appointment', '2026-10-20 09:00–10:00 (UTC-07:00)']]);
    expect(current_date).toBe('Monday 2026-10-19 05:00 (UTC-07:00)');
  });

  it('in the server\'s zone when the surface names none, as the turn\'s date is', async () => {
    const { rows, current_date } = await turn(undefined, 'Asia/Tokyo');
    expect(rows.map(row => row.when_text)).toEqual(['2026-10-21 01:00–02:00 (UTC+09:00)']);
    expect(current_date).toBe('Monday 2026-10-19 21:00 (UTC+09:00)');
  });
});
