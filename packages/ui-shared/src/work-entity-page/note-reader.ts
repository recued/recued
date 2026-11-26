import type { Note } from '@recued/contracts';
import { e } from '../template.js';
import { renderNoteMarkdown } from './note-markdown.js';
import { renderTaskNotes } from './task-notes.js';
import { renderReaderCopyFallback, type WorkReaderCopyView } from './reader-copy.js';

export interface WorkEntityDuplicateView { can_duplicate: boolean; busy?: boolean; from?: string; }
export interface NoteRelatedRecordView {
  key: string; kind: 'contact' | 'project' | 'task'; label: string;
  state: 'loading' | 'ready' | 'missing' | 'unavailable'; opening?: boolean; message?: string;
  can_open?: boolean;
  task?: { source: string; done: boolean; current: boolean; pending: boolean };
}
export interface WorkEntityNoteView {
  entity: Note;
  mode: 'read' | 'edit';
  can_edit: boolean;
  copying?: boolean;
  opening?: boolean;
  format?: 'plain' | 'formatted';
  find?: { open: boolean; query: string; can_search_everywhere?: boolean };
  navigation_html?: string;
  copy?: WorkReaderCopyView;
  task?: { can_create: boolean; disabled?: boolean; busy?: 'create' | 'open'; created?: { title: string } };
  notice?: { kind: 'ok' | 'error'; text: string };
  duplicate?: WorkEntityDuplicateView;
  related?: { records: readonly NoteRelatedRecordView[]; more: boolean };
}

/** A note is useful on its own. Optional relationships and activity never
 *  replace the full text or introduce empty setup sections. */
