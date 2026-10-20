import { describe, expect, it, vi } from 'vitest';
import type { SituationFact, SituationQuery } from '@recued/contracts';
import { createSituationQuery, SituationScanBoundError, type SituationSource } from '../situations/query.js';

const DAY = 86_400_000;
const now = Date.parse('2026-10-17T12:00Z');
const window = { from: now, to: now + 7 * DAY };
const fact = (id: string, patch: Partial<SituationFact> = {}): SituationFact => ({
  ref: { collection: 'task', id }, title: id, kind: 'task', basis: 'declared',
  when: { from: now + DAY, to: now + DAY }, act_by: now + DAY,
  people: [], subjects: [], related: [], evidence: [{ collection: 'task', id }],
  updated_at: now, consequence: 'routine', ...patch,
});
const setup = (facts: SituationFact[], options: { denied?: string[]; verbDenied?: string[]; owner?: boolean; spheres?: ('personal' | 'professional')[] } = {}) => {
  const sources: SituationSource[] = [...new Set(facts.map(item => item.ref.collection))].map(collection => ({
    id: collection, collection, verb_op: `read.${collection}`, read: vi.fn(() => facts.filter(item => item.ref.collection === collection)),
  }));
  const query = createSituationQuery({ sources, now: () => now, sourceForCollection: collection => ({ collection, verb_op: `read.${collection}` }) });
  return { sources, run: (input: Partial<SituationQuery> = {}) => query({ time: window, ...input }, {
    owner: options.owner ?? true, spheres: options.spheres,
    grants: { isCollectionReadGranted: key => !options.denied?.includes(key), isVerbOpGranted: key => !options.verbDenied?.includes(key), isTopicReadGranted: () => false },
  }) };
};
const items = (result: Awaited<ReturnType<ReturnType<typeof setup>['run']>>) => result.clusters.flatMap(cluster => cluster.items);

