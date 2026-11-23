import { REMINDER_TEXT_MAX, readReminderRecordReference, sameReminderRecordReference, type ReminderRecordReference, type WorkEntity } from '@recued/contracts';
import { e } from '@recued/ui-shared';
import { mountReminderCreateForm } from '../reminders/reminder-create-form.js';
import type { ReminderRecoveryStore } from '../reminders/reminder-draft-recovery.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';
import type { DataWorkEntityGetCaller } from './bootstrap-data-route.js';
import type { ReminderCallers } from './reminders-surface.js';
import { createRecordReminders } from './record-reminders.js';

type Record = Extract<WorkEntity, { _kind: 'task' | 'commitment' }>;
export const reminderRecordReference = (record: Record): ReminderRecordReference => ({
  kind: record._kind, id: record.id, source_id: record.source_id,
  source_record_id: record.source_record_id ?? null, created_at: record.created_at,
});
export const matchesReminderRecord = (ref: ReminderRecordReference, record: WorkEntity | null): record is Record =>
  !!record && (record._kind === 'task' || record._kind === 'commitment')
  && record.deleted_at == null && record.sync_state !== 'tombstoned' && record.sync_state !== 'orphaned'
  && sameReminderRecordReference(ref, reminderRecordReference(record));

/** Owns contextual creation and linked reminder management. Draft DOM survives
 * host repaints; late reads belong only to the reader that started them. */
