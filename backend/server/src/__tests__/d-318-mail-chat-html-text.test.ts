/** D-318 audit — the owner's own words from an email's HTML (`html-text.ts`):
 *  where each mail app marks its signature and its quoted history, the owner's
 *  text around it as lines, what was left out, and — read as a stranger's email
 *  lands, before any proof — in linear time. The HTML shapes are the ones mail
 *  apps write.
 *
 *  §8.12: a reply's quote containers are removed wherever they are (an answer
 *  below the quote, or between its parts, is the owner's); a divider, a
 *  signature, or an attached email the parser wrote into the HTML ends the
 *  owner's part; a forward ends at its first container. */

import { describe, expect, it } from 'vitest';

import type { MailUpsertAttachment } from '../collections/mail/mail-collection.js';
import { canonicalizeImap } from '../collections/mail/imap-provider.js';
import { isAttachedEmail, mailChatTurnFiles } from '../mail-chat-door/attachments.js';
import { MAIL_CHAT_HTML_MAX, mailChatHtmlOwnText, mailChatHtmlToText } from '../mail-chat-door/html-text.js';
import { mailChatOwnLines } from '../mail-chat-door/message-text.js';

describe('mailChatHtmlOwnText — where each mail app’s own part ends', () => {
  it.each([
    ['Gmail’s quote', '<div dir="ltr">Sounds good, <b>book</b> it.<div><br></div><div>Thanks!</div></div><br>'
      + '<div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Tue, Oct 14, 2026 at 9:00 AM Recued '
      + '&lt;recued@chat.example&gt; wrote:<br></div><blockquote class="gmail_quote">The table is free at 7.</blockquote></div>',
    'Sounds good, book it.\n\nThanks!'],
    ['Gmail’s signature', '<div dir="ltr">Book it.<br clear="all"><div><br></div><span class="gmail_signature_prefix">-- </span>'
      + '<br><div dir="ltr" class="gmail_signature">Ann Smith<br>+1 555 0100</div></div>', 'Book it.', 'signature'],
    ['Outlook on the web', '<div style="font-family:Aptos">Please file the invoices.</div><div id="Signature"><p>Ann Smith | '
      + '+1 555 0100</p></div><div id="appendonsend"></div><hr style="display:inline-block;width:98%"><div id="divRplyFwdMsg" '
      + 'dir="ltr"><b>From:</b> Bob<br><b>Sent:</b> Monday</div><div>old text</div>', 'Please file the invoices.'],
    ['Outlook on the desktop', '<html><head><style>p.MsoNormal{margin:0}</style></head><body><div class="WordSection1">'
      + '<p class="MsoNormal">Yes, go ahead.<o:p></o:p></p><p class="MsoNormal"><a name="_MailAutoSig">Ann Smith</a></p>'
      + '<div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0in 0in 0in"><p class="MsoNormal"><b>From:</b> '
      + 'Recued</p></div></div></body></html>', 'Yes, go ahead.'],
    ['Apple Mail', '<html><body><div>Here it is.</div><div><br><div id="AppleMailSignature" dir="ltr">Sent from my iPhone</div>'
      + '<div dir="ltr"><br><blockquote type="cite">On Oct 14, 2026, at 09:00, Recued wrote:</blockquote></div></div></body></html>',
    'Here it is.'],
    ['Thunderbird', '<p>Fine by me.</p><div class="moz-cite-prefix">On 14/10/2026 09:00, Recued wrote:<br></div>'
      + '<blockquote type="cite">Booked.</blockquote><div class="moz-signature">-- <br>Ann</div>', 'Fine by me.'],
    ['a plain `-- ` line', '<p>Book it.</p>\n-- <br>Ann<br>+1 555 0100', 'Book it.', 'signature'],
  ])('%s', (_app, html, text, cut = 'quote') => {
    expect(mailChatHtmlOwnText(html)).toEqual({ text, cut });
  });

  it('keeps lines, decodes entities, and reads no comment, style, script or title', () => {
    expect(mailChatHtmlOwnText('<p>Three things:</p><ul><li>milk</li><li>eggs &amp; bread</li></ul>'
      + '<p>That&#8217;s all&nbsp;&#x2014; thanks</p>'))
      .toEqual({ text: 'Three things:\n\nmilk\n\neggs & bread\n\nThat’s all — thanks', cut: 'none' });
    expect(mailChatHtmlToText('<!-- a comment with <b>tags</b> --><style>.x{color:red}</style>'
      + '<script>var a = "<p>no</p>";</script><head><title>t</title></head><p>Only this.</p>')).toBe('Only this.');
  });

  it('says something was cut only when words were', () => {
    expect(mailChatHtmlOwnText('<div>ok</div><div class="gmail_signature"></div>')).toEqual({ text: 'ok', cut: 'none' });
    expect(mailChatHtmlOwnText('<div>just <i>this</i></div>')).toEqual({ text: 'just this', cut: 'none' });
    expect(mailChatHtmlOwnText('<div>ok</div><blockquote> <br></blockquote>')).toEqual({ text: 'ok', cut: 'none' });
  });

  it('a signature alone is a signature; with quoted history after it, the quote is what was cut', () => {
    expect(mailChatHtmlOwnText('<div>Book it.</div><div id="Signature">Ann | +1 555 0100</div>').cut).toBe('signature');
    expect(mailChatHtmlOwnText('<div>Book it.</div><div id="Signature">Ann</div><hr><div id="divRplyFwdMsg">'
      + '<b>From:</b> Bob</div><div>old</div>').cut).toBe('quote');
  });

  it('reads an HTML that leaves `</head>` out — its body is not lost with the head', () => {
    // HTML may omit `</head>`: removing the head to its close took the whole email.
    expect(mailChatHtmlOwnText('<html><head><meta charset="utf-8"><title>t</title><body><p>Book it.</p></body></html>'))
      .toEqual({ text: 'Book it.', cut: 'none' });
  });

  it('ends at a `-- ` line right after a tag, and keeps no piece of that tag', () => {
    expect(mailChatHtmlOwnText('<div>Book it.</div><div>-- <br>Ann<br>+1 555 0100</div>'))
      .toEqual({ text: 'Book it.', cut: 'signature' });
  });

  it(`reads the first ${MAIL_CHAT_HTML_MAX / 1024} KB alone`, () => {
    const html = `<p>${'word '.repeat(Math.ceil(MAIL_CHAT_HTML_MAX / 5))}</p><div class="gmail_quote">quoted</div><p>tail</p>`;
    const own = mailChatHtmlOwnText(html);
    expect(own.text.length).toBeLessThanOrEqual(MAIL_CHAT_HTML_MAX);
    expect(own.text).not.toContain('tail');
    expect(own.text).not.toContain('quoted');
  });
});

