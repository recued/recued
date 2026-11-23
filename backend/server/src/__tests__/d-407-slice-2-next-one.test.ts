/** D-407 slice 2 (D-407 §4, §8, §10.5 U3) — an occasion that comes back whenever the last one says (a
 *  doctor, a dentist): `Occasion.after_each`. Once its date is past and no next one is set, Recued asks "When is the next
 *  one?": in Today (`occasions_waiting`, with its answer), on the occasion's page, in the day's messages and to the AI
 *  (a situation item, private when the occasion is), and in chat (`work.update` `on`, or `no_next`). One answer sets the
 *  next (`occasion.next`); "No next one" ends it.
 *
 *  Through the real stores and services: the occasion store, the Yours service, the situation sources, query and
 *  scheduled situations, and the chat's handlers. The app's answers are checked in a browser (the commit says how). */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { occasionTimeOn, occasionWaitingForNext, type AssetRule, type ExecutionSource, type OccasionInput, type SituationItem } from '@recued/contracts';

import { buildChatTier1Handlers, checkWorkUpdate, type ChatOccasions, type ChatToolHandlerDeps } from '../chat-tool-handlers.js';
import type { NotificationSendArgs } from '../notification-handler.js';
import { createAssetOccurrenceService } from '../situations/asset-occurrence-service.js';
import { createSituationAccess } from '../situations/access.js';
import { situationItemForModel } from '../situations/model-projection.js';
import { createSituationQuery } from '../situations/query.js';
import { createScheduledSituations } from '../situations/scheduled-situations.js';
import { buildSituationSources, OCCASION_NEXT_KIND } from '../situations/sources.js';
import { createYoursService } from '../situations/yours-service.js';
import { createAnnotationStore } from '../storage/annotation-store.js';
import { createBlobStore } from '../storage/blob-store.js';
import { createContactStore } from '../storage/contact-store.js';
import { createContractStore } from '../storage/contract-store.js';
import { createProactiveHistoryStore } from '../storage/proactive-history-store.js';
import { createProactiveProposalStore } from '../storage/proactive-proposal-store.js';
import { createReminderStore } from '../storage/reminder-store.js';
import { createSituationStore } from '../storage/situation-store.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const owner: ExecutionSource = { channel: 'user', actor: 'user_self', user_id: 'owner', client_token_id: 'paired' };
const chatOwner: ExecutionSource = { channel: 'chat', actor: 'user_self', chat_session_id: 'chat-1', user_id: 'user-1' };
const inChat = { channel: 'internal_function_call', session_id: 'sess-1', execution_source: chatOwner, time_zone: 'UTC' } as never;
const approved = { channel: 'internal_function_call', session_id: 'sess-1', execution_source: chatOwner, owner_approved: true, time_zone: 'UTC' } as never;
// Thursday 19 November 2026, 20:00 UTC: Dr. Lee was on Tuesday the 17th.
const NOW = Date.parse('2026-11-19T20:00:00Z');
/** The date rule the chat gives an occasion: a reminder on the day. */
const onTheDay: AssetRule = { id: 'date', title: 'Dr. Lee', enabled: true, muted: false, pinned: false, consequence: 'routine', expiry_policy: 'strict_expire',
  when: { kind: 'expiry', field: 'next_on' }, reaction: { notify: true, occurrence: 'notice', emit: false }, schedule: { before: [], on_day: true } };
const doctor = (patch: Partial<OccasionInput> = {}): OccasionInput => ({ title: 'Dr. Lee', month_day: '11-17', source_next_on: '2026-11-17', after_each: true,
  people: [], muted: false, rules: [], private: true, ...patch });

