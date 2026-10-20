import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { calendarDayMs, type AssetRule, type EpisodeInput, type ExecutionSource, type MailFactTypeId, type SituationDismissal, type SituationFact, type SituationRef } from '@recued/contracts';
import { createWarehouseEventBus } from '@recued/warehouse-events';
import { clockLearningProposals, kindLearningPool, learningPool, type ClockLearningSignal, type LearningTarget } from '../situations/learning.js';
import { createProactiveLearning } from '../situations/learning-runtime.js';
import { createEpisodeRuntime } from '../situations/episode-runtime.js';
import { createYoursService } from '../situations/yours-service.js';
import { createAssetOccurrenceService } from '../situations/asset-occurrence-service.js';
import { createWorkEntityDispatchers } from '../work-entity-ingredients.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import { autoRegisterRecuedBuiltinSources } from '../work-entity-source-boot.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { createSphereStore } from '../storage/sphere-store.js';
import { createSituationStore } from '../storage/situation-store.js';
import { createProactiveHistoryStore } from '../storage/proactive-history-store.js';
import { createProactiveProposalStore } from '../storage/proactive-proposal-store.js';
import { createAssetOccurrenceStore } from '../storage/asset-occurrence-store.js';
import { publishProposalEvents } from '../situations/proposal-events.js';
import { createMailFactStore } from '../storage/mail-fact-store.js';
import { createReminderStore } from '../storage/reminder-store.js';
import { buildSituationSources, situationSourceAccess } from '../situations/sources.js';
import { createSituationQuery } from '../situations/query.js';

const owner: ExecutionSource = { channel: 'user', actor: 'user_self', user_id: 'owner', client_token_id: 'paired' };
const source = { kind: 'owner' as const, ref: 'owner:local' };
const rule = (patch: Partial<AssetRule> = {}): AssetRule => ({ id: 'renew', title: 'Renew', when: { kind: 'expiry', field: 'expires_on' },
  enabled: true, muted: false, pinned: false, consequence: 'floor', expiry_policy: 'escalate_overdue',
  reaction: { notify: true, occurrence: 'action', emit: false }, schedule: { before: [{ amount: 30, unit: 'days' }], on_day: true }, ...patch });
