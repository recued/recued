/** D-315 slice 1 — reading found text into a variable's kind (§3.2, §4.2) and the
 *  two safety rules that live beside it (§9). Refused, never coerced. */

import { describe, expect, it } from 'vitest';

import {
  containsCardNumber,
  identityValueKey,
  normalizeAccountRef,
  containsIban,
  normalizeHeldValue,
  normalizeValue,
  parseDate,
  parseDateTime,
  parseMoney,
} from '../mail-facts/normalize.js';

const value = (result: ReturnType<typeof parseMoney>) => (result.ok ? result.value : `REFUSED: ${result.reason}`);

/** A number with a valid check digit appended, for building card-like digits. */
const withLuhn = (prefix: string): string => {
  for (let d = 0; d <= 9; d += 1) {
    const candidate = `${prefix}${d}`;
    let sum = 0;
    let double = false;
    for (let i = candidate.length - 1; i >= 0; i -= 1) {
      let n = candidate.charCodeAt(i) - 48;
      if (double) {
        n *= 2;
        if (n > 9) n -= 9;
      }
      sum += n;
      double = !double;
    }
    if (sum % 10 === 0) return candidate;
  }
  throw new Error('unreachable');
};

describe('parseMoney — per locale (§4.2)', () => {
  it.each([
    ['$12.50', undefined, { amount: '12.50', currency: 'USD' }],
    ['12,50 €', undefined, { amount: '12.50', currency: 'EUR' }],
    ['€ 1.234,56', undefined, { amount: '1234.56', currency: 'EUR' }],
    ['1 234,56 €', 'fr-FR', { amount: '1234.56', currency: 'EUR' }],
    ['1.234 €', 'de-DE', { amount: '1234', currency: 'EUR' }],
    ['EUR 12.50', undefined, { amount: '12.50', currency: 'EUR' }],
    ['1,234.56 USD', undefined, { amount: '1234.56', currency: 'USD' }],
    ['£3.99', undefined, { amount: '3.99', currency: 'GBP' }],
    ['CA$ 20', undefined, { amount: '20', currency: 'CAD' }],
    ['$20', 'en-CA', { amount: '20', currency: 'CAD' }],
    ['(12.50) USD', undefined, { amount: '-12.50', currency: 'USD' }],
    // By the currency's own decimals: a dinar has three.
    ['KWD 12.500', undefined, { amount: '12.500', currency: 'KWD' }],
    ['USD 12.500', undefined, { amount: '12500', currency: 'USD' }],
    ['₹1,23,456.00', undefined, { amount: '123456.00', currency: 'INR' }],
  ])('%s (%s)', (raw, locale, expected) => {
    expect(value(parseMoney(raw, locale))).toEqual(expected);
  });

  it('refuses an amount with no currency, and a stray capital word is not one', () => {
    expect(value(parseMoney('12.50'))).toBe('REFUSED: no currency');
    expect(value(parseMoney('12.50 incl VAT'))).toBe('REFUSED: no currency');
  });

  it('refuses a mark that separates no thousands rather than reading past it', () => {
    // German reads a comma for decimals: `12.50` has a point that is neither.
    expect(value(parseMoney('12.50 €', 'de-DE'))).toMatch(/REFUSED/);
    // schema.org writes a decimal point: `12,50` there is no amount.
    expect(value(parseMoney('EUR 12,50', undefined, { decimalMark: '.' }))).toMatch(/REFUSED/);
    expect(value(parseMoney('EUR 1.500', undefined, { decimalMark: '.' }))).toEqual({ amount: '1.500', currency: 'EUR' });
  });
});

