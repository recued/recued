/** D-343 slice 2 (§4, ruling 18) — `episode.record`: the owner's record of a day, in their words,
 *  one call for the day. Each record is something they did or skipped, about an item on that day's
 *  agenda or about nothing planned, kept as a stored, declared episode. Before this, no chat tool
 *  wrote an episode: the chat said it had "noted" a day, and nothing kept it.
 *
 *  ⛔ DRIVEN ON THE REAL STORES AND HANDLERS: the history store, a calendar table, the work store and
 *  the contact store. */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isWriteRuleTool, tier1CallDetails, tier1CallTitle, tier1WriteStaysInRecued, writeRuleScopeOf, type ExecutionSource, type SituationRef } from '@recued/contracts';
import { buildChatTier1Handlers, type ChatToolHandlerDeps } from '../chat-tool-handlers.js';
import { withTurnZone } from '../chat-clock.js';
import { checkEpisodeRecord, EPISODE_RECORD_OP_ID } from '../episode-record-tool.js';
import { createClosingRecords } from '../situations/closing-records.js';
import { situationSourceAccess } from '../situations/sources.js';
import { createCalendarTable } from '../collections/calendar/calendar-table.js';
import { createContactStore } from '../storage/contact-store.js';
import { createProactiveHistoryStore } from '../storage/proactive-history-store.js';
import { createProactiveProposalStore } from '../storage/proactive-proposal-store.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';

const owner: ExecutionSource = { channel: 'chat', actor: 'user_self', chat_session_id: 'chat-1', user_id: 'user-1' };
const app: ExecutionSource = { channel: 'mcp', actor: 'contracted_user', agent_id: 'agent', tool_call_id: 'call-1', mcp_token_id: 'tok-1', contract_id: 'app-1' };
/** The owner's chat before they are asked (the check), and the approved run, which carries the
 *  turn's zone in its arguments and none of its own. */
const inChat = { channel: 'internal_function_call', session_id: 'sess-1', execution_source: owner, time_zone: 'Europe/Dublin' } as never;
const approved = { channel: 'internal_function_call', session_id: 'sess-1', execution_source: owner, owner_approved: true } as never;
const overMcp = { channel: 'mcp_wire', mcp_token_id: 'tok-1', execution_source: app, owner_approved: true } as never;
type Refused = { ok: false; reason: string; detail: string };
/** Saturday 7 November 2026, 21:00 in Dublin, which is on UTC in November. */
const NOW = Date.parse('2026-11-07T21:00:00Z');
const DUBLIN = { time_zone: 'Europe/Dublin' };

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); });
afterEach(() => db.close());

