/** D-343 (the owner, 2026-11-15) — a day can be closed in two conversations: its notice went to
 *  Telegram and to the app's "Your day", or the owner replied to its email too. Each close was told the
 *  day "is not recorded yet" and asked about every item again. Now what is already recorded for the
 *  day, from whichever conversation recorded it, is read where a close begins: the closing note marks
 *  it and says not to ask about it, `situation.query` with `close` lists it, and the record's approval
 *  names it. A record of the same item on the same day already replaced its earlier one.
 *
 *  Driven on the real stores: what a day holds is the history store's decision. */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tier1CallDetails, type ExecutionSource, type SituationRef } from '@recued/contracts';
import { buildChatTier1Handlers, buildChatToolRegistryInputs, type ChatToolHandlerDeps } from '../chat-tool-handlers.js';
import { closingDayNote, closingFollowUpNote, closingToolSteps, withRecorded, type ClosingItem } from '../chat-closing-day.js';
import { createClosingRecords } from '../situations/closing-records.js';
import { createCalendarTable } from '../collections/calendar/calendar-table.js';
import { createContactStore } from '../storage/contact-store.js';
import { createProactiveHistoryStore } from '../storage/proactive-history-store.js';
import { createProactiveProposalStore } from '../storage/proactive-proposal-store.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';

const owner: ExecutionSource = { channel: 'chat', actor: 'user_self', chat_session_id: 'chat-1', user_id: 'user-1' };
const fromTelegram = { channel: 'internal_function_call', session_id: 'messenger:telegram:1', execution_source: owner, owner_approved: true } as never;
const NOW = Date.parse('2026-11-07T21:00:00Z');
const DUBLIN = { time_zone: 'Europe/Dublin' };

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); });
afterEach(() => db.close());

