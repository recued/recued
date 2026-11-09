/** D-340 slice 3 (§3.1, §3.2) — the owner's reminders inside the daily stream: due that day, each with
 *  its buttons, in the stream's one message instead of one by one. They wait for it; an urgent one
 *  (consequence floor) never does, the household's go to the household as before, and one that comes
 *  due after the stream went goes on its own. Nothing repeats.
 *
 *  Through the real scheduler, its Yours service and rpc handlers, the real reminder service and the
 *  real notification block. Only the situation sources, the stream's own send and the messenger are
 *  stand-ins: the messenger records the envelope it was handed. */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssetRule, SituationAgendaStatus, SituationFact, YoursCommandResult } from '@recued/contracts';
import {
  createAskDeliveryStore, createAskStore, createNotificationBlock, createNotificationSettingsStore, createUiChannel,
  type AskDeliveryEnvelope, type AskDeliveryRecord, type Channel, type NotificationSettings, type PendingAsk,
} from '@recued/notification';
import type { WsClient } from '../ws-server.js';
import { createSQLiteCollection } from '../sqlite-collection.js';
import { createSituationQuery } from '../situations/query.js';
import { createSituationAccess } from '../situations/access.js';
import { createScheduledSituations } from '../situations/scheduled-situations.js';
import { createYoursService } from '../situations/yours-service.js';
import { makeYoursHandlers } from '../situations/yours-handler.js';
import { createSituationStore } from '../storage/situation-store.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { createContractStore } from '../storage/contract-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createAssetOccurrenceService } from '../situations/asset-occurrence-service.js';
import { createAssetReminderService, type AssetReminderService } from '../situations/asset-reminder-service.js';
import { closingDayNote, quotedClosingDay } from '../chat-closing-day.js';
import { ensureChatSchema } from '../storage/chat-store.js';
import type { NotificationSendArgs } from '../notification-handler.js';

// Monday 19 October 2026, 06:00 UTC (the server's zone is UTC).
const MORNING = Date.parse('2026-10-19T06:00:00Z');
const at = (time: string, day = '2026-10-19') => Date.parse(`${day}T${time}:00Z`);
const RUN: SituationFact = { ref: { collection: 'calendar', id: 'work:run' }, title: 'Run 5 km', kind: 'calendar', basis: 'declared',
  when: { from: at('07:00'), to: at('07:45') }, act_by: at('07:00'), valid_until: at('07:45'), people: [], subjects: [], related: [],
  evidence: [{ collection: 'calendar', id: 'work:run' }], updated_at: MORNING - 86_400_000, consequence: 'routine' };
/** A month before its date, its first reminder falls today. */
const renew = (patch: Partial<AssetRule> = {}): AssetRule => ({ id: 'renew', title: 'Renew', enabled: true, muted: false, pinned: false,
  consequence: 'routine', expiry_policy: 'escalate_overdue', when: { kind: 'expiry', field: 'expires_on' },
  reaction: { notify: true, occurrence: 'action', emit: false }, schedule: { before: [{ amount: 1, unit: 'months' }], on_day: true }, ...patch });
const paired = { instance_id: 'wc_1', client_kind: 'webclient', user_id: 'owner', client_token_id: 'paired' } as unknown as WsClient;
const telegram = { id: 'owner-telegram', channel: 'telegram' as const, connection_name: 'private', connection_enrolled_at: 100,
  recipient: 'private-chat', expected_sender: 'owner' };
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

