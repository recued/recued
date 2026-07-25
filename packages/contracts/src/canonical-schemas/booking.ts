/** D-210 — canonical `booking` schema.
 *
 *  A reservation is TWO rows, and this is the BUSINESS one. The other is
 *  the sealed `reception_form_submission` — what the visitor asked for.
 *  There is no third: booking and calendar are DISJOINT (A.2).
 *
 *  🔑 THE BOOKING OWNS ITS OWN TIME (`slot_start_at` / `slot_end_at`).
 *  This reverses the original no-time-field ruling on a CHANGED PREMISE:
 *  that ruling rested on a calendar event owning the slot, and under A.2
 *  a booking is never in the calendar, so there is no other owner to
 *  defer to. A centre cannot depend on an absent leaf for a core
 *  attribute.
 *
 *  ⚠ The original ruling's REASONING still binds, and is why there are
 *  TWO columns and not three: `duration_minutes` is derived, never
 *  stored, because a fact held twice is a fact that can drift.
 *
 *  ⛔ `lifecycle_state` is NOT the calendar's `status`. `CalendarEvent`
 *  already carries `'confirmed' | 'cancelled' | 'tentative'` — an
 *  iCalendar protocol field about the EVENT. Re-spelling that
 *  vocabulary here would be exactly the double ownership above. The
 *  business axis answers a question the protocol one cannot: a customer
 *  who never turned up leaves the event `confirmed` forever.
 *
 *  Spec: D-210 Appendix A. */

import {
  BOOKING_DEFAULT_LIFECYCLE_STATE,
  BOOKING_LIFECYCLE_STATES,
  BOOKING_TITLE_MAX,
} from '../work-entities.js';
import type { CanonicalSchema } from './shape.js';

export const BOOKING_SCHEMA: CanonicalSchema = {
  kind: 'booking',
  fields: [
    { name: 'id', type: 'uuid', auto: true },
    { name: 'title', type: 'text', max_length: BOOKING_TITLE_MAX },
    {
      name: 'lifecycle_state',
      type: 'enum',
      enum_values: BOOKING_LIFECYCLE_STATES,
      // ⚠ NOT BOOKING_LIFECYCLE_STATES[0]. `pending` sorts first for
      // narrative reasons but nothing in Recued writes it — the
      // reception path mints only at APPROVE, so the approval IS the
      // confirmation. Carried for owner- or pack-authored flows that
      // genuinely have a pre-confirmation step.
      default: BOOKING_DEFAULT_LIFECYCLE_STATE,
    },
    { name: 'created_at', type: 'timestamp', auto: true },
    { name: 'updated_at', type: 'timestamp', auto: true },
    { name: 'state_changed_at', type: 'timestamp', auto: true },
    {
      name: 'slot_start_at',
      type: 'timestamp',
      nullable: true,
      description:
        "When the booking starts — the booking's own fact, not a calendar event's (D-210 A.2). Populated together with slot_end_at or not at all; a start with no end is a corrupt time. Absent is a real state: an enquiry can exist before a time is agreed.",
    },
    {
      name: 'slot_end_at',
      type: 'timestamp',
      nullable: true,
      description:
        'When the booking ends. Populated together with slot_start_at. Duration is derived (slot_end_at - slot_start_at) and deliberately never stored, so it cannot drift from the pair that defines it.',
    },
    {
      name: 'monetary_amount',
      type: 'text',
      nullable: true,
      description:
        'Decimal-as-string at scale 2 (-?\\d+(\\.\\d{1,2})?). Storage flattens monetary_value to monetary_amount + monetary_currency for indexing ergonomics; the conceptual contract is one nullable value object — both NULL or both populated.',
    },
    {
      name: 'monetary_currency',
      type: 'text',
      nullable: true,
      max_length: 3,
      description:
        'ISO 4217 three-letter currency code (^[A-Z]{3}$). Populated together with monetary_amount.',
    },
    {
      name: 'reception_record_id',
      type: 'text',
      nullable: true,
      description:
        'The reception_booking_request.request_id this was promoted from. Absent for an owner-authored booking.',
    },
  ],
  relationships: [
    { name: 'counterparty_contact', ref: 'data.contact', cardinality: 'one', nullable: true },
  ],
  indices: [
    ['lifecycle_state', 'created_at'],
    ['counterparty_contact', 'lifecycle_state'],
    ['slot_start_at'],
    ['reception_record_id'],
  ],
};
