/** D-407 slice 1 (D-407 §5, §8; Q1, Q6, Q7, Q10 ruled 2026-11-20) — the AI adds, finds, reads and
 *  changes an occasion with the work tools: `work.create` kind `occasion` (its date and how it comes back, who and
 *  where, whether it is private, its reminders and the steps before it), `work.search` and `work.read` with kind
 *  `occasion`, and `work.update` now also for its privacy, place and new steps. One text says what goes where
 *  (`WHAT_GOES_WHERE`) for every tool that could take a personal date, and the search words find the kind
 *  (A1) and no longer find `work.create` for a booking it refuses (A4).
 *
 *  ⛔ DRIVEN ON THE REAL HISTORY AND CONTACT STORES AND THE REAL HANDLERS. The model's choices are measured live by
 *  `scripts/drives/d-407-occasion-chat-live.mjs`. */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRuntimeConfigStore } from '@recued/config';
import { WHAT_GOES_WHERE, TIER1_TOOL_DESCRIPTORS, TIER1_TOPIC_TAGS, tier1CallDetails, tier1CallTitle, type ExecutionSource } from '@recued/contracts';
import { buildChatTier1Handlers, checkWorkCreate, checkWorkUpdate, OCCASION_CREATE_OP_ID, workAskLabels, type ChatOccasions,
  type ChatToolHandlerDeps } from '../chat-tool-handlers.js';
import { createBootTrace } from '../cli/boot-trace.js';
import { composeAppContext } from '../serve/compose-app-context.js';
import { composeCollectionContext } from '../serve/compose-collection-context.js';
import { createExecutionLateBoundRefs } from '../serve/compose-execution-context.js';
import { composeStorageContext } from '../serve/compose-storage-context.js';
import { createContactStore } from '../storage/contact-store.js';
import { createProactiveHistoryStore } from '../storage/proactive-history-store.js';
import { createProactiveProposalStore } from '../storage/proactive-proposal-store.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { unlockServerVault } from './helpers/unlocked-vault.js';

const owner: ExecutionSource = { channel: 'chat', actor: 'user_self', chat_session_id: 'chat-1', user_id: 'user-1' };
const door: ExecutionSource = { channel: 'mcp', actor: 'contracted_user', agent_id: 'agent', tool_call_id: 'call-1', mcp_token_id: 'tok-1', contract_id: 'door-1' };
const inChat = { channel: 'internal_function_call', session_id: 'sess-1', execution_source: owner, time_zone: 'Europe/Dublin' } as never;
const approved = { channel: 'internal_function_call', session_id: 'sess-1', execution_source: owner, owner_approved: true, time_zone: 'Europe/Dublin' } as never;
const overMcp = { channel: 'mcp_wire', mcp_token_id: 'tok-1', execution_source: door, owner_approved: true } as never;
type Refused = { ok: false; reason: string; detail: string };
const NOW = Date.parse('2026-11-07T12:00:00Z');

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); });
afterEach(() => db.close());

const harness = () => {
  const history = createProactiveHistoryStore(db, createProactiveProposalStore(db));
  const contacts = createContactStore(db);
  const saved: ExecutionSource[] = [];
  // As the composition root wires them: Yours' store, its list and its places.
  const occasions: ChatOccasions = { read: (id) => history.occasion(id), list: () => history.occasions(10_000), place: (name) => history.place(name),
    save: async (input, by) => { saved.push(by); return { id: history.saveOccasion(input, NOW).id, message: 'Occasion saved.' }; } };
  ensureWorkEntitySchema(db); const store = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(store);
  const resolver = createWorkEntityResolver(store);
  const dispatchers = createWorkEntityDispatchers({ store, resolver, now: () => NOW });
  const deps = {
    getOccasions: () => occasions,
    getContactStore: () => contacts,
    getWorkEntityCrudDeps: () => ({ store, resolver, dispatchers }),
    getOpAdmissionGate: () => ({ isFrozenByPause: () => false,
      isOpGranted: (source: ExecutionSource, op?: string) => source.channel !== 'mcp' || op === undefined }),
    now: () => NOW,
  } as unknown as ChatToolHandlerDeps;
  const handlers = buildChatTier1Handlers(deps);
  return { history, contacts, deps, saved, create: handlers['work.create']!, update: handlers['work.update']!,
    search: handlers['work.search']!, read: handlers['work.read']! };
};
const doctor = { kind: 'occasion', title: 'Dr. Lee', on: '2026-12-18', where: 'the state hospital', private: true,
  steps: [{ title: 'Blood test', days_before: 7 }], remind_days_before: [21, 1] };

