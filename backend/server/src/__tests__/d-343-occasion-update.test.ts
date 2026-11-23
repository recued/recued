/** D-343 slice 1 (ruling 14) — the chat changes an occasion made in Yours through `work.update`:
 *  its title, its date (`on`: a yearly one keeps that month and day, a one-time one moves) or
 *  whether it reminds (`muted`), saved as Yours saves it. Before this, nothing on the chat's side
 *  could change an occasion. A safety, legal or travel clock is not stopped from the chat. An AI
 *  app is refused until the owner grants `core.situation.occasion-update` on its contract (D-343
 *  §355: the grant exists since 2026-11-14).
 *
 *  ⛔ DRIVEN ON THE REAL HISTORY STORE AND HANDLERS; Yours' own save is composed in
 *  `d-325-rule-situations.test.ts`. */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KERNEL_OP_REGISTRY, grantSwitchText, opGrantEntry, tier1CallTitle, type AssetRule, type ExecutionSource, type OccasionInput } from '@recued/contracts';
import { buildChatTier1Handlers, checkWorkUpdate, OCCASION_UPDATE_OP_ID, type ChatOccasions, type ChatToolHandlerDeps } from '../chat-tool-handlers.js';
import { createProactiveHistoryStore } from '../storage/proactive-history-store.js';
import { createProactiveProposalStore } from '../storage/proactive-proposal-store.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';

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

let doorGrants: ReadonlySet<string> = new Set();
const harness = () => {
  const history = createProactiveHistoryStore(db, createProactiveProposalStore(db));
  const saved: ExecutionSource[] = [];
  const occasions: ChatOccasions = { read: (id) => history.occasion(id), save: async (input, by) => { saved.push(by); return history.saveOccasion(input, NOW); } };
  ensureWorkEntitySchema(db); const store = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(store);
  const resolver = createWorkEntityResolver(store);
  const dispatchers = createWorkEntityDispatchers({ store, resolver, now: () => NOW });
  const deps = {
    getOccasions: () => occasions,
    getWorkEntityCrudDeps: () => ({ store, resolver, dispatchers }),
    // The owner is unrestricted; a contract grants only what it names.
    getOpAdmissionGate: () => ({ isFrozenByPause: () => false,
      isOpGranted: (source: ExecutionSource, op?: string) => source.channel !== 'mcp' || op === undefined || doorGrants.has(op) }),
    now: () => NOW,
  } as unknown as ChatToolHandlerDeps;
  const make = (input: Partial<OccasionInput>) => history.saveOccasion({ title: 'Summer party', month_day: '06-20', people: [], muted: false, rules: [], ...input } as OccasionInput, NOW - 1000);
  return { history, deps, saved, make, update: buildChatTier1Handlers(deps)['work.update']! };
};

