/** D-145 PA7 — AI-assist sidebar (STUB).
 *
 *  Per spec § A.5.5 — AI-assist (compose / rewrite / polish) lands as
 *  a sidebar feature in the form renderer. PA7 ships the rendered
 *  controls + data-action wiring only. The host fires the actions as
 *  no-ops; engine integration via `ai.synthesize` lands in PB.
 *
 *  Each control carries `data-action="mail-compose-ai-<kind>"` —
 *  closed list per `MAIL_COMPOSE_AI_ACTIONS`. Hosts that haven't
 *  wired the engine yet should hide the sidebar via CSS rather than
 *  removing the markup, so the render contract stays stable across
 *  PA7 + PB.
 *
 *  Spec: D-145 § A.5.5 (AI-assist sidebar). */

import { MAIL_COMPOSE_AI_ACTIONS, type MailComposeAiAction } from '@recued/contracts';
import { e } from '../template.js';

export interface AiAssistSidebarProps {
  /** Mirror of `MailComposeDialogState.submitting` — the sidebar
   *  controls disable while the rpc is in flight, so the user can't
   *  request another transformation mid-send. */
  submitting: boolean;
}

const AI_ACTION_LABELS: Readonly<Record<MailComposeAiAction, string>> = {
  compose: 'Compose',
  'rewrite-formal': 'Rewrite (formal)',
  'rewrite-friendly': 'Rewrite (friendly)',
  polish: 'Polish',
  'draft-reply': 'Draft reply',
};

export const renderAiAssistSidebar = (props: AiAssistSidebarProps): string => {
  const disabled = props.submitting === true;
  const disabledAttr = disabled ? ' disabled aria-disabled="true"' : '';
  const buttons = MAIL_COMPOSE_AI_ACTIONS.map((action) => {
    const label = AI_ACTION_LABELS[action];
    return `
      <button
        type="button"
        class="mail-compose-ai-action"
        data-action="mail-compose-ai-${e(action)}"${disabledAttr}
      >${e(label)}</button>
    `;
  }).join('');
  return `
    <aside
      class="mail-compose-ai-assist"
      aria-label="AI assist"
      data-stub="pa7"
    >
      <h3 class="mail-compose-ai-title">AI assist</h3>
      <p class="mail-compose-ai-help">
        Coming soon.
      </p>
      <div class="mail-compose-ai-actions">
        ${buttons}
      </div>
    </aside>
  `;
};