export const createWorkReminder = (deps: {
  root: HTMLElement; get?: DataWorkEntityGetCaller; callers: ReminderCallers; actionAttr: string;
  timeZone?: () => string | undefined; now?: () => number; changed(): void;
  recovery?: ReminderRecoveryStore;
}) => {
  type Operation = { record: Record; current(): boolean; opening: boolean; error?: string; notice?: string };
  let op: Operation | undefined;
  let host: HTMLElement | undefined;
  let form: ReturnType<typeof mountReminderCreateForm> | undefined;
  let focus: HTMLElement | undefined;
  let linked: { key: string; model: ReturnType<typeof createRecordReminders> } | undefined;
  const owns = (owner: Operation) => op === owner && owner.current();
  const available = (record: Record) => !!deps.get && !!deps.callers.create && !!deps.callers.list
    && record.deleted_at == null && record.sync_state === 'live' && !record.pending_write;
  const resetForm = () => { op = undefined; form?.dispose(); form = undefined; host = undefined; focus = undefined; };
  const reset = () => { resetForm(); linked?.model.dispose(); linked = undefined; };
  const focusDraft = () => (host?.querySelector<HTMLElement>('textarea') ?? host?.querySelector<HTMLElement>('button'))?.focus();
  return {
    reset, dispose: reset,
    initialReadPending: () => linked?.model.current() === true && linked.model.initialReadPending(),
    pending: () => form?.pending() === true || linked?.model.busy() === true,
    hasDraft: () => form?.hasDraft() === true || linked?.model.hasDraft() === true,
    block(): boolean {
      if (form?.hasDraft()) { focusDraft(); return true; }
      return linked?.model.beforeLeave() === false;
    },
    preservedHost: () => linked?.model.current() ? linked.model.preservedHost() : undefined,
    capture(active: Element | null) {
      focus = active && host?.contains(active) ? active as HTMLElement : undefined;
      linked?.model.capture(active);
    },
    restore() {
      if (op && !owns(op) && !form?.pending()) resetForm();
      if (op && owns(op)) {
        const slot = deps.root.querySelector('[data-work-reminder-slot]');
        if (slot && host) {
          slot.append(host);
          if (focus?.isConnected) focus.focus({ preventScroll: true });
        }
      }
      focus = undefined;
      if (linked && !linked.model.current()) { linked.model.dispose(); linked = undefined; }
      linked?.model.restore();
      linked?.model.start();
    },
    render(record: Record, context: { visit: string; current(): boolean }): string {
      if (deps.callers.list) {
        const reference = reminderRecordReference(record), key = JSON.stringify([context.visit, reference]);
        if (linked?.key !== key) {
          linked?.model.dispose();
          linked = { key, model: createRecordReminders({ root: deps.root, reference, callers: deps.callers,
            recovery: deps.recovery,
            actionAttr: deps.actionAttr, current: context.current, changed: deps.changed,
            ...(deps.now ? { now: deps.now } : {}), ...(deps.timeZone ? { timeZone: deps.timeZone } : {}),
          }) };
        }
      }
      const current = op?.record === record && owns(op) ? op : undefined;
      if (!available(record) && !current && !linked) return '';
      return `<section data-recued-reminders aria-label="Reminder for ${record._kind}">
        ${form?.hasDraft() ? '<p>Set or cancel this reminder before using other record actions.</p>' : available(record) ? `<button type="button" class="work-entity-dialog-cancel" data-action="remind-work-record" data-work-reminder-trigger${current?.opening ? ' disabled aria-busy="true"' : ''}>${current?.opening ? 'Checking record…' : 'Remind me about this'}</button>` : ''}
        ${current?.error ? `<p role="alert">${e(current.error)}</p>` : ''}
        ${current?.notice ? `<p role="status" data-work-reminder-notice tabindex="-1">${e(current.notice)}</p>` : ''}
        <div data-work-reminder-slot></div>
        ${linked?.model.render() ?? ''}
      </section>`;
    },
    handle(action: string, target: HTMLElement): boolean {
      if (!target.closest('[data-work-linked-reminders]')) return false;
      if (form?.hasDraft()) { focusDraft(); return true; }
      if (op && owns(op) && op.opening) return true;
      return linked?.model.handle(action, target) ?? false;
    },
    input: (target: HTMLElement) => linked?.model.input(target) ?? false,
    change: (target: HTMLElement) => linked?.model.change(target) ?? false,
    async open(record: Record, current: () => boolean): Promise<void> {
      if (form?.hasDraft()) { focusDraft(); return; }
      if (!available(record) || !current() || op && owns(op) && op.opening) return;
      if (linked?.model.prepareCreate() === false) return;
      resetForm();
      const owner: Operation = { record, current, opening: true }; op = owner; deps.changed();
      try {
        const [capabilities, response] = await Promise.all([
          deps.callers.list!({ limit: 1 }), deps.get!({ kind: record._kind, id: record.id }),
        ]);
        if (!owns(owner)) return;
        if (capabilities.record_links_supported !== true)
          throw new Error('Update the server to set reminders linked to records.');
        const ref = reminderRecordReference(record), saved = response.entity;
        if (!matchesReminderRecord(ref, saved) || saved.sync_state !== 'live' || saved.pending_write)
          throw new Error('This record changed or is unavailable. Reopen it before setting a reminder.');
        host = deps.root.ownerDocument.createElement('div');
        form = mountReminderCreateForm({ host, ...(deps.now ? { now: deps.now } : {}), ...(deps.timeZone ? { timeZone: deps.timeZone } : {}),
          recovery: deps.recovery,
          create: async args => {
            // Identical retries must reach the server even after the source
            // disappears: it reconciles the creation receipt before reading it.
            const result = await deps.callers.create!(args);
            const returned = readReminderRecordReference(result.reminder.record_ref);
            if (!returned || !sameReminderRecordReference(ref, returned))
              throw new Error('The linked reminder could not be confirmed. Review existing reminders before retrying.');
            return result;
          },
          onClose: (result, keptId) => {
            if (!owns(owner)) return;
            const active = deps.root.ownerDocument.activeElement;
            const ownedFocus = !result || active === deps.root.ownerDocument.body || !!active && !!host?.contains(active);
            owner.notice = result ? `${result.reminder.state === 'pending' ? 'Reminder set' : 'Reminder history'}: ${result.confirmation}`
              : keptId ? 'Draft kept in this tab. Resume it from Reminders or Universal Search.' : undefined;
            if (result && linked?.model.current()) void linked.model.refresh();
            deps.changed();
            if (ownedFocus) deps.root.querySelector<HTMLElement>(result ? '[data-work-reminder-notice]' : '[data-work-reminder-trigger]')?.focus({ preventScroll: true });
          },
        });
        owner.opening = false; deps.changed();
        const title = saved._kind === 'task' ? saved.title : saved.statement;
        let text = `Follow up: ${title.trim()}`.slice(0, REMINDER_TEXT_MAX);
        if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
        form.open({ text, record_ref: ref });
        deps.changed();
      } catch (error) {
        if (owns(owner)) { owner.error = humanizeRpcError(error); owner.opening = false; deps.changed(); }
      }
    },
  };
};
