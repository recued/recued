/** D-315 slice 7 — reading an iCalendar file.
 *
 *  🔑 The time tests do not trust hand arithmetic alone. A zone's own rules —
 *  Outlook's `Pacific Standard Time`, `W. Europe Standard Time`, `AUS Eastern
 *  Standard Time`, Apple's New York with its 2007 change of rules — are read
 *  for hours across years and checked against the platform's IANA tables for
 *  the same place. The hour a clock change repeats or skips is left out: two
 *  readers may each pick a side of it, and both are right. */

import { zoneOffsetMsAt, zonedWallClockToEpochMs } from '@recued/contracts';
import { describe, expect, it } from 'vitest';

import { icsClock, icsInviteKey, looksLikeIcs, parseIcs, readIcsDateTime, ICS_MAX_BYTES } from '../ics.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const crlf = (lines: readonly string[]): string => `${lines.join('\r\n')}\r\n`;
const iso = (s: string): number => Date.parse(s);

const PACIFIC = [
  'BEGIN:VTIMEZONE', 'TZID:Pacific Standard Time',
  'BEGIN:STANDARD', 'DTSTART:16010101T020000', 'TZOFFSETFROM:-0700', 'TZOFFSETTO:-0800',
  'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=11', 'END:STANDARD',
  'BEGIN:DAYLIGHT', 'DTSTART:16010101T020000', 'TZOFFSETFROM:-0800', 'TZOFFSETTO:-0700',
  'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=2SU;BYMONTH=3', 'END:DAYLIGHT',
  'END:VTIMEZONE',
];
const W_EUROPE = [
  'BEGIN:VTIMEZONE', 'TZID:W. Europe Standard Time',
  'BEGIN:STANDARD', 'DTSTART:16010101T030000', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100',
  'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10', 'END:STANDARD',
  'BEGIN:DAYLIGHT', 'DTSTART:16010101T020000', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200',
  'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3', 'END:DAYLIGHT',
  'END:VTIMEZONE',
];
const AUS_EASTERN = [
  'BEGIN:VTIMEZONE', 'TZID:AUS Eastern Standard Time',
  'BEGIN:STANDARD', 'DTSTART:16010101T030000', 'TZOFFSETFROM:+1100', 'TZOFFSETTO:+1000',
  'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=4', 'END:STANDARD',
  'BEGIN:DAYLIGHT', 'DTSTART:16010101T020000', 'TZOFFSETFROM:+1000', 'TZOFFSETTO:+1100',
  'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=10', 'END:DAYLIGHT',
  'END:VTIMEZONE',
];
/** Outlook writes a zone with no daylight time as two identical observances. */
const INDIA = [
  'BEGIN:VTIMEZONE', 'TZID:India Standard Time',
  'BEGIN:STANDARD', 'DTSTART:16010101T000000', 'TZOFFSETFROM:+0530', 'TZOFFSETTO:+0530', 'END:STANDARD',
  'BEGIN:DAYLIGHT', 'DTSTART:16010101T000000', 'TZOFFSETFROM:+0530', 'TZOFFSETTO:+0530', 'END:DAYLIGHT',
  'END:VTIMEZONE',
];
/** Apple's: the full history, each set of rules ended by an UNTIL. */
const APPLE_NEW_YORK = [
  'BEGIN:VTIMEZONE', 'TZID:America/New_York',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0500', 'RRULE:FREQ=YEARLY;UNTIL=20060402T070000Z;BYMONTH=4;BYDAY=1SU',
  'DTSTART:19870405T020000', 'TZNAME:EDT', 'TZOFFSETTO:-0400', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:-0400', 'RRULE:FREQ=YEARLY;UNTIL=20061029T060000Z;BYMONTH=10;BYDAY=-1SU',
  'DTSTART:19671029T020000', 'TZNAME:EST', 'TZOFFSETTO:-0500', 'END:STANDARD',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0500', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
  'DTSTART:20070311T020000', 'TZNAME:EDT', 'TZOFFSETTO:-0400', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:-0400', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
  'DTSTART:20071104T020000', 'TZNAME:EST', 'TZOFFSETTO:-0500', 'END:STANDARD',
  'END:VTIMEZONE',
];
/** Google's: the current rules, from 1970. */
const GOOGLE_BERLIN = [
  'BEGIN:VTIMEZONE', 'TZID:Europe/Berlin', 'X-LIC-LOCATION:Europe/Berlin',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST',
  'DTSTART:19700329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET',
  'DTSTART:19701025T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
  'END:VTIMEZONE',
];

