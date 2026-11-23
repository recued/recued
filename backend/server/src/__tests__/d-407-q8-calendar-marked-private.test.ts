/** D-407 Q8 (D-407 §6; ruled 2026-11-20, the owner: "q8: yes") — an event its own calendar marks
 *  private (Google's `visibility`, Outlook's `sensitivity`, CalDAV's `CLASS`) is private in Recued with no occasion:
 *  the owner's messages call it "Reminder in Yours", and a model reading it is told it is private. Through the real
 *  providers' canonical events, a real calendar table, the real situation sources, query and scheduled situations,
 *  and the real `calendar.search` handler. CalDAV's `CLASS` is read in `caldav-provider.test.ts`, and a marking read
 *  for the first time waking no update in `calendar-collection.test.ts`. */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeConfigStore } from '@recued/config';
import type { CanonicalEvent, SituationItem } from '@recued/contracts';

import { buildChatTier1Handlers } from '../chat-tool-handlers.js';
import { createBootTrace } from '../cli/boot-trace.js';
import type { Collection } from '../collections/types.js';
import { composeAppContext } from '../serve/compose-app-context.js';
import { composeCollectionContext } from '../serve/compose-collection-context.js';
import { createExecutionLateBoundRefs } from '../serve/compose-execution-context.js';
import { composeStorageContext } from '../serve/compose-storage-context.js';
import { unlockServerVault } from './helpers/unlocked-vault.js';
import { createCalendarTable } from '../collections/calendar/calendar-table.js';
import { canonicalizeGcalEvent, type GcalEvent } from '../collections/calendar/gcal-provider.js';
import { canonicalizeGraphEvent, type GraphCalEvent } from '../collections/calendar/graph-provider.js';
import type { NotificationSendArgs } from '../notification-handler.js';
import { createSituationAccess } from '../situations/access.js';
import { situationItemForModel } from '../situations/model-projection.js';
import { createSituationQuery } from '../situations/query.js';
import { createScheduledSituations } from '../situations/scheduled-situations.js';
import { buildSituationSources } from '../situations/sources.js';
import { createContractStore } from '../storage/contract-store.js';
import { createReminderStore } from '../storage/reminder-store.js';
import { createSituationStore } from '../storage/situation-store.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';

const monday = Date.parse('2026-10-19T08:30:00Z');
const DAY = 86_400_000;
const on = (day: number, hhmm: string) => Date.parse(`2026-10-${String(19 + day)}T${hhmm}:00Z`);
const event = (source_id: string, summary: string, from: number, to: number, patch: Partial<CanonicalEvent> = {}): CanonicalEvent => ({
  source_id, ical_uid: `uid-${source_id}`, calendar_id: 'primary', summary, start_at: from, end_at: to, timezone: 'UTC', is_all_day: false,
  status: 'confirmed', created_at: monday, updated_at: monday, ...patch });
const owner = { owner: true, grants: { isVerbOpGranted: () => true, isCollectionReadGranted: () => true, isTopicReadGranted: () => true } } as const;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

/** The owner's day as the composition root wires it, on one connected calendar. `calendars: false` leaves the
 *  scheduled situations without the calendars, as before Q8. */
const fixture = (options: { calendars?: boolean } = {}) => {
  const db = new Database(':memory:'); ensureWorkEntitySchema(db); const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const contracts = createContractStore(db); const store = createSituationStore(db);
  const table = createCalendarTable({ db, slug: 'personal' });
  const calendars = () => [{ slug: 'personal', table }];
  let at = monday;
  const send = vi.fn(async (_message: NotificationSendArgs) => ({ delivered_to: ['in_app', 'telegram'] }));
  const sources = buildSituationSources({ db, work, reminders: createReminderStore(db), calendars, timeZone: () => 'UTC', now: () => at });
  const query = createSituationQuery({ now: () => at, sources, sourceForCollection: collection => ({ verb_op: 'core.work-entity.read', collection }) });
  const access = createSituationAccess({ contracts, query, now: () => at, isVaultUnlocked: () => true });
  const service = createScheduledSituations({ db, work, store, query, timeZone: () => 'UTC', isVaultUnlocked: () => true, isQuiet: () => false,
    overview: async () => ({ proposal_count: 0, newest_proposal: null, unmatched_replies: [], phone_ready: true }), send, now: () => at,
    ...(options.calendars === false ? {} : { calendars }) });
  service.bindAccess(access);
  cleanups.push(async () => { await service.stop(); db.close(); });
  const put = (value: CanonicalEvent) => table.upsert({ event: value, size_bytes: 0 });
  return { db, table, store, send, query, service, put, time: (value: number) => { at = value; },
    texts: () => send.mock.calls.map(([message]) => message.text) };
};

