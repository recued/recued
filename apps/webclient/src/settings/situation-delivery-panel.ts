import type { SituationDeliverySettings, SituationDeliveryStatus, SituationDigestLookAhead } from '@recued/contracts';
import { e } from '@recued/ui-shared';
import { classifyRpcError } from '../shell/rpc-error-copy.js';

export const SITUATION_DELIVERY_PANEL_ATTR = 'data-situation-delivery';

export interface SituationDeliveryPanelOptions {
  host: HTMLElement; document?: Document;
  read: () => Promise<SituationDeliveryStatus>;
  save: (settings: SituationDeliverySettings) => Promise<unknown>;
  sendNow: () => Promise<unknown>;
}

// A run's mode and state as the owner reads them; an unknown value is shown as the server wrote it.
const RUN_MODE: Readonly<Record<string, string>> = { overview: 'Coming up', day_of: 'Due today', manual: 'Manual check' };
const RUN_STATE: Readonly<Record<string, string>> = {
  sent: 'Sent', skipped: 'Nothing new to send', pending: 'Waiting to retry', sending: 'Sending',
  uncertain: 'Delivery not confirmed', superseded: 'Replaced by a newer one',
};
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** §15.7 amendment (2026-11-02) — how far ahead a digest looks, counted from the day it goes,
 *  that day included. Keyed by the contract's type, so a new length is named here too. */
const LOOK_AHEAD: Readonly<Record<SituationDigestLookAhead, string>> = {
  2: 'Today and tomorrow', 3: 'Next 3 days', 7: 'Next 7 days', 14: 'Next 14 days',
};
/** The windows a digest at this frequency may cover, shortest first. A weekly digest covers at
 *  least a week, as the server holds it to, so no day falls between two digests. */
export const digestLookAheadChoices = (frequency: string): SituationDigestLookAhead[] =>
  (Object.keys(LOOK_AHEAD).map(Number) as SituationDigestLookAhead[]).filter(days => frequency !== 'weekly' || days >= 7);
/** The choice to show: the owner's own while it is offered, else the shortest offered that is
 *  longer, so a detour through Weekly gives a daily digest its window back. */
export const digestLookAheadFor = (frequency: string, wanted: number): SituationDigestLookAhead => {
  const choices = digestLookAheadChoices(frequency);
  return choices.find(days => days >= wanted) ?? choices.at(-1)!;
};
/** §15.7 amendment — when the next digest goes, in the server's zone the card's times use.
 *  An unknown zone falls back to this device's; a time already come reads "going out now". */
export const nextDigestText = (at: number, timeZone: string | undefined, now = Date.now(), locale?: string): string => {
  if (at <= now + 60_000) return 'going out now';
  const options: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };
  try { return new Intl.DateTimeFormat(locale, { ...options, ...(timeZone ? { timeZone } : {}) }).format(at); }
  catch { return new Intl.DateTimeFormat(locale, options).format(at); }
};

