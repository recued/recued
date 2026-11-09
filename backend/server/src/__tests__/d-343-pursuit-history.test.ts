/** D-343 slice 5 — what the owner records in Close the day, where they read it back: Episodes by the
 *  day each happened, and a pursuit's history and when it was last worked on (D-342 §7). Through
 *  the real Yours service, work store and closing-record writer (`episode.record`'s). */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { PURSUIT_CLASS_ID, type ExecutionSource } from '@recued/contracts';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createAssetOccurrenceService } from '../situations/asset-occurrence-service.js';
import { createYoursService } from '../situations/yours-service.js';
import { createSituationStore } from '../storage/situation-store.js';
import { createClosingRecords } from '../situations/closing-records.js';
import { createProactiveHistoryStore } from '../storage/proactive-history-store.js';
import { createProactiveProposalStore } from '../storage/proactive-proposal-store.js';

const owner: ExecutionSource = { channel: 'user', actor: 'user_self', user_id: 'owner', client_token_id: 'paired' };
const disposals: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposals.splice(0)) await dispose(); });

const fixture = () => {
  const db = new Database(':memory:'); ensureWorkEntitySchema(db); const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  // Friday 6 November, evening.
  let time = Date.parse('2026-11-06T20:00Z');
  const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work), now: () => time });
  const occurrences = createAssetOccurrenceService({ db, work, dispatchers, timeZone: () => 'UTC', now: () => time });
  const service = createYoursService({ db, work, dispatchers, occurrences, situations: createSituationStore(db), now: () => time, timeZone: () => 'UTC' });
  disposals.push(async () => { await service.stop(); db.close(); });
  const history = createProactiveHistoryStore(db, createProactiveProposalStore(db));
  const closing = createClosingRecords({ db, history, work, calendars: () => [], timeZone: () => 'UTC', now: () => time });
  const command = (input: Parameters<typeof service.command>[0]) => service.command(input, owner);
  const pursuit = async (name: string) => (await command({ action: 'asset.create', class_id: PURSUIT_CLASS_ID, input: { name } })).id!;
  /** One day's records, as the owner approved them in the chat. */
  const close = (day: string, records: Array<{ title: string; outcome: 'done' | 'skipped'; pursuit?: string }>) => closing.record({ day,
    records: records.map(({ pursuit: id, ...record }) => ({ ...record, ...(id ? { item: closing.item({ collection: 'asset', id })! } : {}) })) });
  return { service, history, command, pursuit, close, at: (iso: string) => { time = Date.parse(iso); } };
};

describe('D-343 slice 5 — Episodes reads in the order things happened', () => {
  it('puts a day closed days later on its own day, not where it was written', async () => {
    const f = fixture();
    f.at('2026-11-04T21:00Z'); f.close('2026-11-04', [{ title: 'Went for a walk', outcome: 'done' }]);
    // Monday is closed on Thursday: written after Wednesday's, it happened before it.
    f.at('2026-11-05T21:00Z'); f.close('2026-11-02', [{ title: 'Ran 5 km', outcome: 'done' }, { title: 'Spanish lesson', outcome: 'skipped' }]);
    f.at('2026-11-06T20:00Z');
    const titles = (await f.service.snapshot({})).episodes.map(row => row.title);
    expect(titles.slice(0, 1)).toEqual(['Went for a walk']);
    expect(titles.slice(1).sort()).toEqual(['Ran 5 km', 'Spanish lesson']);
  });
});

describe('D-343 slice 5 (D-342 §7) — a pursuit’s history', () => {
  const seeded = async () => {
    const f = fixture();
    const spanish = await f.pursuit('Learn Spanish'); const guitar = await f.pursuit('Learn guitar');
    const passport = (await f.command({ action: 'asset.create', class_id: 'passport', input: { name: 'Passport', holder_contact: 'ana@example.test' } })).id!;
    f.at('2026-10-01T21:00Z'); f.close('2026-10-01', [{ title: 'Unit 3', outcome: 'done', pursuit: spanish }]);
    f.at('2026-11-04T21:00Z'); f.close('2026-11-04', [{ title: '20 minutes of Spanish', outcome: 'done', pursuit: spanish }]);
    f.at('2026-11-05T21:00Z'); f.close('2026-11-05', [{ title: 'No Spanish today', outcome: 'skipped', pursuit: spanish }]);
    f.at('2026-11-06T20:00Z');
    const today = f.close('2026-11-06', [{ title: 'Read a chapter in Spanish', outcome: 'done', pursuit: spanish },
      { title: 'No guitar', outcome: 'skipped', pursuit: guitar }, { title: 'Went for a walk', outcome: 'done' }]);
    return { ...f, spanish, guitar, passport, today };
  };

  it('lists on its page the records that cite it, the latest first, with when it was last worked on and how often', async () => {
    const f = await seeded();
    const page = await f.service.snapshot({ asset_id: f.spanish });
    expect(page.episodes.map(row => [row.title, row.outcome])).toEqual([
      ['Read a chapter in Spanish', 'done'], ['No Spanish today', 'skipped'], ['20 minutes of Spanish', 'done'], ['Unit 3', 'done']]);
    // A skipped day is no activity, and 1 October is more than 30 days back.
    expect(page.pursuit_activity).toEqual({ [f.spanish]: { last_on: '2026-11-06', days_30: 2 } });
  });

  it('says on the Pursuits tab when each was last worked on, and nothing for one only ever skipped', async () => {
    const f = await seeded();
    expect((await f.service.snapshot({ pursuits: 'only' })).pursuit_activity).toEqual({ [f.spanish]: { last_on: '2026-11-06', days_30: 2 } });
  });

  it('leaves out a record the owner hid, and gives a thing that is no pursuit no activity', async () => {
    const f = await seeded();
    const hidden = f.today.find(row => row.title === 'Read a chapter in Spanish')!;
    await f.command({ action: 'episode.hide', id: hidden.id });
    const page = await f.service.snapshot({ asset_id: f.spanish });
    expect(page.episodes.map(row => row.title)).not.toContain('Read a chapter in Spanish');
    expect(page.pursuit_activity).toEqual({ [f.spanish]: { last_on: '2026-11-04', days_30: 1 } });
    const passport = await f.service.snapshot({ asset_id: f.passport });
    expect(passport).not.toHaveProperty('pursuit_activity');
    expect(passport.episodes).toEqual([]);
  });
});