const wallText = (wall: number): string => new Date(wall).toISOString().slice(0, 19).replace(/[-:]/g, '');

/** Every sampled hour of `years`, read through `vtimezone` as `tzid`, lands
 *  where the IANA tables put the same wall clock in `iana`. */
const expectAgreesWithIana = (vtimezone: readonly string[], tzid: string, iana: string, from: number, to: number): void => {
  const walls: number[] = [];
  for (let day = Date.UTC(from, 0, 1); day < Date.UTC(to + 1, 0, 1); day += 2 * DAY) {
    const changes = zoneOffsetMsAt(day + 12 * HOUR, iana) !== zoneOffsetMsAt(day - 12 * HOUR, iana);
    for (const hour of [0, 1, 2, 3, 6, 9, 12, 15, 18, 21, 23]) {
      if (changes && hour <= 4) continue;
      walls.push(day + hour * HOUR);
    }
  }
  let checked = 0;
  for (let at = 0; at < walls.length; at += 150) {
    const batch = walls.slice(at, at + 150);
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', ...vtimezone];
    batch.forEach((wall, i) => {
      lines.push('BEGIN:VEVENT', `UID:e${i}`, `DTSTART;TZID="${tzid}":${wallText(wall)}`,
        `DTEND;TZID="${tzid}":${wallText(wall + HOUR)}`, 'END:VEVENT');
    });
    lines.push('END:VCALENDAR');
    const result = parseIcs(crlf(lines));
    expect(result.events).toHaveLength(batch.length);
    batch.forEach((wall, i) => {
      const expected = zonedWallClockToEpochMs(new Date(wall).toISOString().slice(0, 19), iana);
      const event = result.events[i]!;
      if (event.start_ms !== expected) {
        throw new Error(`${tzid} ${new Date(wall).toISOString()}: read ${event.start} — ${iana} says ${new Date(expected!).toISOString()}`);
      }
      expect(event.time_basis).toBe('zone');
      checked += 1;
    });
  }
  expect(checked).toBeGreaterThan(1000);
};

describe('a zone given by its own rules reads as the IANA tables read the same place', () => {
  it("Outlook's Pacific Standard Time — Los Angeles", () => {
    expectAgreesWithIana(PACIFIC, 'Pacific Standard Time', 'America/Los_Angeles', 2025, 2027);
  });
  it("Outlook's W. Europe Standard Time — Berlin", () => {
    expectAgreesWithIana(W_EUROPE, 'W. Europe Standard Time', 'Europe/Berlin', 2025, 2027);
  });
  it("Outlook's AUS Eastern Standard Time — Sydney, whose summer spans the new year", () => {
    expectAgreesWithIana(AUS_EASTERN, 'AUS Eastern Standard Time', 'Australia/Sydney', 2025, 2027);
  });
  it("Outlook's India Standard Time — no daylight time", () => {
    expectAgreesWithIana(INDIA, 'India Standard Time', 'Asia/Kolkata', 2026, 2027);
  });
  it("Apple's New York, across the 2007 change of US rules", () => {
    expectAgreesWithIana(APPLE_NEW_YORK, 'America/New_York', 'America/New_York', 2004, 2008);
  });
  it("Google's Berlin, rules from 1970", () => {
    expectAgreesWithIana(GOOGLE_BERLIN, 'Europe/Berlin', 'Europe/Berlin', 2025, 2027);
  });

  it('the day the clocks go forward, either side of the change', () => {
    const result = parseIcs(crlf([
      'BEGIN:VCALENDAR', ...PACIFIC,
      'BEGIN:VEVENT', 'UID:before', 'DTSTART;TZID=Pacific Standard Time:20260308T013000', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:after', 'DTSTART;TZID=Pacific Standard Time:20260308T100000', 'END:VEVENT',
      'END:VCALENDAR',
    ]));
    expect(result.events.map((e) => e.start)).toEqual(['2026-03-08T09:30:00.000Z', '2026-03-08T17:00:00.000Z']);
  });
});

