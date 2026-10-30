import { dueDayIso, type Commitment } from '@recued/contracts';
import { e } from '../template.js';

export const commitmentDirectionLabel = (direction: Commitment['direction']): string =>
  ({ outbound: 'I owe', inbound: 'Waiting for others', internal: 'For myself' })[direction];
export const commitmentStatusLabel = (entity: Commitment): string => entity.lifecycle_state === 'pending'
  ? entity.due_status === 'overdue' ? 'Overdue' : entity.due_status === 'due_soon' ? 'Due soon' : 'Open'
  : ({ fulfilled: 'Fulfilled', cancelled: 'Cancelled', expired: 'Expired' })[entity.lifecycle_state];
export const commitmentDeadlineLabel = (entity: Commitment): string => {
  if (entity.promised_for_at === undefined) return 'No deadline';
  const day = dueDayIso(entity.promised_for_at);
  return day !== null
    ? new Date(entity.promised_for_at).toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' })
    : new Date(entity.promised_for_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};
export const commitmentCounterpartyLabel = (entity: Commitment, labels?: Readonly<Record<string, string>>): string =>
  entity.counterparty_contact_id ? labels && Object.hasOwn(labels, entity.counterparty_contact_id)
    ? labels[entity.counterparty_contact_id]! : 'Contact unavailable' : 'No contact linked';

export interface WorkEntityCommitmentView {
  entity: Commitment;
  mode: 'read' | 'edit';
  can_edit: boolean;
  counterparty_label: string;
  opening?: boolean;
  notice?: string;
}

export const renderCommitmentReader = (view: WorkEntityCommitmentView, context: {
  source_label: string; can_fulfill: boolean; can_cancel: boolean; busy?: boolean; error?: string; history_html?: string; close_label?: string;
}): string => {
  const entity = view.entity;
  const warning = entity.pending_write ? 'A change is waiting for source confirmation.'
    : entity.sync_state === 'stale_unreachable' ? 'This source cannot be reached. This promise may be out of date.'
    : entity.deleted_at != null || entity.sync_state === 'tombstoned' ? 'This promise was deleted at its source.'
    : entity.sync_state === 'orphaned' ? 'This promise’s source was removed.' : '';
  const blocked = context.busy || view.opening ? ' aria-disabled="true" aria-busy="true"' : '';
  const meta = (label: string, value: string) => `<div><dt>${e(label)}</dt><dd>${e(value)}</dd></div>`;
  return `<div class="work-entity-dialog-backdrop" data-action="close-work-entity-dialog-on-backdrop" data-mode="read">
    <div class="work-entity-dialog work-entity-commitment-reader" role="dialog" aria-modal="true" aria-labelledby="work-entity-dialog-title" data-kind="commitment" data-mode="read" data-commitment-id="${e(entity.id)}">
      <header class="work-entity-dialog-header"><h2 class="work-entity-dialog-title" id="work-entity-dialog-title" tabindex="-1">${e(commitmentDirectionLabel(entity.direction))}</h2>
        <button type="button" class="work-entity-dialog-close" data-action="close-work-entity-dialog" aria-label="Close"${blocked}>×</button></header>
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
        ${context.history_html ? `<details class="work-entity-note-secondary"><summary>Activity timeline</summary>${context.history_html}</details>` : ''}
      </div>
      <footer class="work-entity-dialog-actions">
        <button type="button" class="work-entity-dialog-cancel" data-action="close-work-entity-dialog"${blocked}>${e(context.close_label ?? 'Back to commitments')}</button>
        ${view.can_edit ? `<button type="button" class="work-entity-dialog-cancel" data-action="edit-commitment"${blocked}>${view.opening ? 'Opening…' : 'Edit'}</button>` : ''}
        ${context.can_fulfill ? `<button type="button" class="work-entity-dialog-submit" data-action="fulfill-work-entity-commitment"${blocked}>Mark fulfilled</button>` : ''}
        ${context.can_cancel ? `<button type="button" class="work-entity-dialog-cancel" data-action="cancel-work-entity-commitment"${blocked}>Cancel commitment</button>` : ''}
      </footer>
    </div>
  </div>`;
};
