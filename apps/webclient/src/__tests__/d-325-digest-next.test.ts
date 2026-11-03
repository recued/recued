import { describe, expect, it } from 'vitest';
import { digestLookAheadChoices, digestLookAheadFor, nextDigestText } from '../settings/situation-delivery-panel.js';
import { agendaWeekChoices } from '../settings/agenda-panel.js';

describe('D-325 §15.7 amendment — the Digest card says when the next digest goes', () => {
  const monday = Date.parse('2026-10-26T07:00:00Z');
  const now = Date.parse('2026-10-24T12:00:00Z');

  it('says the day and time in the server’s zone, not this device’s', () => {
    expect(nextDigestText(monday, 'UTC', now, 'en-GB')).toBe('Mon 26 Oct, 07:00');
    // Paris is an hour ahead once its clocks go back on 25 October; New York is four behind
    // until its own change on 1 November.
    expect(nextDigestText(monday, 'Europe/Paris', now, 'en-GB')).toBe('Mon 26 Oct, 08:00');
    expect(nextDigestText(monday, 'America/New_York', now, 'en-GB')).toBe('Mon 26 Oct, 03:00');
  });

  it('reads a zone it does not know in this device’s zone rather than failing the card', () => {
    expect(nextDigestText(monday, 'Mars/Olympus_Mons', now, 'en-GB')).toBe(nextDigestText(monday, undefined, now, 'en-GB'));
  });

  it('says it is going out now once its time has come', () => {
    expect(nextDigestText(now, 'UTC', now, 'en-GB')).toBe('going out now');
    expect(nextDigestText(now + 30_000, 'UTC', now, 'en-GB')).toBe('going out now');
    expect(nextDigestText(now + 120_000, 'UTC', now, 'en-GB')).toBe('Sat 24 Oct, 12:02');
  });
});

describe('D-325 §15.7 amendment (2026-11-02) — how far ahead the digest looks', () => {
  it('offers a daily digest today and tomorrow up to two weeks, and a weekly one a week or more', () => {
    expect(digestLookAheadChoices('daily')).toEqual([2, 3, 7, 14]);
    // Off still sends on Send now, over the window it names.
    expect(digestLookAheadChoices('off')).toEqual([2, 3, 7, 14]);
    expect(digestLookAheadChoices('weekly')).toEqual([7, 14]);
  });

  it('shows the owner’s window while it is offered, else the shortest longer one', () => {
    expect(digestLookAheadFor('daily', 2)).toBe(2);
    expect(digestLookAheadFor('weekly', 2)).toBe(7);
    expect(digestLookAheadFor('weekly', 3)).toBe(7);
    expect(digestLookAheadFor('weekly', 14)).toBe(14);
    expect(digestLookAheadFor('daily', 14)).toBe(14);
  });
});

describe('D-325 §15.7 amendment (2026-11-03) — a weekly agenda names the days it lists', () => {
  it('offers the seven days from its weekday or from the next, by name, Sunday wrapping to Monday', () => {
    expect(agendaWeekChoices(1)).toEqual([['today', 'Monday to Sunday'], ['tomorrow', 'Tuesday to Monday']]);
    expect(agendaWeekChoices(7)).toEqual([['today', 'Sunday to Saturday'], ['tomorrow', 'Monday to Sunday']]);
    expect(agendaWeekChoices(5)).toEqual([['today', 'Friday to Thursday'], ['tomorrow', 'Saturday to Friday']]);
  });
  it('reads a weekday it does not know as Monday rather than naming no day', () => {
    for (const weekday of [0, 8, Number.NaN, 2.5]) expect(agendaWeekChoices(weekday)).toEqual(agendaWeekChoices(1));
  });
});