const GOOGLE_INVITE = crlf([
  'BEGIN:VCALENDAR',
  'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
  'VERSION:2.0',
  'CALSCALE:GREGORIAN',
  'METHOD:REQUEST',
  'BEGIN:VTIMEZONE', 'TZID:America/New_York', 'X-LIC-LOCATION:America/New_York',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'TZNAME:EDT',
  'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'TZNAME:EST',
  'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'DTSTART;TZID=America/New_York:20261015T100000',
  'DTEND;TZID=America/New_York:20261015T110000',
  'DTSTAMP:20261001T120000Z',
  'ORGANIZER;CN=Alice Example;SENT-BY="mailto:assistant@example.com":mailto:alice@example.com',
  'UID:abc123@google.com',
  'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=',
  ' TRUE;CN=Me;X-NUM-GUESTS=0:mailto:Me@Owner.Example',
  'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=TRUE',
  ' ;CN=Alice Example;X-NUM-GUESTS=0:mailto:alice@example.com',
  'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=OPT-PARTICIPANT;PARTSTAT=TENTATIVE;CN="Doe; Bo',
  ' b";X-NUM-GUESTS=0:MAILTO:bob@example.com',
  'ATTENDEE;CUTYPE=RESOURCE;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=Room 4:ma',
  ' ilto:c_room4@resource.calendar.google.com',
  'DESCRIPTION:Agenda:\\n1. Plan\\, review\\; decide\\n2. Next steps \\\\ owners',
  'LOCATION:Room 4\\, 2nd floor',
  'SEQUENCE:0',
  'STATUS:CONFIRMED',
  'SUMMARY:Quarterly planning',
  'BEGIN:VALARM',
  'ACTION:EMAIL',
  'DESCRIPTION:This is an event reminder',
  'SUMMARY:Alarm notification',
  'ATTENDEE:mailto:someone-else@example.com',
  'TRIGGER:-P0DT0H30M0S',
  'END:VALARM',
  'END:VEVENT',
  'END:VCALENDAR',
]);

describe('a Google invite', () => {
  const result = parseIcs(GOOGLE_INVITE, { addresses: ['me@owner.example'], timeZone: 'America/Los_Angeles' });
  const event = result.event!;

  it('reads its method, its event and its times in the zone it names', () => {
    expect(result).toMatchObject({ ok: true, method: 'request', event_count: 1, truncated: false, problems: [] });
    expect(event).toMatchObject({
      uid: 'abc123@google.com',
      recurrence_id: null,
      sequence: 0,
      status: 'confirmed',
      summary: 'Quarterly planning',
      all_day: false,
      start: '2026-10-15T14:00:00.000Z',
      end: '2026-10-15T15:00:00.000Z',
      start_ms: iso('2026-10-15T14:00:00Z'),
      time_zone: 'America/New_York',
      time_basis: 'zone',
      recurring: false,
    });
  });

  it("unescapes text, and a reminder's own DESCRIPTION and ATTENDEE stay the reminder's", () => {
    expect(event.description).toBe('Agenda:\n1. Plan, review; decide\n2. Next steps \\ owners');
    expect(event.location).toBe('Room 4, 2nd floor');
    expect(event.attendees.map((a) => a.email)).not.toContain('someone-else@example.com');
  });

  it('reads a quoted parameter holding ":" and ";", across a fold', () => {
    expect(event.organizer).toEqual({ email: 'alice@example.com', name: 'Alice Example' });
    expect(event.attendees.find((a) => a.email === 'bob@example.com')).toMatchObject({
      name: 'Doe; Bob', status: 'tentative', role: 'optional', kind: 'person',
    });
  });

  it('knows the owner by address, whatever its case, and counts the others — the room is no guest', () => {
    expect(event.you).toEqual({ role: 'attendee', email: 'me@owner.example', status: 'needs_action', rsvp: true });
    expect(event.attendee_count).toBe(4);
    expect(event.attendees.find((a) => a.email.startsWith('c_room4'))?.kind).toBe('resource');
    expect(event.others_count).toBe(1);
  });

  it("the owner's own address matches in any case, and with the spaces a setting may carry", () => {
    expect(parseIcs(GOOGLE_INVITE, { addresses: [' ME@Owner.EXAMPLE '] }).event!.you.role).toBe('attendee');
  });

  it('without the owner\'s addresses the owner is nobody, and counts as another guest', () => {
    const anon = parseIcs(GOOGLE_INVITE).event!;
    expect(anon.you.role).toBe('none');
    expect(anon.others_count).toBe(2);
  });
});

