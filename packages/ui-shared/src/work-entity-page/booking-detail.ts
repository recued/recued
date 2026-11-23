import type {
  Booking,
  BookingHistorySummary,
} from '@recued/contracts';
import { renderReaderCopyFallback, type WorkReaderCopyView } from './reader-copy.js';
import { e } from '../template.js';

export interface BookingReaderActionsView {
  customer: { state: 'loading' | 'ready' | 'missing' | 'error' | 'none'; label: string; message?: string; can_open: boolean; can_retry: boolean };
  can_email: boolean; can_history: boolean; busy?: 'contact' | 'mail' | 'history'; busy_key?: string; error?: string;
  history?: ReadonlyArray<{ key: string; error?: string }>;
}

export interface BookingDetailProps {
  readonly booking: Booking;
  readonly history?: BookingHistorySummary;
  readonly actions?: BookingReaderActionsView;
  readonly copy?: WorkReaderCopyView;
  readonly chat?: { available: boolean; busy?: boolean; error?: string };
  readonly close_label?: string;
  readonly can_mint_manage_link?: boolean;
  readonly manage_link_busy?: boolean;
  readonly manage_link_notice?: { readonly kind: 'ok' | 'error'; readonly text: string };
}

export const bookingTimeLabel = (value: number | undefined): string =>
  value === undefined ? 'Not set' : new Date(value).toLocaleString();

const dateTime = bookingTimeLabel;
export const bookingReaderWarning = (booking: Booking): string | undefined => booking.pending_write ? 'A change is waiting for source confirmation.'
  : booking.sync_state === 'orphaned' ? 'This booking’s source was removed.' : booking.sync_state !== 'live' ? 'This source cannot be reached. The booking may be out of date.' : undefined;

const money = (booking: Booking): string =>
  booking.monetary_value === undefined
    ? 'Not set'
    : `${booking.monetary_value.amount} ${booking.monetary_value.currency}`;

/** Owner-only booking detail. The history projection contains opaque contact
 * ids and terminal booking facts only; no visitor email or Reception values. */
