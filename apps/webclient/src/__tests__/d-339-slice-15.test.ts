/** D-339 slice 15 (D-339 §6; D-342 §17) — a goal on a Body's reading, as the owner reads it:
 *  under the reading on the Body's page, on the Pursuits tab and its own page, in "Ask with the numbers",
 *  and as a "looks reached" proposal to mark. The numbers are the server's (`BodyGoalProgress`).
 *
 *  The page is driven in real Chrome by `scripts/drives/d-339-ask-with-numbers-live.mjs`; here, the
 *  words, the facts and the seams the page builds them in. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Asset, BodyGoalProgress } from '@recued/contracts';
import { goalAskWords, goalLineWords, goalProgressWords, goalTimeWords } from '../yours/body-goal-words.js';
import { bodyNumbersText } from '../yours/body-numbers-text.js';
import { PURSUIT_FACTS, pursuitFacts } from '../yours/pursuits.js';
import { readingDayDate } from '../yours/reading-words.js';

const NOW = new Date(2026, 10, 18, 9, 0, 0);
const goal = { asset_id: 'body-1', reading: 'weight' as const, target: 57, unit: 'kg', start: 62, start_day: '2026-11-17' };
const progress = (more: Partial<BodyGoalProgress> = {}): BodyGoalProgress => ({ pursuit_id: 'goal-1', name: "Weight goal · Anna's body",
  target_on: '2027-06-01', goal, way: 'down', now: { value: 58.1, day: '2026-11-18' }, to_go: 1.1, reached: false, ...more });

describe('D-339 slice 15 — a goal in the owner\'s words', () => {
  it('under its reading: the goal and its date, what is left, and the time at this pace', () => {
    expect(goalLineWords(progress({ per_week: 0.4, weeks_left: 2.75 }), NOW))
      .toBe(`Goal 57 kg by ${readingDayDate('2027-06-01', NOW)} · 1.1 kg to go · about 3 weeks at this pace`);
    // Moving away, there today, looks reached; no date, no pace.
    expect(goalLineWords(progress({ target_on: undefined, per_week: -0.2 }), NOW)).toBe('Goal 57 kg · 1.1 kg to go · moving away from it');
    expect(goalLineWords(progress({ target_on: undefined, to_go: 0, now: { value: 57, day: '2026-11-18' } }), NOW)).toBe('Goal 57 kg · there today');
    expect(goalLineWords(progress({ target_on: undefined, to_go: 0, reached: true }), NOW)).toBe('Goal 57 kg · looks reached');
  });

  it('says why there is nothing to say', () => {
    const none = { target_on: undefined, now: undefined, to_go: undefined };
    expect(goalLineWords(progress({ ...none, problem: 'other_unit' }), NOW)).toBe('Goal 57 kg · the weight is in another unit now, so set the goal again');
    expect(goalLineWords(progress({ ...none, problem: 'no_value' }), NOW)).toBe('Goal 57 kg · no weight yet');
    expect(goalLineWords(progress({ ...none, problem: 'body_gone' }), NOW)).toBe('Goal 57 kg · its Body is no longer active');
  });

  it('a pace\'s time as a person says it', () => {
    expect([0.5, 1.2, 2.75, 8.6, 9, 30].map(goalTimeWords)).toEqual(['less than a week', 'a week', '3 weeks', '9 weeks', '2 months', '7 months']);
  });

  it('on the Pursuits tab and its own page: the reading now, the goal, what is left, in place of a typed progress', () => {
    expect(goalProgressWords(progress())).toBe('Weight 58.1 kg now · goal 57 kg · 1.1 kg to go');
    expect(goalProgressWords(progress({ now: undefined, to_go: undefined, problem: 'no_value' }))).toBe('Goal 57 kg · no weight yet');
    const pursuit = { class_id: 'pursuit', status: 'active', name: "Weight goal · Anna's body", readings: { progress: { value: 3, unit: 'kg', as_of: 1, evidence: [] } },
      dates: { target_on: '2027-06-01' }, attributes: {}, settings: { goal } } as unknown as Asset;
    const facts = pursuitFacts(pursuit, 'line', progress());
    expect(facts.map(([label]) => label)).toEqual(['Goal', 'Target date']);
    expect(facts[0]).toEqual(['Goal', 'Weight 58.1 kg now · goal 57 kg · 1.1 kg to go', 'settings.goal']);
    expect(pursuitFacts(pursuit, 'page', progress()).map(([label]) => label)).toEqual(['Goal', 'Target date']);
    // Its kept goal is not listed again among the Facts.
    expect(PURSUIT_FACTS.has('settings.goal')).toBe(true);
  });

  it('in Ask with the numbers: the goal after the rest of the About line', () => {
    expect(goalAskWords(goal, '2027-06-01', NOW)).toBe(`goal weight 57 kg by ${readingDayDate('2027-06-01', NOW)}`);
    const text = bodyNumbersText('Anna’s body', [], { fields: [], days: 7, lenses: false, about: {
      weight: { value: 58.1, unit: 'kg', day: '2026-11-18' }, goals: [{ reading: 'weight', target: 57, unit: 'kg', target_on: '2027-06-01' }] } }, NOW.getTime())!;
    expect(text.split('\n')[1]).toBe(`About: weight 58.1 kg (${readingDayDate('2026-11-18', NOW)}) · goal weight 57 kg by ${readingDayDate('2027-06-01', NOW)}`);
  });
});

describe('⛔ D-339 slice 15 — the seams on the page', () => {
  const route = readFileSync(new URL('../yours/bootstrap-yours-route.ts', import.meta.url), 'utf8');
  const editor = readFileSync(new URL('../yours/pursuit-editor.ts', import.meta.url), 'utf8');

  it('shows a reading\'s goal on a Body from the server\'s progress, and offers Set a goal, or Change goal, on a body-composition reading with a value', () => {
    expect(route).toMatch(/const goalField = isBody && isBodyGoalField\(name\) \? name : undefined;/u);
    expect(route).toMatch(/snapshot\?\.goal_progress\?\.find\(row => row\.goal\.asset_id === asset\.id && row\.goal\.reading === goalField\)/u);
    expect(route).toMatch(/if \(goalField && reading\) button\(actions, goal \? 'Change goal' : 'Set a goal'/u);
  });

  it('a goal pursuit is not a Body, and its progress reading is its Body\'s, so its page leaves it out', () => {
    expect(route).toMatch(/const isBody = asset\.settings\.values_on_request === true && !isPursuit\(asset\);/u);
    expect(route).toMatch(/if \(name === 'progress' && pursuitGoal\) continue;/u);
    expect(editor).toMatch(/if \(goal\) \{\s+row\.hidden = true; counted\.hidden = true;/u);
  });

  it('sends the goal\'s number, never its start, which the server takes from the Body', () => {
    const save = route.slice(route.indexOf("if (value.type === 'goal') {"), route.indexOf("if (value.type === 'reading' || value.type === 'condition') {"));
    expect(save).toMatch(/action: 'goal\.set', asset_id: value\.body_id, reading: value\.field, target: number/u);
    // No `start` or `start_day` key goes with it.
    expect(save).not.toMatch(/\bstart(?:_day)?\s*:/u);
  });

  it('a looks-reached proposal is marked reached or kept going, with nothing to review and no correction', () => {
    expect(route).toMatch(/proposal\.kind === 'goal' \? 'Mark reached' : 'Accept'/u);
    expect(route).toMatch(/proposal\.kind === 'goal' \? 'Not yet' : 'Not now'/u);
    expect(route).toMatch(/if \(proposal\.kind !== 'goal'\) button\(actions, 'Review change'/u);
    expect(route).toMatch(/if \(proposal\.subject\?\.collection === 'asset' && proposal\.kind !== 'goal'\) button\(more, 'That’s wrong'/u);
  });

  it('Ask with the numbers ticks the Body\'s goals to start, and sends them', () => {
    expect(route).toMatch(/\.\.\.\(state\.include\.goals && goals\.length > 0 \? \{ goals: goals\.map\(row => \(\{ reading: row\.goal\.reading, target: row\.goal\.target, unit: row\.goal\.unit,/u);
  });
});
