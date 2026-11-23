import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssetCondition, AssetRule, SituationFact } from '@recued/contracts';
import { createWorkEntityStore, ensureWorkEntitySchema, type WorkEntityStore } from '../storage/work-entity-store.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { createAssetOccurrenceService } from '../situations/asset-occurrence-service.js';
import { createAssetClockStore } from '../storage/asset-clock-store.js';
import { buildSituationSources } from '../situations/sources.js';
import { createSituationQuery } from '../situations/query.js';
import { createReminderStore } from '../storage/reminder-store.js';
import { createSituationAccess } from '../situations/access.js';
import { createScheduledSituations } from '../situations/scheduled-situations.js';
import { createSituationStore } from '../storage/situation-store.js';
import { createContractStore } from '../storage/contract-store.js';

// D-340 §4 — a state: a condition shown while it holds, ending at its `until` with no writer.
const NIGHT_END = Date.parse('2026-11-06T07:00:00Z');
const MIDNIGHT = Date.parse('2026-11-07T00:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

const condition = (patch: Partial<Omit<AssetCondition, 'source'>> = {}): Omit<AssetCondition, 'source'> =>
  ({ active: true, certainty: 'confirmed', as_of: NIGHT_END, until: MIDNIGHT, evidence: [], ...patch });
const rule = (patch: Partial<AssetRule> = {}): AssetRule => ({ id: 'short_sleep', title: 'Short night', enabled: true, muted: false, pinned: false,
  consequence: 'routine', expiry_policy: 'indefinite', when: { kind: 'condition', field: 'short_sleep', certainty: 'confirmed' },
  reaction: { notify: false, occurrence: null, emit: false, state: true }, schedule: { before: [], on_day: true }, ...patch });

const stores = () => {
  const db = new Database(':memory:'); ensureWorkEntitySchema(db); cleanups.push(() => { db.close(); });
  const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  let time = NIGHT_END + HOUR;
  const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work), now: () => time });
  const occurrences = createAssetOccurrenceService({ db, work, dispatchers, now: () => time, timeZone: () => 'UTC' });
  const sources = buildSituationSources({ db, work, reminders: createReminderStore(db), calendars: () => [], now: () => time, timeZone: () => 'UTC' });
  const query = createSituationQuery({ now: () => time, sources, sourceForCollection: collection => ({ verb_op: 'core.work-entity.read', collection }) });
  const grants = { isVerbOpGranted: () => true, isCollectionReadGranted: () => true, isTopicReadGranted: () => true };
  const items = async (surface: 'today' | 'tool' | 'digest' = 'today') => (await query({ time: { from: time, to: time + 7 * DAY }, surface }, { owner: true, grants } as never))
    .clusters.flatMap(cluster => cluster.items).filter(item => item.ref.collection === 'asset');
  const put = (rules: AssetRule[], observation: Omit<AssetCondition, 'source'> | null) => work.writeAsset({ source_id: 'recued.asset',
    source: { kind: 'owner', ref: 'owner' }, name: 'Body', dates: {}, observations: { short_sleep: observation ? { ...observation, source: 'owner' } : null }, rules }, time);
  return { db, work, occurrences, items, put, clocks: createAssetClockStore(db), at: (value: number) => { time = value; } };
};

describe('D-340 states through the observation op', () => {
  const bound = (work: WorkEntityStore, asset_id: string) => {
    work.bindAssetObservations({ id: 'binding-body', asset_id, actor_ref: 'recipe:summarize-body-signals', source_ref: 'recipe:body', fields: ['observations.short_sleep'], enabled: true });
    return (observation: Record<string, unknown>) => work.writeAssetObservations({ binding_id: 'binding-body', actor_ref: 'recipe:summarize-body-signals',
      observations: { short_sleep: observation as never } }, NIGHT_END + HOUR);
  };
  it('accepts an until after as-of, stores it, and refuses one at or before it', () => {
    const s = stores(); const asset = s.put([rule()], null); const write = bound(s.work, asset.id);
    write(condition());
    expect(s.work.readAsset(asset.id)!.observations.short_sleep).toMatchObject({ active: true, until: MIDNIGHT, source: 'recipe:body' });
    expect(() => write(condition({ as_of: NIGHT_END + 2, until: NIGHT_END + 2 }))).toThrow('until must be a time after as-of');
    // The op still writes only what a condition is: an unknown key is refused.
    expect(() => write({ ...condition({ as_of: NIGHT_END + 3 }), expires: MIDNIGHT })).toThrow('Unexpected field');
  });
});

