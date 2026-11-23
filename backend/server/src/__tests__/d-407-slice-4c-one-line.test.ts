/** D-407 slice 4c (D-407 §4.2, §8, §10.2) — an occasion and its own calendar event are one situation, so
 *  Today shows them as one line (the app's Today attaches a situation holding an event to that event's own line), and
 *  the event is private as its occasion is, whatever its calendar did to its marking.
 *
 *  Through the real stores: the occasion store, the bond (`createOccasionCalendarSync`) writing the event into a real
 *  calendar table, the situation sources, query and scheduled situations. */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssetRule, OccasionCalendarChoice, OccasionInput, SituationItem } from '@recued/contracts';

import { createCalendarTable } from '../collections/calendar/calendar-table.js';
import type { NotificationSendArgs } from '../notification-handler.js';
import { createOccasionCalendarSync } from '../situations/occasion-calendar-sync.js';
import { createOccasionEventAdoption } from '../situations/occasion-event-adoption.js';
import { createSituationQuery } from '../situations/query.js';
import { createScheduledSituations } from '../situations/scheduled-situations.js';
import { buildSituationSources } from '../situations/sources.js';
import { createProactiveHistoryStore } from '../storage/proactive-history-store.js';
import { createProactiveProposalStore } from '../storage/proactive-proposal-store.js';
import { createReminderStore } from '../storage/reminder-store.js';
import { createSituationStore } from '../storage/situation-store.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const DAY = 86_400_000;
// Tuesday 20 October 2026, 18:00 UTC: the evening before Dr. Lee, Wednesday at 10:30.
const tuesday = Date.parse('2026-10-20T18:00:00Z');
const wednesday = Date.parse('2026-10-21T10:30:00Z');
const onTheDay: AssetRule = { id: 'date', title: 'Dr. Lee', enabled: true, muted: false, pinned: false, consequence: 'routine',
  expiry_policy: 'strict_expire', when: { kind: 'expiry', field: 'next_on' }, reaction: { notify: true, occurrence: 'notice', emit: false },
  schedule: { before: [], on_day: true } };
const lee = (patch: Partial<OccasionInput> = {}): OccasionInput => ({ title: 'Dr. Lee', month_day: '10-21', source_next_on: '2026-10-21',
  time: '10:30', time_zone: 'UTC', people: [], muted: false, rules: [onTheDay], private: true, in_calendar: true, ...patch });
const personal: OccasionCalendarChoice = { slug: 'personal', calendar_id: 'primary', name: 'Personal' };

/** The owner's day: one calendar, and the bond writing each occasion's own event into it as the calendar would. */
const day = () => {
  const db = new Database(':memory:'); ensureWorkEntitySchema(db); const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const history = createProactiveHistoryStore(db, createProactiveProposalStore(db));
  const table = createCalendarTable({ db, slug: 'personal' });
  const calendars = () => [{ slug: 'personal', table }];
  let made = 0;
  const bond = createOccasionCalendarSync({ db, timeZone: () => 'UTC', now: () => tuesday, choice: () => personal, dropsPrivate: () => {},
    save: input => history.saveOccasion(input, tuesday),
    writer: {
      async create(_choice, _creation, fields) {
        made += 1; const source_id = `own-${String(made)}`;
        table.upsert({ size_bytes: 0, event: { source_id, ical_uid: `uid-${source_id}`, calendar_id: 'primary', summary: fields.summary,
          start_at: fields.start_at, end_at: fields.end_at, timezone: fields.timezone, is_all_day: fields.is_all_day, status: 'confirmed',
          created_at: 0, updated_at: 0, ...(fields.marked_private ? { marked_private: true as const } : {}) } });
        return { source_id, marked_private: fields.marked_private };
      },
      async update() { return { marked_private: true }; },
      async remove() {},
      stored: () => undefined,
      gone: async () => false,
    } });
  const sources = buildSituationSources({ db, work, reminders: createReminderStore(db), calendars, timeZone: () => 'UTC', now: () => tuesday });
  const query = createSituationQuery({ now: () => tuesday, sources, sourceForCollection: collection => ({ verb_op: 'core.work-entity.read', collection }) });
  const service = createScheduledSituations({ db, work, store: createSituationStore(db), query, timeZone: () => 'UTC', isVaultUnlocked: () => true,
    isQuiet: () => false, overview: async () => ({ proposal_count: 0, newest_proposal: null, unmatched_replies: [], phone_ready: true }),
    send: vi.fn(async (_message: NotificationSendArgs) => ({ delivered_to: ['in_app'] })), now: () => tuesday, calendars });
  cleanups.push(async () => { await service.stop(); db.close(); });
  const owner = { owner: true, grants: { isVerbOpGranted: () => true, isCollectionReadGranted: () => true, isTopicReadGranted: () => true } };
  return { db, work, table, history, service,
    /** Saves the occasion and lets the bond write its event, as each clock tick does. */
    add: async (input: OccasionInput) => { const saved = history.saveOccasion(input, tuesday); await bond.sync(history.occasions(100), '2026-10-20'); return saved; },
    /** Wednesday as Today reads it. */
    today: async () => (await query({ time: { from: wednesday - 10.5 * 3_600_000, to: wednesday + 13.5 * 3_600_000 }, surface: 'today' }, owner)).clusters };
};
const kinds = (items: readonly SituationItem[]) => items.map(item => item.kind).sort();

