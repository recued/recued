import { expect, it } from 'vitest';
import { describePromptCron, promptRepeatCron, readPromptRepeat } from '../prompt-repeat.js';
import { parsePromptRecovery, promptDraftRequest, promptDraftTiming, promptDraftUpdate, promptEditOriginal, type PromptDraftEntry, type PromptDraftValues } from '../prompt-draft-recovery.js';
import { comparePromptEdits, mergePromptEdits } from '../prompt-edit-recovery.js';
import { searchRecoveryDrafts } from '../../data/recovery-draft-search.js';
import type { PromptSchedule } from '@recued/contracts';

const now = Date.parse('2026-10-31T12:00Z');
const values = (patch: Partial<PromptDraftValues> = {}): PromptDraftValues => ({ title: 'Renewal review', prompt: 'Review the customer renewal.', mode: 'recurring',
  oneOffZone: 'America/New_York', time: '', chosenAt: null, frequency: 'daily', clock: '09:15', weekday: '1', cron: '15 9 * * *', timezone: 'America/New_York',
  model: '', notify: false, creationId: crypto.randomUUID(), request: null, ...patch });
const draft = (input: PromptDraftValues): PromptDraftEntry => ({ id: 'pdr_' + crypto.randomUUID(), sourceId: 'scheduled_prompt', original: null,
  revision: 1, updatedAt: now, status: 'editing', values: input });
const saved = (): PromptSchedule => ({ schedule_id: 'original', session_id: 'conversation', revision: 1, created_at: now, title: 'Renewal review', prompt: 'Review the customer renewal.',
  mode: 'recurring', time_zone: 'America/New_York', cron_expression: '15 9 * * *', enabled: true, next_run_at: now + 1000, last_run_at: null, last_turn_id: null, last_status: null });

it('decodes selected days and monthly dates while leaving unrepresentable clock and calendar combinations custom', () => {
  expect(readPromptRepeat('15 9 * * 4,2')).toMatchObject({ frequency: 'selected_days', clock: '09:15', selectedWeekdays: ['2', '4'] });
  expect(describePromptCron('15 9 * * 4,2')).toContain('Tuesday, Thursday');
  expect(readPromptRepeat('30 17 * * 1-3,5')).toMatchObject({ frequency: 'selected_days', selectedWeekdays: ['1', '2', '3', '5'] });
  expect(readPromptRepeat('5 8 31 * *')).toMatchObject({ frequency: 'monthly', clock: '08:05', monthDay: '31' });
  for (const expression of ['0 9 15 * 2,4', '0 9 1 1 *', '5,35 8-17 * * 1-5', '0 9 * * */2'])
    expect(readPromptRepeat(expression).frequency).toBe('custom');
});

it('serializes selected days and month dates and rejects empty selections or invalid active dates', () => {
  expect(promptDraftTiming(values({ frequency: 'selected_days', selectedWeekdays: ['4', '2'] })))
    .toEqual({ mode: 'recurring', time_zone: 'America/New_York', cron_expression: '15 9 * * 2,4' });
  expect(promptDraftRequest(values({ frequency: 'monthly', monthDay: '31' }), { model: false, notify: false }).cron_expression).toBe('15 9 31 * *');
  expect(() => promptDraftTiming(values({ frequency: 'selected_days', selectedWeekdays: [] }))).toThrow('Choose at least one weekday');
  for (const monthDay of ['', '0', '32', '1.5'])expect(() => promptDraftTiming(values({ frequency: 'monthly', monthDay }))).toThrow('1 to 31');
  expect(promptDraftTiming(values({ frequency: 'weekly', weekday: '4', monthDay: '99', selectedWeekdays: [] })).cron_expression).toBe('15 9 * * 4');
});

it('keeps the original date/list/range spelling for unchanged timing so title edits do not clear skipped runs', () => {
  for (const cron of ['15 09 * * 4,2', '15 9 * * 1-3,5', '15 9 03 * *']) {
    const read = readPromptRepeat(cron);expect(promptRepeatCron({ ...read, cron })).toBe(cron);
    expect(promptRepeatCron({ ...read, cron, clock: '10:20' })).not.toBe(cron);
  }
});

