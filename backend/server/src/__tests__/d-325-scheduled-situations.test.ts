import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { quietHoursEndFor, shouldSuppressForQuietHours, type AssetRule, type IngredientManifest, type QuietHoursPolicy, type SituationFact } from '@recued/contracts';
import { createSituationQuery, SituationScanBoundError } from '../situations/query.js';
import { createSituationAccess } from '../situations/access.js';
import { createScheduledSituations, mailboxHealthOf } from '../situations/scheduled-situations.js';
import { STOP_GRACE_MS } from '../lifecycle/settle-within.js';
import { createClusterSummary } from '../situations/cluster-summary.js';
import { createSituationDismissalStore, situationItemKey, situationKindKey } from '../storage/situation-dismissal-store.js';
import { createSituationStore } from '../storage/situation-store.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { createContractStore } from '../storage/contract-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import type { ExecuteChatAiCall } from '../chat-orchestrator.js';
import { buildSituationSources } from '../situations/sources.js';
import { createReminderStore } from '../storage/reminder-store.js';
import { createAssetOccurrenceService } from '../situations/asset-occurrence-service.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createProactiveHistoryStore } from '../storage/proactive-history-store.js';
import { createProactiveProposalStore } from '../storage/proactive-proposal-store.js';
import { createAssetOccurrenceStore } from '../storage/asset-occurrence-store.js';
import { createOccurrenceReminderStore } from '../storage/occurrence-reminder-store.js';

const monday = Date.parse('2026-10-19T08:30:00Z');
const fact = (id = 'trip', patch: Partial<SituationFact> = {}): SituationFact => ({ ref: { collection: 'booking', id }, title: 'Lisbon trip', kind: 'booking',
  basis: 'declared', when: { from: monday + 86_400_000, to: monday + 2 * 86_400_000 }, act_by: monday + 86_400_000,
  people: [], subjects: [], related: [], evidence: [{ collection: 'booking', id }], updated_at: monday, consequence: 'routine', ...patch });
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const fixture = (initial = [fact()], zone = 'UTC', nativeSources = false, personName?: (id: string) => string | undefined) => {
  const db = new Database(':memory:'); ensureWorkEntitySchema(db); const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const contracts = createContractStore(db); const store = createSituationStore(db);
  let at = monday; let open = true; let quiet = false; let facts = initial; let fail = false; let summarize: ((cluster: never) => Promise<string | undefined>) | undefined;
  let prepared = new Set<string>();
  // A real window, wired as the composition root wires it; `quiet` stays a plain switch.
  let window: QuietHoursPolicy | null = null;
  const overBound = new Set<string>();
  const send = vi.fn(async (_message: import('../notification-handler.js').NotificationSendArgs) => ({ delivered_to: fail ? [] : ['in_app', 'telegram'] }));
  const sources = nativeSources ? buildSituationSources({ db, work, reminders: createReminderStore(db), calendars: () => [],
    timeZone: () => zone, now: () => at }) : ['booking', 'asset', 'occasion', 'commitment', 'episode', 'calendar', 'task'].map(collection => ({
    id: collection, collection, verb_op: 'core.work-entity.read', read: vi.fn(() => {
      if (overBound.has(collection)) throw new SituationScanBoundError('Situation source exceeds its scan bound');
      return facts.filter(row => row.ref.collection === collection);
    }),
  }));
  const query = createSituationQuery({ now: () => at, sources, sourceForCollection: collection => ({ verb_op: 'core.work-entity.read', collection }) });
  const access = createSituationAccess({ contracts, query, now: () => at, isVaultUnlocked: () => open });
  const boot = () => {
    const service = createScheduledSituations({ db, work, store, query, timeZone: () => zone, isVaultUnlocked: () => open, now: () => at,
      isQuiet: instant => quiet || (window !== null && shouldSuppressForQuietHours({ policy: window, instant, timeZone: zone })),
      quietEnd: minute => window && quietHoursEndFor(window, minute),
      overview: async () => ({ proposal_count: 3, newest_proposal: { id: 'p1', title: 'Boiler' }, unmatched_replies: [], phone_ready: true }), send,
      mailHealth: () => [{ name: 'Personal mail', last_success_at: monday - 8 * 86_400_000, needs_attention: true }],
      summarize: cluster => summarize?.(cluster as never) ?? Promise.resolve(undefined), ...(personName ? { personName } : {}),
      prepNotesReady: id => prepared.has(id) });
    service.bindAccess(access); return service;
  };
  let service = boot();
  cleanups.push(async () => { await service.stop(); db.close(); });
  return { db, work, store, contracts, send, access, query, service: () => service,
    restart: async () => { await service.stop(); service = boot(); },
    time: (value: number) => { at = value; }, quiet: (value: boolean) => { quiet = value; }, open: (value: boolean) => { open = value; },
    quietHours: (value: QuietHoursPolicy) => { window = value; },
    facts: (value: SituationFact[]) => { facts = value; }, fail: (value: boolean) => { fail = value; },
    overBound: (collection: string) => { overBound.add(collection); },
    summary: (value: typeof summarize) => { summarize = value; }, prepared: (ids: string[]) => { prepared = new Set(ids); } };
};

