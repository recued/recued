/** `date_from_text` — the time an English phrase names, on the owner's clock.
 *
 *  ⛔ What matters most here is what it does NOT read: a reminder set from a
 *  false match ("buy 3 apples", "today's agenda", "I may call") is worse than
 *  none, which falls back to the recipe's default and says so. */

import { describe, expect, it } from 'vitest';

import { date_from_text } from '../time-phrase.js';

/** Wednesday 14 October 2026, 10:00 in New York (EDT, UTC-4). */
const NOW = Date.UTC(2026, 9, 14, 14, 0);
const NY = 'America/New_York';
const ctx = (now = NOW) => ({ resolve: () => undefined, evaluate: () => false, now: () => new Date(now) });

type Read = { at: number | null; text: string; phrase: string | null };
const read = (input: unknown, opts: { zone?: string; default_time?: string; now?: number } = {}): Read =>
  date_from_text(
    { input, time_zone: opts.zone ?? NY, ...(opts.default_time !== undefined ? { default_time: opts.default_time } : {}) },
    ctx(opts.now),
  ) as Read;
const at = (input: string, opts: { zone?: string; default_time?: string; now?: number } = {}): string | null => {
  const r = read(input, opts);
  return r.at === null ? null : new Date(r.at).toISOString();
};
/** New York wall clock → ISO instant (EDT until 1 Nov 2026, EST after). */
const ny = (date: string, time: string, offset = '-04:00'): string => new Date(`${date}T${time}:00${offset}`).toISOString();

describe('date_from_text — days', () => {
  it('reads today, tonight and tomorrow, with the default time or its own', () => {
    expect(at('tomorrow')).toBe(ny('2026-10-15', '09:00'));
    expect(at('tomorrow', { default_time: '07:30' })).toBe(ny('2026-10-15', '07:30'));
    expect(at('today')).toBe(ny('2026-10-14', '09:00'));
    expect(at('tonight')).toBe(ny('2026-10-14', '20:00'));
    expect(at('tonight at 10')).toBe(ny('2026-10-14', '22:00'));
    expect(at('Tomorrow at 9AM')).toBe(ny('2026-10-15', '09:00'));
  });

  it('reads a weekday as the next one after today, this / next / on included', () => {
    expect(at('friday')).toBe(ny('2026-10-16', '09:00'));
    expect(at('on Friday at 3pm')).toBe(ny('2026-10-16', '15:00'));
    expect(at('3pm on friday')).toBe(ny('2026-10-16', '15:00'));
    expect(at('this friday')).toBe(ny('2026-10-16', '09:00'));
    expect(at('next friday')).toBe(ny('2026-10-16', '09:00'));
    // Today is a Wednesday: "wednesday" is next week's.
    expect(at('wednesday')).toBe(ny('2026-10-21', '09:00'));
    expect(at('next week')).toBe(ny('2026-10-19', '09:00'));
  });

  it('reads a bare hour next to a day the way people say one', () => {
    expect(at('friday at 5')).toBe(ny('2026-10-16', '17:00'));
    expect(at('friday at 8')).toBe(ny('2026-10-16', '08:00'));
    expect(at('friday at 12')).toBe(ny('2026-10-16', '12:00'));
    expect(at('friday at 20')).toBe(ny('2026-10-16', '20:00'));
  });

  it('reads a date, the next one when it names no year', () => {
    expect(at('oct 20')).toBe(ny('2026-10-20', '09:00'));
    expect(at('October 20th at 2pm')).toBe(ny('2026-10-20', '14:00'));
    expect(at('20 october')).toBe(ny('2026-10-20', '09:00'));
    expect(at('the 20th of October')).toBe(ny('2026-10-20', '09:00'));
    expect(at('2026-10-20')).toBe(ny('2026-10-20', '09:00'));
    expect(at('Oct 20, 2027')).toBe(ny('2027-10-20', '09:00'));
    // Gone this year: next year's.
    expect(at('oct 1')).toBe(ny('2027-10-01', '09:00'));
    // Leap day: the next year that has one.
    expect(at('feb 29')).toBe(ny('2028-02-29', '09:00', '-05:00'));
  });

  it('a day that does not exist is no day', () => {
    expect(read('feb 30')).toEqual({ at: null, text: 'feb 30', phrase: null });
    expect(read('2026-13-01').at).toBeNull();
  });

  it('keeps the wall clock across a change of the clocks', () => {
    // The US leaves summer time on 1 November 2026.
    expect(at('Pay rent by Nov 1')).toBe(ny('2026-11-01', '09:00', '-05:00'));
    expect(at('in 2 months')).toBe(ny('2026-12-14', '10:00', '-05:00'));
  });
});

