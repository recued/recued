/** D-407 slice 4c — an occasion and its own calendar event are one line in Today. The server puts the occasion's items
 *  in its event's situation (they share the occasion as a subject); Today then hangs that situation on the event's own
 *  line, and makes no line of its own for it. Before, the occasion's situation was a second line beside the event. */
import type { ProactiveToday, SituationCluster, SituationItem } from '@recued/contracts';
import { describe, expect, it } from 'vitest';
import { loadToday, todayWindow } from '../../data/today-view.js';

const now = new Date(2026, 9, 20, 18).getTime();
const hour = 3_600_000;
const { tomorrow } = todayWindow(now);
const at = tomorrow + 10.5 * hour;
const dimension = <T>(value: T | null, verdict: 'match' | 'unknown') => ({ value, verdict, basis: 'declared' as const, evidence: [] });
const item = (ref: SituationItem['ref'], kind: string, title: string): SituationItem => ({ ref, kind, basis: 'declared', what: dimension(title, 'match'),
  when: dimension({ from: at, to: at + hour }, 'match'), where: dimension(null, 'unknown'), who: dimension(null, 'unknown'),
  reasons: ['due'], evidence: [], consequence: 'routine', updated_at: now });
const event = item({ collection: 'calendar', id: 'personal:rec-lee' }, 'calendar', 'Dr. Lee');
const occasion = item({ collection: 'occasion', id: 'occ-lee', field: 'rules.date' }, 'occasion', 'Dr. Lee');
const cluster = (id: string, items: SituationItem[]): SituationCluster => ({ id, subjects: [], span: { from: at, to: at + hour }, omitted: 0, items });
const proactive = (clusters: SituationCluster[]): ProactiveToday => ({ situations: { clusters, omitted: 0, ambiguous: [] }, summaries: {},
  occurrences: [], proposal_count: 0, newest_proposal: null, unmatched_replies: [], phone_ready: true });
const record = (record_id: string, summary: string, start_at: number) =>
  ({ record_id, hot_fields: { summary, start_at, end_at: start_at + hour, is_all_day: false, status: 'confirmed' } });

/** Today over one calendar holding Dr. Lee's own event and a team sync, with the situations the server sent. */
const today = (sent: ProactiveToday) => loadToday({
  workEntitySourceListCaller: async () => ({ sources: [] }), workEntityListCaller: async () => ({ entities: [], total: 0 }),
  collectionListInstancesCaller: async () => ({ instances: [{ platform: 'calendar', slug: 'personal' }] }),
  collectionListCaller: async ({ offset, filters }: { offset: number; filters: { is_all_day: boolean } }) =>
    ({ records: offset === 0 && !filters.is_all_day ? [record('rec-lee', 'Dr. Lee', at), record('rec-sync', 'Team sync', at + 2 * hour)] : [] }),
  proactiveTodayCaller: async () => sent,
} as unknown as Parameters<typeof loadToday>[0], now);

describe('D-407 slice 4c — one line in Today for an occasion and its own event', () => {
  it('in its event\'s situation, the occasion rides on the event\'s line; on its own, it was a second line', async () => {
    const one = await today(proactive([cluster('lee', [occasion, event])]));
    expect(one.items.map(line => line.title)).toEqual(['Dr. Lee', 'Team sync']);
    expect(one.items[0]).toMatchObject({ key: 'calendar:personal:rec-lee', kind: 'calendar' });
    expect(one.items[0]!.cluster?.items.map(value => value.kind)).toEqual(['occasion', 'calendar']);
    const two = await today(proactive([cluster('lee-occasion', [occasion]), cluster('lee-event', [event])]));
    expect(two.items.map(line => line.title)).toEqual(['Dr. Lee', 'Dr. Lee', 'Team sync']);
  });
});
