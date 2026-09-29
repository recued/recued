/** D-315 slice 1 — every provider hands the ingest the sender's display name and
 *  the headers, which mail-fact templates read (§4.1, §4.2). In memory only:
 *  neither is stored on the mail row. */

import { describe, expect, it } from 'vitest';

import { canonicalizeGmail } from '../collections/mail/gmail-provider.js';
import { canonicalizeGraph } from '../collections/mail/graph-provider.js';
import { canonicalizeImap } from '../collections/mail/imap-provider.js';
import {
  decodeMailHeaderWords,
  mailHeaderMap,
  mailParsedFromName,
} from '../collections/mail/provider.js';

const rfc822 = [
  'From: "UPS Notifications" <pkginfo@ups.com>',
  'To: me@example.com',
  'Subject: =?UTF-8?B?VVBTIFVwZGF0ZTogWm9sbCBiZXphaGx0?=',
  'Message-ID: <m1@ups.com>',
  'Date: Fri, 25 Sep 2026 10:00:00 +0000',
  'X-Shipment-Ref: =?UTF-8?Q?Paket_f=C3=BCr_Sie?=',
  'List-Id: UPS updates',
  ' <updates.ups.com>',
  'Constructor: not a method',
  'X-Shipment-Ref: a second value',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Tracking Number: 1Z0000000000000001',
  '',
].join('\r\n');

const expectSenderAndHeaders = (msg: { from_name?: string; headers?: Readonly<Record<string, string>> }): void => {
  expect(msg.from_name).toBe('UPS Notifications');
  const headers = msg.headers!;
  // A custom header is decoded; the first of two values is kept.
  expect(headers['x-shipment-ref']).toBe('Paket für Sie');
  // A folded header is unfolded.
  expect(headers['list-id']).toBe('UPS updates <updates.ups.com>');
  // A header named like an Object member is data, never the member.
  expect(headers.constructor).toBe('not a method');
  expect(headers['hasOwnProperty']).toBeUndefined();
  expect(Object.getPrototypeOf(headers)).toBeNull();
};

describe('the sender and headers each provider hands the ingest', () => {
  it('Gmail', async () => {
    const msg = await canonicalizeGmail({
      id: 'g1',
      threadId: 't1',
      labelIds: ['INBOX'],
      raw: Buffer.from(rfc822).toString('base64url'),
      internalDate: '1790000000000',
    });
    expectSenderAndHeaders(msg);
  });

  it('IMAP', async () => {
    const msg = await canonicalizeImap(Buffer.from(rfc822), {
      uid: 7,
      folder: 'INBOX',
      flags: new Set(),
      internalDate: undefined,
    });
    expectSenderAndHeaders(msg);
  });

  it('Graph', () => {
    const msg = canonicalizeGraph({
      id: 'x1',
      from: { emailAddress: { address: 'pkginfo@ups.com', name: ' UPS Notifications ' } },
      internetMessageHeaders: [
        { name: 'X-Shipment-Ref', value: '=?UTF-8?Q?Paket_f=C3=BCr_Sie?=' },
        { name: 'List-Id', value: 'UPS updates <updates.ups.com>' },
        { name: 'constructor', value: 'not a method' },
        { name: 'X-Shipment-Ref', value: 'a second value' },
        { name: 'X-Broken' },
      ],
    });
    expectSenderAndHeaders(msg);
    expect(msg.headers!['x-broken']).toBeUndefined();
  });

  it('gives an empty name when the sender has none', () => {
    expect(mailParsedFromName(undefined)).toBe('');
    expect(mailParsedFromName({ value: [{ name: '' }] })).toBe('');
    expect(mailParsedFromName([{ value: [{ name: 'A' }] }, { value: [{ name: 'B' }] }])).toBe('A');
    expect(mailHeaderMap([['', 'x'], ['  X-A ', ' 1 ']])).toEqual({ 'x-a': '1' });
  });

  it('decodes encoded words: B and Q, adjacent words joined, other charsets, unknown ones kept', () => {
    expect(decodeMailHeaderWords('=?UTF-8?B?Wm9sbCBiZXphaGx0?=')).toBe('Zoll bezahlt');
    expect(decodeMailHeaderWords('=?utf-8?q?f=C3=BCr_Sie?= heute')).toBe('für Sie heute');
    expect(decodeMailHeaderWords('=?UTF-8?Q?Paket_?= =?UTF-8?Q?f=C3=BCr?=')).toBe('Paket für');
    expect(decodeMailHeaderWords('=?ISO-8859-1?Q?caf=E9?=')).toBe('café');
    expect(decodeMailHeaderWords('=?x-unknown?Q?abc?=')).toBe('=?x-unknown?Q?abc?=');
    expect(decodeMailHeaderWords('plain ASCII, no words')).toBe('plain ASCII, no words');
  });
});
