import type { MailWorkDetail, MailWorkReadRequest } from '@recued/contracts';
import { mailWorkOwnerNotesRecordedAtIso } from '@recued/contracts';
import { serializeShellRoute } from '../shell/route.js';

export const MAIL_WORK_INTENTS = {
  orient: 'Work out what would help',
  plan: 'Make a plan',
  catch_up: 'Catch up on progress',
  wrap_up: 'Wrap up or report',
  revisit: 'Revisit the work',
} as const;
export type MailWorkIntent = keyof typeof MAIL_WORK_INTENTS;
/** `replace` opens Chat in place of the current history entry. */
export interface MailWorkChatHandoff { sessionId: string; prompt?: string; repeat?: boolean; replace?: boolean; mailWork?: MailWorkReadRequest }

/** Task and output instructions live in the server system prompt. Keeping them
 * out of the owner message prevents later investigation/refinement from treating
 * generated instructions as owner facts or answering a historical task.
 *
 * Source references enter the normal Chat tool/privacy path. Never preload
 * raw mail here, or promote the saved interpretation into a source of facts.
 * ⛔ That includes a subject, an IMAP thread id and the snapshot warnings that
 * quote subjects: this text is sent as the owner's own words, which the
 * privacy layer does not alias, and which the model reads as an instruction. */
export const mailWorkChatPrompt = (
  { work }: MailWorkDetail,
  intent: MailWorkIntent = 'orient',
): string => [
  'Follow this work with me.',
  `My purpose: ${MAIL_WORK_INTENTS[intent]}.`,
  `Work page: ${serializeShellRoute('mail', 'work', work.id)}`,
  'Work context for this investigation:',
  JSON.stringify({ work_id: work.id,
    // A title still equal to a linked subject is that subject (the default), not the owner's.
    ...(work.threads.some(({ subject }) => subject.slice(0, 200) === work.title) ? {} : { title: work.title }),
    workbook_status: work.status, revision: work.revision,
    desired_outcome: work.goal, owner_notes: work.owner_notes,
    owner_notes_recorded_at_iso: mailWorkOwnerNotesRecordedAtIso(work),
    conversations: work.threads.map(({ slug, seed_record_id }) => ({ slug, seed_record_id })),
    resolution_note: work.resolution_note }, null, 2),
].filter(Boolean).join('\n\n');

/** Presentation only. The exact owner request stays in storage, exports,
 * replies and the model/privacy path; its supplied context is just folded in
 * Chat. An ordinary message, malformed request or mismatched work link must
 * still render in full. Never infer permission from this projection. */
export const readMailWorkChatPrompt = (text: string): { purpose: string; href: string } | null => {
  const match = /^Follow this work with me\.\n\nMy purpose: ([^\n]+)\.\n\nWork page: ([^\n]+)\n\nWork context for this investigation:\n\n([\s\S]+)$/u.exec(text);
  if (!match) return null;
  const [, purpose, href, raw] = match;
  if (!purpose || !href || !raw || !Object.values(MAIL_WORK_INTENTS).some(label => label === purpose)) return null;
  try {
    const context: unknown = JSON.parse(raw);
    if (context === null || typeof context !== 'object' || Array.isArray(context)
      || !('work_id' in context) || typeof context.work_id !== 'string' || context.work_id.length === 0
      || serializeShellRoute('mail', 'work', context.work_id) !== href) return null;
    return { purpose, href };
  } catch {
    return null;
  }
};
