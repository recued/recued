import { e } from '@recued/ui-shared';
import { reminderDraftSource, type ReminderRecoveryStore } from './reminder-draft-recovery.js';
import { formatReminderTimePreview } from './reminder-time.js';

export const renderReminderRecoveries = (options: {
  store?: ReminderRecoveryStore; actionAttr: string; currentId?: string; confirming?: string; error?: string; disabled: boolean;
}): string => {
  if (!options.store) return '';
  const read = options.store.inspect?.() ?? { entries: options.store.list(), unavailable: false };
  const entries = read.entries.filter(entry => entry.id !== options.currentId);
  if (!entries.length && !read.unavailable && !options.error) return '';
  return `<section class="reminder-recoveries" role="region" aria-label="Unfinished reminders and alarms">
    <h3>Unfinished reminders and alarms</h3><p>Drafts stay in this browser tab for up to 7 days. Unconfirmed saves stay until checked or discarded.</p>
    ${read.unavailable ? '<p role="alert">Reminder recovery copies could not be read. Keep any open draft and try again.</p>' : ''}
    ${options.error ? `<p role="alert">${e(options.error)}</p>` : ''}
    ${entries.map(entry => {
      const value = entry.values, source = reminderDraftSource(value);
      const button = (action: string, label: string) => `<button type="button" class="data-button" ${options.actionAttr}="reminders-recovery-${action}"
        data-reminder-draft-id="${entry.id}" data-recued-reminders-focus="recovery-${action}:${entry.id}"${options.disabled ? ' disabled' : ''}>${label}</button>`;
      return `<article><h4>${e(value.text.trim() || (value.kind === 'alarm' ? 'Untitled alarm' : 'Untitled reminder'))}</h4>
        <p>${value.kind === 'alarm' ? 'Alarm' : 'Reminder'} · ${e(value.chosenAt === null ? value.time.replace('T', ' ') || 'No time chosen' : formatReminderTimePreview(value.chosenAt, value.zone))} · ${e(value.zone)}</p>
        ${source ? `<p><a href="${e(source.href)}">${e(source.label)}</a></p>` : ''}
        ${entry.status !== 'editing' ? '<p>This save was not confirmed. Resume to check its original request before creating another reminder.</p>' : ''}
        <div class="reminder-create-actions">${button('resume', 'Resume draft')}${button('discard', 'Discard draft')}</div>
        ${options.confirming === entry.id ? `<div role="group" aria-label="Discard reminder recovery?"><p>Remove this recovery copy? This does not cancel a reminder or alarm already created.</p><div class="reminder-create-actions">${button('keep', 'Keep draft')}${button('remove', 'Discard recovery copy')}</div></div>` : ''}
      </article>`;
    }).join('')}</section>`;
};
