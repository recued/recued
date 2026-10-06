import { MAIL_WORK_PLANNING_CHOICE, MAIL_WORK_PROPOSAL_REMINDER } from './mail-work-turn-contract.js';

/** Presentation for a completed prepared investigation, never ordinary Chat
 * or a failed/pending turn. The owner chose this proposal breakpoint already.
 * Preserve model text; only recognize exact copies of our own ending. */
export const finishMailWorkProposal = (response: string): string => {
  const text = response.trimEnd();
  if (!text.trim()) return response;
  if (text.endsWith(MAIL_WORK_PLANNING_CHOICE)) {
    const before = text.slice(0, -MAIL_WORK_PLANNING_CHOICE.length).trimEnd();
    if (before.endsWith(MAIL_WORK_PROPOSAL_REMINDER)
      || before.endsWith('This is a proposal awaiting your choice.')) return text;
    return `${before}\n\n${MAIL_WORK_PROPOSAL_REMINDER} ${MAIL_WORK_PLANNING_CHOICE}`;
  }
  const reminder = text.endsWith(MAIL_WORK_PROPOSAL_REMINDER) ? '' : `${MAIL_WORK_PROPOSAL_REMINDER} `;
  return `${text}\n\n${reminder}${MAIL_WORK_PLANNING_CHOICE}`;
};
