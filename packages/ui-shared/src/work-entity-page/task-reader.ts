import { dueDayIso, type WorkEntity } from '@recued/contracts';
import { e } from '../template.js';
import { renderTaskNotes } from './task-notes.js';
import { renderTaskDueActions } from '../task-due.js';
import type { NoteRelatedRecordView, WorkEntityDuplicateView } from './note-reader.js';
import { renderReaderCopyFallback, type WorkReaderCopyView } from './reader-copy.js';

type Task = Extract<WorkEntity, { _kind: 'task' }>;
export interface WorkEntityTaskView {
  entity: Task;
  mode: 'read' | 'edit';
  can_edit: boolean;
  opening?: boolean;
  calendar?: { available: boolean; busy?: boolean };
  notice?: string;
  find?: { open: boolean; query: string; can_search_everywhere?: boolean };
  navigation_html?: string;
  reminder_html?: string;
  copy?: WorkReaderCopyView;
  related?: { records: readonly NoteRelatedRecordView[]; more: boolean };
  dependency_summary?: string;
  dependency_list_uncertain?: boolean;
}

export const taskDeadlineLabel = (task: Pick<Task, 'due_at'>): string => task.due_at == null ? 'No due date'
  : dueDayIso(task.due_at) !== null
    ? new Date(task.due_at).toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' })
    : new Date(task.due_at).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

export const taskReaderWarning = (task: Pick<Task, 'pending_write' | 'deleted_at' | 'sync_state'>): string => task.pending_write ? 'A change is waiting for source confirmation.'
  : task.deleted_at != null || task.sync_state === 'tombstoned' ? 'This task was deleted at its source.'
  : task.sync_state === 'orphaned' ? 'This task’s source was removed.'
  : task.sync_state !== 'live' ? 'This source cannot be reached. The task may be out of date.' : '';

/** The saved task is readable without starting a draft. Hosts own all reads,
 * source checks and writes; date shortcuts enter the existing editor. */