const tomorrowsAgenda = async (f: ReturnType<typeof fixture>) => {
  f.time(on(0, '20:00'));
  f.service.setSettings({ frequency: 'off', day_of: false }); f.service.setAgenda({ enabled: true, time: '20:00', day: 'tomorrow' });
  await f.service.tick();
};

describe('D-407 Q8 — each provider reads its own private marking', () => {
  it('Google: visibility private or confidential; default, public or none is not', () => {
    const base: GcalEvent = { id: 'g-1', summary: 'Biopsy', start: { dateTime: '2026-10-20T09:00:00Z' }, end: { dateTime: '2026-10-20T10:00:00Z' } };
    expect(canonicalizeGcalEvent({ ...base, visibility: 'private' }, 'primary').marked_private).toBe(true);
    expect(canonicalizeGcalEvent({ ...base, visibility: 'confidential' }, 'primary').marked_private).toBe(true);
    for (const visibility of ['default', 'public'] as const) {
      expect(canonicalizeGcalEvent({ ...base, visibility }, 'primary')).not.toHaveProperty('marked_private');
    }
    expect(canonicalizeGcalEvent(base, 'primary')).not.toHaveProperty('marked_private');
  });

  it('Outlook: sensitivity private or confidential; normal, personal or none is not', () => {
    const base: GraphCalEvent = { id: 'o-1', subject: 'Biopsy', start: { dateTime: '2026-10-20T09:00:00.0000000', timeZone: 'UTC' },
      end: { dateTime: '2026-10-20T10:00:00.0000000', timeZone: 'UTC' } };
    expect(canonicalizeGraphEvent({ ...base, sensitivity: 'private' }, 'cal-1').marked_private).toBe(true);
    expect(canonicalizeGraphEvent({ ...base, sensitivity: 'confidential' }, 'cal-1').marked_private).toBe(true);
    // Outlook's "Personal" only labels an event: it hides nothing from those the calendar is shared with.
    for (const sensitivity of ['normal', 'personal'] as const) {
      expect(canonicalizeGraphEvent({ ...base, sensitivity }, 'cal-1')).not.toHaveProperty('marked_private');
    }
    expect(canonicalizeGraphEvent(base, 'cal-1')).not.toHaveProperty('marked_private');
  });
});

describe('D-407 Q8 — what the owner\'s messages say', () => {
  it('the Agenda calls a marked event "Reminder in Yours" and names the rest', async () => {
    const f = fixture();
    f.put(event('biopsy', 'Biopsy', on(1, '09:00'), on(1, '10:00'), { marked_private: true }));
    f.put(event('sync', 'Team sync', on(1, '11:00'), on(1, '11:30')));
    await tomorrowsAgenda(f);
    expect(f.texts()).toEqual(['09:00 Reminder in Yours\n11:00 Team sync']);
  });

  it('without the calendars it names both, as before: the marking is what hides it', async () => {
    const f = fixture({ calendars: false });
    f.put(event('biopsy', 'Biopsy', on(1, '09:00'), on(1, '10:00'), { marked_private: true }));
    f.put(event('sync', 'Team sync', on(1, '11:00'), on(1, '11:30')));
    await tomorrowsAgenda(f);
    expect(f.texts()).toEqual(['09:00 Biopsy\n11:00 Team sync']);
  });

  it('a marking taken off at the calendar names the event again', async () => {
    const f = fixture();
    f.put(event('biopsy', 'Biopsy', on(1, '09:00'), on(1, '10:00'), { marked_private: true }));
    f.put(event('biopsy', 'Biopsy', on(1, '09:00'), on(1, '10:00'), { updated_at: monday + 60_000 }));
    await tomorrowsAgenda(f);
    expect(f.texts()).toEqual(['09:00 Biopsy']);
  });

  it('a resolution keeps a marked event private, and one deleted since counts as private, as a gone occasion does', async () => {
    const f = fixture();
    f.put(event('biopsy', 'Biopsy', on(1, '09:00'), on(1, '10:00'), { marked_private: true }));
    f.put(event('gone', 'Old meeting', on(2, '09:00'), on(2, '10:00')));
    f.put(event('sync', 'Team sync', on(3, '11:00'), on(3, '11:30')));
    const clusters = (await f.query({ time: { from: monday, to: monday + 7 * DAY } }, owner)).clusters;
    expect(clusters).toHaveLength(3);
    for (const cluster of clusters) f.store.save({ id: cluster.id, state: 'resolved', cluster: { ...cluster, span: null }, urgency: 'routine' }, { source: 'done' }, monday);
    f.table.delete('gone');
    await f.service.tick();
    const resolved = f.texts()[0]!.split('\n').filter(line => line.startsWith('Resolved · ')).sort();
    expect(resolved).toEqual(['Resolved · Team sync', 'Resolved · a reminder in Yours', 'Resolved · a reminder in Yours']);
    expect(f.texts()[0]).not.toContain('Biopsy');
    expect(f.texts()[0]).not.toContain('Old meeting');
  });
});

