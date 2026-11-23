/** D-339 slice 6 (§5.3) — a Body set to "AI reads the numbers only when you allow it"
 *  (`values_on_request`) shows a model's general reads the names of its readings and states, never
 *  their values: the prefetch and `situation.query` (through situation access, its fact context too)
 *  and `work.read` / `work.search` (through the work read tool). Its state items, whose titles are
 *  values, are left out. Only a stream's own suggestions, while that stream includes private items,
 *  see them. Through the real asset source, clock index, situation query and work read tool. */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssetCondition, AssetRule, ExecutionSource } from '@recued/contracts';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createAssetOccurrenceService } from '../situations/asset-occurrence-service.js';
import { buildSituationSources } from '../situations/sources.js';
import { createSituationQuery } from '../situations/query.js';
import { createReminderStore } from '../storage/reminder-store.js';
import { createSituationAccess } from '../situations/access.js';
import { createContractStore } from '../storage/contract-store.js';
import { runWorkEntityReadTool, runWorkEntitySearchTool, type WorkEntityReadToolsDeps } from '../work-entity-read-tools.js';
import { VALUES_ON_REQUEST_ALLOW_HOW, VALUES_ON_REQUEST_GOAL_HOW, VALUES_ON_REQUEST_HOW, VALUES_ON_REQUEST_OFF_HOW, VALUES_ON_REQUEST_RANGES_HOW, withheldValuesOf,
  withholdFactContextValues } from '../situations/values-on-request.js';
import { bodyNumbersFor, withBodyNumbers, type BodyNumbersSetting } from '../body-numbers-setting.js';

const NIGHT_END = Date.parse('2026-11-06T07:00:00Z');
const MIDNIGHT = Date.parse('2026-11-07T00:00:00Z');
const HOUR = 3_600_000; const DAY = 24 * HOUR;
const owner: ExecutionSource = { channel: 'chat', actor: 'user_self', chat_session_id: 'chat-1', user_id: 'owner' };
const suggestions: ExecutionSource = { channel: 'schedule', actor: 'system', schedule_id: 'stream-daily', cron: '0 7 * * *' } as ExecutionSource;
const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });

const shortNight: AssetRule = { id: 'short_sleep', title: 'Short sleep', enabled: true, muted: false, pinned: false, consequence: 'routine',
  expiry_policy: 'indefinite', when: { kind: 'condition', field: 'short_sleep', certainty: 'confirmed' },
  reaction: { notify: false, occurrence: null, emit: false, state: true }, schedule: { before: [], on_day: true } };
const checkTracker: AssetRule = { ...shortNight, id: 'check', title: 'Check the sleep tracker',
  reaction: { notify: false, occurrence: 'notice', emit: false } };
const holds = (): Omit<AssetCondition, 'source'> => ({ active: true, certainty: 'confirmed', as_of: NIGHT_END, until: MIDNIGHT, evidence: [] });

/** `bodyNumbers`: slice 12a's switch for the owner's chats, wired as the server composes it. */
const fixture = async (values_on_request: boolean, extra: { dates?: Record<string, string>; attributes?: Record<string, string>; settings?: Record<string, unknown> } = {},
  bodyNumbers?: Pick<BodyNumbersSetting, 'forChats'>) => {
  const db = new Database(':memory:'); ensureWorkEntitySchema(db); cleanups.push(() => db.close());
  const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  const at = NIGHT_END + HOUR; const now = () => at;
  const resolver = createWorkEntityResolver(work);
  const dispatchers = createWorkEntityDispatchers({ store: work, resolver, now });
  const occurrences = createAssetOccurrenceService({ db, work, dispatchers, now, timeZone: () => 'UTC' });
  const sources = buildSituationSources({ db, work, reminders: createReminderStore(db), calendars: () => [], now, timeZone: () => 'UTC' });
  const query = createSituationQuery({ now, sources, sourceForCollection: collection => ({ verb_op: 'core.work-entity.read', collection }) });
  const body = work.writeAsset({ source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' }, name: "Anna's body", class_id: 'body', dates: extra.dates ?? {},
    ...(extra.attributes ? { attributes: extra.attributes } : {}),
    // Slice 14: a reading with no value yet, as most of a version 2 Body's are, is named nowhere below.
    readings: { sleep_minutes: { value: 312, unit: 'min', as_of: NIGHT_END, evidence: [] }, resting_heart_rate: { value: 64, unit: 'bpm', as_of: NIGHT_END, evidence: [] },
      blood_glucose: null },
    observations: { short_sleep: { ...holds(), source: 'owner' } },
    settings: { sensitive: true, values_on_request, ...extra.settings }, rules: [shortNight, checkTracker] } as never, at);
  await occurrences.reconcileAsset(body.id);
  const access = createSituationAccess({ contracts: createContractStore(db), query, now, isVaultUnlocked: () => true,
    withheldValues: (id, source) => withBodyNumbers(withheldValuesOf(work.readAsset(id)), bodyNumbers, source), showsWithheldValues: source => source === suggestions });
  const items = async (source: ExecutionSource) => (await access.read({ time: { from: at, to: at + 7 * DAY } }, source, undefined, 'UTC'))
    .clusters.flatMap(cluster => cluster.items).filter(item => item.ref.id === body.id);
  const tools: WorkEntityReadToolsDeps = { isVerbOpGranted: () => true, isCollectionReadGranted: () => true,
    getResolver: () => resolver, getTargetedReadDeps: () => undefined,
    ...(bodyNumbers ? { bodyNumbersFor: (ctx: { execution_source?: ExecutionSource }) => bodyNumbersFor(bodyNumbers, ctx.execution_source) } : {}) };
  const ctx = { execution_source: owner, channel: 'internal_function_call', session_id: 'chat-1' } as never;
  return { work, body, access, items, tools, ctx };
};

