/** D-342 slice 3 (§5) — the Agenda's AI suggestions read the owner's active pursuits on every run,
 *  beside the day, and no other read does. Through the real asset source and clock index, the real
 *  scheduled-prompt service (the Agenda's managed schedule) and the access the chat's tool reads
 *  through; no model runs. */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PURSUIT_CLASS_ID, parseSituationQueryInput, type Asset, type AssetRule, type ExecutionSource, type InternalToolRegistry } from '@recued/contracts';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createAssetOccurrenceService } from '../situations/asset-occurrence-service.js';
import { buildSituationSources } from '../situations/sources.js';
import { createSituationQuery } from '../situations/query.js';
import { createReminderStore } from '../storage/reminder-store.js';
import { createSituationAccess } from '../situations/access.js';
import { createScheduledSituations } from '../situations/scheduled-situations.js';
import { agendaSuggestionsPrompt } from '../situations/agenda-suggestions.js';
import { situationModelProjection } from '../situations/model-projection.js';
import { createSituationStore } from '../storage/situation-store.js';
import { createContractStore } from '../storage/contract-store.js';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createChatOrchestrator } from '../chat-orchestrator.js';
import { createSqliteChatPlanStore } from '../storage/chat-plan-store.js';
import { withQueuedChatTurns } from '../chat-turn-queue.js';
import { createPromptSchedules } from '../prompt-schedules.js';
import { piiEgress } from '@recued/gateway';
import { createClosingRecords } from '../situations/closing-records.js';
import { createProactiveHistoryStore } from '../storage/proactive-history-store.js';
import { createProactiveProposalStore } from '../storage/proactive-proposal-store.js';
import { situationItemForModel } from '../situations/model-projection.js';
import { validateRetainablePromptPart } from '../chat-pii-source.js';
import { buildChatTier1Handlers, type ChatToolHandlerDeps } from '../chat-tool-handlers.js';
import { createPiiEgressPlanForSession, wrapExecuteAiCallForPii } from '../chat-pii-egress.js';
import { createMetaFieldPrivacyResolverFromLocalManifestStore } from '../meta-field-privacy-resolver.js';
import { CANONICAL_PII_CATALOG_MANIFESTS, CANONICAL_PII_ENTITY_PRIVACY_TAGS, CANONICAL_PII_ENTITY_SCHEMAS } from '../canonical-pii-schemas.js';
import { createLocalManifestStore } from '../ingredient-authoring/local-manifest-store.js';

// Monday 19 October 2026, 06:00 UTC; "tomorrow" is the 20th.
const NOW = Date.parse('2026-10-19T06:00:00Z');
const TOMORROW = '2026-10-20';
/** Every part of the fixture reads this clock; a test that crosses a day moves it. */
const clock = { at: NOW };
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { clock.at = NOW; for (const close of cleanups.splice(0).reverse()) await close(); });

const ownerChat: ExecutionSource = { channel: 'chat', actor: 'user_self', chat_session_id: 'chat-1', user_id: 'owner' };
const runOf = (schedule_id: string): ExecutionSource => ({ channel: 'schedule', actor: 'system', schedule_id, cron: '0 7 * * *',
  prompt_schedule: { schedule_id, occurrence_id: 'occurrence-1', revision: 1, due_at: NOW, cron: '0 7 * * *' },
  chat_session_id: 'suggestions-session', turn_id: 'turn-1' } as ExecutionSource);
const renew: AssetRule = { id: 'renew', title: 'Renew', enabled: true, muted: false, pinned: false, consequence: 'routine',
  expiry_policy: 'strict_expire', when: { kind: 'expiry', field: 'renews_on' }, reaction: { notify: true, occurrence: 'action', emit: false },
  schedule: { before: [], on_day: true } };