describe('D-407 Q8 — what a model reading it is told', () => {
  it('the day\'s read marks the private event, beside its title', async () => {
    const f = fixture();
    f.put(event('biopsy', 'Biopsy', on(1, '09:00'), on(1, '10:00'), { marked_private: true }));
    f.put(event('sync', 'Team sync', on(1, '11:00'), on(1, '11:30')));
    const items: SituationItem[] = (await f.query({ time: { from: on(1, '00:00'), to: on(2, '00:00') } }, owner)).clusters.flatMap(cluster => cluster.items);
    const copies = items.map(item => situationItemForModel(item, undefined, { zone: 'UTC', isPrivate: item2 => f.service.isPrivateItem(item2) }));
    expect(Object.fromEntries(copies.map(copy => [copy.what.value, copy.private ?? false]))).toEqual({ Biopsy: true, 'Team sync': false });
  });

  it('calendar.search marks it in each of its three reads: by record id, by words, and by window', async () => {
    const db = new Database(':memory:');
    try {
      const table = createCalendarTable({ db, slug: 'personal' });
      table.upsert({ event: event('biopsy', 'Biopsy', on(1, '09:00'), on(1, '10:00'), { marked_private: true }), size_bytes: 0 });
      table.upsert({ event: event('sync', 'Team sync', on(1, '11:00'), on(1, '11:30')), size_bytes: 0 });
      const collections = [{ platform: 'calendar', slug: 'personal', table, provider: { kind: 'gcal' } }];
      const handlers = buildChatTier1Handlers({ getCollectionRegistry: () => ({ list: () => collections }), now: () => monday } as never);
      const ctx = { execution_source: { channel: 'chat', actor: 'user_self', chat_session_id: 's', user_id: 'owner' }, session_id: 's',
        time_zone: 'UTC' } as never;
      type Matches = { result: { matches: Array<{ hot_fields: { summary: string }; private?: true }> } };
      const marks = (got: Matches) => Object.fromEntries(got.result.matches.map(match => [match.hot_fields.summary, match.private ?? false]));
      const byId = await handlers['calendar.search']!({ record_id: table.get('biopsy')!.record_id }, ctx) as Matches;
      expect(marks(byId)).toEqual({ Biopsy: true });
      const plain = await handlers['calendar.search']!({ record_id: table.get('sync')!.record_id }, ctx) as Matches;
      expect(marks(plain)).toEqual({ 'Team sync': false });
      const byWords = await handlers['calendar.search']!({ query: 'Biopsy' }, ctx) as Matches;
      expect(marks(byWords)).toEqual({ Biopsy: true });
      const byWindow = await handlers['calendar.search']!({ start_since: on(1, '00:00'), start_until: on(2, '00:00') }, ctx) as Matches;
      expect(marks(byWindow)).toEqual({ Biopsy: true, 'Team sync': false });
    } finally { db.close(); }
  });
});