const fixture = () => {
  let clock = MORNING;
  const db = new Database(':memory:'); ensureWorkEntitySchema(db); ensureChatSchema(db);
  const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const query = createSituationQuery({ now: () => clock, sourceForCollection: collection => ({ verb_op: 'core.work-entity.read', collection }),
    sources: [{ id: 'calendar', collection: 'calendar', verb_op: 'core.work-entity.read', read: vi.fn(() => [RUN]) }] });
  // The stream's own message, to the channels it names; the app's card is always set up.
  const notified: NotificationSendArgs[] = [];
  const send = vi.fn(async (message: NotificationSendArgs) => { notified.push(message); return { delivered_to: message.channels ?? ['in_app', 'telegram'] }; });
  const store = createSituationStore(db);
  const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work), now: () => clock });
  const occurrences = createAssetOccurrenceService({ db, work, dispatchers, timeZone: () => 'UTC', now: () => clock });
  const yours = createYoursService({ db, work, dispatchers, occurrences, situations: store, now: () => clock, timeZone: () => 'UTC', isVaultUnlocked: () => true });
  // The owner's messenger: it records each envelope, the stream's message among them.
  const envelopes: AskDeliveryEnvelope[] = []; let refuses = false;
  const messenger: Channel = { name: 'telegram', capability: 'inline', owns_llm_egress: false, deliverNotify: async () => {}, deliverAsk: async () => {},
    closeAsk: async () => {}, restoreAskDelivery: async () => {}, withdrawAskDelivery: vi.fn(async () => true),
    deliverAskDelivery: async envelope => { envelopes.push(structuredClone(envelope));
      return refuses ? { outcome: 'not_delivered', error: 'offline' } : { outcome: 'delivered', provider_message_id: `m-${envelopes.length}` }; } };
  let holds = (): boolean => false;
  const reminders: AssetReminderService = createAssetReminderService({ db, work, dispatchers, occurrences, timeZone: () => 'UTC',
    isQuiet: () => false, isVaultUnlocked: () => true, now: () => clock, heldForStream: () => holds(),
    householdDestinations: async () => [{ id: 'household', channel: 'telegram', connection_name: 'family', connection_enrolled_at: 200, recipient: 'family-chat', audience: 'household' }] });
  const block = createNotificationBlock({ askStore: createAskStore(createSQLiteCollection<PendingAsk>(db, 'pending_asks')),
    deliveryStore: createAskDeliveryStore(createSQLiteCollection<AskDeliveryRecord>(db, 'ask_deliveries')),
    settingsStore: createNotificationSettingsStore(createSQLiteCollection<NotificationSettings>(db, 'notification_settings')),
    channels: [createUiChannel({ busSink: () => {} }), messenger], now: () => clock, isVaultUnlocked: () => true,
    resolveReminderDestinations: async () => ({ destinations: [{ id: 'owner-ui', channel: 'ui' }, telegram], issues: [] }) });
  reminders.bind(block);
  // As `compose-collection-context.ts` composes them.
  const scheduled = createScheduledSituations({ db, work, store, query, timeZone: () => 'UTC', isVaultUnlocked: () => true,
    isQuiet: () => false, now: () => clock, send, overview: () => yours.overview(), reminders });
  holds = () => scheduled.holdsReminders();
  scheduled.bindAccess(createSituationAccess({ contracts: createContractStore(db), query, now: () => clock, isVaultUnlocked: () => true }));
  yours.bindScheduled(scheduled);
  cleanups.push(async () => { await reminders.stop(); await yours.stop(); await scheduled.stop(); db.close(); });
  const handlers = makeYoursHandlers(yours)!.handlers;
  const change = (input: unknown) => handlers['yours.change']!(input as never, paired) as Promise<YoursCommandResult>;
  const agenda = async () => await handlers['yours.agenda']!(undefined, paired) as SituationAgendaStatus;
  // Its clock is indexed as a write on the server indexes it, so its reminder is due today.
  const put = async (name: string, patch: Record<string, unknown> = {}, rule: Partial<AssetRule> = {}) => {
    const asset = work.writeAsset({ source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' }, name, dates: { expires_on: '2026-11-19' },
      rules: [renew(rule)], ...patch } as never, clock - 86_400_000);
    await occurrences.reconcileAsset(asset.id); return asset;
  };
  /** The daily stream at 07:30, listing today, holding the Agenda and the day's reminders. */
  const stream = async (settings: Record<string, unknown> = {}) => {
    scheduled.takeOverStreams();
    await change({ action: 'stream.update', stream: 'daily', settings: { enabled: true, time: '07:30', day: 'today', agenda: true,
      coming_up: false, due_today: false, reminders: true, ...settings } });
    await change({ action: 'stream.update', stream: 'weekly', settings: { enabled: false } });
  };
  /** What the owner's messenger was sent, a list of titles per message. */
  const titles = () => envelopes.filter(envelope => envelope.destination.id === 'owner-telegram').map(envelope => envelope.asks.map(ask => ask.message.title));
  return { db, store, work, scheduled, reminders, block, change, agenda, put, stream, envelopes, notified, titles, occurrences,
    setClock: (value: number) => { clock = value; }, refuse: (value: boolean) => { refuses = value; } };
};

