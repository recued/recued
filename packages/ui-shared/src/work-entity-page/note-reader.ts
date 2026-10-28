import type { Note } from '@recued/contracts';
import { e } from '../template.js';

export interface WorkEntityNoteView {
  entity: Note;
  mode: 'read' | 'edit';
  can_edit: boolean;
  copying?: boolean;
  opening?: boolean;
  notice?: { kind: 'ok' | 'error'; text: string };
}

/** A note is useful on its own. Optional relationships and activity never
 *  replace the full text or introduce empty setup sections. */
export const renderNoteReader = (
  view: WorkEntityNoteView,
  sourceLabel: string,
  historyHtml?: string,
  closeLabel = 'Back to notes',
): string => {
  const note = view.entity;
  const title = note.title?.trim() || 'Note';
  const related = [
    [note.related_contact_ids.length, 'contact', 'contacts'],
    [note.related_calendar_event_ids.length, 'calendar event', 'calendar events'],
    [note.related_mail_thread_ids.length, 'mail thread', 'mail threads'],
    [note.related_project_ids.length, 'project', 'projects'],
  ] as const;
  const links = related.filter(([count]) => count > 0);
  const warning = note.pending_write ? 'A change is waiting for source confirmation.'
    : note.sync_state === 'stale_unreachable' ? 'This source cannot be reached. The note may be out of date.'
    : note.deleted_at != null || note.sync_state === 'tombstoned' ? 'This note was deleted at its source.'
    : note.sync_state === 'orphaned' ? 'This note’s source was removed.' : '';
  return `<div class="work-entity-dialog-backdrop" data-action="close-work-entity-dialog-on-backdrop" data-mode="read">
    <div class="work-entity-dialog work-entity-note-reader" role="dialog" aria-modal="true"
      aria-labelledby="work-entity-dialog-title" data-kind="note" data-mode="read" data-note-id="${e(note.id)}">
      <header class="work-entity-dialog-header">
        <h2 class="work-entity-dialog-title" id="work-entity-dialog-title" tabindex="-1">${e(title)}</h2>
        <button type="button" class="work-entity-dialog-close" data-action="close-work-entity-dialog" aria-label="Close">×</button>
      </header>
      <div class="work-entity-note-content">
        <div class="work-entity-note-meta"><span>${e(sourceLabel)}</span>
          <span>Updated <time datetime="${e(new Date(note.updated_at).toISOString())}">${e(new Date(note.updated_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))}</time></span></div>
        ${warning ? `<p class="work-entity-note-warning" role="status">${e(warning)}</p>` : ''}
        <article class="work-entity-note-body" data-note-body>${e(note.body)}</article>
        ${links.length ? `<details class="work-entity-note-secondary" data-note-section="related"><summary>Related records</summary>
          <p>${e(links.map(([count, singular, plural]) => `${count} ${count === 1 ? singular : plural}`).join(' · '))}</p>
          ${view.can_edit ? '<button type="button" class="work-entity-dialog-cancel" data-action="edit-note-details">Manage related records</button>' : ''}</details>` : ''}
        ${historyHtml ? `<details class="work-entity-note-secondary" data-note-section="activity"><summary>Activity timeline</summary>${historyHtml}</details>` : ''}
      </div>
      <footer class="work-entity-dialog-actions">
        ${view.notice ? `<p data-note-notice class="work-entity-note-notice" role="${view.notice.kind === 'error' ? 'alert' : 'status'}" tabindex="-1">${e(view.notice.text)}</p>` : ''}
        <button type="button" class="work-entity-dialog-cancel" data-action="close-work-entity-dialog">${e(closeLabel)}</button>
        <button type="button" class="work-entity-dialog-cancel" data-action="copy-note-text"${view.copying ? ' aria-disabled="true" aria-busy="true"' : ''}>${view.copying ? 'Copying…' : 'Copy'}</button>
        ${view.can_edit ? `<button type="button" class="work-entity-dialog-submit" data-action="edit-note"${view.opening ? ' aria-disabled="true" aria-busy="true"' : ''}>${view.opening ? 'Opening…' : 'Edit'}</button>` : ''}
      </footer>
    </div>
  </div>`;
};