describe('D-325 scheduled overview through the shared query', () => {
  // An item names people by id (§6.2); Today shows names.
  it('names the people Today’s items carry and leaves out one no longer on file', async () => {
    const names = new Map([['contact-ana', 'Ana Lima'], ['bob@example.test', 'bob@example.test']]);
    const f = fixture([fact('trip', { people: ['contact-ana', 'bob@example.test', 'contact-gone'] })], 'UTC', false, id => names.get(id));
    const today = await f.service().today({ now: monday, before: monday + 7 * 86_400_000 });
    expect(today.situations.clusters[0]?.items[0]?.who.value).toEqual(['contact-ana', 'bob@example.test', 'contact-gone']);
    expect(today.people).toEqual({ 'contact-ana': 'Ana Lima', 'bob@example.test': 'bob@example.test' });
    // Without names to give, it sends none, so the page cannot take every id for a removed contact.
    expect(await fixture([fact()]).service().today({ now: monday, before: monday + 7 * 86_400_000 })).not.toHaveProperty('people');
  });
  it('shows the last mail sync in the owner’s own time', async () => {
    const f = fixture([fact()], 'Asia/Tokyo'); await f.service().tick();
    expect(f.send.mock.calls[0]?.[0].text).toContain('Personal mail: last successful mail sync 2026-10-11 17:30 · needs attention');
  });
  it('reopens the same situation when a resolved subject has a new visible span', async () => {
    const f = fixture(); await f.service().tick(); const entry = f.store.list()[0]!;
    f.store.save({ ...entry.snapshot, state: 'resolved' }, { source: 'previous-trip-ended' }, monday + 1);
    f.facts([fact('trip', { title: 'Changed trip', when: { from: monday + 3 * 86_400_000, to: monday + 4 * 86_400_000 }, updated_at: monday + 2 })]);
    await f.service().sendNow(); expect(f.store.get(entry.snapshot.id)?.snapshot.state).toBe('new');
    expect(f.store.get(entry.snapshot.id)?.snapshot.cluster.items[0]?.what.value).toBe('Changed trip');
  });
  it('finds a resolution beyond the first revision page and acknowledges only what it handled', async () => {
    const f = fixture(); const original = await f.query({ time: { from: monday, to: monday + 7 * 86_400_000 } }, { owner: true,
      grants: { isVerbOpGranted: () => true, isCollectionReadGranted: () => true, isTopicReadGranted: () => true } });
    const cluster = original.clusters[0]!;
    for (let index = 0; index < 1005; index++) {
      const id = `history-${String(index).padStart(4, '0')}`;
      f.store.save({ id, state: 'new', cluster: { ...cluster, id }, urgency: 'routine' }, { source: 'history' }, monday - 1);
    }
    const id = 'situation-last-resolution';
    f.store.save({ id, state: 'resolved', cluster: { ...cluster, id, span: null }, urgency: 'routine' }, { source: 'trip-ended' }, monday);
    f.facts([]); await f.service().tick();
    expect(f.send.mock.calls[0]?.[0].text).toContain('Resolved · Lisbon trip');
    expect(f.store.readSetting('situations.last_sent_revision', 0)).toBe(1006);
  });
  it('sends changed values and stale mail sync, opens Today, persists the sent receipt and skips unchanged restart', async () => {
    const f = fixture(); await f.service().tick();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0]?.[0]).toMatchObject({ ui_link_url: '#today', text: expect.stringContaining('Lisbon trip') });
    expect(f.send.mock.calls[0]?.[0].text).toContain('last successful mail sync 2026-10-11 08:30');
    expect(f.send.mock.calls[0]?.[0].text).toContain('needs attention');
    expect(f.service().status().last_run?.state).toBe('skipped'); // day-of had no new change
    await f.restart(); await f.service().tick(); expect(f.send).toHaveBeenCalledTimes(1);
  });
  it('neither shows a group again nor saves a revision when only an asset’s fields or a trip’s details changed', async () => {
    const car = (colour: string, title = 'Renew · Car insurance') => fact('car', { ref: { collection: 'asset', id: 'car', field: 'rules.renew' }, kind: 'asset_rule', title,
      evidence: [{ collection: 'asset', id: 'car' }], details: { status: 'active', attributes: { colour } },
      context: { root: { kind: 'rule', asset_id: 'car', rule_id: 'renew' } } });
    const trip = (country: string) => fact('trip', { trip: { subject: { collection: 'booking', id: 'trip' }, travellers: [], destination_country: country } });
    const f = fixture([car('Red'), trip('PT')]); await f.service().tick(); expect(f.send).toHaveBeenCalledTimes(1);
    const revisions = () => f.store.revisionsAfter(0, 1000).length; const saved = revisions();
    expect(saved).toBeGreaterThan(0); expect(JSON.stringify(f.store.list())).not.toMatch(/colour|destination_country|"context"/);
    f.facts([car('Blue'), trip('ES')]); await f.service().sendNow();
    expect(f.send).toHaveBeenCalledTimes(1); expect(revisions()).toBe(saved);
    // A change to the item itself is shown and saved: the two above are the context's doing.
    f.facts([car('Blue', 'Renew · Car insurance policy'), trip('ES')]); await f.service().sendNow();
    expect(f.send).toHaveBeenCalledTimes(2); expect(revisions()).toBe(saved + 1);
    // Today reads the values live, context and all.
    const today = (await f.service().today({ now: monday, before: monday + 7 * 86_400_000 })).situations.clusters.flatMap(cluster => cluster.items);
    expect(today.find(item => item.ref.id === 'car')?.details?.attributes).toEqual({ colour: 'Blue' });
    expect(today.find(item => item.ref.id === 'car')?.context).toEqual({ root: { kind: 'rule', asset_id: 'car', rule_id: 'renew' } });
    expect(today.find(item => item.ref.id === 'trip')?.trip).toEqual({ destination_country: 'ES' });
  });
  it('still sends when one source is over its bound, and says which was not fully checked', async () => {
    const f = fixture(); f.overBound('episode'); await f.service().tick();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0]?.[0].text).toContain('Lisbon trip');
    expect(f.send.mock.calls[0]?.[0].text).toContain('Not fully checked: episodes. There were more than one read can hold, so some may be missing.');
  });
  it('holds sealed and quiet work without spending its point, then sends on release', async () => {
    const f = fixture(); f.open(false); await f.service().tick(); f.open(true); f.quiet(true); await f.service().tick(); expect(f.send).not.toHaveBeenCalled();
    f.quiet(false); await f.service().tick(); expect(f.send).toHaveBeenCalledTimes(1);
  });
  const nightly = { enabled: true, from_minute: 22 * 60, to_minute: 7 * 60, applies_to: ['notification' as const], updated_at: 1 };
  it('sends a time set inside quiet hours when they end, where it never came round before', async () => {
    // 23:00 inside 22:00 → 07:00: quiet every evening, and too early every morning by its own time.
    const f = fixture(); f.quietHours(nightly); f.service().setSettings({ frequency: 'daily', time: '23:00', day_of: false });
    for (const time of ['2026-10-19T23:30:00Z', '2026-10-20T06:59:00Z']) { f.time(Date.parse(time)); await f.service().tick(); }
    expect(f.send).not.toHaveBeenCalled();
    f.time(Date.parse('2026-10-20T07:00:00Z')); await f.service().tick();
    expect(f.send).toHaveBeenCalledTimes(1); expect(f.send.mock.calls[0]?.[0].title).toBe('Coming up');
  });
  it('waits for the end of a same-day window around its time, and leaves a time outside quiet hours alone', async () => {
    const f = fixture(); f.quietHours({ ...nightly, from_minute: 13 * 60, to_minute: 14 * 60 });
    f.service().setSettings({ frequency: 'daily', time: '13:30', day_of: false });
    f.time(Date.parse('2026-10-19T13:45:00Z')); await f.service().tick(); expect(f.send).not.toHaveBeenCalled();
    f.time(Date.parse('2026-10-19T14:00:00Z')); await f.service().tick(); expect(f.send).toHaveBeenCalledTimes(1);
    const g = fixture(); g.quietHours(nightly);
    g.time(Date.parse('2026-10-19T07:30:00Z')); await g.service().tick(); expect(g.send).not.toHaveBeenCalled();
    g.time(monday); await g.service().tick(); expect(g.send).toHaveBeenCalledTimes(1);
  });
  it('sends a weekly time carried past midnight the morning after its day, not the morning of it', async () => {
    // Sunday 18 → Monday 19 → Tuesday 20, 07:00 each: Monday 23:00 is due Tuesday 07:00.
    const f = fixture(); f.quietHours(nightly);
    f.time(Date.parse('2026-10-18T12:00:00Z')); f.service().setSettings({ frequency: 'weekly', weekday: 1, time: '23:00', day_of: false });
    for (const time of ['2026-10-19T07:00:00Z', '2026-10-19T21:59:00Z', '2026-10-19T23:30:00Z']) { f.time(Date.parse(time)); await f.service().tick(); }
    expect(f.send).not.toHaveBeenCalled();
    f.time(Date.parse('2026-10-20T07:00:00Z')); await f.service().tick(); expect(f.send).toHaveBeenCalledTimes(1);
    f.time(Date.parse('2026-10-21T07:00:00Z')); await f.service().tick(); expect(f.send).toHaveBeenCalledTimes(1);
  });
  describe('§15.7 amendment — the next digest the status names is the one the scheduler sends', () => {
    // Settings shows `next_at`. Checked against the tick itself: no run a minute before
    // (unless it is due now), and the digest's run at that instant, sent or found with
    // nothing new to send.
    const sendsAt = async (f: ReturnType<typeof fixture>, at: number, expected: string) => {
      const next = f.service().status().next_at;
      expect(new Date(next!).toISOString()).toBe(expected); expect(f.service().status().time_zone).toBe('UTC');
      const before = f.service().status().last_run;
      if (next! > at) { f.time(next! - 60_000); await f.service().tick(); expect(f.service().status().last_run).toEqual(before); }
      f.time(next!); await f.service().tick();
      const run = f.service().status().last_run!; expect(run).toMatchObject({ at: next, mode: 'overview' }); expect(['sent', 'skipped']).toContain(run.state);
      return next!;
    };
    it('names the weekly day and time, then the week after once it went', async () => {
      const f = fixture(); const at = Date.parse('2026-10-17T12:00:00Z'); f.time(at); f.service().setSettings({ frequency: 'weekly', weekday: 1, time: '08:00', day_of: false });
      const sent = await sendsAt(f, at, '2026-10-19T08:00:00.000Z');
      await sendsAt(f, sent, '2026-10-26T08:00:00.000Z');
    });
    it('names now for a time already passed today, and quiet hours’ end for a time inside them', async () => {
      const f = fixture(); f.quietHours(nightly); const at = Date.parse('2026-10-19T12:00:00Z'); f.time(at);
      f.service().setSettings({ frequency: 'daily', time: '23:00', day_of: false });
      const now = await sendsAt(f, at, '2026-10-19T12:00:00.000Z');
      await sendsAt(f, now, '2026-10-20T07:00:00.000Z');
    });
    it('names the morning after for a weekly time carried past midnight', async () => {
      const f = fixture(); f.quietHours(nightly); const at = Date.parse('2026-10-17T12:00:00Z'); f.time(at);
      f.service().setSettings({ frequency: 'weekly', weekday: 1, time: '23:00', day_of: false });
      await sendsAt(f, at, '2026-10-20T07:00:00.000Z');
    });
    it('waits for the end of quiet hours that day when a passed time is caught inside them', async () => {
      const f = fixture(); f.quietHours({ ...nightly, from_minute: 13 * 60, to_minute: 14 * 60 }); const at = Date.parse('2026-10-19T13:30:00Z'); f.time(at);
      f.service().setSettings({ frequency: 'daily', time: '12:00', day_of: false });
      await sendsAt(f, at, '2026-10-19T14:00:00.000Z');
    });
    it('names nothing while the digest is off or the vault is locked', async () => {
      const f = fixture(); f.time(Date.parse('2026-10-17T12:00:00Z')); f.service().setSettings({ frequency: 'off', day_of: false });
      expect('next_at' in f.service().status()).toBe(false);
      f.service().setSettings({ frequency: 'daily' }); expect(f.service().status().next_at).toBeTypeOf('number');
      f.open(false); expect('next_at' in f.service().status()).toBe(false);
    });
  });
  describe('§15.7 amendment (2026-11-02) — the digest covers the days the owner chose', () => {
    const DAY = 86_400_000;
    // `act_by` decides whether a fact is in a window (`situationDue`), so each sits on its own day.
    const on = (id: string, title: string, days: number) => fact(id, { title, when: { from: monday + days * DAY, to: monday + days * DAY + 3600_000 },
      act_by: monday + days * DAY });
    it('lists a thing the morning it first comes within today and tomorrow, and Send now covers the same days', async () => {
      const f = fixture([on('dentist', 'Dentist', 2)]);
      f.service().setSettings({ frequency: 'daily', time: '08:00', day_of: false, look_ahead_days: 2 });
      expect(f.service().status().settings).toMatchObject({ frequency: 'daily', look_ahead_days: 2 });
      // Monday covers Monday and Tuesday, so Wednesday's appointment is not in it yet.
      await f.service().tick(); expect(f.service().status().last_run).toMatchObject({ mode: 'overview', state: 'skipped' });
      await f.service().sendNow(); expect(f.send).not.toHaveBeenCalled();
      f.time(monday + DAY); await f.service().tick();
      expect(f.send).toHaveBeenCalledTimes(1);
      expect(f.send.mock.calls[0]![0]).toMatchObject({ title: 'Coming up', text: expect.stringContaining('Dentist · 2026-10-21') });
    });
    it('looks as far ahead as the owner chose', async () => {
      for (const [look_ahead_days, listed] of [[3, true], [2, false]] as const) {
        const f = fixture([on('dentist', 'Dentist', 2)]);
        f.service().setSettings({ frequency: 'daily', time: '08:00', day_of: false, look_ahead_days }); await f.service().tick();
        expect(f.send.mock.calls.some(([message]) => message.text.includes('Dentist · 2026-10-21'))).toBe(listed);
      }
    });
    it('holds a weekly digest to a week however its frequency was set, and keeps a daily window for when it is daily again', async () => {
      // Saturday: inside a week of Monday, outside today and tomorrow.
      const f = fixture([on('boiler', 'Boiler service', 5)]);
      f.service().setSettings({ frequency: 'daily', time: '08:00', day_of: false, look_ahead_days: 2 });
      f.service().setSettings({ frequency: 'weekly', weekday: 1 });
      expect(f.service().status().settings.look_ahead_days).toBe(7);
      await f.service().tick(); expect(f.send.mock.calls[0]?.[0].text).toContain('Boiler service · 2026-10-24');
      f.service().setSettings({ frequency: 'daily' }); expect(f.service().status().settings.look_ahead_days).toBe(2);
      // `yours.change` `settings.update` writes the frequency alone, past `setSettings`.
      f.store.writeSetting('digest.frequency', 'weekly'); expect(f.service().status().settings.look_ahead_days).toBe(7);
    });
    it('refuses a window that is not a choice, and a weekly digest asked for less than a week', () => {
      const f = fixture();
      for (const look_ahead_days of [1, 5, 30, 7.5, '7', null]) {
        expect(() => f.service().setSettings({ frequency: 'daily', look_ahead_days: look_ahead_days as never })).toThrow('Choose a valid overview schedule');
      }
      expect(() => f.service().setSettings({ frequency: 'weekly', look_ahead_days: 3 })).toThrow('A weekly digest looks at least 7 days ahead');
      expect(f.service().status().settings).toMatchObject({ frequency: 'weekly', look_ahead_days: 7 });
      f.service().setSettings({ frequency: 'weekly', look_ahead_days: 14 }); expect(f.service().status().settings.look_ahead_days).toBe(14);
    });
    it('covers a week by default and from settings saved before the choice, and a save that does not name it keeps it', () => {
      const f = fixture(); expect(f.service().status().settings.look_ahead_days).toBe(7);
      f.store.writeSetting('situations.delivery', { frequency: 'daily', weekday: 1, time: '08:00', day_of: true }); f.store.writeSetting('digest.frequency', 'daily');
      expect(f.service().status().settings.look_ahead_days).toBe(7);
      // An older server stored a field it did not know as it came.
      f.store.writeSetting('situations.delivery', { frequency: 'daily', weekday: 1, time: '08:00', day_of: true, look_ahead_days: 99 });
      expect(f.service().status().settings.look_ahead_days).toBe(7);
      // An older client saves the four fields it knows.
      f.service().setSettings({ look_ahead_days: 3 }); f.service().setSettings({ frequency: 'daily', weekday: 2, time: '09:00', day_of: false });
      expect(f.service().status().settings).toEqual({ frequency: 'daily', weekday: 2, time: '09:00', day_of: false, look_ahead_days: 3 });
    });
  });
  describe('§15.7 amendment (2026-11-02, later) — the Agenda, apart from the Digest', () => {
    // Monday 19 October 2026 is day 0, in UTC.
    const on = (day: number, hhmm: string) => Date.parse(`2026-10-${19 + day}T${hhmm}:00Z`);
    const event = (id: string, title: string, day: number, from: string, to: string) => fact(id, { ref: { collection: 'calendar', id: `work:${id}` },
      kind: 'calendar', title, when: { from: on(day, from), to: on(day, to) }, act_by: on(day, from), valid_until: on(day, to),
      evidence: [{ collection: 'calendar', id: `work:${id}` }] });
    const task = (id: string, title: string, day: number, hhmm: string) => fact(id, { ref: { collection: 'task', id }, kind: 'task', title,
      when: { from: on(day, hhmm), to: on(day, hhmm) }, act_by: on(day, hhmm), evidence: [{ collection: 'task', id }] });
    const allDay = (id: string, title: string, day: number) => fact(id, { ref: { collection: 'occasion', id, field: 'rules.date' }, kind: 'occasion', title,
      when: { from: on(day, '00:00'), to: on(day + 1, '00:00') }, when_day: `2026-10-${19 + day}`, act_by: on(day, '00:00'), evidence: [{ collection: 'occasion', id }] });
    // Every morning's routine is a recurring series: each day's instance is its own record.
    const routine = (day: number) => [event(`wake-${day}`, 'Wake up', day, '06:00', '06:15'), event(`jog-${day}`, 'Jogging', day, '06:30', '07:15'),
      event(`breakfast-${day}`, 'Breakfast', day, '07:30', '08:00'), event(`drive-${day}`, 'Driving to work', day, '08:00', '08:45'),
      event(`briefing-${day}`, 'Morning briefing', day, '09:00', '09:30')];
    const tuesday = ['All day · Mum’s birthday', 'Until 10:00 · Conference', '06:00 Wake up', '06:30 Jogging', '07:30 Breakfast', '08:00 Driving to work',
      '09:00 Morning briefing · prep notes ready', '12:00 Pay electricity bill'];
    const agendaOnly = (f: ReturnType<typeof fixture>, settings: Partial<import('@recued/contracts').SituationAgendaSettings>) => {
      f.service().setSettings({ frequency: 'off', day_of: false }); f.service().setAgenda({ enabled: true, ...settings });
    };
    const texts = (f: ReturnType<typeof fixture>) => f.send.mock.calls.map(([message]) => message);
    it('lists the next day in time order, all-day first, every recurring instance, and says prep notes are ready', async () => {
      const f = fixture([...routine(0), ...routine(1), allDay('mum', 'Mum’s birthday', 1), task('bill', 'Pay electricity bill', 1, '12:00'),
        event('late-call', 'Late call', 0, '22:00', '23:00'),
        // Begun the day before: it says until when, after the all-day items.
        fact('conference', { ref: { collection: 'calendar', id: 'work:conference' }, kind: 'calendar', title: 'Conference',
          when: { from: on(0, '15:00'), to: on(1, '10:00') }, act_by: on(0, '15:00'), valid_until: on(1, '10:00'), evidence: [{ collection: 'calendar', id: 'work:conference' }] })]);
      f.prepared(['briefing-1']); f.time(on(0, '20:00')); agendaOnly(f, { time: '20:00', day: 'tomorrow' });
      await f.service().tick();
      expect(texts(f)).toEqual([{ title: 'Agenda · Tue 20 Oct', text: tuesday.join('\n'), ui_link_url: '#today' }]);
      // An agenda repeats what has not changed: Send now lists the same day again, where the Digest would send nothing.
      await f.service().sendAgendaNow(); expect(texts(f)[1]?.text).toBe(tuesday.join('\n'));
      // The next evening lists the next day's own instances of the same series.
      f.time(on(1, '20:00')); f.facts([...routine(2)]); await f.service().tick();
      expect(texts(f)[2]).toMatchObject({ title: 'Agenda · Wed 21 Oct', text: expect.stringContaining('06:30 Jogging') });
    });
    it('leaves out on the day it goes what has already ended, and keeps an open task whose time has passed', async () => {
      const f = fixture([...routine(1), task('cat', 'Feed the cat', 1, '07:00'), task('bill', 'Pay electricity bill', 1, '12:00')]);
      // Set before its time and sent late, as after a restart: what is over by then is left out.
      f.time(on(1, '06:00')); agendaOnly(f, { time: '07:00', day: 'today' }); f.time(on(1, '08:10')); await f.service().tick();
      expect(texts(f).map(message => message.text)).toEqual([['07:00 Feed the cat', '08:00 Driving to work', '09:00 Morning briefing',
        '12:00 Pay electricity bill'].join('\n')]);
    });
    it('leaves out an ended event that comes in only as related to one still to come', async () => {
      // The query adds what a due record names as related, ended or not.
      const report = fact('report', { ref: { collection: 'task', id: 'report' }, kind: 'task', title: 'Send the run report',
        when: { from: on(1, '12:00'), to: on(1, '12:00') }, act_by: on(1, '12:00'), related: [{ collection: 'calendar', id: 'work:jog-1' }],
        evidence: [{ collection: 'task', id: 'report' }] });
      const f = fixture([report, event('jog-1', 'Jogging', 1, '06:30', '07:15')]);
      f.time(on(1, '06:00')); agendaOnly(f, { time: '07:00', day: 'today' }); f.time(on(1, '08:10')); await f.service().tick();
      expect(texts(f).map(message => message.text)).toEqual(['12:00 Send the run report']);
    });
    it('keeps what a reminder keeps private as "Private reminder", at its own time', async () => {
      const f = fixture([]); const history = createProactiveHistoryStore(f.db, createProactiveProposalStore(f.db));
      const birthday = history.saveOccasion({ title: 'Ana’s birthday', month_day: '10-20', people: ['ana'], muted: false, rules: [], sphere: 'personal' }, monday);
      f.facts([allDay(birthday.id, 'Ana’s birthday', 1), event('dentist-1', 'Dentist', 1, '18:30', '19:00')]);
      f.time(on(0, '20:00')); agendaOnly(f, { time: '20:00', day: 'tomorrow' }); await f.service().tick();
      expect(texts(f)[0]?.text).toBe('All day · Private reminder\n18:30 Dentist');
    });
    it('goes at its own time on its own two sends a day, so it never takes the Digest’s', async () => {
      const f = fixture([...routine(1), task('bill', 'Pay electricity bill', 1, '12:00')]);
      f.time(on(1, '06:00')); f.service().setSettings({ frequency: 'daily', time: '08:00', day_of: false });
      f.service().setAgenda({ enabled: true, time: '07:00', day: 'today' });
      expect(f.service().agendaStatus()).toMatchObject({ next_at: on(1, '07:00'), time_zone: 'UTC' });
      await f.service().tick(); expect(f.send).not.toHaveBeenCalled();
      // Two agenda tries that reach no channel spend the Agenda's two sends, not the Digest's.
      f.fail(true); for (const time of ['07:00', '07:01', '07:02']) { f.time(on(1, time)); await f.service().tick(); }
      expect(texts(f).map(message => message.title)).toEqual(['Agenda · Tue 20 Oct', 'Agenda · Tue 20 Oct']);
      f.fail(false); f.time(on(1, '08:00')); await f.service().tick();
      expect(texts(f).map(message => message.title)).toEqual(['Agenda · Tue 20 Oct', 'Agenda · Tue 20 Oct', 'Coming up']);
      // Each card reads its own runs.
      const status = f.service().status();
      expect(status.last_run).toMatchObject({ mode: 'overview', state: 'sent' });
      expect(f.service().agendaStatus()).toMatchObject({ pending: 1, last_run: { mode: 'agenda', state: 'pending' }, last_sent: null });
    });
    it('names the next agenda only while it is on, and sends a held-over agenda no later than its own day', async () => {
      const f = fixture([...routine(1), ...routine(2)]); f.time(on(1, '06:00'));
      expect(f.service().agendaStatus()).toEqual({ settings: { enabled: false, time: '07:00', day: 'today', frequency: 'daily', weekday: 1 },
        last_run: null, last_sent: null, pending: 0, uncertain: 0 });
      agendaOnly(f, { time: '07:00', day: 'today' }); f.fail(true); f.time(on(1, '07:00')); await f.service().tick();
      expect(f.service().agendaStatus().pending).toBe(1);
      // The next day, Tuesday's agenda is not sent late: it is superseded, and Wednesday's goes.
      f.fail(false); f.time(on(2, '07:00')); await f.service().tick();
      expect(texts(f).map(message => message.title)).toEqual(['Agenda · Tue 20 Oct', 'Agenda · Wed 21 Oct']);
      expect(f.db.prepare("SELECT id,state FROM scheduled_situation_runs WHERE mode='agenda' ORDER BY id").all())
        .toEqual([{ id: 'agenda:2026-10-20', state: 'superseded' }, { id: 'agenda:2026-10-21', state: 'sent' }]);
      f.service().setAgenda({ enabled: false }); expect('next_at' in f.service().agendaStatus()).toBe(false);
    });
    it('carried past midnight by quiet hours, goes when they end and lists that morning’s day', async () => {
      const f = fixture([...routine(1)]); f.quietHours({ enabled: true, from_minute: 22 * 60, to_minute: 7 * 60, applies_to: ['notification'], updated_at: 1 });
      f.time(on(0, '21:00')); agendaOnly(f, { time: '23:00', day: 'tomorrow' });
      expect(f.service().agendaStatus().next_at).toBe(on(1, '07:00'));
      // Turned on in the evening, the day's 07:00 has passed: it is not caught up at once.
      for (const time of [on(0, '21:00'), on(0, '23:00'), on(1, '06:59')]) { f.time(time); await f.service().tick(); }
      expect(f.send).not.toHaveBeenCalled();
      f.time(on(1, '07:00')); await f.service().tick();
      expect(texts(f)).toEqual([expect.objectContaining({ title: 'Agenda · Tue 20 Oct', text: expect.stringContaining('07:30 Breakfast') })]);
    });
    it('turned on after the day’s time, starts the next day; a day missed while the server was down still goes', async () => {
      const f = fixture([...routine(1), ...routine(2), task('bill', 'Pay electricity bill', 2, '12:00')]); f.time(on(1, '09:00'));
      agendaOnly(f, { time: '07:00', day: 'today' });
      expect(f.service().agendaStatus().next_at).toBe(on(2, '07:00'));
      await f.service().tick(); expect(f.send).not.toHaveBeenCalled();
      // Wednesday's 07:00 passed with the server down; at 11:00 it goes, without what is over.
      f.time(on(2, '11:00')); await f.service().tick();
      expect(texts(f)).toEqual([expect.objectContaining({ title: 'Agenda · Wed 21 Oct', text: '12:00 Pay electricity bill' })]);
    });
    it('sends now while it is off, and a day with nothing on sends nothing', async () => {
      const f = fixture([...routine(1)]); f.time(on(1, '05:00'));
      await f.service().sendAgendaNow(); expect(texts(f)[0]).toMatchObject({ title: 'Agenda · Tue 20 Oct' });
      f.service().setAgenda({ day: 'tomorrow' }); await f.service().sendAgendaNow();
      expect(f.send).toHaveBeenCalledTimes(1); expect(f.service().agendaStatus()).toMatchObject({ last_run: { mode: 'agenda_manual', state: 'skipped' } });
      expect(f.service().status().last_run).toBeNull();
    });
    it('refuses a schedule it cannot keep', () => {
      const f = fixture();
      for (const patch of [{ time: '7:00' }, { time: '24:00' }, { day: 'yesterday' }, { enabled: 'yes' }, { frequency: 'monthly' }, { frequency: null },
        { weekday: 0 }, { weekday: 8 }, { weekday: 1.5 }, { weekday: '1' }]) {
        expect(() => f.service().setAgenda(patch as never)).toThrow('Choose a valid agenda schedule');
      }
      expect(f.service().agendaSettings()).toEqual({ enabled: false, time: '07:00', day: 'today', frequency: 'daily', weekday: 1 });
    });
    it('reads settings saved before the weekly choice as daily, and a save that names neither keeps them', () => {
      const f = fixture(); f.store.writeSetting('situations.agenda', { enabled: true, time: '06:30', day: 'tomorrow' });
      expect(f.service().agendaSettings()).toEqual({ enabled: true, time: '06:30', day: 'tomorrow', frequency: 'daily', weekday: 1 });
      // A client from before the weekly choice saves the three fields it knows.
      f.service().setAgenda({ frequency: 'weekly', weekday: 5 }); f.service().setAgenda({ enabled: true, time: '07:15', day: 'today' });
      expect(f.service().agendaSettings()).toEqual({ enabled: true, time: '07:15', day: 'today', frequency: 'weekly', weekday: 5 });
    });
    it('keeps each card’s last run and last sent through retention', async () => {
      const f = fixture([...routine(1), task('bill', 'Pay electricity bill', 1, '12:00')]);
      f.time(on(1, '07:00')); f.service().setSettings({ frequency: 'daily', time: '07:00', day_of: false });
      f.service().setAgenda({ enabled: true, time: '07:00', day: 'today' }); await f.service().tick();
      expect(texts(f).map(message => message.title)).toEqual(['Coming up', 'Agenda · Tue 20 Oct']);
      f.time(on(3, '07:00')); f.service().setAgenda({ enabled: false }); f.service().setSettings({ frequency: 'off' });
      f.service().prune(on(3, '00:00'));
      expect(f.service().status().last_sent).toMatchObject({ mode: 'overview' });
      expect(f.service().agendaStatus().last_sent).toMatchObject({ mode: 'agenda' });
    });
    describe('§15.7 amendment (2026-11-03) — a weekly agenda', () => {
      // The owner: "perhaps agenda can be weekly as well for user to choose between daily & weekly".
      const nightly = { enabled: true, from_minute: 22 * 60, to_minute: 7 * 60, applies_to: ['notification' as const], updated_at: 1 };
      it('goes on its weekday and lists seven days, a day at a time, leaving out a day with nothing on', async () => {
        const f = fixture([...routine(0), allDay('mum', 'Mum’s birthday', 1), task('bill', 'Pay electricity bill', 3, '12:00'),
          event('brunch', 'Brunch', 6, '11:00', '12:00'), event('dentist', 'Dentist', 7, '10:00', '10:30')]);
        f.prepared(['briefing-0']);
        // Sunday 18 October, the evening before the week it lists.
        f.time(on(-1, '12:00')); agendaOnly(f, { frequency: 'weekly', weekday: 7, time: '18:00', day: 'tomorrow' });
        expect(f.service().agendaStatus().next_at).toBe(on(-1, '18:00'));
        f.time(on(-1, '17:59')); await f.service().tick(); expect(f.send).not.toHaveBeenCalled();
        f.time(on(-1, '18:00')); await f.service().tick();
        expect(texts(f)).toEqual([{ title: 'Agenda · Mon 19 Oct to Sun 25 Oct', ui_link_url: '#today', text: ['Mon 19 Oct', '06:00 Wake up', '06:30 Jogging',
          '07:30 Breakfast', '08:00 Driving to work', '09:00 Morning briefing · prep notes ready', '', 'Tue 20 Oct', 'All day · Mum’s birthday', '',
          'Thu 22 Oct', '12:00 Pay electricity bill', '', 'Sun 25 Oct', '11:00 Brunch'].join('\n') }]);
        // Not again until its weekday comes round.
        expect(f.service().agendaStatus().next_at).toBe(on(6, '18:00'));
        for (let day = 0; day < 6; day++) { f.time(on(day, '18:00')); await f.service().tick(); }
        expect(f.send).toHaveBeenCalledTimes(1);
      });
      it('lists something that lasts several days on each of them', async () => {
        const f = fixture([fact('conference', { ref: { collection: 'calendar', id: 'work:conference' }, kind: 'calendar', title: 'Conference',
          when: { from: on(0, '15:00'), to: on(2, '10:00') }, act_by: on(0, '15:00'), valid_until: on(2, '10:00'), evidence: [{ collection: 'calendar', id: 'work:conference' }] })]);
        f.time(on(0, '06:00')); f.service().setAgenda({ frequency: 'weekly', weekday: 1 }); await f.service().sendAgendaNow();
        expect(texts(f)[0]?.text).toBe(['Mon 19 Oct', '15:00 Conference', '', 'Tue 20 Oct', 'All day · Conference', '', 'Wed 21 Oct', 'Until 10:00 · Conference'].join('\n'));
      });
      it('turned on after its time, waits a week; one missed while the server was down goes later that week with the days still to come', async () => {
        const facts = () => [...routine(0), task('bill', 'Pay electricity bill', 2, '12:00'), event('brunch', 'Brunch', 6, '11:00', '12:00')];
        const f = fixture(facts());
        f.time(on(0, '09:00')); agendaOnly(f, { frequency: 'weekly', weekday: 1, time: '07:00', day: 'today' });
        expect(f.service().agendaStatus().next_at).toBe(on(7, '07:00'));
        await f.service().tick(); expect(f.send).not.toHaveBeenCalled();
        // Turned on the day before, then the server is down until Wednesday 10:00.
        const g = fixture(facts());
        g.time(on(-1, '12:00')); agendaOnly(g, { frequency: 'weekly', weekday: 1, time: '07:00', day: 'today' });
        g.time(on(2, '10:00')); expect(g.service().agendaStatus().next_at).toBe(on(2, '10:00'));
        await g.service().tick();
        expect(texts(g)).toEqual([{ title: 'Agenda · Wed 21 Oct to Sun 25 Oct', ui_link_url: '#today',
          text: ['Wed 21 Oct', '12:00 Pay electricity bill', '', 'Sun 25 Oct', '11:00 Brunch'].join('\n') }]);
        expect(g.service().agendaStatus().next_at).toBe(on(7, '07:00'));
      });
      it('carried past midnight by quiet hours, goes the morning after its weekday and lists seven days from that morning', async () => {
        for (const day of ['today', 'tomorrow'] as const) {
          const f = fixture([...routine(0), event('brunch', 'Brunch', 6, '11:00', '12:00'), event('dentist', 'Dentist', 7, '10:00', '10:30')]);
          f.quietHours(nightly); f.time(on(-1, '12:00')); agendaOnly(f, { frequency: 'weekly', weekday: 7, time: '23:00', day });
          expect(f.service().agendaStatus().next_at).toBe(on(0, '07:00'));
          for (const time of [on(-1, '23:00'), on(0, '06:59')]) { f.time(time); await f.service().tick(); }
          expect(f.send).not.toHaveBeenCalled();
          f.time(on(0, '07:00')); await f.service().tick();
          expect(texts(f)).toEqual([expect.objectContaining({ title: 'Agenda · Mon 19 Oct to Sun 25 Oct', text: expect.stringContaining('11:00 Brunch') })]);
          expect(texts(f)[0]?.text).not.toContain('Dentist');
        }
      });
      it('a switch from daily leaves a daily agenda still waiting unsent', async () => {
        const f = fixture([...routine(1), task('bill', 'Pay electricity bill', 1, '12:00')]);
        f.time(on(1, '06:00')); agendaOnly(f, { time: '07:00', day: 'today' });
        f.fail(true); f.time(on(1, '07:00')); await f.service().tick(); expect(f.service().agendaStatus().pending).toBe(1);
        f.fail(false); f.time(on(1, '07:30')); f.service().setAgenda({ frequency: 'weekly', weekday: 2, time: '08:00' });
        await f.service().tick(); expect(f.send).toHaveBeenCalledTimes(1);
        f.time(on(1, '08:00')); await f.service().tick();
        expect(texts(f).map(message => message.title)).toEqual(['Agenda · Tue 20 Oct', 'Agenda · Tue 20 Oct to Mon 26 Oct']);
        expect(f.db.prepare("SELECT id,state FROM scheduled_situation_runs WHERE mode='agenda' ORDER BY id").all())
          .toEqual([{ id: 'agenda:2026-10-20', state: 'superseded' }, { id: 'agenda_week:2026-10-20', state: 'sent' }]);
      });
      it('Send now lists seven days from today or tomorrow on any day, and a week with nothing on sends nothing', async () => {
        const f = fixture([...routine(2), event('brunch', 'Brunch', 6, '11:00', '12:00'), event('dentist', 'Dentist', 9, '10:00', '10:30')]);
        // Wednesday, while it is off: its weekday is Sunday, and Send now does not wait for it.
        f.time(on(2, '05:00')); f.service().setAgenda({ frequency: 'weekly', weekday: 7, day: 'tomorrow' });
        await f.service().sendAgendaNow();
        expect(texts(f)[0]).toMatchObject({ title: 'Agenda · Thu 22 Oct to Wed 28 Oct', text: 'Sun 25 Oct\n11:00 Brunch\n\nWed 28 Oct\n10:00 Dentist' });
        f.service().setAgenda({ day: 'today' }); await f.service().sendAgendaNow();
        expect(texts(f)[1]).toMatchObject({ title: 'Agenda · Wed 21 Oct to Tue 27 Oct', text: expect.stringMatching(/^Wed 21 Oct\n06:00 Wake up\n/u) });
        expect(texts(f)[1]?.text).not.toContain('Dentist');
        f.facts([]); await f.service().sendAgendaNow();
        expect(f.send).toHaveBeenCalledTimes(2); expect(f.service().agendaStatus().last_run).toMatchObject({ mode: 'agenda_manual', state: 'skipped' });
      });
      it('holds each day to its own count of lines and says how many more that day has', async () => {
        const many = Array.from({ length: 42 }, (_, index) => task(`task-${index}`, `Task ${String(index).padStart(2, '0')}`, 1, '12:00'));
        const f = fixture([...many, task('later', 'Pay electricity bill', 2, '12:00')]);
        f.time(on(1, '06:00')); f.service().setAgenda({ frequency: 'weekly', weekday: 2 }); await f.service().sendAgendaNow();
        const lines = texts(f)[0]!.text.split('\n');
        expect(lines.slice(0, 2)).toEqual(['Tue 20 Oct', '12:00 Task 00']);
        expect(lines.slice(40, 46)).toEqual(['12:00 Task 39', 'And 2 more that day. Open Today for the rest.', '', 'Wed 21 Oct', '12:00 Pay electricity bill']);
      });
    });
  });
  it('holds before the configured local time, disables ordinary pushes, and lets the owner send now', async () => {
    const f = fixture(); f.time(Date.parse('2026-10-19T07:30:00Z')); await f.service().tick(); expect(f.send).not.toHaveBeenCalled();
    f.service().setSettings({ frequency: 'off' }); f.time(monday); await f.service().tick(); expect(f.send).not.toHaveBeenCalled();
    await f.service().sendNow(); expect(f.send).toHaveBeenCalledTimes(1);
    expect(() => f.service().setSettings({ time: '25:40' })).toThrow(/valid/);
    expect(() => f.service().setSettings({ weekday: 0 })).toThrow(/valid/);
  });
  it('retains a known failed delivery and retries without marking unseen clusters as sent', async () => {
    const f = fixture(); f.fail(true); await f.service().tick(); expect(f.service().status().pending).toBe(1);
    expect(f.db.prepare('SELECT * FROM scheduled_situation_seen').all()).toEqual([]);
    f.fail(false); await f.service().tick(); expect(f.db.prepare('SELECT * FROM scheduled_situation_seen').all()).toHaveLength(1);
  });
  it('reserves at most two automatic send attempts per day, then retries a failed point with fresh values on the next day', async () => {
    const f = fixture(); f.fail(true);
    await f.service().tick(); await f.service().tick(); await f.service().tick();
    expect(f.send).toHaveBeenCalledTimes(2);
    f.time(monday + 86_400_000); f.fail(false); await f.service().tick();
    expect(f.send).toHaveBeenCalledTimes(3); expect(f.service().status().pending).toBe(0);
    expect(f.db.prepare('SELECT * FROM scheduled_situation_attempts').all()).toHaveLength(3);
  });
  it('uses one in-flight execution and at most two successful automatic pushes per local day', async () => {
    const f = fixture([fact('one', { when: { from: monday, to: monday + 3600_000 } })]);
    await Promise.all([f.service().tick(), f.service().tick()]); expect(f.send).toHaveBeenCalledTimes(1);
    f.facts([fact('one', { title: 'Changed Lisbon trip', when: { from: monday, to: monday + 3600_000 } })]);
    await f.service().tick(); expect(f.send.mock.calls.length).toBeLessThanOrEqual(2);
  });
  it('keeps source revocations ahead of the query and the last-mile release, including stored resolutions', async () => {
    const f = fixture(); const rows = createContractGrantEntryStore(f.contracts);
    rows.set('user_self', 'data.booking', false, monday); await f.service().tick(); expect(f.send).not.toHaveBeenCalled();
    rows.set('user_self', 'data.booking', true, monday);
    f.service().setSettings({ frequency: 'daily' }); f.time(monday + 86_400_000);
    f.summary(async () => { rows.set('user_self', 'data.booking', false, monday); return 'not released'; });
    await f.service().tick(); expect(f.send).not.toHaveBeenCalled();
  });
  it('returns Today values and the proposal footer metadata while keeping questions out of the scheduled push', async () => {
    const f = fixture([fact(), fact('question', { title: 'When was it done?', kind: 'asset_rule', ref: { collection: 'asset', id: 'q' }, when: undefined, missing: true, act_by: monday })]);
    const today = await f.service().today({ now: monday, before: monday + 7 * 86_400_000 });
    expect(today.proposal_count).toBe(3); expect(today.newest_proposal?.title).toBe('Boiler');
    expect(today.situations.clusters.flatMap(cluster => cluster.items).some(item => item.ref.id === 'q')).toBe(false);
    await f.service().tick(); expect(f.send.mock.calls[0]?.[0].text).not.toContain('When was it done?');
  });
  it('shows the brief’s summary on Today for the same values, though Today reads another window', async () => {
    const f = fixture(); f.summary(async () => 'Lisbon trip starts tomorrow.'); await f.service().tick();
    expect(f.send.mock.calls[0]?.[0].text).toContain('Lisbon trip starts tomorrow.');
    // A one-day window gives the trip other verdicts than the brief's week did; the values are the same.
    const today = await f.service().today({ now: monday, before: monday + 86_400_000 + 1 });
    expect(today.summaries).toEqual({ [today.situations.clusters[0]!.id]: 'Lisbon trip starts tomorrow.' });
    f.facts([fact('trip', { title: 'Lisbon trip, rebooked' })]);
    expect((await f.service().today({ now: monday, before: monday + 7 * 86_400_000 })).summaries).toBeUndefined();
  });
  it('keeps what the owner dismissed off Today until it lapses or is restored', async () => {
    const f = fixture([fact(), fact('check', { ref: { collection: 'asset', id: 'passport', field: 'trip_validity:booking:trip' }, title: 'Passport check',
      kind: 'travel_validity', basis: 'derived', related: [{ collection: 'booking', id: 'trip' }] })]);
    const ids = async () => (await f.service().today({ now: monday, before: monday + 7 * 86_400_000 })).situations.clusters.flatMap(cluster => cluster.items).map(item => item.ref.id);
    expect(await ids()).toEqual(expect.arrayContaining(['trip', 'passport']));
    const dismissals = createSituationDismissalStore(f.db); const ref = { collection: 'asset', id: 'passport', field: 'trip_validity:booking:trip' };
    dismissals.dismiss({ key: situationItemKey(ref), scope: 'item', code: 'not_now', label: 'Passport check', ref, kind: 'travel_validity', until: monday + 3_600_000, at: monday });
    expect(await ids()).toEqual(['trip']);
    f.time(monday + 3_600_000); expect(await ids()).toEqual(expect.arrayContaining(['trip', 'passport']));
    dismissals.dismiss({ key: situationKindKey('travel_validity'), scope: 'kind', code: 'never_this_kind', label: 'Passport check', ref: null, kind: 'travel_validity', until: null, at: monday });
    expect(await ids()).toEqual(['trip']);
    dismissals.restore(situationKindKey('travel_validity')); expect(await ids()).toEqual(expect.arrayContaining(['trip', 'passport']));
  });
  it('performs the second query with the cluster place, people and date', async () => {
    const trip = fact('trip', { place: { key: 'city:lisbon', name: 'Lisbon' }, people: ['Ana'], related: [{ collection: 'asset', id: 'passport' }] });
    const f = fixture([trip, fact('passport', { ref: { collection: 'asset', id: 'passport' }, title: 'Passport', kind: 'asset_rule',
      when: { from: monday + 80 * 86_400_000, to: monday + 80 * 86_400_000 }, act_by: monday + 70 * 86_400_000 })]);
    const today = await f.service().today({ now: monday, before: monday + 7 * 86_400_000 });
    const passport = today.situations.clusters.flatMap(cluster => cluster.items).find(item => item.ref.id === 'passport')!;
    expect(passport.when.verdict).toBe('outside'); expect(passport.where.verdict).toBe('unknown');
    const returnedTrip = today.situations.clusters.flatMap(cluster => cluster.items).find(item => item.ref.id === 'trip')!;
    expect(returnedTrip.where.verdict).toBe('match'); expect(returnedTrip.who.verdict).toBe('match');
  });
  // The lines of every group run on together, so a line that misses its group names what it
  // misses (§6.2), and a fit says nothing more.
  it('says in words how an overview line misses its group, by the item the group is anchored on', async () => {
    const day = 86_400_000;
    const asset = (id: string, title: string, from: number, patch: Partial<SituationFact> = {}) => fact(id, { ref: { collection: 'asset', id }, title,
      kind: 'asset_rule', when: { from, to: from }, act_by: monday + 70 * day, ...patch });
    const lines = async (facts: SituationFact[]) => { const f = fixture(facts); await f.service().tick(); return f.send.mock.calls[0]![0].text.split('\n'); };
    // A check that opens with the trip and ranks above it is not what the trip's lines miss.
    const far = await lines([fact('trip', { related: [{ collection: 'asset', id: 'passport' }, { collection: 'asset', id: 'check' }] }),
      asset('check', 'Passport check', monday + day, { kind: 'travel_validity', consequence: 'floor', when: { from: monday + day, to: monday + 2 * day } }),
      asset('passport', 'Passport', monday + 80 * day)]);
    expect(far).toEqual(expect.arrayContaining(['Lisbon trip · 2026-10-20', 'Passport check · 2026-10-20', 'Passport · 2027-01-07 · well after “Lisbon trip”']));
    expect(far.join('\n')).not.toMatch(/ · (match|near|outside|unknown|inferred)$/mu);
    expect(await lines([fact('trip', { related: [{ collection: 'asset', id: 'visa' }] }), asset('visa', 'Visa', monday - 3 * day)]))
      .toContain('Visa · 2026-10-16 · shortly before “Lisbon trip”');
  });
  it('says a last-time line and a guess are what they are', async () => {
    const f = fixture([fact(), fact('last', { ref: { collection: 'episode', id: 'last' }, title: 'Flowers in Lisbon', basis: 'inferred', last_time: true,
      related: [{ collection: 'booking', id: 'trip' }] })]);
    f.store.writeSetting('last_time.choice', 'on'); await f.service().tick();
    expect(f.send.mock.calls[0]![0].text.split('\n')).toContain('Flowers in Lisbon · 2026-10-20 · from last time · Recued’s guess');
  });
  it('keeps last-time restricted to an opted-in digest, never a day-of or Today source', async () => {
    const f = fixture([fact(), fact('last', { ref: { collection: 'episode', id: 'last' }, title: 'Flowers in Lisbon', last_time: true, related: [{ collection: 'booking', id: 'trip' }] })]);
    f.store.writeSetting('last_time.choice', 'on'); await f.service().tick();
    expect(f.send.mock.calls[0]?.[0].text).toContain('Flowers in Lisbon');
    const today = await f.service().today({ now: monday, before: monday + 7 * 86_400_000 });
    expect(JSON.stringify(today.situations)).not.toContain('Flowers in Lisbon');
  });
  it('constrains model output to one supplied value and has a real no-model path', async () => {
    const calls = vi.fn(async (_manifest: IngredientManifest, _input: Record<string, unknown>) => ({ body: { highlight_position: 0, invented: 'No such claim' } }));
    const f = fixture(); let ready = false;
    const summarize = createClusterSummary({ call: calls as ExecuteChatAiCall, ready: () => ready ? 'any' : undefined });
    const cluster = (await f.service().today({ now: monday, before: monday + 7 * 86_400_000 })).situations.clusters[0]!;
    expect(await summarize(cluster)).toBeUndefined(); expect(calls).not.toHaveBeenCalled();
    ready = true; expect(await summarize(cluster)).toBe('First: Lisbon trip'); expect(calls).toHaveBeenCalledTimes(1);
    expect(calls.mock.calls[0]?.[1]).toHaveProperty('llm.force_layer', 'any');
  });
});

