import { describe, expect, it } from 'vitest';
import { calendarDayMs, type Commitment } from '@recued/contracts';
import { dayAfter, dueDayText, dueOnText, renewalDateWords, taskDueWords } from '../yours/due-words.js';

type Task = Pick<Commitment, 'due_status' | 'promised_for_at' | 'lifecycle_state'>;
const day = calendarDayMs('2027-04-01')!;
const task = (patch: Partial<Task>): Task => ({ due_status: 'not_due', promised_for_at: day, lifecycle_state: 'pending', ...patch });

describe('D-325 §15.2 amendment — a task under Due says its deadline in words', () => {
  it('says each deadline as a person would, never the stored values', () => {
    expect(taskDueWords(task({}), 'en-US')).toBe('Due Apr 1, 2027');
    expect(taskDueWords(task({ due_status: 'due_soon' }), 'en-US')).toBe('Due soon, on Apr 1, 2027');
    expect(taskDueWords(task({ due_status: 'overdue' }), 'en-US')).toBe('Overdue since Apr 1, 2027');
    expect(taskDueWords(task({ due_status: 'no_deadline', promised_for_at: undefined }), 'en-US')).toBe('No deadline');
    for (const status of ['not_due', 'due_soon', 'overdue'] as const) {
      expect(taskDueWords(task({ due_status: status, promised_for_at: undefined }), 'en-US')).toBe({ not_due: 'Not due yet', due_soon: 'Due soon', overdue: 'Overdue' }[status]);
    }
  });

  it('adds how a closed task closed, and says an unknown status or state rather than guessing', () => {
    expect(taskDueWords(task({ lifecycle_state: 'fulfilled' }), 'en-US')).toBe('Due Apr 1, 2027 · Done');
    expect(taskDueWords(task({ due_status: 'overdue', lifecycle_state: 'expired' }), 'en-US')).toBe('Overdue since Apr 1, 2027 · Expired');
    // A newer server's words, as `Commitment` cannot type them.
    expect(taskDueWords(task({ due_status: 'due_today' as never }), 'en-US')).toBe('due today · Apr 1, 2027');
    expect(taskDueWords(task({ lifecycle_state: 'on_hold' as never }), 'en-US')).toBe('Due Apr 1, 2027 · on hold');
  });

  it('reads a whole day in UTC, so the day it names never moves with the time zone', () => {
    // Stored as UTC midnight: a zone west of UTC, read locally, would say March 31.
    expect(dueDayText(day, 'en-US')).toBe('Apr 1, 2027');
    expect(dueDayText(day, 'en-GB')).toBe('1 Apr 2027');
    expect(dueOnText('2027-04-01', 'en-US')).toBe('Apr 1, 2027');
    // Text that names no day is shown as it came, never as a different day.
    expect(dueOnText('2027-02-30', 'en-US')).toBe('2027-02-30');
  });

  it('asks a renewal for the date that replaces its own, from the day after it (§15.7, 2026-10-24)', () => {
    expect(['expires_on', 'renews_on', 'legal_check_on', 'membership_ends_on'].map(field => renewalDateWords(field)))
      .toEqual(['New expiry date', 'New renewal date', 'Next legal check date', 'New date']);
    expect(['2027-04-17', '2027-12-31', '2028-02-28', '2027-02-30'].map(dayAfter)).toEqual(['2027-04-18', '2028-01-01', '2028-02-29', null]);
  });
});
