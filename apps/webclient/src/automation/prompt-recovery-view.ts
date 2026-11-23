import { describeCron } from '@recued/contracts';
import type { PromptDraftEntry, PromptRecoveryStore } from './prompt-draft-recovery.js';

/** DOM text setters keep unfinished owner input out of HTML parsing. */
export const promptRecoveryView = (options: {
  document: Document; store?: PromptRecoveryStore; disabled: boolean; error?: string; confirming?: PromptDraftEntry;
  scheduleId?: string; creationDraftId?: string;
  resume(entry: PromptDraftEntry): void; confirm(entry?: PromptDraftEntry): void; remove(entry: PromptDraftEntry): void;
}): HTMLElement | undefined => {
  if (!options.store) return;
  const read = options.store.inspect?.() ?? { entries: options.store.list(), unavailable: false };
  if (options.scheduleId) read.entries = read.entries.filter(entry => entry.original?.schedule_id === options.scheduleId || entry.id === options.creationDraftId);
  if (!read.entries.length && !read.unavailable && !options.error) return;
  const doc = options.document;
  const node = (tag: string, text: string) => { const el = doc.createElement(tag); el.textContent = text; return el; };
  const section = doc.createElement('section'); section.setAttribute('role', 'region'); section.setAttribute('aria-label', 'Unfinished scheduled prompts');
  section.append(node('h3', 'Unfinished scheduled prompts'), node('p', 'Drafts stay in this browser tab for up to 7 days. Unconfirmed saves stay until checked or discarded.'));
  const error = options.error || (read.unavailable ? 'Scheduled prompt recovery copies could not be read. Keep any open draft and try again.' : '');
  if (error) { const alert = node('p', error); alert.setAttribute('role', 'alert'); section.append(alert); }
  for (const entry of read.entries) {
    const values = entry.values, card = doc.createElement('article'); card.dataset.promptDraftId = entry.id;
    card.append(node('h4', values.title.trim() || 'Untitled scheduled prompt'), node('p', values.prompt.slice(0, 180)));
    if (entry.original) card.append(node('p', `Edits to “${entry.original.title}”. Resume checks its current settings before saving.`));
    let timing = values.time.replace('T', ' ') + ' · ' + values.oneOffZone;
    if (values.mode === 'recurring') {
      try { timing = (values.frequency === 'custom' ? describeCron(values.cron) : values.frequency === 'weekly' ? 'Every week' : values.frequency === 'weekdays' ? 'Every weekday' : 'Every day') + ' · ' + (values.frequency === 'custom' ? values.cron : values.clock) + ' · ' + values.timezone; }
      catch { timing = values.cron + ' · ' + values.timezone; }
    }
    card.append(node('p', timing));
    if (entry.status !== 'editing') card.append(node('p', entry.original ? 'This update was not confirmed. Resume to check the saved settings before retrying.' : 'This save was not confirmed. Resume to check its original request before creating another schedule.'));
    const actions = doc.createElement('div'); actions.dataset.promptScheduleActions = '';
    const button = (label: string, key: string, action: () => void, parent: HTMLElement = actions) => {
      const button = doc.createElement('button'); button.type = 'button'; button.textContent = label; button.disabled = options.disabled;
      button.dataset.promptFocus = 'draft-' + key + ':' + entry.id; button.addEventListener('click', action); parent.append(button);
    };
    button('Resume draft', 'resume', () => options.resume(entry)); button('Discard draft', 'discard', () => options.confirm(entry)); card.append(actions);
    if (options.confirming?.id === entry.id) {
      const confirm = doc.createElement('div'); confirm.setAttribute('role', 'group'); confirm.setAttribute('aria-label', 'Discard scheduled prompt draft?');
      confirm.append(node('p', entry.original ? 'Remove only these local edits? This does not change, pause or remove the saved schedule. An update already sent may still finish.' : 'Remove this recovery copy? This does not pause or remove a schedule already created.'));
      button('Keep draft', 'keep', () => options.confirm(), confirm);
      button('Discard recovery copy', 'remove', () => options.remove(options.confirming!), confirm); card.append(confirm);
    }
    section.append(card);
  }
  return section;
};