// 312 is matched as a number of its own (`\b312\b`): a random asset id holds "312" in 0.5% of runs, and
// `/312/` failed the 2026-11-17 sweep on the id `733125de-…`, with no value shown anywhere.
describe('D-339 slice 6 — a Body\'s values stay out of a model\'s general reads', () => {
  it('situation.query: its items carry the names of its readings and states; its state is left out', async () => {
    const f = await fixture(true);
    const items = await f.items(owner);
    expect(items.map(item => item.kind)).toEqual(['asset_rule']);
    expect(items[0]!.details).toMatchObject({ values_on_request: { readings: ['sleep', 'resting heart rate'], states: ['Short sleep'] } });
    expect(items[0]!.details).not.toHaveProperty('readings');
    // It says the values are held and how to read them: with the names alone a model said "no readings on file".
    expect(items[0]!.details!.values_on_request!.how).toMatch(/held.*tools\.search.*how someone has slept and recovered.*asks the owner/su);
    expect(JSON.stringify(items)).not.toMatch(/\b312\b|"value":64|Short sleep · /u);
  });

  it('shows them as before for a Body that does not ask, and to a stream\'s suggestions that include private items', async () => {
    const plain = await fixture(false);
    const all = await plain.items(owner);
    expect(all.map(item => item.kind).sort()).toEqual(['asset_rule', 'asset_state']);
    expect(all[0]!.details!.readings).toMatchObject({ sleep_minutes: { value: 312 } });
    const f = await fixture(true);
    const shown = await f.items(suggestions);
    expect(shown.map(item => item.kind).sort()).toEqual(['asset_rule', 'asset_state']);
    expect(shown[0]!.details).not.toHaveProperty('values_on_request');
  });

  it('the prefetch: the same names, never the values', async () => {
    const f = await fixture(true);
    const result = await f.access.prefetch("How did Anna's body sleep?", owner, new AbortController().signal);
    const items = result.clusters.flatMap(cluster => cluster.items).filter(item => item.ref.id === f.body.id);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every(item => item.kind !== 'asset_state')).toBe(true);
    expect(JSON.stringify(items)).not.toMatch(/\b312\b|"value":64/u);
  });

  it('its fact context names a reading and leaves its value out', () => {
    const packet = { nodes: [{ kind: 'field', ref: { kind: 'field', asset_id: 'b1', group: 'readings', field: 'sleep_minutes' }, label: 'Sleep minutes',
      value: { value: 312, unit: 'min', as_of: 1 }, known: true, source: null }], edges: [], missing: [] } as never;
    const out = withholdFactContextValues(packet, id => (id === 'b1' ? { readings: ['sleep'], states: [] } : undefined));
    expect(out.nodes[0]).toMatchObject({ label: 'Sleep minutes', value: null, value_omitted: true });
  });

  it('work.read shows the names in place of its readings and conditions; work.search shows no values either', async () => {
    const f = await fixture(true);
    const read = await runWorkEntityReadTool(f.tools, { kind: 'asset', id: f.body.id }, f.ctx) as { ok: true; result: { entity: Record<string, unknown> } };
    expect(read.ok).toBe(true);
    const item = read.result.entity;
    expect(item).toMatchObject({ name: "Anna's body", values_on_request: { readings: ['sleep', 'resting heart rate'], states: ['Short sleep'] } });
    expect(item).not.toHaveProperty('readings');
    expect(item).not.toHaveProperty('observations');
    expect((item.values_on_request as { how: string }).how).toMatch(/held, not absent/u);
    const search = await runWorkEntitySearchTool(f.tools, { kind: 'asset', query: 'body' }, f.ctx);
    expect(JSON.stringify(search)).not.toMatch(/\b312\b|"value":64/u);
    // A Body that does not ask still shows its readings.
    const plain = await fixture(false);
    expect(JSON.stringify(await runWorkEntityReadTool(plain.tools, { kind: 'asset', id: plain.body.id }, plain.ctx))).toMatch(/\b312\b/u);
  });

  it('slice 13: its dates and details are held too (named, never shown), and its conversation is never shown', async () => {
    // What "Ask with the numbers" keeps on a Body: a birth date, a gender, the conversation and approvals.
    const about = { dates: { birth_date: '1990-03-04' }, attributes: { gender: 'female' },
      settings: { chat_conversation: { session_id: 'chat-kept-77', sent: [{ at: 1, request: 'diet', days: 7, readings: [], about: ['age'], source: 'slot_1', source_label: 'Fast · qwen' }] } } };
    const hidden = /1990-03-04|female|chat-kept-77|Fast · qwen/u;
    const f = await fixture(true, about);
    const items = await f.items(owner);
    expect(items[0]!.details).toMatchObject({ values_on_request: { dates: ['birth date'], attributes: ['gender'] } });
    expect(items[0]!.details!.values_on_request!.how).toMatch(/dates and details here \(such as a birth date\) are held too.*only when the owner sends them/su);
    expect(JSON.stringify(items)).not.toMatch(hidden);
    const prefetch = await f.access.prefetch("What should Anna's body eat?", owner, new AbortController().signal);
    expect(prefetch.clusters.flatMap(cluster => cluster.items).some(item => item.ref.id === f.body.id)).toBe(true);
    expect(JSON.stringify(prefetch)).not.toMatch(hidden);
    const read = await runWorkEntityReadTool(f.tools, { kind: 'asset', id: f.body.id }, f.ctx) as { ok: true; result: { entity: Record<string, unknown> } };
    expect(read.result.entity).toMatchObject({ values_on_request: { dates: ['birth date'], attributes: ['gender'] } });
    expect(read.result.entity).not.toHaveProperty('dates');
    expect(read.result.entity).not.toHaveProperty('attributes');
    expect(JSON.stringify(read)).not.toMatch(hidden);
    const packet = { nodes: [{ kind: 'field', ref: { kind: 'field', asset_id: 'b1', group: 'dates', field: 'birth_date' }, label: 'Birth date',
      value: '1990-03-04', known: true, source: null }], edges: [], missing: [] } as never;
    expect(withholdFactContextValues(packet, id => (id === 'b1' ? { readings: [], states: [] } : undefined)).nodes[0]).toMatchObject({ value: null, value_omitted: true });
    // A Body with no dates or details says nothing of them, as before.
    const bare = await fixture(true);
    expect((await bare.items(owner))[0]!.details!.values_on_request).not.toHaveProperty('dates');
    // A Body that does not ask shows them as before.
    const plain = await fixture(false, about);
    expect(JSON.stringify(await plain.items(owner))).toMatch(/1990-03-04/u);
  });
});

