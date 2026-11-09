import {
  getMessengerVendorDeclaration, MESSENGER_VENDOR_SLUGS,
  type NotificationChannelToggleView, type NotificationDeliveryChannel, type SituationAgendaStatus, type SituationCloseDaySettings,
  type SituationDigestLookAhead, type SituationStreamKind, type SituationStreamPreview, type SituationStreamSettings, type SituationStreamStatus,
} from '@recued/contracts';
import { e } from '@recued/ui-shared';
import { classifyRpcError } from '../shell/rpc-error-copy.js';
import { agendaWeekChoices } from '../settings/agenda-panel.js';
import { CLOSE_DAY_PANEL_STYLES, mountCloseDayPanel } from '../settings/close-day-panel.js';
import { deliveryCardStyles, nextDigestText } from '../settings/situation-delivery-panel.js';

export const STREAM_PANEL_ATTR = 'data-today-stream';
export const STREAM_DIALOG_ATTR = 'data-today-stream-dialog';

/** A channel the owner set up, as Send to offers it. */
export interface StreamChannel { channel: NotificationDeliveryChannel; label: string }

/** D-340 slice 2 (§3.1, §3.7, ruling 11) — the streams' settings on Today: Daily and Weekly tabs,
 *  each its own schedule, with its parts, the channels it goes to, Save and Send now, and a preview
 *  of its next message with its full text on request (ruling 10). Close the day sits under the tabs
 *  (D-343 §3.1). It reads the Agenda's status (`yours.agenda`), which names the streams on a server
 *  that keeps them. */
export interface StreamPanelOptions {
  host: HTMLElement; document?: Document;
  read: () => Promise<SituationAgendaStatus>;
  save: (stream: SituationStreamKind, settings: Partial<SituationStreamSettings>) => Promise<unknown>;
  sendNow: (stream: SituationStreamKind) => Promise<unknown>;
  preview: (stream: SituationStreamKind) => Promise<SituationStreamPreview>;
  /** The channels set up, for Send to. One that cannot be read leaves only "Every channel". */
  channels: () => Promise<StreamChannel[]>;
  closeDay?: { save: (settings: SituationCloseDaySettings) => Promise<unknown>; sendNow: () => Promise<unknown> };
}

const KINDS = ['daily', 'weekly'] as const;
const TAB_NAMES: Readonly<Record<SituationStreamKind, string>> = { daily: 'Daily', weekly: 'Weekly' };
const SEND_ME: Readonly<Record<SituationStreamKind, string>> = { daily: 'Send me my day', weekly: 'Send me my week' };
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
const LOOK_AHEAD: ReadonlyArray<SituationDigestLookAhead> = [2, 3, 7, 14];
const RUN_MODE: Readonly<Record<string, string>> = { stream: 'Daily', stream_manual: 'Send now', stream_week: 'Weekly', stream_week_manual: 'Send now' };
const RUN_STATE: Readonly<Record<string, string>> = {
  sent: 'Sent', skipped: 'Nothing on, so nothing was sent', pending: 'Waiting to retry', sending: 'Sending',
  uncertain: 'Delivery not confirmed', superseded: 'Not sent: a newer one replaced it',
};
const LEDE = 'One message at your time, holding the parts you check, sent to the channels you pick. Today, here in the app, '
  + 'shows everything whatever is checked.';

/** Send to's choices (ruling 7): each channel that is set up and has Notify on, named as Settings
 *  names it, and the app's cards as "The app". The Browser Bridge shows alerts on the desktop and
 *  takes no message. */
