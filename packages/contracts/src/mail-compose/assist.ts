/** Governed compose-body rewrite dispatch.
 *
 * The host sends the current body plus known mailbox addresses to one hidden,
 * read-only recipe. That recipe aliases the addresses, gives only the aliased
 * body to `core.ai.rewrite`, restores the result, and returns text for review.
 * Subject, sender choice, attachments, and reply linkage never enter the AI
 * input and therefore cannot be changed by this action. */

import type { MailComposeRewriteAction, MailComposeValues, MailReplyContext } from './types.js';

export const REWRITE_COMPOSED_MAIL_RECIPE_ID = 'rewrite-composed-mail';
export const DRAFT_COMPOSED_MAIL_RECIPE_ID = 'draft-composed-mail';
export const MAIL_DRAFT_BRIEF_MAX = 8_000;
export const MAIL_DRAFT_SOURCE_MAX = 65_536;

/** Only text and privacy seeds enter the model; routing stays with the host. */
export const composeDraftRecipeConfig = (input: ComposeRewriteRecipeInput & {
  brief: string;
  reply?: MailReplyContext | null;
}): Record<string, unknown> => ({
  brief: input.brief.trim(),
  body: input.values.body,
  sender_email: input.sender_email,
  to: [...input.values.to], cc: [...input.values.cc], bcc: [...input.values.bcc],
  original_from: input.reply?.original_message.from ?? '',
  original_to: [...(input.reply?.original_message.to ?? [])],
  original_cc: [...(input.reply?.original_message.cc ?? [])],
  original_subject: input.reply?.original_message.subject ?? '',
  original_body: input.reply?.original_message.body ?? '',
});

export interface ComposeRewriteRecipeInput {
  values: Pick<MailComposeValues, 'body' | 'to' | 'cc' | 'bcc'>;
  sender_email: string;
}

const ACTION_COPY: Readonly<Record<MailComposeRewriteAction, {
  style: string;
  instruction: string;
}>> = {
  'rewrite-formal': {
    style: 'formal, direct, and professional',
    instruction: 'Use a professional tone without making the message colder or adding commitments.',
  },
  'rewrite-friendly': {
    style: 'friendly, warm, and natural',
    instruction: 'Use a warm natural tone without becoming overly familiar or adding commitments.',
  },
  polish: {
    style: 'clear, concise, and polished',
    instruction: 'Improve clarity, grammar, and flow while retaining the writer’s voice and level of detail.',
  },
};

const COMMON_INSTRUCTION =
  'Return only the rewritten email body. Preserve meaning, factual claims, links, and formatting intent. '
  + 'Do not invent names, dates, promises, prices, attachments, or a subject line.';

export const composeRewriteRecipeConfig = (
  input: ComposeRewriteRecipeInput,
  action: MailComposeRewriteAction,
): Record<string, unknown> => ({
  body: input.values.body,
  sender_email: input.sender_email,
  to: [...input.values.to],
  cc: [...input.values.cc],
  bcc: [...input.values.bcc],
  style: ACTION_COPY[action].style,
  instructions: `${COMMON_INSTRUCTION} ${ACTION_COPY[action].instruction}`,
});