const fixture = async () => {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON'); ensureWorkEntitySchema(db); ensureChatSchema(db);
  const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work), now: () => clock.at });
  const occurrences = createAssetOccurrenceService({ db, work, dispatchers, now: () => clock.at, timeZone: () => 'UTC' });
  const sources = buildSituationSources({ db, work, reminders: createReminderStore(db), calendars: () => [], now: () => clock.at, timeZone: () => 'UTC' });
  const query = createSituationQuery({ now: () => clock.at, sources, sourceForCollection: collection => ({ verb_op: 'core.work-entity.read', collection }) });
  // The chat's scheduled prompts, as D-338's test builds them: the Agenda's managed schedule is real.
  const chat = createChatStore(db); const plans = createSqliteChatPlanStore(db);
  const registry: InternalToolRegistry = { list: () => [], listByTier: () => [], getByName: () => null,
    dispatch: async () => ({ ok: true, result: {} }), subscribeRefresh: () => () => {} };
  const runTurn = async (input: { queue_turn_id?: string }) => ({ turn_id: input.queue_turn_id! });
  const base = createChatOrchestrator({ chatStore: chat, registry, selfSignature: { server_kind: 'recued', version: '1', instance_id: 'd342' } });
  const queue = withQueuedChatTurns({ ...base, runTurn }, { db, store: chat, pollMs: 10 }).turnQueue!;
  const schedules = createPromptSchedules({ db, store: chat, instanceId: 'd342', now: () => clock.at, runTurn, queue,
    readPlans: (session, turn) => plans.listForTurn(session, turn) });
  const send = vi.fn(async (_message: import('../notification-handler.js').NotificationSendArgs) => ({ delivered_to: ['in_app'] }));
  const scheduled = createScheduledSituations({ db, work, store: createSituationStore(db), query, timeZone: () => 'UTC', isVaultUnlocked: () => true,
    now: () => clock.at, isQuiet: () => false, quietEnd: () => null, send, mailHealth: () => [], summarize: () => Promise.resolve(undefined), prepNotesReady: () => false,
    overview: async () => ({ proposal_count: 0, newest_proposal: null, unmatched_replies: [], phone_ready: true }), promptSchedules: () => schedules });
  // As the composition root wires it (`compose-execution-context.ts`).
  const access = createSituationAccess({ contracts: createContractStore(db), query, now: () => clock.at, isVaultUnlocked: () => true,
    isPrivate: item => scheduled.isPrivateItem(item), readsPursuits: source => scheduled.readsPursuits(source) });
  scheduled.bindAccess(access);
  cleanups.push(async () => { await scheduled.stop(); queue.close(); db.close(); });
  const asset = (name: string, patch: Partial<Asset>) => work.writeAsset({ source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' },
    name, ...patch } as never, NOW - 86_400_000);
  // A thing due tomorrow, by its clock, and three pursuits: open, private (the owner's choice) and ended.
  const insurance = asset('Car insurance', { dates: { renews_on: TOMORROW }, rules: [renew] }); await occurrences.reconcileAsset(insurance.id);
  // The open one has no private setting, as its type makes it (ruling 9).
  const run = asset('Run a 10k', { class_id: PURSUIT_CLASS_ID, dates: { target_on: '2027-03-01' },
    attributes: { horizon: 'by spring 2027', where_i_am: 'Up to 6 km without stopping' }, readings: { progress: { value: 6, unit: 'km', as_of: NOW - 1000, evidence: [] } } });
  const spanish = asset('Learn Spanish', { class_id: PURSUIT_CLASS_ID, settings: { sensitive: true }, attributes: { where_i_am: 'Finished unit 4' } });
  const novel = asset('Write a novel', { class_id: PURSUIT_CLASS_ID, settings: { sensitive: true }, status: 'retired', attributes: { ended_as: 'let_go' } });
  // Indexed as a write on the server indexes them: an asset its clock index has not evaluated is
  // read by every window, which would find a pursuit with no help from the pursuits' own seed.
  for (const id of [run.id, spanish.id, novel.id]) await occurrences.reconcileAsset(id);
  // The owner turns the suggestions on: the Agenda makes its managed schedule.
  scheduled.setAgenda({ enabled: true, time: '07:00', day: 'tomorrow', suggestions: true }); await scheduled.syncAgendaSuggestions();
  const [managed] = (await schedules.list(undefined, { managed: true })).filter(row => row.managed_by === 'agenda');
  const read = async (source: ExecutionSource) => (await access.read({ time: TOMORROW }, source, undefined, 'UTC')).clusters.flatMap(cluster => cluster.items);
  return { db, work, scheduled, access, schedules, managed: managed!, send, insurance, run, spanish, novel, read };
};