describe('what kind of message an invite is', () => {
  const one = (method: string | null, eventLines: readonly string[]): ReturnType<typeof parseIcs> => parseIcs(crlf([
    'BEGIN:VCALENDAR', ...(method === null ? [] : [`METHOD:${method}`]),
    'BEGIN:VEVENT', 'UID:u1', 'DTSTART:20261015T140000Z', ...eventLines, 'END:VEVENT', 'END:VCALENDAR',
  ]), { addresses: ['me@owner.example'] });

  it('a cancellation', () => {
    const result = one('CANCEL', ['STATUS:CANCELLED', 'SEQUENCE:3', 'ORGANIZER:mailto:alice@example.com', 'ATTENDEE:mailto:me@owner.example']);
    expect(result.method).toBe('cancel');
    expect(result.event).toMatchObject({ status: 'cancelled', sequence: 3, you: { role: 'attendee' } });
  });

  it("a guest's reply to the owner's own invite", () => {
    const result = one('REPLY', ['ORGANIZER:mailto:me@owner.example', 'ATTENDEE;PARTSTAT=DECLINED;CN=Bob:mailto:bob@example.com']);
    expect(result.method).toBe('reply');
    expect(result.event!.you.role).toBe('organizer');
    expect(result.event!.attendees).toEqual([
      { email: 'bob@example.com', name: 'Bob', status: 'declined', role: 'required', rsvp: false, kind: 'person' },
    ]);
  });

  it('a published event, and a plain calendar file with no method', () => {
    expect(one('PUBLISH', []).method).toBe('publish');
    expect(one(null, []).method).toBe('none');
    expect(one('X-SOMETHING', []).method).toBe('other');
  });

  it('an answer left unstated is NEEDS-ACTION', () => {
    expect(one('REQUEST', ['ATTENDEE:mailto:me@owner.example']).event!.you.status).toBe('needs_action');
  });
});