// D-339 slice 15 (D-342 §17) — a goal on a Body is a pursuit; its numbers are body numbers.
// D-339 slice 12a (§5.6) — the note tells the owner's chats what their switch for a Body's numbers lets
// them do, wired as the server composes it; any other reader is told the read asks.
describe('D-339 slice 12a — the owner\'s chats are told their switch', () => {
  const hid: ExecutionSource = { channel: 'user', actor: 'user_self', user_id: 'owner', client_token_id: 'paired' };
  const HOW = { off: VALUES_ON_REQUEST_OFF_HOW, ask: VALUES_ON_REQUEST_HOW, allow: VALUES_ON_REQUEST_ALLOW_HOW } as const;
  const howOf = (item: unknown) => (item as { details?: { values_on_request?: { how: string } }; values_on_request?: { how: string } })
    .details?.values_on_request?.how ?? (item as { values_on_request?: { how: string } }).values_on_request?.how;

  it('situation.query and work.read, for each setting; the owner\'s own read is told it asks', async () => {
    for (const chats of ['off', 'ask', 'allow'] as const) {
      const f = await fixture(true, {}, { forChats: () => chats });
      const [item] = await f.items(owner);
      expect(howOf(item)?.startsWith(HOW[chats]), chats).toBe(true);
      const read = await runWorkEntityReadTool(f.tools, { kind: 'asset', id: f.body.id }, f.ctx) as { ok: true; result: { entity: unknown } };
      expect(howOf(read.result.entity)?.startsWith(HOW[chats]), chats).toBe(true);
      const [own] = await f.items(hid);
      expect(howOf(own)?.startsWith(VALUES_ON_REQUEST_HOW), chats).toBe(true);
    }
  });
});