describe('D-340 states in the situation', () => {
  it('lists a holding state with the holds reason over its window, never as due', async () => {
    const s = stores(); const asset = s.put([rule()], condition()); await s.occurrences.reconcileAsset(asset.id);
    expect(await s.items()).toMatchObject([{ kind: 'asset_state', reasons: ['holds'], what: { value: 'Short night · Body' },
      when: { value: { from: NIGHT_END, to: MIDNIGHT } } }]);
    // The clock index finds it from its as-of and lets it lapse at its until.
    expect(s.clocks.rows(asset.id)).toMatchObject([{ rule_id: 'short_sleep', act_by_at: NIGHT_END, lapses_at: MIDNIGHT }]);
  });
  it('ends at its until with no writer, and nothing about it is left', async () => {
    const s = stores(); const asset = s.put([rule()], condition()); await s.occurrences.reconcileAsset(asset.id);
    s.at(MIDNIGHT + HOUR);
    expect(await s.items('tool')).toEqual([]);
    expect(await s.items()).toEqual([]);
  });
  it('holds with no until until a writer clears it', async () => {
    // Left out, not `undefined`: the store keeps only JSON values.
    const { until: _until, ...lasting } = condition();
    const s = stores(); const asset = s.put([rule()], lasting); await s.occurrences.reconcileAsset(asset.id);
    s.at(MIDNIGHT + 30 * DAY);
    expect(await s.items()).toMatchObject([{ kind: 'asset_state', reasons: ['holds'] }]);
    expect(s.clocks.rows(asset.id)).toMatchObject([{ act_by_at: NIGHT_END, lapses_at: null }]);
  });
  it('shows nothing for a condition its rule’s certainty does not accept, or one not active', async () => {
    const s = stores();
    const conditional = s.put([rule()], condition({ certainty: 'conditional' })); await s.occurrences.reconcileAsset(conditional.id);
    const clear = s.put([rule()], condition({ active: false })); await s.occurrences.reconcileAsset(clear.id);
    expect(await s.items()).toEqual([]);
  });
  it('shows every state that holds on Today, though a cluster shows a few items; the digest keeps its few', async () => {
    const s = stores();
    const fields = ['short_sleep', 'low_hrv', 'high_rhr', 'late_bed'];
    const asset = s.work.writeAsset({ source_id: 'recued.asset', source: { kind: 'owner', ref: 'owner' }, name: 'Body', dates: {},
      observations: Object.fromEntries(fields.map(field => [field, { ...condition(), source: 'owner' }])),
      rules: fields.map(field => rule({ id: field, title: field.replace('_', ' '), when: { kind: 'condition', field, certainty: 'confirmed' } })) } as never, NIGHT_END + HOUR);
    await s.occurrences.reconcileAsset(asset.id);
    const today = await s.items('today');
    expect(today.filter(item => item.kind === 'asset_state')).toHaveLength(4);
    const digest = await s.items('digest');
    expect(digest).toHaveLength(3);
  });
  it('leaves an ordinary condition rule as it was: due, not a state', async () => {
    const s = stores(); const task = rule({ id: 'check', title: 'Check sleep tracking', reaction: { notify: false, occurrence: 'notice', emit: false } });
    const asset = s.put([task], condition()); await s.occurrences.reconcileAsset(asset.id);
    const [item] = await s.items();
    expect(item).toMatchObject({ kind: 'asset_rule', reasons: expect.arrayContaining(['due']) });
    expect(item!.reasons).not.toContain('holds');
  });
});