const clockFact = (collection = 'asset', patch: Partial<SituationFact> = {}): SituationFact => fact('passport', {
  ref: { collection, id: 'passport', field: 'rules.renew' }, kind: collection === 'asset' ? 'asset_rule' : 'occasion',
  title: 'Renew passport', when: { from: monday, to: monday }, act_by: monday, consequence: 'floor', ...patch,
});
const dueTrip = (clock: SituationFact) => fact('trip', { title: 'Lisbon trip starts today',
  when: { from: monday, to: monday + 3_600_000 }, act_by: monday, related: [clock.ref] });
const dayOfOnly = (f: ReturnType<typeof fixture>) => f.service().setSettings({ frequency: 'off', day_of: true });
const obligation = (f: ReturnType<typeof fixture>, derivation: 'rule_emitted' | 'user_declared') => f.work.ensureCommitment({
  id: 'renewal', source_id: 'recued.commitment', direction: 'outbound', statement: 'Renew passport', derivation,
  expiry_policy: 'escalate_overdue', promised_for_at: monday,
}, monday).commitment;

describe('D-325 day-of notification ownership', () => {
  it('projects only source-granted items before applying the view limits', async () => {
    const clock = clockFact('asset', { evidence: [{ collection: 'asset', id: 'passport' }] });
    const f = fixture([clock, dueTrip(clock)]); const project = vi.fn((items: readonly import('@recued/contracts').SituationItem[]) => items);
    const result = await f.query({ time: { from: monday, to: monday + 86_400_000 }, surface: 'push' }, { owner: true,
      grants: { isVerbOpGranted: () => true, isCollectionReadGranted: collection => collection === 'asset', isTopicReadGranted: () => true },
      projectClusterItems: project });
    expect(project).toHaveBeenCalled();
    expect(project.mock.calls.flatMap(([items]) => items).map(item => item.ref.collection)).toEqual(['asset']);
    expect(JSON.stringify(result)).not.toContain('Lisbon');
  });

  it('rejects view projections that inject a record outside the granted input', async () => {
    const f = fixture([fact()]);
    await expect(f.query({ time: { from: monday, to: monday + 7 * 86_400_000 } }, { owner: true,
      grants: { isVerbOpGranted: () => true, isCollectionReadGranted: () => true, isTopicReadGranted: () => true },
      projectClusterItems: items => [{ ...items[0]!, ref: { collection: 'asset', id: 'injected' } }],
    })).rejects.toThrow('must use supplied items');
  });

  it('keeps the inference and item caps when projecting a complete crowded cluster', async () => {
    const clock = clockFact();
    const f = fixture([clock, ...['one', 'two', 'three'].map(id => fact(id, { ref: { collection: 'asset', id },
      basis: 'inferred', related: [clock.ref], title: `Inference ${id}`, when: undefined, act_by: undefined }))]);
    const project = vi.fn((items: readonly import('@recued/contracts').SituationItem[]) => items);
    const result = await f.query({ time: { from: monday, to: monday + 86_400_000 }, surface: 'push', limit_items: 1 }, { owner: true,
      grants: { isVerbOpGranted: () => true, isCollectionReadGranted: () => true, isTopicReadGranted: () => true }, projectClusterItems: project });
    expect(project.mock.calls.flatMap(([items]) => items).filter(item => item.basis === 'inferred')).toHaveLength(1);
    expect(result.clusters[0]?.items).toHaveLength(1);
  });

  it('does not let high-ranked clock-only clusters hide an independent event behind the push cap', async () => {
    const clocks = ['a', 'b'].map(id => clockFact('asset', { ref: { collection: 'asset', id, field: 'rules.renew' }, title: `Clock ${id}` }));
    const event = fact('independent', { title: 'Independent event', when: { from: monday, to: monday + 3_600_000 }, act_by: monday });
    const f = fixture([...clocks, event]); dayOfOnly(f);
    await f.service().tick(); expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0]?.[0].text).toContain('Independent event');
  });

  it('retains an independent reason inside a cluster crowded by higher-ranked clocks', async () => {
    const clocks = ['a', 'b', 'c'].map(id => clockFact('asset', { ref: { collection: 'asset', id, field: 'rules.renew' },
      title: `Clock ${id}`, subjects: [{ collection: 'asset', id: 'home' }] }));
    const f = fixture([...clocks, dueTrip(clocks[0]!)]); dayOfOnly(f);
    await f.service().tick(); expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0]?.[0].text).toContain('Lisbon trip starts today');
    expect(f.send.mock.calls[0]?.[0].text).toContain('Clock ');
  });

  it('applies dismissed reasons before the query cap so another event can use the slot', async () => {
    const clocks = ['a', 'b'].map(id => clockFact('asset', { ref: { collection: 'asset', id, field: 'rules.renew' }, title: `Clock ${id}` }));
    const trip = dueTrip(clocks[0]!); const event = fact('independent', { title: 'Independent event',
      when: { from: monday, to: monday + 3_600_000 }, act_by: monday });
    const f = fixture([...clocks, trip, event]); dayOfOnly(f);
    createSituationDismissalStore(f.db).dismiss({ key: situationItemKey(trip.ref), scope: 'item', code: 'not_now',
      label: trip.title, ref: trip.ref, kind: trip.kind, until: monday + 3_600_000, at: monday });
    await f.service().tick(); expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0]?.[0].text).toContain('Independent event');
    expect(f.send.mock.calls[0]?.[0].text).not.toContain(trip.title);
  });

  it.each(['action', 'notice'] as const)('keeps real %s clock materialization and native source projection outside the extra day-of push', async occurrence => {
    const f = fixture([], 'UTC', true);
    const rule: AssetRule = { id: 'renew', title: 'Renew passport', enabled: true, muted: false, pinned: false,
      consequence: 'floor', expiry_policy: 'escalate_overdue', when: { kind: 'expiry', field: 'expires_on' },
      reaction: { notify: true, occurrence, emit: false }, schedule: { before: [], on_day: true } };
    f.work.writeAsset({ source_id: 'recued.asset', source: { kind: 'owner', ref: 'fixture' }, name: 'Passport',
      dates: { expires_on: '2026-10-19' }, rules: [rule] }, monday);
    const clocks = createAssetOccurrenceService({ db: f.db, work: f.work,
      dispatchers: createWorkEntityDispatchers({ store: f.work, resolver: createWorkEntityResolver(f.work) }),
      timeZone: () => 'UTC', now: () => monday });
    await clocks.tick(); dayOfOnly(f);
    const items = (await f.service().today({ now: monday, before: monday + 86_400_000 })).situations.clusters.flatMap(cluster => cluster.items);
    expect(items).toHaveLength(1);
    expect(items[0]?.ref.collection).toBe(occurrence === 'action' ? 'commitment' : 'asset');
    await f.service().tick(); expect(f.send).not.toHaveBeenCalled();
    await f.service().sendNow(); expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0]?.[0].text).toContain('Renew passport');
  });

  it.each(['action', 'notice'] as const)('keeps a sensitive asset’s name and dates out of the brief, as its own %s reminder does', async occurrence => {
    const f = fixture([], 'UTC', true);
    const rule: AssetRule = { id: 'renew', title: 'Renew passport', enabled: true, muted: false, pinned: false,
      consequence: 'floor', expiry_policy: 'escalate_overdue', when: { kind: 'expiry', field: 'expires_on' },
      reaction: { notify: true, occurrence, emit: false }, schedule: { before: [], on_day: true } };
    f.work.writeAsset({ source_id: 'recued.asset', source: { kind: 'owner', ref: 'fixture' }, name: 'Ana’s passport', class_id: 'passport',
      settings: { sensitive: true }, dates: { expires_on: '2026-10-19' }, rules: [rule] }, monday);
    await createAssetOccurrenceService({ db: f.db, work: f.work, dispatchers: createWorkEntityDispatchers({ store: f.work, resolver: createWorkEntityResolver(f.work) }),
      timeZone: () => 'UTC', now: () => monday }).tick();
    await f.service().sendNow(); expect(f.send).toHaveBeenCalledTimes(1);
    const text = f.send.mock.calls[0]![0].text;
    expect(text).not.toContain('Ana’s passport'); expect(text).not.toContain('2026-10-19');
    expect(text).toContain('Private reminder');
    // Today, inside the app, still names it.
    const today = (await f.service().today({ now: monday, before: monday + 86_400_000 })).situations.clusters.flatMap(cluster => cluster.items);
    expect(JSON.stringify(today)).toContain('Ana’s passport');
  });
  it('marks a renewal in Today, and one acknowledged stays out until its next reminder is sent, still open (§15.7, 2026-10-24)', async () => {
    const f = fixture([], 'UTC', true);
    const rule: AssetRule = { id: 'renew', title: 'Renew passport', enabled: true, muted: false, pinned: false,
      consequence: 'floor', expiry_policy: 'escalate_overdue', when: { kind: 'expiry', field: 'expires_on' },
      reaction: { notify: true, occurrence: 'action', emit: false }, schedule: { before: [], on_day: true } };
    f.work.writeAsset({ source_id: 'recued.asset', source: { kind: 'owner', ref: 'fixture' }, name: 'Passport', settings: { class_rule_ids: ['renew'] },
      dates: { expires_on: '2026-10-19' }, rules: [rule] }, monday);
    await createAssetOccurrenceService({ db: f.db, work: f.work, dispatchers: createWorkEntityDispatchers({ store: f.work, resolver: createWorkEntityResolver(f.work) }),
      timeZone: () => 'UTC', now: () => monday }).tick();
    const today = async () => (await f.service().today({ now: monday, before: monday + 86_400_000 })).occurrences;
    const [renewal] = await today(); const points = createOccurrenceReminderStore(f.db);
    expect(renewal).toMatchObject({ renewal: { field: 'expires_on', current: '2026-10-19' } }); expect(renewal!.acknowledged).toBeUndefined();
    // As the reminder service records the reminder it sent.
    const sent = (on: string) => f.db.prepare(`INSERT INTO occurrence_reminder_controls(occurrence_id,last_notified_on) VALUES(?,?)
      ON CONFLICT(occurrence_id) DO UPDATE SET last_notified_on=excluded.last_notified_on`).run(renewal!.id, on);
    sent('2026-10-19'); points.acknowledge(renewal!.id, monday);
    expect((await today())[0]).toMatchObject({ acknowledged: true, commitment: { lifecycle_state: 'pending' } });
    sent('2026-11-19');
    expect((await today())[0]!.acknowledged).toBeUndefined();
  });
  it('names in a brief nothing an item’s own reminder keeps private: an occasion with people, a cited visa, a summary, an anchor', async () => {
    const day = 86_400_000; const f = fixture([]);
    const history = createProactiveHistoryStore(f.db, createProactiveProposalStore(f.db));
    const birthday = history.saveOccasion({ title: 'Ana’s birthday', month_day: '10-21', people: ['ana'], muted: false, rules: [], sphere: 'personal' }, monday);
    const opening = history.saveOccasion({ title: 'Shop opening', month_day: '10-22', people: [], muted: false, rules: [], sphere: 'personal' }, monday);
    const visa = f.work.writeAsset({ source_id: 'recued.asset', source: { kind: 'owner', ref: 'fixture' }, name: 'Ana’s Japan visa', class_id: 'visa',
      settings: { sensitive: true }, dates: {}, rules: [] }, monday);
    const occasion = (id: string, title: string, from: number, patch: Partial<SituationFact> = {}) => fact(id, { ref: { collection: 'occasion', id, field: 'rules.date' },
      kind: 'occasion', title, when: { from, to: from }, act_by: from, evidence: [{ collection: 'occasion', id }], ...patch });
    f.facts([
      occasion(birthday.id, 'Ana’s birthday', monday + 2 * day, { people: ['ana'], related: [{ collection: 'asset', id: 'flowers' }] }),
      fact('flowers', { ref: { collection: 'asset', id: 'flowers' }, kind: 'asset_rule', title: 'Order flowers', when: { from: monday - 3 * day, to: monday - 3 * day },
        act_by: monday + 70 * day, evidence: [{ collection: 'asset', id: 'flowers' }] }),
      occasion(opening.id, 'Shop opening', monday + 3 * day),
      fact('trip', { ref: { collection: 'booking', id: 'trip', field: 'trip_document:ana' }, kind: 'travel_validity', when: { from: monday + 4 * day, to: monday + 5 * day },
        title: 'Tokyo trip · visas on file: Ana’s Japan visa (valid for JP)', evidence: [{ collection: 'booking', id: 'trip' }, { collection: 'asset', id: visa.id }] }),
    ]);
    f.summary(async (cluster: { items: Array<{ what: { value: string | null } }> }) => `Summary: ${cluster.items.map(item => item.what.value).join(', ')}`);
    await f.service().tick(); expect(f.send).toHaveBeenCalledTimes(1);
    const lines = f.send.mock.calls[0]![0].text.split('\n');
    expect(lines.join('\n')).not.toMatch(/Ana’s|Tokyo trip/u);
    expect(lines.filter(line => line === 'Private reminder · open Today for the details')).toHaveLength(2);
    expect(lines).toContain('Order flowers · 2026-10-16 · shortly before a private reminder');
    // The rest is named as before, its group's summary included.
    expect(lines).toEqual(expect.arrayContaining(['Shop opening · 2026-10-22', 'Summary: Shop opening']));
  });
  it('keeps the commitment of a sensitive asset, or of an occasion with people, private when it comes without the clock that cites it', async () => {
    const f = fixture([]);
    const rule: AssetRule = { id: 'renew', title: 'Renew passport', enabled: true, muted: false, pinned: false,
      consequence: 'floor', expiry_policy: 'escalate_overdue', when: { kind: 'expiry', field: 'expires_on' },
      reaction: { notify: true, occurrence: 'action', emit: false }, schedule: { before: [], on_day: true } };
    const passport = f.work.writeAsset({ source_id: 'recued.asset', source: { kind: 'owner', ref: 'fixture' }, name: 'Ana’s passport', class_id: 'passport',
      settings: { sensitive: true }, dates: { expires_on: '2026-10-19' }, rules: [rule] }, monday);
    await createAssetOccurrenceService({ db: f.db, work: f.work, dispatchers: createWorkEntityDispatchers({ store: f.work, resolver: createWorkEntityResolver(f.work) }),
      timeZone: () => 'UTC', now: () => monday }).tick();
    const rows = createAssetOccurrenceStore(f.db); const commitment = rows.byAsset(passport.id)[0]!.commitment_id!;
    const birthday = createProactiveHistoryStore(f.db, createProactiveProposalStore(f.db)).saveOccasion({ title: 'Ana’s birthday', month_day: '10-21',
      people: ['ana'], muted: false, rules: [], sphere: 'personal' }, monday);
    rows.ensure({ id: 'gift', asset_id: birthday.id, subject_kind: 'occasion', rule_id: 'date', cycle: '2026-10-21', commitment_id: 'gift-commitment',
      question: false, trigger_kind: 'rule', created_at: monday });
    // Read on its own, a commitment cites only itself.
    const alone = (id: string, title: string) => fact(id, { ref: { collection: 'commitment', id }, kind: 'commitment', title, evidence: [{ collection: 'commitment', id }] });
    f.facts([alone(commitment, 'Renew passport · Ana’s passport'), alone('gift-commitment', 'Buy a gift for Ana’s birthday')]);
    await f.service().tick();
    const text = f.send.mock.calls[0]![0].text;
    expect(text.split('\n').filter(line => line === 'Private reminder · open Today for the details')).toHaveLength(2); expect(text).not.toContain('Ana’s');
  });
  it('says a resolution is private where its item’s own reminder would be, though its record is gone', async () => {
    const f = fixture([]);
    const history = createProactiveHistoryStore(f.db, createProactiveProposalStore(f.db));
    const birthday = history.saveOccasion({ title: 'Ana’s birthday', month_day: '10-21', people: ['ana'], muted: false, rules: [], sphere: 'personal' }, monday);
    const passport = f.work.writeAsset({ source_id: 'recued.asset', source: { kind: 'owner', ref: 'fixture' }, name: 'Ana’s passport', class_id: 'passport',
      settings: { sensitive: true }, dates: {}, rules: [] }, monday);
    f.facts([clockFact('asset', { ref: { collection: 'asset', id: passport.id, field: 'rules.renew' }, title: 'Renew · Ana’s passport', evidence: [{ collection: 'asset', id: passport.id }] }),
      clockFact('occasion', { ref: { collection: 'occasion', id: birthday.id, field: 'rules.date' }, title: 'Ana’s birthday', evidence: [{ collection: 'occasion', id: birthday.id }] })]);
    const clusters = (await f.query({ time: { from: monday, to: monday + 7 * 86_400_000 } }, { owner: true,
      grants: { isVerbOpGranted: () => true, isCollectionReadGranted: () => true, isTopicReadGranted: () => true } })).clusters;
    expect(clusters).toHaveLength(2);
    for (const cluster of clusters) f.store.save({ id: cluster.id, state: 'resolved', cluster: { ...cluster, span: null }, urgency: 'routine' }, { source: 'done' }, monday);
    history.deleteOccasion(birthday.id);
    f.facts([]); await f.service().tick();
    const text = f.send.mock.calls[0]![0].text;
    expect(text.split('\n').filter(line => line === 'Resolved · a private reminder')).toHaveLength(2);
    expect(text).not.toContain('Ana’s');
  });
  it.each(['asset', 'occasion'])('leaves a lone %s clock to its own reminder schedule, without spending the push budget', async collection => {
    const clock = clockFact(collection); const f = fixture([clock]); dayOfOnly(f);
    await f.service().tick(); await f.restart(); await f.service().tick();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.db.prepare('SELECT * FROM scheduled_situation_attempts').all()).toEqual([]);
    expect(f.db.prepare('SELECT * FROM scheduled_situation_seen').all()).toEqual([]);
    const today = await f.service().today({ now: monday, before: monday + 86_400_000 });
    expect(today.situations.clusters.flatMap(cluster => cluster.items).map(item => item.what.value)).toContain('Renew passport');
    await f.service().sendNow();
    expect(f.send).toHaveBeenCalledTimes(1); expect(f.send.mock.calls[0]?.[0].text).toContain('Renew passport');
  });

  it.each(['asset', 'occasion'])('recognizes the canonical commitment after a %s clock is deduplicated by the shared query', async collection => {
    const f = fixture([]); const commitment = obligation(f, 'rule_emitted');
    const clock = clockFact(collection, { represents: { collection: 'commitment', id: commitment.id } });
    f.facts([clock, fact(commitment.id, { ref: { collection: 'commitment', id: commitment.id }, kind: 'commitment',
      title: commitment.statement, when: clock.when, act_by: monday })]); dayOfOnly(f);
    const items = (await f.service().today({ now: monday, before: monday + 86_400_000 })).situations.clusters.flatMap(cluster => cluster.items);
    expect(items).toHaveLength(1); expect(items[0]?.ref).toEqual({ collection: 'commitment', id: commitment.id });
    await f.service().tick(); expect(f.send).not.toHaveBeenCalled();
  });

  it('keeps an ordinary commitment with the same wording as a separate obligation', async () => {
    const f = fixture([]); const commitment = obligation(f, 'user_declared'); const clock = clockFact();
    f.facts([clock, fact(commitment.id, { ref: { collection: 'commitment', id: commitment.id }, kind: 'commitment',
      title: commitment.statement, when: clock.when, act_by: monday, related: [clock.ref] })]); dayOfOnly(f);
    await f.service().tick(); expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0]?.[0].text).toContain('Renew passport');
  });

  it('adds the clock as context when a related trip has its own day-of reason', async () => {
    const clock = clockFact(); const f = fixture([clock, dueTrip(clock)]); dayOfOnly(f);
    await f.service().tick(); expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0]?.[0].text).toContain('Lisbon trip starts today');
    expect(f.send.mock.calls[0]?.[0].text).toContain('Renew passport');
  });

  it('keeps a clock and passive related asset in Today without making another push', async () => {
    const clock = clockFact(); const f = fixture([clock, fact('home', { ref: { collection: 'asset', id: 'home' }, kind: 'asset',
      title: 'Main house', when: undefined, act_by: undefined, related: [clock.ref] })]); dayOfOnly(f);
    const items = (await f.service().today({ now: monday, before: monday + 86_400_000 })).situations.clusters.flatMap(cluster => cluster.items);
    expect(items.map(item => item.what.value)).toEqual(expect.arrayContaining(['Main house', 'Renew passport']));
    await f.service().tick(); expect(f.send).not.toHaveBeenCalled();
  });

  it('preserves a distinct derived validity check even when its related clock already owns reminders', async () => {
    const clock = clockFact(); const f = fixture([clock, fact('passport', {
      ref: { collection: 'asset', id: 'passport', field: 'trip_validity:booking:trip' }, kind: 'travel_validity', basis: 'derived',
      title: 'Passport validity needs review', when: undefined, act_by: undefined, related: [clock.ref], consequence: 'floor',
    })]); dayOfOnly(f);
    await f.service().tick(); expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0]?.[0].text).toContain('Passport validity needs review');
  });

  it('keeps a distinct check on a field of the same canonical obligation', async () => {
    const f = fixture([]); const commitment = obligation(f, 'rule_emitted'); const clock = clockFact();
    f.facts([clock, fact(commitment.id, { ref: { collection: 'commitment', id: commitment.id, field: 'checks.trip_validity' },
      kind: 'travel_validity', basis: 'derived', title: 'Passport check for this trip', when: undefined, act_by: undefined, related: [clock.ref] })]); dayOfOnly(f);
    await f.service().tick(); expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0]?.[0].text).toContain('Passport check for this trip');
  });

  it('rechecks commitment reminder ownership after an awaited summary', async () => {
    const f = fixture([]); const commitment = obligation(f, 'user_declared');
    f.facts([fact(commitment.id, { ref: { collection: 'commitment', id: commitment.id }, kind: 'commitment',
      title: commitment.statement, when: { from: monday, to: monday }, act_by: monday })]); dayOfOnly(f);
    f.summary(async () => { f.work.writeCommitment({ ...commitment, derivation: 'rule_emitted' }, monday + 1); return 'Renew passport'; });
    await f.service().tick(); expect(f.send).not.toHaveBeenCalled();
    expect(f.db.prepare('SELECT * FROM scheduled_situation_attempts').all()).toEqual([]);
  });

  it('reconciles a known failed day-of delivery when only the clock remains', async () => {
    const clock = clockFact(); const f = fixture([clock, dueTrip(clock)]); dayOfOnly(f); f.fail(true);
    await f.service().tick(); expect(f.send).toHaveBeenCalledTimes(1); expect(f.service().status().pending).toBe(1);
    f.facts([clock]); f.fail(false); await f.service().tick();
    expect(f.send).toHaveBeenCalledTimes(1); expect(f.service().status().pending).toBe(0);
    expect(f.service().status().last_run?.state).toBe('skipped');
  });
});