describe('D-407 slice 2 — when an occasion waits for its next one', () => {
  it('after its date, with no next one, and only when it comes back whenever the last one says', () => {
    expect(occasionWaitingForNext(doctor(), '2026-11-18')).toBe('2026-11-17');
    expect(occasionWaitingForNext(doctor(), '2026-11-17')).toBeUndefined();
    expect(occasionWaitingForNext(doctor({ source_next_on: '2027-05-18' }), '2026-11-18')).toBeUndefined();
    expect(occasionWaitingForNext({ ...doctor(), after_each: undefined }, '2026-11-18')).toBeUndefined();
    // An older server stored what a client sent, unchecked.
    expect(occasionWaitingForNext({ ...doctor(), after_each: 'yes' as never }, '2026-11-18')).toBeUndefined();
  });

  it('a time of day is on the zone it was kept on: 10:30 in Chicago is 16:30 UTC in November', () => {
    expect(occasionTimeOn({ time: '10:30', time_zone: 'America/Chicago' }, '2026-11-17')).toBe(Date.parse('2026-11-17T16:30:00Z'));
    expect(occasionTimeOn({ time: '10:30', time_zone: 'America/Chicago' }, '2026-07-17')).toBe(Date.parse('2026-07-17T15:30:00Z'));
    expect(occasionTimeOn({}, '2026-11-17')).toBeUndefined();
    // What an older server stored unchecked reads as no time.
    expect(occasionTimeOn({ time: '25:00', time_zone: 'UTC' }, '2026-11-17')).toBeUndefined();
    expect(occasionTimeOn({ time: '10:30', time_zone: 'Mars/Olympus' }, '2026-11-17')).toBeUndefined();
  });

  it('the store keeps a time only with a zone that reads', () => {
    const db = new Database(':memory:'); cleanups.push(() => { db.close(); });
    const history = createProactiveHistoryStore(db, createProactiveProposalStore(db));
    expect(history.saveOccasion(doctor({ time: '10:30', time_zone: 'America/Chicago' }), NOW)).toMatchObject({ time: '10:30', time_zone: 'America/Chicago' });
    for (const bad of [{ time: '10:30' }, { time_zone: 'UTC' }, { time: '9:30', time_zone: 'UTC' }, { time: '10:30', time_zone: 'Mars/Olympus' }]) {
      expect(() => history.saveOccasion(doctor(bad), NOW), JSON.stringify(bad)).toThrow('Invalid occasion time');
    }
  });

  it('the store keeps it only for an owner\'s occasion with a next date', () => {
    const db = new Database(':memory:'); cleanups.push(() => { db.close(); });
    const history = createProactiveHistoryStore(db, createProactiveProposalStore(db));
    expect(history.saveOccasion(doctor(), NOW).after_each).toBe(true);
    for (const bad of [{ after_each: false as never }, { source_next_on: undefined }, { source_next_on: null },
      { source: { collection: 'calendar', id: 'personal:x' } }]) {
      expect(() => history.saveOccasion(doctor(bad), NOW), JSON.stringify(bad)).toThrow('Invalid occasion repeat');
    }
  });
});