describe('D-339 slice 15 — a body goal\'s numbers are held as its Body\'s are', () => {
  /** Bo's body weighs 58.1 kg; a goal on it of 57 kg, set at 62 kg. */
  const withGoal = async (held: boolean) => {
    const f = await fixture(true);
    const at = NIGHT_END + HOUR; const by = { source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' } };
    const bo = f.work.writeAsset({ ...by, name: "Bo's body", class_id: 'body', dates: {}, observations: {}, rules: [],
      readings: { weight: { value: 58.1, unit: 'kg', as_of: NIGHT_END, evidence: [] } }, settings: { sensitive: true, values_on_request: true } } as never, at);
    const goal = f.work.writeAsset({ ...by, name: "Weight goal · Bo's body", class_id: 'pursuit', dates: { target_on: '2027-06-01' },
      readings: { progress: null }, observations: {}, rules: [], attributes: { why: 'the half marathon' },
      settings: { goal: { asset_id: bo.id, reading: 'weight', target: 57, unit: 'kg', start: 62, start_day: '2026-10-01' }, sensitive: true, values_on_request: held } } as never, at);
    const goalItems = async (source: ExecutionSource) =>
      (await f.access.prefetch("How is Bo's weight goal going?", source, new AbortController().signal)).clusters
        .flatMap(cluster => cluster.items).filter(item => item.ref.id === goal.id);
    return { ...f, bo, goal, goalItems };
  };
  const hidden = /\b57\b|\b58\.1\b|\b62\b|2026-10-01|2027-06-01|half marathon/u;

  it('held: a general read names its reading, says how it is held, and shows no number of it', async () => {
    const f = await withGoal(true);
    const items = await f.goalItems(owner);
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]!.details).toMatchObject({ values_on_request: { goal: 'weight', how: VALUES_ON_REQUEST_GOAL_HOW } });
    expect(items[0]!.details).not.toHaveProperty('goal');
    expect(JSON.stringify(items)).not.toMatch(hidden);
    const read = await runWorkEntityReadTool(f.tools, { kind: 'asset', id: f.goal.id }, f.ctx) as { ok: true; result: { entity: Record<string, unknown> } };
    expect(read.result.entity).toMatchObject({ values_on_request: { goal: 'weight' } });
    expect(JSON.stringify(read)).not.toMatch(hidden);
    expect(withheldValuesOf(f.goal)?.goal).toBe('weight');
  });

  it('not held: its numbers, and where its Body is now, worked out when read', async () => {
    const f = await withGoal(false);
    const [item] = await f.goalItems(owner);
    expect(item!.details!.goal).toMatchObject({ reading: 'weight', target: { value: 57, unit: 'kg' }, start: { value: 62, day: '2026-10-01' },
      now: { value: 58.1 }, to_go: 1.1 });
    // Kept as a structure in its settings, it is the goal, not a setting "left out" for its size.
    expect(item!.details!.left_out ?? []).not.toContain('settings.goal');
    expect(item!.details!.settings ?? {}).not.toHaveProperty('goal');
  });

  it('a stream\'s suggestions that include private items read a held goal\'s numbers', async () => {
    const f = await withGoal(true);
    const [item] = await f.goalItems(suggestions);
    expect(item!.details!.goal).toMatchObject({ target: { value: 57, unit: 'kg' }, now: { value: 58.1 } });
    expect(item!.details).not.toHaveProperty('values_on_request');
  });
});

