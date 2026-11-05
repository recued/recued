/** D-338 — what a model writes and reads of a situation. A day it names is read on the turn's
 *  clock (`time: "2026-11-05"`, `{first_day, last_day}`), and an item the owner's notifications
 *  call only "a reminder in Yours" says so (`private: true`). Live (2026-11-04, qwen3.7-plus),
 *  writing epoch ms, the Agenda's suggestions asked for the wrong day in 4 of 6 runs; and with
 *  nothing marking it, they named the owner's private occasion in 7 of the 7 runs that had it.
 *  Through the real parser, access, handler, orchestrator, chat checks and privacy egress; the
 *  model is a stub that records what it was sent. */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseSituationQueryInput, SITUATION_QUERY_SCHEMA, TIER1_TOOL_DESCRIPTORS,
  type ExecutionSource, type SituationFact, type SituationItem } from '@recued/contracts';
import { piiEgress } from '@recued/gateway';
import { createContractStore, type ContractStore } from '../storage/contract-store.js';
import { createSituationQuery } from '../situations/query.js';
import { createSituationAccess } from '../situations/access.js';
import { createScheduledSituations } from '../situations/scheduled-situations.js';
import { createSituationStore } from '../storage/situation-store.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createProactiveHistoryStore } from '../storage/proactive-history-store.js';
import { createProactiveProposalStore } from '../storage/proactive-proposal-store.js';
import { createMetaFieldPrivacyResolverFromLocalManifestStore } from '../meta-field-privacy-resolver.js';
import { CANONICAL_PII_CATALOG_MANIFESTS, CANONICAL_PII_ENTITY_PRIVACY_TAGS, CANONICAL_PII_ENTITY_SCHEMAS } from '../canonical-pii-schemas.js';
import { createChatOrchestrator } from '../chat-orchestrator.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createLocalManifestStore } from '../ingredient-authoring/local-manifest-store.js';
import { buildChatTier1Handlers, type ChatToolHandlerDeps } from '../chat-tool-handlers.js';
import { ungroundedArgumentsInCall } from '../tool-argument-grounding.js';

const LA = 'America/Los_Angeles';
const at = Date.parse('2026-10-19T12:00:00Z');
const owner: ExecutionSource = { channel: 'chat', actor: 'user_self', user_id: 'owner', chat_session_id: 's' };

describe('D-338 situation.query reads a day the model names on the owner\'s clock', () => {
  it('reads a day, and days with both ends included, from midnight to midnight there', () => {
    expect(parseSituationQueryInput({ time: '2026-11-05' }, 'Europe/Dublin').time)
      .toEqual({ from: Date.parse('2026-11-05T00:00:00Z'), to: Date.parse('2026-11-06T00:00:00Z') - 1 });
    expect(parseSituationQueryInput({ time: '2026-11-05' }, LA).time)
      .toEqual({ from: Date.parse('2026-11-05T08:00:00Z'), to: Date.parse('2026-11-06T08:00:00Z') - 1 });
    // A week across the clock change on 1 November: it starts on summer time and ends on winter time.
    expect(parseSituationQueryInput({ time: { first_day: '2026-10-31', last_day: '2026-11-06' } }, LA).time)
      .toEqual({ from: Date.parse('2026-10-31T07:00:00Z'), to: Date.parse('2026-11-07T08:00:00Z') - 1 });
    // Without a zone a day is a UTC day, as a date-only due is.
    expect(parseSituationQueryInput({ time: '2026-11-05' }).time).toEqual({ from: Date.parse('2026-11-05T00:00:00Z'), to: Date.parse('2026-11-06T00:00:00Z') - 1 });
  });

  it('keeps Unix ms as it was, and the other fields with a day', () => {
    expect(parseSituationQueryInput({ time: 5 }, LA).time).toBe(5);
    expect(parseSituationQueryInput({ time: { from: 1, to: 2 } }, LA).time).toEqual({ from: 1, to: 2 });
    expect(parseSituationQueryInput({ time: '2026-11-05', text: 'dentist', limit_items: 3 }, LA))
      .toMatchObject({ text: 'dentist', limit_items: 3, time: { from: Date.parse('2026-11-05T08:00:00Z') } });
  });

  it('refuses a day that does not exist, days out of order, and days under from and to, saying what it takes', () => {
    for (const time of ['2026-02-30', '2026-11-5', '05/11/2026', { first_day: '2026-11-06', last_day: '2026-11-05' }, { first_day: '2026-11-05' },
      { from: '2026-11-05', to: '2026-11-05' }, { first_day: '2026-11-05', last_day: '2026-11-05', from: 1 }, { from: 2, to: 1 }]) {
      expect(() => parseSituationQueryInput({ time }, LA), JSON.stringify(time)).toThrow('give time as a day "YYYY-MM-DD", days {"first_day","last_day"} or Unix ms');
    }
  });

  it('advertises every form it takes, and names the days first', () => {
    const branches = SITUATION_QUERY_SCHEMA.properties.time.anyOf as readonly Record<string, unknown>[];
    const matches = (value: unknown) => branches.filter(branch => branch.type === 'integer' ? Number.isInteger(value)
      : branch.type === 'string' ? typeof value === 'string' && new RegExp(String(branch.pattern), 'u').test(value)
        : Boolean(value) && typeof value === 'object'
          && JSON.stringify(Object.keys(value as object).sort()) === JSON.stringify([...(branch.required as string[])].sort()));
    for (const time of ['2026-11-05', { first_day: '2026-11-05', last_day: '2026-11-11' }, 5, { from: 1, to: 2 }]) {
      expect(() => parseSituationQueryInput({ time }, LA)).not.toThrow();
      expect(matches(time), JSON.stringify(time)).toHaveLength(1);
    }
    expect(branches[0]).toMatchObject({ type: 'string' });
    const description = TIER1_TOOL_DESCRIPTORS['situation.query']!.description;
    expect(description).toContain('a day `"2026-11-05"`, or days `{"first_day":"2026-11-05","last_day":"2026-11-11"}` with both included, on the owner\'s clock');
    expect(description).toContain('`private: true` marks an item the owner\'s notifications call only "a reminder in Yours": text meant for a notification writes that, never its title; any other answer names it as usual.');
  });

  it('is not refused as an invented identifier, which a date under from or to would be', () => {
    // The packet a run on 4 November reads: tomorrow's date is in none of it.
    const packet = JSON.stringify({ current_date: 'Wednesday 2026-11-04 11:49 (UTC+00:00)', user_message: 'My agenda for tomorrow goes to me at this time.' });
    expect(ungroundedArgumentsInCall({ time: '2026-11-05' }, packet)).toEqual([]);
    expect(ungroundedArgumentsInCall({ time: { first_day: '2026-11-05', last_day: '2026-11-05' } }, packet)).toEqual([]);
    expect(ungroundedArgumentsInCall({ time: { from: '2026-11-05', to: '2026-11-05' } }, packet).map(found => found.path)).toEqual(['time.from', 'time.to']);
  });
});