export const renderTaskReader = (view: WorkEntityTaskView, context: {
  source_label: string; busy?: boolean; error?: string; history_html?: string; close_label?: string;
  completion?: { can_change: boolean; notice?: string }; duplicate?: WorkEntityDuplicateView;
}): string => {
  const task = view.entity;
  const blocked = context.busy || view.opening ? ' aria-disabled="true" aria-busy="true"' : '';
  const warning = taskReaderWarning(task);
  const meta = (label: string, value: string) => `<div><dt>${e(label)}</dt><dd>${e(value)}</dd></div>`;
  const records = view.related?.records.filter(record => record.kind !== 'task') ?? [];
  const dependencies = view.related?.records.filter(record => record.kind === 'task') ?? [];
  return `<div class="work-entity-dialog-backdrop" data-action="close-work-entity-dialog-on-backdrop" data-mode="read">
    <div class="work-entity-dialog work-entity-task-reader" role="dialog" aria-modal="true" aria-labelledby="work-entity-dialog-title"
      data-kind="task" data-mode="read" data-task-id="${e(task.id)}">
      <header class="work-entity-dialog-header">
        <h2 class="work-entity-dialog-title" id="work-entity-dialog-title" data-task-find-title tabindex="-1">${e(task.title.trim() || 'Task')}</h2>
        <button type="button" class="work-entity-dialog-close" data-action="close-work-entity-dialog" aria-label="Close"${blocked}>×</button>
      </header>
      ${view.find || view.copy ? `<div class="work-entity-note-display" role="group" aria-label="Task tools">
        <button type="button" data-action="reader-start-top" data-task-focus="start-top">Start from top</button>
        ${view.find ? `<button type="button" data-action="task-find-open" data-task-focus="find-open" aria-expanded="${view.find.open}">Find in task</button>` : ''}
        ${view.copy ? `<button type="button" data-action="work-copy-details" data-task-focus="copy-details"${view.copy.disabled ? ' aria-disabled="true"' : ''}>${view.copy.busy === 'details' ? 'Copying…' : 'Copy task details'}</button>
          <button type="button" data-action="work-copy-link" data-task-focus="copy-link"${view.copy.disabled ? ' aria-disabled="true"' : ''}${view.copy.can_link ? '' : ' disabled'}>${view.copy.busy === 'link' ? 'Copying…' : 'Copy link'}</button>` : ''}
      </div>` : ''}
      ${view.find?.open ? `<div class="work-entity-note-find" role="search" aria-label="Find in this task">
        <input type="search" data-task-find-input data-task-focus="find-input" aria-label="Find in this task" aria-describedby="work-task-find-status" placeholder="Find in this task" value="${e(view.find.query)}" maxlength="512" autocomplete="off" autocapitalize="off" spellcheck="false">
        <div class="work-entity-note-find-controls">
          <button type="button" data-action="task-find-previous" data-task-focus="find-previous" data-task-find-step aria-label="Previous match" disabled>Previous</button>
          <button type="button" data-action="task-find-next" data-task-focus="find-next" data-task-find-step aria-label="Next match" disabled>Next</button>
          <span id="work-task-find-status" data-task-find-status role="status" aria-live="polite" aria-atomic="true">Type to find text.</span>
          <button type="button" data-action="task-find-close" data-task-focus="find-close" aria-label="Close Find">×</button>
        </div>
        ${view.find.can_search_everywhere ? `<button type="button" class="work-entity-note-find-everywhere" data-action="task-find-everywhere" data-task-focus="find-everywhere" data-task-find-everywhere${context.busy || view.opening ? ' aria-disabled="true"' : ''}${view.find.query.trim() && !context.busy && !view.opening ? '' : ' disabled'}>Search everywhere</button>` : ''}
      </div>` : ''}
      ${view.navigation_html ?? ''}
      <div class="work-entity-task-content work-entity-task-reader-content">
        <p data-task-completion-status role="status" tabindex="-1">${e(context.completion?.notice ?? (task.done ? 'Task complete.' : 'Task unfinished.'))}</p>
        ${warning ? `<p class="work-entity-note-warning" role="status">${e(warning)}</p>` : ''}
        ${!view.can_edit && !warning ? '<p class="work-entity-note-meta">This task is read-only here.</p>' : ''}
        <dl class="work-entity-task-meta">${meta('Due date', taskDeadlineLabel(task))}${meta('Priority', task.priority ? task.priority[0]!.toUpperCase() + task.priority.slice(1) : 'Not set')}${meta('Source', context.source_label)}</dl>
        ${renderReaderCopyFallback(view.copy, 'task')}
        ${view.reminder_html ?? ''}
        ${view.can_edit ? `<section aria-label="Change task due date">${renderTaskDueActions({ actionAttr: 'data-action', prefix: 'work-entity-task-due', hasDue: task.due_at != null, disabled: Boolean(context.busy || view.opening) })}<p class="work-entity-task-date-hint">Review and save date changes in the editor.</p></section>` : ''}
        ${records.length ? `<section aria-label="Related records"><h3>Related records</h3><ul class="work-entity-note-related">${records.map(record => `<li>
          ${record.state === 'ready' ? `<button type="button" class="work-entity-dialog-cancel" data-action="open-task-related" data-task-related-key="${e(record.key)}" data-task-focus="related-${e(record.key)}" aria-label="Open ${record.kind} ${e(record.label)}"${record.opening || context.busy || view.opening ? ' disabled' : ''}>${e(record.label)}${record.opening ? ' — Opening…' : ''}</button>` : `<span>${e(record.label)}</span>`}
          <small>${record.kind === 'contact' ? 'Assigned contact' : 'Project'}${record.state === 'loading' ? ' · Loading…' : ''}</small>
          ${record.message ? `<p role="status">${e(record.message)}</p>` : ''}
          ${record.state === 'missing' || record.state === 'unavailable' ? `<button type="button" class="work-entity-dialog-cancel" data-action="retry-task-related" data-task-related-key="${e(record.key)}" data-task-focus="retry-${e(record.key)}"${context.busy || view.opening ? ' disabled' : ''}>Try again</button>` : ''}
        </li>`).join('')}</ul></section>` : ''}
        ${dependencies.length ? `<details class="work-entity-note-secondary" data-task-section="dependencies" open><summary>Depends on</summary>
          <p data-task-dependency-summary role="status">${e(view.dependency_summary ?? 'Checking dependencies…')}</p>
          ${view.dependency_list_uncertain ? '<p>The saved dependency list may be out of date.</p>' : ''}
          <ul class="work-entity-note-related">${dependencies.map(record => `<li>
            ${record.state === 'ready' || record.can_open ? `<button type="button" class="work-entity-dialog-cancel" data-action="open-task-related" data-task-related-key="${e(record.key)}" data-task-focus="related-${e(record.key)}" aria-label="Open task ${e(record.label)}"${record.state !== 'ready' || record.opening || context.busy || view.opening ? ' aria-disabled="true" aria-busy="true"' : ''}>${e(record.label)}${record.opening ? ' — Opening…' : ''}</button>` : `<span>${e(record.label)}</span>`}
            <small>${e(record.state === 'loading' ? 'Checking status…' : record.task ? [record.task.source,
              record.task.pending ? 'Change awaiting confirmation' : !record.task.current ? 'Status unconfirmed' : record.task.done ? 'Completed' : 'Open'].filter(Boolean).join(' · ') : 'Status unavailable')}</small>
            ${record.message ? `<p role="status">${e(record.message)}</p>` : ''}
            ${record.state === 'missing' || record.state === 'unavailable' ? `<button type="button" class="work-entity-dialog-cancel" data-action="retry-task-related" data-task-related-key="${e(record.key)}" data-task-focus="retry-${e(record.key)}"${context.busy || view.opening ? ' disabled' : ''}>Try again</button>` : ''}
          </li>`).join('')}</ul>
          ${view.related?.more ? '<button type="button" class="work-entity-dialog-cancel" data-action="more-task-related" data-task-focus="more-dependencies">More dependencies</button>' : ''}
          <button type="button" class="work-entity-dialog-cancel" data-action="refresh-task-dependencies" data-task-focus="refresh-dependencies"${context.busy || view.opening || dependencies.some(record => record.state === 'loading' || record.opening) ? ' aria-disabled="true" aria-busy="true"' : ''}>Check dependencies again</button>
        </details>` : ''}
        ${task.body ? `<section aria-label="Task notes"><h3>Notes</h3><div class="work-entity-task-notes" data-task-find-body>${renderTaskNotes(task.body)}</div></section>` : ''}
        ${context.history_html ? `<details class="work-entity-note-secondary" data-task-section="activity"><summary>Activity timeline</summary>${context.history_html}</details>` : ''}
        ${context.error ? `<div class="work-entity-dialog-submit-error" role="alert" tabindex="-1">${e(context.error)}</div>` : ''}
        ${view.notice ? `<p data-task-notice role="status" tabindex="-1">${e(view.notice)}</p>` : ''}
      </div>
      <footer class="work-entity-dialog-actions">
        ${view.copy?.notice ? `<p class="work-entity-note-notice" data-work-copy-notice role="${view.copy.notice.kind === 'error' ? 'alert' : 'status'}">${e(view.copy.notice.text)}</p>` : ''}
        <button type="button" class="work-entity-dialog-cancel" data-action="close-work-entity-dialog"${blocked}>${e(context.close_label ?? 'Back to tasks')}</button>
        ${context.duplicate?.can_duplicate ? `<button type="button" class="work-entity-dialog-cancel" data-action="duplicate-work-entity"${blocked}${context.duplicate.busy ? ' disabled aria-busy="true"' : ''}>${context.duplicate.busy ? 'Opening copy…' : 'Duplicate task'}</button>` : ''}
        ${view.calendar?.available ? `<button type="button" class="work-entity-dialog-cancel" data-action="schedule-task-calendar" data-task-focus="schedule"${blocked}${view.calendar.busy ? ' disabled aria-busy="true"' : ''}>${view.calendar.busy ? 'Checking task…' : 'Schedule time'}</button>` : ''}
        ${view.can_edit ? `<button type="button" class="work-entity-dialog-cancel" data-action="edit-task"${blocked}>${view.opening ? 'Opening…' : 'Edit'}</button>` : ''}
        ${context.completion?.can_change ? `<button type="button" class="work-entity-dialog-submit" data-action="${task.done ? 'reopen' : 'complete'}-work-entity-task"${blocked}>${context.busy ? (task.done ? 'Reopening…' : 'Completing…') : task.done ? 'Reopen' : 'Complete'}</button>` : ''}
      </footer>
    </div>
  </div>`;
};