describe('D-342 §5 — the suggestions read the owner’s pursuits beside the day', () => {
  it('lists each active pursuit, with its own fields, beside the day’s items; never an ended one, and never as due', async () => {
    const f = await fixture();
    const items = await f.read(runOf(f.managed.schedule_id));
    expect(items.find(item => item.ref.id === f.insurance.id)).toMatchObject({ kind: 'asset_rule', reasons: expect.arrayContaining(['due']) });
    const pursuits = items.filter(item => item.kind === 'pursuit');
    expect(pursuits.map(item => item.what.value).sort()).toEqual(['Learn Spanish', 'Run a 10k']);
    const run = pursuits.find(item => item.ref.id === f.run.id)!;
    expect(run).toMatchObject({ ref: { collection: 'asset', id: f.run.id }, reasons: ['pursuing'],
      details: { class_id: 'pursuit', dates: { target_on: '2027-03-01' }, readings: { progress: { value: 6, unit: 'km' } },
        attributes: { horizon: 'by spring 2027', where_i_am: 'Up to 6 km without stopping' } } });
    expect(items.some(item => item.ref.id === f.novel.id)).toBe(false);
  });
  it('marks a private pursuit private in the copy the model reads, as the Agenda keeps it', async () => {
    const f = await fixture();
    const result = await f.access.read({ time: TOMORROW }, runOf(f.managed.schedule_id), undefined, 'UTC');
    const model = situationModelProjection(result, undefined, { isPrivate: f.access.isPrivate }).clusters.flatMap(cluster => cluster.items);
    expect(model.find(item => item.ref.id === f.spanish.id)).toMatchObject({ kind: 'pursuit', private: true });
    expect(model.find(item => item.ref.id === f.run.id)).not.toHaveProperty('private');
  });
  it('asks the model for a step on a pursuit where the day has room, and to leave out a private one', () => {
    const prompt = agendaSuggestionsPrompt({ enabled: true, time: '07:00', day: 'tomorrow', frequency: 'daily', weekday: 1, suggestions: true } as never);
    expect(prompt).toContain('which lists the same items my agenda does, and beside them what I am working toward (kind pursuit): give it tomorrow as a date.');
    expect(prompt).toContain('and, where the day has room, a step on one of my pursuits that fits it, from where I am with it');
    expect(prompt).toContain('Leave out a pursuit marked private. Leave out any other item marked private unless a suggestion involves it');
    // D-343 (2026-11-15) — a time for what has none, in a free stretch of the day.
    expect(prompt).toContain('Where an item has no time, or for a step on a pursuit, propose one: a time in a free stretch of tomorrow');
    expect(prompt).toContain('Give each its own time: two in one gap only if both fit in it, one after the other.');
    expect(prompt).toContain('Never tell me a day is unknown or unrecorded.');
    expect(prompt).toContain('Name a gap by when the item before it ends ("free from 19:30, after the team review"), not when it starts.');
    expect(prompt).toContain('not one already past and not over a timed item');
    // Run ahead of the stream, a time must not come before the message does.
    expect(agendaSuggestionsPrompt({ enabled: true, time: '07:00', day: 'today', frequency: 'daily', weekday: 1, suggestions: true, head_start: true } as never))
      .toContain('not before this reaches me (allow 15 minutes from now) and not over a timed item');
  });
});

describe('D-342 §5 — no other read lists pursuits', () => {
  it('leaves them out of the owner’s chat, another schedule’s run, and a run once the suggestions’ schedule is gone', async () => {
    const f = await fixture();
    for (const source of [ownerChat, runOf('another-schedule')]) {
      const items = await f.read(source);
      expect(items.some(item => item.ref.id === f.insurance.id)).toBe(true);
      expect(items.filter(item => item.kind === 'pursuit' || item.ref.id === f.run.id || item.ref.id === f.spanish.id)).toEqual([]);
    }
    f.db.prepare('DELETE FROM chat_prompt_schedules WHERE schedule_id=?').run(f.managed.schedule_id);
    expect((await f.read(runOf(f.managed.schedule_id))).some(item => item.kind === 'pursuit')).toBe(false);
  });
  it('leaves them out of Today and the Agenda', async () => {
    const f = await fixture();
    const today = (await f.scheduled.today({ now: NOW, before: NOW + 7 * 86_400_000 })).situations.clusters.flatMap(cluster => cluster.items);
    expect(today.some(item => item.ref.id === f.insurance.id)).toBe(true);
    expect(today.some(item => item.kind === 'pursuit' || item.ref.id === f.run.id)).toBe(false);
    await f.scheduled.sendAgendaNow();
    const sent = f.send.mock.calls.map(([message]) => `${message.title}\n${message.text}`).join('\n');
    expect(sent).toContain('Car insurance');
    expect(sent).not.toMatch(/10k|Spanish|novel/u);
  });
  it('never lets a model ask for them: the tool’s input refuses the flag', async () => {
    const f = await fixture();
    expect(() => parseSituationQueryInput({ time: TOMORROW, include_pursuits: true })).toThrow('Invalid situation query');
    await expect(f.access.read({ time: TOMORROW, include_pursuits: true }, ownerChat)).rejects.toThrow('Invalid situation query');
  });
});

