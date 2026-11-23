/** D-407 slice 4a.2 (Q3, Q4, U4) — the calendar occasions put their events in, chosen once by the owner in Yours and
 *  never by the AI, and each occasion's *In my calendar*: what Yours keeps and says, and what the chat can set. The
 *  event writing itself is `d-407-occasion-calendar-sync.test.ts`. */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tier1CallDetails, type ExecutionSource, type OccasionCalendarChoice, type OccasionInput } from '@recued/contracts';

import { buildChatTier1Handlers, checkWorkUpdate, workAskLabels, type ChatOccasions, type ChatToolHandlerDeps } from '../chat-tool-handlers.js';
import { createAssetOccurrenceService } from '../situations/asset-occurrence-service.js';
import { createYoursService } from '../situations/yours-service.js';
import { createAnnotationStore } from '../storage/annotation-store.js';
import { createBlobStore } from '../storage/blob-store.js';
import { createContactStore } from '../storage/contact-store.js';
import { createProactiveHistoryStore } from '../storage/proactive-history-store.js';
import { createProactiveProposalStore } from '../storage/proactive-proposal-store.js';
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
const NOW = Date.parse('2026-11-21T07:00:00Z');
const personal: OccasionCalendarChoice = { slug: 'outlook-me', calendar_id: 'cal-personal', name: 'Personal' };
const lee = (patch: Partial<OccasionInput> = {}): OccasionInput => ({ title: 'Dr. Lee', month_day: '12-12', source_next_on: '2026-12-12', people: [],
  muted: false, rules: [], private: true, ...patch });

describe('D-407 slice 4 — the store keeps In my calendar only for an owner\'s occasion', () => {
  it('a boolean, and never on one dated by its source', () => {
    const db = new Database(':memory:'); cleanups.push(() => { db.close(); });
    const history = createProactiveHistoryStore(db, createProactiveProposalStore(db));
    expect(history.saveOccasion(lee({ in_calendar: true }), NOW).in_calendar).toBe(true);
    expect(() => history.saveOccasion(lee({ in_calendar: 'yes' as never }), NOW)).toThrow('Invalid occasion calendar');
    expect(() => history.saveOccasion(lee({ source_next_on: undefined, in_calendar: true, source: { collection: 'contact', id: 'c-1' } }), NOW)).toThrow('Invalid occasion calendar');
  });
});