describe('numbers', () => {
  it('reads a number that begins `0.` as a decimal, whatever follows', () => {
    expect(value(normalizeValue('0.125', 'number'))).toBe(0.125);
    expect(value(normalizeValue('1.250', 'number'))).toBe(1250);
    expect(value(normalizeValue('1,250.5', 'number'))).toBe(1250.5);
  });

  it('refuses digits a space or an apostrophe groups other than by thousands: EUR 12 50 is not 1,250', () => {
    expect(value(parseMoney('EUR 12 50'))).toMatch(/not an amount/);
    expect(value(parseMoney("CHF 12'50"))).toMatch(/not an amount/);
    expect(value(normalizeValue('12 50', 'number'))).toMatch(/not a number/);
    expect(value(normalizeValue('1 2 3', 'number'))).toMatch(/not a number/);
    // Thousands, as a space or an apostrophe groups them.
    expect(value(parseMoney('EUR 1 250'))).toEqual({ amount: '1250', currency: 'EUR' });
    expect(value(parseMoney('EUR 1 250,50', 'de-DE'))).toEqual({ amount: '1250.50', currency: 'EUR' });
    expect(value(parseMoney("CHF 1'234.50"))).toEqual({ amount: '1234.50', currency: 'CHF' });
    expect(value(normalizeValue('12 345 678', 'number'))).toBe(12345678);
    expect(value(normalizeValue('1\u00A0250', 'number'))).toBe(1250);
  });

  it('refuses a number too large to hold, which would be stored as nothing', () => {
    expect(value(normalizeValue('9'.repeat(400), 'number'))).toMatch(/^REFUSED: .* is too large a number$/);
    expect(value(normalizeValue(`-${'9'.repeat(400)}`, 'number'))).toMatch(/too large a number/);
    // As large as a number goes, it is read.
    expect(value(normalizeValue('9'.repeat(308), 'number'))).toBe(Number('9'.repeat(308)));
  });

  it('reads a number written with a decimal point as the markup and a JSON answer write one', () => {
    expect(value(normalizeValue('1.125', 'number', { decimalMark: '.' }))).toBe(1.125);
  });
});

describe('parseDate — per locale, never guessed (§4.2)', () => {
  it.each([
    ['2026-09-26', undefined, '2026-09-26'],
    ['26.09.2026', undefined, '2026-09-26'],
    ['09/26/2026', undefined, '2026-09-26'],
    ['03/04/2026', 'en-US', '2026-03-04'],
    ['03/04/2026', 'de-DE', '2026-04-03'],
    ['26/09/26', undefined, '2026-09-26'],
    ['September 26, 2026', undefined, '2026-09-26'],
    ['Fri, Sep 26 2026', undefined, '2026-09-26'],
    ['Friday 26 September 2026', undefined, '2026-09-26'],
    ['26 septembre 2026', undefined, '2026-09-26'],
    ['26. September 2026', undefined, '2026-09-26'],
    ['26 de septiembre de 2026', undefined, '2026-09-26'],
  ])('%s (%s) → %s', (raw, locale, expected) => {
    expect(value(parseDate(raw, locale))).toBe(expected);
  });

  it('refuses a date that could be read either way when the rule names no locale — or English alone', () => {
    expect(value(parseDate('03/04/2026'))).toMatch(/needs a locale/);
    expect(value(parseDate('03/04/2026', 'en'))).toMatch(/needs a locale/);
    expect(value(parseDate('03/04/2026', 'en-GB'))).toBe('2026-04-03');
  });

  it('refuses a date that does not exist', () => {
    expect(value(parseDate('31.02.2026'))).toMatch(/not a real date/);
  });

  it('reads a date whole: a digit past it makes it no date, not the date it begins with', () => {
    for (const raw of ['2026-09-280', '2026-09-2800', '2026/09/280', '28.09.20260', 'September 28, 20260', '28 September 20260']) {
      expect(parseDate(raw).ok, raw).toBe(false);
    }
    // What follows a date as words is no part of it.
    expect(value(parseDate('2026-09-28 (Monday)'))).toBe('2026-09-28');
    expect(value(parseDate('September 28, 2026, at the latest'))).toBe('2026-09-28');
  });
});