describe('D-343 slice 5 (§5) — the suggestions read the days the owner recorded each pursuit this week', () => {
  /** The owner's closing records, as `episode.record` writes them once approved. */
  const recordsOf = (f: Awaited<ReturnType<typeof fixture>>) => {
    const history = createProactiveHistoryStore(f.db, createProactiveProposalStore(f.db));
    const closing = createClosingRecords({ db: f.db, history, work: f.work, calendars: () => [], timeZone: () => 'UTC', now: () => clock.at });
    const record = (pursuit: Asset, day: string, outcome: 'done' | 'skipped') => closing.record({ day,
      records: [{ title: outcome === 'done' ? `Worked on ${pursuit.name}` : `Skipped ${pursuit.name}`, outcome, item: closing.item({ collection: 'asset', id: pursuit.id })! }] })[0]!;
    return { history, record };
  };

  it('lists the days of the past week done and skipped, newest first, and leaves out older ones and one the owner hid', async () => {
    const f = await fixture(); const { history, record } = recordsOf(f);
    // Monday 19 October: the week is Tuesday 13 to Monday 19.
    record(f.run, '2026-10-18', 'done'); record(f.run, '2026-10-17', 'done'); record(f.run, '2026-10-15', 'skipped');
    record(f.run, '2026-10-12', 'done');
    const hidden = record(f.run, '2026-10-14', 'done'); history.suppressEpisode(hidden.id, NOW);
    // A day with a record of each is a day it was done (the owner's own Record episode beside the chat's).
    record(f.run, '2026-10-16', 'skipped');
    history.saveEpisode({ title: 'Ran after all', when: { from: Date.parse('2026-10-16T18:00:00Z'), to: Date.parse('2026-10-16T19:00:00Z') }, people: [],
      subjects: [{ collection: 'asset', id: f.run.id }], evidence: [], basis: 'declared', sensitive: [], storage_reason: 'owner_record' }, NOW);
    const items = await f.read(runOf(f.managed.schedule_id));
    expect(items.find(item => item.ref.id === f.run.id)!.recorded).toEqual({ done: ['Sun 2026-10-18', 'Sat 2026-10-17', 'Fri 2026-10-16'], skipped: ['Thu 2026-10-15'] });
    // Never recorded this week: nothing, for a day not recorded is unknown, not missed.
    expect(items.find(item => item.ref.id === f.spanish.id)).not.toHaveProperty('recorded');
  });

  it('reaches the model as written, through the tool and the privacy egress, and in the lookup\'s closed copy', async () => {
    const f = await fixture(); const { record } = recordsOf(f);
    record(f.run, '2026-10-18', 'done'); record(f.run, '2026-10-15', 'skipped');
    const handlers = buildChatTier1Handlers({ getSituationAccess: () => f.access } as ChatToolHandlerDeps);
    const tool = await handlers['situation.query']!({ time: TOMORROW }, { execution_source: runOf(f.managed.schedule_id), time_zone: 'UTC' } as never) as { ok: true; result: unknown };
    const resolver = createMetaFieldPrivacyResolverFromLocalManifestStore(createLocalManifestStore(f.db),
      CANONICAL_PII_ENTITY_SCHEMAS, CANONICAL_PII_CATALOG_MANIFESTS, CANONICAL_PII_ENTITY_PRIVACY_TAGS);
    const plan = createPiiEgressPlanForSession({ ledgerStore: piiEgress.createSessionLedgerStore(), resolver }, 'suggestions-session', 'chat');
    let sent = '';
    await wrapExecuteAiCallForPii(async (_manifest, request) => { sent = String(request['llm.prompt']); return { body: { response: 'ok', events: [], tool_calls: [] } }; }, plan)(
      {} as never, { 'llm.prompt': JSON.stringify({ user_message: 'My agenda for tomorrow goes to me at this time.',
        prior_tool_calls: [{ tool_name: 'situation.query', tier: 1, args: { time: TOMORROW }, status: 'ok', result: tool.result }] }) });
    expect(sent).toContain('"recorded":{"done":["Sun 2026-10-18"],"skipped":["Thu 2026-10-15"]}');
    // The chat's lookup takes a situation item only in its closed shape: a field it does not name
    // turns the whole item away.
    const item = (await f.read(runOf(f.managed.schedule_id))).find(row => row.ref.id === f.run.id)!;
    expect(() => validateRetainablePromptPart({ role: 'entity', source: 'situations', entity: 'situation_item',
      payload: [situationItemForModel(item)], render: () => '' } as never)).not.toThrow();
  });

  it('asks for a step from the days recorded, and says a day not listed is unknown', () => {
    const prompt = agendaSuggestionsPrompt({ enabled: true, time: '07:00', day: 'tomorrow', frequency: 'daily', weekday: 1, suggestions: true } as never);
    expect(prompt).toContain('a step on one of my pursuits that fits it, from where I am with it and the days this week I recorded doing or skipping it '
      + '(recorded; a day it does not list is unknown, not one I missed).');
  });
});