describe('D-325 overview retention', () => {
  it('keeps what Settings shows and an uncertain send not yet followed by one, and drops the rest of the history', async () => {
    const f = fixture([]); const day = 86_400_000; f.service().setSettings({ frequency: 'daily', day_of: false });
    const on = (d: number, hours = 0) => monday + d * day + hours * 3_600_000;
    // A bill, not a trip: nothing resolves by itself, so no send comes unasked.
    const bill = (d: number) => fact('bill', { ref: { collection: 'commitment', id: 'bill' }, kind: 'commitment', title: `Pay invoice ${d}`,
      when: { from: on(d) + day, to: on(d) + day }, act_by: on(d) + day, evidence: [{ collection: 'commitment', id: 'bill' }], updated_at: on(d) });
    const tick = async (d: number, hours = 0) => { f.time(on(d, hours)); await f.service().tick(); };
    const uncertain = async (d: number) => {
      f.facts([bill(d)]); f.send.mockRejectedValueOnce(new Error('timeout')).mockRejectedValueOnce(new Error('timeout'));
      await tick(d); await tick(d, 1); await tick(d + 1);
    };
    f.facts([bill(0)]); await tick(0);
    await uncertain(2);
    f.summary(async () => 'One payment this week'); f.facts([bill(4)]); await tick(4); f.summary(undefined);
    await uncertain(6);
    f.facts([]); for (let d = 8; d <= 46; d++) await tick(d);
    // A run still to retry stays however old it is.
    f.db.prepare("INSERT INTO scheduled_situation_runs(id,mode,day,at,state) VALUES('overview:2026-10-20','overview','2026-10-20',?,'pending')").run(on(1));
    const settings = f.service().status();
    expect(settings).toMatchObject({ pending: 1, uncertain: 2, last_run: { state: 'skipped' }, last_sent: { text: expect.stringContaining('Pay invoice 4') } });

    // Resolved long ago, the bill's situation goes, and what the overview kept about it with it.
    const situation = f.store.list()[0]!;
    f.store.save({ ...situation.snapshot, state: 'resolved' }, { source: 'paid' }, on(8));
    const before = on(46) - 30 * day;
    expect(f.store.prune({ before, subscribers: [] }).situations).toBe(1);
    // Its sent fingerprint, summary and listing.
    expect(f.service().prune(before)).toMatchObject({ overview_clusters: 0, overview_cached: 3 });
    expect(f.service().status()).toEqual({ ...settings, uncertain: 1 });
    expect(f.db.prepare('SELECT id,state FROM scheduled_situation_runs WHERE at<? ORDER BY at').all(before)).toEqual([
      { id: 'overview:2026-10-20', state: 'pending' }, { id: 'overview:2026-10-23', state: 'sent' }, { id: 'overview:2026-10-25', state: 'uncertain' }]);
    expect(f.db.prepare('SELECT count(*) AS n FROM scheduled_situation_attempts').get()).toEqual({ n: 0 });
  });

  it('drops a cluster it has not listed for 30 days, keeps one it still lists, and shows one that comes back as new', async () => {
    const f = fixture([]); const day = 86_400_000; f.service().setSettings({ frequency: 'daily', day_of: false });
    const on = (d: number) => monday + d * day;
    const item = (id: string, title: string, due: number) => fact(id, { ref: { collection: 'commitment', id }, kind: 'commitment', title,
      when: { from: due, to: due }, act_by: due, evidence: [{ collection: 'commitment', id }], updated_at: monday });
    // The deposit form is overdue and open, so every run lists it; the call is made and the
    // parcel collected in the first week.
    const deposit = item('deposit', 'Return the deposit form', on(-1));
    f.facts([deposit, item('call', 'Call the plumber', on(2)), item('parcel', 'Collect the parcel', on(3))]);
    for (let d = 0; d <= 6; d++) { f.time(on(d)); await f.service().tick(); }
    const clusterOf = (ref: string) => f.store.list(1000).find(row => row.snapshot.cluster.items.some(entry => entry.ref.id === ref))!.snapshot.id;
    const call = clusterOf('call'); const kept = clusterOf('deposit'); const parcel = clusterOf('parcel');
    const unchanged = f.store.get(kept)!.revision;
    f.facts([deposit]);
    for (let d = 7; d <= 40; d++) { f.time(on(d)); await f.service().tick(); }
    // Resolved yesterday, the parcel's cluster carries an answer of its own: only new ones go.
    f.store.save({ ...f.store.get(parcel)!.snapshot, state: 'resolved' }, { source: 'collected' }, on(39));

    // The call's fingerprint and listing go with it; nothing was summarized.
    expect(f.service().prune(on(40) - 30 * day)).toMatchObject({ overview_clusters: 1, overview_cached: 2 });
    expect(f.store.get(call)).toBeNull(); expect(f.store.get(parcel)?.snapshot.state).toBe('resolved');
    // Unchanged since the first week, the deposit stays because the overview still lists it.
    expect(f.store.get(kept)).toMatchObject({ snapshot: { state: 'new' }, revision: unchanged });
    expect(f.db.prepare('SELECT id FROM scheduled_situation_seen ORDER BY id').all()).toEqual([{ id: kept }, { id: parcel }].sort((a, b) => a.id.localeCompare(b.id)));
    expect(f.db.prepare('SELECT id FROM scheduled_situation_listed ORDER BY id').all()).toEqual([{ id: kept }, { id: parcel }].sort((a, b) => a.id.localeCompare(b.id)));

    const sent = f.send.mock.calls.length;
    f.facts([deposit, item('call', 'Call the plumber', on(42))]); f.time(on(41)); await f.service().tick();
    expect(f.send).toHaveBeenCalledTimes(sent + 1); expect(f.send.mock.calls.at(-1)![0].text).toContain('Call the plumber');
    expect(f.store.get(call)?.snapshot.state).toBe('new');
  });

  it('walks only its own clusters, and still resolves an ended trip', async () => {
    const f = fixture(); await f.service().tick();
    const trip = f.store.list()[0]!.snapshot;
    // Another producer's situations, ended trips too, sort before and after the overview's own.
    for (const id of ['occurrence-ended', 'zz-ended']) f.store.save({ ...trip, id, cluster: { ...trip.cluster, id } }, { source: 'elsewhere' }, monday);
    f.time(monday + 3 * 86_400_000); await f.service().tick();
    expect(f.store.get(trip.id)?.snapshot.state).toBe('resolved');
    expect(f.store.get('occurrence-ended')?.snapshot.state).toBe('new');
    expect(f.store.get('zz-ended')?.snapshot.state).toBe('new');
  });

  it('counts a cluster saved before listings were recorded as listed when they began', async () => {
    const f = fixture([]); const day = 86_400_000;
    f.db.exec('DROP TABLE scheduled_situation_listed');
    const old = (id: string) => f.store.save({ id, state: 'new', urgency: 'routine', cluster: { id, subjects: [], span: null, omitted: 0, items: [] } },
      { source: 'scheduled-situations' }, monday - 90 * day);
    old('situation-legacy'); old('occurrence-legacy');
    await f.restart();
    expect(f.service().prune(monday - day).overview_clusters).toBe(0);
    expect(f.service().prune(monday + day).overview_clusters).toBe(1);
    // Another producer's situation is not the overview's to drop.
    expect(f.store.get('occurrence-legacy')?.snapshot.state).toBe('new');
  });
});

