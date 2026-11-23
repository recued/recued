import type { SituationAgendaStatus, SituationCloseDaySettings, SituationCloseDayStatus } from '@recued/contracts';
import { e } from '@recued/ui-shared';
import { classifyRpcError } from '../shell/rpc-error-copy.js';
import { serializeChatSessionAddress } from '../shell/route.js';
import { deliveryCardStyles, nextDigestText } from './situation-delivery-panel.js';

export const CLOSE_DAY_PANEL_ATTR = 'data-situation-close-day';

/** D-343 slice 4 (§3.1, ruling 19) — Close the day, a card of its own under the Agenda's: the
 *  evening message that lists the day and asks what the owner did. It reads the Agenda's status
 *  (`yours.agenda`), which names it on a server that has it; on any other the card leaves the page.
 *  It moves with the Agenda when D-340 puts the daily stream on Today. */
export interface CloseDayPanelOptions {
  host: HTMLElement; document?: Document;
  read: () => Promise<SituationAgendaStatus>;
  save: (settings: SituationCloseDaySettings) => Promise<unknown>;
  sendNow: () => Promise<unknown>;
  retryReply?: (id: string) => Promise<unknown>;
  reviewReply?: (id: string) => Promise<unknown>;
  /** D-340 slice 2 — on Today, under the streams' tabs. In Settings (the default) the card leaves on a
   *  server whose streams took over, since Today holds it then. */
  onToday?: boolean;
}

const LEDE = 'A plain message each evening that lists your day and asks what you did, sent where your Agenda goes. '
  + 'Reply to it, in your messenger or here, to close the day.';
/** D-343 §3.1 — once the streams took over, it goes where the daily stream goes. */
const STREAM_LEDE = 'A plain message each evening that lists your day and asks what you did, sent where your daily stream goes. '
  + 'Reply to it, in your messenger or here, to close the day.';
const RUN_MODE: Readonly<Record<string, string>> = { close_day: 'Evening', close_day_manual: 'Send now' };
const RUN_STATE: Readonly<Record<string, string>> = {
  sent: 'Sent', pending: 'Waiting to retry', sending: 'Sending', uncertain: 'Delivery not confirmed',
  superseded: 'Not sent: a newer one replaced it',
};
const REPLY_REASON = {
  waiting: 'Saved and waiting to open in Chat. Recued will try again.',
  retry: 'Could not open in Chat yet. Your reply is saved; Recued will try again.',
  source_unavailable: 'The saved email could not be read. Check its mailbox, then try again.',
  unknown: 'An earlier reply could not be confirmed. Check its conversation before sending a new reply.',
} as const;