describe('D-325 shared situation query', () => {
  it('fences people and embedded traveller/holder references before relations, matching and clustering', async () => {
    const a = fact('a', { sphere: 'professional', people: ['private-person'],
      travel_document: { holder: 'private-person' }, trip: { subject: { collection: 'task', id: 'a' }, travellers: ['private-person'] } });
    const b = fact('b', { sphere: 'professional', people: ['private-person'] });
    const relate = vi.fn((_facts: readonly SituationFact[]) => []);
    const query = createSituationQuery({ sources: [{ id: 'task', collection: 'task', verb_op: 'read.task', read: () => [a, b] }],
      now: () => now, sourceForCollection: collection => ({ collection, verb_op: `read.${collection}` }), relate });
    const context = { owner: false, spheres: ['professional' as const], referenceSphere: (ref: { collection: string }) => ref.collection === 'contact' ? 'personal' as const : 'professional' as const,
      grants: { isVerbOpGranted: () => true, isCollectionReadGranted: () => true, isTopicReadGranted: () => false } };
    const result = await query({ time: window }, context);
    expect(JSON.stringify(result)).not.toContain('private-person');
    expect(result.clusters).toHaveLength(2);
    expect(relate.mock.calls[0]?.[0]).toEqual(expect.arrayContaining([expect.objectContaining({ people: [],
      travel_document: expect.objectContaining({ holder: undefined }), trip: expect.objectContaining({ travellers: [] }) })]));
    expect((await query({ time: window, people: ['private-person'], surface: 'prefetch' }, context)).clusters).toEqual([]);
  });
  it.each(['verb', 'data'])('keeps an ungranted contact out of an otherwise granted fact (%s)', async axis => {
    const result = await setup([fact('public', { people: ['secret@example.test'] })], axis === 'verb'
      ? { verbDenied: ['read.contact'] } : { denied: ['contact'] }).run();
    expect(items(result)[0]?.who.value).toBeNull();
    expect(JSON.stringify(result)).not.toContain('secret@example.test');
  });
  it('withholds an earlier source item moved out of scope while a later source was being read', async () => {
    let sphere: 'personal' | 'professional' = 'professional';
    const query = createSituationQuery({ now: () => now, sourceForCollection: collection => ({ collection, verb_op: `read.${collection}` }), sources: [
      { id: 'task', collection: 'task', verb_op: 'read.task', read: () => [fact('private-after-move', { sphere: 'professional' })] },
      { id: 'calendar', collection: 'calendar', verb_op: 'read.calendar', read: async () => { sphere = 'personal'; return []; } },
    ] });
    const result = await query({ time: window }, { owner: false, spheres: ['professional'], referenceSphere: () => sphere,
      grants: { isVerbOpGranted: () => true, isCollectionReadGranted: () => true, isTopicReadGranted: () => false } });
    expect(result).toEqual({ clusters: [], omitted: 0, ambiguous: [] });
  });
  it('keeps the owner’s other sources when one is over its bound and names it, and refuses a scoped contract', async () => {
    const grants = { isVerbOpGranted: () => true, isCollectionReadGranted: () => true, isTopicReadGranted: () => false };
    const over = (): SituationFact[] => { throw new SituationScanBoundError('Situation source exceeds its scan bound'); };
    const query = createSituationQuery({ now: () => now, sourceForCollection: collection => ({ collection, verb_op: `read.${collection}` }), sources: [
      { id: 'task', collection: 'task', verb_op: 'read.task', read: over },
      { id: 'booking', collection: 'booking', verb_op: 'read.booking', read: () => [fact('trip', { ref: { collection: 'booking', id: 'trip' }, kind: 'booking', sphere: 'personal' })] },
    ] });
    const owner = await query({ time: window }, { owner: true, grants });
    expect(owner.partial).toEqual(['task']); expect(owner.clusters.flatMap(cluster => cluster.items).map(item => item.ref.id)).toEqual(['trip']);
    expect((await query({ time: window }, { owner: false, all_spheres: true, grants })).partial).toEqual(['task']);
    await expect(query({ time: window }, { owner: false, spheres: ['personal'], grants })).rejects.toThrow(SituationScanBoundError);
    const broken = createSituationQuery({ now: () => now, sourceForCollection: collection => ({ collection, verb_op: `read.${collection}` }),
      sources: [{ id: 'task', collection: 'task', verb_op: 'read.task', read: () => { throw new Error('disk failed'); } }] });
    await expect(broken({ time: window }, { owner: true, grants })).rejects.toThrow('disk failed');
    const many = createSituationQuery({ now: () => now, sourceForCollection: collection => ({ collection, verb_op: `read.${collection}` }), sources: [
      { id: 'task', collection: 'task', verb_op: 'read.task', read: () => Array.from({ length: 20_001 }, (_, index) => fact(`t${index}`, { sphere: 'personal' })) },
    ] });
    expect((await many({ time: window }, { owner: true, grants })).partial).toEqual(['task']);
    await expect(many({ time: window }, { owner: false, spheres: ['personal'], grants })).rejects.toThrow(SituationScanBoundError);
  });
  it('filters both grant axes before the adapter, evidence, clustering or omitted count', async () => {
    const privateFact = fact('private', { ref: { collection: 'asset', id: 'private' }, consequence: 'floor' });
    const task = fact('public', { evidence: [{ collection: 'asset', id: 'private', value: 'private number' }, { collection: 'task', id: 'public' }],
      subjects: [{ collection: 'asset', id: 'private' }], related: [{ collection: 'asset', id: 'private' }] });
    for (const options of [{ denied: ['asset'] }, { verbDenied: ['read.asset'] }]) {
      const drive = setup([privateFact, task], options);
      const result = await drive.run();
      expect(drive.sources.find(source => source.collection === 'asset')?.read).not.toHaveBeenCalled();
      expect(items(result).map(item => item.ref.id)).toEqual(['public']);
      expect(result.omitted).toBe(0); expect(JSON.stringify(result)).not.toContain('private');
    }
  });
  it('returns a related near-miss with its own date and keeps unknown location unknown', async () => {
    const trip = fact('Lisbon trip', { related: [{ collection: 'asset', id: 'passport' }] });
    const passport = fact('Passport renewal', { ref: { collection: 'asset', id: 'passport' },
      when: { from: now + 80 * DAY, to: now + 80 * DAY }, act_by: now + 70 * DAY });
    const result = await setup([trip, passport]).run();
    expect(result.clusters).toHaveLength(1);
    const item = items(result).find(item => item.ref.id === 'passport')!;
    expect(item.when).toMatchObject({ value: passport.when, verdict: 'outside' });
    expect(item.where).toMatchObject({ value: null, verdict: 'unknown' });
    expect(item.reasons).toContain('related'); expect(item.basis).toBe('declared');
  });
  it('selects act-by rather than requiring the deadline itself in the window', async () => {
    const result = await setup([fact('renew', { act_by: now - 5 * DAY, when: { from: now + 180 * DAY, to: now + 180 * DAY } })]).run();
    expect(items(result)[0]?.reasons).toContain('due'); expect(items(result)[0]?.when.verdict).toBe('outside');
  });
  it('keeps the same trip identity as the query window moves and a related conflict joins it', async () => {
    const trip = fact('trip', { kind: 'booking', title: 'Lisbon trip', related: [{ collection: 'asset', id: 'passport' }] });
    const first = await setup([trip]).run();
    const later = await setup([trip, fact('passport', { ref: { collection: 'asset', id: 'passport' }, consequence: 'floor',
      subjects: [{ collection: 'asset', id: 'passport' }] })]).run({ time: { from: now + 1000, to: window.to + 1000 } });
    expect(later.clusters[0]?.id).toBe(first.clusters[0]?.id);
    expect(later.clusters[0]?.span).toEqual(trip.when);
    expect(later.clusters[0]?.items).toHaveLength(2);
  });
  it('selects changes and missing evidence without inventing a date', async () => {
    const result = await setup([fact('No boiler service', { when: undefined, act_by: undefined, missing: true,
      updated_at: now + 1, subjects: [{ collection: 'asset', id: 'boiler' }] })]).run({ changed_since: now, subjects: [{ collection: 'asset', id: 'boiler' }] });
    expect(items(result)[0]?.reasons).toContain('missing'); expect(items(result)[0]?.when.verdict).toBe('unknown');
  });
  it('withholds unknown and disallowed spheres from a scoped door, including relations', async () => {
    const result = await setup([fact('work', { sphere: 'professional' }), fact('home', { sphere: 'personal', related: [{ collection: 'task', id: 'work' }] }), fact('unknown')],
      { owner: false, spheres: ['professional'] }).run();
    expect(items(result).map(item => item.ref.id)).toEqual(['work']); expect(result.omitted).toBe(0);
  });
  it('caps inferred items at one per cluster, items at three, and clusters at five', async () => {
    const facts = [0, 1, 2, 3, 4].map(index => fact(`shared-${index}`, { basis: 'inferred', subjects: [{ collection: 'asset', id: 'shared' }] }));
    for (let index = 0; index < 12; index += 1) facts.push(fact(`separate-${index}`));
    const result = await setup(facts).run({ limit_clusters: 100, limit_items: 100 });
    expect(result.clusters).toHaveLength(5);
    expect(result.clusters.every(cluster => cluster.items.length <= 3 && cluster.items.filter(item => item.basis === 'inferred').length <= 1)).toBe(true);
    expect(result.omitted + items(result).length).toBe(17);
  });
  it('clusters overlapping dates only with a real shared person or normalized place', async () => {
    const result = await setup([fact('a', { place: { key: 'city:las-vegas', name: 'LV' } }), fact('b', { place: { key: 'city:las-vegas', name: 'Las Vegas' } }), fact('c')]).run();
    expect(result.clusters.map(cluster => cluster.items.length).sort()).toEqual([1, 2]);
    expect(items(result).filter(item => item.reasons.includes('collides'))).toHaveLength(2);
  });
  it('expires trip context and never injects episodes or last-time into prefetch', async () => {
    const result = await setup([fact('Lisbon old trip', { valid_until: now - 1 }), fact('Lisbon episode', { ref: { collection: 'episode', id: 'e' }, last_time: true }), fact('Lisbon trip')])
      .run({ surface: 'prefetch', text: 'Lisbon', include_last_time: true });
    expect(items(result).map(item => item.what.value)).toEqual(['Lisbon trip']);
  });
  it('adds nothing on a prefetch miss and reports duplicate names as ambiguous', async () => {
    const drive = setup([fact('a', { title: 'Passport' }), fact('b', { title: 'Passport' })]);
    expect(await drive.run({ surface: 'prefetch', text: 'weather' })).toEqual({ clusters: [], omitted: 0, ambiguous: [] });
    expect((await drive.run({ surface: 'prefetch', text: 'Passport' })).ambiguous).toEqual([{ name: 'passport', choices: [{ collection: 'task', id: 'a' }, { collection: 'task', id: 'b' }] }]);
  });
});
