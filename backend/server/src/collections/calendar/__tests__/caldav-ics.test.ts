/** CalDAV write-back edits the calendar's own file (2026-10-07).
 *
 *  🔑 The zone rules this writes are not checked by hand: each is read back
 *  by the same reader invites are read with (`icsClock`) and compared, hour by
 *  hour across two years, with the platform's own tables for the zone. */

import { zoneOffsetMsAt } from '@recued/contracts';
import { icsClock } from '@recued/transforms';
import { describe, expect, it } from 'vitest';

import {
  cloneComponentLines,
  componentsNamed,
  createIcsEditor,
  escapeIcsText,
  firstProp,
  foldIcsLine,
  icsLine,
  icsTimeLine,
  parseIcsDoc,
  setComponentProperty,
  vtimezoneLines,
} from '../caldav-ics.js';

const HOUR = 3_600_000;

const APPLE_EVENT = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Apple Inc.//macOS 15.0//EN',
  'BEGIN:VTIMEZONE',
  'TZID:America/Los_Angeles',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:-0800',
  'TZOFFSETTO:-0700',
  'DTSTART:20070311T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:-0700',
  'TZOFFSETTO:-0800',
  'DTSTART:20071104T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'UID:dentist-1',
  'DTSTAMP:20261001T000000Z',
  'DTSTART;TZID=America/Los_Angeles:20261017T100000',
  'DTEND;TZID=America/Los_Angeles:20261017T110000',
  'SUMMARY:Dentist',
  'DESCRIPTION:A long description that the server folded across lines becau',
  ' se it ran past seventy-five octets.',
  'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'DESCRIPTION:Reminder',
  'TRIGGER:-PT15M',
  'END:VALARM',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n') + '\r\n';

describe('parseIcsDoc + createIcsEditor', () => {
  it('writes an unedited file back exactly as it came, folded lines included', () => {
    const doc = parseIcsDoc(APPLE_EVENT);
    expect(createIcsEditor(doc).render()).toBe(APPLE_EVENT);
  });

  it('keeps a component to its own properties: a reminder\'s DESCRIPTION is the reminder\'s', () => {
    const doc = parseIcsDoc(APPLE_EVENT);
    const [vevent] = componentsNamed(doc, 'VEVENT');
    expect(firstProp(doc, vevent!, 'DESCRIPTION')?.value).toBe(
      'A long description that the server folded across lines because it ran past seventy-five octets.',
    );
    const [alarm] = componentsNamed(doc, 'VALARM');
    expect(firstProp(doc, alarm!, 'DESCRIPTION')?.value).toBe('Reminder');
  });

  it('changes only the line an edit names; a new property lands before the reminder', () => {
    const doc = parseIcsDoc(APPLE_EVENT);
    const editor = createIcsEditor(doc);
    const [vevent] = componentsNamed(doc, 'VEVENT');
    setComponentProperty(editor, vevent!, 'SUMMARY', icsLine('SUMMARY', 'Dentist (moved)'));
    setComponentProperty(editor, vevent!, 'LOCATION', icsLine('LOCATION', escapeIcsText('Suite 4, 2nd floor')));
    const out = editor.render();
    expect(out).toBe(
      APPLE_EVENT
        .replace('SUMMARY:Dentist\r\n', 'SUMMARY:Dentist (moved)\r\n')
        .replace('BEGIN:VALARM\r\n', 'LOCATION:Suite 4\\, 2nd floor\r\nBEGIN:VALARM\r\n'),
    );
  });

  it('removes a property everywhere it appears, and only in its component', () => {
    const doc = parseIcsDoc(APPLE_EVENT);
    const editor = createIcsEditor(doc);
    const [vevent] = componentsNamed(doc, 'VEVENT');
    setComponentProperty(editor, vevent!, 'DESCRIPTION', null);
    const out = editor.render();
    expect(out).not.toContain('A long description');
    expect(out).toContain('DESCRIPTION:Reminder\r\n');
  });

  it('copies a component with some properties replaced, its reminder whole', () => {
    const doc = parseIcsDoc(APPLE_EVENT);
    const [vevent] = componentsNamed(doc, 'VEVENT');
    const lines = cloneComponentLines(doc, vevent!, {
      set: new Map([['RECURRENCE-ID', ['RECURRENCE-ID;TZID=America/Los_Angeles:20261017T100000']]]),
      drop: new Set(['X-APPLE-TRAVEL-ADVISORY-BEHAVIOR']),
    });
    expect(lines[0]).toBe('BEGIN:VEVENT');
    expect(lines.at(-1)).toBe('END:VEVENT');
    expect(lines).toContain('RECURRENCE-ID;TZID=America/Los_Angeles:20261017T100000');
    expect(lines).not.toContain('X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC');
    expect(lines.slice(lines.indexOf('BEGIN:VALARM'), lines.indexOf('END:VALARM') + 1)).toEqual([
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'TRIGGER:-PT15M', 'END:VALARM',
    ]);
  });
});