export const mountCloseDayPanel = (opts: CloseDayPanelOptions) => {
  const doc = opts.document ?? document;
  const root = doc.createElement('section');
  root.setAttribute(CLOSE_DAY_PANEL_ATTR, '');
  // Shown once a server names Close the day, so an older one shows nothing at all.
  root.hidden = true;
  opts.host.appendChild(root);
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, parent: HTMLElement = root, className?: string) => {
    const element = doc.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className !== undefined) element.className = className;
    parent.appendChild(element);
    return element;
  };
  // "Close the day" is the word its messages arrive under ("Close the day · Sat 7 Nov").
  node('h3', 'Close the day');
  const lede = node('p', LEDE, root, 'sd-lede');
  const form = node('form');
  const enabledLabel = node('label', undefined, form, 'sd-check');
  const enabled = node('input', undefined, enabledLabel);
  enabled.type = 'checkbox';
  enabled.name = 'enabled';
  enabled.setAttribute('aria-label', 'Ask me each evening what I did');
  node('span', 'Ask me each evening what I did', enabledLabel);
  const fields = node('div', undefined, form, 'sd-fields');
  const timeLabel = node('label', undefined, fields, 'sd-field');
  node('span', 'Time', timeLabel);
  const time = node('input', undefined, timeLabel, 'rx-input');
  time.type = 'time';
  time.name = 'time';
  time.required = true;
  time.setAttribute('aria-label', 'Time');
  node('p', 'The time is when it is sent, not a cutoff: a reply closes the day whenever it comes, even days later. '
    + 'A day with nothing on still asks, for what you did that was not planned.', form, 'sd-hint');
  const zone = node('p', 'Times use your ', form, 'sd-hint');
  node('a', 'server timezone', zone).href = '#settings/server/timezone';
  node('span', '. A time inside quiet hours waits until they end. Send now goes at once.', zone);
  const actions = node('div', undefined, form, 'sd-actions');
  const saveButton = node('button', 'Save', actions, 'rx-btn rx-btn-secondary rx-btn-sm');
  saveButton.type = 'submit';
  const sendButton = node('button', 'Send now', actions, 'rx-btn rx-btn-secondary rx-btn-sm');
  sendButton.type = 'button';
  sendButton.setAttribute('data-close-day-send-now', '');
  const notice = node('p');
  notice.setAttribute('data-close-day-message', '');
  notice.setAttribute('role', 'status');
  notice.setAttribute('tabindex', '-1');
  const retry = node('button', 'Retry', root, 'rx-btn rx-btn-secondary rx-btn-sm');
  retry.type = 'button';
  retry.setAttribute('data-close-day-retry', '');
  retry.hidden = true;
  const results = node('div');
  results.setAttribute('data-close-day-results', '');
  const emailReplies = node('div');
  emailReplies.setAttribute('data-close-day-email-replies', '');
  let replyButtons: HTMLButtonElement[] = [];
  const controls = [enabled, time, saveButton, sendButton];
  let disposed = false;
  let busy = false;
  let dirty = false;
  let generation = 0;
  let status: SituationCloseDayStatus | undefined;

  const message = (text: string, error = false) => {
    notice.textContent = text;
    notice.setAttribute('role', error ? 'alert' : 'status');
  };
  const lock = (value: boolean) => { busy = value; for (const control of [...controls, ...replyButtons]) control.disabled = value; };
  const settings = (): SituationCloseDaySettings => ({ enabled: enabled.checked, time: time.value });
  const same = (a: SituationCloseDaySettings, b: SituationCloseDaySettings) => a.enabled === b.enabled && a.time === b.time;
  const updateDirty = () => {
    if (disposed || busy || !status) return;
    dirty = time.validity.badInput || !same(settings(), status.settings);
  };
  const leave = () => { disposed = true; generation += 1; root.remove(); };
  const paint = () => {
    if (!status || disposed) return;
    root.hidden = false;
    // A read that matches the draft retires it; one that does not leaves the owner's edits.
    if (dirty && same(settings(), status.settings)) dirty = false;
    if (!dirty) {
      enabled.checked = status.settings.enabled;
      // A focused time control holds an incomplete segment outside `value`: it is left be.
      if (doc.activeElement !== time && time.value !== status.settings.time) time.value = status.settings.time;
    }
    const { last_run: run, last_sent: sent } = status;
    results.innerHTML = `${status.next_at !== undefined ? `<p data-close-day-next>Next: ${e(nextDigestText(status.next_at, status.time_zone))}</p>` : ''}
      ${status.uncertain ? `<p>${status.uncertain === 1 ? 'A delivery' : `${status.uncertain} deliveries`} could not be confirmed, even after one repeat.</p>` : ''}
      ${run ? `<p>Last sent ${e(new Date(run.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))} · ${e(RUN_MODE[run.mode] ?? run.mode)} · ${e(RUN_STATE[run.state] ?? run.state)}</p>${sent?.text ? `<details><summary>What it sent</summary><p class="sd-sent">${e(sent.text)}</p></details>` : ''}` : '<p>Nothing has been sent yet.</p>'}`;
    emailReplies.textContent = '';
    replyButtons = [];
    if (status.email_replies?.length) {
      node('h4', 'Email replies', emailReplies);
      for (const reply of status.email_replies) {
        const item = node('div', undefined, emailReplies);
        node('p', `Reply received ${new Date(reply.received_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}. ${REPLY_REASON[reply.reason]}`, item);
        if (reply.session_id) node('a', 'Open conversation', item).href = serializeChatSessionAddress({ sessionId: reply.session_id });
        if (reply.retry_available && opts.retryReply) {
          const button = node('button', 'Try opening in Chat', item, 'rx-btn rx-btn-secondary rx-btn-sm');
          button.type = 'button'; button.disabled = busy;
          button.setAttribute('data-close-day-email-retry', reply.id);
          button.addEventListener('click', () => { void write('reply', reply.id); });
          replyButtons.push(button);
        }
        if (reply.reason === 'unknown' && opts.reviewReply) {
          const button = node('button', 'Mark reviewed', item, 'rx-btn rx-btn-secondary rx-btn-sm');
          button.type = 'button'; button.disabled = busy;
          button.setAttribute('data-close-day-email-review', reply.id);
          button.addEventListener('click', () => { void write('review', reply.id); });
          replyButtons.push(button);
        }
      }
    }
  };
  const adopt = (next: SituationAgendaStatus): boolean => {
    if (!next.close_day || (next.streams && !opts.onToday)) return false;
    status = next.close_day;
    lede.textContent = next.streams ? STREAM_LEDE : LEDE;
    return true;
  };

  const write = async (kind: 'save' | 'send' | 'reply' | 'review', replyId?: string) => {
    if (busy || disposed || !status) return;
    const wanted = kind === 'save' ? settings() : undefined;
    if (wanted) dirty = true;
    generation += 1;
    const owner = [...controls, ...replyButtons].find(control => control === doc.activeElement);
    lock(true);
    retry.hidden = true;
    message(kind === 'save' ? 'Saving…' : kind === 'reply' ? 'Opening your email reply in Chat…' : kind === 'review' ? 'Marking reviewed…' : 'Sending…');
    if (owner) notice.focus({ preventScroll: true });
    let reading = false;
    try {
      if (wanted) await opts.save(wanted);
      else if (kind === 'reply') await opts.retryReply!(replyId!);
      else if (kind === 'review') await opts.reviewReply!(replyId!);
      else await opts.sendNow();
      if (disposed) return;
      reading = true;
      const next = await opts.read();
      if (disposed) return;
      if (!adopt(next)) { leave(); return; }
      if (wanted && !same(wanted, status!.settings)) {
        paint();
        throw new Error('The settings could not be confirmed. Your edits are still here. Try saving again.');
      }
      if (wanted) dirty = false;
      paint();
      message(kind === 'review' ? 'Earlier email reply marked reviewed.' : kind === 'save' ? 'Close the day saved.' : kind === 'reply'
        ? 'Email reply checked. Any reply still waiting is listed below.' : 'Sent. Reply to it with what you did.');
    } catch (error) {
      if (!disposed) {
        message(error instanceof Error ? error.message : String(error), true);
        // Retry reloads the card; it never repeats a completed action.
        retry.hidden = !reading;
      }
    } finally {
      busy = false;
      if (!disposed) {
        lock(false);
        if (doc.activeElement === notice && kind !== 'reply' && kind !== 'review') owner?.focus({ preventScroll: true });
      }
    }
  };
  form.addEventListener('input', updateDirty);
  form.addEventListener('change', updateDirty);
  form.addEventListener('submit', event => { event.preventDefault(); void write('save'); });
  sendButton.addEventListener('click', () => { void write('send'); });

  const refresh = async () => {
    if (disposed || busy) return;
    const own = ++generation;
    const had = status !== undefined;
    retry.hidden = true;
    message(had ? 'Refreshing…' : 'Loading…');
    try {
      const next = await opts.read();
      if (disposed || own !== generation) return;
      // A server that names no Close the day: the card leaves, and with it any claim to the page.
      if (!adopt(next)) { leave(); return; }
      paint();
      message('');
    } catch (error) {
      if (disposed || own !== generation) return;
      if (!status && classifyRpcError(error).code === 'unknown_method') { leave(); return; }
      root.hidden = false;
      message(error instanceof Error ? error.message : String(error), true);
      retry.hidden = false;
    }
  };
  retry.addEventListener('click', () => { void refresh(); });
  void refresh();
  return {
    refresh,
    hasInFlightWork: () => !disposed && busy,
    hasUnsavedChanges: () => !disposed && (dirty || time.validity.badInput),
    dispose() { disposed = true; generation += 1; root.remove(); },
  };
};

/** Injected once by the settings route, beside the Agenda's: the same card, under its own attribute.
 *  ⚠ The card starts `hidden` until a server names Close the day, and the card's own
 *  `display: flex` would otherwise show it. */
export const CLOSE_DAY_PANEL_STYLES = `${deliveryCardStyles(CLOSE_DAY_PANEL_ATTR, {
  message: 'data-close-day-message', retry: 'data-close-day-retry', results: 'data-close-day-results' })}
[${CLOSE_DAY_PANEL_ATTR}][hidden] {
  display: none !important;
}
`;