describe('parseDateTime — the zone when stated, else local time', () => {
  it.each([
    ['2026-09-26T14:30:00Z', undefined, '2026-09-26T14:30:00Z'],
    ['2026-09-26 14:30+0200', undefined, '2026-09-26T14:30:00+02:00'],
    ['September 26, 2026 at 3:00 PM EDT', undefined, '2026-09-26T15:00:00-04:00'],
    ['Sep 26, 2026, 9:05 am', undefined, '2026-09-26T09:05:00'],
    ['26.09.2026 15:30', 'de-DE', '2026-09-26T15:30:00'],
  ])('%s → %s', (raw, locale, expected) => {
    expect(value(parseDateTime(raw, locale))).toBe(expected);
  });

  it('keeps a time’s fraction of a second: 10:00:00.100Z and 10:00:00.900Z are two times', () => {
    expect(value(parseDateTime('2026-09-28T10:00:00.100Z'))).toBe('2026-09-28T10:00:00.100Z');
    expect(value(parseDateTime('2026-09-28T10:00:00.9+02:00'))).toBe('2026-09-28T10:00:00.9+02:00');
    // No fraction to keep: as before.
    expect(value(parseDateTime('2026-09-28T10:00:00.000Z'))).toBe('2026-09-28T10:00:00Z');
    // A fraction with no seconds is no time.
    expect(value(parseDateTime('2026-09-28T10:00.5Z'))).toMatch(/not a real time/);
  });

  it('refuses an offset no time zone has, however it is written', () => {
    expect(value(parseDateTime('2026-09-28T10:00:00+99:99'))).toMatch(/offset no time zone has/);
    expect(value(parseDateTime('2026-09-28T10:00:00+05:60'))).toMatch(/offset no time zone has/);
    expect(value(parseDateTime('2026-09-28 10:00-1500'))).toMatch(/offset no time zone has/);
    expect(value(parseDateTime('Sep 28, 2026 10:00 AM (+99:99)'))).toMatch(/offset no time zone has/);
    // The widest there are.
    expect(value(parseDateTime('2026-09-28T10:00:00+14:00'))).toBe('2026-09-28T10:00:00+14:00');
    expect(value(parseDateTime('2026-09-28T10:00:00-12:00'))).toBe('2026-09-28T10:00:00-12:00');
    expect(value(parseDateTime('Sep 28, 2026 10:00 AM +0545'))).toBe('2026-09-28T10:00:00+05:45');
  });

  it('quotes found text short in a reason', () => {
    expect(value(parseDateTime(`${'word '.repeat(40)}`))).toMatch(/^REFUSED: 'word word .{40,}…' is not a date$/);
    expect(String(value(parseDateTime(`${'word '.repeat(40)}`))).length).toBeLessThan(90);
  });

  it('reads a time whole: a digit past it, or a separator and a digit, make it no time', () => {
    for (const raw of [
      'September 28, 2026 10:000',
      'September 28, 2026 10:00:0',
      'September 28, 2026 10:00:000',
      'September 28, 2026 10am5',
      '2026-09-28 10:000',
      'Sep 28, 2026 9:00\u201310:000 PM',
      'Sep 28, 2026 9:00\u201310:00:0 PM',
    ]) {
      expect(parseDateTime(raw).ok, raw).toBe(false);
    }
    // What follows a time as words is no part of it; a fraction of a second is kept, as ISO keeps it.
    expect(value(parseDateTime('September 28, 2026 10:00 in the lobby'))).toBe('2026-09-28T10:00:00');
    expect(value(parseDateTime('September 28, 2026 10:00:00.5'))).toBe('2026-09-28T10:00:00.5');
    expect(value(parseDateTime('September 28, 2026 10:00:00.000'))).toBe('2026-09-28T10:00:00');
    expect(value(parseDateTime('September 28, 2026 10:00.'))).toBe('2026-09-28T10:00:00');
    expect(value(parseDateTime('September 28, 2026 10:00:00.5 PM'))).toBe('2026-09-28T22:00:00.5');
    // Minutes and seconds after a dot, as some locales write them: read, never dropped.
    expect(value(parseDateTime('28.09.2026 10.30'))).toBe('2026-09-28T10:30:00');
    expect(value(parseDateTime('28.09.2026 10.30.45'))).toBe('2026-09-28T10:30:45');
    expect(value(parseDateTime('28.09.2026 9.00\u201310.30.00'))).toBe('2026-09-28T09:00:00');
  });

  it('refuses a date with no time, and a time that does not exist', () => {
    expect(value(parseDateTime('Sep 26, 2026'))).toMatch(/no time/);
    expect(value(parseDateTime('2026-09-26T25:00:00Z'))).toMatch(/not a real time/);
    expect(value(parseDateTime('2026-09-26 14:61'))).toMatch(/not a real time/);
  });

  it('reads a zone several zones share only by the locale’s country', () => {
    expect(value(parseDateTime('Sep 26, 2026 3:00 PM IST'))).toMatch(/several time zones/);
    expect(value(parseDateTime('Sep 26, 2026 3:00 PM IST', 'en-IN'))).toBe('2026-09-26T15:00:00+05:30');
    expect(value(parseDateTime('Sep 26, 2026 3:00 PM IST', 'en-IE'))).toBe('2026-09-26T15:00:00+01:00');
    expect(value(parseDateTime('Sep 26, 2026 3:00 PM CST', 'zh-CN'))).toBe('2026-09-26T15:00:00+08:00');
    expect(value(parseDateTime('Sep 26, 2026 3:00 PM CST', 'en-US'))).toBe('2026-09-26T15:00:00-06:00');
  });

  it('reads GMT or UTC and the offset written after it whole: the offset is the zone', () => {
    expect(value(parseDateTime('26 September 2026 at 10:00 GMT+0200'))).toBe('2026-09-26T10:00:00+02:00');
    expect(value(parseDateTime('Sep 26, 2026 10:00 UTC+08:00'))).toBe('2026-09-26T10:00:00+08:00');
    expect(value(parseDateTime('Sep 26, 2026 10:00 AM (UTC-05:00)'))).toBe('2026-09-26T10:00:00-05:00');
    expect(value(parseDateTime('Sep 26, 2026 10:00 GMT+2'))).toBe('2026-09-26T10:00:00+02:00');
    expect(value(parseDateTime('Sep 26, 2026 10:00 UTC +5:30'))).toBe('2026-09-26T10:00:00+05:30');
    expect(value(parseDateTime('Sep 26, 2026 10:00 GMT\u22123'))).toBe('2026-09-26T10:00:00-03:00');
    expect(value(parseDateTime('2026-09-26 10:00 GMT+0200'))).toBe('2026-09-26T10:00:00+02:00');
    // Alone, or no offset at all: UTC still.
    expect(value(parseDateTime('Sep 26, 2026 10:00 GMT'))).toBe('2026-09-26T10:00:00Z');
    expect(value(parseDateTime('Sep 26, 2026 10:00 UTC+0'))).toBe('2026-09-26T10:00:00Z');
  });

  it('refuses a zone it cannot read whole: an offset no zone has, or a name and an offset that disagree', () => {
    expect(value(parseDateTime('Sep 26, 2026 10:00 GMT+15'))).toMatch(/offset no time zone has/);
    expect(value(parseDateTime('Sep 26, 2026 10:00 UTC+05:75'))).toMatch(/offset no time zone has/);
    expect(value(parseDateTime('Sep 26, 2026 10:00 CET+0300'))).toMatch(/a time zone and an offset it does not have/);
    // A name and its own offset agree; a name several zones share is told apart by it.
    expect(value(parseDateTime('Sep 26, 2026 10:00 CEST +0200'))).toBe('2026-09-26T10:00:00+02:00');
    expect(value(parseDateTime('Sep 26, 2026 3:00 PM IST+05:30'))).toBe('2026-09-26T15:00:00+05:30');
  });

  it('reads a range of times by its start, and the zone after it: its end is no offset', () => {
    expect(value(parseDateTime('26.09.2026 10:00-12:00', 'de-DE'))).toBe('2026-09-26T10:00:00');
    expect(value(parseDateTime('Saturday, September 26, 2026 10:00 AM-11:00 AM (UTC+01:00) Amsterdam'))).toBe('2026-09-26T10:00:00+01:00');
    expect(value(parseDateTime('Sep 26, 2026 10:00 AM - 11:00 AM EDT'))).toBe('2026-09-26T10:00:00-04:00');
    expect(value(parseDateTime('Sep 26, 2026 9 am\u201311 am GMT+1'))).toBe('2026-09-26T09:00:00+01:00');
    expect(value(parseDateTime('Sep 26, 2026 10:00 - 11:00 EDT'))).toBe('2026-09-26T10:00:00-04:00');
    // An offset after a space, or with a plus sign, is one still — and so is
    // one that is no time, or a minus sign's.
    expect(value(parseDateTime('Sat, 26 Sep 2026 10:00:00 -0700 (PDT)'))).toBe('2026-09-26T10:00:00-07:00');
    expect(value(parseDateTime('Sep 26, 2026 10:00+02:00'))).toBe('2026-09-26T10:00:00+02:00');
    expect(value(parseDateTime('Sep 26, 2026 10:00-0700'))).toBe('2026-09-26T10:00:00-07:00');
    expect(value(parseDateTime('Sep 26, 2026 10:00 \u22120700'))).toBe('2026-09-26T10:00:00-07:00');
    // Neither a time nor an offset any zone has.
    expect(value(parseDateTime('Sep 26, 2026 10:00-25:00'))).toMatch(/offset no time zone has/);
  });

  it('refuses an offset not read whole: one digit past it is no offset a zone has', () => {
    expect(value(parseDateTime('2026-09-28 10:00:00 +02:000'))).toMatch(/offset/);
    expect(value(parseDateTime('Sep 28, 2026 10:00 -070099'))).toMatch(/offset/);
    expect(value(parseDateTime('Sep 28, 2026 10:00 (+02:000)'))).toMatch(/offset/);
    // Whole, it is one; an airline's "+1" day after a time is no offset at all.
    expect(value(parseDateTime('2026-09-28 10:00:00 +02:00'))).toBe('2026-09-28T10:00:00+02:00');
    expect(value(parseDateTime('Sep 28, 2026 10:00 -0700 (PDT)'))).toBe('2026-09-28T10:00:00-07:00');
    expect(value(parseDateTime('Sep 28, 2026 06:30 +1'))).toBe('2026-09-28T06:30:00');
  });

  it('gives a range’s start the a.m. or p.m. only its end says: 9:00–10:00 PM starts at nine at night', () => {
    expect(value(parseDateTime('28 September 2026 9:00\u201310:00 PM (UTC+01:00)'))).toBe('2026-09-28T21:00:00+01:00');
    expect(value(parseDateTime('Sep 28, 2026 9-10 PM'))).toBe('2026-09-28T21:00:00');
    expect(value(parseDateTime('Sep 28, 2026 12:00-1:00 PM'))).toBe('2026-09-28T12:00:00');
    // The start comes before the end: across noon or midnight, in the other half of the day.
    expect(value(parseDateTime('Sep 28, 2026 11:00-1:00 PM'))).toBe('2026-09-28T11:00:00');
    expect(value(parseDateTime('Sep 28, 2026 11:30 - 12:30 AM'))).toBe('2026-09-28T23:30:00');
    // No earlier than its end: a range of no length is in the end's half.
    expect(value(parseDateTime('Sep 28, 2026 10:00-10:00 PM'))).toBe('2026-09-28T22:00:00');
    // A start written as a 24-hour time keeps it; one with its own a.m. or p.m. too.
    expect(value(parseDateTime('Sep 28, 2026 13:00-2:00 PM'))).toBe('2026-09-28T13:00:00');
    expect(value(parseDateTime('Sep 28, 2026 0:30-1:00 AM'))).toBe('2026-09-28T00:30:00');
    expect(value(parseDateTime('Sep 28, 2026 9 AM-5 PM'))).toBe('2026-09-28T09:00:00');
    expect(value(parseDateTime('Sep 28, 2026 9 PM-10 AM'))).toBe('2026-09-28T21:00:00');
    // A start that is no time is refused, whatever its end says.
    expect(value(parseDateTime('Sep 28, 2026 9:75-10:00 PM'))).toMatch(/not a real time/);
    // An hour alone, with no range to tell it, is still no time.
    expect(value(parseDateTime('Sep 28, 2026 9'))).toMatch(/no time/);
    expect(value(parseDateTime('Sep 28, 2026 9-10:30'))).toMatch(/no time/);
  });
});

