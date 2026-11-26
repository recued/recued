import {
  zonedWallClockToEpochMs,
  mailFollowUpLabel, mailFollowUpAutomaticReplyNotice, type MailFollowUpList, type MailFollowUpAddress, type MailFollowUp, type MailFollowUpCursor, type MailFollowUpGet, type MailFollowUpPage,
  type MailFollowUpStart, type MailFollowUpReschedule, type MailFollowUpReplyTarget, type MailFollowUpReplyNotification, type ReminderMailReference,
  type MailFollowUpSendIntent,
} from '@recued/contracts';
import { e, stampZone } from '@recued/ui-shared';
import { classifyRpcError, humanizeRpcError } from '../shell/rpc-error-copy.js';
import { formatReminderTimePreview, reminderTimePreset, reminderWallClockValue } from '../reminders/reminder-time.js';
import { runSearchHref } from '../logs/run-search.js';
import { createMailFollowUpTaskPanel } from './mail-follow-up-task-panel.js';

export interface MailFollowUpCallers {
  tasks?: {
    get(args: { id: string }): Promise<import('@recued/contracts').MailFollowUpTaskView>;
    set(args: import('@recued/contracts').MailFollowUpTaskSet): Promise<MailFollowUp>;
    create?(args: import('@recued/contracts').MailFollowUpTaskCreate): Promise<MailFollowUp>;
    list(args: { tasks: import('@recued/contracts').MailFollowUpTaskRef[] }): Promise<import('@recued/contracts').MailFollowUpTaskLinks>;
    search(args: import('@recued/contracts').WorkEntitySearchRpcRequest): Promise<import('@recued/contracts').WorkEntitySearchRpcResponse>;
  };
  sends?: {
    get(args: { id: string }): Promise<MailFollowUpSendIntent | null>;
    cancel(args: { id: string; expected_revision: number }): Promise<MailFollowUpSendIntent>;
  };
  get(args: { mail_ref: ReminderMailReference }): Promise<MailFollowUpGet>;
  start(args: MailFollowUpStart): Promise<MailFollowUp>;
  check(args: { id: string }): Promise<MailFollowUp>;
  cancel(args: { id: string; expected_revision: number }): Promise<MailFollowUp>;
  reschedule(args: MailFollowUpReschedule): Promise<MailFollowUp>;
  createReplacement?(args: import('@recued/contracts').MailFollowUpReplacementCreate): Promise<MailFollowUp>;
  getDeliveryReport?(args: { id: string }): Promise<MailFollowUpReplyTarget>;
  getReply(args: { id: string }): Promise<MailFollowUpReplyTarget>;
  setReplyNotification(args: MailFollowUpReplyNotification): Promise<MailFollowUp>;
  list(args?: MailFollowUpList): Promise<MailFollowUpPage>;
}
const active = (watch: MailFollowUp): boolean => ['waiting', 'needs_attention', 'draft_ready'].includes(watch.state);
const watchLabel = mailFollowUpLabel;

/** This portal owns asynchronous work independently of the reader's repaints.
 * Drafts open in the existing governed composer; no send action runs here. */
