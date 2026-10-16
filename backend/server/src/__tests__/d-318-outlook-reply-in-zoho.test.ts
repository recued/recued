/** D-318 — the email chat door's pieces, over an Outlook 16 reply received in a
 *  Zoho mailbox (`fixtures/mail-outlook-reply-in-zoho`: the structure of a real
 *  one, every word replaced).
 *
 *  Through the real IMAP parse (`canonicalizeImap`, mailparser) and the door's
 *  real readers:
 *  - the content boundary: the reply alone, its typed sign-off kept, the chain
 *    of earlier Outlook and Zoho replies cut — from the HTML, and from Outlook's
 *    plain text, which quotes with header blocks and no `>`;
 *  - ⛔ the embedded image: Outlook sends its logo inside `multipart/related`
 *    with a Content-ID and NO disposition. Read as an attachment (as it was),
 *    the logo of an earlier message in the chain became the turn's file. It is
 *    the HTML's own image (RFC 2387), and the HTML shows it only in the quoted
 *    history, so the door leaves it out;
 *  - Zoho's stamp names no DMARC result: the door's sender check derives one
 *    from its SPF pass for exactly the sender's domain (step 8). */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { dmarcResultFor, senderCheckFor } from '../collections/mail/authentication-results.js';
import { canonicalizeImap } from '../collections/mail/imap-provider.js';
import type { MailUpsertAttachment } from '../collections/mail/mail-collection.js';
import { mailPartDisposition } from '../collections/mail/provider.js';
import { mailChatTurnFiles } from '../mail-chat-door/attachments.js';
import { mailChatHtmlOwnText } from '../mail-chat-door/html-text.js';
import { mailChatOwnLines } from '../mail-chat-door/message-text.js';

const SOURCE = readFileSync(new URL('./fixtures/mail-outlook-reply-in-zoho/reply.eml', import.meta.url));
const parse = (source: Buffer = SOURCE) =>
  canonicalizeImap(source, { uid: 7, folder: 'INBOX', flags: new Set(), internalDate: new Date('2026-09-24T06:35:36Z') });

const REPLY = [
  'Dear Kai,',
  'Thank you for your email below.',
  'We confirm that the filing is proceeding as planned, and no further action is needed from you at this stage.',
  'We will update you as soon as the office issues its next notice.',
  'Best regards',
  'Sam Counsel',
  'Example IP Ltd.',
  'HK',
];
/** What only the earlier messages say. */
const CHAIN = ['Could you check whether the name', 'filing receipt', 'first notice', 'From:', 'Sent:', 'Subject:'];
const lines = (text: string): string[] => text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);

/** The stored file, as the mail collection hands the door each attachment. */
const stored = async (msg: Awaited<ReturnType<typeof parse>>): Promise<MailUpsertAttachment[]> =>
  Promise.all((msg.attachments ?? []).map(async (part, i) => ({
    file_id: `file:${i}`,
    filename: part.filename,
    mime_type: part.mime_type,
    ...(part.disposition !== undefined ? { disposition: part.disposition } : {}),
    media_class: 'image',
    content_hash: createHash('sha256').update(await part.fetchBytes()).digest('hex'),
  })));

describe('an Outlook reply carrying a chain of Zoho and Outlook replies', () => {
  it('the content boundary: the reply alone, its sign-off kept — from the HTML', async () => {
    const msg = await parse();
    const own = mailChatHtmlOwnText(msg.body_html!);
    expect(own.cut).toBe('quote');
    expect(lines(own.text)).toEqual(REPLY);
    // The door's line rules, run on the HTML's own part as well, keep it whole.
    expect(lines(mailChatOwnLines(own.text, { continuing: true }).text)).toEqual(REPLY);
  });

  it('…and from Outlook’s plain text, which quotes with header blocks and no `>`', async () => {
    const msg = await parse();
    const own = mailChatOwnLines(msg.body_text, { continuing: true });
    expect(lines(own.text)).toEqual(REPLY);
    for (const words of CHAIN) expect(own.text).not.toContain(words);
    // Starting a conversation, the email it replies to is mail.
    expect(mailChatOwnLines(msg.body_text, { continuing: false }).mail_cut).toBe(true);
  });

  it('⛔ the logo Outlook sends with no disposition is the HTML’s own image, not an attachment', async () => {
    const msg = await parse();
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments![0]).toMatchObject({ filename: 'image001.jpg', disposition: 'inline' });
    // The parser wrote it into the HTML by its bytes — after the reply's end.
    const html = msg.body_html!;
    expect(html.indexOf('data:image/jpeg')).toBeGreaterThan(html.indexOf('border-top:solid #E1E1E1'));
  });

  it('⛔ so the door leaves it out of the turn: it shows only in the quoted history', async () => {
    const msg = await parse();
    expect(mailChatTurnFiles(msg.body_html, await stored(msg))).toEqual([]);
  });

  it('an image the reply itself shows stays — a photo pasted into the text', async () => {
    const msg = await parse();
    const [file] = await stored(msg);
    const bytes = await msg.attachments![0]!.fetchBytes();
    const html = msg.body_html!.replace('Dear Kai,', `Dear Kai,<img src="data:image/jpeg;base64,${bytes.toString('base64')}">`);
    expect(mailChatTurnFiles(html, [file!])).toEqual([{ file_id: 'file:0', media_class: 'image' }]);
  });

  it('a related part that SAYS it is an attachment is one', async () => {
    const source = Buffer.from(SOURCE.toString('latin1')
      .replace('Content-ID: <image001.jpg@', 'Content-Disposition: attachment; filename="image001.jpg"\r\nContent-ID: <image001.jpg@'), 'latin1');
    const msg = await parse(source);
    expect(msg.attachments![0]).toMatchObject({ disposition: 'attachment' });
    expect(mailChatTurnFiles(msg.body_html, await stored(msg))).toEqual([{ file_id: 'file:0', media_class: 'image' }]);
  });

  it('Zoho’s stamp names no DMARC result; step 8 derives the pass from its SPF pass for exactly the sender’s domain', async () => {
    const msg = await parse();
    expect(msg.headers?.['authentication-results']).toMatch(/^mx\.zohomail\.com;/);
    expect(dmarcResultFor(msg.headers?.['authentication-results'], 'firm.example')).toBeNull();
    expect(senderCheckFor(msg.headers?.['authentication-results'], 'firm.example'))
      .toEqual({ stamped_by: 'mx.zohomail.com', result: 'pass' });
  });
});

describe('mailPartDisposition — a part’s disposition as the message means it', () => {
  it('an explicit disposition is what it says; with none, a related part is inline and any other an attachment', () => {
    expect(mailPartDisposition('inline', false)).toBe('inline');
    expect(mailPartDisposition('Inline; filename="a.png"', false)).toBe('inline');
    expect(mailPartDisposition('attachment; filename="a.png"', true)).toBe('attachment');
    expect(mailPartDisposition(undefined, true)).toBe('inline');
    expect(mailPartDisposition('', true)).toBe('inline');
    expect(mailPartDisposition(undefined, false)).toBe('attachment');
    expect(mailPartDisposition(null, false)).toBe('attachment');
  });
});