const harness = (granted: (source: ExecutionSource, op: string) => boolean = () => true) => {
  ensureWorkEntitySchema(db); const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work), now: () => NOW });
  const history = createProactiveHistoryStore(db, createProactiveProposalStore(db));
  const contacts = createContactStore(db); const calendar = createCalendarTable({ db, slug: 'local' });
  const closing = createClosingRecords({ db, history, work, calendars: () => [{ slug: 'local', table: calendar }], contacts,
    timeZone: () => 'Europe/Dublin', now: () => NOW });
  const deps = {
    getClosingRecords: () => closing,
    getOpAdmissionGate: () => ({ isFrozenByPause: () => false, isOwnerGoverned: () => true, isOpGranted: (source: ExecutionSource, op?: string) => op === undefined || granted(source, op) }),
    now: () => NOW,
  } as unknown as ChatToolHandlerDeps;
  const ana = contacts.upsertManual({ email: 'ana@example.com', name: 'Ana' }, NOW - 86_400_000);
  // Friday's call with Ana at Café Lumen, 15:00–15:30, which a stranger was asked to as well.
  calendar.upsert({ size_bytes: 0, now: NOW - 86_400_000, event: { source_id: 'call-ana', ical_uid: 'call-ana', calendar_id: 'home',
    summary: 'Call with Ana', location: 'Café Lumen', start_at: Date.parse('2026-11-06T15:00:00Z'), end_at: Date.parse('2026-11-06T15:30:00Z'),
    timezone: 'Europe/Dublin', is_all_day: false, status: 'confirmed', created_at: 1, updated_at: 1, attendees: [
      { email: 'ana@example.com', response_status: 'accepted' }, { email: 'stranger@example.net', response_status: 'accepted' },
      { email: 'me@example.com', response_status: 'accepted', is_self: true }] } });
  const call = calendar.get('call-ana')!;
  const callRef: SituationRef = { collection: 'calendar', id: `local:${call.record_id}` };
  const spanish = work.writeAsset({ source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner:user-1' }, name: 'Spanish' }, NOW - 86_400_000);
  const spanishRef: SituationRef = { collection: 'asset', id: spanish.id };
  return { history, dispatchers, deps, ana, callRef, spanishRef, record: buildChatTier1Handlers(deps)['episode.record']! };
};

describe('D-343 slice 2 — the chat records a day in one call', () => {
  it('writes each thing done or skipped as the owner’s record, asked before the owner is', async () => {
    const f = harness();
    const task = (await f.dispatchers.taskCreate({ title: 'Book the dentist' } as never)).task;
    const taskRef = { collection: 'task', id: task.id };
    const haircut = (await f.dispatchers.bookingCreate({ title: 'Haircut', slot_start_at: Date.parse('2026-11-06T10:00:00Z'),
      slot_end_at: Date.parse('2026-11-06T11:00:00Z'), counterparty_contact_id: f.ana.contact_id } as never)).booking;
    const haircutRef = { collection: 'booking', id: haircut.id };
    const day = { day: '2026-11-06', ...DUBLIN, records: [
      { title: 'Did the call with Ana', outcome: 'done', item: f.callRef },
      { title: 'Haircut, Ana cut it', outcome: 'done', item: haircutRef },
      { title: 'Booked the dentist', outcome: 'done', item: taskRef },
      { title: 'Spanish', outcome: 'skipped', item: f.spanishRef },
      { title: 'Went for a walk', outcome: 'done' },
    ] };
    // One ask, the day's checklist in the owner's words.
    expect(tier1CallTitle('episode.record', day)).toBe('Record your day · Fri 6 Nov');
    expect(tier1CallDetails('episode.record', day)).toEqual({ args: { Done: ['Did the call with Ana', 'Haircut, Ana cut it', 'Booked the dentist', 'Went for a walk'],
      Skipped: ['Spanish'] } });
    expect(await checkEpisodeRecord(f.deps, day, inChat)).toBeNull();
    expect(f.history.episodes()).toEqual([]);
    // It stays in Recued, and three approved days can become one standing rule for any day.
    expect(tier1WriteStaysInRecued('episode.record', day)).toBe(true);
    expect([isWriteRuleTool('episode.record'), writeRuleScopeOf('episode.record', day)]).toEqual([true, '']);
    expect(await f.record(day, approved)).toEqual({ ok: true, result: { recorded: 5, day: '2026-11-06', records: [
      { title: 'Did the call with Ana', outcome: 'done' }, { title: 'Haircut, Ana cut it', outcome: 'done' }, { title: 'Booked the dentist', outcome: 'done' },
      { title: 'Spanish', outcome: 'skipped' }, { title: 'Went for a walk', outcome: 'done' }] } });
    const saved = new Map(f.history.episodes().map((episode) => [episode.title, episode]));
    expect(saved.size).toBe(5);
    for (const episode of saved.values()) {
      expect(episode).toMatchObject({ basis: 'declared', assembly_rule: 'owner_record.v1', storage_reason: 'owner_record', sensitive: [] });
    }
    // An event's record is the event: its window, its place and the people in it whom Recued knows.
    expect(saved.get('Did the call with Ana')).toMatchObject({ outcome: 'done', when: { from: Date.parse('2026-11-06T15:00:00Z'), to: Date.parse('2026-11-06T15:30:00Z') },
      people: [f.ana.contact_id], subjects: [f.callRef], evidence: [f.callRef] });
    expect(saved.get('Did the call with Ana')!.where?.name).toBe('Café Lumen');
    // A booking's, its slot and the person it is with.
    expect(saved.get('Haircut, Ana cut it')).toMatchObject({ when: { from: Date.parse('2026-11-06T10:00:00Z'), to: Date.parse('2026-11-06T11:00:00Z') },
      people: [f.ana.contact_id], subjects: [haircutRef] });
    // Anything else spans its day, on the owner's clock.
    const friday = { from: Date.parse('2026-11-06T00:00:00Z'), to: Date.parse('2026-11-07T00:00:00Z') };
    expect(saved.get('Booked the dentist')).toMatchObject({ outcome: 'done', when: friday, subjects: [taskRef], evidence: [taskRef], people: [] });
    expect(saved.get('Spanish')).toMatchObject({ outcome: 'skipped', when: friday, subjects: [f.spanishRef] });
    expect(saved.get('Went for a walk')).toMatchObject({ outcome: 'done', when: friday, subjects: [], evidence: [], people: [] });
  });
  it('keeps one record per item per day, and closes today up to now', async () => {
    const f = harness();
    await f.record({ day: '2026-11-07', ...DUBLIN, records: [{ title: 'Spanish', outcome: 'done', item: f.spanishRef }] }, approved);
    await f.record({ day: '2026-11-07', ...DUBLIN, records: [{ title: 'Spanish, unit 5 after all', outcome: 'skipped', item: f.spanishRef }] }, approved);
    let records = f.history.episodes();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ title: 'Spanish, unit 5 after all', outcome: 'skipped', when: { from: Date.parse('2026-11-07T00:00:00Z'), to: NOW } });
    // Another day is another record.
    await f.record({ day: '2026-11-05', ...DUBLIN, records: [{ title: 'Spanish', outcome: 'done', item: f.spanishRef }] }, approved);
    records = f.history.episodes();
    expect(records).toHaveLength(2);
    // Something not planned is one record per thing said.
    await f.record({ day: '2026-11-07', ...DUBLIN, records: [{ title: 'Went for a walk', outcome: 'done' }] }, approved);
    await f.record({ day: '2026-11-07', ...DUBLIN, records: [{ title: 'went for a  walk', outcome: 'done' }] }, approved);
    expect(f.history.episodes()).toHaveLength(3);
  });
  it('reads the day on the turn’s clock, which the approved run carries', async () => {
    const f = harness();
    // The chat fills the turn's zone in before it holds the call, so the approved run has it.
    const day = { day: '2026-11-07', records: [{ title: 'Early run', outcome: 'done' }] };
    expect(withTurnZone('episode.record', day, 'Asia/Tokyo')).toEqual({ ...day, time_zone: 'Asia/Tokyo' });
    // 21:00 in Dublin is 06:00 on Sunday in Tokyo, and 13:00 on Saturday in Los Angeles.
    await f.record({ day: '2026-11-08', time_zone: 'Asia/Tokyo', records: [{ title: 'Early run', outcome: 'done' }] }, approved);
    await f.record({ day: '2026-11-07', time_zone: 'America/Los_Angeles', records: [{ title: 'Lunch out', outcome: 'done' }] }, approved);
    const byTitle = new Map(f.history.episodes().map((episode) => [episode.title, episode]));
    expect(byTitle.get('Early run')!.when).toEqual({ from: Date.parse('2026-11-07T15:00:00Z'), to: NOW });
    expect(byTitle.get('Lunch out')!.when).toEqual({ from: Date.parse('2026-11-07T08:00:00Z'), to: NOW });
    // With none, the server's own clock.
    expect((await checkEpisodeRecord(f.deps, { day: '2026-11-08', records: [{ title: 'x', outcome: 'done' }] }, approved) as Refused).detail)
      .toBe('episode.record: `day` is today or an earlier day, not 2026-11-08');
  });
});