describe('D-407 slice 1 — one text says what goes where, and the words find it', () => {
  it('work.create and calendar.create both carry it; the kinds and fields are the model\'s', () => {
    const create = TIER1_TOOL_DESCRIPTORS['work.create']; const calendar = TIER1_TOOL_DESCRIPTORS['calendar.create'];
    expect(create.description).toContain(WHAT_GOES_WHERE);
    expect(calendar.description).toContain(WHAT_GOES_WHERE);
    expect(WHAT_GOES_WHERE).toMatch(/health one is private/u);
    expect(WHAT_GOES_WHERE).toMatch(/birthday or anniversary goes on\s+their contact \(`contact\.write`\)/u);
    // 2026-11-21 — being told at a time is D-324's reminder, found with `tools.search`, never a task: slice 1 said
    // nothing of it, and "Remind me to pay the rent on 1 December" went to a task.
    // Said for both readers: a chat finds Remind me with `tools.search`; an MCP app, which has no `tools.search`, in its tools.
    expect(WHAT_GOES_WHERE).toMatch(/on a day or at a time .*is a reminder, not a task: use Remind me \(in chat, `tools\.search` finds it\)/su);
    // A deadline is a task even when said as "remind me" (D-324: work with progress stays a task).
    expect(WHAT_GOES_WHERE).toMatch(/Work due by a deadline is a task, even said\s+as "remind me"/u);
    expect(WHAT_GOES_WHERE).toMatch(/if there is none, say so rather than making a task/u);
    expect((create.arg_schema as { properties: { kind: { description: string } } }).properties.kind.description)
      .toMatch(/`task` = something to do \(optionally with a due date\); being told something at a time is a reminder, not a task/u);
    const schema = create.arg_schema as { properties: Record<string, { enum?: string[] }> };
    expect(schema.properties.kind!.enum).toContain('occasion');
    for (const field of ['on', 'repeat', 'people', 'where', 'private', 'steps', 'remind_days_before']) expect(schema.properties).toHaveProperty(field);
    for (const tool of ['work.search', 'work.read'] as const) {
      expect((TIER1_TOOL_DESCRIPTORS[tool].arg_schema as { properties: { kind: { enum: string[] } } }).properties.kind.enum).toContain('occasion');
    }
  });

  it('work.create is tagged for an occasion or an appointment, not a booking it refuses nor a reminder it never makes (A4)', () => {
    expect(TIER1_TOPIC_TAGS['work.create']).toEqual(expect.arrayContaining(['occasion', 'appointment']));
    expect(TIER1_TOPIC_TAGS['work.create']).not.toContain('booking');
    expect(TIER1_TOPIC_TAGS['work.create']).not.toContain('reminder');
    for (const tool of ['work.search', 'work.read', 'work.update'] as const) expect(TIER1_TOPIC_TAGS[tool]).toContain('occasion');
  });
});