export const renderBookingDetail = (props: BookingDetailProps): string => {
  const { booking, history, actions } = props;
  const blocked = actions?.busy ? ' disabled aria-busy="true"' : '';
  const canMintManageLink = props.can_mint_manage_link === true
    && typeof booking.reception_record_id === 'string'
    && booking.reception_record_id.length > 0;
  const manageLinkButton = canMintManageLink
    ? `<button type="button" class="work-entity-booking-manage" data-action="copy-booking-manage-link"
        data-entity-id="${e(booking.id)}"${props.manage_link_busy === true ? ' disabled' : ''}>${
          props.manage_link_busy === true ? 'Minting link…' : 'Copy reschedule link'
        }</button>`
    : '';
  const manageLinkNotice = props.manage_link_notice === undefined
    ? ''
    : `<p class="work-entity-booking-manage-notice work-entity-booking-manage-notice--${
        props.manage_link_notice.kind
      }" role="${props.manage_link_notice.kind === 'error' ? 'alert' : 'status'}">${
        e(props.manage_link_notice.text)
      }</p>`;
  const historyHtml = history === undefined
    ? '<p class="work-entity-booking-history-empty">No linked customer history.</p>'
    : history.entries.length === 0
      ? '<p class="work-entity-booking-history-empty">No previous completed or no-show bookings.</p>'
      : `<ul class="work-entity-booking-history">${history.entries.map((entry) => `
          <li>
            <strong>${e(entry.title)}</strong>
            <span>${e(entry.lifecycle_state.replace('_', ' '))}</span>
            <time>${e(dateTime(entry.slot_start_at ?? entry.state_changed_at))}</time>
            ${actions?.can_history ? (() => { const row = actions.history?.find(row => row.key === JSON.stringify([entry.id, entry.created_at]));
              return row ? `<div class="work-entity-booking-history-action"><button type="button" class="data-button" data-action="booking-open-history" data-booking-history-key="${e(row.key)}" data-booking-focus="history:${e(row.key)}" aria-label="Open previous booking ${e(entry.title)}"${blocked}>${actions.busy === 'history' && actions.busy_key === row.key ? 'Checking booking…' : row.error ? 'Try booking again' : 'Open booking'}</button>
                ${row.error ? `<p role="alert">${e(row.error)}</p>` : ''}</div>` : ''; })() : ''}
          </li>`).join('')}
        </ul>`;
  return `
    <section class="work-entity-booking-detail" data-kind="booking" data-booking-id="${e(booking.id)}">
      <div class="work-entity-booking-detail-nav">
        <button type="button" class="work-entity-booking-back" data-action="close-booking-detail" data-booking-focus="back">${e(props.close_label ?? 'Back to bookings')}</button>
        <div class="work-entity-booking-detail-actions">
          ${manageLinkButton}
          <button type="button" class="work-entity-booking-edit" data-action="edit-booking-detail"
            data-entity-id="${e(booking.id)}" data-kind="booking" data-booking-focus="edit">Edit / reschedule</button>
        </div>
      </div>
      ${manageLinkNotice}
      <div class="work-entity-booking-detail-actions">
        ${props.copy ? `<button type="button" class="data-button" data-action="work-copy-details" data-booking-focus="copy-details"${props.copy.disabled ? ' aria-disabled="true"' : ''}>Copy summary</button>${props.copy.can_link ? `<button type="button" class="data-button" data-action="work-copy-link" data-booking-focus="copy-link"${props.copy.disabled ? ' aria-disabled="true"' : ''}>Copy link</button>` : ''}` : ''}
        ${props.chat?.available ? `<button type="button" class="data-button" data-action="chat-about-booking" data-booking-focus="chat"${props.chat.busy || actions?.busy ? ' disabled' : ''}>${props.chat.busy ? 'Checking booking…' : 'Chat about this'}</button>` : ''}
      </div>
      ${props.copy?.notice ? `<p role="status" data-work-copy-notice>${e(props.copy.notice.text)}</p>` : ''}
      ${renderReaderCopyFallback(props.copy, 'booking')}
      ${props.chat?.error ? `<p role="alert" data-booking-chat-error>${e(props.chat.error)}</p>` : ''}
      ${actions?.can_email ? `<p><button type="button" class="data-button" data-action="booking-draft-email" data-booking-focus="mail"${blocked}>${actions.busy === 'mail' ? 'Checking booking…' : 'Draft email'}</button></p>` : ''}
      ${actions?.error ? `<p role="alert" data-booking-action-error>${e(actions.error)}</p>` : ''}
      <header>
        <p class="work-entity-booking-kicker">Booking</p>
        <h1 tabindex="-1" data-booking-focus="heading">${e(booking.title)}</h1>
        <span class="work-entity-booking-state">${e(booking.lifecycle_state.replace('_', ' '))}</span>
      </header>
      <dl class="work-entity-booking-facts">
        <div><dt>Starts</dt><dd>${e(dateTime(booking.slot_start_at))}</dd></div>
        <div><dt>Ends</dt><dd>${e(dateTime(booking.slot_end_at))}</dd></div>
        <div><dt>Value</dt><dd>${e(money(booking))}</dd></div>
        <div><dt>Customer</dt><dd data-booking-customer-state="${actions?.customer.state ?? 'missing'}">${e(actions?.customer.label ?? (booking.counterparty_contact_id ? 'Customer unavailable' : 'Not linked'))}
          ${actions?.customer.message ? `<p role="status">${e(actions.customer.message)}</p>` : ''}
          ${actions?.customer.can_open ? `<button type="button" class="data-button" data-action="booking-open-customer" data-booking-focus="customer"${blocked}>${actions.busy === 'contact' ? 'Checking customer…' : 'Open contact'}</button>` : ''}
          ${actions?.customer.can_retry && (actions.customer.state === 'error' || actions.customer.state === 'missing') ? `<button type="button" class="data-button" data-action="booking-retry-customer" data-booking-focus="retry-customer"${blocked}>Try customer again</button>` : ''}
        </dd></div>
        <div><dt>Created</dt><dd>${e(dateTime(booking.created_at))}</dd></div>
        <div><dt>Last updated</dt><dd>${e(dateTime(booking.updated_at))}</dd></div>
      </dl>
      <section class="work-entity-booking-history-section">
        <h2>Previous bookings${history !== undefined ? ` (${history.total})` : ''}</h2>
        ${history && history.total > history.entries.length ? `<p>Showing ${history.entries.length} of ${history.total} previous bookings.</p>` : ''}
        ${historyHtml}
      </section>
    </section>
  `;
};
