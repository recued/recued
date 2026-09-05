/** Mail-compose body rewrite controls.
 *
 * Only transformations of an existing body render here. “Compose” and “Draft
 * reply” remain in the broader contract vocabulary, but exposing either before
 * grounding and source-context semantics exist would invite invented mail. */

import {
  MAIL_COMPOSE_REWRITE_ACTIONS,
  type MailComposeRewriteAction,
} from '@recued/contracts';
import { e } from '../template.js';

export interface AiAssistSidebarProps {
  /** Sending and rewriting are mutually exclusive draft mutations. */
  submitting: boolean;
  /** The one transformation awaiting its governed execute response. */
  busyAction?: MailComposeRewriteAction | null;
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
    ? `<button type="button" class="mail-compose-ai-undo" data-action="mail-compose-ai-undo"${disabledAttr}>Undo last rewrite</button>`
    : '';
  return `
    <aside class="mail-compose-ai-assist" aria-label="AI assist">
      <h3 class="mail-compose-ai-title">AI assist</h3>
      <p class="mail-compose-ai-help">
        Rewrite the current message body. You review every change before sending.
      </p>
      <div class="mail-compose-ai-actions">
        ${buttons}
      </div>
      ${error}
      ${undo}
    </aside>
  `;
};