describe('D-340 slice 3 — the day\'s reminders wait for the daily stream and go inside it', () => {
  it('holds the owner\'s reminder for the stream, which sends its message with it, each reminder\'s buttons, to its messenger', async () => {
    const f = fixture();
    await f.put('Boiler');
    await f.stream();
    // 06:00: the stream goes at 07:30, so its reminder waits.
    await f.reminders.tick();
    expect(f.envelopes).toEqual([]);
    f.setClock(at('07:30')); await f.scheduled.tick();
    // One envelope, to the messenger and the app: the stream's message is its lead.
    expect(f.envelopes).toHaveLength(1);
    const [envelope] = f.envelopes;
    expect(envelope!.lead!.title).toBe('Your day · Mon 19 Oct');
    expect(envelope!.lead!.text).toMatch(/^Agenda\n07:00 Run 5 km\n\nReminders\n1\. Boiler\n.+/u);
    expect(envelope!.asks.map(ask => ask.message.title)).toEqual(['Boiler']);
    // The app's card holds the same text; the messenger got it with the buttons.
    expect(f.notified).toEqual([expect.objectContaining({ title: 'Your day · Mon 19 Oct', text: envelope!.lead!.text, channels: ['in_app'] })]);
    expect((await f.agenda()).streams!.daily.last_run).toMatchObject({ mode: 'stream', state: 'sent' });
    // Nothing repeats: the reminder went in the stream, so it does not go on its own.
    await f.reminders.tick();
    expect(f.envelopes).toHaveLength(1);
  });

  it('tells a reply quoting it that its reminders are answered separately, not asked about as the day\'s items', async () => {
    const f = fixture();
    await f.put('Boiler'); await f.stream();
    f.setClock(at('07:30')); await f.scheduled.tick();
    const { lead } = f.envelopes[0]!;
    const quoting = (text: string) => JSON.stringify({ reply_to: { message_id: 'notice:1', role: 'notice', text }, message: 'Ran it.' });
    const items = [{ title: 'Run 5 km', ref: { collection: 'calendar', id: 'work:run' } }];
    const quote = quotedClosingDay(quoting(`${lead!.title}\n${lead!.text}`), '2026-10-19')!;
    expect(quote).toEqual({ title: 'Your day · Mon 19 Oct', from: '2026-10-19', to: '2026-10-19', reminders: true });
    expect(closingDayNote(quote, items)).toContain('\n3. Ask about each item above they did not mention (not the notice\'s Reminders, which they answer separately): '
      + 'leave it out, or record it as skipped?\n');
    // A stream with none, and a day's item called "Reminders", as before.
    for (const text of ['Agenda\n07:00 Run 5 km', 'Agenda\n07:00 Reminders']) {
      const plain = quotedClosingDay(quoting(`${lead!.title}\n${text}`), '2026-10-19')!;
      expect(plain).toEqual({ title: 'Your day · Mon 19 Oct', from: '2026-10-19', to: '2026-10-19' });
      expect(closingDayNote(plain, items)).toContain('\n3. Ask about each item above they did not mention: leave it out, or record it as skipped?\n');
    }
  });

  it('never holds an urgent reminder, nor one for the household, and sends one due after the stream on its own', async () => {
    const f = fixture();
    await f.put('Boiler'); await f.put('Smoke alarm', {}, { consequence: 'floor' }); await f.put('Shared heater', { audience: 'household' });
    await f.stream();
    await f.reminders.tick();
    // At once, as before: the urgent one and the household's (to the owner and the household); the owner's waits.
    expect(f.titles().flat().sort()).toEqual(['Shared heater', 'Smoke alarm']);
    expect(f.envelopes.filter(envelope => envelope.destination.id === 'household').map(envelope => envelope.asks[0]!.message.title)).toEqual(['Shared heater']);
    f.setClock(at('07:30')); await f.scheduled.tick();
    expect(f.envelopes.at(-1)!.lead).toBeDefined();
    expect(f.envelopes.at(-1)!.asks.map(ask => ask.message.title)).toEqual(['Boiler']);
    // Written after the stream went: on its own, as before.
    f.setClock(at('09:00')); await f.put('Car');
    await f.reminders.tick();
    expect(f.envelopes.at(-1)).toMatchObject({ asks: [expect.objectContaining({ message: expect.objectContaining({ title: 'Car' }) })] });
    expect(f.envelopes.at(-1)!.lead).toBeUndefined();
  });

  it('holds nothing when the stream carries no reminders, or after its day\'s run went', async () => {
    const f = fixture();
    await f.put('Boiler');
    await f.stream({ reminders: false });
    await f.reminders.tick();
    expect(f.titles()).toEqual([['Boiler']]);
    expect(f.envelopes[0]!.lead).toBeUndefined();
    expect(f.scheduled.holdsReminders()).toBe(false);
  });

  it('leaves Due today out beside the reminders, and previews them without sending or reserving one', async () => {
    const f = fixture();
    await f.put('Boiler');
    await f.stream({ agenda: false, due_today: true });
    const { preview } = await f.change({ action: 'stream.preview', stream: 'daily' });
    expect(preview!.counts).toMatchObject({ reminders: 1, due_today: 0 });
    expect(preview!.text).toMatch(/^Reminders\n1\. Boiler\n/u);
    expect(f.envelopes).toEqual([]);
    // Still the stream's to send.
    f.setClock(at('07:30')); await f.scheduled.tick();
    expect(f.envelopes).toHaveLength(1);
    expect(f.envelopes[0]!.lead!.text).not.toMatch(/Due today/u);
  });

  it('previews a later day\'s reminders by that day\'s reminder points', async () => {
    const f = fixture();
    // Reminded a month before its date, today, and again 30 days before, tomorrow.
    await f.put('Car', {}, { schedule: { before: [{ amount: 1, unit: 'months' }, { amount: 30, unit: 'days' }], on_day: true } });
    await f.stream();
    // Today's stream carried today's reminder: the next stream is tomorrow's.
    f.setClock(at('07:30')); await f.scheduled.tick();
    expect(f.titles()).toEqual([['Car']]);
    f.setClock(at('08:00'));
    const { preview } = await f.change({ action: 'stream.preview', stream: 'daily' });
    expect(preview).toMatchObject({ title: 'Your day · Tue 20 Oct', counts: { reminders: 1 } });
    expect(preview!.text).toContain('Reminders\n1. Car\n');
  });

  it('hands its message on when the messenger did not take it at once: not sent again, and uncertain until the delivery\'s retry', async () => {
    const f = fixture();
    await f.put('Boiler');
    await f.stream({ channels: ['telegram'] });
    f.refuse(true);
    f.setClock(at('07:30')); await f.scheduled.tick();
    expect(f.envelopes).toHaveLength(1);
    expect((await f.agenda()).streams!.daily.last_run).toMatchObject({ mode: 'stream', state: 'uncertain' });
    // The stream's run does not send it again; the delivery retries the messenger itself.
    f.setClock(at('07:35')); await f.scheduled.tick();
    expect(f.notified).toEqual([]);
    expect(f.envelopes.filter(envelope => envelope.lead !== undefined)).toHaveLength(1);
  });

  it('builds its message again when a reminder changed after it read them, so the numbers match the buttons', async () => {
    const f = fixture();
    const boiler = await f.put('Boiler'); await f.put('Car');
    await f.stream();
    const read = f.reminders.streamReminders();
    expect(read.map(reminder => reminder.ask.message.title).sort()).toEqual(['Boiler', 'Car']);
    // The owner stops the boiler's reminders in the app meanwhile.
    f.work.writeAsset({ id: boiler.id, source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' }, rules: [renew({ muted: true })] } as never, MORNING);
    expect(await f.reminders.sendWithStream({ reminders: read, lead: { title: 'Your day · Mon 19 Oct', text: 'x' }, channels: null })).toEqual({ stale: true });
    expect(f.envelopes).toEqual([]);
    f.setClock(at('07:30')); await f.scheduled.tick();
    expect(f.envelopes[0]!.asks.map(ask => ask.message.title)).toEqual(['Car']);
    expect(f.envelopes[0]!.lead!.text).toMatch(/Reminders\n1\. Car\n/u);
  });

  it('goes with the stream\'s channels: the app\'s cards only where the stream goes to the app', async () => {
    const f = fixture();
    await f.put('Boiler');
    await f.stream({ channels: ['telegram'] });
    f.setClock(at('07:30')); await f.scheduled.tick();
    expect(f.envelopes).toHaveLength(1);
    expect(f.envelopes[0]!.destination.id).toBe('owner-telegram');
    const group = (await f.block.getAskDelivery(f.envelopes[0]!.group_id))!;
    expect(group.destinations.map(destination => destination.id)).toEqual(['owner-telegram']);
    // Nothing else to send: the messenger had the message.
    expect(f.notified).toEqual([]);
  });

  it('names a private item\'s reminder in a stream that includes private items, and none in one that does not', async () => {
    for (const include_private of [false, true]) {
      const f = fixture();
      await f.put('Passport', { settings: { sensitive: true } });
      await f.stream({ include_private });
      f.setClock(at('07:30')); await f.scheduled.tick();
      expect(f.envelopes[0]!.asks[0]!.message.title).toBe(include_private ? 'Passport' : 'Reminder in Yours');
      expect(f.envelopes[0]!.lead!.text).toContain(include_private ? '1. Passport' : '1. Reminder in Yours');
    }
  });

  it('keeps reminders to a daily stream that lists today', async () => {
    const f = fixture();
    f.scheduled.takeOverStreams();
    await expect(f.change({ action: 'stream.update', stream: 'weekly', settings: { reminders: true } })).rejects.toThrow('Reminders go with the daily stream');
    await expect(f.change({ action: 'stream.update', stream: 'daily', settings: { day: 'tomorrow', reminders: true } }))
      .rejects.toThrow('Reminders go with a stream that lists today');
    await expect(f.change({ action: 'stream.update', stream: 'daily', settings: { reminders: 'yes' } })).rejects.toThrow('Choose a valid stream schedule');
    // Written by hand or by a later Recued, it reads as off.
    f.store.writeSetting('situations.streams', { daily: { day: 'tomorrow', reminders: true }, weekly: { reminders: true } });
    expect((await f.agenda()).streams!.daily.settings.reminders).toBe(false);
    expect((await f.agenda()).streams!.weekly.settings.reminders).toBe(false);
  });
});
