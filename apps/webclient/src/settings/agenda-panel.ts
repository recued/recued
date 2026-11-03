import type { SituationAgendaSettings, SituationAgendaStatus } from '@recued/contracts';
import { e } from '@recued/ui-shared';
import { classifyRpcError } from '../shell/rpc-error-copy.js';
import { deliveryCardStyles, nextDigestText } from './situation-delivery-panel.js';

export const AGENDA_PANEL_ATTR = 'data-situation-agenda';

/** D-325 §15.7 amendment (2026-11-02, later) — the Agenda card, apart from the Digest's. The
 *  owner: *"or it could be a separate thing that dont call digest (so those two are
 *  seperated)"*. It reads its own status (`yours.agenda`); a server without the Agenda answers
 *  `unknown_method`, and the card leaves the page. Amended 2026-11-03: daily or weekly, offered
 *  only by a server that names its frequency. */
export interface AgendaPanelOptions {
  host: HTMLElement; document?: Document;
  read: () => Promise<SituationAgendaStatus>;
  save: (settings: SituationAgendaSettings) => Promise<unknown>;
  sendNow: () => Promise<unknown>;
}

const RUN_MODE: Readonly<Record<string, string>> = { agenda: 'Agenda', agenda_manual: 'Send now' };
const RUN_STATE: Readonly<Record<string, string>> = {
  sent: 'Sent', skipped: 'Nothing on, so nothing was sent', pending: 'Waiting to retry', sending: 'Sending',
  uncertain: 'Delivery not confirmed', superseded: 'Not sent: a newer agenda replaced it',
};
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
const DAY_CHOICES = [['today', 'Today'], ['tomorrow', 'Tomorrow']] as const;
/** §15.7 amendment (2026-11-03) — what "Which days" offers a weekly agenda going on `weekday`
 *  (ISO, Monday=1): the seven days from that day, or from the next, by name. */
export const agendaWeekChoices = (weekday: number): ReadonlyArray<readonly ['today' | 'tomorrow', string]> => {
  const from = Number.isInteger(weekday) && weekday >= 1 && weekday <= 7 ? weekday - 1 : 0;
  const name = (offset: number) => WEEKDAYS[(from + offset) % 7];
  return [['today', `${name(0)} to ${name(6)}`], ['tomorrow', `${name(1)} to ${name(7)}`]];
};
const DAILY_LEDE = 'Your day in time order, sent to your notification channels as “Agenda” with its date. It lists everything '
  + 'on that day, recurring events included, every time, whether or not it changed. If nothing is on, nothing is sent.';
const WEEKLY_LEDE = 'Your day or your week in time order, sent to your notification channels as “Agenda” with its dates. It lists '
  + 'everything on those days, recurring events included, every time, whether or not it changed. If nothing is on, nothing is sent.';

