import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { nextAnnualDate, type EpisodeInput } from '@recued/contracts';
import { createProactiveProposalStore } from '../storage/proactive-proposal-store.js';
import { createProactiveHistoryStore, episodeCandidateId } from '../storage/proactive-history-store.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const fixture = () => { const db = new Database(':memory:'); databases.push(db); const proposals = createProactiveProposalStore(db); return { proposals, history: createProactiveHistoryStore(db, proposals) }; };
const draft = (): EpisodeInput => ({ title: 'Las Vegas trip', when: { from: 100, to: 200 }, people: ['ana'], where: { key: 'vegas', name: 'Las Vegas' },
  subjects: [], evidence: [{ collection: 'calendar', id: 'trip' }, { collection: 'mail', id: 'checkin' }], basis: 'derived', sensitive: [], storage_reason: 'proposal_citation' });
describe('D-325 durable episodes, occasions and recall evidence', () => {
  it('rings a leap-day occasion every year without storing a rolled-forward date', () => {
    const { history } = fixture(); const occasion = history.saveOccasion({ title: 'Leap birthday', month_day: '--02-29', people: ['ana'], muted: false, rules: [] }, 1000);
    expect(nextAnnualDate(occasion.month_day, '2096-01-01')).toBe('2096-02-29');
    // P27: a common year has 28 February in its place, the century's 2100 included.
    expect(nextAnnualDate(occasion.month_day, '2097-01-01')).toBe('2097-02-28');
    expect(nextAnnualDate(occasion.month_day, '2100-01-01')).toBe('2100-02-28');
    expect(nextAnnualDate(occasion.month_day, '2027-03-01')).toBe('2028-02-29');
    expect(nextAnnualDate('12-31', '9999-12-31')).toBe('9999-12-31'); expect(nextAnnualDate('02-29', '9999-12-31')).toBeNull();
    expect(history.occasion(occasion.id)!.month_day).toBe('02-29');
    expect(occasion.rules[0]).toMatchObject({ when: { field: 'next_on' }, reaction: { occurrence: 'notice' }, schedule: { before: [{ amount: 1, unit: 'weeks' }] } });
  });
  it('retains an episode only with an identity reason, refuses future claims, and applies the one suppression list', () => {
    const { history, proposals } = fixture();
    expect(() => history.saveEpisode({ ...draft(), storage_reason: 'harvest' as never }, 1000)).toThrow('reason');
    expect(() => history.saveEpisode({ ...draft(), when: { from: 100, to: 2000 } }, 1000)).toThrow('future');
    const episode = history.saveEpisode(draft(), 1000); expect(history.episodes()).toHaveLength(1); expect(history.suppressed(episode)).toBe(false);
    proposals.saveSuppression({ kind: 'person', value: 'ana' }, 1001); expect(history.suppressed(episode)).toBe(true);
    const id = proposals.suppressions()[0]!.id; proposals.deleteSuppression(id); expect(history.suppressed(episode)).toBe(false);
    proposals.saveSuppression({ kind: 'date_range', from: 150, to: 300 }, 1002); expect(history.suppressed(episode)).toBe(true);
    history.deleteEpisode(episode.id, 1003); expect(history.episodes()).toEqual([]); expect(proposals.suppressions().some(row => row.kind === 'episode' && row.value === episode.id)).toBe(true);
  });
  it('unifies only confirmed place aliases and rolls back conflicting names without changing the earlier place', () => {
    const { history } = fixture(); const vegas = history.savePlace({ name: 'Las Vegas', aliases: ['LV', 'The hotel, Las Vegas'] });
    expect(history.place(' lv ')).toEqual(vegas); expect(history.place('The hotel, Las Vegas')).toEqual(vegas);
    const other = history.savePlace({ name: 'Laval', aliases: [] });
    expect(() => history.savePlace({ key: other.key, name: 'Changed', aliases: ['LV'] })).toThrow('different place');
    expect(history.place('Laval').name).toBe('Laval'); expect(history.place('LV')).toEqual(vegas);
  });
  it('keeps dark scoring separate from retained episodes and records each observed score once', () => {
    const { history } = fixture();
    for (let index = 0; index < 5; index++) history.darkCandidate({ id: `candidate-${index}`, class_id: 'flowers', episode: draft(), window: { from: 100, to: 200 } }, 1000);
    expect(history.episodes()).toEqual([]); expect(history.darkRates()).toEqual([]);
    expect(() => history.scoreDarkCandidate('candidate-0', true, null, 2000)).toThrow('evidence');
    for (let index = 0; index < 5; index++) history.scoreDarkCandidate(`candidate-${index}`, index !== 4, index !== 4 ? { collection: 'mail_fact', id: `purchase-${index}` } : null, 2000);
    history.scoreDarkCandidate('candidate-0', false, null, 2001);
    expect(history.darkRates()).toEqual([{ class_id: 'flowers', scored: 5, relevant: 4, rate: 0.8 }]); expect(history.darkPending()).toEqual([]);
    expect(episodeCandidateId([{ collection: 'calendar', id: 'trip' }, { collection: 'mail', id: 'trace' }]))
      .toBe(episodeCandidateId([{ collection: 'mail', id: 'trace' }, { collection: 'calendar', id: 'trip' }, { collection: 'mail', id: 'trace' }]));
  });
});
