import { REMINDER_TEXT_MAX, readReminderMailReference, readReminderRecordReference, sameReminderMailReference, sameReminderRecordReference,
  type ReminderCreateRequest, type ReminderRecordReference, type ReminderMailReference, type ReminderCreateResult } from '@recued/contracts';
import { stampZone } from '@recued/ui-shared';
import { formatReminderTimePreview, reminderTimePreset, reminderWallClockValue } from './reminder-time.js';
import { classifyRpcError, humanizeRpcError } from '../shell/rpc-error-copy.js';
import { createReminderDraftCheckpoint, reminderDraftAt, reminderDraftSource, reminderDraftText,
  type ReminderDraftEntry, type ReminderDraftValues, type ReminderRecoveryStore } from './reminder-draft-recovery.js';

/** Shared creation and recovery for reminders, linked records and alarms. */
export const mountReminderCreateForm = (options: {
  host: HTMLElement; kind?: 'alarm' | 'reminder'; now?: () => number;
  create: (args: ReminderCreateRequest) => Promise<ReminderCreateResult>;
  timeZone?: () => string | undefined; recovery?: ReminderRecoveryStore;
  onClose: (result?: ReminderCreateResult, keptId?: string) => void;
}) => {
  const { host } = options, doc = host.ownerDocument, now = options.now ?? Date.now;
  let active = false, busy = false, disposed = false, needsCheck = false;
  let values: ReminderDraftValues | null = null;
  let readFields: (() => void) | undefined;
  const checkpoint = createReminderDraftCheckpoint({ store: options.recovery, now, changed: () => {
    const status = host.querySelector('[data-reminder-recovery-status]'); if (status) status.textContent = checkpoint.message();
  } });
  const capture = () => { if (values && !needsCheck) { readFields?.(); checkpoint.capture(values); } };
  const flush = () => { capture(); return checkpoint.flush(); };
  const close = (result?: ReminderCreateResult, keptId?: string) => {
    checkpoint.suspend(); active = false; values = null; needsCheck = false; readFields = undefined; host.replaceChildren(); options.onClose(result, keptId);
  };
  const mount = (focus = true) => {
    const draft = values!, alarm = draft.kind === 'alarm';
    const form = doc.createElement('form'); form.dataset.reminderCreateForm = '';
    if (alarm) form.dataset.automationAlarmForm = '';
    const heading = doc.createElement('h3'); heading.textContent = alarm ? 'Alarm details' : draft.fromHistory ? 'Remind again' : 'New reminder'; form.append(heading);
    const intro = doc.createElement('p'); intro.textContent = draft.fromHistory
      ? 'Create a new one-off reminder. The original stays in history. Your notification settings and quiet hours apply.'
      : 'Send yourself a one-off reminder at the chosen time. It follows your notification settings and quiet hours.'; form.append(intro);
    const source = reminderDraftSource(draft);
    if (source) { const link = doc.createElement('a'); link.href = source.href; link.textContent = source.label; form.append(link); }
    if (options.recovery) {
      const status = doc.createElement('p'); status.setAttribute('role', 'status'); status.dataset.reminderRecoveryStatus = '';
      status.textContent = checkpoint.message(); form.append(status);
    }
    const field = (label: string, input: HTMLTextAreaElement | HTMLInputElement) => {
      const wrapper = doc.createElement('label'), caption = doc.createElement('span'); caption.textContent = label;
      wrapper.append(caption, input); form.append(wrapper);
    };
    const message = doc.createElement('textarea'); message.required = true; message.maxLength = REMINDER_TEXT_MAX; message.rows = 3;
    message.value = draft.text; field(alarm ? 'Alarm message' : 'Reminder', message);
    const time = doc.createElement('input'); time.type = 'datetime-local'; time.required = true; time.value = draft.time;
    readFields = () => {
      if (busy || needsCheck) return;
      draft.text = message.value;
      if (draft.time !== time.value) { draft.time = time.value; draft.chosenAt = null; draft.chosenAt = reminderDraftAt(draft); }
    };
    field(`Date and time (${draft.zone})`, time);
    const preview = doc.createElement('p'); preview.setAttribute('role', 'status');
    if (draft.chosenAt !== null) preview.textContent = formatReminderTimePreview(draft.chosenAt, draft.zone);
    const error = doc.createElement('p'); error.setAttribute('role', 'alert');
    if (needsCheck) error.textContent = 'This save was interrupted. Check its original request before creating another reminder.';
    form.append(error);
    const presets: HTMLButtonElement[] = [];
    if (draft.mail_ref) {
      const choices = doc.createElement('div'); choices.className = 'reminder-create-actions';
      choices.setAttribute('role', 'group'); choices.setAttribute('aria-label', 'Choose a reminder time');
      for (const [key, label] of [['15-minutes', 'In 15 minutes'], ['tomorrow-9', 'Tomorrow at 9am']] as const) {
        const button = doc.createElement('button'); button.type = 'button'; button.className = 'data-button'; button.textContent = label;
        button.addEventListener('click', () => {
          if (busy || needsCheck) return;
          try {
            const chosen = reminderTimePreset(key, now(), draft.zone); time.value = draft.time = chosen.value; draft.chosenAt = chosen.at;
            preview.textContent = formatReminderTimePreview(chosen.at, draft.zone); error.textContent = ''; capture();
          } catch (cause) { error.textContent = humanizeRpcError(cause); }
        });
        choices.append(button); presets.push(button);
      }
      const custom = doc.createElement('button'); custom.type = 'button'; custom.className = 'data-button'; custom.textContent = 'Choose date and time';
      custom.addEventListener('click', () => time.focus()); choices.append(custom); presets.push(custom); form.append(choices);
    }
    form.append(preview);
    const actions = doc.createElement('div'); actions.className = 'reminder-create-actions automation-alarm-actions';
    const save = doc.createElement('button'); save.type = 'submit'; save.className = alarm ? 'data-button automation-button automation-button--primary' : 'data-button';
    const keep = options.recovery ? doc.createElement('button') : undefined;
    if (keep) {
      keep.type = 'button'; keep.className = alarm ? 'data-button automation-button' : 'data-button'; keep.textContent = 'Keep draft for later';
      keep.addEventListener('click', () => {
        if (busy || disposed) return;
        capture(); const id = checkpoint.id();
        if (!checkpoint.keepForLater()) { error.textContent = 'Your latest draft could not be confirmed in this tab. Keep this form open and try again.'; keep.focus(); return; }
        close(undefined, id);
      });
    }
    const cancel = doc.createElement('button'); cancel.type = 'button'; cancel.className = alarm ? 'data-button automation-button' : 'data-button'; cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => {
      if (busy || disposed) return;
      if (!checkpoint.discard()) { error.textContent = 'This recovery copy could not be discarded. Keep this form open and try again.'; cancel.focus(); return; }
      close();
    });
    actions.append(save); if (keep) actions.append(keep); actions.append(cancel); form.append(actions);
    const update = () => {
      form.setAttribute('aria-busy', String(busy));
      save.textContent = busy ? alarm ? 'Creating alarm…' : 'Setting reminder…' : needsCheck ? 'Check save' : alarm ? 'Create alarm' : 'Set reminder';
      for (const control of [message, time, ...presets]) control.disabled = busy || needsCheck;
      save.disabled = cancel.disabled = busy; if (keep) keep.disabled = busy;
      cancel.hidden = needsCheck && Boolean(options.recovery);
    };
    const input = (event: Event) => {
      if (busy || needsCheck || disposed) return;
      readFields?.();
      if (event.target === time) {
        preview.textContent = draft.chosenAt === null ? '' : formatReminderTimePreview(draft.chosenAt, draft.zone);
      }
      error.textContent = ''; capture();
    };
    form.addEventListener('input', input); form.addEventListener('change', input);
    form.addEventListener('submit', event => {
      event.preventDefault(); if (busy || disposed) return;
      let request = draft.request;
      if (!needsCheck) {
        readFields?.();
        const at = reminderDraftAt(draft), text = reminderDraftText(draft.text);
        if (at === null || at <= now()) { error.textContent = 'Choose a valid future date and time.'; time.focus(); return; }
        if (!text) { error.textContent = alarm ? 'Enter a message for your alarm.' : 'Enter a message for your reminder.'; message.focus(); return; }
        request = { text, at, creation_id: draft.creationId, ...(draft.record_ref ? { record_ref: draft.record_ref } : {}), ...(draft.mail_ref ? { mail_ref: draft.mail_ref } : {}) };
      }
      if (!request) return;
      draft.request = request;
      const ticket = checkpoint.startAttempt(draft);
      if (ticket?.blocked) {
        if (!needsCheck) draft.request = null;
        error.textContent = 'The save could not start because its recovery copy could not be updated. Keep this form open and try again.'; save.focus(); return;
      }
      const checking = needsCheck, sent = structuredClone(request);
      busy = true; error.textContent = ''; update();
      void (async () => {
        try {
          const result = await options.create(sent), row = result?.reminder;
          const record = readReminderRecordReference(row?.record_ref), mail = readReminderMailReference(row?.mail_ref);
          if (!row?.reminder_id || row.managed_by === 'clock' || row.text !== sent.text || row.at !== sent.at || !['pending', 'delivered', 'cancelled'].includes(row.state)
            || typeof result.confirmation !== 'string'
            || row.record_ref !== undefined && !record || row.mail_ref !== undefined && !mail
            || Boolean(sent.record_ref) !== Boolean(record) || Boolean(sent.mail_ref) !== Boolean(mail)
            || sent.record_ref && (!record || !sameReminderRecordReference(sent.record_ref, record))
            || sent.mail_ref && (!mail || !sameReminderMailReference(sent.mail_ref, mail))) throw new Error('The saved reminder could not be confirmed.');
          checkpoint.settle(ticket, 'confirmed');
          if (disposed) return;
          busy = false; close(result);
        } catch (failure) {
          const code = classifyRpcError(failure).code;
          const refused = !checking && code !== null && ['bad_request', 'invalid_args', 'forbidden', 'unauthorized', 'resource_changed', 'not_configured', 'unknown_method'].includes(code);
          checkpoint.settle(ticket, refused ? 'refused' : 'unknown');
          needsCheck = !refused; if (refused) draft.request = null;
          if (!disposed) {
            error.textContent = humanizeRpcError(failure) + (needsCheck ? ' Check this original save before creating another reminder. ' : ' ');
            const review = doc.createElement('a'); review.href = '#data/reminder'; review.textContent = alarm ? 'Review existing alarms' : 'Review existing reminders'; error.append(review);
          }
        } finally {
          busy = false; update();
          const focused = doc.activeElement;
          if (!disposed && active && form.isConnected && (!focused || focused === doc.body || form.contains(focused))) save.focus();
        }
      })();
    });
    host.replaceChildren(form); update(); if (focus) (needsCheck ? save : message).focus();
  };
  const open = (initial?: { text?: string; focus?: boolean; fromHistory?: boolean; record_ref?: ReminderRecordReference; mail_ref?: ReminderMailReference }) => {
    if (disposed || busy) return;
    if (active) { if (initial?.focus !== false) host.querySelector<HTMLElement>('textarea:not(:disabled), button')?.focus(); return; }
    const zone = stampZone(options.timeZone?.());
    values = { kind: options.kind ?? 'reminder', text: initial?.text ?? '', time: reminderWallClockValue(now() + 3600000, zone), zone, chosenAt: null,
      creationId: crypto.randomUUID(), fromHistory: initial?.fromHistory ?? false, request: null,
      ...(initial?.record_ref ? { record_ref: structuredClone(initial.record_ref) } : {}), ...(initial?.mail_ref ? { mail_ref: structuredClone(initial.mail_ref) } : {}) };
    values.chosenAt = reminderDraftAt(values); active = true; needsCheck = false;
    checkpoint.begin(values, undefined, Boolean(initial?.text || initial?.record_ref || initial?.mail_ref)); mount(initial?.focus !== false);
  };
  const resume = (id: string, expected?: ReminderDraftEntry): boolean => {
    if (disposed || busy || active || !options.recovery) return false;
    const entry = options.recovery.get(id);
    if (!entry || expected && JSON.stringify(entry) !== JSON.stringify(expected)) return false;
    values = structuredClone(entry.values); active = true; needsCheck = entry.status !== 'editing';
    checkpoint.begin(values, entry); mount(); return true;
  };
  const flushOnLeave = () => { if (!disposed) flush(); };
  doc.defaultView?.addEventListener('pagehide', flushOnLeave); doc.defaultView?.addEventListener('beforeunload', flushOnLeave);
  return { open, resume, flush, id: checkpoint.id, pending: () => busy, hasDraft: () => active,
    dispose() {
      flush(); checkpoint.suspend(); disposed = true;
      doc.defaultView?.removeEventListener('pagehide', flushOnLeave); doc.defaultView?.removeEventListener('beforeunload', flushOnLeave);
      host.remove();
    } };
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

export const REMINDER_RECOVERY_STYLES = `
.reminder-recoveries { margin:1rem 0; padding:1rem; border:1px solid var(--border); border-radius:.65rem; background:var(--surface); }
.reminder-recoveries h3,.reminder-recoveries h4 { margin:0 0 .5rem; overflow-wrap:anywhere; }
.reminder-recoveries p { margin:.5rem 0; overflow-wrap:anywhere; }
.reminder-recoveries article + article { border-top:1px solid var(--border); margin-top:1rem; padding-top:1rem; }
`;
