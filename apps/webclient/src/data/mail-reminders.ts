import { REMINDER_TEXT_MAX, readReminderMailReference, sameReminderMailReference,
  type MailMessageSnapshot, type ReminderMailReference } from '@recued/contracts';
import { e } from '@recued/ui-shared';
import { mountReminderCreateForm } from '../reminders/reminder-create-form.js';
import type { ReminderRecoveryStore } from '../reminders/reminder-draft-recovery.js';
import { validateReminderSearchPage } from '../reminders/reminder-search.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';
import { createRecordReminders } from './record-reminders.js';
import type { ReminderCallers } from './reminders-surface.js';
export const MAIL_REMINDER_CREATE_HOST = 'data-mail-reminder-create-host';

/** One selected email, one reminder workflow. Its drafts and pending reads
 * cannot migrate to another message or another enrollment of the mailbox. */
export const createMailReminders = (deps: {
  root: HTMLElement; callers: ReminderCallers; actionAttr: string; changed(): void;
  now?: () => number; timeZone?: () => string | undefined;
  recovery?: ReminderRecoveryStore;
}) => {
  type Scope = { key: string; ref: ReminderMailReference; current(): boolean;
    model: ReturnType<typeof createRecordReminders>; opening: boolean; error?: string; notice?: string };
  let scope: Scope | undefined, host: HTMLElement | undefined;
  let form: ReturnType<typeof mountReminderCreateForm> | undefined, held: HTMLElement | undefined;
  const resetForm = () => { form?.dispose(); form = undefined; host = undefined; held = undefined; };
  const reset = () => { resetForm(); scope?.model.dispose(); scope = undefined; };
  const owns = (owner: Scope) => scope === owner && owner.current();
  const focusDraft = () => host?.querySelector<HTMLElement>('textarea, button')?.focus({ preventScroll: true });
  const beforeLeave = () => {
    if (form?.hasDraft()) { focusDraft(); return false; }
    return scope?.model.beforeLeave() ?? true;
  };
  return {
    reset, dispose: reset, beforeLeave,
    pending: () => form?.pending() === true || scope?.model.busy() === true,
    hasDraft: () => form?.hasDraft() === true || scope?.model.hasDraft() === true,
    preservedHost: () => scope && owns(scope) ? form?.hasDraft() ? host : scope.model.preservedHost() : undefined,
    capture(active: Element | null) {
      held = active && host?.contains(active) ? active as HTMLElement : undefined;
      scope?.model.capture(active);
    },
    restore() {
      if (scope && !owns(scope)) { reset(); return; }
      const slot = deps.root.querySelector('[data-mail-reminder-slot]');
      if (host && slot && host.parentNode !== slot) {
        const placeholder = slot.querySelector(`[${MAIL_REMINDER_CREATE_HOST}]`);
        if (placeholder) placeholder.replaceWith(host); else slot.append(host);
      }
      if (held?.isConnected) held.focus({ preventScroll: true });
      held = undefined; scope?.model.restore(); scope?.model.start();
    },
    render(message: MailMessageSnapshot, context: { visit: string; current(): boolean }): string {
      const ref = readReminderMailReference(message.reminder_ref);
      if (!ref || !deps.callers.list) return '';
      const key = JSON.stringify([context.visit, ref]);
      if (scope?.key !== key) {
        reset();
        scope = { key, ref, current: context.current, opening: false,
          model: createRecordReminders({ root: deps.root, mailReference: ref, callers: deps.callers,
            recovery: deps.recovery,
            actionAttr: deps.actionAttr, current: context.current, changed: deps.changed,
            ...(deps.now ? { now: deps.now } : {}), ...(deps.timeZone ? { timeZone: deps.timeZone } : {}) }) };
      }
      return `<section data-mail-reminders data-recued-reminders aria-label="Reminders for this email">
        ${scope.error ? `<p role="alert">${e(scope.error)}</p>` : ''}
        ${scope.notice ? `<p role="status" tabindex="-1" data-mail-reminder-notice>${e(scope.notice)}</p>` : ''}
        ${scope.opening ? '<p role="status">Checking email reminders…</p>' : ''}
        ${form?.hasDraft() ? '<p>Set or cancel this reminder before using other email actions.</p>' : ''}
        <div data-mail-reminder-slot>${host ? `<div ${MAIL_REMINDER_CREATE_HOST}></div>` : ''}</div>${scope.model.render()}
      </section>`;
    },
    async open(message: MailMessageSnapshot, current: () => boolean) {
      const owner = scope;
      if (form?.hasDraft()) { focusDraft(); return; }
      if (!owner || !owns(owner) || !current() || owner.opening || !deps.callers.create || !deps.callers.list
        || !owner.model.prepareCreate()) return;
      resetForm(); owner.opening = true; owner.error = undefined; deps.changed();
      try {
        const page = { mail_ref: owner.ref, state: 'pending' as const };
        const available = await deps.callers.list({ limit: 1, page });
        if (!owns(owner) || !current()) return;
        validateReminderSearchPage(available, page);
        if (available.mail_links_supported !== true) throw new Error('Update the server to set reminders linked to emails.');
        host = deps.root.ownerDocument.createElement('div');
        host.setAttribute(MAIL_REMINDER_CREATE_HOST, '');
        form = mountReminderCreateForm({ host, ...(deps.now ? { now: deps.now } : {}), ...(deps.timeZone ? { timeZone: deps.timeZone } : {}),
          recovery: deps.recovery,
          create: async input => {
            const out = await deps.callers.create!(input);
            const ref = readReminderMailReference(out.reminder.mail_ref);
            if (!ref || !sameReminderMailReference(owner.ref, ref))
              throw new Error('The linked reminder could not be confirmed. Review existing reminders before retrying.');
            return out;
          },
          onClose: (result, keptId) => {
            if (!owns(owner)) return;
            const active = deps.root.ownerDocument.activeElement;
            const focus = !result || active === deps.root.ownerDocument.body || !!active && !!host?.contains(active);
            owner.notice = result ? `Reminder ${result.reminder.state === 'pending' ? 'set' : 'history'}: ${result.confirmation}`
              : keptId ? 'Draft kept in this tab. Resume it from Reminders or Universal Search.' : undefined;
            deps.changed();
            if (result) void owner.model.refresh();
            if (focus) deps.root.querySelector<HTMLElement>(result ? '[data-mail-reminder-notice]' : '[data-mail-focus="remind"]')?.focus({ preventScroll: true });
          },
        });
        owner.opening = false; deps.changed();
        let text = `Follow up: ${message.subject.trim() || 'Email'}`.slice(0, REMINDER_TEXT_MAX);
        if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
        form.open({ text, mail_ref: owner.ref });
      } catch (cause) {
        if (owns(owner) && current()) { owner.error = humanizeRpcError(cause); owner.opening = false; deps.changed(); }
      } finally { if (owns(owner)) owner.opening = false; }
    },
    handle(action: string, target: HTMLElement): boolean {
      if (!target.closest('[data-mail-reminders]')) return false;
      if (form?.hasDraft()) { focusDraft(); return true; }
      if (scope?.opening) return true;
      return scope?.model.handle(action, target) ?? false;
    },
    input: (target: HTMLElement) => scope?.model.input(target) ?? false,
    change: (target: HTMLElement) => scope?.model.change(target) ?? false,
  };
};