describe('§8.12 — a quote container is removed; a divider or a signature ends the owner’s part', () => {
  it('keeps a reply written below the quote — Gmail, Apple Mail, Thunderbird', () => {
    expect(mailChatHtmlOwnText('<div class="gmail_quote"><div class="gmail_attr">On Tue, Oct 14, 2026 at 9:00 AM Recued '
      + '&lt;recued@chat.example&gt; wrote:<br></div><blockquote class="gmail_quote">Shall I book it?</blockquote></div>'
      + '<div dir="ltr">Yes, book it.</div>')).toEqual({ text: 'Yes, book it.', cut: 'quote' });
    expect(mailChatHtmlOwnText('<div><br><blockquote type="cite">On Oct 14, 2026, at 09:00, Recued wrote:<br><br>'
      + '</blockquote></div><blockquote type="cite"><div dir="ltr">Shall I book it?</div></blockquote><div>Yes please.</div>'))
      .toEqual({ text: 'Yes please.', cut: 'quote' });
    expect(mailChatHtmlOwnText('<div class="moz-cite-prefix">On 14/10/2026 09:00, Recued wrote:<br></div>'
      + '<blockquote type="cite">Shall I book it?</blockquote><p>Fine by me.</p><div class="moz-signature">-- <br>Ann</div>'))
      .toEqual({ text: 'Fine by me.', cut: 'quote' });
  });

  it('keeps the owner’s answers between the parts of the quote', () => {
    expect(mailChatHtmlOwnText('<div class="gmail_attr">On Tue, Recued wrote:</div>'
      + '<blockquote class="gmail_quote">Which day?</blockquote><div>Thursday.</div>'
      + '<blockquote class="gmail_quote">What time?</blockquote><div>Noon.</div>'))
      .toEqual({ text: 'On Tue, Recued wrote:\n\nThursday.\n\nNoon.', cut: 'quote' });
    // The line rules, run on the HTML's text as the door runs them, drop the attribution line.
    expect(mailChatOwnLines(mailChatHtmlOwnText('<div class="gmail_attr">On Tue, Oct 14, 2026, Recued wrote:</div>'
      + '<blockquote class="gmail_quote">Which day?</blockquote><div>Thursday.</div>').text, { continuing: true }).text)
      .toBe('Thursday.');
  });

  it('removes a nested quote with its parent, and a quote never closed to the end', () => {
    expect(mailChatHtmlOwnText('<blockquote>Booked.<blockquote>Shall I book it?</blockquote>Done.</blockquote><div>Thanks.</div>'))
      .toEqual({ text: 'Thanks.', cut: 'quote' });
    expect(mailChatHtmlOwnText('<div class="gmail_quote"><div><div>On Tue wrote:</div></div><blockquote>Booked.</blockquote>'
      + '</div><div>Thanks.</div>')).toEqual({ text: 'Thanks.', cut: 'quote' });
    expect(mailChatHtmlOwnText('<div>Thanks.</div><blockquote>Booked.<div>Done.</div>')).toEqual({ text: 'Thanks.', cut: 'quote' });
  });

  it('⛔ an Outlook divider still ends it: the original after it is no reply, even with words after its container', () => {
    expect(mailChatHtmlOwnText('<p class="MsoNormal">Yes, go ahead.</p><div style="border:none;border-top:solid #E1E1E1 1.0pt">'
      + '<p class="MsoNormal"><b>From:</b> Client<br><b>Sent:</b> Tuesday</p></div><p class="MsoNormal">Can you send it?</p>'
      + '<blockquote>older</blockquote><p class="MsoNormal">My cell is +1 555 0199.</p>'))
      .toEqual({ text: 'Yes, go ahead.', cut: 'quote' });
  });

  it('⛔ a signature still ends it: what follows a signature in no container is not the owner’s', () => {
    expect(mailChatHtmlOwnText('<div>Book it.</div><div class="gmail_signature">Ann</div><blockquote>Shall I?</blockquote>'
      + '<div>Client: my cell is +1 555 0199.</div>')).toEqual({ text: 'Book it.', cut: 'quote' });
  });

  it('⛔ a forward ends at its first container — the mail it forwards may quote, and what follows is still that mail', () => {
    const html = '<div>FYI</div><blockquote type="cite">Invoice 1042 is due.</blockquote><div>Our bank: IBAN DE00 1234.</div>';
    expect(mailChatHtmlOwnText(html, { forwarded: true })).toEqual({ text: 'FYI', cut: 'quote' });
    // As a reply, the same HTML is an answer written below a quote.
    expect(mailChatHtmlOwnText(html).text).toBe('FYI\n\nOur bank: IBAN DE00 1234.');
    // Gmail's forward is one container.
    expect(mailChatHtmlOwnText('<div dir="ltr">What do you make of this?</div><br><div class="gmail_quote">'
      + '<div dir="ltr" class="gmail_attr">---------- Forwarded message ---------<br>From: Supplier</div><br><br>'
      + '<div>Invoice 1042.<blockquote>older</blockquote>Our bank: IBAN DE00 1234.</div></div>', { forwarded: true }))
      .toEqual({ text: 'What do you make of this?', cut: 'quote' });
  });
});

