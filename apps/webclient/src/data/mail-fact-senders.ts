/**
 * D-315 §6.5 — Data → Received → Mail facts → Senders without a template.
 *
 * The senders the owner gets the most mail from that no template and no
 * standard reads, over the last 30 days: how many emails, their most common
 * subjects, and "Make a template", which opens the editor on the newest one.
 * A dismissed sender stays dismissed until shown again. Counted by the server
 * from the stored mail, with no AI.
 */

import type { MailFactEmailRef, MailFactSenderDismissal, MailFactSendersResult } from '@recued/contracts';
import { e } from '@recued/ui-shared';

import { humanizeRpcError } from '../shell/rpc-error-copy.js';

const FOCUS = 'data-recued-mail-facts-focus';
export const MAIL_FACTS_SENDER_ROW_ATTR = 'data-recued-mail-fact-sender';

export interface MailFactSenderCallers {
  readonly listSenders?: (args?: { limit?: number }) => Promise<MailFactSendersResult>;
  readonly dismissSender?: (args: MailFactSenderDismissal) => Promise<MailFactSenderDismissal>;
}

export interface MailFactSendersDeps {
  readonly callers: MailFactSenderCallers;
  readonly actionAttr: string;
  readonly render: () => void;
  readonly focus: (key: string) => void;
  /** "Make a template": the editor, on the sender's newest email. */
  readonly makeTemplate: (email: MailFactEmailRef) => void;
  /** Whether the Templates editor can be opened on an email. */
  readonly canMakeTemplate: boolean;
}

export interface MailFactSenders {
  render(): string;
  refresh(silent?: boolean): Promise<void>;
  handleAction(action: string, target: HTMLElement): boolean;
  isBusy(): boolean;
  /** A dismissal, or a sender shown again, is under way. */
  hasInFlightWork(): boolean;
  dispose(): void;
}

