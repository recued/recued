/** Owner-started drafting and body rewrites in the shared composer. */

import {
  MAIL_COMPOSE_REWRITE_ACTIONS,
  MAIL_DRAFT_BRIEF_MAX,
  type MailComposeAiAction,
  type MailComposeRewriteAction,
} from '@recued/contracts';
import { e } from '../template.js';

export interface AiAssistSidebarProps {
  /** Sending and rewriting are mutually exclusive draft mutations. */
  submitting: boolean;
  /** The one transformation awaiting its governed execute response. */
  busyAction?: MailComposeAiAction | null;
  brief?: string;
  mode?: 'create' | 'reply';
  draftUnavailableReason?: string | null;
  /** Owner-facing failure/local conflict copy. */
  error?: string | null;
  /** Whether the host still holds a safely-applicable one-step undo. */
  canUndo?: boolean;
}

const AI_ACTION_LABELS: Readonly<Record<MailComposeRewriteAction, string>> = {
  'rewrite-formal': 'Make formal',
  'rewrite-friendly': 'Make friendly',
  polish: 'Polish',
};

const busyLabel = (action: MailComposeRewriteAction): string =>
  action === 'polish' ? 'Polishing…' : 'Rewriting…';

export const renderAiAssistSidebar = (props: AiAssistSidebarProps): string => {
  const busyAction = props.busyAction ?? null;
  const disabled = props.submitting === true || busyAction !== null;
  const disabledAttr = disabled ? ' disabled aria-disabled="true"' : '';
  const buttons = MAIL_COMPOSE_REWRITE_ACTIONS.map((action) => {
    const active = busyAction === action;
    const ariaBusy = active ? ' aria-busy="true"' : '';
    return `
      <button
        type="button"
        class="mail-compose-ai-action"
        data-action="mail-compose-ai-${e(action)}"${disabledAttr}${ariaBusy}
      >${e(active ? busyLabel(action) : AI_ACTION_LABELS[action])}</button>
    `;
  }).join('');
  const error = props.error
    ? `<p class="mail-compose-ai-error" role="alert">${e(props.error)}</p>`
    : '';
  const undo = props.canUndo === true
    ? `<button type="button" class="mail-compose-ai-undo" data-action="mail-compose-ai-undo"${disabledAttr}>Undo last AI change</button>`
    : '';
  return `
    <aside class="mail-compose-ai-assist" aria-label="AI assist">
      <h3 class="mail-compose-ai-title">AI assist</h3>
      <p class="mail-compose-ai-help">
        ${props.mode === 'reply' ? 'Draft a reply using the original email and your instructions.' : 'Describe the email you want to write.'} Review and edit the draft before sending.
      </p>
      <label class="mail-compose-ai-brief-label">${props.mode === 'reply' ? 'What should your reply say?' : 'What should this email say?'}
        <textarea data-mail-compose-ai-brief rows="4" maxlength="${MAIL_DRAFT_BRIEF_MAX}"${disabledAttr}>${e(props.brief ?? '')}</textarea>
      </label>
      <button type="button" class="mail-compose-ai-action" data-action="mail-compose-ai-draft"${disabled || props.draftUnavailableReason ? ' disabled aria-disabled="true"' : ''}${busyAction === 'compose' || busyAction === 'draft-reply' ? ' aria-busy="true"' : ''}>${busyAction === 'compose' || busyAction === 'draft-reply' ? 'Drafting…' : 'Draft with AI'}</button>
      ${props.draftUnavailableReason ? `<p class="mail-compose-ai-help" role="status">${e(props.draftUnavailableReason)}</p>` : ''}
      <p class="mail-compose-ai-help">Refine the current message:</p>
      <div class="mail-compose-ai-actions">
        ${buttons}
      </div>
      ${error}
      ${undo}
    </aside>
  `;
};
