import { TASK_TITLE_MAX, type MailMessageSnapshot } from '@recued/contracts';
import { serializeSourceRecordAddress } from '../shell/route.js';
import { READER_PASSAGE_MAX } from './reader-passage.js';

const boundedText = (value: string, limit: number): string => {
  let result = '';
  for (const character of value) {
    if (result.length + character.length > limit) break;
    result += character;
  }
  return result;
};

/** A bounded quotation and an exact mailbox-qualified link, never a provider
 * thread id or an inferred contact/project relationship. */
export const mailTaskValues = (message: MailMessageSnapshot, clientUrl: string, selected?: string): Record<string, unknown> => {
  if (selected !== undefined && (!selected.trim() || selected.length > READER_PASSAGE_MAX)) throw new Error('Select a shorter passage before creating a task.');
  const url = new URL(clientUrl);
  url.search = ''; url.username = ''; url.password = '';
  url.hash = serializeSourceRecordAddress({ tab: 'mail', collectionSlug: message.slug, recordId: message.record_id });
  const body = message.body?.trim() ?? '';
  const excerpt = boundedText(body, 600);
  const partial = message.body_truncated || excerpt.length < body.length;
  return {
    title: boundedText(selected?.trim().split(/\r?\n/u)[0] || message.subject.trim() || 'Follow up on email', TASK_TITLE_MAX),
    body: [`From: ${message.from}`, `Email: ${url.href}`, '',
      ...(selected !== undefined ? [message.body_truncated ? 'Selected passage (from a partial email):' : 'Selected passage:', selected]
        : body ? [partial ? 'Email excerpt (partial):' : 'Email excerpt:', excerpt] : ['The email text was unavailable. Open the email for context.'])].join('\n'),
    done: false,
    due_at: null,
  };
};