export const createMailFactSenders = (deps: MailFactSendersDeps): MailFactSenders => {
  const { callers, actionAttr } = deps;
  let result: MailFactSendersResult | null = null;
  let loading = false;
  let error: string | null = null;
  let busy: string | null = null;
  let seq = 0;
  let disposed = false;
  /** "Dismissed", open or shut across repaints. */
  let dismissedOpen = false;

  /** A control of a sender's row, by what the owner can do there. */
  const rowFocus = (address: string): string =>
    deps.canMakeTemplate ? `snd:make:${address}` : `snd:dismiss:${address}`;

  const load = async (silent: boolean): Promise<void> => {
    if (callers.listSenders === undefined) return;
    const mine = ++seq;
    loading = true;
    if (!silent) {
      error = null;
      deps.render();
    }
    try {
      const next = await callers.listSenders();
      if (disposed || mine !== seq) return;
      result = next;
      error = null;
    } catch (failure) {
      if (disposed || mine !== seq) return;
      error = humanizeRpcError(failure);
    }
    loading = false;
    deps.render();
  };

  const setDismissed = async (address: string, dismissed: boolean): Promise<void> => {
    if (callers.dismissSender === undefined || busy !== null) return;
    busy = address;
    // Where it stood in the list: after a dismissal, the sender that takes
    // its place has the focus.
    const at = result?.senders.findIndex((sender) => sender.address === address) ?? -1;
    deps.render();
    try {
      await callers.dismissSender({ address, dismissed });
      if (disposed) return;
      busy = null;
      await load(true);
      if (disposed) return;
      const senders = result?.senders ?? [];
      const shown = senders.find((sender) => sender.address === address);
      const next = senders[Math.max(0, Math.min(at, senders.length - 1))];
      // Something that exists after the repaint: the sender shown again, the
      // one after the one dismissed, or the list of those dismissed.
      deps.focus(!dismissed && shown !== undefined
        ? rowFocus(address)
        : dismissed && next !== undefined
          ? rowFocus(next.address)
          : (result?.dismissed.length ?? 0) > 0 ? 'snd:dismissed' : 'view:senders');
      deps.render();
    } catch (failure) {
      if (disposed) return;
      busy = null;
      error = humanizeRpcError(failure);
      deps.render();
    }
  };

  const renderList = (value: MailFactSendersResult): string => {
    if (value.senders.length === 0) {
      return `<p class="mail-facts-empty">No sender without a template in the last ${value.days} days${value.scanned > 0 ? ` (${value.scanned} emails counted)` : ''}.</p>`;
    }
    return `
      <ul class="mail-facts-template-list" role="list">
        ${value.senders.map((sender) => `
          <li class="mail-facts-template" ${MAIL_FACTS_SENDER_ROW_ATTR}="${e(sender.address)}">
            <div class="mail-facts-template-head">
              <span class="mail-facts-template-name">${e(sender.address)}</span>
              <span class="mail-facts-subtle">${sender.count} ${sender.count === 1 ? 'email' : 'emails'}</span>
            </div>
            <ul class="mail-facts-subjects" role="list" aria-label="Its most common subjects">
              ${sender.subjects.map((subject) => `<li>${e(subject.subject.length > 0 ? subject.subject : '(no subject)')}${subject.count > 1 ? ` <span class="mail-facts-subtle">× ${subject.count}</span>` : ''}</li>`).join('')}
            </ul>
            <div class="mail-facts-template-actions">
              ${deps.canMakeTemplate
                ? `<button type="button" class="data-button" ${actionAttr}="mail-facts-snd-make"
                    data-slug="${e(sender.newest.slug)}" data-record-id="${e(sender.newest.record_id)}"
                    ${FOCUS}="snd:make:${e(sender.address)}">Make a template</button>`
                : ''}
              ${callers.dismissSender !== undefined
                ? `<button type="button" class="data-button" ${actionAttr}="mail-facts-snd-dismiss" data-address="${e(sender.address)}"
                    ${FOCUS}="snd:dismiss:${e(sender.address)}"${busy === sender.address ? ' aria-disabled="true" aria-busy="true"' : ''}>Dismiss</button>`
                : ''}
            </div>
          </li>`).join('')}
      </ul>`;
  };

  const renderDismissed = (value: MailFactSendersResult): string => {
    if (value.dismissed.length === 0 || callers.dismissSender === undefined) return '';
    return `
      <details class="mail-facts-advanced"${dismissedOpen ? ' open' : ''}>
        <summary ${actionAttr}="mail-facts-snd-dismissed-toggle" ${FOCUS}="snd:dismissed">Dismissed (${value.dismissed.length})</summary>
        <ul class="mail-facts-rules" role="list">
          ${value.dismissed.map((address) => `
            <li><span>${e(address)}</span>
              <button type="button" class="data-button" ${actionAttr}="mail-facts-snd-restore" data-address="${e(address)}"
                ${FOCUS}="snd:restore:${e(address)}"${busy === address ? ' aria-disabled="true" aria-busy="true"' : ''}>Show again</button></li>`).join('')}
        </ul>
      </details>`;
  };

  return {
    render: () => {
      if (callers.listSenders === undefined) return '<p class="mail-facts-subtle">This server cannot count senders.</p>';
      return `
        <p class="mail-facts-intro">The senders you get the most mail from that no template and no standard reads, over the last 30 days. A template for one turns its mail into facts.</p>
        ${error !== null ? `<p class="mail-facts-error" role="alert">${e(error)}</p>` : ''}
        ${result === null
          ? `<p class="mail-facts-subtle" aria-live="polite">${loading ? 'Counting your mail…' : 'Loading…'}</p>`
          : `${renderList(result)}${renderDismissed(result)}`}`;
    },

    refresh: (silent = false) => load(silent),

    handleAction: (action, target) => {
      const address = target.getAttribute('data-address') ?? '';
      switch (action) {
        case 'mail-facts-snd-make': {
          const slug = target.getAttribute('data-slug');
          const record_id = target.getAttribute('data-record-id');
          if (slug !== null && record_id !== null) deps.makeTemplate({ slug, record_id });
          return true;
        }
        case 'mail-facts-snd-dismiss':
          void setDismissed(address, true);
          return true;
        case 'mail-facts-snd-restore':
          void setDismissed(address, false);
          return true;
        case 'mail-facts-snd-dismissed-toggle':
          // The browser opens or shuts it; a repaint here would undo that.
          dismissedOpen = !dismissedOpen;
          return true;
        default:
          return false;
      }
    },

    isBusy: () => loading || busy !== null,

    hasInFlightWork: () => busy !== null,

    dispose: () => {
      disposed = true;
    },
  };
};