describe('§8.12 — an attached email sent inline, which the mail parser writes into the text', () => {
  const inner = [
    'From: Supplier <billing@supplier.example>', 'To: Owner <owner@owner.example>', 'Subject: Invoice 1042',
    'Date: Tue, 14 Oct 2026 09:00:00 +0000', 'Message-ID: <inner@supplier.example>', 'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="in"', '', '--in', 'Content-Type: text/plain; charset=utf-8', '',
    'Our bank: IBAN DE00 1234.', '--in', 'Content-Type: text/html; charset=utf-8', '', '<p>Our bank: IBAN DE00 1234.</p>',
    '--in--', '',
  ];
  const email = (disposition: string | null) => Buffer.from([
    'From: Owner <owner@owner.example>', 'To: Chat <chat@chat.example>', 'Subject: ask: can you handle this?',
    'Date: Tue, 14 Oct 2026 10:00:00 +0000', 'Message-ID: <outer@owner.example>', 'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="out"', '', '--out', 'Content-Type: multipart/alternative; boundary="alt"', '',
    '--alt', 'Content-Type: text/plain; charset=utf-8', '', 'Can you handle this?', '--alt',
    'Content-Type: text/html; charset=utf-8', '', '<p>Can you handle this?</p>', '--alt--', '--out',
    'Content-Type: message/rfc822', ...(disposition === null ? [] : [`Content-Disposition: ${disposition}`]), '',
    ...inner, '--out--', '',
  ].join('\r\n'));
  const parse = (source: Buffer) =>
    canonicalizeImap(source, { uid: 1, folder: 'INBOX', flags: new Set(), internalDate: new Date('2026-10-14T10:00:01Z') });

  it('⛔ sent inline, its words are in the email’s own text — and end the owner’s part as mail', async () => {
    const msg = await parse(email('inline'));
    // The parser lists no attachment, and writes the email after a head of its own.
    expect(msg.attachments ?? []).toEqual([]);
    expect(msg.body_html).toContain('mp_head');
    expect(msg.body_html).toContain('DE00 1234');
    expect(mailChatHtmlOwnText(msg.body_html!)).toEqual({ text: 'Can you handle this?', cut: 'mail' });
    // Its text writes a header block, which the line rules end at.
    expect(mailChatOwnLines(msg.body_text, { continuing: false })).toEqual({ text: 'Can you handle this?', mail_cut: true });
  });

  it('sent as a file, it is an attachment, and the text is the owner’s alone', async () => {
    for (const [disposition, filename, isEmail] of [
      ['attachment; filename="Invoice 1042.eml"', 'Invoice 1042.eml', true],
      // ⚠ Unnamed, the sync's sniffing calls it plain text (any text-looking
      // file is), so nothing says it is an email: a forward of it is read as
      // one whose mail was not found (§8.12) — as mail, the safe side.
      [null, 'attachment-1', false],
    ] as const) {
      const msg = await parse(email(disposition));
      expect(msg.attachments?.map((part) => [part.filename, part.mime_type])).toEqual([[filename, 'text/plain']]);
      expect(msg.attachments!.map(isAttachedEmail)).toEqual([isEmail]);
      expect(mailChatHtmlOwnText(msg.body_html!)).toEqual({ text: 'Can you handle this?', cut: 'none' });
    }
  });
});