export const mountSituationDeliveryPanel = (opts: SituationDeliveryPanelOptions) => {
  const doc = opts.document ?? document;
  const root = doc.createElement('section');
  root.setAttribute(SITUATION_DELIVERY_PANEL_ATTR, '');
  opts.host.appendChild(root);
  // The form stays connected. Native time controls hold incomplete segments
  // outside `value`, so retaining a string cannot preserve an in-progress edit.
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, parent: HTMLElement = root, className?: string) => {
    const element = doc.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className !== undefined) element.className = className;
    parent.appendChild(element);
    return element;
  };
  // D-338 §9 — the card is named as its message is ("Coming up"), and the due-day note it also
  // holds as that is ("Due today"), so the owner matches a message to its setting. Its settings
  // keep their stored names (`digest.frequency`, `situations.delivery`).
  node('h3', 'Coming up');
  node('p', 'What changed in the days ahead, sent to your notification channels as “Coming up”. It lists what '
    + 'changed since the last one and counts the rest as still open. If nothing changed, nothing is sent.', root, 'sd-lede');
  const editor = node('div');
  editor.setAttribute('data-overview-editor', '');
  editor.hidden = true;
  const form = node('form', undefined, editor);
  const fields = node('div', undefined, form, 'sd-fields');
  const field = (label: string) => {
    const wrap = node('label', undefined, fields, 'sd-field');
    node('span', label, wrap);
    return wrap;
  };
  const select = (name: string, label: string, choices: ReadonlyArray<readonly [string, string]>) => {
    const control = node('select', undefined, field(label), 'rx-select');
    control.name = name;
    control.setAttribute('aria-label', label);
    for (const [value, text] of choices) node('option', text, control).value = value;
    return control;
  };
  const frequency = select('frequency', 'How often', [['weekly', 'Weekly'], ['daily', 'Daily'], ['off', 'Off']]);
  const weekday = select('weekday', 'Day', ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
    .map((day, index) => [String(index + 1), day] as const));
  const time = node('input', undefined, field('Time'), 'rx-input');
  time.type = 'time';
  time.name = 'time';
  time.required = true;
  time.setAttribute('aria-label', 'Time');
  // An older server has no window to choose (its digest covers seven days): the field stays
  // hidden and the save leaves it out, since that server would keep it and ignore it.
  const lookAhead = select('look_ahead_days', 'How far ahead', []);
  const lookAheadField = lookAhead.parentElement!;
  lookAheadField.hidden = true;
  const weeklyHint = node('p', 'Weekly looks at least a week ahead, so nothing falls between two.', form, 'sd-hint');
  weeklyHint.setAttribute('data-look-ahead-hint', '');
  weeklyHint.hidden = true;
  const dayLabel = node('label', undefined, form, 'sd-check');
  const dayOf = node('input', undefined, dayLabel);
  dayOf.type = 'checkbox';
  dayOf.name = 'day_of';
  dayOf.setAttribute('aria-label', 'Also send “Due today” on the day something is due');
  node('span', 'Also send “Due today” on the day something is due', dayLabel);
  // Both go at the set time, and "Due today" goes whatever the frequency, except on a day the
  // Agenda lists that morning or the evening before (D-338 §9: it would repeat it).
  node('p', 'It goes at the same time, even with “Coming up” off. It skips a day your Agenda lists that morning '
    + 'or the evening before.', form, 'sd-hint');
  const timezone = node('p', 'Times use your ', form, 'sd-hint');
  node('a', 'server timezone', timezone).href = '#settings/server/timezone';
  // Send now ignores quiet hours (`tickOnce(manual)`); only the schedule waits,
  // and a time inside them goes when they end (`quietHoursEndFor`).
  node('span', '. A time inside quiet hours waits until they end. Reminders for your assets and occasions don’t '
    + 'depend on this: each rule sends its own.', timezone);
  const actions = node('div', undefined, form, 'sd-actions');
  const saveButton = node('button', 'Save “Coming up” settings', actions, 'rx-btn rx-btn-secondary rx-btn-sm');
  saveButton.type = 'submit';
  const sendButton = node('button', 'Send now', actions, 'rx-btn rx-btn-secondary rx-btn-sm');
  sendButton.type = 'button';
  sendButton.setAttribute('data-send-now', '');
  const notice = node('p');
  notice.setAttribute('data-situation-delivery-message', '');
  notice.setAttribute('role', 'status');
  notice.setAttribute('tabindex', '-1');
  const retry = node('button', 'Retry “Coming up” settings', root, 'rx-btn rx-btn-secondary rx-btn-sm');
  retry.type = 'button';
  retry.setAttribute('data-overview-retry', '');
  retry.hidden = true;
  const results = node('div');
  results.setAttribute('data-overview-results', '');
  // The day only applies to a weekly digest. A focused control is left in
  // place until it is blurred, so a refresh cannot drop keyboard focus.
  const weekdayField = weekday.parentElement!;
  const syncWeekday = () => {
    if (frequency.value === 'weekly') weekdayField.hidden = false;
    else if (doc.activeElement !== weekday) weekdayField.hidden = true;
  };
  const controls = [frequency, weekday, time, lookAhead, dayOf, saveButton, sendButton];
  let disposed = false;
  let busy = false;
  let dirty = false;
  let unconfirmedSave = false;
  let generation = 0;
  let status: SituationDeliveryStatus | undefined;
  let resultKey: string | undefined;
  // The window the owner last chose, kept while Weekly offers only longer ones.
  let wantedLookAhead = 7;
  const lookAheadNamed = () => status?.settings.look_ahead_days !== undefined;
  const syncLookAhead = () => {
    lookAheadField.hidden = !lookAheadNamed();
    weeklyHint.hidden = !lookAheadNamed() || frequency.value !== 'weekly';
    const choices = digestLookAheadChoices(frequency.value);
    if ([...lookAhead.options].map(option => option.value).join() !== choices.join()) {
      lookAhead.replaceChildren();
      for (const days of choices) node('option', LOOK_AHEAD[days], lookAhead).value = String(days);
    }
    lookAhead.value = String(digestLookAheadFor(frequency.value, wantedLookAhead));
  };

  const message = (text: string, error = false) => {
    notice.textContent = text;
    notice.setAttribute('role', error ? 'alert' : 'status');
  };
  const lock = (value: boolean) => {
    busy = value;
    for (const control of controls) control.disabled = value;
  };
  const settings = (): SituationDeliverySettings => ({
    frequency: frequency.value as SituationDeliverySettings['frequency'],
    weekday: Number(weekday.value), time: time.value, day_of: dayOf.checked,
    ...(lookAheadNamed() ? { look_ahead_days: Number(lookAhead.value) as SituationDigestLookAhead } : {}),
  });
  const sameSettings = (a: SituationDeliverySettings, b: SituationDeliverySettings) =>
    a.frequency === b.frequency && a.weekday === b.weekday && a.time === b.time && a.day_of === b.day_of
    && a.look_ahead_days === b.look_ahead_days;
  const updateDirty = () => {
    if (disposed || busy || !status) return;
    // A failed save may have reached the server. Only a fresh read can resolve it.
    dirty = unconfirmedSave || time.validity.badInput || !sameSettings(settings(), status.settings);
  };
  const paint = () => {
    if (!status || disposed) return;
    editor.hidden = false;
    if (time.validity.badInput) dirty = true;
    // A refreshed read can also confirm a save whose acknowledgement read
    // failed. It must match the whole current draft before retiring that draft.
    if (dirty && sameSettings(settings(), status.settings)) dirty = false;
    if (!dirty) {
      frequency.value = status.settings.frequency;
      weekday.value = String(status.settings.weekday);
      if (doc.activeElement !== time && time.value !== status.settings.time) time.value = status.settings.time;
      dayOf.checked = status.settings.day_of;
      if (status.settings.look_ahead_days !== undefined) wantedLookAhead = status.settings.look_ahead_days;
    }
    syncWeekday();
    syncLookAhead();
    const key = JSON.stringify([status.pending, status.uncertain, status.last_run, status.last_sent, status.next_at, status.time_zone]);
    if (key === resultKey) return;
    resultKey = key;
    const priorDetails = results.querySelector('details');
    const open = priorDetails?.open ?? false;
    const heldSummary = doc.activeElement === priorDetails?.querySelector('summary');
    const { pending = 0, uncertain = 0, last_run: run, last_sent: sent } = status;
    results.innerHTML = `${status.next_at !== undefined ? `<p data-situation-next>Next “Coming up”: ${e(nextDigestText(status.next_at, status.time_zone))}</p>` : ''}
      ${pending ? `<p>${count(pending, 'message is', 'messages are')} waiting to be sent. Recued retries ${pending === 1 ? 'it' : 'them'}.</p>` : ''}
      ${uncertain ? `<p>${count(uncertain, 'delivery', 'deliveries')} could not be confirmed, even after one repeat. Open Today to see what is current.</p>` : ''}
      ${run ? `<p>Last checked ${e(new Date(run.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))} · ${e(RUN_MODE[run.mode] ?? run.mode)} · ${e(RUN_STATE[run.state] ?? run.state)}</p>${sent?.text ? `<details><summary>What it sent</summary><p class="sd-sent">${e(sent.text)}</p></details>` : ''}` : '<p>Nothing has been sent yet.</p>'}`;
    const details = results.querySelector('details');
    if (details) details.open = open;
    if (heldSummary) (details?.querySelector('summary') ?? notice).focus({ preventScroll: true });
  };

  const write = async (kind: 'save' | 'send') => {
    if (busy || disposed || !status) return;
    const wanted = kind === 'save' ? settings() : undefined;
    if (wanted) { dirty = true; unconfirmedSave = true; }
    // Retire older reads before starting a write, including their errors.
    generation += 1;
    const owner = controls.find(control => control === doc.activeElement);
    let reading = false;
    lock(true);
    retry.hidden = true;
    message(kind === 'save' ? 'Saving…' : 'Checking what changed…');
    if (owner) notice.focus({ preventScroll: true });
    try {
      if (wanted) await opts.save(wanted);
      else await opts.sendNow();
      if (disposed) return;
      reading = true;
      const next = await opts.read();
      if (disposed) return;
      status = next;
      unconfirmedSave = false;
      if (wanted && !sameSettings(wanted, next.settings)) {
        paint();
        throw new Error('The “Coming up” settings could not be confirmed. Your edits are still here. Try saving again.');
      }
      if (wanted) dirty = false;
      paint();
      message(kind === 'save' ? '“Coming up” settings saved.' : 'Checked. “Coming up” is sent only when something changed.');
    } catch (error) {
      if (!disposed) {
        message(error instanceof Error ? error.message : String(error), true);
        // Retry reloads settings/results; it never repeats a completed action.
        retry.hidden = !reading;
      }
    } finally {
      busy = false;
      if (!disposed) {
        lock(false);
        if (doc.activeElement === notice) owner?.focus({ preventScroll: true });
      }
    }
  };
  form.addEventListener('input', updateDirty);
  form.addEventListener('change', updateDirty);
  // Before the form's own `change`, so the dirty check sees the window the frequency offers.
  frequency.addEventListener('change', () => { syncWeekday(); syncLookAhead(); });
  lookAhead.addEventListener('change', () => { wantedLookAhead = Number(lookAhead.value); });
  weekday.addEventListener('blur', syncWeekday);
  time.addEventListener('blur', () => {
    if (!disposed && !busy && !dirty && status && !time.validity.badInput && time.value !== status.settings.time) time.value = status.settings.time;
  });
  form.addEventListener('submit', event => { event.preventDefault(); void write('save'); });
  sendButton.addEventListener('click', () => { void write('send'); });

  const refresh = async () => {
    if (disposed || busy) return;
    const ownGeneration = ++generation;
    const hadStatus = status !== undefined;
    const retryOwned = doc.activeElement === retry;
    retry.hidden = true;
    message(hadStatus ? 'Refreshing “Coming up” settings…' : 'Loading “Coming up” settings…');
    if (retryOwned) notice.focus({ preventScroll: true });
    try {
      const next = await opts.read();
      if (disposed || ownGeneration !== generation) return;
      status = next;
      unconfirmedSave = false;
      paint();
      message(hadStatus ? '“Coming up” settings updated.' : '');
    } catch (error) {
      if (disposed || ownGeneration !== generation) return;
      // An old server omits this feature. A later read failure retains a draft
      // already being edited instead of removing its form.
      if (!status && classifyRpcError(error).code === 'unknown_method') {
        disposed = true;
        root.remove();
        return;
      }
      message(error instanceof Error ? error.message : String(error), true);
      retry.hidden = false;
    } finally {
      if (!disposed && ownGeneration === generation && retryOwned && doc.activeElement === notice) {
        (retry.hidden ? saveButton : retry).focus({ preventScroll: true });
      }
    }
  };
  retry.addEventListener('click', () => { void refresh(); });
  void refresh();
  return {
    refresh,
    // A user-started action stays pending through its confirmation read.
    hasInFlightWork: () => !disposed && busy,
    hasUnsavedChanges: () => !disposed && (dirty || time.validity.badInput),
    dispose() { disposed = true; generation += 1; root.remove(); },
  };
};