describe('card numbers and account references (§9)', () => {
  it('finds a full card number, grouped or not', () => {
    expect(containsCardNumber('card 4111 1111 1111 1111 charged')).toBe(true);
    expect(containsCardNumber('4111-1111-1111-1111')).toBe(true);
    expect(containsCardNumber('Amex 378282246310005')).toBe(true);
  });

  it('finds a card or an IBAN however its groups are spaced: a no-break, a narrow or a thin space', () => {
    for (const space of ['\u00A0', '\u202F', '\u2009']) {
      expect(containsCardNumber(['4111', '1111', '1111', '1111'].join(space))).toBe(true);
      expect(containsIban(['DE89', '3704', '0044', '0532', '0130', '00'].join(space))).toBe(true);
    }
  });

  it('finds a card or an IBAN whatever run of separators parts its groups: four spaces, tabs and lines, a run of dashes', () => {
    expect(containsCardNumber('4111    1111    1111    1111')).toBe(true);
    expect(containsIban('DE89    3704    0044    0532    0130    00')).toBe(true);
    expect(containsCardNumber('Visa 4111\t \t1111\n\n\n\n1111 1111 charged')).toBe(true);
    expect(containsCardNumber('4111----1111----1111----1111')).toBe(true);
    expect(containsIban('DE89 -- 3704 -- 0044 -- 0532 -- 0130 -- 00')).toBe(true);
    expect(containsIban('pay to DE89    3704    0044    0532    0130    00    by Friday')).toBe(true);
    // One digit off: none, however far apart its groups.
    expect(containsCardNumber('4111    1111    1111    1112')).toBe(false);
    expect(containsIban('DE89    3704    0044    0532    0130    01')).toBe(false);
  });

  it('finds a card or an IBAN written in fullwidth or other compatibility forms, as the identity key reads it', () => {
    const fullwidth = (text: string): string => text.replace(/[0-9A-Z]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 0xFEE0));
    expect(containsCardNumber(fullwidth('4111111111111111'))).toBe(true);
    expect(containsCardNumber(`card ${fullwidth('4111 1111 1111 1111')}`)).toBe(true);
    expect(containsIban(fullwidth('DE89370400440532013000'))).toBe(true);
    // Mathematical digits too: the key reads them as 4111…
    expect(containsCardNumber(`\u{1D7D2}${'\u{1D7CF}'.repeat(15)}`)).toBe(true);
    // One digit off: none, however written.
    expect(containsCardNumber(fullwidth('4111111111111112'))).toBe(false);
  });

  it('finds an IBAN grouped as a card may be: by dashes or dots too', () => {
    expect(containsIban('DE89-3704-0044-0532-0130-00')).toBe(true);
    expect(containsIban('DE89 - 3704 - 0044 - 0532 - 0130 - 00')).toBe(true);
    expect(containsIban('DE89.3704.0044.0532.0130.00')).toBe(true);
    expect(containsIban('pay to DE89\u20113704\u20110044\u20110532\u20110130\u201100 by Friday')).toBe(true);
    // One digit off: no IBAN, however grouped.
    expect(containsIban('DE89-3704-0044-0532-0130-01')).toBe(false);
  });

  it('does not take a number with a valid check digit but no card issuer prefix for a card', () => {
    const orderNumber = withLuhn('123456781234567'); // 16 digits, check digit valid
    expect(orderNumber).toHaveLength(16);
    expect(containsCardNumber(orderNumber)).toBe(false);
    expect(containsCardNumber('4111111111111112')).toBe(false); // bad check digit
  });

  it('reads an account’s last four as the kind the account is declared: a number is refused as text', () => {
    expect(value(normalizeValue('ABCD', 'number', { variable: 'account_ref' }))).toMatch(/not a number/);
    expect(value(normalizeValue('****1234', 'number', { variable: 'account_ref' }))).toBe(1234);
    // The last four first: a longer number is refused before its kind is read.
    expect(value(normalizeValue('12345678', 'number', { variable: 'account_ref' }))).toMatch(/last four/);
    expect(value(normalizeValue('XXXX-1234', 'text', { variable: 'account_ref' }))).toBe('1234');
  });

  it('keeps only the last four characters of an account', () => {
    expect(value(normalizeAccountRef('XXXX-1234'))).toBe('1234');
    expect(value(normalizeAccountRef('****1234'))).toBe('1234');
    expect(value(normalizeAccountRef('12345678'))).toMatch(/last four/);
  });

  it('finds a card beside other numbers, and never inside a tracking number', () => {
    expect(containsCardNumber('Card 4111 1111 1111 1111 12/26')).toBe(true);
    expect(containsCardNumber('Order 12345 4111111111111111')).toBe(true);
    expect(containsCardNumber('4111 - 1111 - 1111 - 1111')).toBe(true);
    // USPS, 22 digits in groups: no whole group run is a card.
    expect(containsCardNumber('9400 1000 0000 0000 0000 00')).toBe(false);
    expect(containsCardNumber('9400100000000000000000')).toBe(false);
    expect(containsCardNumber('1Z999AA10123456784')).toBe(false);
  });

  it('refuses an IBAN in any variable: the one account number told apart with certainty', () => {
    expect(containsIban('Pay to DE89 3704 0044 0532 0130 00 by Friday')).toBe(true);
    expect(containsIban('GB82WEST12345698765432')).toBe(true);
    expect(containsIban('DE89 3704 0044 0532 0130 01')).toBe(false); // the check digits do not hold
    expect(containsIban('Order AB12 3456 7890 1234')).toBe(false);
    expect(value(normalizeValue('DE89370400440532013000', 'text'))).toMatch(/IBAN/);
  });

  it('refuses a full card number in any variable', () => {
    expect(normalizeValue('paid with 4111 1111 1111 1111', 'text').ok).toBe(false);
  });

  it('refuses a card number a number or an amount holds once its separators are read', () => {
    // Grouped by thousands, the text holds no card; read, the number is one.
    expect(value(normalizeValue('4,111,111,111,111,111', 'number', { locale: 'en-US' }))).toMatch(/card number/);
    expect(value(normalizeValue('4,111,111,111,111,111.00', 'number', { locale: 'en-US' }))).toMatch(/card number/);
    expect(value(normalizeValue("4'111'111'111'111'111", 'number', { locale: 'de-CH' }))).toMatch(/card number/);
    expect(value(normalizeValue('4,11,11,11,11,11,11,111', 'number', { locale: 'en-IN' }))).toMatch(/card number/);
    expect(value(normalizeValue('USD 4,111,111,111,111,111.00', 'money'))).toMatch(/card number/);
    expect(value(normalizeHeldValue('4,111,111,111,111,111', 'number'))).toMatch(/card number/);
    // A number no card is stands: the check digit fails.
    expect(value(normalizeValue('4,111,111,111,111,112', 'number', { locale: 'en-US' }))).toBe(4111111111111112);
    expect(value(normalizeValue('USD 1,234,567.00', 'money'))).toEqual({ amount: '1234567.00', currency: 'USD' });
  });
});

