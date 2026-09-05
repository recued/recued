/** Governed compose-body rewrite dispatch.
 *
 * The host sends the current body plus known mailbox addresses to one hidden,
 * read-only recipe. That recipe aliases the addresses, gives only the aliased
 * body to `core.ai.rewrite`, restores the result, and returns text for review.
 * Subject, sender choice, attachments, and reply linkage never enter the AI
 * input and therefore cannot be changed by this action. */

import type { MailComposeRewriteAction, MailComposeValues } from './types.js';

export const REWRITE_COMPOSED_MAIL_RECIPE_ID = 'rewrite-composed-mail';

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
