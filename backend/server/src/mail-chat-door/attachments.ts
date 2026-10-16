/** D-318 step 4, part 3 — an email request's files (§4.4, ruling 6).
 *
 *  Attachments become the turn's files: the sync has already stored each as a
 *  received file (`mail_attachment`), and a chat turn takes files by id, as a
 *  Slack or Telegram turn's media.
 *
 *  ⛔ NOT THE SIGNATURE'S IMAGES. A signature's logo and social icons are inline
 *  images the HTML signature shows, and an Outlook reply carries the logos of
 *  every email it quotes. They are not what the owner sent. But a photo pasted
 *  into the text is an inline image too, so the line is drawn where the HTML
 *  shows each one: an inline image the owner's own part of the HTML names stays;
 *  one named only inside the signature or the quoted history goes.
 *
 *  The HTML shows an inline image one of two ways, and both are read: by its
 *  Content-ID (`cid:…`, as Graph returns it), or by its bytes — Gmail's and the
 *  IMAP sync's parser writes each into the HTML as a `data:` URI, matched to
 *  the stored file by its SHA-256.
 *
 *  ⚠ When an image cannot be placed — no HTML, or the HTML shows it nowhere —
 *  it stays: an extra logo costs less than a lost photo.
 *
 *  The owner's own part is `html-text.ts`'s, the one their words come from: a
 *  photo pasted below a quote, in a reply, is theirs.
 *
 *  ⛔ LINEAR TIME (the D-318 audit): the HTML is a stranger's until the proof
 *  says otherwise. The markers are `html-text.ts`'s, every pattern stays inside
 *  one tag and bounds what it repeats, only the first `MAIL_CHAT_HTML_MAX`
 *  characters are read, and an email with no inline image is not read at all.
 *
 *  Spec: D-318 §4.4, §8 step 4. */

import { createHash } from 'node:crypto';

import type { MailUpsertAttachment } from '../collections/mail/mail-collection.js';
import { mailChatHtmlOwnPart, mailChatHtmlReadable } from './html-text.js';

/** One file a turn carries, as the chat queue takes it. */
export interface MailChatTurnFile {
  readonly file_id: string;
  readonly media_class: string;
}

/** What the HTML shows: each Content-ID it names as `cid:…` (lower case), and
 *  the SHA-256 of each image it carries as a `data:` URI. */
const shown = (html: string): { ids: Set<string>; hashes: Set<string> } => {
  const ids = new Set<string>();
  for (const match of html.matchAll(/cid:([^"'\s)<>]{1,256})/gi)) {
    let id = match[1]!;
    try { id = decodeURIComponent(id); } catch { /* named as written */ }
    ids.add(id.toLowerCase());
  }
  const hashes = new Set<string>();
  for (const match of html.matchAll(/data:[^;,"'\s<>]{0,100};base64,([A-Za-z0-9+/=]+)/gi)) {
    hashes.add(createHash('sha256').update(Buffer.from(match[1]!, 'base64')).digest('hex'));
  }
  return { ids, hashes };
};

/** The files a request brings: every attachment, and each inline image the
 *  owner's own part of the email shows — read as its words are, a forward's
 *  (`forwarded`) ending where the mail it forwards begins. */
export const mailChatTurnFiles = (
  html: string | undefined,
  attachments: readonly MailUpsertAttachment[],
  options: { readonly forwarded?: boolean } = {},
): MailChatTurnFile[] => {
  // Without an inline image there is nothing to place: the HTML is not read.
  const read = html === undefined || !attachments.some((attachment) => attachment.disposition === 'inline')
    ? undefined
    : mailChatHtmlReadable(html);
  const everywhere = read === undefined ? undefined : shown(read);
  const own = read === undefined ? undefined : shown(mailChatHtmlOwnPart(read, options).html);
  const shows = (where: { ids: Set<string>; hashes: Set<string> }, attachment: MailUpsertAttachment): boolean =>
    (attachment.content_id !== undefined && where.ids.has(attachment.content_id.toLowerCase()))
    || (attachment.content_hash !== undefined && where.hashes.has(attachment.content_hash));
  return attachments
    .filter((attachment) => {
      if (attachment.disposition !== 'inline' || everywhere === undefined) return true;
      // Shown nowhere: there is no telling where it belongs, so it stays.
      if (!shows(everywhere, attachment)) return true;
      return shows(own!, attachment);
    })
    .map((attachment) => ({ file_id: attachment.file_id, media_class: attachment.media_class ?? 'other' }));
};

const ATTACHED_EMAIL_TYPES: ReadonlySet<string> = new Set(['message/rfc822', 'message/global', 'application/vnd.ms-outlook']);

/** An email sent as a file — forwarded as an attachment: `message/rfc822`
 *  (RFC 2046), the same internationalized (`message/global`, RFC 6532), or an
 *  Outlook `.msg`. The email it forwards is that file, not the text. One sent
 *  inline is no attachment at all: the mail parser writes it into the text
 *  (`MAIL_CHAT_EMBEDDED_START`). */
export const isAttachedEmail = (part: {
  readonly filename: string;
  readonly mime_type: string;
  readonly disposition?: 'attachment' | 'inline';
}): boolean =>
  part.disposition !== 'inline'
  && (ATTACHED_EMAIL_TYPES.has(part.mime_type.trim().toLowerCase()) || /\.(?:eml|msg)$/i.test(part.filename.trim()));