describe('normalizeValue by kind', () => {
  it('reads enums, ids, numbers and booleans', () => {
    const states = ['in_transit', 'out_for_delivery', 'delivered'];
    expect(value(normalizeValue('Out for delivery', 'enum', { values: states }))).toBe('out_for_delivery');
    expect(value(normalizeValue('Lost', 'enum', { values: states }))).toMatch(/not one of/);
    expect(value(normalizeValue('  #1Z 999 AA1. ', 'id'))).toBe('1Z999AA1');
    expect(value(normalizeValue('1.234,5', 'number', { locale: 'de-DE' }))).toBe(1234.5);
    expect(value(normalizeValue('Yes', 'boolean'))).toBe(true);
    expect(value(normalizeValue('some text', 'file'))).toMatch(/attachment/);
  });

  it('keys an identity value case- and space-insensitively', () => {
    expect(identityValueKey('1Z 999 AA1')).toBe(identityValueKey('1z999aa1'));
  });

  it('strips a company or web ending only from a name, and keys an address as the address', () => {
    // A merchant, named two ways by two passes, is one.
    expect(identityValueKey('Amazon.com, Inc.', 'text', 'merchant')).toBe(identityValueKey('Amazon', 'text', 'merchant'));
    // Any other text keeps them: a reference "Acme Co" is not "Acme".
    expect(identityValueKey('Acme Co', 'text', 'name')).not.toBe(identityValueKey('Acme', 'text', 'name'));
    expect(identityValueKey('Acme Co', 'text')).not.toBe(identityValueKey('Acme', 'text'));
    // An address, in any variable, whole: its domain, dots and dashes count.
    expect(identityValueKey('alex@acme.com', 'text', 'email')).not.toBe(identityValueKey('alex@acme.net', 'text', 'email'));
    expect(identityValueKey('alex@acme.com', 'text', 'merchant')).not.toBe(identityValueKey('alex@acme.net', 'text', 'merchant'));
    expect(identityValueKey('a.b@x.com', 'text', 'email')).not.toBe(identityValueKey('ab@x.com', 'text', 'email'));
    expect(identityValueKey(' Alex@Acme.COM ', 'text', 'email')).toBe(identityValueKey('alex@acme.com', 'text', 'email'));
  });

  it('keys a number by its value: its sign and decimal point count', () => {
    const keys = [1.25, 125, -125].map((n) => identityValueKey(n, 'number'));
    expect(new Set(keys).size).toBe(3);
    // A whole number keeps the key it always had.
    expect(identityValueKey(125, 'number')).toBe('125');
  });

  it('keys an amount by its value: 12.50 is 12.5, and its currency is part of it', () => {
    const key = (amount: string, currency = 'EUR') => identityValueKey({ amount, currency });
    expect(key('12.50')).toBe(key('12.5'));
    expect(key('12.00')).toBe(key('12'));
    expect(key('-12.50')).toBe(key('-12.5'));
    expect(key('-0.00')).toBe(key('0'));
    expect(key('1.500', 'KWD')).toBe(key('1.5', 'KWD'));
    expect(key('12.05')).not.toBe(key('12.5'));
    expect(key('120')).not.toBe(key('12'));
    expect(key('-12.5')).not.toBe(key('12.5'));
    expect(key('12.50', 'USD')).not.toBe(key('12.50'));
    // A whole amount keeps the key it had.
    expect(key('12')).toBe('EUR:12');
  });

  it('keys an enum by the value it declares: v1_2 and v12 are two', () => {
    expect(identityValueKey('v1_2', 'enum')).toBe('v1_2');
    expect(identityValueKey('v12', 'enum')).toBe('v12');
    expect(identityValueKey('tax_form', 'enum')).not.toBe(identityValueKey('taxform', 'enum'));
  });

  it('keys a datetime by the instant it names, and one with no zone by its clock', () => {
    const key = (text: string) => identityValueKey(text, 'datetime');
    // Punctuation aside these were one key; they are two hours apart.
    expect(key('2026-09-27T10:00:00+01:00')).not.toBe(key('2026-09-27T10:00:00-01:00'));
    expect(key('2026-09-27T10:00:00+01:00')).toBe(key('2026-09-27T09:00:00Z'));
    expect(key('2026-09-27T10:00:00-01:00')).toBe(key('2026-09-27T11:00:00Z'));
    expect(key('2026-09-27T10:00:00+05:45')).toBe(key('2026-09-27T04:15:00Z'));
    // Across midnight, and across a year.
    expect(key('2026-09-27T00:30:00+01:00')).toBe(key('2026-09-26T23:30:00Z'));
    expect(key('2026-12-31T23:30:00-01:00')).toBe(key('2027-01-01T00:30:00Z'));
    // A time in UTC and a time with no zone keep the keys they had.
    expect(key('2026-09-27T09:00:00Z')).toBe('20260927t090000z');
    expect(key('2026-09-27T10:00:00')).toBe('20260927t100000');
    // A local time names no instant: it is none of the zoned ones.
    expect(key('2026-09-27T10:00:00')).not.toBe(key('2026-09-27T10:00:00Z'));
    // A fraction of a second counts, written how it may be.
    expect(key('2026-09-27T10:00:00.100Z')).not.toBe(key('2026-09-27T10:00:00.900Z'));
    expect(key('2026-09-27T10:00:00.100Z')).toBe(key('2026-09-27T10:00:00.1Z'));
    expect(key('2026-09-27T11:00:00.25+01:00')).toBe(key('2026-09-27T10:00:00.250Z'));
    expect(key('2026-09-27T10:00:00.5')).not.toBe(key('2026-09-27T10:00:00'));
    // None, and none worth keeping, keep the keys they had.
    expect(key('2026-09-27T10:00:00.000Z')).toBe('20260927t100000z');
    // A date is a date.
    expect(identityValueKey('2026-09-27', 'date')).toBe('20260927');
  });

  // A shipment's identity is carrier + tracking number: one parcel named two
  // ways by two emails would be two things.
  it('names a carrier as the four carriers are named, whichever pass read it', () => {
    const carrier = (raw: string) => value(normalizeValue(raw, 'text', { variable: 'carrier' }));
    expect(carrier('United Parcel Service')).toBe('UPS');
    expect(carrier('UPS Ground')).toBe('UPS');
    expect(carrier('fedex home delivery')).toBe('FedEx');
    expect(carrier('Federal Express')).toBe('FedEx');
    expect(carrier('US Postal Service')).toBe('USPS');
    expect(carrier('U.S. Postal Service')).toBe('USPS');
    expect(carrier('DHL eCommerce')).toBe('DHL');
    // Any other carrier is kept as written; so is the name in any other variable.
    expect(carrier('Royal  Mail')).toBe('Royal Mail');
    expect(value(normalizeValue('United Parcel Service', 'text', { variable: 'merchant' }))).toBe('United Parcel Service');
  });
});