// D-407 slice 5 (§4.2) — an event an occasion holds is marked as its occasion is: one it adopted (a clinic's invite)
// carries no marking of Recued's, and the search named it to the model unmarked.
describe('D-407 slice 5 — calendar.search marks an event as the occasion holding it is', () => {
  it('in each of its three reads, whatever its calendar marks', async () => {
    const db = new Database(':memory:');
    try {
      const table = createCalendarTable({ db, slug: 'personal' });
      table.upsert({ event: event('invite', 'Dr. Lee follow-up', on(1, '09:00'), on(1, '10:00')), size_bytes: 0 });
      table.upsert({ event: event('sync', 'Team sync', on(1, '11:00'), on(1, '11:30')), size_bytes: 0 });
      const collections = [{ platform: 'calendar', slug: 'personal', table, provider: { kind: 'gcal' } }];
      const held: string[] = [];
      const handlers = buildChatTier1Handlers({ getCollectionRegistry: () => ({ list: () => collections }), now: () => monday,
        getOccasions: () => ({ eventPrivate: (slug: string, source_id: string) => { held.push(`${slug}:${source_id}`); return source_id === 'invite'; } }) } as never);
      const ctx = { execution_source: { channel: 'chat', actor: 'user_self', chat_session_id: 's', user_id: 'owner' }, session_id: 's',
        time_zone: 'UTC' } as never;
      type Matches = { result: { matches: Array<{ hot_fields: { summary: string }; private?: true }> } };
      const marks = (got: Matches) => Object.fromEntries(got.result.matches.map(match => [match.hot_fields.summary, match.private ?? false]));
      expect(marks(await handlers['calendar.search']!({ record_id: table.get('invite')!.record_id }, ctx) as Matches)).toEqual({ 'Dr. Lee follow-up': true });
      expect(marks(await handlers['calendar.search']!({ query: 'Lee' }, ctx) as Matches)).toEqual({ 'Dr. Lee follow-up': true });
      expect(marks(await handlers['calendar.search']!({ start_since: on(1, '00:00'), start_until: on(2, '00:00') }, ctx) as Matches))
        .toEqual({ 'Dr. Lee follow-up': true, 'Team sync': false });
      expect(held).toContain('personal:invite');
    } finally { db.close(); }
  });
});

describe('D-407 Q8 — the composition root hands the owner\'s calendars to the privacy rule', () => {
  it('an event its calendar marks private is private in the composed scheduled situations, on any connected calendar', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'd407-q8-'));
    const dbPath = join(dir, 'realm.sqlite'), runtimeConfig = createRuntimeConfigStore({});
    const storage = await composeStorageContext({ dbPath,
      bootTrace: createBootTrace({ entrypoint: 'serve-entry', profile: 'serve', command: 'serve', env: {} }),
      runtimeConfig, vaultQuotas: { perPublisherBytes: 1_000_000, totalBytes: 5_000_000 } });
    try {
      const app = composeAppContext({ db: storage.db, dbPath, envLlmConfig: storage.envLlmConfig,
        gateRegistry: storage.gateRegistry, auditLog: storage.auditLog, eventBus: storage.eventBus,
        serverInstanceId: storage.serverInstanceId, recipeStore: storage.recipeStore,
        pairedInstances: storage.pairedInstances, workEntityStore: storage.workEntityStoreRef, chatLateBound: createExecutionLateBoundRefs() });
      await unlockServerVault(app.keys!);
      const collection = composeCollectionContext({ db: storage.db, dbPath, runtimeConfig,
        manifests: storage.manifests, baseVault: storage.baseVault, auditLog: storage.auditLog,
        cacheBlobs: app.cacheBlobs, warehouseBus: app.warehouseBus, contactStore: app.contactStoreRef,
        mailFactStore: storage.mailFactStoreRef, gateRegistry: storage.gateRegistry, accountStore: storage.accountStore,
        eventBus: storage.eventBus, keys: app.keys, connectionStore: app.connectionStoreRef,
        workEntityStore: storage.workEntityStoreRef, enrichmentCascade: app.enrichmentCascadeRef });
      const scheduled = collection.scheduledSituations;
      expect(scheduled).toBeDefined();
      // A calendar connected after boot, as the owner connects one: the rule reads the registry each time.
      collection.collectionRegistry.register({ platform: 'calendar', slug: 'personal', close: async () => undefined } as unknown as Collection);
      const table = createCalendarTable({ db: storage.db, slug: 'personal' });
      table.upsert({ event: event('biopsy', 'Biopsy', on(1, '09:00'), on(1, '10:00'), { marked_private: true }), size_bytes: 0 });
      table.upsert({ event: event('sync', 'Team sync', on(1, '11:00'), on(1, '11:30')), size_bytes: 0 });
      const item = (source_id: string) => ({ ref: { collection: 'calendar', id: `personal:${table.get(source_id)!.record_id}` },
        evidence: [] }) as unknown as SituationItem;
      expect(scheduled!.isPrivateItem(item('biopsy'))).toBe(true);
      expect(scheduled!.isPrivateItem(item('sync'))).toBe(false);
      await scheduled!.stop();
    } finally {
      await storage.drainAuditWrites?.();
      if (storage.db.open) storage.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
