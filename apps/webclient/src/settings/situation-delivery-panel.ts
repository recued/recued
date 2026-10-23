import type { SituationDeliverySettings, SituationDeliveryStatus } from '@recued/contracts';
import { e } from '@recued/ui-shared';
import { classifyRpcError } from '../shell/rpc-error-copy.js';

export interface SituationDeliveryPanelOptions {
  host: HTMLElement; document?: Document;
  read: () => Promise<SituationDeliveryStatus>;
  save: (settings: SituationDeliverySettings) => Promise<unknown>;
  sendNow: () => Promise<unknown>;
}
export const mountSituationDeliveryPanel = (opts: SituationDeliveryPanelOptions) => {
  const doc = opts.document ?? document;
  const root = doc.createElement('section');
  root.setAttribute('data-situation-delivery', '');
  opts.host.appendChild(root);
  // The form stays connected. Native time controls hold incomplete segments
  // outside `value`, so retaining a string cannot preserve an in-progress edit.
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, parent: HTMLElement = root) => {
    const element = doc.createElement(tag);
    if (text !== undefined) element.textContent = text;
    parent.appendChild(element);
    return element;
  };
  node('h3', 'Coming up');
  node('p', 'A weekly or daily overview and day-of notes open Today. Unchanged items are counted in Still open.');
  node('p', 'Asset and occasion rules send their own reminders. Day-of notes add other due items and checks.');
  const editor = node('div');
  editor.setAttribute('data-overview-editor', '');
  editor.hidden = true;
  const form = node('form', undefined, editor);
  const select = (name: string, label: string, choices: ReadonlyArray<readonly [string, string]>) => {
    const wrap = node('label', `${label} `, form);
    const control = node('select', undefined, wrap);
    control.name = name;
    control.setAttribute('aria-label', label);
    for (const [value, text] of choices) node('option', text, control).value = value;
    return control;
  };
  const frequency = select('frequency', 'Overview', [['weekly', 'Weekly'], ['daily', 'Daily'], ['off', 'Off']]);
  const weekday = select('weekday', 'Weekly day', ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
    .map((day, index) => [String(index + 1), day] as const));
  const time = node('input', undefined, node('label', 'Time ', form));
  time.type = 'time';
  time.name = 'time';
  time.required = true;
  time.setAttribute('aria-label', 'Time');
  const dayLabel = node('label', undefined, form);
  const dayOf = node('input', undefined, dayLabel);
  dayOf.type = 'checkbox';
  dayOf.name = 'day_of';
  dayOf.setAttribute('aria-label', 'Day-of notes');
  node('span', ' Day-of notes', dayLabel);
  const timezone = node('p', 'Uses your ', form);
  node('a', 'server timezone', timezone).href = '#settings/server/timezone';
  node('span', ' and notification quiet hours.', timezone);
  const saveButton = node('button', 'Save overview schedule', form);
  saveButton.type = 'submit';
  const sendButton = node('button', 'Send now', form);
  sendButton.type = 'button';
  sendButton.setAttribute('data-send-now', '');
  const notice = node('p');
  notice.setAttribute('data-situation-delivery-message', '');
  notice.setAttribute('role', 'status');
  notice.setAttribute('tabindex', '-1');
  const retry = node('button', 'Retry overview settings');
  retry.type = 'button';
  retry.setAttribute('data-overview-retry', '');
  retry.hidden = true;
  const results = node('div');
  results.setAttribute('data-overview-results', '');
  const controls = [frequency, weekday, time, dayOf, saveButton, sendButton];
  let disposed = false;
  let busy = false;
  let dirty = false;
  let unconfirmedSave = false;
  let generation = 0;
  let status: SituationDeliveryStatus | undefined;
  let resultKey: string | undefined;

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
  });
  const sameSettings = (a: SituationDeliverySettings, b: SituationDeliverySettings) =>
    a.frequency === b.frequency && a.weekday === b.weekday && a.time === b.time && a.day_of === b.day_of;
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
    }
    const key = JSON.stringify([status.pending, status.uncertain, status.last_run, status.last_sent]);
    if (key === resultKey) return;
    resultKey = key;
    const priorDetails = results.querySelector('details');
    const open = priorDetails?.open ?? false;
    const heldSummary = doc.activeElement === priorDetails?.querySelector('summary');
    results.innerHTML = `${status.pending ? `<p>${status.pending} overview deliveries are waiting. Recued retries them.</p>` : ''}
      ${status.uncertain ? `<p>${status.uncertain} deliveries could not be confirmed after their marked repeat. Open Today to check the current items.</p>` : ''}
      ${status.last_run ? `<p>Last checked ${e(new Date(status.last_run.at).toLocaleString())} · ${e(status.last_run.state)}</p>${status.last_sent?.text ? `<details><summary>What it sent</summary><p style="white-space:pre-wrap">${e(status.last_sent.text)}</p></details>` : ''}` : '<p>No overview has run yet.</p>'}`;
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
        throw new Error('The overview schedule could not be confirmed. Your edits are still here. Try saving again.');
      }
      if (wanted) dirty = false;
      paint();
      message(kind === 'save' ? 'Overview schedule saved.' : 'Checked. An overview sends when something changed.');
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
    message(hadStatus ? 'Refreshing overview settings…' : 'Loading overview settings…');
    if (retryOwned) notice.focus({ preventScroll: true });
    try {
      const next = await opts.read();
      if (disposed || ownGeneration !== generation) return;
      status = next;
      unconfirmedSave = false;
      paint();
      message(hadStatus ? 'Overview settings updated.' : '');
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