/** ⛔ A drain step awaits the stop (and the minute timer awaits its tick) with
 *  5 s, while a run sends through every channel — 30 s a messenger, longer an
 *  email. The stop must not wait for the send, and the send must not be lost. */
describe('D-325 scheduled overview — stopping', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('a stop waits no longer than the grace for a send, and the send cut short is repeated once after the restart', async () => {
    const f = fixture();
    // A channel that never answers.
    f.send.mockImplementationOnce(() => new Promise(() => {}));
    const ticking = f.service().tick();
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
    // The run was marked `sending`, its attempt counted, before the send.
    expect(f.service().status()).toMatchObject({ pending: 1, last_run: { mode: 'overview', state: 'sending' } });

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let stopped = false;
    let ticked = false;
    const stopping = f.service().stop().then(() => { stopped = true; });
    void ticking.then(() => { ticked = true; });
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS);
    for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stopped).toBe(true);
    // The minute timer's tick is released too: the registry waits for it in
    // the same drain step.
    expect(ticked).toBe(true);
    await stopping;
    // A stopped service sends nothing more.
    await f.service().tick();
    expect(f.send).toHaveBeenCalledTimes(1);

    // The restart stops the old service again (the send is still held), then starts anew.
    const restarting = f.restart();
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS);
    await restarting;
    vi.useRealTimers();
    await f.service().tick();
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send.mock.calls[1]?.[0].text).toContain('Repeating once because the previous delivery could not be confirmed.');
    expect(f.service().status().last_sent).toMatchObject({ mode: 'overview' });
  });
});