describe('D-407 slice 1 — the chat adds an occasion', () => {
  it('asked before the owner is, then saved as theirs: its date once, its place, private, its steps and reminders', async () => {
    const f = harness();
    expect(tier1CallTitle('work.create', doctor)).toBe('Add a private occasion');
    expect(await checkWorkCreate(f.deps, doctor, inChat)).toBeNull();
    expect(f.history.occasions()).toEqual([]);
    const done = await f.create(doctor, approved) as { ok: true; result: { id: string } };
    expect(done).toMatchObject({ ok: true, result: { created: true, kind: 'occasion', title: 'Dr. Lee', on: '2026-12-18', repeat: 'once', private: true, steps: 1 } });
    const kept = f.history.occasion(done.result.id)!;
    expect(kept).toMatchObject({ title: 'Dr. Lee', month_day: '12-18', source_next_on: '2026-12-18', private: true, people: [], muted: false,
      where: { name: 'the state hospital' } });
    const date = kept.rules.find((rule) => rule.id === 'date')!;
    expect(date).toMatchObject({ reaction: { occurrence: 'notice' }, schedule: { before: [{ amount: 21, unit: 'days' }, { amount: 1, unit: 'days' }], on_day: true } });
    const step = kept.rules.find((rule) => rule.title === 'Blood test')!;
    expect(step).toMatchObject({ reaction: { occurrence: 'action' }, expiry_policy: 'strict_expire', when: { kind: 'expiry', field: 'next_on', offset: { amount: 7, unit: 'days' } } });
    expect(f.saved).toEqual([owner]);
  });

  it('a yearly one with a person: the person a contact by name, or a new name-only contact once approved (Q6)', async () => {
    const f = harness();
    f.contacts.upsertManual({ email: 'ana@example.test', name: 'Ana Lima' }, NOW);
    const party = { kind: 'occasion', title: 'Family reunion', on: '2027-07-18', repeat: 'yearly', people: ['Ana Lima', 'Grandma'] };
    expect(await workAskLabels(f.deps, party)).toEqual({ people: { 'Ana Lima': 'Ana Lima', Grandma: 'Grandma (new contact)' } });
    expect(await checkWorkCreate(f.deps, party, inChat)).toBeNull();
    // A check adds nobody.
    expect(f.contacts.list({ name_contains: 'Grandma' })).toEqual([]);
    const done = await f.create(party, approved) as { ok: true; result: { id: string; private: boolean } };
    const kept = f.history.occasion(done.result.id)!;
    expect(kept).toMatchObject({ month_day: '07-18', people: expect.any(Array) });
    expect(kept.source_next_on).toBeUndefined();
    const grandma = f.contacts.list({ name_contains: 'Grandma' });
    expect(grandma).toHaveLength(1);
    const ana = f.contacts.get('ana@example.test')!;
    expect(kept.people).toEqual([ana.contact_id ?? ana.email, grandma[0]!.contact_id ?? grandma[0]!.email]);
    // No choice made: the rule before decides, a person in it.
    expect(kept).not.toHaveProperty('private');
    expect(done.result.private).toBe(true);
    // A week before and on the day, as Yours' default.
    expect(kept.rules).toEqual([expect.objectContaining({ id: 'date', schedule: { before: [{ amount: 1, unit: 'weeks' }], on_day: true } })]);
  });

  it('its approval says what it adds, private always said', () => {
    expect(tier1CallDetails('work.create', doctor).args).toEqual({ Occasion: 'Dr. Lee', Date: expect.stringMatching(/18 Dec/u), Where: 'the state hospital',
      Private: 'Yes', Steps: 'Blood test, 7 days before', Reminders: '21 and 1 days before, and on the day' });
    expect(tier1CallDetails('work.create', { kind: 'occasion', title: 'Reunion', on: '2027-07-18', repeat: 'yearly', people: ['Grandma'] },
      { people: { Grandma: 'Grandma (new contact)' } }).args).toEqual({ Occasion: 'Reunion', Date: expect.stringMatching(/18 Jul.*every year/u),
      People: 'Grandma (new contact)', Private: 'Yes, a person is in it', Reminders: 'A week before, and on the day' });
    expect(tier1CallTitle('work.create', { kind: 'occasion', title: 'Reunion', on: '2027-07-18' })).toBe('Add an occasion');
  });

  it('refuses what an occasion cannot take, before the owner is asked; another kind refuses its fields', async () => {
    const f = harness();
    f.contacts.upsertManual({ email: 'sam1@example.test', name: 'Sam' }, NOW); f.contacts.upsertManual({ email: 'sam2@example.test', name: 'Sam' }, NOW);
    for (const [call, words] of [
      [{ on: '18 December' }, "an occasion's `on` is its date, YYYY-MM-DD"],
      [{ on: '2026-11-01' }, '“Dr. Lee” happens once, so `on` is today or later'],
      [{ repeat: 'monthly' }, '`repeat` is `yearly`, `once` or `after_each`'],
      [{ private: 'yes' }, '`private` is `true` or `false`'],
      [{ steps: [{ title: 'Blood test' }] }, 'each of `steps` has a `title` and `days_before`'],
      [{ remind_days_before: [0] }, '`remind_days_before` is a list of up to 5 whole numbers of days'],
      [{ people: ['Sam'] }, 'two contacts are named “Sam”'],
      [{ due_at: '2026-12-01' }, 'an occasion takes `title`, `on`, `repeat`, `time`, `time_zone`, `alert_minutes_before`, `in_calendar`, `people`, `where`, `private`, `steps` and `remind_days_before`, not `due_at`'],
      [{ body: 'At 5pm.' }, 'an occasion keeps no `body`: put a time of day in `time` ("17:00")'],
    ] as const) {
      const refused = await checkWorkCreate(f.deps, { ...doctor, ...call }, inChat) as Refused;
      expect(refused.ok, JSON.stringify(call)).toBe(false);
      expect(refused.detail, JSON.stringify(call)).toContain(words);
    }
    expect(((await checkWorkCreate(f.deps, { kind: 'task', title: 'Call', on: '2026-12-01' }, inChat)) as Refused).detail).toContain('`on` applies to an occasion only');
    expect(f.history.occasions()).toEqual([]);
  });

  it('an AI app is refused until the owner grants the switch', async () => {
    const f = harness();
    const refused = await f.create(doctor, overMcp) as Refused;
    expect(OCCASION_CREATE_OP_ID).toBe('core.situation.occasion-create');
    expect(refused).toMatchObject({ ok: false, reason: 'classification_blocked' });
    expect(refused.detail).toContain("'work.create' is not available for this contract");
    expect(f.history.occasions()).toEqual([]);
  });
});