describe('values', () => {
  it('folds at 75 octets without splitting a character', () => {
    const line = `SUMMARY:${'é'.repeat(60)}`;
    const folded = foldIcsLine(line);
    expect(folded.length).toBeGreaterThan(1);
    for (const l of folded) expect(Buffer.byteLength(l, 'utf8')).toBeLessThanOrEqual(75);
    expect(folded.slice(1).every((l) => l.startsWith(' '))).toBe(true);
    expect(folded[0] + folded.slice(1).map((l) => l.slice(1)).join('')).toBe(line);
  });

  it('quotes a parameter holding a colon, semicolon or comma', () => {
    expect(icsLine('ATTENDEE', 'mailto:a@x.com', [['CN', 'Doe, Jane'], ['PARTSTAT', 'ACCEPTED']]))
      .toBe('ATTENDEE;CN="Doe, Jane";PARTSTAT=ACCEPTED:mailto:a@x.com');
    expect(icsLine('ORGANIZER', 'mailto:a@x.com', [['SENT-BY', 'mailto:b@x.com']]))
      .toBe('ORGANIZER;SENT-BY="mailto:b@x.com":mailto:a@x.com');
  });

  it('writes an instant on a zone\'s clock in each form', () => {
    const clock = icsClock(APPLE_EVENT);
    const at = Date.parse('2026-10-17T17:00:00Z');
    expect(icsTimeLine('DTSTART', at, { kind: 'zoned', tzid: 'America/Los_Angeles', zone: clock.zone('America/Los_Angeles', false) }))
      .toBe('DTSTART;TZID=America/Los_Angeles:20261017T100000');
    expect(icsTimeLine('DTSTART', at, { kind: 'utc' })).toBe('DTSTART:20261017T170000Z');
    expect(icsTimeLine('DTSTART', Date.UTC(2026, 9, 17), { kind: 'date' })).toBe('DTSTART;VALUE=DATE:20261017');
  });
});

/** The zones the rules are proven for: rules by nth and last weekday, south of
 *  the equator, a half-hour change (Lord Howe), a zone whose winter is IANA's
 *  "negative DST" (Dublin), zones that no longer change (Kolkata, São Paulo,
 *  Tehran), and ones whose changes follow no weekday rule (Santiago, which
 *  changes on the first Sunday after the 1st; Casablanca, around Ramadan). */
const ZONES = [
  'America/Los_Angeles',
  'America/New_York',
  'Europe/London',
  'Europe/Dublin',
  'Europe/Berlin',
  'Australia/Sydney',
  'Australia/Lord_Howe',
  'Pacific/Auckland',
  'Asia/Kolkata',
  'America/Sao_Paulo',
  'Asia/Tehran',
  'America/Santiago',
  'Africa/Casablanca',
];

describe('vtimezoneLines', () => {
  for (const zone of ZONES) {
    it(`${zone}: the rules written read back to the platform's clock, every hour for two years`, () => {
      const around = Date.UTC(2026, 9, 17);
      const rules = vtimezoneLines(zone, around);
      expect(rules).not.toBeNull();
      const tzid = zone;
      const clock = icsClock(['BEGIN:VCALENDAR', 'VERSION:2.0', ...rules!, 'END:VCALENDAR'].join('\r\n'));
      expect(clock.hasRules(tzid)).toBe(true);
      const reader = clock.zone(tzid, false);
      const mismatches: string[] = [];
      for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2028, 0, 1); t += HOUR) {
        const expected = t + zoneOffsetMsAt(t, zone);
        const wall = reader.toWall(t);
        if (wall !== expected) mismatches.push(`${new Date(t).toISOString()}: ${wall === null ? 'null' : new Date(wall).toISOString()} != ${new Date(expected).toISOString()}`);
      }
      expect(mismatches.slice(0, 5)).toEqual([]);
    });
  }

  it('writes a yearly weekday rule where the zone keeps one', () => {
    expect(vtimezoneLines('America/Los_Angeles', Date.UTC(2026, 9, 17))).toEqual(expect.arrayContaining([
      'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
      'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
    ]));
    expect(vtimezoneLines('Europe/London', Date.UTC(2026, 9, 17))).toEqual(expect.arrayContaining([
      'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
      'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
    ]));
  });

  it('writes one standard offset for a zone that does not change, and nothing for one the platform lacks', () => {
    expect(vtimezoneLines('Asia/Kolkata', Date.UTC(2026, 9, 17))).toEqual([
      'BEGIN:VTIMEZONE', 'TZID:Asia/Kolkata',
      'BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZOFFSETFROM:+0530', 'TZOFFSETTO:+0530', 'END:STANDARD',
      'END:VTIMEZONE',
    ]);
    expect(vtimezoneLines('Pacific Standard Time', Date.UTC(2026, 9, 17))).toBeNull();
  });
});