/** Yours as the composition root wires it. */
const yours = (zone = 'UTC') => {
  const db = new Database(':memory:'); ensureWorkEntitySchema(db);
  const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  let occurrences: ReturnType<typeof createAssetOccurrenceService>;
  const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work),
    onAssetChanged: async asset => { await occurrences.reconcileAsset(asset.id); }, onAssetDeleted: async asset => { await occurrences.retireAsset(asset.id); } });
  occurrences = createAssetOccurrenceService({ db, work, dispatchers, timeZone: () => 'UTC' });
  const dir = mkdtempSync(join(tmpdir(), 'd407-s2-'));
  const annotations = createAnnotationStore({ db, blobs: createBlobStore(join(dir, 'blobs')) });
  const service = createYoursService({ db, work, dispatchers, occurrences, annotations, situations: createSituationStore(db), isVaultUnlocked: () => true,
    timeZone: () => zone, now: () => NOW } as never);
  cleanups.push(async () => { await service.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { db, service, history: createProactiveHistoryStore(db, createProactiveProposalStore(db)), proposals: createProactiveProposalStore(db) };
};

describe('D-407 slice 2 — "When is the next one?" answered through Yours', () => {
  it('the snapshot says this server asks it; a date sets the next one; "No next one" ends it, keeping its last date', async () => {
    const f = yours();
    const { id } = await f.service.command({ action: 'occasion.save', occasion: doctor() }, owner);
    expect((await f.service.snapshot({})).occasion_next).toBe(true);
    await expect(f.service.command({ action: 'occasion.next', id: id!, on: '2026-11-18' }, owner)).rejects.toThrow('Choose 2026-11-19 or a later date');
    expect(await f.service.command({ action: 'occasion.next', id: id!, on: '2027-05-18' }, owner)).toMatchObject({ message: 'Next one saved: 2027-05-18.' });
    expect(f.history.occasion(id!)).toMatchObject({ source_next_on: '2027-05-18', month_day: '05-18', after_each: true });
    expect(await f.service.command({ action: 'occasion.next', id: id!, on: null }, owner)).toMatchObject({ message: 'No next one: it keeps its last date.' });
    const ended = f.history.occasion(id!)!;
    expect(ended).not.toHaveProperty('after_each'); expect(ended.source_next_on).toBe('2027-05-18');
    await expect(f.service.command({ action: 'occasion.next', id: id!, on: '2027-11-18' }, owner)).rejects.toThrow('This occasion does not ask for its next date');
  });

  it('the answer takes its time of day, on the owner\'s zone unless it has its own; `null` makes it a day again', async () => {
    const f = yours();
    const { id } = await f.service.command({ action: 'occasion.save', occasion: doctor() }, owner);
    await expect(f.service.command({ action: 'occasion.next', id: id!, on: '2027-05-18', time: '9:5' }, owner)).rejects.toThrow('Choose a time as HH:mm');
    expect(await f.service.command({ action: 'occasion.next', id: id!, on: '2027-05-18', time: '10:30' }, owner)).toMatchObject({ message: 'Next one saved: 2027-05-18 at 10:30.' });
    expect(f.history.occasion(id!)).toMatchObject({ time: '10:30', time_zone: 'UTC' });
    const { id: away } = await f.service.command({ action: 'occasion.save', occasion: doctor({ title: 'Clinic in Chicago', time: '08:00', time_zone: 'America/Chicago' }) }, owner);
    await f.service.command({ action: 'occasion.next', id: away!, on: '2027-05-18', time: '09:15' }, owner);
    expect(f.history.occasion(away!)).toMatchObject({ time: '09:15', time_zone: 'America/Chicago' });
    await f.service.command({ action: 'occasion.next', id: away!, on: '2027-05-19', time: null }, owner);
    expect(f.history.occasion(away!)).not.toHaveProperty('time');
    expect(f.history.occasion(away!)).not.toHaveProperty('time_zone');
  });

  it('D-269: a time the app saves without its zone is on the owner\'s zone, the server\'s, never a browser\'s', async () => {
    const f = yours('Europe/Paris');
    const { id } = await f.service.command({ action: 'occasion.save', occasion: doctor({ title: 'Optician', time: '09:15' }) }, owner);
    expect(f.history.occasion(id!)).toMatchObject({ time: '09:15', time_zone: 'Europe/Paris' });
    // One kept on its own zone keeps it.
    await f.service.command({ action: 'occasion.save', occasion: { ...f.history.occasion(id!)!, time_zone: 'America/Chicago', time: '10:00' } }, owner);
    expect(f.history.occasion(id!)).toMatchObject({ time: '10:00', time_zone: 'America/Chicago' });
    // A suggestion the owner gave a time to, accepted.
    const proposal = f.proposals.ensure({ key: 'dentist-recurs', kind: 'occasion', title: 'Dentist recurs?', explanation: 'Twice', confidence: 'low', origin: 'owner', sources: [],
      payload: { occasion: doctor({ title: 'Dentist', time: '08:30' }) } }, NOW);
    const accepted = await f.service.command({ action: 'proposal.accept', ids: [proposal.id] }, owner);
    expect(accepted).toMatchObject({ changed: 1 });
    expect(f.history.occasions(10).find(row => row.title === 'Dentist')).toMatchObject({ time: '08:30', time_zone: 'Europe/Paris' });
  });
});

/** The owner's day, as the composition root wires it. */
const day = () => {
  const db = new Database(':memory:'); ensureWorkEntitySchema(db); const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const contracts = createContractStore(db); const store = createSituationStore(db);
  const history = createProactiveHistoryStore(db, createProactiveProposalStore(db));
  let at = NOW;
  const send = vi.fn(async (_message: NotificationSendArgs) => ({ delivered_to: ['in_app', 'telegram'] }));
  const sources = buildSituationSources({ db, work, reminders: createReminderStore(db), calendars: () => [], timeZone: () => 'UTC', now: () => at });
  const query = createSituationQuery({ now: () => at, sources, sourceForCollection: collection => ({ verb_op: 'core.work-entity.read', collection }) });
  const access = createSituationAccess({ contracts, query, now: () => at, isVaultUnlocked: () => true });
  const service = createScheduledSituations({ db, work, store, query, timeZone: () => 'UTC', isVaultUnlocked: () => true, isQuiet: () => false,
    excludedPerson: (id: string) => id === 'contact-kept-out',
    overview: async () => ({ proposal_count: 0, newest_proposal: null, unmatched_replies: [], phone_ready: true }), send, now: () => at });
  service.bindAccess(access);
  cleanups.push(async () => { await service.stop(); db.close(); });
  return { history, service, query, send, time: (value: number) => { at = value; },
    agenda: async () => {
      service.setSettings({ frequency: 'off', day_of: false }); service.setAgenda({ enabled: true, time: '20:00', day: 'tomorrow' });
      await service.tick(); return send.mock.calls.map(([message]) => message.text);
    } };
};
const ownerRead = { owner: true, grants: { isVerbOpGranted: () => true, isCollectionReadGranted: () => true, isTopicReadGranted: () => true } } as const;

describe('D-407 slice 2 — where the question is asked', () => {
  it('Today lists it, with the day it was last, and keeps it out of the clusters: it has its own answer', async () => {
    const f = day();
    const waiting = f.history.saveOccasion(doctor(), NOW - 1000);
    f.history.saveOccasion(doctor({ title: 'Dentist', source_next_on: '2027-01-10', month_day: '01-10' }), NOW - 1000);
    f.history.saveOccasion(doctor({ title: 'Physio', muted: true }), NOW - 1000);
    // A person the owner keeps out of what Recued brings up: the occasion asks nothing, as the Agenda's source.
    f.history.saveOccasion(doctor({ title: 'Speech therapy with Ola', people: ['contact-kept-out'] }), NOW - 1000);
    const today = await f.service.today({ now: NOW, before: NOW + 7 * 86_400_000 });
    expect(today.occasions_waiting).toEqual([{ id: waiting.id, title: 'Dr. Lee', last_on: '2026-11-17' }]);
    expect(today.situations.clusters.flatMap(cluster => cluster.items).filter(item => item.kind === OCCASION_NEXT_KIND)).toEqual([]);
  });

  it('on its day, an occasion with a time is in the Agenda at that time, on the owner\'s clock; one without stays All day', async () => {
    const f = day();
    f.history.saveOccasion(doctor({ title: 'Dr. Lee', private: false, source_next_on: '2026-11-20', month_day: '11-20', time: '10:30', time_zone: 'America/Chicago', rules: [onTheDay] }), NOW - 1000);
    f.history.saveOccasion(doctor({ title: 'Dentist', private: false, source_next_on: '2026-11-20', month_day: '11-20', rules: [{ ...onTheDay, title: 'Dentist' }] }), NOW - 1000);
    expect(await f.agenda()).toEqual(['All day · Dentist\n16:30 Dr. Lee']);
  });

  it('the day\'s message and the AI get it as an item: "Reminder in Yours" when the occasion is private, its name when shown', async () => {
    const f = day();
    const hidden = f.history.saveOccasion(doctor(), NOW - 1000);
    f.history.saveOccasion(doctor({ title: 'Haircut with Sam', private: false }), NOW - 1000);
    expect(await f.agenda()).toEqual(['All day · Reminder in Yours\nAll day · When is the next one? · Haircut with Sam']);
    const items: SituationItem[] = (await f.query({ time: { from: NOW, to: NOW + 86_400_000 } }, ownerRead)).clusters.flatMap(cluster => cluster.items);
    const copies = items.map(item => situationItemForModel(item, undefined, { zone: 'UTC', isPrivate: (one) => f.service.isPrivateItem(one) }));
    expect(copies.map(copy => [copy.kind, copy.what.value, copy.private ?? false])).toEqual(expect.arrayContaining([
      [OCCASION_NEXT_KIND, 'When is the next one? · Dr. Lee', true], [OCCASION_NEXT_KIND, 'When is the next one? · Haircut with Sam', false]]));
    expect(copies.find(copy => copy.what.value?.includes('Dr. Lee'))!.ref).toEqual({ collection: 'occasion', id: hidden.id, field: 'next' });
  });
});

/** The chat's tools on the real occasion store. */
const chat = () => {
  const db = new Database(':memory:'); cleanups.push(() => { db.close(); });
  const history = createProactiveHistoryStore(db, createProactiveProposalStore(db));
  const occasions: ChatOccasions = { read: (id) => history.occasion(id), list: () => history.occasions(10_000), place: (name) => history.place(name),
    save: async (input) => ({ id: history.saveOccasion(input, NOW).id, message: 'Occasion saved.' }) };
  ensureWorkEntitySchema(db); const store = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(store);
  const resolver = createWorkEntityResolver(store);
  const deps = { getOccasions: () => occasions, getContactStore: () => createContactStore(db),
    getWorkEntityCrudDeps: () => ({ store, resolver, dispatchers: createWorkEntityDispatchers({ store, resolver, now: () => NOW }) }),
    getOpAdmissionGate: () => ({ isFrozenByPause: () => false, isOpGranted: () => true }), now: () => NOW } as unknown as ChatToolHandlerDeps;
  const handlers = buildChatTier1Handlers(deps);
  return { history, deps, create: handlers['work.create']!, update: handlers['work.update']!, search: handlers['work.search']! };
};

describe('D-407 slice 2 — the chat adds one, answers it, or ends it', () => {
  it('work.create with repeat after_each keeps its next one; work.search says when it waits', async () => {
    const f = chat();
    const made = await f.create({ kind: 'occasion', title: 'Dentist cleaning at 9:00', on: '2026-12-12', repeat: 'after_each', private: true }, approved) as { result: { id: string } };
    expect(f.history.occasion(made.result.id)).toMatchObject({ after_each: true, source_next_on: '2026-12-12', month_day: '12-12' });
    expect(((await f.create({ kind: 'occasion', title: 'X', on: '2026-11-01', repeat: 'after_each' }, inChat)) as { detail: string }).detail)
      .toContain('“X” is the next one, so `on` is today or later');
    const waiting = f.history.saveOccasion(doctor(), NOW - 1000);
    const found = await f.search({ kind: 'occasion', query: 'Lee' }, inChat) as { result: { matches: Array<Record<string, unknown>> } };
    expect(found.result.matches[0]).toMatchObject({ id: waiting.id, repeat: 'after_each', waiting_for_next: true, last_on: '2026-11-17', next_on: null });
  });

  it('work.create keeps a time of day on the turn\'s zone, or the one named; refuses a zone with no time', async () => {
    const f = chat();
    const made = await f.create({ kind: 'occasion', title: 'Dr. Lee', on: '2026-12-12', repeat: 'after_each', time: '10:30' }, approved) as { result: { id: string; time: string } };
    expect(made.result.time).toBe('10:30');
    expect(f.history.occasion(made.result.id)).toMatchObject({ time: '10:30', time_zone: 'UTC' });
    const away = await f.create({ kind: 'occasion', title: 'State hospital', on: '2026-12-13', time: '08:00', time_zone: 'America/Chicago' }, approved) as { result: { id: string } };
    expect(f.history.occasion(away.result.id)).toMatchObject({ time: '08:00', time_zone: 'America/Chicago' });
    for (const [args, words] of [[{ time_zone: 'America/Chicago' }, '`time_zone` goes with a `time`'], [{ time: '8am' }, '`time` is HH:mm'],
      [{ time: '08:00', time_zone: 'Chicago' }, '`time_zone` is an IANA zone']] as const) {
      expect(((await f.create({ kind: 'occasion', title: 'X', on: '2026-12-13', ...args }, inChat)) as { detail: string }).detail, JSON.stringify(args)).toContain(words);
    }
    // A task takes no time of day.
    expect(((await f.create({ kind: 'task', title: 'Call', time: '10:30' }, inChat)) as { detail: string }).detail).toContain('`time` applies to an occasion only');
  });

  it('work.update `on` sets its next one; `no_next` ends it; neither for one that does not ask', async () => {
    const f = chat();
    const waiting = f.history.saveOccasion(doctor(), NOW - 1000);
    expect(await checkWorkUpdate(f.deps, { kind: 'occasion', id: waiting.id, on: '2027-05-18' }, inChat)).toBeNull();
    expect(await f.update({ kind: 'occasion', id: waiting.id, on: '2027-05-18' }, approved)).toMatchObject({ ok: true, result: { fields: ['on'] } });
    expect(f.history.occasion(waiting.id)).toMatchObject({ source_next_on: '2027-05-18', month_day: '05-18', after_each: true });
    expect(((await checkWorkUpdate(f.deps, { kind: 'occasion', id: waiting.id, no_next: true, on: '2027-06-01' }, inChat)) as { detail: string }).detail)
      .toContain('`no_next` ends it, so it takes no `on`');
    expect(await f.update({ kind: 'occasion', id: waiting.id, no_next: true }, approved)).toMatchObject({ ok: true, result: { fields: ['no_next'] } });
    expect(f.history.occasion(waiting.id)).not.toHaveProperty('after_each');
    expect(((await checkWorkUpdate(f.deps, { kind: 'occasion', id: waiting.id, no_next: true }, inChat)) as { detail: string }).detail)
      .toContain('does not ask for its next one');
    // Its time of day, kept on its own zone.
    expect(await f.update({ kind: 'occasion', id: waiting.id, time: '14:00' }, approved)).toMatchObject({ ok: true, result: { fields: ['time'] } });
    expect(f.history.occasion(waiting.id)).toMatchObject({ time: '14:00', time_zone: 'UTC' });
    expect(((await checkWorkUpdate(f.deps, { kind: 'task', id: 'task_1', time: '14:00' }, inChat)) as { detail: string }).detail).toContain('`time` applies to an occasion only');
  });
});