describe('⛔ linear time on a stranger’s HTML', () => {
  // Read as the email lands, before the proof: whoever writes to the chat
  // mailbox chooses it. The first cut of these patterns took 37 s on 320 KB.
  const N = 2 * 1024 * 1024;
  const fill = (unit: string): string => unit.repeat(Math.ceil(N / unit.length)).slice(0, N);
  const inlineImage: MailUpsertAttachment = {
    file_id: 'f', filename: 'a.png', mime_type: 'image/png', disposition: 'inline', content_id: 'zz@x', media_class: 'image',
  };

  it.each([
    ['open tags', fill('<div ')],
    ['id= runs inside one tag', fill(`<a ${'id='.repeat(660)}>`)],
    ['class= runs, never closed', fill(`<p ${'class='.repeat(330)}`)],
    ['a long class value', fill(`<p class="${'x'.repeat(199)}"`)],
    ['div attributes', fill(`<div ${'class=x '.repeat(250)}`)],
    ['an Outlook border run', fill(`<div ${'border-top: solid '.repeat(100)}`)],
    ['comments never closed', fill('<!-- ')],
    ['styles never closed', fill('<style ')],
    ['cid: runs', fill(`cid:${'x'.repeat(300)}`)],
    ['data: runs', fill(`data:${'x'.repeat(99)}`)],
    ['data: URIs', fill(`data:image/png;base64,${'A'.repeat(100)} `)],
    ['signature lines', fill('\n -- ')],
    ['entities', fill('&#x1234')],
    // §8.12 — containers: each removed one is searched past, never again from the start.
    ['empty quotes, a divider at the end', `${fill('<blockquote></blockquote>')}<hr>`],
    ['quotes never closed', fill('<blockquote>')],
    ['Gmail quotes of nested divs', fill('<div class="gmail_quote"><div></div></div>')],
    ['Gmail quotes never closed', fill('<div class="gmail_quote"><div>')],
    ['quotes and signature-like tags', fill(`<blockquote>x</blockquote><p ${'class='.repeat(50)}`)],
    ['closings alone', fill('</blockquote></div>')],
    ['parser heads never closed', fill('<table class="mp_head">')],
  ])('%s', (_shape, html) => {
    const started = performance.now();
    mailChatHtmlOwnText(html);
    mailChatHtmlOwnText(html, { forwarded: true });
    mailChatTurnFiles(html, [inlineImage]);
    // Measured at most ~60 ms each at 2 MB; the first cut's patterns took seconds on a tenth of it.
    expect(performance.now() - started).toBeLessThan(1_500);
  });
});