describe('the Digest\'s mailbox lines', () => {
  const now = Date.parse('2026-10-26T12:00:00Z');
  const box = (slug: string, over: Record<string, unknown> = {}, health: Record<string, unknown> = {}) => ({
    platform: 'mail', slug, ...over,
    health: () => ({ platform: 'mail', slug, last_indexed_at: now - 60_000, pending_queue_size: 0, error_count_24h: 0, state: 'idle', ...health }),
  });

  it('⛔ leaves out an SMTP-only account: it syncs nothing, so it is never "not synced yet"', () => {
    // Listed, a send-only account read "mail has not synced yet · needs attention" every day.
    expect(mailboxHealthOf([
      box('home'),
      box('behind', {}, { last_indexed_at: now - 3 * 86_400_000 }),
      box('mailgun', { receiveCapable: false }, { last_indexed_at: 0 }),
      box('calendar', { platform: 'calendar' }),
    ] as never, now)).toEqual([
      { name: 'home', last_success_at: now - 60_000, needs_attention: false },
      { name: 'behind', last_success_at: now - 3 * 86_400_000, needs_attention: true },
    ]);
  });

  it('keeps a mailbox that has not synced yet, or whose sends fail, and says it needs attention', () => {
    expect(mailboxHealthOf([
      box('new', { receiveCapable: true }, { last_indexed_at: 0 }),
      box('failing', {}, { error_count_24h: 2 }),
    ] as never, now).map(row => [row.name, row.needs_attention])).toEqual([['new', true], ['failing', true]]);
  });
});
