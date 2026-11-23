/** D-407 (the owner, 2026-11-21; Q2's "2 hours before") — an occasion with a time of day can alert before it
 *  (`Occasion.alert_minutes`). Its own engine sends it at that instant, once for each date, on the owner's channels:
 *  ⛔ never a Data → Reminders record ("if occasion has its own reminder then it should not bind to the
 *  data.reminders"). Held in quiet hours and while paused, not sent once the occasion has begun, and a private one says
 *  only "Reminder in Yours". Through the real occasion store, clock service, Yours service and chat handlers. */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isOccasionAlertMinutes, occasionAlertAt, tier1CallDetails, type ExecutionSource, type OccasionInput } from '@recued/contracts';

import { buildChatTier1Handlers, checkWorkUpdate, type ChatOccasions, type ChatToolHandlerDeps } from '../chat-tool-handlers.js';
import { createAssetOccurrenceService } from '../situations/asset-occurrence-service.js';
import { createOccasionClockService, occasionAlertWhen, type OccasionAlertMessage } from '../situations/occasion-clock-service.js';
import { createYoursService } from '../situations/yours-service.js';
import { createAnnotationStore } from '../storage/annotation-store.js';
import { createBlobStore } from '../storage/blob-store.js';
import { createContactStore } from '../storage/contact-store.js';
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
const DAY = '2026-11-20';
const at = (clock: string): number => Date.parse(`${DAY}T${clock}:00Z`);
const lee = (patch: Partial<OccasionInput> = {}): OccasionInput => ({ title: 'Dr. Lee', month_day: '11-20', source_next_on: DAY, people: [],
  muted: false, rules: [], private: false, time: '10:30', time_zone: 'UTC', alert_minutes: 120, ...patch });

describe('D-407 — when an occasion alerts', () => {
  it('its time less its minutes, on the zone the time is kept on; none without a time or with what an older server stored', () => {
    expect(occasionAlertAt(lee(), DAY)).toBe(at('08:30'));
    // 10:30 in Chicago is 16:30 UTC in November: two hours before is 14:30 UTC.
    expect(occasionAlertAt(lee({ time_zone: 'America/Chicago' }), DAY)).toBe(at('14:30'));
    expect(occasionAlertAt(lee({ alert_minutes: 0 }), DAY)).toBe(at('10:30'));
    expect(occasionAlertAt({ alert_minutes: 120 }, DAY)).toBeUndefined();
    for (const bad of [-1, 1441, 1.5, '120', null]) expect(isOccasionAlertMinutes(bad), String(bad)).toBe(false);
    expect(occasionAlertWhen(lee(), DAY, DAY, 'UTC')).toBe('today at 10:30');
    expect(occasionAlertWhen(lee(), DAY, '2026-11-19', 'UTC')).toBe('tomorrow at 10:30');
    expect(occasionAlertWhen(lee(), DAY, '2026-11-01', 'UTC')).toBe('on 20 November at 10:30');
    expect(occasionAlertWhen(lee({ time_zone: 'America/Chicago' }), DAY, DAY, 'UTC')).toBe('today at 10:30 CST');
  });

  it('the store keeps an alert only with a time, in whole minutes up to a day', () => {
    const db = new Database(':memory:'); cleanups.push(() => { db.close(); });
    const history = createProactiveHistoryStore(db, createProactiveProposalStore(db));
    expect(history.saveOccasion(lee(), at('07:00')).alert_minutes).toBe(120);
    for (const bad of [{ time: undefined, time_zone: undefined }, { alert_minutes: 1441 }, { alert_minutes: -5 }, { alert_minutes: 2.5 }]) {
      expect(() => history.saveOccasion(lee(bad), at('07:00')), JSON.stringify(bad)).toThrow('Invalid occasion alert');
    }
  });
});

/** The occasion clock as the composition root makes it, with its alert sender. */
const clock = (options: { quiet?: (at: number) => boolean; paused?: () => boolean; excluded?: string[]; deliver?: () => readonly string[]; zone?: string } = {}) => {
  const db = new Database(':memory:'); ensureWorkEntitySchema(db); const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const history = createProactiveHistoryStore(db, createProactiveProposalStore(db));
  let current = at('07:00');
  const sent: OccasionAlertMessage[] = [];
  const service = createOccasionClockService({ db, work, dispatchers: createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work) }),
    timeZone: () => options.zone ?? 'UTC', now: () => current, excludedPerson: id => options.excluded?.includes(id) === true,
    sendAlert: async (message) => { sent.push(message); return { delivered_to: options.deliver?.() ?? ['in_app'] }; },
    ...(options.quiet ? { isQuiet: options.quiet } : {}), ...(options.paused ? { isPaused: options.paused } : {}) });
  cleanups.push(() => { db.close(); });
  return { db, history, sent, time: (clockTime: string) => { current = at(clockTime); return service.tick(); } };
};

