/** D-336 (spec §42) — two approvals that hid whom a call goes to. SendGrid's recipients sat
 *  below the ask's depth cut (`personalizations: 1: {to: 1: …}`), and Gmail's `send_raw` passes
 *  the whole email encoded (`body.raw: VG86IG1p…`). */

import { describe, expect, it, vi } from 'vitest';

import {
  ANY_ARGUMENT, describeEncodedEmail, readEncodedEmailHeaders, renderBatchItemsBlock, type ApprovalValueLabels,
} from '../index.js';

const PEOPLE: ApprovalValueLabels = { [ANY_ARGUMENT]: { 'mia@example.com': 'Mia Whitfield <mia@example.com>' } };
const block = (args: Record<string, unknown>, labels?: ApprovalValueLabels) =>
  renderBatchItemsBlock([{ summary: 'x', args_preview: args }], labels);
/** An email as Gmail's `send_raw` takes it: base64url, no padding. */
const encode = (message: string) => Buffer.from(message, 'utf8').toString('base64url');

describe('the depth cut never hides whom a call goes to', () => {
  it("SendGrid's recipients read below the cut, by name where they are contacts", () => {
    const sendgrid = { body: {
      personalizations: [{ to: [{ email: 'mia@example.com' }, { email: 'bob@example.com', name: 'Bob' }] }],
      subject: 'Late',
    } };
    expect(block(sendgrid, PEOPLE)).toContain('personalizations: 1: {to: 2: Mia Whitfield <mia@example.com>, bob@example.com}');
    expect(block(sendgrid)).toContain('personalizations: 1: {to: 2: mia@example.com, bob@example.com}');
  });

  it('a cut with no one below it reads as before', () => {
    expect(block({ body: { a: [{ b: [{ c: 1, d: 'x' }] }] } })).toContain('a: 1: {b: 1: …}');
    // Text that only mentions an address is not a person.
    expect(block({ body: { a: [{ b: [{ note: 'write to mia@example.com soon' }] }] } })).toContain('a: 1: {b: 1: …}');
  });
});

describe('an encoded email reads as whom it goes to and its subject', () => {
  const RAW = encode('To: Mia <mia@example.com>, bob@example.com\r\nCc: carol@example.com\r\n'
    + 'Subject: Running late\r\nContent-Type: text/plain\r\n\r\nSee you soon.\r\nBcc: eve@example.com\r\n');

  it('on the ask, each address as the owner knows it, whom first; the call keeps the encoding', () => {
    const short = encode('To: Mia <mia@example.com>\r\nSubject: Running late\r\n\r\nSee you soon.');
    expect(block({ body: { raw: short } }, PEOPLE)).toBe(
      '  body.raw: An email to Mia Whitfield <mia@example.com>; subject: Running late');
    // A line too long for the ask is clipped as any value is, the people first.
    expect(block({ body: { raw: RAW } }, PEOPLE)).toContain(
      '  body.raw: An email to 2: Mia Whitfield <mia@example.com>, bob@example.com; cc: carol@example.com; subject…');
    expect(block({ raw: RAW })).toContain('raw: An email to 2: mia@example.com, bob@example.com;');
  });

  it('reads only the headers: never the body, a folded line joined, an encoded subject left out', () => {
    const headers = readEncodedEmailHeaders(RAW);
    expect(headers).toEqual({ to: ['mia@example.com', 'bob@example.com'], cc: ['carol@example.com'], bcc: [], subject: 'Running late' });
    const folded = encode('From: me@example.com\nTo: Mia <mia@example.com>,\n bob@example.com\nSubject: =?UTF-8?B?w6l0w6k=?=\n\nhi');
    expect(readEncodedEmailHeaders(folded)).toEqual({ to: ['mia@example.com', 'bob@example.com'], cc: [], bcc: [] });
    expect(describeEncodedEmail(folded)).toBe('An email to 2: mia@example.com, bob@example.com');
    // A large message decodes its start alone.
    const large = encode(`To: mia@example.com\nSubject: Photos\n\n${'x'.repeat(2_000_000)}`);
    const atob = vi.spyOn(globalThis, 'atob');
    try {
      expect(describeEncodedEmail(large)).toBe('An email to mia@example.com; subject: Photos');
      expect(Math.max(...atob.mock.calls.map(([text]) => text.length))).toBeLessThanOrEqual(8192);
    } finally {
      atob.mockRestore();
    }
  });

  it('anything that is not an encoded email is left as it is', () => {
    for (const value of [
      encode('ABCDEFGHIJKLMNOPQRSTUVWXYZ'), // decodes, but to no header
      encode('Subject: Late\n\nno one to send to'), // headers, but no one to send to
      encode('Hello there\nTo: mia@example.com\n\nbody'), // a To line, but text first: no header opens it
      'not base64 at all, with spaces', 'short', 42, undefined,
    ]) {
      expect(readEncodedEmailHeaders(value)).toBeUndefined();
    }
    const note = encode('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    expect(block({ note })).toContain(`note: ${note}`);
  });
});