/** Injected once by the settings route. The card matches its neighbours in
 *  Approval & notifications (kind policy, quiet hours): this panel shipped with
 *  no styles, so it rendered as unpadded browser defaults beneath them.
 *  Control heights are the shell's (`--wc-control-h`, 44px on a phone), so
 *  this sets layout only.
 *  ⚠ `[hidden]` is restated because `.rx-btn` sets a display, which would
 *  otherwise show the hidden Retry button and the unloaded editor.
 *  The Agenda's card (§15.7, 2026-11-02, later) is the same card under its own
 *  attribute and its own message, retry and results hooks. */
export const deliveryCardStyles = (attr: string, names: { message: string; retry: string; results: string }): string => `
[${attr}] {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 18px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--fg);
  font-size: 13px;
}
[${attr}] [hidden] {
  display: none !important;
}
[${attr}] h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
[${attr}] p {
  margin: 0;
}
[${attr}] .sd-lede,
[${attr}] .sd-hint {
  max-width: 68ch;
  color: var(--fg-muted);
}
[${attr}] .sd-hint {
  font-size: 12px;
}
[${attr}] .sd-hint a {
  color: var(--accent);
}
[${attr}] form {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
}
[${attr}] .sd-fields {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 16px;
}
[${attr}] .sd-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 132px;
}
[${attr}] .sd-field > span {
  font-size: 12px;
  font-weight: 500;
  color: var(--fg-muted);
}
[${attr}] .sd-check {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 28px;
  font-weight: 500;
  cursor: pointer;
}
[${attr}] .sd-check input {
  width: 16px;
  height: 16px;
  margin: 0;
  accent-color: var(--accent);
}
/* The label is the checkbox's target: a finger's height on a phone. ⛔ 28px. */
@media (max-width: 640px) {
  [${attr}] .sd-check { min-height: 44px; }
}
[${attr}] .sd-check + .sd-hint {
  margin-top: -6px;
  padding-left: 24px;
}
[${attr}] .sd-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
[${attr}] [${names.message}][role="alert"] {
  color: var(--danger);
}
[${attr}] [${names.retry}] {
  align-self: flex-start;
}
[${attr}] [${names.results}] {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
  font-size: 12px;
  color: var(--fg-muted);
}
[${attr}] [${names.results}]:empty {
  display: none;
}
[${attr}] [${names.results}] summary {
  cursor: pointer;
  color: var(--fg);
}
[${attr}] .sd-sent {
  margin-top: 6px;
  padding: 8px 10px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--fg);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 4px;
}
`;
export const SITUATION_DELIVERY_PANEL_STYLES = deliveryCardStyles(SITUATION_DELIVERY_PANEL_ATTR,
  { message: 'data-situation-delivery-message', retry: 'data-overview-retry', results: 'data-overview-results' });
