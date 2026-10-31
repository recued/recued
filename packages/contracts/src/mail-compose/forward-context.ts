import type { MailComposeValues, MailForwardContext } from './types.js';
import { MAIL_DRAFT_SOURCE_MAX } from './assist.js';

/** Keep source headers on their own lines inside the plain-text quotation. */
const headerText = (value: string): string => value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();

/** A forward has new recipients and no reply linkage. Never quote a partial
 * original or inherit original recipient/attachment refs into the envelope. */
export const deriveForwardValues = (
  context: MailForwardContext,
): MailComposeValues | null => {
  const message = context.original_message;
  const received = new Date(message.received_at);
  if (message.body_truncated || typeof message.body !== 'string'
    || message.body.length > MAIL_DRAFT_SOURCE_MAX || !Number.isFinite(received.getTime())) return null;
  const subject = headerText(message.subject);
  const headers = [
    '---------- Forwarded message ----------',
    `From: ${headerText(message.from)}`,
    `Date: ${received.toUTCString()}`,
    `Subject: ${subject}`,
    `To: ${message.to.map(headerText).join(', ')}`,
    ...(message.cc.length ? [`Cc: ${message.cc.map(headerText).join(', ')}`] : []),
  ];
  return {
    to: [], cc: [], bcc: [],
    subject: /^fw(?:d)?:\s*/i.test(subject) ? subject : `Fwd: ${subject}`,
    body: `\n\n${headers.join('\n')}\n\n${message.body}`,
    attachments: [], in_reply_to: null, sender_source: context.original_source_id,
  };
};