const yours = (writes = true) => {
  const db = new Database(':memory:'); ensureWorkEntitySchema(db);
  const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  let occurrences: ReturnType<typeof createAssetOccurrenceService>;
  const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work),
    onAssetChanged: async asset => { await occurrences.reconcileAsset(asset.id); }, onAssetDeleted: async asset => { await occurrences.retireAsset(asset.id); } });
  occurrences = createAssetOccurrenceService({ db, work, dispatchers, timeZone: () => 'UTC' });
  const dir = mkdtempSync(join(tmpdir(), 'd407-s4-'));
  const service = createYoursService({ db, work, dispatchers, occurrences, annotations: createAnnotationStore({ db, blobs: createBlobStore(join(dir, 'blobs')) }),
    situations: createSituationStore(db), isVaultUnlocked: () => true, timeZone: () => 'UTC', now: () => NOW,
    ...(writes ? { occasionEvents: () => ({ 'occ-1': { name: 'Personal' }, 'occ-2': { name: 'Personal', error: 'Outlook said 503' } }) } : {}) } as never);
  cleanups.push(async () => { await service.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  return service;
};

describe('D-407 slice 4 — the occasions\' calendar, chosen once in Yours', () => {
  it('kept and shown; null for none; refused when this server writes no event', async () => {
    const service = yours();
    const before = await service.snapshot({});
    expect(before).toMatchObject({ occasion_calendar_events: true, occasion_events: { 'occ-1': { name: 'Personal' }, 'occ-2': { error: 'Outlook said 503' } } });
    expect(before.settings.occasion_calendar).toBeNull();
    await service.command({ action: 'settings.update', occasion_calendar: personal }, owner);
    expect((await service.snapshot({})).settings.occasion_calendar).toEqual(personal);
    await expect(service.command({ action: 'settings.update', occasion_calendar: { slug: '', calendar_id: 'x', name: 'X' } }, owner)).rejects.toThrow('Choose a calendar for occasions');
    await service.command({ action: 'settings.update', occasion_calendar: null }, owner);
    expect((await service.snapshot({})).settings.occasion_calendar).toBeNull();
    const older = yours(false);
    expect((await older.snapshot({})).occasion_calendar_events).toBeUndefined();
    await expect(older.command({ action: 'settings.update', occasion_calendar: personal }, owner)).rejects.toThrow('This server does not write occasions into a calendar');
  });
});

const chat = (choice: OccasionCalendarChoice | null) => {
  const db = new Database(':memory:'); cleanups.push(() => { db.close(); });
  const history = createProactiveHistoryStore(db, createProactiveProposalStore(db));
  const occasions: ChatOccasions = { read: (id) => history.occasion(id), list: () => history.occasions(10_000), place: (name) => history.place(name),
    calendar: () => choice, save: async (input) => ({ id: history.saveOccasion(input, NOW).id, message: 'Occasion saved.' }) };
  ensureWorkEntitySchema(db); const store = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(store);
  const resolver = createWorkEntityResolver(store);
  const deps = { getOccasions: () => occasions, getContactStore: () => createContactStore(db),
    getWorkEntityCrudDeps: () => ({ store, resolver, dispatchers: createWorkEntityDispatchers({ store, resolver, now: () => NOW }) }),
    getOpAdmissionGate: () => ({ isFrozenByPause: () => false, isOpGranted: () => true }), now: () => NOW } as unknown as ChatToolHandlerDeps;
  const handlers = buildChatTier1Handlers(deps);
  return { history, deps, create: handlers['work.create']!, update: handlers['work.update']!, read: handlers['work.read']! };
};

describe('D-407 slice 4 — the chat ticks In my calendar, or keeps it Recued only', () => {
  it('ticked to start once a calendar is chosen; false when the user says Recued only; none chosen, refused if asked', async () => {
    const f = chat(personal);
    const made = await f.create({ kind: 'occasion', title: 'Dr. Lee', on: '2026-12-12' }, approved) as { result: { id: string } };
    expect(f.history.occasion(made.result.id)?.in_calendar).toBe(true);
    const only = await f.create({ kind: 'occasion', title: 'Biopsy', on: '2026-12-09', in_calendar: false }, approved) as { result: { id: string } };
    expect(f.history.occasion(only.result.id)?.in_calendar).toBe(false);
    const g = chat(null);
    const none = await g.create({ kind: 'occasion', title: 'Dr. Lee', on: '2026-12-12' }, approved) as { result: { id: string } };
    expect(g.history.occasion(none.result.id)).not.toHaveProperty('in_calendar');
    expect(((await g.create({ kind: 'occasion', title: 'X', on: '2026-12-12', in_calendar: true }, inChat)) as { detail: string }).detail)
      .toContain('no calendar is chosen for occasions yet');
  });

  it('work.update moves it in or out; the read says it; the card says Recued only', async () => {
    const f = chat(personal);
    const occasion = f.history.saveOccasion(lee(), NOW);
    expect(await f.update({ kind: 'occasion', id: occasion.id, in_calendar: true }, approved)).toMatchObject({ ok: true, result: { fields: ['in_calendar'] } });
    expect(((await f.read({ kind: 'occasion', id: occasion.id }, inChat)) as { result: { entity: Record<string, unknown> } }).result.entity).toMatchObject({ in_calendar: true });
    const sourced = f.history.saveOccasion(lee({ title: 'Birthday', source_next_on: undefined, source: { collection: 'contact', id: 'c-1' } }), NOW);
    expect(((await checkWorkUpdate(f.deps, { kind: 'occasion', id: sourced.id, in_calendar: true }, inChat)) as { detail: string }).detail)
      .toContain('is dated by its source');
    expect(((tier1CallDetails('work.create', { kind: 'occasion', title: 'Biopsy', on: '2026-12-09', in_calendar: false }) as { args: Record<string, unknown> }).args).Calendar)
      .toBe('Recued only, no calendar entry');
  });

  it('the card names the calendar its event goes in, left out or said; nothing when none is chosen (§4.1)', async () => {
    const f = chat(personal);
    const leftOut = { kind: 'occasion', title: 'Dr. Lee', on: '2026-12-12', people: ['Dr. Lee'] };
    const labels = await workAskLabels(f.deps, leftOut);
    expect(labels).toMatchObject({ in_calendar: { true: 'Its event goes in Personal' }, people: { 'Dr. Lee': 'Dr. Lee (new contact)' } });
    const card = (args: Record<string, unknown>, given: Awaited<ReturnType<typeof workAskLabels>>) =>
      (tier1CallDetails('work.create', args, given) as { args: Record<string, unknown> }).args;
    expect(card(leftOut, labels).Calendar).toBe('Its event goes in Personal');
    expect(card({ ...leftOut, in_calendar: true }, labels).Calendar).toBe('Its event goes in Personal');
    expect(card({ ...leftOut, in_calendar: false }, labels).Calendar).toBe('Recued only, no calendar entry');
    // None chosen: no label, so no row; nothing is written then either.
    expect(await workAskLabels(chat(null).deps, { kind: 'occasion', title: 'Dr. Lee', on: '2026-12-12' })).toBeUndefined();
    expect(card(leftOut, undefined)).not.toHaveProperty('Calendar');
    // A change into or out of the calendar, in the same words, with the occasion by its title.
    const occasion = f.history.saveOccasion(lee(), NOW);
    const into = { kind: 'occasion', id: occasion.id, in_calendar: true };
    const updateLabels = await workAskLabels(f.deps, into);
    expect(updateLabels).toMatchObject({ id: { [occasion.id]: 'Dr. Lee' } });
    const update = (args: Record<string, unknown>) => (tier1CallDetails('work.update', args, updateLabels) as { args: Record<string, unknown> }).args;
    expect(update(into)).toMatchObject({ Occasion: occasion.id, Calendar: 'Its event goes in Personal' });
    expect(update({ ...into, in_calendar: false })).toMatchObject({ Calendar: 'Recued only, no calendar entry' });
    expect(update(into)).not.toHaveProperty('in_calendar');
  });
});