export const streamChannelsOf = (rows: readonly NotificationChannelToggleView[]): StreamChannel[] => rows.flatMap((row): StreamChannel[] => {
  if (!row.notification || !row.ready) return [];
  if (row.channel === 'ui') return [{ channel: 'in_app', label: 'The app' }];
  if (row.channel === 'email') return [{ channel: 'email', label: 'Email' }];
  const vendor = MESSENGER_VENDOR_SLUGS.find(slug => slug === row.channel);
  return vendor ? [{ channel: vendor, label: getMessengerVendorDeclaration(vendor)?.display_name ?? vendor }] : [];
});
/** "3 agenda items, 1 coming up": what each part holds now; nothing when there is nothing to send. */
export const streamCountsText = (counts: SituationStreamPreview['counts']): string => {
  const parts = [
    counts.states ? `${counts.states} that ${counts.states === 1 ? 'holds' : 'hold'} today` : '',
    // D-340 slice 4 — the AI suggestions, under what holds, when they finished before it goes.
    counts.suggestions ? 'AI suggestions' : '',
    counts.agenda ? `${counts.agenda} agenda ${counts.agenda === 1 ? 'item' : 'items'}` : '',
    counts.due_today ? `${counts.due_today} due` : '',
    counts.reminders ? `${counts.reminders} ${counts.reminders === 1 ? 'reminder' : 'reminders'}` : '',
    counts.coming_up ? `${counts.coming_up} coming up` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'nothing to send yet';
};

export const mountStreamPanel = (opts: StreamPanelOptions) => {
  const doc = opts.document ?? document;
  const root = doc.createElement('section');
  root.setAttribute(STREAM_PANEL_ATTR, '');
  opts.host.appendChild(root);
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, parent: HTMLElement = root, className?: string) => {
    const element = doc.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className !== undefined) element.className = className;
    parent.appendChild(element);
    return element;
  };
  node('p', LEDE, root, 'sd-lede');
  const tablist = node('div', undefined, root, 'stream-tabs');
  tablist.setAttribute('role', 'tablist');
  tablist.setAttribute('aria-label', 'Streams');
  const notice = node('p');
  notice.setAttribute('data-stream-message', '');
  notice.setAttribute('role', 'status');
  notice.setAttribute('tabindex', '-1');
  const retry = node('button', 'Retry', root, 'rx-btn rx-btn-secondary rx-btn-sm');
  retry.type = 'button';
  retry.setAttribute('data-stream-retry', '');
  retry.hidden = true;
  let status: SituationAgendaStatus['streams'];
  let channels: StreamChannel[] = [];
  let selected: SituationStreamKind = 'daily';
  let disposed = false;
  let busy = false;
  let generation = 0;
  const message = (text: string, error = false) => {
    notice.textContent = text;
    notice.setAttribute('role', error ? 'alert' : 'status');
  };

  /** One tab: its button, and the form it shows. */
  const tab = (kind: SituationStreamKind) => {
    const button = node('button', TAB_NAMES[kind], tablist, 'stream-tab');
    button.type = 'button';
    button.id = `stream-tab-${kind}`;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', `stream-${kind}`);
    button.setAttribute('data-stream-tab', kind);
    const form = doc.createElement('form');
    form.id = `stream-${kind}`;
    form.setAttribute('role', 'tabpanel');
    form.setAttribute('aria-labelledby', button.id);
    form.setAttribute('data-stream-form', kind);
    root.insertBefore(form, notice);
    const check = (name: string, label: string, parent: HTMLElement = form) => {
      const wrap = node('label', undefined, parent, 'sd-check');
      const input = node('input', undefined, wrap);
      input.type = 'checkbox'; input.name = name;
      input.setAttribute('aria-label', label);
      node('span', label, wrap);
      return input;
    };
    const fields = node('div', undefined, form, 'sd-fields');
    const field = (label: string) => { const wrap = node('label', undefined, fields, 'sd-field'); node('span', label, wrap); return wrap; };
    const select = (name: string, label: string, choices: ReadonlyArray<readonly [string, string]>, parent?: HTMLElement) => {
      const control = node('select', undefined, parent ?? field(label), 'rx-select');
      control.name = name; control.setAttribute('aria-label', label);
      for (const [value, text] of choices) node('option', text, control).value = value;
      return control;
    };
    const enabled = check('enabled', SEND_ME[kind]);
    form.insertBefore(enabled.parentElement!, fields);
    const weekday = kind === 'weekly' ? select('weekday', 'Day', WEEKDAYS.map((name, index) => [String(index + 1), name] as const)) : undefined;
    const day = select('day', kind === 'weekly' ? 'Which days' : 'Which day', kind === 'weekly' ? agendaWeekChoices(1) : [['today', 'Today'], ['tomorrow', 'Tomorrow']]);
    const time = node('input', undefined, field('Time'), 'rx-input');
    time.type = 'time'; time.name = 'time'; time.required = true;
    time.setAttribute('aria-label', 'Time');
    const parts = node('fieldset', undefined, form, 'stream-parts');
    node('legend', 'In it', parts);
    const agenda = check('agenda', 'Agenda', parts);
    node('p', kind === 'weekly' ? 'The seven days in time order, a day at a time.' : 'The day in time order, recurring events included.', parts, 'sd-hint');
    const suggestions = check('suggestions', 'AI suggestions', parts);
    node('p', 'After it goes, Recued’s AI looks the Agenda over and sends suggestions, such as clashes and what to prepare.', parts, 'sd-hint');
    const comingUp = check('coming_up', 'Coming up', parts);
    const ahead = select('look_ahead_days', 'Looks ahead', LOOK_AHEAD.filter(days => kind === 'daily' || days >= 7)
      .map(days => [String(days), `${days} days`] as const), node('label', undefined, parts, 'sd-field stream-ahead'));
    ahead.parentElement!.insertBefore(node('span', 'Looks ahead'), ahead);
    // D-340 slice 3 (§3.1) — the day's reminders inside the message, in a daily stream that lists today.
    const remindersBox = kind === 'daily' ? check('reminders', 'Reminders from Yours', parts) : undefined;
    const remindersHint = kind === 'daily' ? node('p', 'The reminders due that day, each with its buttons, in this message instead of one by '
      + 'one. Urgent ones, and those for things you share with your household, still go at once.', parts, 'sd-hint') : undefined;
    const dueToday = kind === 'daily' ? check('due_today', 'Due today', parts) : undefined;
    const dueHint = kind === 'daily' ? node('p', 'What is due that day, on a day with no Agenda or reminders in it.', parts, 'sd-hint') : undefined;
    // D-340 slice 5 (§3.4) — one switch for every part, in every channel it goes to.
    const privateItems = check('include_private', 'Include private items', parts);
    const privateHint = node('p', `Private items, such as how you slept or a passport’s expiry, will be named in the channels this goes to${
      kind === 'daily' ? ', Close the day included' : ''}.`, parts, 'sd-hint');
    const sendTo = node('fieldset', undefined, form, 'stream-channels');
    node('legend', 'Send to', sendTo);
    const radio = (value: 'all' | 'some', label: string) => {
      const wrap = node('label', undefined, sendTo, 'sd-check');
      const input = node('input', undefined, wrap);
      input.type = 'radio'; input.name = `send_to_${kind}`; input.value = value;
      node('span', label, wrap);
      return input;
    };
    const everyChannel = radio('all', 'Every channel you set up');
    const someChannels = radio('some', 'Only these');
    const channelList = node('div', undefined, sendTo, 'stream-channel-list');
    channelList.setAttribute('data-stream-channels', '');
    const actions = node('div', undefined, form, 'sd-actions');
    const save = node('button', 'Save', actions, 'rx-btn rx-btn-secondary rx-btn-sm');
    save.type = 'submit';
    const sendNow = node('button', 'Send now', actions, 'rx-btn rx-btn-secondary rx-btn-sm');
    sendNow.type = 'button';
    sendNow.setAttribute('data-stream-send-now', '');
    const preview = node('div', undefined, form, 'stream-preview');
    preview.setAttribute('data-stream-preview', '');
    const next = node('p', undefined, preview);
    next.setAttribute('data-stream-next', '');
    const full = node('details', undefined, preview);
    node('summary', 'Show the full text', full);
    const text = node('p', undefined, full, 'sd-sent');
    text.setAttribute('data-stream-text', '');
    const results = node('div', undefined, form);
    results.setAttribute('data-stream-results', '');
    let dirty = false;
    let boxes: HTMLInputElement[] = [];
    const current = (): SituationStreamStatus | undefined => status?.[kind];
    /** A part the server names: one before it offers none (D-338's compatibility rule). */
    const named = (key: keyof SituationStreamSettings): boolean => { const saved = current()?.settings; return saved !== undefined && key in saved; };
    const reminding = (): boolean => remindersBox !== undefined && named('reminders') && day.value === 'today' && remindersBox.checked;
    const draft = (): SituationStreamSettings => ({ enabled: enabled.checked, time: time.value, day: day.value as 'today' | 'tomorrow',
      weekday: weekday ? Number(weekday.value) : current()?.settings.weekday ?? 1, agenda: agenda.checked, coming_up: comingUp.checked,
      look_ahead_days: Number(ahead.value) as SituationDigestLookAhead, suggestions: agenda.checked && suggestions.checked,
      due_today: dueToday ? !agenda.checked && !reminding() && dueToday.checked : false, include_private: privateItems.checked,
      reminders: reminding(),
      channels: everyChannel.checked ? null : boxes.filter(box => box.checked).map(box => box.value as NotificationDeliveryChannel) });
    /** Only what the owner changed, and only what the server names, so a save keeps what it holds of
     *  the rest and an older server is sent nothing it does not know. */
    const changes = (): Partial<SituationStreamSettings> => {
      const saved = current()?.settings; const next = draft();
      if (!saved) return next;
      return Object.fromEntries(Object.entries(next).filter(([key, value]) => key in saved
        && JSON.stringify(value) !== JSON.stringify(saved[key as keyof SituationStreamSettings])));
    };
    const shape = () => {
      // AI suggestions come with the Agenda; Due today is for a day with none.
      suggestions.disabled = busy || !agenda.checked;
      suggestions.parentElement!.hidden = !agenda.checked; suggestions.parentElement!.nextElementSibling!.toggleAttribute('hidden', !agenda.checked);
      ahead.disabled = busy || !comingUp.checked;
      // Reminders go in a stream that lists their day; Due today is for a day with neither the Agenda
      // nor them.
      if (remindersBox && remindersHint) {
        const offered = named('reminders') && day.value === 'today';
        remindersBox.parentElement!.hidden = !offered; remindersHint.hidden = !offered; remindersBox.disabled = busy || !offered;
      }
      if (dueToday && dueHint) { dueToday.parentElement!.hidden = agenda.checked || reminding(); dueHint.hidden = agenda.checked || reminding(); }
      privateItems.parentElement!.hidden = !named('include_private'); privateHint.hidden = !named('include_private');
      channelList.hidden = !someChannels.checked;
      if (weekday) for (const [index, [value, words]] of agendaWeekChoices(Number(weekday.value)).entries()) {
        const option = day.options[index]; if (option) { option.value = value; option.textContent = words; }
      }
    };
    const paintChannels = (chosen: readonly string[] | null) => {
      channelList.textContent = '';
      boxes = channels.map(({ channel, label }) => {
        const box = check('channel', label, channelList);
        box.value = channel; box.checked = chosen === null || chosen.includes(channel);
        return box;
      });
      // A channel it was set to that is no longer set up still shows, so a save does not drop it unseen.
      for (const channel of chosen ?? []) if (!channels.some(row => row.channel === channel)) {
        const box = check('channel', channel, channelList); box.value = channel; box.checked = true; boxes.push(box);
      }
    };
    const paint = () => {
      const row = current(); if (!row || disposed) return;
      button.textContent = `${TAB_NAMES[kind]} · ${row.settings.enabled ? 'On' : 'Off'}`;
      if (dirty && JSON.stringify(changes()) === '{}') dirty = false;
      if (!dirty) {
        const saved = row.settings;
        enabled.checked = saved.enabled; agenda.checked = saved.agenda; comingUp.checked = saved.coming_up;
        suggestions.checked = saved.suggestions; ahead.value = String(saved.look_ahead_days);
        if (dueToday) dueToday.checked = saved.due_today;
        privateItems.checked = saved.include_private === true;
        if (remindersBox) remindersBox.checked = saved.reminders === true;
        if (weekday) weekday.value = String(saved.weekday);
        day.value = saved.day;
        // A focused time control holds an incomplete segment outside `value`: it is left be.
        if (doc.activeElement !== time && time.value !== saved.time) time.value = saved.time;
        everyChannel.checked = saved.channels === null; someChannels.checked = saved.channels !== null;
        paintChannels(saved.channels);
      }
      shape();
      const { last_run: run, last_sent: sent } = row;
      results.innerHTML = `${run ? `<p>Last sent ${e(new Date(run.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))} · ${e(RUN_MODE[run.mode] ?? run.mode)} · ${e(RUN_STATE[run.state] ?? run.state)}</p>${sent?.text ? `<details><summary>What it sent</summary><p class="sd-sent">${e(sent.text)}</p></details>` : ''}` : '<p>Nothing has been sent yet.</p>'}`;
    };
    const showPreview = async () => {
      const own = generation;
      try {
        const got = await opts.preview(kind);
        if (disposed || own !== generation) return;
        next.textContent = `${got.next_at !== undefined ? `Next: ${nextDigestText(got.next_at, got.time_zone)}` : 'Off. If it went now'} · ${streamCountsText(got.counts)}`;
        text.textContent = got.text || 'Nothing to send right now.';
        full.hidden = false;
      } catch {
        if (disposed || own !== generation) return;
        next.textContent = 'Recued could not preview it just now.'; full.hidden = true;
      }
    };
    const controls = () => [enabled, time, day, ...weekday ? [weekday] : [], agenda, suggestions, comingUp, ahead,
      ...remindersBox ? [remindersBox] : [], ...dueToday ? [dueToday] : [], privateItems, everyChannel, someChannels, ...boxes, save, sendNow];
    const lock = (value: boolean) => { busy = value; for (const control of controls()) control.disabled = value; if (!value) shape(); };
    const write = async (what: 'save' | 'send') => {
      if (busy || disposed || !current()) return;
      const patch = what === 'save' ? changes() : undefined;
      if (patch && everyChannel.checked === false && boxes.every(box => !box.checked)) {
        message('Pick a channel, or send it to every channel you set up.', true); return;
      }
      generation += 1;
      const owner = controls().find(control => control === doc.activeElement);
      lock(true); retry.hidden = true;
      message(what === 'save' ? 'Saving…' : 'Sending…');
      if (owner) notice.focus({ preventScroll: true });
      let reading = false;
      try {
        if (patch) { if (Object.keys(patch).length) await opts.save(kind, patch); }
        else await opts.sendNow(kind);
        if (disposed) return;
        reading = true;
        const read = await opts.read();
        if (disposed) return;
        status = read.streams;
        if (patch) dirty = false;
        paint();
        message(what === 'save' ? `${TAB_NAMES[kind]} stream saved.` : 'Checked. It is sent only when something is on.');
        void showPreview();
      } catch (error) {
        if (!disposed) { message(error instanceof Error ? error.message : String(error), true); retry.hidden = !reading; }
      } finally {
        if (!disposed) { lock(false); if (doc.activeElement === notice) owner?.focus({ preventScroll: true }); }
      }
    };
    const edited = () => { if (!disposed && !busy) { dirty = JSON.stringify(changes()) !== '{}' || time.validity.badInput; shape(); } };
    form.addEventListener('input', edited);
    form.addEventListener('change', edited);
    form.addEventListener('submit', event => { event.preventDefault(); void write('save'); });
    sendNow.addEventListener('click', () => { void write('send'); });
    /** The channels arrived after the settings: Send to lists them, keeping what is picked. */
    const channelsArrived = () => {
      if (disposed) return;
      paintChannels(everyChannel.checked ? null : boxes.filter(box => box.checked).map(box => box.value));
      if (busy) for (const box of boxes) box.disabled = true;
    };
    return { kind, button, form, paint, showPreview, channelsArrived, dirty: () => dirty || time.validity.badInput };
  };
  const tabs = KINDS.map(tab);
  const choose = (kind: SituationStreamKind, focus = false) => {
    selected = kind;
    for (const one of tabs) {
      const on = one.kind === kind;
      one.button.setAttribute('aria-selected', String(on)); one.button.tabIndex = on ? 0 : -1; one.form.hidden = !on;
    }
    if (focus) tabs.find(one => one.kind === kind)!.button.focus();
    void tabs.find(one => one.kind === kind)!.showPreview();
  };
  for (const one of tabs) {
    one.button.addEventListener('click', () => { choose(one.kind); });
    // Arrow keys move between the tabs, as a tab list does.
    one.button.addEventListener('keydown', event => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
      event.preventDefault(); choose(one.kind === 'daily' ? 'weekly' : 'daily', true);
    });
  }
  const closeDayHost = node('div', undefined, root, 'stream-close-day');
  const closeDay = opts.closeDay ? mountCloseDayPanel({ host: closeDayHost, document: doc, read: opts.read, ...opts.closeDay, onToday: true }) : null;

  const refresh = async () => {
    if (disposed || busy) return;
    const own = ++generation;
    retry.hidden = true;
    message(status ? 'Refreshing…' : 'Loading…');
    // Send to's channels come on their own: a list that is slow, or cannot be read, holds nothing up.
    void opts.channels().then(set => {
      if (disposed || own !== generation) return;
      channels = set; for (const one of tabs) one.channelsArrived();
    }, () => {});
    try {
      const read = await opts.read();
      if (disposed || own !== generation) return;
      if (!read.streams) { message('Your Recued server needs an update to keep a daily stream.', true); return; }
      status = read.streams;
      for (const one of tabs) one.paint();
      message('');
      choose(selected);
    } catch (error) {
      if (disposed || own !== generation) return;
      message(classifyRpcError(error).code === 'unknown_method' ? 'Your Recued server needs an update to keep a daily stream.'
        : error instanceof Error ? error.message : String(error), true);
      retry.hidden = false;
    }
  };
  retry.addEventListener('click', () => { void refresh(); });
  choose('daily');
  void refresh();
  return {
    refresh,
    hasInFlightWork: () => !disposed && (busy || closeDay?.hasInFlightWork() === true),
    hasUnsavedChanges: () => !disposed && (tabs.some(one => one.dirty()) || closeDay?.hasUnsavedChanges() === true),
    dispose() { disposed = true; generation += 1; closeDay?.dispose(); root.remove(); },
  };
};