const target = (value = rule()): LearningTarget => ({ ref: { collection: 'asset', id: 'future' }, name: 'Future', class_id: 'boiler', sphere: 'personal', rule: value, due_on: '2027-10-17' });
const signal = (index: number, patch: Partial<ClockLearningSignal> = {}, value = target()): ClockLearningSignal => ({ id: `signal-${index}`,
  pool: learningPool(value.class_id, value.sphere, value.rule), subject: { collection: 'commitment', id: `cycle-${index}` }, rule_id: value.rule.id,
  at: Date.parse(`202${index}-10-17`), outcome: 'fulfilled', actor: 'owner', due_on: `202${index}-10-10`, acted_on: `202${index}-10-17`, surfaced: 'unknown',
  evidence: [{ collection: 'asset', id: 'past' }], ...patch });
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
const fixture = () => {
  const db = new Database(':memory:'); ensureWorkEntitySchema(db); const work = createWorkEntityStore(db); autoRegisterRecuedBuiltinSources(work);
  let time = Date.parse('2026-10-17T12:00Z'); const now = () => time; const bus = createWarehouseEventBus(); const events: unknown[] = []; bus.subscribe('**', event => { events.push(event); });
  const dispatchers = createWorkEntityDispatchers({ store: work, resolver: createWorkEntityResolver(work), now, bus });
  const occurrences = createAssetOccurrenceService({ db, work, dispatchers, now, timeZone: () => 'UTC' });
  const spheres = createSphereStore(db, work); const situations = createSituationStore(db); const proposals = createProactiveProposalStore(db);
  const history = createProactiveHistoryStore(db, proposals); const rows = createAssetOccurrenceStore(db);
  const episodes = createEpisodeRuntime({ db, work, situations, calendars: () => [], now, timeZone: () => 'UTC', isVaultUnlocked: () => true });
  // As the composition root wires it: a type the owner made is named as they named it.
  const mail = createMailFactStore(db);
  const learning = createProactiveLearning({ db, work, spheres, situations, episodes, now, timeZone: () => 'UTC', isVaultUnlocked: () => true,
    kindName: kind => mail.getCustomType(kind)?.name });
  const yours = createYoursService({ db, work, dispatchers, occurrences, situations, spheres, learning, episodeRuntime: episodes, mailFacts: mail, now, timeZone: () => 'UTC' });
  const command = (input: Parameters<typeof yours.command>[0]) => yours.command(input, owner);
  const put = (name: string, expires_on = '2027-10-17') => {
    const asset = work.writeAsset({ source_id: 'recued.asset', source, name, class_id: 'boiler', dates: { expires_on }, rules: [rule()] }, time);
    spheres.setItem({ collection: 'asset', id: asset.id }, 'personal'); return asset;
  };
  const completed = async (index: number, owned = true) => {
    const due = `202${index}-10-10`; time = Date.parse(`202${index}-10-17T12:00Z`); const asset = put(`Past ${index}`, due);
    await occurrences.reconcileAsset(asset.id); const row = rows.byAsset(asset.id).find(row => row.commitment_id)!;
    await occurrences.completeOccurrence({ occurrence_id: row.id, answered_at: time, owner_action: owned }); return row;
  };
  const episode = (year: number): EpisodeInput => ({ id: `flowers-${year}`, title: 'Birthday flowers', class_id: 'flowers', when: { from: Date.parse(`${year}-10-24`), to: Date.parse(`${year}-10-24`) },
    people: ['ana'], subjects: [], evidence: [], basis: 'declared', sphere: 'personal', sensitive: [], storage_reason: 'owner_record' });
  const thing = (id: string, type: MailFactTypeId = 'bill'): SituationRef => {
    mail.saveThing({ thing_id: id, type, identity_keys: [`${type}:${id}`], variables: { issuer: `Issuer ${id}` }, passes: {}, variable_email_at: {},
      last_email_at: now(), missing: [], complete: true, created_at: now(), updated_at: now() });
    return { collection: 'mail_fact', id };
  };
  const fact = (kind: string, ref: SituationRef): SituationFact => ({ ref, kind, title: kind, basis: 'derived', people: [], subjects: [], related: [],
    evidence: [{ collection: ref.collection, id: ref.id }], updated_at: now(), consequence: 'routine' });
  cleanups.push(async () => { await yours.stop(); await learning.stop(); await episodes.stop(); bus.dispose(); db.close(); });
  return { db, work, rows, proposals, history, situations, spheres, episodes, learning, yours, command, put, completed, episode, events, mail, thing, fact,
    now, at: (date: string) => { time = Date.parse(date); } };
};

