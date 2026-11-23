/** D-343 (the owner's day over Telegram, 2026-11-14) — asked to move a call "to 5 pm today", the
 *  model wrote the Unix ms for 5 pm the NEXT day, the approval read "due_at: 16 Nov 2026, 17:00 UTC",
 *  and the chat said "today". A work tool's `due_at` may now be the day, or the day and time on the
 *  user's clock, converted where the dispatch begins; and the approval shows it on that clock. */
import { describe, expect, it } from 'vitest';
import { tier1CallDetails } from '@recued/contracts';
import { dueValueLabels, withTurnDates } from '../chat-clock.js';

describe('D-343 — a due date as the user means it', () => {
  it('converts the day and time on the turn\'s clock, and the day alone as a date-only due', () => {
    expect(withTurnDates('work.update', { kind: 'task', id: 't', due_at: '2026-11-15T17:00' }, 'Europe/Dublin'))
      .toEqual({ kind: 'task', id: 't', due_at: Date.parse('2026-11-15T17:00:00Z') });
    expect(withTurnDates('work.create', { kind: 'task', title: 'x', due_at: '2026-07-15T17:00' }, 'Europe/Dublin'))
      .toMatchObject({ due_at: Date.parse('2026-07-15T16:00:00Z') });
    expect(withTurnDates('work.create', { kind: 'task', title: 'x', due_at: '2026-11-15' }, 'America/Los_Angeles'))
      .toMatchObject({ due_at: Date.parse('2026-11-15T00:00:00Z') });
    // Unix ms, anything it cannot read, and other tools, as they came.
    expect(withTurnDates('work.update', { due_at: 1 }, 'UTC')).toEqual({ due_at: 1 });
    expect(withTurnDates('work.update', { due_at: 'tomorrow' }, 'UTC')).toEqual({ due_at: 'tomorrow' });
    expect(withTurnDates('calendar.update', { due_at: '2026-11-15T17:00' }, 'UTC')).toEqual({ due_at: '2026-11-15T17:00' });
  });

  it('labels it on the owner\'s clock, under "Due"', () => {
    const at = Date.parse('2026-11-15T17:00:00Z');
    expect(dueValueLabels('work.update', { due_at: at }, 'Europe/Dublin')).toEqual({ due_at: { [String(at)]: 'Sun 15 Nov, 17:00' } });
    expect(dueValueLabels('work.update', { due_at: at }, 'America/New_York')).toEqual({ due_at: { [String(at)]: 'Sun 15 Nov, 12:00' } });
    const day = Date.parse('2026-11-15T00:00:00Z');
    expect(dueValueLabels('work.create', { due_at: day }, 'America/Los_Angeles')).toEqual({ due_at: { [String(day)]: 'Sun 15 Nov' } });
    expect(dueValueLabels('memory.write', { due_at: at }, 'UTC')).toBeUndefined();
    // D-343 (the owner's day audit, 2026-11-15) — a change says what it was: a date-only due, none, or the same.
    expect(dueValueLabels('work.update', { due_at: at }, 'Europe/Dublin', day)).toEqual({ due_at: { [String(at)]: 'Sun 15 Nov → 17:00 that day' } });
    expect(dueValueLabels('work.update', { due_at: at }, 'Europe/Dublin', Date.parse('2026-11-15T09:00:00Z')))
      .toEqual({ due_at: { [String(at)]: 'Sun 15 Nov, 09:00 → 17:00' } });
    expect(dueValueLabels('work.update', { due_at: at }, 'Europe/Dublin', Date.parse('2026-11-14T00:00:00Z')))
      .toEqual({ due_at: { [String(at)]: 'Sat 14 Nov → Sun 15 Nov, 17:00' } });
    expect(dueValueLabels('work.update', { due_at: at }, 'Europe/Dublin', null)).toEqual({ due_at: { [String(at)]: 'no due date → Sun 15 Nov, 17:00' } });
    expect(dueValueLabels('work.update', { due_at: at }, 'Europe/Dublin', at)).toEqual({ due_at: { [String(at)]: 'Sun 15 Nov, 17:00' } });
    const shown = tier1CallDetails('work.update', { kind: 'task', id: 't', due_at: at }, { due_at: { [String(at)]: 'Sun 15 Nov, 17:00' } });
    expect(shown.args).toHaveProperty('Due', at);
    expect(shown.args).not.toHaveProperty('due_at');
    expect(shown.labels).toEqual({ Due: { [String(at)]: 'Sun 15 Nov, 17:00' } });
  });
});