export const mountAgendaPanel = (opts: AgendaPanelOptions) => {
  const doc = opts.document ?? document;
  const root = doc.createElement('section');
  root.setAttribute(AGENDA_PANEL_ATTR, '');
  // Shown once a server answers that it has an Agenda, so an older one shows nothing at all.
  root.hidden = true;
  opts.host.appendChild(root);
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, parent: HTMLElement = root, className?: string) => {
    const element = doc.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className !== undefined) element.className = className;
    parent.appendChild(element);
    return element;
  };
  // "Agenda" is the word its messages arrive under ("Agenda · Tue 3 Nov"), as "Coming up" is the Digest's.
  node('h3', 'Agenda');
  // A server whose Agenda is daily only keeps the daily words: it offers no week.
  const lede = node('p', DAILY_LEDE, root, 'sd-lede');
  const editor = node('div');
  editor.setAttribute('data-agenda-editor', '');
  editor.hidden = true;
  const form = node('form', undefined, editor);
  const enabledLabel = node('label', undefined, form, 'sd-check');
  const enabled = node('input', undefined, enabledLabel);
  enabled.type = 'checkbox';
  enabled.name = 'enabled';
  enabled.setAttribute('aria-label', 'Send me an agenda');
  node('span', 'Send me an agenda', enabledLabel);
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
  // How often and its Day show only for a server that names a frequency: one whose Agenda is
  // daily only would drop them from a save, and say it was saved.
  const frequency = select('frequency', 'How often', [['daily', 'Daily'], ['weekly', 'Weekly']]);
  const frequencyField = frequency.parentElement!;
  frequencyField.hidden = true;
  const weekday = select('weekday', 'Day', WEEKDAYS.map((name, index) => [String(index + 1), name] as const));
  const weekdayField = weekday.parentElement!;
  weekdayField.hidden = true;
  // A daily agenda lists one day and a weekly one seven: the same choice, named for each.
  const day = select('day', 'Which day', DAY_CHOICES);
  const dayLabel = day.parentElement!.querySelector('span')!;
  const time = node('input', undefined, field('Time'), 'rx-input');
  time.type = 'time';
  time.name = 'time';
  time.required = true;
  time.setAttribute('aria-label', 'Time');
  const dailyHint = node('p', 'Today leaves out what is already over when it goes. Tomorrow suits an evening time.', form, 'sd-hint');
  const weeklyHint = node('p', 'It lists the seven days, a day at a time, and leaves out a day with nothing on.', form, 'sd-hint');
  weeklyHint.setAttribute('data-agenda-week-hint', '');
  weeklyHint.hidden = true;
  const prep = node('p', 'A meeting says “prep notes ready” once its Meeting preparation notes are written. ', form, 'sd-hint');
  node('a', 'Turn them on in Housekeeping', prep).href = '#settings/housekeeping';
  node('span', '.', prep);
  const timezone = node('p', 'Times use your ', form, 'sd-hint');
  node('a', 'server timezone', timezone).href = '#settings/server/timezone';
  node('span', '. A time inside quiet hours waits until they end. Send now goes at once.', timezone);
  const actions = node('div', undefined, form, 'sd-actions');
  const saveButton = node('button', 'Save agenda settings', actions, 'rx-btn rx-btn-secondary rx-btn-sm');
  saveButton.type = 'submit';
  const sendButton = node('button', 'Send now', actions, 'rx-btn rx-btn-secondary rx-btn-sm');
  sendButton.type = 'button';
  sendButton.setAttribute('data-agenda-send-now', '');
  const notice = node('p');
  notice.setAttribute('data-agenda-message', '');
  notice.setAttribute('role', 'status');
  notice.setAttribute('tabindex', '-1');
  const retry = node('button', 'Retry agenda settings', root, 'rx-btn rx-btn-secondary rx-btn-sm');
  retry.type = 'button';
  retry.setAttribute('data-agenda-retry', '');
  retry.hidden = true;
  const results = node('div');
  results.setAttribute('data-agenda-results', '');
  const controls = [enabled, frequency, weekday, day, time, saveButton, sendButton];
  let disposed = false;
  let busy = false;
  let dirty = false;
  let unconfirmedSave = false;
  let generation = 0;
  let agenda: SituationAgendaStatus | undefined;
  let resultKey: string | undefined;

  const message = (text: string, error = false) => {
    notice.textContent = text;
    notice.setAttribute('role', error ? 'alert' : 'status');
  };
  const lock = (value: boolean) => {
    busy = value;
    for (const control of controls) control.disabled = value;
  };
  const weeklyNamed = () => agenda?.settings.frequency !== undefined;
  const weekly = () => weeklyNamed() && frequency.value === 'weekly';
  // Labels follow the frequency and the weekday; values stay, so a draft keeps its choice. A
  // focused Day stays until it is blurred, so a refresh cannot drop keyboard focus.
  const syncFields = () => {
    lede.textContent = weeklyNamed() ? WEEKLY_LEDE : DAILY_LEDE;
    frequencyField.hidden = !weeklyNamed();
    if (weekly()) weekdayField.hidden = false;
    else if (doc.activeElement !== weekday) weekdayField.hidden = true;
    const choices = weekly() ? agendaWeekChoices(Number(weekday.value)) : DAY_CHOICES;
    for (const [index, [, text]] of choices.entries()) day.options[index]!.textContent = text;
    const label = weekly() ? 'Which days' : 'Which day';
    dayLabel.textContent = label;
    day.setAttribute('aria-label', label);
    dailyHint.hidden = weekly();
    weeklyHint.hidden = !weekly();
  };
  const settings = (): SituationAgendaSettings => ({ enabled: enabled.checked, time: time.value, day: day.value === 'tomorrow' ? 'tomorrow' : 'today',
    ...(weeklyNamed() ? { frequency: frequency.value === 'weekly' ? 'weekly' as const : 'daily' as const, weekday: Number(weekday.value) } : {}) });
  const sameSettings = (a: SituationAgendaSettings, b: SituationAgendaSettings) => a.enabled === b.enabled && a.time === b.time && a.day === b.day
    && a.frequency === b.frequency && a.weekday === b.weekday;
  const updateDirty = () => {
    if (disposed || busy || !agenda) return;
    // A failed save may have reached the server. Only a fresh read can resolve it.
    dirty = unconfirmedSave || time.validity.badInput || !sameSettings(settings(), agenda.settings);
  };
  // A server without the Agenda: the card leaves, and with it any claim to the page.
  const leave = () => { disposed = true; generation += 1; root.remove(); };
  const adopt = (status: SituationAgendaStatus) => { agenda = status; };
  const paint = () => {
    if (!agenda || disposed) return;
    root.hidden = false;
    editor.hidden = false;
    if (time.validity.badInput) dirty = true;
    // A refreshed read can also confirm a save whose acknowledgement read failed. It must
    // match the whole current draft before retiring that draft.
    if (dirty && sameSettings(settings(), agenda.settings)) dirty = false;
    if (!dirty) {
      enabled.checked = agenda.settings.enabled;
      day.value = agenda.settings.day;
      if (agenda.settings.frequency !== undefined) frequency.value = agenda.settings.frequency;
      if (agenda.settings.weekday !== undefined) weekday.value = String(agenda.settings.weekday);
      // Native time controls hold an incomplete segment outside `value`: a focused one is left be.
      if (doc.activeElement !== time && time.value !== agenda.settings.time) time.value = agenda.settings.time;
    }
    syncFields();
    const key = JSON.stringify([agenda.pending, agenda.uncertain, agenda.last_run, agenda.last_sent, agenda.next_at, agenda.time_zone]);
    if (key === resultKey) return;
    resultKey = key;
    const priorDetails = results.querySelector('details');
    const open = priorDetails?.open ?? false;
    const heldSummary = doc.activeElement === priorDetails?.querySelector('summary');
    const { pending, uncertain, last_run: run, last_sent: sent } = agenda;
    results.innerHTML = `${agenda.next_at !== undefined ? `<p data-agenda-next>Next agenda: ${e(nextDigestText(agenda.next_at, agenda.time_zone))}</p>` : ''}
      ${pending ? `<p>${count(pending, 'agenda is', 'agendas are')} waiting to be sent. Recued retries ${pending === 1 ? 'it' : 'them'} that day.</p>` : ''}
      ${uncertain ? `<p>${count(uncertain, 'delivery', 'deliveries')} could not be confirmed, even after one repeat. Open Today to see the day.</p>` : ''}
      ${run ? `<p>Last checked ${e(new Date(run.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))} · ${e(RUN_MODE[run.mode] ?? run.mode)} · ${e(RUN_STATE[run.state] ?? run.state)}</p>${sent?.text ? `<details><summary>What it sent</summary><p class="sd-sent">${e(sent.text)}</p></details>` : ''}` : '<p>No agenda has been sent yet.</p>'}`;
    const details = results.querySelector('details');
    if (details) details.open = open;
    if (heldSummary) (details?.querySelector('summary') ?? notice).focus({ preventScroll: true });
  };

  const write = async (kind: 'save' | 'send') => {
    if (busy || disposed || !agenda) return;
    const wanted = kind === 'save' ? settings() : undefined;
    if (wanted) { dirty = true; unconfirmedSave = true; }
    // Retire older reads before starting a write, including their errors.
    generation += 1;
    const owner = controls.find(control => control === doc.activeElement);
    let reading = false;
    lock(true);
    retry.hidden = true;
    message(kind === 'save' ? 'Saving…' : 'Checking what is on…');
    if (owner) notice.focus({ preventScroll: true });
    try {
      if (wanted) await opts.save(wanted);
      else await opts.sendNow();
      if (disposed) return;
      reading = true;
      const next = await opts.read();
      if (disposed) return;
      adopt(next);
      unconfirmedSave = false;
      if (wanted && !sameSettings(wanted, next.settings)) {
        paint();
        throw new Error('The agenda settings could not be confirmed. Your edits are still here. Try saving again.');
      }
      if (wanted) dirty = false;
      paint();
      message(kind === 'save' ? 'Agenda settings saved.' : 'Checked. An agenda is sent only when something is on.');
    } catch (error) {
      if (!disposed) {
        message(error instanceof Error ? error.message : String(error), true);
        // Retry reloads settings and results; it never repeats a completed action.
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
  frequency.addEventListener('change', syncFields);
  weekday.addEventListener('change', syncFields);
  weekday.addEventListener('blur', syncFields);
  time.addEventListener('blur', () => {
    if (!disposed && !busy && !dirty && agenda && !time.validity.badInput && time.value !== agenda.settings.time) time.value = agenda.settings.time;
  });
  form.addEventListener('submit', event => { event.preventDefault(); void write('save'); });
  sendButton.addEventListener('click', () => { void write('send'); });

  const refresh = async () => {
    if (disposed || busy) return;
    const ownGeneration = ++generation;
    const hadStatus = agenda !== undefined;
    const retryOwned = doc.activeElement === retry;
    retry.hidden = true;
    message(hadStatus ? 'Refreshing agenda settings…' : 'Loading agenda settings…');
    if (retryOwned) notice.focus({ preventScroll: true });
    try {
      const next = await opts.read();
      if (disposed || ownGeneration !== generation) return;
      adopt(next);
      unconfirmedSave = false;
      paint();
      message(hadStatus ? 'Agenda settings updated.' : '');
    } catch (error) {
      if (disposed || ownGeneration !== generation) return;
      // An older server has no Agenda. A later failure keeps a draft already being edited
      // rather than removing its form.
      if (!agenda && classifyRpcError(error).code === 'unknown_method') { leave(); return; }
      root.hidden = false;
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

/** Injected once by the settings route, beside the Digest's: the same card, under its own attribute.
 *  ⚠ The card itself starts `hidden` until a server says it has an Agenda, and the card's own
 *  `display: flex` would otherwise show it: the shared sheet hides only what is inside a card. */
export const AGENDA_PANEL_STYLES = `${deliveryCardStyles(AGENDA_PANEL_ATTR, {
  message: 'data-agenda-message', retry: 'data-agenda-retry', results: 'data-agenda-results' })}
[${AGENDA_PANEL_ATTR}][hidden] {
  display: none !important;
}
`;