describe('D-340 states on Today, kept out of the Agenda and Coming up until the stream', () => {
  const monday = Date.parse('2026-10-19T08:30:00Z');
  const state: SituationFact = { ref: { collection: 'asset', id: 'body', field: 'rules.short_sleep' }, title: 'Short night · Body', kind: 'asset_state',
    basis: 'declared', when: { from: monday - 2 * HOUR, to: monday + 16 * HOUR }, people: [], subjects: [{ collection: 'asset', id: 'body' }], related: [],
    evidence: [{ collection: 'asset', id: 'body', field: 'rules.short_sleep' }], updated_at: monday, consequence: 'routine' };
  const booking: SituationFact = { ref: { collection: 'booking', id: 'dentist' }, title: 'Dentist', kind: 'booking', basis: 'declared',
    when: { from: monday + 3 * HOUR, to: monday + 4 * HOUR }, act_by: monday + 3 * HOUR, people: [], subjects: [], related: [],
    evidence: [{ collection: 'booking', id: 'dentist' }], updated_at: monday, consequence: 'routine' };
  const scheduled = () => {
    const db = new Database(':memory:'); ensureWorkEntitySchema(db); const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
    const sources = ['asset', 'booking'].map(collection => ({ id: collection, collection, verb_op: 'core.work-entity.read',
      read: () => [state, booking].filter(row => row.ref.collection === collection) }));
    const query = createSituationQuery({ now: () => monday, sources, sourceForCollection: collection => ({ verb_op: 'core.work-entity.read', collection }) });
    const send = vi.fn(async (_message: import('../notification-handler.js').NotificationSendArgs) => ({ delivered_to: ['in_app'] }));
    const service = createScheduledSituations({ db, work, store: createSituationStore(db), query, timeZone: () => 'UTC', isVaultUnlocked: () => true,
      now: () => monday, isQuiet: () => false, quietEnd: () => null,
      overview: async () => ({ proposal_count: 0, newest_proposal: null, unmatched_replies: [], phone_ready: true }), send, mailHealth: () => [],
      summarize: () => Promise.resolve(undefined), prepNotesReady: () => false });
    service.bindAccess(createSituationAccess({ contracts: createContractStore(db), query, now: () => monday, isVaultUnlocked: () => true }));
    cleanups.push(async () => { await service.stop(); db.close(); });
    return { service, sent: () => send.mock.calls.map(([message]) => `${message.title}\n${message.text}`) };
  };
  it('keeps the state on Today with the holds reason', async () => {
    const f = scheduled();
    const items = (await f.service.today({ now: monday, before: monday + 7 * DAY })).situations.clusters.flatMap(cluster => cluster.items);
    // Today also marks what changed as related; what matters is holds, and never due.
    const held = items.find(item => item.kind === 'asset_state');
    expect(held).toMatchObject({ reasons: expect.arrayContaining(['holds']), what: { value: 'Short night · Body' } });
    expect(held!.reasons).not.toContain('due');
  });
  it('lists the day’s booking in the Agenda but not the state', async () => {
    const f = scheduled();
    f.service.setSettings({ frequency: 'off', day_of: false }); f.service.setAgenda({ enabled: true, time: '07:00', day: 'today' });
    await f.service.sendAgendaNow();
    expect(f.sent().join('\n')).toContain('Dentist');
    expect(f.sent().join('\n')).not.toContain('Short night');
  });
  it('sends Coming up with the booking but not the state', async () => {
    const f = scheduled();
    f.service.setSettings({ frequency: 'daily', time: '08:00', day_of: false });
    await f.service.sendNow();
    expect(f.sent().join('\n')).toContain('Dentist');
    expect(f.sent().join('\n')).not.toContain('Short night');
  });
});
