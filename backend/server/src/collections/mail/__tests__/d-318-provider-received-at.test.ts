/** D-318 step 1 — what each mail sync hands the email chat door.
 *
 *  - **The provider's own received time** (`provider_received_at`): Gmail's
 *    `internalDate`, IMAP's `INTERNALDATE`, Graph's `receivedDateTime`. The
 *    door measures a request's age with it (ruling 7), because `received_at`
 *    is the sender's `Date:` line on Gmail and IMAP — a clock the sender owns.
 *    Each case below gives the two times an HOUR apart, so a sync that copied
 *    one into the other fails.
 *  - **The headers the door reads** (§4.7, §4.13): the automatic-mail markers,
 *    the reply chain, and the receiving provider's DMARC stamp, in the in-memory
 *    header map, lower-cased. */

import { describe, expect, it } from 'vitest';

import { canonicalizeGmail } from '../gmail-provider.js';
import { canonicalizeGraph } from '../graph-provider.js';
import { canonicalizeImap } from '../imap-provider.js';

const SENDER_DATE = Date.UTC(2026, 9, 14, 9, 0, 0);
const PROVIDER_TIME = SENDER_DATE + 60 * 60 * 1000;

const DOOR_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ['Auto-Submitted', 'auto-replied'],
  ['Precedence', 'bulk'],
  ['List-Id', '<news.example.com>'],
  ['In-Reply-To', '<answer-1@recued.example>'],
  ['References', '<request-0@example.com> <answer-1@recued.example>'],
  ['Authentication-Results', 'mx.google.com; dmarc=pass (p=NONE) header.from=example.com'],
];

const raw = (): string => [
  'From: Owner <owner@example.com>',
  'To: Recued <recued@owner.example>',
  'Subject: ask: what is due this week?',
  `Date: ${new Date(SENDER_DATE).toUTCString()}`,
  'Message-ID: <request-1@example.com>',
  ...DOOR_HEADERS.map(([name, value]) => `${name}: ${value}`),
  'Content-Type: text/plain; charset=utf-8',
  '',
  'What is due this week?',
  '',
].join('\r\n');

const expectDoorHeaders = (headers: Readonly<Record<string, string>> | undefined): void => {
  for (const [name, value] of DOOR_HEADERS) expect(headers?.[name.toLowerCase()]).toBe(value);
};

describe('D-318 step 1 — the provider received time and the door\'s headers', () => {
  it('Gmail: internalDate beside the sender\'s Date line, and every door header', async () => {
    const msg = await canonicalizeGmail({
      id: 'gmail-1',
      threadId: 'thread-1',
      labelIds: ['INBOX'],
      internalDate: String(PROVIDER_TIME),
      raw: Buffer.from(raw()).toString('base64url'),
    });
    expect(msg.received_at).toBe(SENDER_DATE);
    expect(msg.provider_received_at).toBe(PROVIDER_TIME);
    expectDoorHeaders(msg.headers);
  });

  it('Gmail: no internalDate, no provider time', async () => {
    const msg = await canonicalizeGmail({
      id: 'gmail-2',
      threadId: 'thread-2',
      labelIds: ['INBOX'],
      raw: Buffer.from(raw()).toString('base64url'),
    });
    expect(msg.received_at).toBe(SENDER_DATE);
    expect(Object.hasOwn(msg, 'provider_received_at')).toBe(false);
  });

  it('IMAP: INTERNALDATE beside the sender\'s Date line, as a Date or a string, and every door header', async () => {
    for (const internalDate of [new Date(PROVIDER_TIME), new Date(PROVIDER_TIME).toISOString()]) {
      const msg = await canonicalizeImap(Buffer.from(raw()), {
        uid: 7,
        folder: 'INBOX',
        flags: new Set(),
        internalDate,
      });
      expect(msg.received_at).toBe(SENDER_DATE);
      expect(msg.provider_received_at).toBe(PROVIDER_TIME);
      expectDoorHeaders(msg.headers);
    }
    const none = await canonicalizeImap(Buffer.from(raw()), { uid: 8, folder: 'INBOX', flags: new Set(), internalDate: undefined });
    expect(Object.hasOwn(none, 'provider_received_at')).toBe(false);
  });

  it('Graph: receivedDateTime is the provider\'s time, and every door header from internetMessageHeaders', () => {
    const msg = canonicalizeGraph({
      id: 'graph-1',
      subject: 'ask: what is due this week?',
      receivedDateTime: new Date(PROVIDER_TIME).toISOString(),
      internetMessageHeaders: DOOR_HEADERS.map(([name, value]) => ({ name, value })),
      body: { contentType: 'text', content: 'What is due this week?' },
    });
    expect(msg.received_at).toBe(PROVIDER_TIME);
    expect(msg.provider_received_at).toBe(PROVIDER_TIME);
    expectDoorHeaders(msg.headers);
  });
});

describe('D-318 step 4 — what an inline image carries', () => {
  const related = (): string => [
    'From: Owner <owner@example.com>',
    'To: Recued <recued@owner.example>',
    'Subject: ask: what is this?',
    `Date: ${new Date(SENDER_DATE).toUTCString()}`,
    'Message-ID: <request-2@example.com>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/related; boundary="rel"',
    '',
    '--rel',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<div>What is this?</div><div class="gmail_signature"><img src="cid:logo@example.com"></div>',
    '--rel',
    'Content-Type: image/png; name="logo.png"',
    'Content-Disposition: inline; filename="logo.png"',
    'Content-ID: <logo@example.com>',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('a logo').toString('base64'),
    '--rel--',
    '',
  ].join('\r\n');

  it('IMAP: inline — and the parser writes it into the HTML by its bytes, not its Content-ID', async () => {
    const msg = await canonicalizeImap(Buffer.from(related()), {
      uid: 9, folder: 'INBOX', flags: new Set(), internalDate: new Date(PROVIDER_TIME),
    });
    expect(msg.attachments?.[0]).toMatchObject({ filename: 'logo.png', disposition: 'inline' });
    // ⚠ mailparser replaces each cid: link with a data: URI, so the door also
    // places an image by its bytes (attachments.ts).
    expect(msg.body_html).not.toContain('cid:logo@example.com');
    expect(msg.body_html).toContain(`data:image/png;base64,${Buffer.from('a logo').toString('base64')}`);
  });
});
