import { describe, expect, it } from 'vitest';
import { nextDigestText } from '../settings/situation-delivery-panel.js';

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