let db: Database.Database; let contracts: ContractStore;
beforeEach(() => { db = new Database(':memory:'); contracts = createContractStore(db, { now: () => at }); });
afterEach(() => db.close());
const fact = (id: string, title: string, from: string, to: string): SituationFact => {
  const when = { from: Date.parse(from), to: Date.parse(to) };
  return { ref: { collection: 'calendar', id: `work:${id}` }, title, kind: 'calendar', basis: 'declared', when, act_by: when.from, valid_until: when.to,
    people: [], subjects: [], related: [], evidence: [{ collection: 'calendar', id: `work:${id}` }], updated_at: at, consequence: 'routine' };
};
// 23:00–23:30 on Monday 19 and on Tuesday 20 October in Los Angeles; in Tokyo, 15:00 the next day.
const facts = [fact('monday', 'Monday call', '2026-10-20T06:00:00Z', '2026-10-20T06:30:00Z'), fact('tuesday', 'Tuesday call', '2026-10-21T06:00:00Z', '2026-10-21T06:30:00Z')];
const accessOver = (extra: { timeZone?: () => string; isPrivate?: (item: SituationItem) => boolean } = {}, over: SituationFact[] = facts) => {
  const query = createSituationQuery({ now: () => at, sources: [{ id: 'calendar', collection: 'calendar', verb_op: 'core.work-entity.read', read: vi.fn(() => over) }],
    sourceForCollection: collection => ({ verb_op: 'core.work-entity.read', collection }) });
  return createSituationAccess({ contracts, query, now: () => at, isVaultUnlocked: () => true, ...extra });
};
type Row = { ref: { id: string }; what: { value: string }; when: { verdict: string }; private?: true } & Record<string, unknown>;
const rowsOf = (result: unknown) => (result as { clusters: Array<{ items: Row[] }> }).clusters.flatMap(cluster => cluster.items);
const matched = (result: unknown) => rowsOf(result).filter(row => row.when.verdict === 'match').map(row => row.what.value).sort();

describe('D-338 the chat reads a named day on its turn\'s clock, and a caller without one on the server\'s', () => {
  // 20 October is a different 24 hours on each clock, and each holds a different pair of these.
  const across = [fact('a', 'Tokyo only', '2026-10-19T20:00:00Z', '2026-10-19T20:30:00Z'),
    fact('b', 'Tokyo and UTC', '2026-10-20T03:00:00Z', '2026-10-20T03:30:00Z'),
    fact('c', 'UTC and Los Angeles', '2026-10-20T20:00:00Z', '2026-10-20T20:30:00Z'),
    fact('d', 'Los Angeles only', '2026-10-21T03:00:00Z', '2026-10-21T03:30:00Z')];
  const ask = async (server: string | undefined, turn: string | undefined) => {
    const handlers = buildChatTier1Handlers({ getSituationAccess: () => accessOver(server ? { timeZone: () => server } : {}, across) } as ChatToolHandlerDeps);
    const result = await handlers['situation.query']!({ time: '2026-10-20' }, { execution_source: owner, ...(turn ? { time_zone: turn } : {}) } as never) as { ok: true; result: unknown };
    return matched(result.result);
  };

  it('reads the day in the turn\'s zone, which the turn\'s date is in', async () => {
    expect(await ask('Asia/Tokyo', LA)).toEqual(['Los Angeles only', 'UTC and Los Angeles']);
  });

  it('reads it in the server\'s zone for a caller with no clock of its own (an MCP agent, a recipe), and as UTC with none', async () => {
    expect(await ask('Asia/Tokyo', undefined)).toEqual(['Tokyo and UTC', 'Tokyo only']);
    expect(await ask(undefined, undefined)).toEqual(['Tokyo and UTC', 'UTC and Los Angeles']);
  });
});