describe('D-325 bounded owner learning', () => {
  // Option A (§8): what the owner opens and sets aside from Today teaches how a kind that no
  // rule raises ranks. Before, a Today answer only hid its item and taught nothing.
  it('learns how a kind of Today item ranks from what the owner opened and set aside there, two-sided and inert until accepted', async () => {
    const f = fixture(); const { thing } = f;
    const [a, b, c, d, e, g] = ['a', 'b', 'c', 'd', 'e', 'g'].map(id => thing(`bill-${id}`));
    // The page's kind is a label: the item's own kind is what is learned.
    const answer = async (ref: SituationRef, code: SituationDismissal) => (await f.command({ action: 'situation.dismiss', ref, kind: 'shipment', code, label: 'A bill' })).id!;
    const open = (ref: SituationRef, from?: 'today') => f.command({ action: 'navigation.open', ref, ...(from ? { from } : {}) });
    const offers = () => f.proposals.list({ kind: 'ranking', state: 'proposed' }).filter(row => row.payload.item_kind === 'bill');
    await answer(a, 'not_now'); await answer(b, 'wrong'); await open(c);
    await answer({ collection: 'asset', id: 'passport', field: 'trip_validity:booking:trip' }, 'not_this_one');
    expect(f.learning.store.kindSignals(0)).toEqual([]);
    const undone = await answer(a, 'not_this_one'); await answer(b, 'not_this_one');
    await f.learning.tick(); expect(offers()).toEqual([]);
    await answer(c, 'never_this_kind');
    expect(f.learning.store.kindSignals(0).map(row => [row.kind, row.outcome])).toEqual([['bill', 'dismissed'], ['bill', 'dismissed'], ['bill', 'dismissed']]);
    await f.learning.tick();
    expect(offers()).toMatchObject([{ title: 'Rank bills lower in Today', payload: { ranking_factor: 0.5, baseline_weight: 1 } }]);
    expect(offers()[0]!.explanation).toContain('opened 0 and set aside 3 of the bills it showed');
    // Undo takes back what its answer taught, and an open from Today argues the other way.
    await f.command({ action: 'situation.restore', key: undone }); await open(d, 'today'); await open(a, 'today');
    await f.learning.tick(); expect(offers()).toEqual([]);
    await open(e, 'today'); await open(g, 'today'); await open(g, 'today'); await f.learning.tick();
    const [higher] = offers(); expect(higher).toMatchObject({ title: 'Rank bills higher in Today', payload: { ranking_factor: 1.2 } });
    // Nothing applies until the owner accepts it, and then only to that kind.
    const { fact } = f;
    expect(f.learning.rank(fact('bill', a))).toBe(1);
    expect((await f.command({ action: 'proposal.accept', ids: [higher!.id] })).changed).toBe(1);
    expect(f.learning.rank(fact('bill', a))).toBe(1.2); expect(f.learning.rank(fact('shipment', thing('ship-1', 'shipment')))).toBe(1);
    // A kind's weight applies to a mail fact only, whatever else shares the kind's name.
    f.learning.store.setWeight(kindLearningPool('travel_validity'), 1.5);
    expect(f.learning.rank(fact('travel_validity', { collection: 'asset', id: 'passport', field: 'trip_validity:booking:trip' }))).toBe(1);
  });
  // Option A promised travel and legal items never rank lower; a mail fact's consequence is
  // routine, so the query's own floor never covered a reservation or a tax form.
  it('never offers or applies a lower rank for reservations or tax forms', async () => {
    const f = fixture(); const { thing, fact } = f;
    const setAside = async (type: MailFactTypeId) => { for (const n of [1, 2, 3]) await f.command({ action: 'situation.dismiss', ref: thing(`${type}-${n}`, type), kind: type, code: 'not_this_one', label: type }); };
    f.mail.saveCustomType({ id: 'custom_rental', name: 'Rental invoice', description: '', variables: [], states: [], notices: [], identity: [] });
    await setAside('reservation'); await setAside('pay_tax_document'); await setAside('bill'); await setAside('custom_rental');
    expect(f.learning.store.kindSignals(0)).toHaveLength(12);
    await f.learning.tick();
    const offered = f.proposals.list({ kind: 'ranking', state: 'proposed' });
    expect(offered.map(row => row.title).sort()).toEqual(['Rank bills lower in Today', 'Rank “Rental invoice” items lower in Today']);
    // An offer made against a weight that has since changed is refused, not applied.
    f.learning.store.setWeight(kindLearningPool('bill'), 0.8);
    expect(await f.command({ action: 'proposal.accept', ids: [offered.find(row => row.payload.item_kind === 'bill')!.id] }))
      .toMatchObject({ changed: 0, failed: [{ reason: 'This ranking suggestion changed. Refresh it before accepting.' }] });
    // Made by hand or edited lower, it is refused; a weight stored below the start is not applied.
    const pool = kindLearningPool('reservation');
    const { id } = await f.command({ action: 'proposal.create', proposal: { key: 'owner:stays-lower', kind: 'ranking', title: 'Lower', explanation: 'Lower', sources: [],
      confidence: 'medium', origin: 'owner', payload: { learning_pool: pool, item_kind: 'reservation', ranking_factor: 0.5, baseline_weight: 1 } } });
    expect(await f.command({ action: 'proposal.accept', ids: [id!] })).toMatchObject({ changed: 0, failed: [{ reason: 'Choose a ranking factor from 1 to 1.5' }] });
    f.learning.store.setWeight(pool, 0.5); f.learning.store.setWeight(kindLearningPool('bill'), 0.5);
    expect(f.learning.rank(fact('reservation', thing('reservation-1', 'reservation')))).toBe(1);
    expect(f.learning.rank(fact('bill', thing('bill-1', 'bill')))).toBe(0.5);
  });
  // The weight is read off the item the mail-fact source builds, not one made by hand: its
  // kind must be the thing's type, as the server learns it.
  it('reorders Today by the weight accepted for a kind, through the real source and query', async () => {
    const f = fixture();
    const dated = (id: string, type: MailFactTypeId, variables: Record<string, string>) => f.mail.saveThing({ thing_id: id, type, identity_keys: [`${type}:${id}`], variables,
      passes: {}, variable_email_at: {}, last_email_at: f.now(), missing: [], complete: true, created_at: f.now(), updated_at: f.now() });
    dated('power', 'bill', { issuer: 'Acme Power', due_at: '2026-10-19' }); dated('parcel', 'shipment', { carrier: 'UPS', expected_at: '2026-10-18' });
    const sources = buildSituationSources({ db: f.db, work: f.work, reminders: createReminderStore(f.db), mailFacts: f.mail, calendars: () => [], now: f.now, timeZone: () => 'UTC' });
    const query = createSituationQuery({ sources, sourceForCollection: situationSourceAccess, now: f.now, rank: fact => f.learning.rank(fact) });
    const order = async () => (await query({ time: { from: f.now(), to: f.now() + 7 * 86_400_000 }, surface: 'today' }, { owner: true,
      grants: { isVerbOpGranted: () => true, isCollectionReadGranted: () => true, isTopicReadGranted: () => true } })).clusters.map(cluster => cluster.items[0]!.ref.id);
    expect(await order()).toEqual(['parcel', 'power']);
    f.learning.store.setWeight(kindLearningPool('bill'), 1.2);
    expect(await order()).toEqual(['power', 'parcel']);
  });
  it('learns delay by moving the reminder earlier without changing the deadline or switching a rule on', () => {
    const result = clockLearningProposals(target(), [signal(1), signal(2), signal(3)], []);
    expect(result.find(row => row.kind === 'schedule')!.payload.schedule).toEqual({ before: [{ amount: 30, unit: 'days' }, { amount: 44, unit: 'days' }], on_day: true });
    expect(result.every(row => row.origin === 'learner')).toBe(true); expect(result.some(row => 'expires_on' in row.payload)).toBe(false);
  });
  it('counts neither AI success nor another sphere, duplicate cycles, nor ignoring by itself', () => {
    expect(clockLearningProposals(target(), [signal(1, { actor: 'system' }), signal(2, { pool: 'another-sphere' }), signal(1)], [])).toEqual([]);
    const ignored = [1, 2, 3].map(index => signal(index, { outcome: 'lapsed', actor: 'system', acted_on: undefined, surfaced: 'unknown' }));
    expect(clockLearningProposals(target(), ignored, [])).toEqual([]);
    const unseen = ignored.map(row => ({ ...row, surfaced: 'none' as const }));
    expect(clockLearningProposals(target(), unseen, []).map(row => row.kind)).toEqual(['schedule', 'ranking']);
  });
  it('never lowers a consequence floor while explicit owner declines can reduce a routine ranking', () => {
    const declined = [1, 2, 3].map(index => signal(index, { outcome: 'dismissed', acted_on: undefined }));
    expect(clockLearningProposals(target(), declined, []).some(row => row.kind === 'ranking')).toBe(false);
    const routine = target(rule({ consequence: 'routine' }));
    const result = clockLearningProposals(routine, declined.map(row => ({ ...row, pool: learningPool(routine.class_id, routine.sphere, routine.rule) })), []);
    expect(result.find(row => row.kind === 'ranking')!.payload.ranking_factor).toBe(0.5);
  });
  it('offers an earlier missing-service cadence only after four confirmed dates, never adopting late servicing', () => {
    const value = target(rule({ when: { kind: 'interval', field: 'serviced_on', every: { amount: 12, unit: 'months' } } }));
    const services = [0, 1, 2, 3].map(index => ({ id: String(index), asset_id: 'past', pool: learningPool(value.class_id, value.sphere, value.rule),
      on: new Date(Date.parse('2021-01-01') + index * 300 * 86400000).toISOString().slice(0, 10), evidence: [value.ref] }));
    expect(clockLearningProposals(value, [], services.slice(0, 3))).toEqual([]);
    expect(clockLearningProposals(value, [], services)[0]!.payload.rule).toMatchObject({ enabled: false, pinned: false, when: { every: { amount: 300, unit: 'days' } } });
    expect(clockLearningProposals(value, [], services.map((row, index) => ({ ...row, on: new Date(Date.parse('2021-01-01') + index * 400 * 86400000).toISOString().slice(0, 10) })))) .toEqual([]);
  });
  it('derives proposals from actual canonical owner completions and applies one only after review', async () => {
    const f = fixture(); for (const year of [3, 4, 5]) await f.completed(year); await f.completed(2, false);
    f.at('2026-10-17T12:00Z'); const asset = f.put('Current'); const before = f.work.readAsset(asset.id)!;
    await f.learning.tick(); const proposal = f.proposals.list({ kind: 'schedule', subject: { collection: 'asset', id: asset.id } })[0]!;
    expect(proposal).toBeDefined(); expect(f.work.readAsset(asset.id)!.rules).toEqual(before.rules);
    const pool = learningPool('boiler', 'personal', before.rules[0]!); expect(f.learning.store.signals(pool, 0)).toHaveLength(3);
    expect((await f.command({ action: 'proposal.accept', ids: [proposal.id] })).changed).toBe(1);
    expect(f.work.readAsset(asset.id)).toMatchObject({ dates: before.dates, rules: [{ pinned: true, schedule: { before: [{ amount: 30 }, { amount: 44 }] } }] });
    expect(f.proposals.read(proposal.id)!.state).toBe('accepted');
  });
  it('retracts a stale suggestion after sphere/rule edits and refuses a floor-silencing edited offer', async () => {
    const f = fixture(); for (const year of [3, 4, 5]) await f.completed(year); f.at('2026-10-17'); const asset = f.put('Current'); await f.learning.tick();
    const proposal = f.proposals.list({ kind: 'schedule', subject: { collection: 'asset', id: asset.id } })[0]!;
    await f.command({ action: 'proposal.edit', id: proposal.id, payload: { ...proposal.payload, schedule: { before: [], on_day: false } } });
    const failed = await f.command({ action: 'proposal.accept', ids: [proposal.id] }); expect(failed.failed?.[0]?.reason).toContain('cannot silence');
    f.spheres.setItem({ collection: 'asset', id: asset.id }, 'professional'); f.learning.refreshPending(); expect(f.proposals.read(proposal.id)!.state).toBe('retracted');
    expect(f.work.readAsset(asset.id)!.rules[0]!.schedule.on_day).toBe(true);
  });
  it('learns relations only after three distinct owner trip openings and consumes an accepted relation in its sphere', async () => {
    const f = fixture(); const asset = f.put('Policy'); const refs: SituationRef[] = [];
    for (let index = 0; index < 3; index++) {
      const booking = f.work.writeBooking({ source_id: 'recued.booking', title: `Trip ${index}`, slot_start_at: f.now(), slot_end_at: f.now() + 86400000, source_extension_blob: { trip: { destination_country: 'FR' } } }, f.now());
      const ref = { collection: 'booking', id: booking.id }; f.spheres.setItem(ref, 'personal'); refs.push(ref);
      f.learning.recordOpened(ref, 'client'); f.learning.recordOpened({ collection: 'asset', id: asset.id }, 'client');
      f.learning.recordOpened({ collection: 'asset', id: asset.id }, 'client');
    }
    await f.learning.tick(); const proposal = f.proposals.list({ kind: 'relation' })[0]!; expect(proposal).toBeDefined(); expect(f.learning.store.relations()).toEqual([]);
    expect((await f.command({ action: 'proposal.accept', ids: [proposal.id] })).changed).toBe(1); expect(f.learning.store.relations()).toHaveLength(1);
    expect(f.learning.store.relations()[0]!.evidence).toEqual(expect.arrayContaining(refs));
  });
  it('asks once about a recurring occasion: next year’s offer replaces an open one, and an answered one is not asked again', async () => {
    const f = fixture(); f.situations.writeSetting('last_time.choice', 'on');
    const trip = (date: string) => f.history.saveEpisode({ ...f.episode(2000), id: `trip-${date}`, title: 'Las Vegas weekend',
      when: { from: Date.parse(date), to: Date.parse(date) } }, f.now());
    f.at('2025-10-20T12:00Z'); trip('2024-10-24'); trip('2025-10-16'); await f.learning.tick();
    const first = f.proposals.list({ kind: 'occasion', state: 'proposed' }); expect(first).toHaveLength(1);
    f.at('2026-10-20T12:00Z'); trip('2026-10-18'); await f.learning.tick();
    const open = f.proposals.list({ kind: 'occasion', state: 'proposed' });
    expect(open).toHaveLength(1); expect(open[0]!.id).not.toBe(first[0]!.id);
    expect(f.proposals.read(first[0]!.id)!.state).toBe('retracted');
    await f.command({ action: 'proposal.dismiss', id: open[0]!.id, code: 'not_now' });
    f.at('2027-10-20T12:00Z'); trip('2027-10-17'); await f.learning.tick();
    expect(f.proposals.list({ kind: 'occasion', state: 'proposed' })).toEqual([]);
  });
  it('uses three original accepted years for a standing task, gated by consent and current suppressions', async () => {
    const f = fixture(); f.situations.writeSetting('last_time.choice', 'on');
    for (const year of [2023, 2024, 2025]) {
      const episode = f.history.saveEpisode(f.episode(year), f.now()); const proposal = f.proposals.ensure({ key: `recall-${year}`, kind: 'recall', title: 'Flowers', explanation: 'Repeat',
        origin: 'learner', confidence: 'low', sources: [{ collection: 'episode', id: episode.id }], payload: { episode_id: episode.id, statement: 'Buy flowers', on: `${year}-10-24` } }, f.now());
      f.proposals.outcome(proposal.id, 'accepted', f.now());
    }
    await f.learning.tick(); const offer = f.proposals.list({ kind: 'habit', state: 'proposed' })[0]!;
    expect(offer).toBeDefined(); expect(f.history.occasions()).toEqual([]);
    const accepted = await f.command({ action: 'proposal.accept', ids: [offer.id] }); expect(accepted.failed).toBeUndefined(); expect(accepted.changed).toBe(1);
    const occasion = f.history.occasions()[0]!; expect(occasion.rules.some(row => row.enabled && row.reaction.occurrence === 'action' && row.expiry_policy === 'strict_expire')).toBe(true);
    expect(f.work.listCommitments().every(row => row.derivation === 'rule_emitted')).toBe(true);
    expect(f.history.episodes().every(row => row.occasion_id === occasion.id)).toBe(true);
    f.proposals.saveSuppression({ kind: 'proposal_kind', value: 'recall:flowers' }, f.now()); expect(f.learning.habitEvidenceAllowed(offer)).toBe(false);
    f.situations.writeSetting('last_time.choice', 'off'); expect(f.learning.memoryEvidenceAllowed(offer.payload.episode_ids)).toBe(false);
  });
  it('publishes a recalled owner task through the real canonical dispatcher exactly once', async () => {
    const f = fixture(); f.situations.writeSetting('last_time.choice', 'on'); const episode = f.history.saveEpisode(f.episode(2025), f.now());
    const proposal = f.proposals.ensure({ key: 'recall-live', kind: 'recall', title: 'Flowers', explanation: 'Repeat', origin: 'learner', confidence: 'low', sources: [],
      payload: { episode_id: episode.id, statement: 'Buy flowers', on: '2026-10-24' } }, f.now());
    expect((await f.command({ action: 'proposal.accept', ids: [proposal.id] })).changed).toBe(1);
    await f.command({ action: 'proposal.accept', ids: [proposal.id] });
    expect(f.work.listCommitments()).toHaveLength(1); expect(f.work.listCommitments()[0]!.promised_for_at).toBe(calendarDayMs('2026-10-24'));
    expect(f.events).toHaveLength(1); expect(f.events[0]).toMatchObject({ slug: 'commitment', prev: { record: { derivation: 'user_declared' } } });
  });
  it('keeps proposal outcomes atomic with their durable event and retries an unacknowledged revision once', () => {
    const f = fixture(); const proposal = f.proposals.ensure({ key: 'outbox', kind: 'occasion', title: 'Annual', explanation: 'Repeat', origin: 'learner', confidence: 'low', sources: [], payload: {} }, f.now());
    const acknowledge = vi.spyOn(f.proposals, 'acknowledgeEvent').mockImplementationOnce(() => { throw new Error('crash before acknowledgement'); });
    expect(() => publishProposalEvents(f.proposals, f.situations)).toThrow('crash'); expect(f.situations.revisionsAfter(0)).toHaveLength(1);
    acknowledge.mockRestore(); publishProposalEvents(f.proposals, f.situations); expect(f.situations.revisionsAfter(0)).toHaveLength(1);
    f.proposals.markShown(proposal.id, f.now()); expect(f.proposals.pendingEvents()).toEqual([]);
    f.proposals.outcome(proposal.id, 'not_now', f.now()); publishProposalEvents(f.proposals, f.situations); expect(f.situations.revisionsAfter(0)).toHaveLength(2);
    expect(f.situations.revisionsAfter(0)[1]!.after.state).toBe('dismissed');
  });
});
