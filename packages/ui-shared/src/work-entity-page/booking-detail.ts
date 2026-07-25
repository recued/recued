import type {
  Booking,
  BookingHistorySummary,
} from '@recued/contracts';
import { e } from '../template.js';

export interface BookingDetailProps {
  readonly booking: Booking;
  readonly history?: BookingHistorySummary;
  readonly can_mint_manage_link?: boolean;
  readonly manage_link_busy?: boolean;
  readonly manage_link_notice?: { readonly kind: 'ok' | 'error'; readonly text: string };
}

const dateTime = (value: number | undefined): string =>
  value === undefined ? 'Not set' : new Date(value).toLocaleString();

const money = (booking: Booking): string =>
  booking.monetary_value === undefined
    ? 'Not set'
    : `${booking.monetary_value.amount} ${booking.monetary_value.currency}`;

/** Owner-only booking detail. The history projection contains opaque contact
 * ids and terminal booking facts only; no visitor email or Reception values. */
export const renderBookingDetail = (props: BookingDetailProps): string => {
  const { booking, history } = props;
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
          </li>`).join('')}
        </ul>`;
  return `
    <section class="work-entity-booking-detail" data-booking-id="${e(booking.id)}">
      <div class="work-entity-booking-detail-nav">
        <button type="button" class="work-entity-booking-back" data-action="close-booking-detail">Back to bookings</button>
        <div class="work-entity-booking-detail-actions">
          ${manageLinkButton}
          <button type="button" class="work-entity-booking-edit" data-action="edit-booking-detail"
            data-entity-id="${e(booking.id)}" data-kind="booking">Edit / reschedule</button>
        </div>
      </div>
      ${manageLinkNotice}
      <header>
        <p class="work-entity-booking-kicker">Booking</p>
        <h1>${e(booking.title)}</h1>
        <span class="work-entity-booking-state">${e(booking.lifecycle_state.replace('_', ' '))}</span>
      </header>
      <dl class="work-entity-booking-facts">
        <div><dt>Starts</dt><dd>${e(dateTime(booking.slot_start_at))}</dd></div>
        <div><dt>Ends</dt><dd>${e(dateTime(booking.slot_end_at))}</dd></div>
        <div><dt>Value</dt><dd>${e(money(booking))}</dd></div>
        <div><dt>Customer ID</dt><dd>${e(booking.counterparty_contact_id ?? 'Not linked')}</dd></div>
        <div><dt>Created</dt><dd>${e(dateTime(booking.created_at))}</dd></div>
        <div><dt>Last updated</dt><dd>${e(dateTime(booking.updated_at))}</dd></div>
      </dl>
      <section class="work-entity-booking-history-section">
        <h2>Previous bookings${history !== undefined ? ` (${history.total})` : ''}</h2>
        ${historyHtml}
      </section>
    </section>
  `;
};