export const renderNoteReader = (
  view: WorkEntityNoteView,
  sourceLabel: string,
  historyHtml?: string,
  closeLabel?: string,
  inline = false,
): string => {
  const note = view.entity;
  const title = note.title?.trim() || 'Note';
  const formatted = view.format === 'formatted';
  const markdown = formatted ? renderNoteMarkdown(note.body) : null;
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
  const outline = markdown?.headings.length ? `<details class="work-entity-note-outline" data-note-section="outline"><summary>On this page <span>${markdown.headings.length} ${markdown.headings.length === 1 ? 'heading' : 'headings'}</span></summary>
    <nav aria-label="Note headings"><ol>${markdown.headings.map(heading => `<li data-level="${heading.level}"><button type="button" data-action="go-note-heading" data-note-heading-target="${e(heading.id)}" data-note-focus="outline-${e(heading.id)}">${e(heading.text || 'Untitled section')}</button></li>`).join('')}</ol></nav></details>` : '';
  const edit = view.can_edit ? `<button type="button" class="work-entity-dialog-submit" data-action="edit-note"${view.opening ? ' aria-disabled="true" aria-busy="true"' : ''}>${view.opening ? 'Opening…' : 'Edit'}</button>` : '';
  const close = '<button type="button" class="work-entity-dialog-close" data-action="close-work-entity-dialog" aria-label="Close">×</button>';
  const body = `
      <header class="work-entity-dialog-header">
        <h2 class="work-entity-dialog-title" id="work-entity-dialog-title" tabindex="-1">${e(title)}</h2>
        ${inline && edit ? `<div class="work-entity-note-heading-actions">${edit}${close}</div>` : close}
      </header>
      <div class="work-entity-note-display" role="group" aria-label="Note display">
        <button type="button" data-action="set-note-format" data-note-format="plain" data-note-focus="format-plain" aria-pressed="${!formatted}">Plain text</button>
        <button type="button" data-action="set-note-format" data-note-format="formatted" data-note-focus="format-formatted" aria-pressed="${formatted}">Formatted</button>
        <button type="button" data-action="reader-start-top" data-note-focus="start-top">Start from top</button>
        ${view.find ? `<button type="button" data-action="note-find-open" data-note-focus="find-open" aria-expanded="${view.find.open}">Find in note</button>` : ''}
        ${view.copy ? `<button type="button" data-action="work-copy-link" data-note-focus="copy-link"${view.copy.disabled ? ' aria-disabled="true"' : ''}${view.copy.can_link ? '' : ' disabled'}>${view.copy.busy === 'link' ? 'Copying…' : 'Copy link'}</button>` : ''}
      </div>
      ${view.find?.open ? `<div class="work-entity-note-find" role="search" aria-label="Find in this note">
        <input type="search" data-note-find-input data-note-focus="find-input" aria-label="Find in this note" aria-describedby="work-note-find-status" placeholder="Find in this note" value="${e(view.find.query)}" maxlength="512" autocomplete="off" autocapitalize="off" spellcheck="false">
        <div class="work-entity-note-find-controls">
          <button type="button" data-action="note-find-previous" data-note-focus="find-previous" data-note-find-step aria-label="Previous match" disabled>Previous</button>
          <button type="button" data-action="note-find-next" data-note-focus="find-next" data-note-find-step aria-label="Next match" disabled>Next</button>
          <span id="work-note-find-status" data-note-find-status role="status" aria-live="polite" aria-atomic="true">Type to find text.</span>
          <button type="button" data-action="note-find-close" data-note-focus="find-close" aria-label="Close Find">×</button>
        </div>
        ${view.find.can_search_everywhere ? `<button type="button" class="work-entity-note-find-everywhere" data-action="note-find-everywhere" data-note-focus="find-everywhere" data-note-find-everywhere${view.find.query.trim() ? '' : ' disabled'}>Search everywhere</button>` : ''}
      </div>` : ''}
      ${view.navigation_html ?? ''}
      ${inline ? outline : ''}
      <div class="work-entity-note-content">
        <div class="work-entity-note-meta"><span>${e(sourceLabel)}</span>
          <span>Updated <time datetime="${e(new Date(note.updated_at).toISOString())}">${e(new Date(note.updated_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))}</time></span></div>
        ${warning ? `<p class="work-entity-note-warning" role="status">${e(warning)}</p>` : ''}
        ${renderReaderCopyFallback(view.copy, 'note')}
        ${view.duplicate?.from ? `<p class="work-entity-note-meta">Copied from ${e(view.duplicate.from)}.</p>` : ''}
        ${inline ? '' : outline}
        <article class="work-entity-note-body${formatted ? ' work-entity-note-markdown' : ''}" data-note-body>${markdown?.html ?? renderTaskNotes(note.body, 'note')}</article>
        ${links.length ? `<details class="work-entity-note-secondary" data-note-section="related"><summary>Related records</summary>
          <p>${e(links.map(([count, singular, plural]) => `${count} ${count === 1 ? singular : plural}`).join(' · '))}</p>
          ${view.related?.records.length ? `<ul class="work-entity-note-related">${view.related.records.map(record => `<li>
            ${record.state === 'ready' ? `<button type="button" class="work-entity-dialog-cancel" data-action="open-note-related" data-note-related-key="${e(record.key)}" data-note-focus="related-${e(record.key)}" aria-label="Open ${record.kind} ${e(record.label)}"${record.opening ? ' disabled aria-busy="true"' : ''}>${e(record.label)}${record.opening ? ' — Opening…' : ''}</button>`
              : `<span>${e(record.label)}</span>`}
            <small>${record.kind === 'contact' ? 'Contact' : 'Project'}${record.state === 'loading' ? ' · Loading…' : ''}</small>
            ${record.message ? `<p role="status">${e(record.message)}</p>` : ''}
            ${record.state === 'unavailable' || record.state === 'missing' ? `<button type="button" class="work-entity-dialog-cancel" data-action="retry-note-related" data-note-related-key="${e(record.key)}" data-note-focus="retry-${e(record.key)}" aria-label="Try ${e(record.label)} again">Try again</button>` : ''}
          </li>`).join('')}</ul>` : ''}
          ${view.related?.more ? '<button type="button" class="work-entity-dialog-cancel" data-action="more-note-related" data-note-focus="more-related">More related records</button>' : ''}
          ${view.can_edit ? '<button type="button" class="work-entity-dialog-cancel" data-action="edit-note-details">Manage related records</button>' : ''}</details>` : ''}
        ${historyHtml ? `<details class="work-entity-note-secondary" data-note-section="activity"><summary>Activity timeline</summary>${historyHtml}</details>` : ''}
      </div>
      <footer class="work-entity-dialog-actions">
        ${view.task?.created ? `<p class="work-entity-note-notice" data-note-created-task role="status">Task created: ${e(view.task.created.title)} <button type="button" class="work-entity-dialog-cancel" data-action="open-note-created-task" data-note-focus="open-created-task"${view.task.busy || view.task.disabled ? ' aria-disabled="true"' : ''}>${view.task.busy === 'open' ? 'Opening…' : 'Open task'}</button></p>` : ''}
        ${view.notice ? `<p data-note-notice class="work-entity-note-notice" role="${view.notice.kind === 'error' ? 'alert' : 'status'}" tabindex="-1">${e(view.notice.text)}</p>` : ''}
        <button type="button" class="work-entity-dialog-cancel" data-action="close-work-entity-dialog">${e(closeLabel ?? (inline ? 'Close note' : 'Back to notes'))}</button>
        <button type="button" class="work-entity-dialog-cancel" data-action="copy-note-text"${view.copying || view.copy?.disabled ? ' aria-disabled="true"' : ''}${view.copying ? ' aria-busy="true"' : ''}>${view.copying ? 'Copying…' : 'Copy'}</button>
        ${view.task?.can_create ? `<button type="button" class="work-entity-dialog-cancel" data-action="create-note-task" data-note-focus="create-task"${view.task.busy || view.task.disabled ? ' aria-disabled="true"' : ''}${view.task.busy === 'create' ? ' aria-busy="true"' : ''}>${view.task.busy === 'create' ? 'Preparing task…' : 'Create task'}</button>` : ''}
        ${view.duplicate?.can_duplicate ? `<button type="button" class="work-entity-dialog-cancel" data-action="duplicate-work-entity"${view.duplicate.busy ? ' disabled aria-busy="true"' : ''}>${view.duplicate.busy ? 'Opening copy…' : 'Duplicate note'}</button>` : ''}
        ${inline ? '' : edit}
      </footer>
  `;
  const identity = `aria-labelledby="work-entity-dialog-title" data-kind="note" data-mode="read" data-note-id="${e(note.id)}" data-note-format="${formatted ? 'formatted' : 'plain'}"`;
  if (inline) {
    return `<section class="work-entity-dialog work-entity-note-reader work-entity-reader--inline" ${identity}>${body}</section>`;
  }
  return `<div class="work-entity-dialog-backdrop" data-action="close-work-entity-dialog-on-backdrop" data-mode="read">
    <div class="work-entity-dialog work-entity-note-reader" role="dialog" aria-modal="true" ${identity}>${body}</div>
  </div>`;
};
