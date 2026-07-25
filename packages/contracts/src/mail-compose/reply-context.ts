/** D-145 PA7 — reply-context derivation.
 *
 *  Pure: given a `MailReplyContext`, return a `Partial<MailComposeValues>`
 *  shape with `in_reply_to` / `to` / `subject` / `sender_source`
 *  prepopulated. Other fields (cc / bcc / body / attachments) are left
 *  untouched — the user composes those.
 *
 *  Spec: docs/d-145-spec.md § A.5.4 (Reply-context handling). */

import type { MailComposeValues, MailReplyContext } from './types.js';

const RE_PREFIX = /^re:\s/i;

/** Add `Re: ` to a subject unless it already has a Re-style prefix
 *  (case-insensitive — `re: ` / `Re: ` / `RE: ` all count). RFC 5322
 *  doesn't pin a canonical reply-prefix; mainstream clients converge
 *  on `Re:` (single-instance, no count suffix). The substrate matches
 *  that convention.
 *
 *  Empty / whitespace-only subjects yield `Re: ` — the user edits
 *  before send. */
export const addReReplyPrefix = (subject: string): string => {
  if (RE_PREFIX.test(subject)) return subject;
  return `Re: ${subject}`;
};

/** Pure: derive the prepopulated values for a reply-mode compose. */
export const deriveReplyValues = (
  context: MailReplyContext,
): Pick<MailComposeValues, 'to' | 'subject' | 'in_reply_to' | 'sender_source'> => ({
  to: [context.original_message.from],
  subject: addReReplyPrefix(context.original_message.subject),
  in_reply_to: context.original_message.id,
  sender_source: context.original_source_id,
});