it('retains incomplete new drafts and reads old drafts without inventing extra fields', () => {
  const old = draft(values());expect(parsePromptRecovery(old, now)).toEqual(old);
  for (const input of [values({ frequency: 'monthly', monthDay: '' }), values({ frequency: 'monthly', monthDay: '99' }), values({ frequency: 'selected_days', selectedWeekdays: [] })]) {
    const copy = draft(input);expect(parsePromptRecovery(copy, now)).toEqual(copy);
  }
  expect(parsePromptRecovery(draft(values({ frequency: 'monthly' })), now)).toBeNull();
  expect(parsePromptRecovery(draft(values({ frequency: 'selected_days', selectedWeekdays: ['2', '2'] })), now)).toBeNull();
});

it('binds pending creations and edits to the exact selected days and month date', () => {
  for (const input of [values({ frequency: 'monthly', monthDay: '31' }), values({ frequency: 'selected_days', selectedWeekdays: ['2', '4'] })]) {
    const copy = draft(input);copy.status = 'unknown';copy.attempt = crypto.randomUUID();copy.values.request = promptDraftRequest(input, { model: false, notify: false });
    expect(parsePromptRecovery(copy, now)).toEqual(copy);
    const changed = input.frequency === 'monthly' ? { monthDay: '30' } : { selectedWeekdays: ['3', '5'] };
    expect(parsePromptRecovery({ ...copy, values: { ...copy.values, ...changed } }, now)).toBeNull();
    copy.original = promptEditOriginal(saved());copy.values.request = null;copy.values.updateRequest = promptDraftUpdate(input, copy.original, { model: false, notify: false });
    expect(parsePromptRecovery(copy, now)).toEqual(copy);
    expect(parsePromptRecovery({ ...copy, values: { ...copy.values, ...changed } }, now)).toBeNull();
  }
});

it('carries the complete timing choice through a conflict in either direction', () => {
  const original = saved();
  const current = { ...original, revision: 2, cron_expression: '20 11 31 * *', time_zone: 'Asia/Tokyo' };
  const input = values({ frequency: 'selected_days', selectedWeekdays: ['2', '4'] });
  for (const choice of ['saved', 'mine'] as const) {
    const comparison = comparePromptEdits(original, input, current);comparison.choices.timing = choice;const merged = mergePromptEdits(comparison)!;
    expect(merged).toMatchObject(choice === 'mine' ? { frequency: 'selected_days', selectedWeekdays: ['2', '4'], timezone: 'America/New_York' } : { frequency: 'monthly', monthDay: '31', clock: '11:20', timezone: 'Asia/Tokyo' });
    expect(promptDraftUpdate(merged, current, { model: false, notify: false }).cron_expression).toBe(choice === 'mine' ? '15 9 * * 2,4' : '20 11 31 * *');
  }
});

it('finds active weekday and monthly choices in draft search without exposing hidden cadence fields', () => {
  const copies = [draft(values({ frequency: 'selected_days', selectedWeekdays: ['2', '4'], monthDay: '31' })), draft(values({ frequency: 'monthly', monthDay: '31', selectedWeekdays: ['1', '3'] }))];
  const stores = { prompt: { list: () => copies, get: (id: string) => copies.find(copy => copy.id === id) ?? null } };
  expect(searchRecoveryDrafts(stores, 'Tuesday Thursday 09:15').matches.map(match => match.id)).toEqual([copies[0]!.id]);
  expect(searchRecoveryDrafts(stores, 'selected weekdays Tuesday').matches.map(match => match.id)).toEqual([copies[0]!.id]);
  expect(searchRecoveryDrafts(stores, 'monthly 31').matches.map(match => match.id)).toEqual([copies[1]!.id]);
  expect(searchRecoveryDrafts(stores, 'Wednesday').matches).toEqual([]);
});