/** Opened from Today's "Daily stream" (§3.7): the panel in a dialog over Today, so Today's own
 *  repaints never touch it. Closing with changes not saved says so once; a second Close discards them. */
export const openStreamDialog = (doc: Document, opts: Omit<StreamPanelOptions, 'host' | 'document'>, onClose?: () => void) => {
  const dialog = doc.createElement('dialog');
  dialog.setAttribute(STREAM_DIALOG_ATTR, '');
  dialog.setAttribute('aria-labelledby', 'stream-dialog-title');
  const header = doc.createElement('div'); header.className = 'stream-dialog-header';
  const title = doc.createElement('h2'); title.id = 'stream-dialog-title'; title.textContent = 'Daily stream';
  const done = doc.createElement('button'); done.type = 'button'; done.className = 'rx-btn rx-btn-secondary rx-btn-sm'; done.textContent = 'Close';
  done.setAttribute('data-stream-close', '');
  header.append(title, done);
  const warning = doc.createElement('p'); warning.setAttribute('role', 'alert'); warning.hidden = true;
  warning.textContent = 'Your changes are not saved. Save them, or Close again to leave without them.';
  const host = doc.createElement('div');
  dialog.append(header, warning, host);
  const panel = mountStreamPanel({ host, document: doc, ...opts });
  let closed = false;
  const close = (force = false) => {
    if (closed) return;
    if (!force && warning.hidden && panel.hasUnsavedChanges()) { warning.hidden = false; return; }
    closed = true; panel.dispose(); if (dialog.open) dialog.close(); dialog.remove(); onClose?.();
  };
  done.addEventListener('click', () => { close(); });
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  doc.body.append(dialog);
  dialog.showModal();
  return { close, panel, dialog };
};

