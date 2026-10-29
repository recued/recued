import { REMINDER_TEXT_MAX, zonedWallClockToEpochMs, type ReminderCreateResult } from '@recued/contracts';
import { stampZone } from '@recued/ui-shared';
import { reminderWallClockValue } from './reminder-time.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

/** One creation flow for Data reminders and Automation alarms. The draft survives host repaints. */
export const mountReminderCreateForm = (options: {
  host: HTMLElement;
  kind?: 'alarm' | 'reminder';
  now?: () => number;
  create: (args: { text: string; at: number; creation_id: string }) => Promise<ReminderCreateResult>;
  timeZone?: () => string | undefined;
  onClose: (result?: ReminderCreateResult) => void;
}) => {
  const { host } = options, doc = host.ownerDocument;
  const alarm = options.kind === 'alarm', now = options.now ?? Date.now;
  let active = false, busy = false, disposed = false;
  const open = () => {
    if (disposed || busy) return;
    if (active) { host.querySelector('textarea')?.focus(); return; }
    active = true;
    const creation_id = crypto.randomUUID();
    const zone = stampZone(options.timeZone?.());
    const form = doc.createElement('form'); form.dataset.reminderCreateForm = '';
    if (alarm) form.dataset.automationAlarmForm = '';
    const heading = doc.createElement('h3'); heading.textContent = alarm ? 'Alarm details' : 'New reminder'; form.append(heading);
    const intro = doc.createElement('p');
    intro.textContent = 'Send yourself a one-off reminder at the chosen time. It follows your notification settings and quiet hours.';
    form.append(intro);
    const field = (label: string, input: HTMLTextAreaElement | HTMLInputElement) => {
      const wrapper = doc.createElement('label'), caption = doc.createElement('span');
      caption.textContent = label; wrapper.append(caption, input); form.append(wrapper);
    };
    const message = doc.createElement('textarea'); message.required = true; message.maxLength = REMINDER_TEXT_MAX;
    message.rows = 3; field(alarm ? 'Alarm message' : 'Reminder', message);
    const time = doc.createElement('input'); time.type = 'datetime-local'; time.required = true;
    time.value = reminderWallClockValue(now() + 3600000, zone); field(`Date and time (${zone})`, time);
    const error = doc.createElement('p'); error.setAttribute('role', 'alert'); form.append(error);
    const actions = doc.createElement('div'); actions.className = 'reminder-create-actions automation-alarm-actions';
    const save = doc.createElement('button'); save.type = 'submit'; save.className = alarm ? 'automation-button automation-button--primary' : 'data-button'; save.textContent = alarm ? 'Create alarm' : 'Set reminder';
    const cancel = doc.createElement('button'); cancel.type = 'button'; cancel.className = alarm ? 'automation-button' : 'data-button'; cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => {
      if (busy) return;
      active = false; host.replaceChildren(); options.onClose();
    });
    actions.append(save, cancel); form.append(actions);
    form.addEventListener('submit', event => {
      event.preventDefault(); if (busy || disposed) return;
      const at = zonedWallClockToEpochMs(time.value, zone);
      if (at === null || reminderWallClockValue(at, zone) !== time.value || at <= now()) {
        error.textContent = 'Choose a valid future date and time.'; time.focus(); return;
      }
      if (!message.value.trim()) { error.textContent = alarm ? 'Enter a message for your alarm.' : 'Enter a message for your reminder.'; message.focus(); return; }
      busy = true; error.textContent = '';
      form.setAttribute('aria-busy', 'true'); save.textContent = alarm ? 'Creating alarm…' : 'Setting reminder…';
      for (const control of [message, time, save, cancel]) control.disabled = true;
      void (async () => {
        try {
          const result = await options.create({ text: message.value.trim(), at, creation_id });
          if (disposed) return;
          busy = false; active = false; host.replaceChildren(); options.onClose(result);
        } catch (failure) {
          if (!disposed) {
            error.textContent = humanizeRpcError(failure) + ' ';
            const review = doc.createElement('a'); review.href = '#data/reminder'; review.textContent = alarm ? 'Review existing alarms' : 'Review existing reminders'; error.append(review);
          }
        } finally {
          busy = false;
          form.setAttribute('aria-busy', 'false'); save.textContent = alarm ? 'Create alarm' : 'Set reminder';
          for (const control of [message, time, save, cancel]) control.disabled = false;
          const focused = doc.activeElement;
          if (!disposed && active && form.isConnected && (!focused || focused === doc.body || form.contains(focused))) save.focus();
        }
      })();
    });
    host.replaceChildren(form); message.focus();
  };
  return { open, pending: () => busy, hasDraft: () => active,
    dispose() { disposed = true; host.remove(); } };
};

export const REMINDER_CREATE_STYLES = `
[data-recued-reminders] [data-reminder-create-form] { display:flex; flex-direction:column; gap:1rem; padding:1rem; margin:1rem 0; border:1px solid var(--border); border-radius:.65rem; background:var(--surface); }
[data-recued-reminders] [data-reminder-create-form] h3 { margin:0; font-size:1.1rem; }
[data-recued-reminders] [data-reminder-create-form] p { margin:0; }
[data-recued-reminders] [data-reminder-create-form] label { display:flex; flex-direction:column; gap:.4rem; min-width:0; }
[data-recued-reminders] [data-reminder-create-form] input, [data-recued-reminders] [data-reminder-create-form] textarea { box-sizing:border-box; width:100%; padding:.65rem; border:1px solid var(--border); border-radius:.4rem; background:var(--surface); color:var(--fg); font:inherit; }
[data-recued-reminders] [data-reminder-create-form] [role=alert]:empty { display:none; }
[data-recued-reminders] [data-reminder-create-form] [role=alert] { color:var(--danger); }
[data-recued-reminders] .reminder-create-actions { display:flex; flex-wrap:wrap; gap:.5rem; }
`;