describe('D-407 slice 4c — an occasion and its own event are one line in Today', () => {
  it('one situation holds both; an event of no occasion stands alone', async () => {
    const f = day();
    await f.add(lee({ private: false }));
    f.table.upsert({ size_bytes: 0, event: { source_id: 'sync', ical_uid: 'uid-sync', calendar_id: 'primary', summary: 'Team sync',
      start_at: wednesday, end_at: wednesday + 3_600_000, timezone: 'UTC', is_all_day: false, status: 'confirmed', created_at: 0, updated_at: 0 } });
    const clusters = await f.today();
    const lines = clusters.map(cluster => kinds(cluster.items));
    expect(lines).toContainEqual(['calendar', 'occasion']);
    expect(lines).toContainEqual(['calendar']);
    expect(clusters).toHaveLength(2);
    // The app's Today puts a situation that holds an event on that event's own line: the event's ref is the one it finds.
    const doctor = clusters.find(cluster => cluster.items.length === 2)!;
    expect(doctor.items.find(item => item.kind === 'calendar')!.ref).toEqual({ collection: 'calendar', id: 'personal:' + f.table.get('own-1')!.record_id });
  });

  it('private as its occasion is: unmarked in its calendar, it stays private while the occasion is; shown by name, it is named', async () => {
    const f = day();
    const doctor = await f.add(lee());
    const shown = await f.add(lee({ title: 'Reunion', private: false, month_day: '10-21', time: '15:00' }));
    // The phone took the marking away: the event says nothing of privacy now.
    const own = f.table.get('own-1')!.event; expect(own.summary).toBe('Dr. Lee');
    f.table.upsert({ size_bytes: 0, event: { ...own, marked_private: undefined } });
    const items = (await f.today()).flatMap(cluster => cluster.items);
    const event = (title: string) => items.find(item => item.kind === 'calendar' && item.what.value === title)!;
    expect(f.service.isPrivateItem(event('Dr. Lee'))).toBe(true);
    expect(f.service.isPrivateItem(event('Reunion'))).toBe(false);
    expect(doctor.private).toBe(true); expect(shown.private).toBe(false);
  });
});

// D-407 slice 5 (§4.2, §10.1, U2) — a clinic's invite the owner ticked Occasion on, and the booking the same invite made:
// one appointment in Today, private as its occasion is. The booking was a line of its own, and never private.
describe('D-407 slice 5 — an adopted invite and the booking it made are one appointment', () => {
  it('one line in Today with its occasion, private as the occasion is; shown by name, named', async () => {
    for (const chosen of [true, false]) {
      const f = day();
      f.table.upsert({ size_bytes: 0, event: { source_id: 'invite-1', ical_uid: 'uid-clinic-1', calendar_id: 'primary', summary: 'Dr. Lee follow-up',
        start_at: wednesday, end_at: wednesday + 1_800_000, timezone: 'UTC', is_all_day: false, status: 'confirmed', created_at: 0, updated_at: 0,
        organizer: { email: 'clinic@hospital.example' } } });
      f.work.writeBooking({ source_id: 'recued.booking', title: 'Dr. Lee follow-up — State Hospital', lifecycle_state: 'confirmed',
        slot_start_at: wednesday, slot_end_at: wednesday + 1_800_000,
        source_extension_blob: { kind: 'calendar_invite', uid: 'uid-clinic-1', match_key: 'uid-clinic-1' } }, tuesday);
      const adoption = createOccasionEventAdoption({ db: f.db, history: f.history, timeZone: () => 'UTC', now: () => tuesday,
        event: (slug, source_id) => { const row = slug === 'personal' ? f.table.get(source_id) : undefined;
          return row ? { event: row.event, calendar_name: 'Personal' } : undefined; } });
      adoption.adopt({ slug: 'personal', source_id: 'invite-1', private: chosen });
      const clusters = await f.today();
      const appointment = clusters.find(cluster => cluster.items.some(item => item.kind === 'booking'))!;
      expect(kinds(appointment.items)).toEqual(['booking', 'calendar', 'occasion']);
      expect(clusters).toHaveLength(1);
      for (const item of appointment.items) expect(f.service.isPrivateItem(item), `${item.kind}, ${String(chosen)}`).toBe(chosen);
    }
  });
});