const harness = () => {
  ensureWorkEntitySchema(db); const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work), now: () => NOW });
  const history = createProactiveHistoryStore(db, createProactiveProposalStore(db));
  const closing = createClosingRecords({ db, history, work, calendars: () => [{ slug: 'local', table: createCalendarTable({ db, slug: 'local' }) }],
    contacts: createContactStore(db), timeZone: () => 'Europe/Dublin', now: () => NOW });
  const deps = {
    getClosingRecords: () => closing,
    getWorkEntityCrudDeps: () => ({ store: work, dispatchers }),
    getOpAdmissionGate: () => ({ isFrozenByPause: () => false, isOwnerGoverned: () => true, isOpGranted: () => true }),
    now: () => NOW,
  } as unknown as ChatToolHandlerDeps;
  const spanish = work.writeAsset({ source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner:user-1' }, name: 'Spanish' }, NOW - 86_400_000);
  const spanishRef: SituationRef = { collection: 'asset', id: spanish.id };
  return { closing, history, deps, spanishRef, work, record: buildChatTier1Handlers(deps)['episode.record']! };
};

describe('D-343 — what a day already holds, from any conversation', () => {
  it('reads the day\'s records, whichever conversation kept them, and a later one of the same item replaces it', async () => {
    const f = harness();
    await f.record({ day: '2026-11-07', ...DUBLIN, records: [{ title: 'Spanish, unit 5', outcome: 'done', item: f.spanishRef },
      { title: 'Went for a walk', outcome: 'done' }] }, fromTelegram);
    // Both span the day, so their order is the store's (by record id).
    const kept = f.closing.recorded('2026-11-07', 'Europe/Dublin');
    expect(kept).toHaveLength(2);
    expect(kept).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Spanish, unit 5', outcome: 'done', ref: f.spanishRef }),
      expect.objectContaining({ title: 'Went for a walk', outcome: 'done' }),
    ]));
    expect(f.closing.recorded('2026-11-06', 'Europe/Dublin')).toEqual([]);
    // The app closes the same day: the item's record is replaced, not doubled.
    await f.record({ day: '2026-11-07', ...DUBLIN, records: [{ title: 'Spanish, skipped after all', outcome: 'skipped', item: f.spanishRef }] }, fromTelegram);
    const day = f.closing.recorded('2026-11-07', 'Europe/Dublin');
    expect(day).toHaveLength(2);
    expect(day.find(record => record.ref?.id === f.spanishRef.id)).toMatchObject({ title: 'Spanish, skipped after all', outcome: 'skipped' });
  });

  it('marks it in the closing note, lists what cites no item, and says not to ask about it', () => {
    const items: ClosingItem[] = [{ title: 'Spanish', ref: { collection: 'asset', id: 'a1' } }, { title: 'Call the plumber', ref: { collection: 'task', id: 't1' } }];
    const day = withRecorded(items, [{ title: 'Spanish, unit 5', outcome: 'done', ref: { collection: 'asset', id: 'a1' } },
      { title: 'Went for a walk', outcome: 'done' }]);
    const quote = { title: 'Close the day · Sat 7 Nov', from: '2026-11-07', to: '2026-11-07' };
    const note = closingDayNote(quote, day);
    expect(note).toContain('- Spanish {"collection":"asset","id":"a1"} (already recorded: done)');
    expect(note).toContain('- Call the plumber {"collection":"task","id":"t1"}\n');
    expect(note).toContain('Already recorded with no item: Went for a walk (done)');
    expect(note).toContain('do not ask about it');
    expect(closingFollowUpNote(quote, day)).toContain('(already recorded: done)');
    // A day nothing is recorded for reads as it did.
    const fresh = closingDayNote(quote, withRecorded(items, []));
    expect(fresh).not.toContain('already recorded');
    expect(fresh).not.toContain('do not ask about it');
    expect(closingToolSteps('2026-11-07', true)).toContain('listed as already_recorded');
    expect(closingToolSteps('2026-11-07')).not.toContain('already_recorded');
  });

  it('names it on the record\'s approval, and nothing on a day with none', async () => {
    const f = harness();
    const labels = buildChatToolRegistryInputs(f.deps).tier1AskLabels['episode.record']!;
    const call = { day: '2026-11-07', ...DUBLIN, records: [{ title: 'Read 20 pages', outcome: 'done' }] };
    expect(await labels(call)).toBeUndefined();
    await f.record({ day: '2026-11-07', ...DUBLIN, records: [{ title: 'Spanish, unit 5', outcome: 'done', item: f.spanishRef },
      { title: 'Did not call the plumber', outcome: 'skipped' }] }, fromTelegram);
    // Both span the whole day, so which comes first is the store's; the approval lists both.
    const named = await labels(call) as { recorded_before: Record<string, string> };
    expect(Object.values(named.recorded_before).sort()).toEqual(['Did not call the plumber (skipped)', 'Spanish, unit 5']);
    const shown = tier1CallDetails('episode.record', call, named).args as Record<string, string[]>;
    expect(shown.Done).toEqual(['Read 20 pages']);
    expect([...shown['Already recorded']!].sort()).toEqual(['Did not call the plumber (skipped)', 'Spanish, unit 5']);
    // A record of an item the call records again is replaced by it, so it is not listed beside it.
    const again = { ...call, records: [{ title: 'Spanish, unit 6', outcome: 'done', item: f.spanishRef }] };
    expect(Object.values((await labels(again) as { recorded_before: Record<string, string> }).recorded_before)).toEqual(['Did not call the plumber (skipped)']);
  });
});

describe('D-343 (the owner\'s day audit, 2026-11-15) — a skipped task is still open', () => {
  it('says so where the reply after the owner\'s yes is written, so the chat offers to move it', async () => {
    const f = harness();
    const plumber = f.work.writeTask({ source_id: 'recued.task', title: 'Call the plumber', due_at: Date.parse('2026-11-07T00:00:00Z') } as never, NOW - 3_600_000);
    const lesson = f.work.writeTask({ source_id: 'recued.task', title: 'Spanish lesson', due_at: Date.parse('2026-11-07T00:00:00Z') } as never, NOW - 3_600_000);
    const done = await f.record({ day: '2026-11-07', ...DUBLIN, records: [
      { title: 'Spanish lesson', outcome: 'done', item: { collection: 'task', id: lesson.id } },
      { title: 'Call the plumber', outcome: 'skipped', item: { collection: 'task', id: plumber.id } }] }, fromTelegram) as { ok: true; result: Record<string, unknown> };
    expect(done.result.still_open).toEqual([{ title: 'Call the plumber', id: plumber.id }]);
    expect(done.result.next).toContain('Ask the user whether to move each to another day');
    // Nothing skipped, nothing said.
    const none = await f.record({ day: '2026-11-07', ...DUBLIN, records: [{ title: 'Went for a walk', outcome: 'done' }] }, fromTelegram) as { ok: true; result: Record<string, unknown> };
    expect(none.result).not.toHaveProperty('still_open');
  });
});
