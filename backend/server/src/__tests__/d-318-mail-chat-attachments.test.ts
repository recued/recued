/** D-318 step 4, part 3 — an email request's files (§4.4): every attachment,
 *  and each inline image the owner's own text shows; never a signature's
 *  images, nor those of the quoted history. The HTML shapes are the ones mail
 *  apps write. */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { MailUpsertAttachment } from '../collections/mail/mail-collection.js';
import { isAttachedEmail, mailChatTurnFiles } from '../mail-chat-door/attachments.js';

const attached = (file_id: string, media_class = 'document'): MailUpsertAttachment =>
  ({ file_id, filename: `${file_id}.pdf`, mime_type: 'application/pdf', disposition: 'attachment', media_class });
const inline = (file_id: string, content_id: string): MailUpsertAttachment =>
  ({ file_id, filename: `${file_id}.png`, mime_type: 'image/png', disposition: 'inline', content_id, media_class: 'image' });
const ids = (files: readonly { file_id: string }[]) => files.map((file) => file.file_id);

describe('mailChatTurnFiles', () => {
  it('keeps every attachment, with its media class', () => {
    expect(mailChatTurnFiles('<div>see attached</div>', [attached('file:a'), attached('file:b', 'other')]))
      .toEqual([{ file_id: 'file:a', media_class: 'document' }, { file_id: 'file:b', media_class: 'other' }]);
  });

  it('keeps a photo the owner pasted, and leaves out a Gmail signature’s logo', () => {
    const html = '<div dir="ltr">What is this plant?<br><img src="cid:photo_1"><br></div>'
      + '<br clear="all"><div><br></div><span class="gmail_signature_prefix">-- </span><br>'
      + '<div dir="ltr" class="gmail_signature" data-smartmail="gmail_signature">Ann<br><img src="cid:logo_2"></div>';
    expect(ids(mailChatTurnFiles(html, [inline('file:photo', 'photo_1'), inline('file:logo', 'logo_2')])))
      .toEqual(['file:photo']);
  });

  it('leaves out the logos an Outlook reply carries from the emails it quotes', () => {
    const outlookWeb = '<div>Thanks, book it.</div><div id="Signature"><img src="cid:image001.png@01DA0000"></div>'
      + '<div id="appendonsend"></div><hr style="display:inline-block;width:98%"><div id="divRplyFwdMsg">'
      + '<b>From:</b> Recued</div><img src="cid:image002.png@01DA0000">';
    expect(ids(mailChatTurnFiles(outlookWeb, [
      inline('file:own-logo', 'image001.png@01DA0000'),
      inline('file:quoted-logo', 'image002.png@01DA0000'),
    ]))).toEqual([]);
    const outlookDesktop = '<p class="MsoNormal">Yes.</p><p class="MsoNormal"><a name="_MailAutoSig">Ann</a>'
      + '<img src="cid:image003.jpg@01DA0000"></p><div style="border:none;border-top:solid #E1E1E1 1.0pt">'
      + '<p><b>From:</b> Recued</p></div>';
    expect(ids(mailChatTurnFiles(outlookDesktop, [inline('file:sig', 'image003.jpg@01DA0000')]))).toEqual([]);
  });

  it('reads Apple Mail’s, Thunderbird’s and a plain `-- ` signature, and Gmail’s quote', () => {
    expect(ids(mailChatTurnFiles(
      '<div>Here.<img src="cid:a@x"></div><div id="AppleMailSignature"><img src="cid:b@x"></div>',
      [inline('file:a', 'a@x'), inline('file:b', 'b@x')],
    ))).toEqual(['file:a']);
    expect(ids(mailChatTurnFiles(
      '<p>Here.</p><div class="moz-signature">-- <br><img src="cid:c@x"></div>',
      [inline('file:c', 'c@x')],
    ))).toEqual([]);
    expect(ids(mailChatTurnFiles('<p>Here.</p>\n-- <br><img src="cid:d@x">', [inline('file:d', 'd@x')]))).toEqual([]);
    expect(ids(mailChatTurnFiles(
      '<div>ok</div><div class="gmail_quote"><blockquote><img src="cid:e@x"></blockquote></div>',
      [inline('file:e', 'e@x')],
    ))).toEqual([]);
  });

  it('keeps an inline image it cannot place: no HTML, no Content-ID, or one the HTML never names', () => {
    expect(ids(mailChatTurnFiles(undefined, [inline('file:a', 'a@x')]))).toEqual(['file:a']);
    expect(ids(mailChatTurnFiles('<div class="gmail_signature"></div>', [{ ...inline('file:b', 'b@x'), content_id: undefined }])))
      .toEqual(['file:b']);
    expect(ids(mailChatTurnFiles('<div>text</div><div class="gmail_signature"></div>', [inline('file:c', 'c@x')])))
      .toEqual(['file:c']);
  });

  it('places an image Gmail’s or IMAP’s parser wrote into the HTML as a data: URI, by its bytes', () => {
    const photo = Buffer.from('a photo of a plant');
    const logo = Buffer.from('the company logo');
    const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    const html = `<div>What is this?<img src="data:image/jpeg;base64,${photo.toString('base64')}"></div>`
      + `<div class="gmail_signature">Ann<img src="data:image/png;base64,${logo.toString('base64')}"></div>`;
    expect(ids(mailChatTurnFiles(html, [
      { ...inline('file:photo', 'photo@x'), content_hash: sha(photo) },
      { ...inline('file:logo', 'logo@x'), content_hash: sha(logo) },
      { ...inline('file:nameless', 'n@x'), content_id: undefined, content_hash: sha(Buffer.from('elsewhere')) },
    ]))).toEqual(['file:photo', 'file:nameless']);
  });

  it('matches a Content-ID case aside, and one the HTML escaped', () => {
    expect(ids(mailChatTurnFiles('<img src="cid:Photo%201@X">', [inline('file:p', 'photo 1@x')]))).toEqual(['file:p']);
  });

  it('§8.12 — a photo pasted below the quote is the owner’s; the quote’s logo is not', () => {
    const html = '<div class="gmail_quote">On Tue, Recued wrote:<blockquote>Which plant?<img src="cid:logo@x"></blockquote></div>'
      + '<div>This one.<img src="cid:photo@x"></div>';
    expect(ids(mailChatTurnFiles(html, [inline('file:photo', 'photo@x'), inline('file:logo', 'logo@x')]))).toEqual(['file:photo']);
  });

  it('§8.12 — in a forward, an image after its first quote is the forwarded mail’s', () => {
    const html = '<div>FYI<img src="cid:mine@x"></div><blockquote type="cite">Invoice.</blockquote><div><img src="cid:theirs@x"></div>';
    const files = [inline('file:mine', 'mine@x'), inline('file:theirs', 'theirs@x')];
    expect(ids(mailChatTurnFiles(html, files, { forwarded: true }))).toEqual(['file:mine']);
    expect(ids(mailChatTurnFiles(html, files))).toEqual(['file:mine', 'file:theirs']);
  });
});

describe('isAttachedEmail — an email forwarded as a file', () => {
  it('an `.eml` or `.msg` file, or a part an unsniffed provider calls an email; never one the parser wrote into the text', () => {
    const part = (filename: string, mime_type: string, disposition?: 'attachment' | 'inline') =>
      ({ filename, mime_type, ...(disposition !== undefined ? { disposition } : {}) });
    expect(isAttachedEmail(part('Invoice 1042.eml', 'text/plain', 'attachment'))).toBe(true);
    expect(isAttachedEmail(part('Invoice 1042.MSG', 'application/vnd.ms-outlook'))).toBe(true);
    expect(isAttachedEmail(part('attachment-2', 'message/rfc822', 'attachment'))).toBe(true);
    expect(isAttachedEmail(part('attachment-2', 'Message/Global'))).toBe(true);
    expect(isAttachedEmail(part('Invoice 1042.eml', 'text/plain', 'inline'))).toBe(false);
    expect(isAttachedEmail(part('notes.txt', 'text/plain', 'attachment'))).toBe(false);
    expect(isAttachedEmail(part('emlx.pdf', 'application/pdf'))).toBe(false);
  });
});