describe('date_from_text — times, parts of the day and spans', () => {
  it('a time with no day is the next one', () => {
    expect(at('at 5pm')).toBe(ny('2026-10-14', '17:00'));
    expect(at('at 9am')).toBe(ny('2026-10-15', '09:00'));
    expect(at('9:30 p.m.')).toBe(ny('2026-10-14', '21:30'));
    expect(at('21:15')).toBe(ny('2026-10-14', '21:15'));
    expect(at('9:30')).toBe(ny('2026-10-15', '09:30'));
    expect(at('noon')).toBe(ny('2026-10-14', '12:00'));
    expect(at('12am')).toBe(ny('2026-10-15', '00:00'));
  });

  it('reads a part of the day', () => {
    expect(at('tomorrow morning')).toBe(ny('2026-10-15', '09:00'));
    expect(at('friday evening')).toBe(ny('2026-10-16', '18:00'));
    expect(at('tomorrow night')).toBe(ny('2026-10-15', '20:00'));
    expect(at('this afternoon')).toBe(ny('2026-10-14', '15:00'));
    expect(at('in the evening')).toBe(ny('2026-10-14', '18:00'));
  });

  it('counts a span from now; days and longer keep the clock, unless a time is given', () => {
    expect(read('in 20 minutes').at).toBe(NOW + 20 * 60_000);
    expect(read('in 2 hours').at).toBe(NOW + 2 * 3_600_000);
    expect(read('in 2h').at).toBe(NOW + 2 * 3_600_000);
    expect(read('in an hour').at).toBe(NOW + 3_600_000);
    expect(read('in half an hour').at).toBe(NOW + 30 * 60_000);
    expect(at('in 3 days')).toBe(ny('2026-10-17', '10:00'));
    expect(at('in three days at 9am')).toBe(ny('2026-10-17', '09:00'));
    expect(at('in a week')).toBe(ny('2026-10-21', '10:00'));
  });

  it('reads on the owner’s clock, not the server’s', () => {
    // 14:00Z is 22:00 on Wednesday in Hong Kong: tomorrow is Thursday there.
    expect(at('tomorrow at 9am', { zone: 'Asia/Hong_Kong' })).toBe('2026-10-15T01:00:00.000Z');
    expect(at('at 9am', { zone: 'Asia/Hong_Kong' })).toBe('2026-10-15T01:00:00.000Z');
    expect(at('tomorrow at 9am', { zone: 'UTC' })).toBe('2026-10-15T09:00:00.000Z');
  });
});

describe('date_from_text — the rest of the text', () => {
  it('takes the phrase out, and what it leaves hanging', () => {
    expect(read('Call the dentist tomorrow at 9am')).toMatchObject({ text: 'Call the dentist', phrase: 'tomorrow at 9am' });
    expect(read('Pay rent by Nov 1')).toMatchObject({ text: 'Pay rent', phrase: 'Nov 1' });
    expect(read('Tomorrow 9am: call mom')).toMatchObject({ text: 'call mom', phrase: 'Tomorrow 9am' });
    expect(read('Renew passport - next week')).toMatchObject({ text: 'Renew passport', phrase: 'next week' });
    expect(read('Lunch with Sam friday, 1pm.')).toMatchObject({ text: 'Lunch with Sam', phrase: 'friday, 1pm.' });
    expect(read('tomorrow')).toMatchObject({ text: '', phrase: 'tomorrow' });
  });

  it('reads the first phrase only', () => {
    expect(read('Tomorrow: email Ana about Friday')).toMatchObject({
      text: 'email Ana about Friday', phrase: 'Tomorrow', at: Date.parse(ny('2026-10-15', '09:00')),
    });
  });
});

describe('date_from_text — ⛔ what it must not read', () => {
  it.each([
    'Buy 3 apples',
    'Meet at 10 Downing Street',
    'Discuss today’s agenda',
    "Read tomorrow's paper",
    'Wear sun cream',
    'I may call',
    'Fridays are busy',
    'Room 9:61',
    'in 0 days',
    'put it in 2 drawers',
    '',
  ])('%s', (input) => {
    expect(read(input).at).toBeNull();
    expect(read(input).phrase).toBeNull();
  });

  it('gives no time from something that is not text', () => {
    expect(read(42)).toEqual({ at: null, text: '', phrase: null });
    expect(read(null)).toEqual({ at: null, text: '', phrase: null });
  });

  it('refuses a zone it does not know and a default time it cannot read', () => {
    expect(read('tomorrow', { zone: 'Pacific Standard Time' })).toBeNull();
    expect(read('tomorrow', { default_time: '9am' })).toBeNull();
    expect(read('tomorrow', { default_time: '24:00' })).toBeNull();
  });

  it('with no zone, reads the server’s clock, as the other date transforms do', () => {
    expect(read('in 2 hours', { zone: '' }).at).toBe(NOW + 2 * 3_600_000);
  });
});
