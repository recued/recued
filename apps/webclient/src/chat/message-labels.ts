/** D-338 — how the chat says what a row is, so the owner can tell what the model can see.
 *
 *  Three looks, and the quote rule belongs to the first only:
 *  - a NOTICE card: Recued sent it on a linked messenger without being asked. It is not part of
 *    the chat; quoting it in a reply is the one way to ask about it.
 *  - a reply labelled WITHOUT AI: Recued answered from the owner's own records (or with a fixed
 *    line) and no model ran. It is part of the chat.
 *  - an ordinary reply. */
import type { ChatAnswerSource, ChatMessage } from '@recued/contracts';

/** The line under every notice in the app. The messenger copy says the same in that
 *  messenger's own words (`chat-notices.ts` `noticeRuleLine`). */
export const NOTICE_RULE_TEXT = 'Not part of the chat. Reply to it to ask about it.';

/** A notice's heading: "Notice", then its own title. */
export const noticeHeading = (title: string | undefined): string => {
  const trimmed = title?.trim();
  return trimmed ? `Notice · ${trimmed}` : 'Notice';
};

const SOURCE_WORDS: Record<ChatAnswerSource, string> = {
  contacts: 'from your contacts',
  calendar: 'from your calendar',
  mail: 'from your mail',
};

/** "from your contacts, without AI" — or "without AI" for a fixed reply; undefined for a reply a
 *  model wrote (and for every reply from a server before D-338). */
export const withoutAiLabel = (answered: ChatMessage['answered_without_model']): string | undefined => {
  if (answered === undefined) return undefined;
  const from = answered.from !== undefined ? SOURCE_WORDS[answered.from] : undefined;
  return from !== undefined ? `${from}, without AI` : 'without AI';
};

/** What a quote block names: who wrote the quoted message, or which notice it was. */
export const quoteLabel = (
  preview: { role: 'user' | 'assistant' | 'notice'; title?: string },
  draft: boolean,
): string => {
  if (preview.role === 'notice') {
    const title = preview.title?.trim();
    return `${draft ? 'Replying to a notice' : 'Notice'}${title ? ` · ${title}` : ''}`;
  }
  return `${draft ? 'Replying to ' : ''}${preview.role === 'user' ? 'You' : 'Recued'}`;
};