describe('times', () => {
  const at = (lines: readonly string[], opts: Parameters<typeof parseIcs>[1] = {}) => parseIcs(crlf([
    'BEGIN:VCALENDAR', ...lines.filter((l) => !l.startsWith('E:')),
    'BEGIN:VEVENT', 'UID:u1', ...lines.filter((l) => l.startsWith('E:')).map((l) => l.slice(2)), 'END:VEVENT',
    'END:VCALENDAR',
  ]), opts);

  it('an IANA zone named without its rules is read from the tables', () => {
    const event = at(['E:DTSTART;TZID=Europe/Berlin:20261025T100000', 'E:DTEND;TZID=Europe/Berlin:20261025T113000']).event!;
    expect(event).toMatchObject({ start: '2026-10-25T09:00:00.000Z', end: '2026-10-25T10:30:00.000Z', time_basis: 'zone' });
  });

  it("an old Thunderbird zone path is read by the zone name inside it", () => {
    const event = at(['E:DTSTART;TZID=/mozilla.org/20050126_1/America/New_York:20261015T100000']).event!;
    expect(event.start).toBe('2026-10-15T14:00:00.000Z');
  });

  it('a zone nothing knows leaves the times empty and says so — never a guess', () => {
    const result = at(['E:DTSTART;TZID=Mars Standard Time:20261015T100000']);
    expect(result.event).toMatchObject({ start: null, end: null, start_ms: null, time_basis: 'unresolved', time_zone: 'Mars Standard Time' });
    expect(result.event!.problems).toEqual(['its time zone "Mars Standard Time" is not one this reader knows']);
  });

  it("a floating time is read in the calendar's zone, else the owner's, else UTC with a word", () => {
    expect(at(['E:DTSTART:20261015T100000'], { timeZone: 'America/Los_Angeles' }).event)
      .toMatchObject({ start: '2026-10-15T17:00:00.000Z', time_basis: 'floating', time_zone: 'America/Los_Angeles' });
    expect(at(['X-WR-TIMEZONE:Europe/Berlin', 'E:DTSTART:20261015T100000'], { timeZone: 'America/Los_Angeles' }).event)
      .toMatchObject({ start: '2026-10-15T08:00:00.000Z', time_zone: 'Europe/Berlin' });
    const bare = at(['E:DTSTART:20261015T100000']).event!;
    expect(bare.start).toBe('2026-10-15T10:00:00.000Z');
    expect(bare.problems).toContain('its time names no zone, and was read in UTC');
  });

  it("an all-day event spans its days from the owner's midnight; its end is the day after the last", () => {
    const event = at(['E:DTSTART;VALUE=DATE:20261020', 'E:DTEND;VALUE=DATE:20261023'], { timeZone: 'America/Los_Angeles' }).event!;
    expect(event).toMatchObject({
      all_day: true,
      start_date: '2026-10-20',
      end_date: '2026-10-23',
      start_ms: iso('2026-10-20T07:00:00Z'),
      end_ms: iso('2026-10-23T07:00:00Z'),
      time_zone: null,
      time_basis: 'date',
    });
    expect(at(['E:DTSTART;VALUE=DATE:20261020']).event).toMatchObject({ end_date: '2026-10-21', start_ms: iso('2026-10-20T00:00:00Z') });
  });

  it('a duration counts its days on the calendar — across a change of clocks a day is still a day', () => {
    const event = at([...APPLE_NEW_YORK, 'E:DTSTART;TZID=America/New_York:20261031T100000', 'E:DURATION:P1DT1H']).event!;
    // 10:00 EDT on 31 October, then 11:00 EST on 1 November: 26 hours, not 25.
    expect(event.start).toBe('2026-10-31T14:00:00.000Z');
    expect(event.end).toBe('2026-11-01T16:00:00.000Z');
    expect(at(['E:DTSTART:20261015T140000Z', 'E:DURATION:PT1H30M']).event!.end).toBe('2026-10-15T15:30:00.000Z');
  });

  it('with neither an end nor a duration a timed event is an instant', () => {
    const event = at(['E:DTSTART:20261015T140000Z']).event!;
    expect(event.end_ms).toBe(event.start_ms);
  });

  it('an end before the start is said, and held at the start', () => {
    const event = at(['E:DTSTART:20261015T140000Z', 'E:DTEND:20261015T130000Z']).event!;
    expect(event.end).toBe(event.start);
    expect(event.problems).toContain('it ends before it starts');
  });

  it('a date that does not exist is no time', () => {
    const result = at(['E:DTSTART:20260230T100000Z']);
    expect(result.events).toEqual([]);
    expect(result.problems).toEqual(['event u1: it has no start time this reader understands']);
  });
});

describe("an event's time in the owner's words", () => {
  const one = (eventLines: readonly string[], timeZone?: string) => parseIcs(crlf([
    'BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:u1', ...eventLines, 'END:VEVENT', 'END:VCALENDAR',
  ]), timeZone === undefined ? {} : { timeZone }).event!;

  it("a timed event is told in the owner's zone, not the server's", () => {
    // 10:00–11:00 in New York is 07:00–08:00 in Los Angeles.
    expect(parseIcs(GOOGLE_INVITE, { timeZone: 'America/Los_Angeles' }).event!.when).toBe('Thu 15 Oct 2026, 07:00–08:00');
    // East of UTC the same hour crosses midnight, and says so.
    expect(parseIcs(GOOGLE_INVITE, { timeZone: 'Asia/Tokyo' }).event!.when).toBe('Thu 15 Oct 2026, 23:00 – Fri 16 Oct 2026, 00:00');
  });

  it('days are told as days: one, or the first and the last', () => {
    expect(one(['DTSTART;VALUE=DATE:20261020'], 'America/Los_Angeles').when).toBe('Tue 20 Oct 2026');
    expect(one(['DTSTART;VALUE=DATE:20261020', 'DTEND;VALUE=DATE:20261023']).when).toBe('Tue 20 Oct – Thu 22 Oct 2026');
    expect(one(['DTSTART;VALUE=DATE:20261230', 'DTEND;VALUE=DATE:20270102']).when).toBe('Wed 30 Dec 2026 – Fri 1 Jan 2027');
  });

  it('an instant has one time; an unread zone has no words', () => {
    expect(one(['DTSTART:20261015T140000Z'], 'Europe/Berlin').when).toBe('Thu 15 Oct 2026, 16:00');
    expect(one(['DTSTART;TZID=Mars Standard Time:20261015T100000']).when).toBeNull();
  });
});