export const STREAM_PANEL_STYLES = `${deliveryCardStyles(STREAM_PANEL_ATTR, { message: 'data-stream-message', retry: 'data-stream-retry', results: 'data-stream-results' })}
${CLOSE_DAY_PANEL_STYLES}
[${STREAM_PANEL_ATTR}] { border: 0; padding: 0; }
[${STREAM_PANEL_ATTR}] .stream-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); }
[${STREAM_PANEL_ATTR}] .stream-tab { min-height: 36px; padding: 6px 14px; border: 1px solid transparent; border-bottom: 0;
  border-radius: 6px 6px 0 0; background: none; color: var(--fg-muted); font: inherit; font-weight: 600; cursor: pointer; }
[${STREAM_PANEL_ATTR}] .stream-tab[aria-selected="true"] { border-color: var(--border); background: var(--bg); color: var(--fg); margin-bottom: -1px; }
[${STREAM_PANEL_ATTR}] .stream-tab:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
[${STREAM_PANEL_ATTR}] fieldset { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; margin: 0; padding: 0; border: 0; min-width: 0; }
[${STREAM_PANEL_ATTR}] legend { padding: 0; margin-bottom: 4px; font-size: 12px; font-weight: 600; color: var(--fg-muted); }
[${STREAM_PANEL_ATTR}] .stream-channel-list { display: flex; flex-wrap: wrap; gap: 4px 16px; padding-left: 24px; }
[${STREAM_PANEL_ATTR}] .stream-preview { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--fg-muted); }
[${STREAM_PANEL_ATTR}] .stream-close-day { margin-top: 8px; }
@media (max-width: 640px) { [${STREAM_PANEL_ATTR}] .stream-tab { min-height: 44px; } }
dialog[${STREAM_DIALOG_ATTR}] { box-sizing: border-box; width: min(720px, calc(100vw - 32px)); max-height: calc(100dvh - 48px); padding: 16px 20px 20px;
  border: 1px solid var(--border); border-radius: 10px; background: var(--bg); color: var(--fg); overflow: auto; }
dialog[${STREAM_DIALOG_ATTR}]::backdrop { background: #0008; }
dialog[${STREAM_DIALOG_ATTR}] .stream-dialog-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
dialog[${STREAM_DIALOG_ATTR}] .stream-dialog-header h2 { margin: 0; font-size: 18px; }
dialog[${STREAM_DIALOG_ATTR}] > p[role="alert"] { margin: 0 0 8px; color: var(--danger); }
@media (max-width: 600px) { dialog[${STREAM_DIALOG_ATTR}] { width: 100vw; max-width: none; height: 100dvh; max-height: none; margin: 0; border: 0; border-radius: 0; } }
`;