// D-339 slice 16 — the owner's own ranges, kept on the Body, are body numbers too.
describe('D-339 slice 16 — a Body\'s own ranges are held as its readings are', () => {
  const ranges = { ranges: { weight: { low: 50, high: 52, unit: 'kg', set_on: '2026-10-02' }, body_fat: { high: 22, unit: '%', set_on: '2026-10-02' } } };
  const hidden = /\b50\b|\b52\b|\b22\b|2026-10-02/u;

  it('held: a general read names them, says how they are held, and shows no number of them', async () => {
    const f = await fixture(true, { settings: ranges });
    const items = await f.items(owner);
    expect(items[0]!.details).toMatchObject({ values_on_request: { ranges: ['weight', 'body fat'] } });
    expect(items[0]!.details!.values_on_request!.how).toContain(VALUES_ON_REQUEST_RANGES_HOW);
    expect(items[0]!.details).not.toHaveProperty('ranges');
    expect(JSON.stringify(items)).not.toMatch(hidden);
    const prefetch = await f.access.prefetch("How did Anna's body sleep?", owner, new AbortController().signal);
    expect(JSON.stringify(prefetch)).not.toMatch(hidden);
    const read = await runWorkEntityReadTool(f.tools, { kind: 'asset', id: f.body.id }, f.ctx) as { ok: true; result: { entity: Record<string, unknown> } };
    expect(read.result.entity).toMatchObject({ values_on_request: { ranges: ['weight', 'body fat'] } });
    expect(JSON.stringify(read)).not.toMatch(hidden);
    expect(withheldValuesOf(f.work.readAsset(f.body.id))?.ranges).toEqual(['weight', 'body fat']);
  });

  it('not held, and to a stream\'s suggestions that include private items: each range on its reading', async () => {
    const plain = await fixture(false, { settings: ranges });
    const [item] = await plain.items(owner);
    expect(item!.details!.ranges).toEqual([{ reading: 'weight', low: 50, high: 52, unit: 'kg', set_on: '2026-10-02' },
      { reading: 'body fat', high: 22, unit: '%', set_on: '2026-10-02' }]);
    // Kept as a structure in its settings, it is a range, not a setting "left out" for its size.
    expect(item!.details!.left_out ?? []).not.toContain('settings.ranges');
    expect(item!.details!.settings ?? {}).not.toHaveProperty('ranges');
    const held = await fixture(true, { settings: ranges });
    const shown = await held.items(suggestions);
    expect(shown.find(row => row.details?.ranges)?.details?.ranges).toHaveLength(2);
  });
});

// D-339 slice 17 — a reading outside its range is a state, and a state's title is a value: a held Body's is left out.
describe('D-339 slice 17 — a range state is held as the Body\'s other states are', () => {
  /** Bo's body weighs 58.1 kg, over its own range of 56–57 kg; held or not. */
  const overRange = async (held: boolean) => {
    const f = await fixture(true);
    const bo = f.work.writeAsset({ source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' }, name: "Bo's body", class_id: 'body', dates: {},
      observations: {}, rules: [], readings: { weight: { value: 58.1, unit: 'kg', as_of: NIGHT_END, evidence: [] } },
      settings: { sensitive: true, values_on_request: held, ranges: { weight: { low: 56, high: 57, unit: 'kg', set_on: '2026-11-01' } } } } as never, NIGHT_END + HOUR);
    const states = async (source: ExecutionSource) => (await f.access.read({ time: { from: NIGHT_END, to: NIGHT_END + 7 * DAY } }, source, undefined, 'UTC'))
      .clusters.flatMap(cluster => cluster.items).filter(item => item.ref.id === bo.id && item.kind === 'asset_state').map(item => item.what.value);
    return { states };
  };

  it('a Body that does not hold its values shows it to a model\'s read', async () => {
    expect(await (await overRange(false)).states(owner)).toEqual(["Weight over your range · Bo's body"]);
  });

  it('a held Body\'s is left out of a model\'s general read, and the suggestions that include private items read it', async () => {
    const f = await overRange(true);
    expect(await f.states(owner)).toEqual([]);
    expect(await f.states(suggestions)).toEqual(["Weight over your range · Bo's body"]);
  });
});