export const createMailFollowUpSurface = (options: {
  document: Document; callers: MailFollowUpCallers; now?: () => number; timeZone?: () => string | undefined;
  focusReturn(): void;
  openDraft(request: { draftId: string; isCurrent(): boolean; onClosed(): void }): Promise<{ opened: boolean; error?: string }>;
  openReceivedReply?(ref: ReminderMailReference): void;
}) => {
  const doc = options.document, now = options.now ?? Date.now;
  const pendingReplacements = new Map<string, import('@recued/contracts').MailFollowUpReplacementCreate>();
  const pendingStarts = new Map<string, MailFollowUpStart>();
  const pendingReschedules = new Map<string, MailFollowUpReschedule>();
  interface Session {
    dialog: HTMLDialogElement; body: HTMLElement; footer: HTMLElement; title: HTMLElement;
    ref: ReminderMailReference | null; watch: MailFollowUp | null; eligible: boolean; reason?: string; recipients?: string[];
    intent: MailFollowUpSendIntent | null; pendingRows: MailFollowUpSendIntent[];
    zone: string; busy: boolean; editing: boolean; dirty: boolean; suspended: boolean;
    cursor: MailFollowUpCursor | null; rows: MailFollowUp[]; timer?: ReturnType<typeof setTimeout>;
    before: HTMLElement | null;
    taskPanel?: ReturnType<typeof createMailFollowUpTaskPanel>;
  }
  let session: Session | null = null;
  let disposed = false;
  const owns = (s: Session): boolean => !disposed && session === s;
  const focusReturn = (s: Session): void => {
    options.focusReturn();
    if (doc.activeElement === doc.body && s.before?.isConnected) s.before.focus();
  };
  const close = (restore = true): void => {
    const s = session; if (!s) return;
    if (s.timer) clearTimeout(s.timer);
    s.taskPanel?.dispose();
    session = null; s.dialog.close(); s.dialog.remove(); if (restore) focusReturn(s);
  };
  const button = (text: string, action: () => void, disabled = false): HTMLButtonElement => {
    const b = doc.createElement('button'); b.type = 'button'; b.className = 'data-button'; b.textContent = text;
    b.dataset.watchAction = text; b.disabled = disabled; b.addEventListener('click', action); return b;
  };
  const error = (s: Session, cause: unknown): void => {
    let p = s.body.querySelector<HTMLElement>('[data-watch-error]');
    if (!p) { p = doc.createElement('p'); p.dataset.watchError = ''; p.setAttribute('role', 'alert'); s.body.append(p); }
    p.textContent = humanizeRpcError(cause);
  };
  const busy = (s: Session, value: boolean): void => {
    s.busy = value; s.dialog.setAttribute('aria-busy', String(value));
    for (const control of s.dialog.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button,input,select')) {
      if (value) { control.dataset.watchBeforeBusy = String(control.disabled); control.disabled = true; }
      else if (control.dataset.watchBeforeBusy !== undefined) {
        control.disabled = control.dataset.watchBeforeBusy === 'true'; delete control.dataset.watchBeforeBusy;
      }
    }
  };
  const footer = (s: Session): void => {
    s.footer.replaceChildren(button('Close', () => { if (!s.busy) close(); }));
  };
  const focusReplyPreference = (s: Session): void => {
    (s.body.querySelector<HTMLInputElement>('.mail-watch-reply-notification input') ?? s.footer.querySelector<HTMLButtonElement>('button'))?.focus();
  };
  const schedule = (s: Session): void => {
    if (s.timer) clearTimeout(s.timer);
    if (!owns(s) || s.editing || s.suspended || s.busy) return;
    s.timer = setTimeout(() => {
      if (!owns(s) || s.busy || s.editing || s.suspended) return;
      if (s.intent) void refreshIntent(s);
      else if (s.watch && active(s.watch)) void check(s); else if (!s.watch) void list(s, false);
    }, 30_000);
  };
  const run = async (s: Session, task: () => Promise<void>): Promise<void> => {
    if (!owns(s) || s.busy) return;
    busy(s, true);
    try { await task(); } catch (cause) { if (owns(s)) error(s, cause); }
    finally { if (owns(s)) { busy(s, false); schedule(s); } }
  };
  const renderWatch = (s: Session): void => {
    s.taskPanel?.dispose(); s.taskPanel = undefined;
    s.intent = null;
    const focus = (doc.activeElement as HTMLElement | null)?.getAttribute('data-watch-action');
    const watch = s.watch!; s.editing = false; s.dirty = false;
    s.title.textContent = 'Follow up if no reply';
    s.body.innerHTML = `<h3>${e(watch.subject || '(No subject)')}</h3>
      <p role="status">${e(watchLabel(watch))}</p>
      ${watch.waiting_for ? `<p>Waiting for: ${e(watch.waiting_for.address)}</p>` : ''}
      ${mailFollowUpAutomaticReplyNotice(watch) ? `<p>${e(mailFollowUpAutomaticReplyNotice(watch)!)}</p>` : ''}
      <p>Check after ${e(formatReminderTimePreview(watch.check_at, s.zone))} (${e(s.zone)}).</p>
      ${watch.state === 'delivery_failed' && watch.delivery_failure ? `<p>Reported reason: ${e(watch.delivery_failure.reason ?? watch.delivery_failure.status)} (${e(watch.delivery_failure.status)}).</p>` : ''}
      ${watch.detail ? `<p>${e(watch.detail)}</p>` : ''}
      <p>Mailbox: ${e(watch.mail_ref.slug)}. Checks use synced messages in this conversation.</p>`;
    const actions = doc.createElement('div'); actions.className = 'mail-watch-actions'; s.body.append(actions);
    const source = doc.createElement('a'); source.className = 'data-button'; source.textContent = 'View watched email';
    source.href = `#data/mail/record/${encodeURIComponent(watch.mail_ref.slug)}/${encodeURIComponent(watch.mail_ref.record_id)}`;
    source.addEventListener('click', event => {
      event.preventDefault();
      void run(s, async () => {
        const confirmed = await options.callers.get({ mail_ref: watch.mail_ref });
        if (!owns(s)) return;
        if (!confirmed.eligible) throw new Error(confirmed.reason ?? 'The watched email could not be confirmed.');
        const hash = source.hash; close(false);
        if (doc.defaultView) doc.defaultView.location.hash = hash;
      });
    }); actions.append(source);
    if (watch.state === 'replied' && watch.reply_ref && options.openReceivedReply)
      actions.append(button('Open received reply', () => void openReply(s)));
    if (watch.state === 'replied' && !watch.reply_ref) {
      const note = doc.createElement('p'); note.textContent = 'This reply cannot be opened directly. Open the watched email to review its conversation.'; s.body.append(note);
    }
    if (active(watch) || watch.notify_on_reply) {
      const label = doc.createElement('label'); label.className = 'mail-watch-reply-notification';
      const toggle = doc.createElement('input'); toggle.type = 'checkbox'; toggle.checked = watch.notify_on_reply === true;
      toggle.addEventListener('change', () => void run(s, async () => {
        try {
          const updated = await options.callers.setReplyNotification({ id: watch.id, expected_revision: watch.revision, enabled: toggle.checked });
          if (owns(s)) { s.watch = updated; renderWatch(s); focusReplyPreference(s); }
        } catch (cause) { if (owns(s)) { renderWatch(s); focusReplyPreference(s); } throw cause; }
      }));
      label.append(toggle, 'Notify me when a reply arrives'); s.body.append(label);
    }
    if (watch.state === 'delivery_failed' && watch.delivery_failure && options.callers.createReplacement) actions.append(button(watch.replacement_draft_id ? 'Open replacement draft' : 'Draft replacement', () => void prepareReplacement(s)));
    if (watch.state === 'delivery_failed' && watch.delivery_failure && options.openReceivedReply) actions.append(button('Open delivery report', () => void openReport(s)));
    if (active(watch) || watch.state === 'delivery_failed') actions.append(button('Check now', () => void check(s)));
    if (active(watch) && !watch.delivery_failure) actions.append(button(pendingReschedules.has(watch.id) ? 'Check time change'
      : watch.draft_id || (watch.automatic_reply_count ?? 0) > 0 ? 'Snooze follow-up' : 'Change check time', () => renderReschedule(s)));
    if (watch.draft_id && !watch.delivery_failure) actions.append(button('Open saved draft', () => void openDraft(s)));
    if (active(watch) || watch.state === 'delivery_failed') actions.append(button(watch.state === 'delivery_failed' ? 'Dismiss delivery failure' : 'Cancel watch', () => void run(s, async () => {
      const updated = await options.callers.cancel({ id: watch.id, expected_revision: watch.revision });
      if (owns(s)) { s.watch = updated; renderWatch(s); }
    })));
    if (!active(watch) && s.ref && s.eligible) actions.append(button('Start another watch', () => renderCreate(s)));
    if (!s.ref) actions.append(button('Back to reply watches', () => { s.watch = null; void list(s, false); }));
    if (options.callers.tasks) s.taskPanel = createMailFollowUpTaskPanel({ parent: s.body, watch, callers: options.callers.tasks,
      current: () => owns(s) && s.watch?.id === watch.id && !s.suspended, busy: () => s.busy,
      editing: (value, dirty) => {
        s.editing = value; s.dirty = dirty;
        for (const controls of s.body.querySelectorAll<HTMLElement>('.mail-watch-actions,.mail-watch-reply-notification')) controls.inert = value;
        if (!value) schedule(s);
      },
      run: task => run(s, task), updated: updated => { s.watch = updated; renderWatch(s); s.footer.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true }); },
      navigate: href => { close(false); if (doc.defaultView) doc.defaultView.location.hash = href; },
    });
    footer(s); schedule(s);
    if (focus) Array.from(s.dialog.querySelectorAll<HTMLButtonElement>('[data-watch-action]')).find(b => b.dataset.watchAction === focus)?.focus({ preventScroll: true });
  };
  const check = (s: Session): Promise<void> => run(s, async () => {
    if (!s.watch) return;
    const watch = await options.callers.check({ id: s.watch.id });
    if (owns(s)) { s.watch = watch; renderWatch(s); }
  });
  const openReply = (s: Session): Promise<void> => run(s, async () => {
    if (!s.watch || !options.openReceivedReply) return;
    const target = await options.callers.getReply({ id: s.watch.id });
    if (!owns(s)) return;
    close(false); options.openReceivedReply(target.mail_ref);
  });
  const openReport = (s: Session): Promise<void> => run(s, async () => {
    if (!s.watch || !options.openReceivedReply) return;
    if (!options.callers.getDeliveryReport) throw new Error('Delivery report links are unavailable on this server. Open the watch in Mail.');
    const target = await options.callers.getDeliveryReport({ id: s.watch.id });
    if (!owns(s)) return;
    close(false); options.openReceivedReply(target.mail_ref);
  });
  const prepareReplacement = (s: Session): Promise<void> => run(s, async () => {
    if (!s.watch || !options.callers.createReplacement) return;
    const watch = s.watch;
    let request = pendingReplacements.get(watch.id);
    if (!request) { request = { id: watch.id, expected_revision: watch.revision, request_id: crypto.randomUUID() }; pendingReplacements.set(watch.id, request); }
    const updated = await options.callers.createReplacement(request);
    if (!owns(s)) return;
    pendingReplacements.delete(watch.id); s.watch = updated;
    if (!updated.replacement_draft_id) throw new Error('The replacement draft could not be confirmed. Check this watch again.');
    s.suspended = true; s.dialog.close();
    try {
      const result = await options.openDraft({ draftId: updated.replacement_draft_id, isCurrent: () => owns(s), onClosed: () => {
        if (!owns(s)) return; s.suspended = false; s.dialog.showModal(); renderWatch(s);
        s.body.querySelector<HTMLButtonElement>('button')?.focus();
      } });
      if (owns(s) && !result.opened) { s.suspended = false; s.dialog.showModal(); renderWatch(s); error(s, result.error ?? 'The replacement draft is unavailable. Open Drafts to review it.'); }
    } catch (cause) { if (owns(s)) { s.suspended = false; s.dialog.showModal(); renderWatch(s); } throw cause; }
  });
  const openDraft = (s: Session): Promise<void> => run(s, async () => {
    if (!s.watch?.draft_id || s.watch.delivery_failure) return;
    const checked = await options.callers.check({ id: s.watch.id });
    if (!owns(s)) return;
    s.watch = checked;
    if (!checked.draft_id || checked.delivery_failure) { renderWatch(s); return; }
    s.suspended = true; s.dialog.close();
    try {
      const result = await options.openDraft({ draftId: checked.draft_id, isCurrent: () => owns(s), onClosed: () => {
        if (!owns(s)) return;
        s.suspended = false; s.dialog.showModal(); renderWatch(s);
        s.body.querySelector<HTMLButtonElement>('button')?.focus();
      } });
      if (owns(s) && !result.opened) {
        s.suspended = false; s.dialog.showModal(); renderWatch(s);
        error(s, result.error ?? 'The saved draft is unavailable. It may have been deleted.');
      }
    } catch (cause) {
      if (owns(s)) { s.suspended = false; s.dialog.showModal(); renderWatch(s); }
      throw cause;
    }
  });
  const renderReschedule = (s: Session): void => {
    s.taskPanel?.dispose(); s.taskPanel = undefined;
    const watch = s.watch; if (!watch || !active(watch)) return;
    const pending = pendingReschedules.get(watch.id);
    s.editing = true; s.dirty = !!pending; s.title.textContent = watch.draft_id ? 'Snooze follow-up' : 'Change check time';
    const initial = pending?.check_at ?? (watch.check_at > now() ? watch.check_at : reminderTimePreset('tomorrow-9', now(), s.zone).at);
    let chosenAt: number | null = initial;
    s.body.innerHTML = watch.draft_id
      ? '<p>Your saved draft and edits will be kept. Recued will check for a reply before alerting you again.</p>'
      : '<p>Choose when Recued should check this conversation for a reply.</p>';
    const label = doc.createElement('label'); label.textContent = `Check date and time (${s.zone})`;
    const time = doc.createElement('input'); time.type = 'datetime-local'; time.required = true;
    time.value = reminderWallClockValue(initial, s.zone); time.disabled = !!pending; label.append(time); s.body.append(label);
    const preview = doc.createElement('p'); preview.setAttribute('role', 'status'); s.body.append(preview);
    const updatePreview = (): void => { preview.textContent = chosenAt === null ? 'Choose a valid time on this clock.' : formatReminderTimePreview(chosenAt, s.zone); };
    updatePreview();
    time.addEventListener('input', () => {
      if (s.busy || pendingReschedules.has(watch.id)) return;
      s.dirty = true; chosenAt = zonedWallClockToEpochMs(time.value, s.zone);
      if (chosenAt !== null && reminderWallClockValue(chosenAt, s.zone) !== time.value) chosenAt = null;
      updatePreview();
    });
    const presets = doc.createElement('div'); presets.className = 'mail-watch-actions';
    for (const [preset, text] of [['1-hour', 'In 1 hour'], ['tomorrow-9', 'Tomorrow at 9am']] as const) presets.append(button(text, () => {
      if (s.busy || pendingReschedules.has(watch.id)) return;
      const value = reminderTimePreset(preset, now(), s.zone); time.value = value.value; chosenAt = value.at; s.dirty = true; updatePreview();
    }, !!pending));
    s.body.append(presets);
    const save = button(pending ? 'Check save' : 'Save check time', () => {
      if (s.busy) return;
      if (!pendingReschedules.has(watch.id) && (chosenAt === null || chosenAt <= now())) { error(s, 'Choose a future check time.'); time.focus(); return; }
      const request = pendingReschedules.get(watch.id) ?? { id: watch.id, expected_revision: watch.revision,
        request_id: doc.defaultView!.crypto.randomUUID(), check_at: chosenAt! };
      pendingReschedules.set(watch.id, request); s.dirty = true;
      void run(s, async () => {
        try {
          const updated = await options.callers.reschedule(request); pendingReschedules.delete(watch.id);
          if (owns(s)) { s.watch = updated; renderWatch(s); }
        } catch (cause) {
          if (!owns(s)) return;
          if (['bad_request', 'resource_changed', 'conflict', 'forbidden', 'permission_denied'].includes(classifyRpcError(cause).code ?? '')) {
            pendingReschedules.delete(watch.id);
            try { const updated = await options.callers.check({ id: watch.id }); if (owns(s)) s.watch = updated; } catch { /* Preserve the last confirmed watch. */ }
            if (owns(s)) { renderWatch(s); error(s, cause); }
          } else { renderReschedule(s); error(s, cause); }
        }
      });
    });
    s.footer.replaceChildren(save, button('Cancel', () => { if (!s.busy) renderWatch(s); }));
    if (pending) s.body.insertAdjacentHTML('beforeend', '<p>Check save retries the same time change. You can also check this watch to see its current status.</p>');
    time.focus();
  };
  const renderCreate = (s: Session): void => {
    s.taskPanel?.dispose(); s.taskPanel = undefined;
    if (!s.ref || !s.eligible) return;
    s.title.textContent = 'Follow up if no reply'; s.editing = true;
    const key = JSON.stringify(s.ref), pending = pendingStarts.get(key);
    const initial = pending?.check_at ?? reminderTimePreset('tomorrow-9', now(), s.zone).at;
    let chosenAt: number | null = initial;
    s.body.innerHTML = `<p>Watch this sent email for a reply from its recipients. If no reply is found after your check time and a healthy mailbox sync, Recued saves a follow-up draft for you to review.</p>
      <p>Recued must be running and unlocked to check. You can find this watch in Mail → Reply watches.</p>`;
    const label = doc.createElement('label'); label.textContent = `Check date and time (${s.zone})`;
    const time = doc.createElement('input'); time.type = 'datetime-local'; time.required = true;
    time.value = reminderWallClockValue(initial, s.zone); label.append(time); s.body.append(label);
    const preview = doc.createElement('p'); preview.setAttribute('role', 'status'); s.body.append(preview);
    const updatePreview = (): void => {
      preview.textContent = chosenAt === null ? 'Choose a valid time on this clock.' : formatReminderTimePreview(chosenAt, s.zone);
    }; updatePreview();
    time.addEventListener('input', () => {
      if (s.busy || pendingStarts.has(key)) return;
      s.dirty = true; chosenAt = zonedWallClockToEpochMs(time.value, s.zone);
      if (chosenAt !== null && reminderWallClockValue(chosenAt, s.zone) !== time.value) chosenAt = null;
      updatePreview();
    });
    const choices = doc.createElement('div'); choices.className = 'mail-watch-actions';
    for (const [preset, text] of [['1-hour', 'In 1 hour'], ['tomorrow-9', 'Tomorrow at 9am']] as const) choices.append(button(text, () => {
      if (s.busy || pendingStarts.has(key)) return;
      const value = reminderTimePreset(preset, now(), s.zone); time.value = value.value; chosenAt = value.at; s.dirty = true; updatePreview();
    }, !!pending));
    s.body.append(choices);
    const notifyLabel = doc.createElement('label');
    const notify = doc.createElement('input'); notify.type = 'checkbox'; notify.checked = pending?.notify_on_reply === true; notify.disabled = !!pending;
    notify.addEventListener('change', () => { s.dirty = true; });
    notifyLabel.append(notify, 'Notify me when a reply arrives'); s.body.append(notifyLabel);
    let responder: HTMLSelectElement | undefined;
    if (s.recipients?.length) {
      const label = doc.createElement('label'); label.textContent = 'Waiting for'; responder = doc.createElement('select');
      for (const [value, text] of [['', 'Anyone on To/Cc'], ...s.recipients.map(address => [address, address])]) {
        const option = doc.createElement('option'); option.value = value!; option.textContent = text!; responder.append(option);
      }
      responder.value = pending?.waiting_for?.address ?? ''; responder.disabled = Boolean(pending);
      responder.addEventListener('change', () => { s.dirty = true; }); label.append(responder); s.body.append(label);
    }
    const save = button(pending ? 'Check save' : 'Start reply watch', () => {
      if (s.busy) return;
      if (!pendingStarts.has(key) && (chosenAt === null || chosenAt <= now())) { error(s, 'Choose a future check time.'); time.focus(); return; }
      const request = pendingStarts.get(key) ?? { creation_id: doc.defaultView!.crypto.randomUUID(), mail_ref: s.ref!, check_at: chosenAt!, ...(notify.checked ? { notify_on_reply: true } : {}),
        ...(responder?.value ? { waiting_for: { address: responder.value, recipients: s.recipients!.slice() } } : {}) };
      pendingStarts.set(key, request); s.dirty = true;
      void run(s, async () => {
        try {
          const watch = await options.callers.start(request);
          pendingStarts.delete(key);
          if (owns(s)) { s.watch = watch; renderWatch(s); }
        } catch (cause) {
          if (owns(s)) {
            if (['bad_request', 'resource_changed'].includes(classifyRpcError(cause).code ?? '')) pendingStarts.delete(key);
            renderCreate(s); error(s, cause);
            const note = doc.createElement('p'); note.textContent = 'Check save retries the same request. Saved watches are also available in Reply watches.'; s.body.append(note);
          }
        }
      });
    });
    footer(s); s.footer.prepend(save);
    // An interrupted save has one immutable request, including its exact instant.
    time.disabled = !!pending;
    if (pending) s.dirty = true;
    time.focus();
  };
  const intentLabel = (intent: MailFollowUpSendIntent): string => ({ awaiting_send: 'Waiting for the send', awaiting_approval: 'Waiting for send approval',
    awaiting_sync: 'Waiting for Sent sync', needs_attention: 'Needs attention', not_sent: 'Send did not start', armed: 'Reply watch started', cancelled: 'Reply watch cancelled' })[intent.state];
  const renderIntent = (s: Session): void => {
    s.taskPanel?.dispose(); s.taskPanel = undefined;
    const intent = s.intent!; s.watch = null; s.editing = false; s.dirty = false;
    s.title.textContent = 'Reply watch request';
    s.body.innerHTML = `<h3>${e(intent.subject || '(No subject)')}</h3><p role="status">${e(intentLabel(intent))}</p>
      ${intent.waiting_for ? `<p>Waiting for: ${e(intent.waiting_for.address)}</p>` : ''}
      <p>${e(intent.detail ?? '')}</p><p>Mailbox: ${e(intent.mailbox)}. Check for a reply ${e(String(intent.after_ms / 3600000))} hours after sending.</p>
      ${intent.run_id ? `<p><a href="${e(runSearchHref(intent.run_id))}">Open this send in History</a></p>` : ''}
      <p>Cancelling this reply watch request does not cancel or resend the email.</p>`;
    s.body.querySelector<HTMLAnchorElement>('a')?.addEventListener('click', event => {
      if (event.button > 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      if (s.busy) { event.preventDefault(); return; }
      close(false);
    });
    s.body.append(button('Refresh reply watch request', () => void refreshIntent(s)));
    if (!['armed', 'cancelled'].includes(intent.state) && options.callers.sends) s.body.append(button('Cancel reply watch request', () => void run(s, async () => {
      const updated = await options.callers.sends!.cancel({ id: intent.id, expected_revision: intent.revision });
      if (owns(s)) { s.intent = updated; renderIntent(s); }
    })));
    s.body.append(button('Back to reply watches', () => { s.intent = null; void list(s, false); })); footer(s); schedule(s);
  };
  const readIntent = async (s: Session, id: string): Promise<void> => {
    const intent = await options.callers.sends?.get({ id });
    if (!owns(s)) return;
    if (!intent) throw new Error('This reply watch request is unavailable. Refresh Reply watches.');
    if (intent.state === 'armed' && intent.watch_id) {
      const watch = await options.callers.check({ id: intent.watch_id }); if (!owns(s)) return;
      s.watch = watch; renderWatch(s);
    } else { s.intent = intent; renderIntent(s); }
  };
  const refreshIntent = (s: Session): Promise<void> => run(s, async () => { if (s.intent) await readIntent(s, s.intent.id); });
  const renderList = (s: Session): void => {
    s.taskPanel?.dispose(); s.taskPanel = undefined;
    s.intent = null;
    s.editing = false; s.dirty = false; s.title.textContent = 'Reply watches';
    const selected = (doc.activeElement as HTMLElement | null)?.getAttribute('data-reply-watch-id');
    s.body.innerHTML = '<p>Check sent emails for recipient replies and prepare saved drafts for your review.</p>';
    if (!s.rows.length && !s.pendingRows.length) s.body.insertAdjacentHTML('beforeend', '<p role="status">No reply watches yet. Open a sent email and choose “Follow up if no reply”, or choose it while composing a one-off send.</p>');
    for (const intent of s.pendingRows) {
      const row = doc.createElement('section'); row.dataset.pendingReplyWatch = intent.id;
      row.innerHTML = `<h3>${e(intent.subject || '(No subject)')}</h3><p>${e(intentLabel(intent))} · ${e(intent.mailbox)}</p><p>${e(intent.detail ?? '')}</p>`;
      row.append(button('Manage pending watch', () => { s.intent = intent; void refreshIntent(s); })); s.body.append(row);
    }
    for (const watch of s.rows) {
      const row = doc.createElement('section');
      row.innerHTML = `<h3>${e(watch.subject || '(No subject)')}</h3><p>${e(watchLabel(watch))} · ${e(watch.mail_ref.slug)}</p><p>${e(formatReminderTimePreview(watch.check_at, s.zone))}</p>`;
      const open = button('Manage watch', () => { s.watch = watch; renderWatch(s); s.body.querySelector<HTMLButtonElement>('button')?.focus(); });
      open.dataset.replyWatchId = watch.id; row.append(open); s.body.append(row);
    }
    if (s.cursor) s.body.append(button('Load more watches', () => void list(s, true)));
    footer(s); s.footer.prepend(button('Refresh watches', () => void list(s, false)));
    if (selected) Array.from(s.body.querySelectorAll<HTMLButtonElement>('[data-reply-watch-id]')).find(b => b.dataset.replyWatchId === selected)?.focus({ preventScroll: true });
    schedule(s);
  };
  const list = (s: Session, more: boolean): Promise<void> => run(s, async () => {
    const result = await options.callers.list(more && s.cursor ? { cursor: s.cursor } : undefined);
    if (!owns(s)) return;
    s.rows = more ? [...new Map([...s.rows, ...result.watches].map(w => [w.id, w])).values()] : result.watches;
    if (!more) s.pendingRows = result.pending_sends ?? [];
    s.cursor = result.next_cursor; renderList(s);
  });
  const open = (ref: ReminderMailReference | null, target?: MailFollowUpAddress): void => {
      if (disposed) return;
      if (session) { session.dialog.focus(); return; }
      const dialog = doc.createElement('dialog'); dialog.setAttribute('aria-label', ref || target ? 'Follow up if no reply' : 'Reply watches');
      dialog.dataset.mailReplyWatches = '';
      const style = doc.createElement('style'); style.textContent = `
        [data-mail-reply-watches] { width:min(560px,90vw); max-height:85vh; max-height:85dvh; box-sizing:border-box; overflow:hidden; padding:20px; border:1px solid var(--border,#666); border-radius:12px; background:var(--surface,#fff); color:var(--fg,#222); font:14px/1.5 system-ui,sans-serif; }
        [data-mail-reply-watches][open] { display:flex; flex-direction:column; }
        [data-mail-reply-watches]::backdrop { background:#0006; }
        [data-mail-reply-watches] h2 { margin:0 0 12px; font-size:1.2rem; }
        [data-mail-reply-watches] h3 { overflow-wrap:anywhere; }
        [data-mail-reply-watches] .mail-watch-body { min-height:0; overflow:auto; overscroll-behavior:contain; overflow-wrap:anywhere; }
        [data-mail-reply-watches] .mail-watch-actions { display:flex; flex-wrap:wrap; gap:8px; }
        [data-mail-reply-watches] footer { display:flex; flex:none; flex-wrap:wrap; justify-content:flex-end; gap:8px; padding-top:16px; }
        [data-mail-reply-watches] label { display:grid; gap:8px; }
        [data-mail-reply-watches] input { padding:8px; font:inherit; color:inherit; background:var(--surface,#fff); border:1px solid var(--border,#888); border-radius:6px; min-width:0; }
        [data-mail-reply-watches] button,[data-mail-reply-watches] a { font:inherit; color:inherit; padding:8px 12px; background:var(--surface,#fff); border:1px solid var(--border,#888); border-radius:6px; cursor:pointer; }
      `;
      const title = doc.createElement('h2'); title.textContent = ref || target ? 'Follow up if no reply' : 'Reply watches';
      const body = doc.createElement('div'); body.className = 'mail-watch-body'; body.innerHTML = '<p role="status">Loading reply watches…</p>';
      const actions = doc.createElement('footer');
      const s: Session = { dialog, title, body, footer: actions, ref, watch: null, intent: null, pendingRows: [], eligible: false,
        zone: stampZone(options.timeZone?.()), busy: false, editing: false, dirty: false, suspended: false,
        cursor: null, rows: [], before: doc.activeElement as HTMLElement | null };
      session = s; dialog.append(style, title, body, actions); footer(s);
      dialog.addEventListener('cancel', event => { event.preventDefault(); if (!s.busy) close(); });
      doc.body.append(dialog); dialog.showModal();
      if (target) void run(s, async () => {
        let watch: MailFollowUp;
        try { watch = await options.callers.check({ id: target.id }); }
        catch (cause) {
          if (classifyRpcError(cause).code !== 'not_found' || !options.callers.sends || target.draft_id || target.open_reply || target.open_report || target.edit_time) throw cause;
          await readIntent(s, target.id); return;
        }
        if (!owns(s)) return;
        s.watch = watch; renderWatch(s);
        if (target.draft_id && target.draft_id !== watch.draft_id) error(s, 'This link belongs to a different draft. Review the current watch.');
        else if (target.draft_id && (target.schedule_version ?? 0) !== (watch.schedule_version ?? 0)) error(s, 'This link is from an earlier check time. Review the current watch.');
      }).then(() => {
        if (owns(s) && target.edit_time && s.watch && active(s.watch)) { renderReschedule(s); return; }
        if (owns(s) && target.open_report && s.watch?.state === 'delivery_failed') { void openReport(s); return; }
        if (owns(s) && target.open_reply && s.watch?.state === 'replied') { void openReply(s); return; }
        if (owns(s) && target.draft_id && s.watch?.draft_id === target.draft_id && s.watch.state === 'draft_ready'
          && (target.schedule_version ?? 0) === (s.watch.schedule_version ?? 0)) void openDraft(s);
      });
      else if (ref) void run(s, async () => {
        const result = await options.callers.get({ mail_ref: ref }); if (!owns(s)) return;
        s.eligible = result.eligible; s.reason = result.reason; s.watch = result.watch; s.recipients = result.recipients;
        if (result.watch) pendingStarts.delete(JSON.stringify(ref));
        if (s.watch) renderWatch(s); else if (result.eligible) renderCreate(s);
        else { s.body.textContent = result.reason ?? 'Choose a sent email with confirmed reply headers.'; footer(s); }
      }); else void list(s, false);
  };
  return {
    open,
    openTarget: (target: MailFollowUpAddress): void => open(null, target),
    beforeLeave(): boolean {
      if (!session || session.suspended) return true;
      session.dialog.focus(); return false;
    },
    hasUnsavedChanges: (): boolean => session?.dirty === true,
    hasInFlightWork: (): boolean => session?.busy === true,
    reset: (): void => close(false),
    dispose: (): void => { disposed = true; close(false); pendingStarts.clear(); },
  };
};