describe('D-343 — the loop across days: a day closed in the chat is what the next morning\'s suggestions read', () => {
  it('records Monday through the chat\'s own approved episode.record, and Tuesday\'s suggestions read it as done', async () => {
    const f = await fixture();
    // Monday 19 October, 21:00 UTC: the owner closes the day in the chat.
    clock.at = Date.parse('2026-10-19T21:00:00Z');
    const history = createProactiveHistoryStore(f.db, createProactiveProposalStore(f.db));
    const closing = createClosingRecords({ db: f.db, history, work: f.work, calendars: () => [], timeZone: () => 'UTC', now: () => clock.at });
    const handlers = buildChatTier1Handlers({ getClosingRecords: () => closing, now: () => clock.at,
      getOpAdmissionGate: () => ({ isFrozenByPause: () => false, isOwnerGoverned: () => true, isOpGranted: () => true }) } as unknown as ChatToolHandlerDeps);
    const approved = { channel: 'internal_function_call', session_id: 'close-1', execution_source: ownerChat, owner_approved: true } as never;
    const readWednesday = async () => (await f.access.read({ time: '2026-10-21' }, runOf(f.managed.schedule_id), undefined, 'UTC')).clusters.flatMap(cluster => cluster.items);
    // Before the close, nothing is recorded for the run this week.
    expect((await readWednesday()).find(item => item.ref.id === f.run.id)).not.toHaveProperty('recorded');
    const result = await handlers['episode.record']!({ day: '2026-10-19', time_zone: 'UTC', records: [
      { title: 'Ran 5 km', outcome: 'done', item: { collection: 'asset', id: f.run.id } },
      { title: 'No Spanish today', outcome: 'skipped', item: { collection: 'asset', id: f.spanish.id } },
    ] }, approved);
    expect(result).toMatchObject({ ok: true, result: { recorded: 2, day: '2026-10-19' } });
    // Tuesday 20 October, 06:00 UTC: the suggestions' run reads Wednesday, and the week behind it.
    clock.at = Date.parse('2026-10-20T06:00:00Z');
    const items = await readWednesday();
    expect(items.find(item => item.ref.id === f.run.id)!.recorded).toEqual({ done: ['Mon 2026-10-19'], skipped: [] });
    expect(items.find(item => item.ref.id === f.spanish.id)!.recorded).toEqual({ done: [], skipped: ['Mon 2026-10-19'] });
    // The ended pursuit stays out, record or none.
    expect(items.some(item => item.ref.id === f.novel.id)).toBe(false);
  });
});