describe('D-343 slice 1 — the chat changes an occasion made in Yours', () => {
  it('renames it and moves a yearly one’s month and day, asked before the owner is', async () => {
    const f = harness();
    const party = f.make({});
    const move = { kind: 'occasion', id: party.id, title: 'Summer barbecue', on: '2027-06-27' };
    expect(tier1CallTitle('work.update', move)).toBe('Change an occasion');
    expect(await checkWorkUpdate(f.deps, move, inChat)).toBeNull();
    expect(f.history.occasion(party.id)).toMatchObject({ title: 'Summer party', month_day: '06-20' });
    expect(await f.update(move, approved)).toEqual({ ok: true, result: { updated: true, kind: 'occasion', id: party.id, fields: ['title', 'on'] } });
    expect(f.history.occasion(party.id)).toMatchObject({ title: 'Summer barbecue', month_day: '06-27' });
    expect(f.saved).toEqual([owner]);
  });
  it('moves a one-time one to its date, and stops or starts its reminders', async () => {
    const f = harness();
    const visit = f.make({ title: 'Gran’s visit', month_day: '12-01', source_next_on: '2026-12-01' });
    expect(await f.update({ kind: 'occasion', id: visit.id, on: '2026-12-05' }, approved)).toMatchObject({ ok: true });
    expect(f.history.occasion(visit.id)).toMatchObject({ source_next_on: '2026-12-05', month_day: '12-01' });
    const stop = { kind: 'occasion', id: visit.id, muted: true };
    expect(tier1CallTitle('work.update', stop)).toBe('Stop an occasion’s reminders');
    expect(await f.update(stop, approved)).toMatchObject({ ok: true, result: { fields: ['muted'] } });
    expect(f.history.occasion(visit.id)!.muted).toBe(true);
    expect(await f.update({ kind: 'occasion', id: visit.id, muted: false }, approved)).toMatchObject({ ok: true });
    expect(f.history.occasion(visit.id)!.muted).toBe(false);
  });
  it('refuses what an occasion cannot take, each before the owner is asked', async () => {
    const f = harness();
    const party = f.make({});
    const once = f.make({ title: 'Gran’s visit', month_day: '12-01', source_next_on: '2026-12-01' });
    const floor: AssetRule = { id: 'visa', title: 'Visa run', enabled: true, muted: false, pinned: false, consequence: 'floor', expiry_policy: 'strict_expire',
      when: { kind: 'expiry', field: 'next_on' }, reaction: { notify: true, occurrence: 'notice', emit: false }, schedule: { before: [], on_day: true } };
    const visa = f.make({ title: 'Visa run', rules: [floor] });
    for (const [call, words] of [
      [{ id: party.id, done: true }, 'an occasion takes `title`, `on`, `time`, `alert_minutes_before`, `in_calendar`, `muted`, `private`, `where`, `add_steps` and `no_next`, not `done`'],
      [{ id: party.id, on: '20 June' }, '`on` is a date as YYYY-MM-DD'],
      [{ id: once.id, on: '2026-11-01' }, '“Gran’s visit” happens once, so `on` is today or later'],
      [{ id: party.id, muted: 'yes' }, '`muted` is `true` or `false`'],
      [{ id: visa.id, muted: true }, '“Visa run” keeps a safety, legal or travel reminder, which only the user stops, in Yours'],
      [{ id: party.id, title: ' ' }, "an occasion's `title` is its name, at most 500 characters"],
      [{ id: party.id, on: '2030-06-20' }, '“Summer party” already says that, so nothing would change'],
      [{ id: party.id }, "send an occasion's new `title`, `on`, `muted`, `private`, `where` or `add_steps`"],
      [{ id: 'occasion-none', title: 'x' }, 'there is no occasion `occasion-none`'],
    ] as const) {
      const refused = await checkWorkUpdate(f.deps, { kind: 'occasion', ...call }, inChat) as Refused;
      expect(refused, JSON.stringify(call)).toMatchObject({ ok: false, reason: 'invalid_args' });
      expect(refused.detail, JSON.stringify(call)).toContain(words);
    }
    expect((await checkWorkUpdate(f.deps, { kind: 'task', id: 'task-1', on: '2026-12-01' }, inChat) as Refused).detail)
      .toBe('work.update: `on` applies to an occasion only');
    expect(f.saved).toEqual([]);
  });
  it('an AI app is refused until its contract grants the change, then may make it', async () => {
    const f = harness();
    const party = f.make({});
    doorGrants = new Set();
    expect(await f.update({ kind: 'occasion', id: party.id, title: 'Summer barbecue' }, overMcp)).toMatchObject({ ok: false, reason: 'classification_blocked' });
    expect(f.history.occasion(party.id)!.title).toBe('Summer party');
    doorGrants = new Set([OCCASION_UPDATE_OP_ID]);
    try {
      expect(await f.update({ kind: 'occasion', id: party.id, title: 'Summer barbecue' }, overMcp)).toMatchObject({ ok: true });
      expect(f.history.occasion(party.id)!.title).toBe('Summer barbecue');
    } finally { doorGrants = new Set(); }
  });
  it('is a grant the owner can give: a registered write with its switch, off for a door until granted', () => {
    expect(OCCASION_UPDATE_OP_ID).toBe('core.situation.occasion-update');
    expect(KERNEL_OP_REGISTRY.find((entry) => entry.op === OCCASION_UPDATE_OP_ID)).toMatchObject({ domain: 'situation', risk: 'write' });
    expect(grantSwitchText(opGrantEntry(OCCASION_UPDATE_OP_ID))?.title).toBe('Change an occasion');
  });
});