describe('a series', () => {
  const result = parseIcs(crlf([
    'BEGIN:VCALENDAR', 'METHOD:REQUEST', ...W_EUROPE,
    'BEGIN:VEVENT', 'UID:weekly@x', 'RECURRENCE-ID;TZID=W. Europe Standard Time:20261022T090000',
    'DTSTART;TZID=W. Europe Standard Time:20261022T110000', 'DTEND;TZID=W. Europe Standard Time:20261022T113000',
    'SUMMARY:Standup (moved)', 'SEQUENCE:2', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:weekly@x', 'RRULE:FREQ=WEEKLY;BYDAY=TH',
    'DTSTART;TZID=W. Europe Standard Time:20261015T090000', 'DTEND;TZID=W. Europe Standard Time:20261015T093000',
    'SUMMARY:Standup', 'SEQUENCE:1', 'END:VEVENT',
    'END:VCALENDAR',
  ]));

  it('is the series and each occurrence it moves; the series is the event', () => {
    expect(result.events).toHaveLength(2);
    expect(result.event).toMatchObject({ summary: 'Standup', recurring: true, rrule: 'FREQ=WEEKLY;BYDAY=TH', recurrence_id: null });
    expect(result.events[0]).toMatchObject({
      summary: 'Standup (moved)',
      recurrence_id: '2026-10-22T07:00:00.000Z',
      start: '2026-10-22T09:00:00.000Z',
      recurring: false,
    });
  });
});

describe('bytes', () => {
  it('a line folded inside a multi-byte character is whole again', () => {
    const summary = Buffer.from('SUMMARY:Café ☕ chat', 'utf8');
    const cut = summary.indexOf(Buffer.from('☕', 'utf8')) + 1;
    const bytes = Buffer.concat([
      Buffer.from('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:u1\r\nDTSTART:20261015T140000Z\r\n'),
      summary.subarray(0, cut), Buffer.from('\r\n '), summary.subarray(cut),
      Buffer.from('\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'),
    ]);
    expect(parseIcs(new Uint8Array(bytes)).event!.summary).toBe('Café ☕ chat');
  });

  it('knows an iCalendar file by how it begins — a BOM, blank lines, any case', () => {
    expect(looksLikeIcs(new Uint8Array(Buffer.from('﻿\r\n\r\nbegin:vcalendar\r\n', 'utf8')))).toBe(true);
    expect(looksLikeIcs(new Uint8Array(Buffer.from('BEGIN:VCARD\r\n')))).toBe(false);
    expect(looksLikeIcs(new Uint8Array(Buffer.from('%PDF-1.7')))).toBe(false);
    expect(looksLikeIcs(new Uint8Array(0))).toBe(false);
  });

  it('what is not a calendar reads as nothing', () => {
    expect(parseIcs('hello')).toMatchObject({ ok: false, events: [], event: null });
    expect(parseIcs('BEGIN:VCARD\r\nFN:x\r\nEND:VCARD\r\n').ok).toBe(false);
  });

  it(`a file over ${ICS_MAX_BYTES} bytes is refused, not read`, () => {
    const big = `BEGIN:VCALENDAR\r\nX-PAD:${'x'.repeat(ICS_MAX_BYTES)}\r\nEND:VCALENDAR\r\n`;
    expect(parseIcs(big)).toMatchObject({ ok: false, problems: [`the file is larger than ${ICS_MAX_BYTES} bytes`] });
  });

  it('an event with no UID is left out and named; a calendar never closed still reads', () => {
    const result = parseIcs('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:20261015T140000Z\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:u2\r\nDTSTART:20261015T140000Z\r\nEND:VEVENT\r\n');
    expect(result.events.map((e) => e.uid)).toEqual(['u2']);
    // The file's own shape is read first, then its events.
    expect(result.problems).toEqual(['"VCALENDAR" was never closed', 'an event without a UID was left out']);
  });
});