describe('D-407 — the occasion sends its alert itself', () => {
  it('at its minute, once for its date; not before, and not again', async () => {
    const f = clock(); f.history.saveOccasion(lee(), at('07:00'));
    await f.time('08:29'); expect(f.sent).toEqual([]);
    await f.time('08:30'); await f.time('08:31'); await f.time('10:00');
    expect(f.sent).toEqual([{ title: 'Reminder', text: 'Dr. Lee, today at 10:30', ui_link_url: expect.stringMatching(/^#yours\/occasions\/occasion\//u) }]);
    // ⛔ Never a Data → Reminders record.
    createReminderStore(f.db);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM reminders').get()).toEqual({ n: 0 });
  });

  it('a private one says only "Reminder in Yours"; a day before says tomorrow; another zone is named', async () => {
    const f = clock();
    // Each alerts at 10:30 UTC: 10:45 less 15 minutes; tomorrow 10:30 less a day; 05:00 in Chicago (11:00 UTC) less 30.
    f.history.saveOccasion(lee({ title: 'Biopsy', private: true, time: '10:45', alert_minutes: 15 }), at('07:00'));
    f.history.saveOccasion(lee({ title: 'Clinic', source_next_on: '2026-11-21', month_day: '11-21', alert_minutes: 1440 }), at('07:00'));
    f.history.saveOccasion(lee({ title: 'Chicago visit', time: '05:00', time_zone: 'America/Chicago', alert_minutes: 30 }), at('07:00'));
    await f.time('10:29'); expect(f.sent).toEqual([]);
    await f.time('10:30');
    expect(f.sent.map(message => message.text).sort()).toEqual(['Chicago visit, today at 05:00 CST', 'Clinic, tomorrow at 10:30', 'Reminder in Yours, today at 10:45']);
  });

  it('held through quiet hours and a pause, then sent; never once the occasion has begun', async () => {
    let quiet = true; let paused = false;
    const f = clock({ quiet: () => quiet, paused: () => paused }); f.history.saveOccasion(lee(), at('07:00'));
    await f.time('08:30'); expect(f.sent).toEqual([]);
    quiet = false; paused = true; await f.time('09:00'); expect(f.sent).toEqual([]);
    paused = false; await f.time('09:30'); expect(f.sent.map(message => message.text)).toEqual(['Dr. Lee, today at 10:30']);
    const late = clock({ quiet: () => quiet }); late.history.saveOccasion(lee(), at('07:00'));
    quiet = true; await late.time('08:30'); quiet = false; await late.time('10:30'); await late.time('11:00');
    expect(late.sent).toEqual([]);
  });

  it('none for a muted occasion or one with a person kept out; a send no channel took is tried again', async () => {
    const f = clock({ excluded: ['contact-kept-out'] });
    f.history.saveOccasion(lee({ title: 'Muted', muted: true }), at('07:00'));
    f.history.saveOccasion(lee({ title: 'Kept out', people: ['contact-kept-out'] }), at('07:00'));
    await f.time('09:00'); expect(f.sent).toEqual([]);
    let channels: string[] = [];
    const g = clock({ deliver: () => channels }); g.history.saveOccasion(lee(), at('07:00'));
    await g.time('08:30'); channels = ['telegram']; await g.time('08:31'); await g.time('08:32');
    expect(g.sent).toHaveLength(2);
  });
});

/** Yours as the composition root wires it. */
const yours = () => {
  const db = new Database(':memory:'); ensureWorkEntitySchema(db);
  const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  let occurrences: ReturnType<typeof createAssetOccurrenceService>;
  const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work),
    onAssetChanged: async asset => { await occurrences.reconcileAsset(asset.id); }, onAssetDeleted: async asset => { await occurrences.retireAsset(asset.id); } });
  occurrences = createAssetOccurrenceService({ db, work, dispatchers, timeZone: () => 'UTC' });
  const dir = mkdtempSync(join(tmpdir(), 'd407-alert-'));
  const annotations = createAnnotationStore({ db, blobs: createBlobStore(join(dir, 'blobs')) });
  const service = createYoursService({ db, work, dispatchers, occurrences, annotations, situations: createSituationStore(db), isVaultUnlocked: () => true,
    timeZone: () => 'UTC', now: () => at('07:00') } as never);
  cleanups.push(async () => { await service.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { service, history: createProactiveHistoryStore(db, createProactiveProposalStore(db)) };
};

describe('D-407 — Yours says it sends alerts; a day again keeps none', () => {
  it('advertised, saved, and dropped with the time by "When is the next one?"', async () => {
    const f = yours();
    expect((await f.service.snapshot({})).occasion_alert).toBe(true);
    const { id } = await f.service.command({ action: 'occasion.save', occasion: lee({ after_each: true, source_next_on: '2026-11-17', month_day: '11-17' }) }, owner);
    expect(f.history.occasion(id!)).toMatchObject({ alert_minutes: 120 });
    await f.service.command({ action: 'occasion.next', id: id!, on: '2027-05-18', time: null }, owner);
    expect(f.history.occasion(id!)).not.toHaveProperty('alert_minutes');
  });
});

/** The chat's tools on the real occasion store. */
const chat = () => {
  const db = new Database(':memory:'); cleanups.push(() => { db.close(); });
  const history = createProactiveHistoryStore(db, createProactiveProposalStore(db));
  const occasions: ChatOccasions = { read: (id) => history.occasion(id), list: () => history.occasions(10_000), place: (name) => history.place(name),
    save: async (input) => ({ id: history.saveOccasion(input, at('07:00')).id, message: 'Occasion saved.' }) };
  ensureWorkEntitySchema(db); const store = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(store);
  const resolver = createWorkEntityResolver(store);
  const deps = { getOccasions: () => occasions, getContactStore: () => createContactStore(db),
    getWorkEntityCrudDeps: () => ({ store, resolver, dispatchers: createWorkEntityDispatchers({ store, resolver, now: () => at('07:00') }) }),
    getOpAdmissionGate: () => ({ isFrozenByPause: () => false, isOpGranted: () => true }), now: () => at('07:00') } as unknown as ChatToolHandlerDeps;
  const handlers = buildChatTier1Handlers(deps);
  return { history, deps, create: handlers['work.create']!, update: handlers['work.update']!, read: handlers['work.read']! };
};

describe('D-407 — the chat sets an occasion\'s alert', () => {
  it('work.create keeps it with a time; refuses it without one, or out of range', async () => {
    const f = chat();
    const made = await f.create({ kind: 'occasion', title: 'Dentist', on: '2026-12-12', time: '09:15', alert_minutes_before: 120 }, approved) as { result: { id: string } };
    expect(f.history.occasion(made.result.id)).toMatchObject({ time: '09:15', alert_minutes: 120 });
    for (const [args, words] of [[{ alert_minutes_before: 30 }, '`alert_minutes_before` goes with a `time`'],
      [{ time: '09:15', alert_minutes_before: 3000 }, 'whole minutes from 0 to 1440']] as const) {
      expect(((await f.create({ kind: 'occasion', title: 'X', on: '2026-12-13', ...args }, inChat)) as { detail: string }).detail, JSON.stringify(args)).toContain(words);
    }
    expect(((await f.create({ kind: 'task', title: 'Call', alert_minutes_before: 30 }, inChat)) as { detail: string }).detail).toContain('applies to an occasion only');
  });

  it('work.update sets it, `null` takes it away, and one with no time is told to send one; the read shows it', async () => {
    const f = chat();
    const timed = f.history.saveOccasion(lee({ alert_minutes: undefined }), at('07:00'));
    expect(await f.update({ kind: 'occasion', id: timed.id, alert_minutes_before: 30 }, approved)).toMatchObject({ ok: true, result: { fields: ['alert_minutes_before'] } });
    expect(f.history.occasion(timed.id)).toMatchObject({ alert_minutes: 30 });
    expect(((await f.read({ kind: 'occasion', id: timed.id }, inChat)) as { result: { entity: Record<string, unknown> } }).result.entity).toMatchObject({ time: '10:30', alert_minutes_before: 30 });
    expect(await f.update({ kind: 'occasion', id: timed.id, alert_minutes_before: null }, approved)).toMatchObject({ ok: true });
    expect(f.history.occasion(timed.id)).not.toHaveProperty('alert_minutes');
    const untimed = f.history.saveOccasion(lee({ title: 'Untimed', time: undefined, time_zone: undefined, alert_minutes: undefined }), at('07:00'));
    expect(((await checkWorkUpdate(f.deps, { kind: 'occasion', id: untimed.id, alert_minutes_before: 30 }, inChat)) as { detail: string }).detail)
      .toContain('has no `time` yet: send one with the alert');
  });

  it('the card says its time, how it comes back and its alert', () => {
    const rows = (tier1CallDetails('work.create', { kind: 'occasion', title: 'Dentist', on: '2026-12-12', time: '09:15', repeat: 'after_each', alert_minutes_before: 120 }) as { args: Record<string, unknown> }).args;
    expect(rows).toMatchObject({ Date: expect.stringMatching(/ at 09:15, then whenever the last one says$/u), Alert: '2 hours before' });
  });
});
