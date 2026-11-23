import { dueDayIso, type Commitment } from '@recued/contracts';
import { e } from '../template.js';
import { renderReaderCopyFallback, type WorkReaderCopyView } from './reader-copy.js';
import { renderCommitmentEvidence } from './commitment-evidence.js';
import { renderCommitmentRelated, type CommitmentRelatedView } from './commitment-related.js';

export const commitmentDirectionLabel = (direction: Commitment['direction']): string =>
  ({ outbound: 'I owe', inbound: 'Waiting for others', internal: 'For myself' })[direction];
export const commitmentStatusLabel = (entity: Pick<Commitment, 'lifecycle_state' | 'due_status'>): string => entity.lifecycle_state === 'pending'
  ? entity.due_status === 'overdue' ? 'Overdue' : entity.due_status === 'due_soon' ? 'Due soon' : 'Open'
  : ({ fulfilled: 'Fulfilled', cancelled: 'Cancelled', expired: 'Expired' })[entity.lifecycle_state];
export const commitmentDeadlineLabel = (entity: Pick<Commitment, 'promised_for_at'>): string => {
  if (entity.promised_for_at === undefined) return 'No deadline';
  const day = dueDayIso(entity.promised_for_at);
  return day !== null
    ? new Date(entity.promised_for_at).toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' })
    : new Date(entity.promised_for_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};
export const commitmentCounterpartyLabel = (entity: Commitment, labels?: Readonly<Record<string, string>>): string =>
  entity.counterparty_contact_id ? labels && Object.hasOwn(labels, entity.counterparty_contact_id)
    ? labels[entity.counterparty_contact_id]! : 'Contact unavailable' : 'No contact linked';

export const commitmentReaderWarning = (entity: Pick<Commitment, 'pending_write' | 'sync_state' | 'deleted_at'>): string => entity.pending_write ? 'A change is waiting for source confirmation.'
    : entity.sync_state === 'stale_unreachable' ? 'This source cannot be reached. This promise may be out of date.'
    : entity.deleted_at != null || entity.sync_state === 'tombstoned' ? 'This promise was deleted at its source.'
    : entity.sync_state === 'orphaned' ? 'This promise’s source was removed.' : '';

export interface WorkEntityCommitmentView {
  entity: Commitment;
  mode: 'read' | 'edit';
  can_edit: boolean;
  counterparty_label: string;
  opening?: boolean;
  notice?: string;
  reminder_html?: string;
  follow_up?: { available: boolean; busy?: boolean; checking?: boolean; error?: string; message?: string };
  related?: CommitmentRelatedView;
  copy?: WorkReaderCopyView;
  chat?: { available: boolean; busy?: boolean; error?: string };
  project_link?: { title: string; linked: boolean };
}

export const renderCommitmentReader = (view: WorkEntityCommitmentView, context: {
  source_label: string; can_fulfill: boolean; can_cancel: boolean; busy?: boolean; error?: string; history_html?: string; close_label?: string;
}): string => {
  const entity = view.entity;
  const warning = commitmentReaderWarning(entity);
  const blocked = context.busy || view.opening ? ' aria-disabled="true" aria-busy="true"' : '';
  const meta = (label: string, value: string) => `<div><dt>${e(label)}</dt><dd>${e(value)}</dd></div>`;
  return `<div class="work-entity-dialog-backdrop" data-action="close-work-entity-dialog-on-backdrop" data-mode="read">
    <div class="work-entity-dialog work-entity-commitment-reader" role="dialog" aria-modal="true" aria-labelledby="work-entity-dialog-title" data-kind="commitment" data-mode="read" data-commitment-id="${e(entity.id)}">
      <header class="work-entity-dialog-header"><h2 class="work-entity-dialog-title" id="work-entity-dialog-title" tabindex="-1">${e(commitmentDirectionLabel(entity.direction))}</h2>
        <button type="button" class="work-entity-dialog-close" data-action="close-work-entity-dialog" aria-label="Close"${blocked}>×</button></header>
      ${view.copy || view.chat?.available ? `<div class="work-entity-note-display" role="group" aria-label="Commitment tools">
        ${view.copy ? `<button type="button" data-action="work-copy-details" data-commitment-focus="copy-details"${view.copy.disabled ? ' aria-disabled="true"' : ''}>${view.copy.busy === 'details' ? 'Copying…' : 'Copy summary'}</button>
          <button type="button" data-action="work-copy-link" data-commitment-focus="copy-link"${view.copy.disabled ? ' aria-disabled="true"' : ''}${view.copy.can_link ? '' : ' disabled'}>${view.copy.busy === 'link' ? 'Copying…' : 'Copy link'}</button>` : ''}
        ${view.chat?.available ? `<button type="button" data-action="chat-about-commitment" data-commitment-focus="chat"${blocked}${view.chat.busy ? ' disabled aria-busy="true"' : ''}>${view.chat.busy ? 'Checking commitment…' : 'Chat about this'}</button>` : ''}
      </div>` : ''}
      <div class="work-entity-commitment-content">
        <p class="work-entity-commitment-statement">${e(entity.statement)}</p>
        <p data-commitment-status role="status" tabindex="-1" class="work-entity-commitment-status${entity.lifecycle_state === 'pending' && entity.due_status === 'overdue' ? ' is-overdue' : ''}">${e(commitmentStatusLabel(entity))}</p>
        ${warning ? `<p class="work-entity-note-warning" role="status">${e(warning)}</p>` : ''}
        ${!view.can_edit && !context.can_fulfill && !context.can_cancel && !warning ? '<p class="work-entity-note-warning">This promise is read-only here.</p>' : ''}
        ${context.busy ? '<p role="status">Saving change…</p>' : ''}
        <dl class="work-entity-commitment-meta">${meta('With', view.counterparty_label)}${meta('Deadline', commitmentDeadlineLabel(entity))}${meta('Source', context.source_label)}
          ${entity.monetary_value ? meta('Amount', `${entity.monetary_value.amount} ${entity.monetary_value.currency}`) : ''}</dl>
        ${context.error ? `<div class="work-entity-dialog-submit-error" role="alert" tabindex="-1">${e(context.error)}</div>` : ''}
        ${view.notice ? `<p role="status" data-commitment-notice tabindex="-1">${e(view.notice)}</p>` : ''}
        ${view.follow_up?.error ? `<p role="alert" data-commitment-follow-up-error>${e(view.follow_up.error)}</p>` : ''}
        ${view.follow_up?.message ? `<p role="status">${e(view.follow_up.message)}</p>` : ''}
        ${view.project_link ? `<p class="work-entity-note-warning">${e(view.project_link.linked
          ? `Already linked to ${view.project_link.title}.` : `Project: ${view.project_link.title}`)}</p>` : ''}
        ${view.chat?.error ? `<p role="alert" data-commitment-chat-error>${e(view.chat.error)}</p>` : ''}
        ${renderReaderCopyFallback(view.copy, 'commitment')}
        ${view.reminder_html ?? ''}
        ${renderCommitmentRelated(view.related)}
        ${renderCommitmentEvidence(entity)}
        ${context.history_html ? `<details class="work-entity-note-secondary" data-commitment-section="activity"><summary>Activity timeline</summary>${context.history_html}</details>` : ''}
      </div>
      <footer class="work-entity-dialog-actions">
        ${view.copy?.notice ? `<p class="work-entity-note-notice" data-work-copy-notice role="${view.copy.notice.kind === 'error' ? 'alert' : 'status'}">${e(view.copy.notice.text)}</p>` : ''}
        <button type="button" class="work-entity-dialog-cancel" data-action="close-work-entity-dialog"${blocked}>${e(context.close_label ?? 'Back to commitments')}</button>
        ${view.follow_up?.available ? `<button type="button" class="work-entity-dialog-cancel" data-action="draft-commitment-follow-up"${blocked}${view.follow_up.busy ? ' disabled aria-busy="true"' : ''}>${view.follow_up.checking ? 'Checking email…' : view.follow_up.busy ? 'Opening…' : 'Draft follow-up'}</button>` : ''}
        ${view.can_edit ? `<button type="button" class="work-entity-dialog-cancel" data-action="edit-commitment"${blocked}>${view.opening ? 'Opening…' : 'Edit'}</button>` : ''}
        ${view.can_edit && view.project_link && !view.project_link.linked ? `<button type="button" class="work-entity-dialog-cancel" data-action="link-commitment-to-project"${blocked}>Link to project</button>` : ''}
        ${context.can_fulfill ? `<button type="button" class="work-entity-dialog-submit" data-action="fulfill-work-entity-commitment"${blocked}>Mark fulfilled</button>` : ''}
        ${context.can_cancel ? `<button type="button" class="work-entity-dialog-cancel" data-action="cancel-work-entity-commitment"${blocked}>Cancel commitment</button>` : ''}
      </footer>
    </div>
  </div>`;
};