describe('one invite, two copies', () => {
  const lf = GOOGLE_INVITE.replace(/\r\n/g, '\n');
  const refolded = GOOGLE_INVITE.replace('SUMMARY:Quarterly planning', 'SUMMARY:Quarterly\r\n  planning');

  it('the inline copy and the attached one have one key, however they are written', () => {
    const key = icsInviteKey(GOOGLE_INVITE);
    expect(key).toBe('REQUEST|abc123@google.com||0');
    expect(icsInviteKey(lf)).toBe(key);
    expect(icsInviteKey(new Uint8Array(Buffer.from(refolded)))).toBe(key);
  });

  it('an update is another invite', () => {
    expect(icsInviteKey(GOOGLE_INVITE.replace('SEQUENCE:0', 'SEQUENCE:1'))).not.toBe(icsInviteKey(GOOGLE_INVITE));
    expect(icsInviteKey(GOOGLE_INVITE.replace('METHOD:REQUEST', 'METHOD:CANCEL'))).not.toBe(icsInviteKey(GOOGLE_INVITE));
  });

  it('what is no invite has no key', () => {
    expect(icsInviteKey('hello')).toBeNull();
    expect(icsInviteKey('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n')).toBeNull();
  });
});

describe('the clock, for a reader that writes the file back (the CalDAV adapter)', () => {
  const file = crlf(['BEGIN:VCALENDAR', 'VERSION:2.0', ...PACIFIC, 'END:VCALENDAR']);

  it("turns a wall clock into an instant and back on a zone's own rules, as the IANA tables do", () => {
    const zone = icsClock(file).zone('Pacific Standard Time', false);
    expect(zone.basis).toBe('zone');
    for (let t = iso('2026-01-01T00:00:00Z'); t < iso('2027-01-01T00:00:00Z'); t += 7 * HOUR) {
      const wall = zone.toWall(t)!;
      expect(wall).toBe(t + zoneOffsetMsAt(t, 'America/Los_Angeles'));
      // Back again, except in the hour a change of clocks repeats.
      if (zoneOffsetMsAt(t - HOUR, 'America/Los_Angeles') === zoneOffsetMsAt(t + HOUR, 'America/Los_Angeles')) {
        expect(zone.toUtc(wall)).toBe(t);
      }
    }
  });

  it("reads a floating time in the calendar's zone, else the owner's, else UTC; a zone nothing reads is unresolved", () => {
    const tenAm = readIcsDateTime('20261017T100000')!.wall;
    expect(icsClock(file, { timeZone: 'America/New_York' }).zone(undefined, false).toUtc(tenAm)).toBe(iso('2026-10-17T14:00:00Z'));
    const london = crlf(['BEGIN:VCALENDAR', 'X-WR-TIMEZONE:Europe/London', 'END:VCALENDAR']);
    expect(icsClock(london, { timeZone: 'America/New_York' }).zone(undefined, false).name).toBe('Europe/London');
    expect(icsClock(file).zone(undefined, false).toUtc(tenAm)).toBe(iso('2026-10-17T10:00:00Z'));
    expect(icsClock(file).zone(undefined, true).basis).toBe('utc');
    const nowhere = icsClock(file).zone('Nowhere Standard Time', false);
    expect(nowhere.basis).toBe('unresolved');
    expect(nowhere.toUtc(tenAm)).toBeNull();
    expect(icsClock(file).hasRules('Pacific Standard Time')).toBe(true);
    expect(icsClock(file).hasRules('America/Los_Angeles')).toBe(false);
  });
});
