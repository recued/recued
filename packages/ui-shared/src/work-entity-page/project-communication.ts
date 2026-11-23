import { e } from '../template.js';
export interface ProjectCommunicationView {
  mail_available: boolean; chat: { available: boolean; busy?: boolean; error?: string }; busy: boolean;
  chooser: boolean; phase: 'idle' | 'loading' | 'ready' | 'opening'; selected: string;
  choices: readonly { key: string; label: string; email?: string; reason?: string; merged?: boolean }[];
  error?: string; notice?: string;
}
export const renderProjectCommunication = (view: ProjectCommunicationView | undefined, blocked = false): string => {
  if (!view || !view.mail_available && !view.chat.available) return '';
  const disabled = view.busy || blocked ? ' aria-disabled="true"' : '';
  return `<section class="project-work-section" aria-label="Project communication" data-project-communication>
    <div class="project-work-actions">
      ${view.mail_available ? `<button type="button" data-action="project-communication-mail" data-project-focus="project-mail"${disabled}>${view.phase === 'loading' ? 'Checking project…' : 'Draft status email'}</button>` : ''}
      ${view.chat.available ? `<button type="button" data-action="project-communication-chat" data-project-focus="project-chat"${disabled}>${view.chat.busy ? 'Checking project…' : 'Chat about project'}</button>` : ''}
    </div>
    ${view.chat.error ? `<p role="alert">${e(view.chat.error)}</p>` : ''}${view.error ? `<p role="alert">${e(view.error)}</p>` : ''}
    ${view.notice ? `<p role="status">${e(view.notice)}</p>` : ''}
    ${view.chooser ? `<section class="project-work-search" aria-label="Choose project update recipient">
      <p>Choose a linked contact. Review the project update in the email composer before generating or sending it.</p>
      ${view.phase === 'loading' ? '<p role="status">Loading linked contacts…</p>' : ''}
      ${view.choices.length ? `<label>Recipient<select data-project-recipient data-project-focus="project-recipient"${view.busy || blocked ? ' disabled' : ''}>
        <option value="">Choose a contact</option>${view.choices.map(row => `<option value="${e(row.key)}"${view.selected === row.key ? ' selected' : ''}${!row.email ? ' disabled' : ''}>${e(row.label)}${row.email ? ' · ' + e(row.email) : ''}${row.merged ? ' · Merged contact' : ''}${row.reason ? ' · ' + e(row.reason) : ''}</option>`).join('')}</select></label>`
        : view.phase !== 'loading' && !view.error ? '<p>No contacts are linked to this project. Add a contact in Edit project before drafting an update.</p>' : ''}
      <div class="project-work-actions"><button type="button" data-action="project-communication-draft" data-project-focus="project-mail-continue"${view.busy || blocked || !view.selected ? ' disabled' : ''}>${view.phase === 'opening' ? 'Opening email…' : 'Continue to email'}</button>
        <button type="button" data-action="project-communication-mail" data-project-focus="project-mail-reload"${disabled}>Reload contacts</button>
        <button type="button" data-action="project-communication-close" data-project-focus="project-mail-close"${view.phase === 'opening' ? ' disabled' : ''}>Close recipient choice</button></div>
    </section>` : ''}
  </section>`;
};