describe('D-343 slice 2 — what a day’s records are refused for, before the owner is asked', () => {
  it('refuses what a record cannot take, and writes nothing', async () => {
    const f = harness();
    const ok = { title: 'Ran 5 km', outcome: 'done' };
    for (const [call, words] of [
      [{ day: '6 Nov', records: [ok] }, '`day` is the day the records are for, as YYYY-MM-DD'],
      [{ day: '2026-11-08', records: [ok] }, '`day` is today or an earlier day, not 2026-11-08'],
      [{ day: '2026-11-06', records: [] }, '`records` lists what they did or skipped that day, 1 to 50 of them'],
      [{ day: '2026-11-06', records: Array.from({ length: 51 }, (_, n) => ({ title: `Thing ${n}`, outcome: 'done' })) }, '1 to 50 of them'],
      [{ day: '2026-11-06', records: ['ran'] }, 'records[0] is {"title": …, "outcome": "done" or "skipped"}'],
      [{ day: '2026-11-06', records: [{ ...ok, when: 'morning' }] }, 'records[0] takes `title`, `outcome` and `item`, not `when`'],
      [{ day: '2026-11-06', records: [{ ...ok, title: ' ' }] }, 'records[0].title is what they did, in their words, at most 500 characters'],
      [{ day: '2026-11-06', records: [{ ...ok, title: 'x'.repeat(501) }] }, 'at most 500 characters'],
      [{ day: '2026-11-06', records: [{ ...ok, outcome: 'partly' }] }, 'records[0].outcome is `done` or `skipped`'],
      [{ day: '2026-11-06', records: [{ ...ok, item: 'task-1' }] }, "records[0].item is an agenda item's `ref` from situation.query"],
      [{ day: '2026-11-06', records: [{ ...ok, item: { collection: 'task', id: 'task-none' } }] }, 'records[0].item names no task item `task-none`'],
      [{ day: '2026-11-06', records: [{ ...ok, item: { collection: 'invoice', id: 'inv-1' } }] }, 'records[0].item names no invoice item `inv-1`'],
      [{ day: '2026-11-06', records: [{ ...ok, item: f.spanishRef }, { title: 'Spanish again', outcome: 'skipped', item: f.spanishRef }] },
        'records[1] repeats an earlier record: send each thing once'],
      [{ day: '2026-11-06', records: [ok, { title: 'ran 5 KM', outcome: 'done' }] }, 'records[1] repeats an earlier record'],
      [{ day: '2026-11-06', records: [ok], when: 'evening' }, 'it takes `day` and `records`, not `when`'],
    ] as const) {
      const refused = await checkEpisodeRecord(f.deps, call, inChat) as Refused;
      expect(refused, JSON.stringify(call).slice(0, 120)).toMatchObject({ ok: false, reason: 'invalid_args' });
      expect(refused.detail, JSON.stringify(call).slice(0, 120)).toContain(words);
    }
    expect(f.history.episodes()).toEqual([]);
  });
  it('keeps to the contract: off for an AI app until granted, and an item only of a kind it may read', async () => {
    const calendarRead = situationSourceAccess('calendar')!.verb_op;
    const f = harness((source, op) => source.channel !== 'mcp' || (op === EPISODE_RECORD_OP_ID && grantRecord) || (op === calendarRead && grantCalendar));
    let grantRecord = false; let grantCalendar = false;
    const day = { day: '2026-11-06', records: [{ title: 'Did the call with Ana', outcome: 'done', item: f.callRef }] };
    expect(await f.record(day, overMcp)).toEqual({ ok: false, reason: 'classification_blocked', detail: "'episode.record' is not available for this contract." });
    grantRecord = true;
    expect(await f.record(day, overMcp)).toEqual({ ok: false, reason: 'classification_blocked',
      detail: 'episode.record: records[0].item: Reading calendar items is not available for this contract.' });
    expect(await checkEpisodeRecord(f.deps, { day: '2026-11-06', records: [{ title: 'Went for a walk', outcome: 'done' }] }, overMcp)).toBeNull();
    grantCalendar = true;
    expect(await f.record(day, overMcp)).toMatchObject({ ok: true, result: { recorded: 1 } });
    expect(f.history.episodes()).toHaveLength(1);
  });
});