const resolver = () => createMetaFieldPrivacyResolverFromLocalManifestStore(createLocalManifestStore(db),
  CANONICAL_PII_ENTITY_SCHEMAS, CANONICAL_PII_CATALOG_MANIFESTS, CANONICAL_PII_ENTITY_PRIVACY_TAGS);

describe('D-338 a model is told which items the owner\'s notifications keep private', () => {
  const privateTuesday = (item: SituationItem) => item.ref.id === 'work:tuesday';

  it('marks them beside the title in situation.query\'s result, and no other', async () => {
    const handlers = buildChatTier1Handlers({ getSituationAccess: () => accessOver({ isPrivate: privateTuesday }) } as ChatToolHandlerDeps);
    const turn = await handlers['situation.query']!({ time: { first_day: '2026-10-19', last_day: '2026-10-21' } }, { execution_source: owner, time_zone: LA } as never) as { ok: true; result: unknown };
    const rows = rowsOf(turn.result);
    expect(Object.fromEntries(rows.map(row => [row.what.value, row.private]))).toEqual({ 'Monday call': undefined, 'Tuesday call': true });
    expect(Object.keys(rows.find(row => row.private)!).slice(0, 4)).toEqual(['ref', 'kind', 'private', 'what']);
  });

  it('marks them in the chat\'s lookup too, which the chat\'s checks let through to the model', async () => {
    const chatDb = new Database(':memory:'); ensureChatSchema(chatDb);
    const chatStore = createChatStore(chatDb); chatStore.setRollingBriefEnabled(false);
    const sent: string[] = []; let ids = 0;
    const orchestrator = createChatOrchestrator({ chatStore, broadcast: { emit: () => undefined },
      registry: { list: () => [], listByTier: () => [], getByName: () => null, dispatch: async () => ({ ok: false, reason: 'not_implemented' }),
        subscribeRefresh: () => () => undefined },
      selfSignature: { server_kind: 'recued', version: '1.0.0', instance_id: 'inst-test' }, mintId: () => `id-${++ids}`, now: () => at,
      getSituationAccess: () => accessOver({ isPrivate: privateTuesday }),
      piiLedgerStore: piiEgress.createSessionLedgerStore(), fieldPrivacyResolver: resolver(),
      executeAiCall: async (_manifest, request) => { sent.push(String(request['llm.prompt'])); return { body: { response: 'ok', events: [], tool_calls: [] } }; } });
    chatStore.createSession({ id: 's', now: at });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      await orchestrator.runTurn({ session_id: 's', message: 'When is the Tuesday call?', picker_state: { current: 'self' }, time_zone: LA });
    } finally { vi.useRealTimers(); chatDb.close(); }
    const block = ((JSON.parse(sent[0]!) as { prefetch_context?: string[] }).prefetch_context ?? []).join('\n');
    const rows = block.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line) as Row);
    expect(rows.map(row => [row.what.value, row.private])).toContainEqual(['Tuesday call', true]);
    expect(rows.filter(row => row.what.value !== 'Tuesday call').every(row => row.private === undefined)).toBe(true);
  });

  it('by the Agenda\'s own rule: an occasion with people in it is private, one without is not', () => {
    ensureWorkEntitySchema(db);
    const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
    const query = createSituationQuery({ now: () => at, sources: [], sourceForCollection: () => undefined });
    const service = createScheduledSituations({ db, work, store: createSituationStore(db), query, timeZone: () => LA, isVaultUnlocked: () => true,
      now: () => at, isQuiet: () => false, send: async () => ({ delivered_to: [] }),
      overview: async () => ({ proposal_count: 0, newest_proposal: null, unmatched_replies: [], phone_ready: true }) });
    const history = createProactiveHistoryStore(db, createProactiveProposalStore(db));
    const birthday = history.saveOccasion({ title: 'Anna’s birthday', month_day: '11-05', people: ['anna@example.com'], muted: false, rules: [], sphere: 'personal' }, at);
    const party = history.saveOccasion({ title: 'Street party', month_day: '11-05', people: [], muted: false, rules: [], sphere: 'personal' }, at);
    const item = (collection: string, id: string) => ({ ref: { collection, id, field: 'rules.date' }, evidence: [{ collection, id, field: 'rules.date' }] }) as unknown as SituationItem;
    expect(service.isPrivateItem(item('occasion', birthday.id))).toBe(true);
    expect(service.isPrivateItem(item('occasion', party.id))).toBe(false);
    expect(service.isPrivateItem(item('calendar', 'work:dentist'))).toBe(false);
  });
});