describe('D-407 slice 1 — found, read and changed as the rest are (A3)', () => {
  it('work.search finds it by its words with its id, work.read reads it, work.update changes its privacy, place and steps', async () => {
    const f = harness();
    const id = (await f.create(doctor, approved) as { result: { id: string } }).result.id;
    await f.create({ kind: 'occasion', title: 'Street party', on: '2027-06-20', repeat: 'yearly' }, approved);
    const found = await f.search({ kind: 'occasion', query: 'doctor Lee appointment' }, inChat) as { ok: true; result: { matches: Array<Record<string, unknown>> } };
    expect(found.result.matches).toEqual([{ kind: 'occasion', id, title: 'Dr. Lee', next_on: '2026-12-18', repeat: 'once', private: true,
      steps: [{ title: 'Blood test', days_before: 7 }] }]);
    // Its people and place are not here: `situation.query` gives them, aliased.
    expect(JSON.stringify(found.result)).not.toContain('state hospital');
    const all = await f.search({ kind: 'occasion' }, inChat) as { ok: true; result: { matches: Array<{ title: string }> } };
    expect(all.result.matches.map((row) => row.title)).toEqual(['Dr. Lee', 'Street party']);
    expect(await f.read({ kind: 'occasion', id }, inChat)).toMatchObject({ ok: true, result: { entity: { id, title: 'Dr. Lee', private: true } } });
    const change = { kind: 'occasion', id, private: false, where: 'the clinic on Main Street', add_steps: [{ title: 'Fast from midnight', days_before: 1 }] };
    expect(await checkWorkUpdate(f.deps, change, inChat)).toBeNull();
    expect(await f.update(change, approved)).toMatchObject({ ok: true, result: { updated: true, kind: 'occasion', fields: ['private', 'where', 'add_steps'] } });
    const kept = f.history.occasion(id)!;
    expect(kept).toMatchObject({ private: false, where: { name: 'the clinic on Main Street' } });
    expect(kept.rules.map((rule) => rule.title)).toEqual(['Dr. Lee', 'Blood test', 'Fast from midnight']);
    expect(tier1CallDetails('work.update', change).args).toMatchObject({ Private: false, Where: 'the clinic on Main Street', 'Adds steps': 'Fast from midnight, 1 day before' });
    expect(await f.read({ kind: 'occasion', id: 'occasion-none' }, inChat)).toMatchObject({ ok: false });
  });
});

describe('D-407 slice 1 — the composition root gives the chat the occasions to search and their places', () => {
  it('lists Yours\' occasions and keeps a place as Yours keeps one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'd407-s1-'));
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
      const occasionsRef: { current: ChatOccasions | undefined } = { current: undefined };
      const collection = composeCollectionContext({ db: storage.db, dbPath, runtimeConfig,
        manifests: storage.manifests, baseVault: storage.baseVault, auditLog: storage.auditLog,
        cacheBlobs: app.cacheBlobs, warehouseBus: app.warehouseBus, contactStore: app.contactStoreRef,
        mailFactStore: storage.mailFactStoreRef, gateRegistry: storage.gateRegistry, accountStore: storage.accountStore,
        eventBus: storage.eventBus, keys: app.keys, connectionStore: app.connectionStoreRef,
        workEntityStore: storage.workEntityStoreRef, enrichmentCascade: app.enrichmentCascadeRef, occasionsRef });
      const occasions = occasionsRef.current!;
      expect(occasions.list).toBeDefined(); expect(occasions.place).toBeDefined();
      const place = occasions.place!('The State Hospital');
      expect(place).toMatchObject({ name: 'The State Hospital' });
      await occasions.save({ title: 'Dr. Lee', month_day: '12-18', source_next_on: '2026-12-18', people: [], muted: false, rules: [], where: place }, owner);
      expect(occasions.list!().map((row) => [row.title, row.where?.name])).toEqual([['Dr. Lee', 'The State Hospital']]);
      await collection.scheduledSituations?.stop();
    } finally {
      await storage.drainAuditWrites?.();
      if (storage.db.open) storage.db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
