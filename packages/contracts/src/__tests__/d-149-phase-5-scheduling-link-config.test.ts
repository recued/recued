/** D-149 P5 § A.5.2 — `SchedulingLinkConfig` + booking validator tests.
 *
 *  Covers:
 *    - Closed-shape gate on every required field.
 *    - Duration option allowlist + cardinality cap.
 *    - Window-definition XOR-ish (requires SI ref OR explicit_windows).
 *    - Visitor-field requirement closed shape (name=='required', etc.).
 *    - Notification target closed list.
 *    - Booking validator: required fields, slot bounds, advance/lead-time
 *      gates, duration-not-offered defense. */

import { describe, expect, it } from 'vitest';
import {
  RECEPTION_RPC_ERROR_CODE_SET,
  SCHEDULING_LINK_DURATION_OPTION_MINUTES_ALLOWED,
  SCHEDULING_LINK_DURATION_OPTION_MINUTES_SET,
  SCHEDULING_LINK_BOOKING_PROCESSING_OUTCOMES,
  SCHEDULING_LINK_BOOKING_PROCESSING_OUTCOME_SET,
  SCHEDULING_LINK_DISPLAY_NAME_MAX,
  SCHEDULING_LINK_INSTRUCTIONS_MAX,
  SCHEDULING_LINK_SUCCESS_MESSAGE_MAX,
  SCHEDULING_LINK_VISITOR_NAME_MAX,
  SCHEDULING_LINK_VISITOR_EMAIL_MAX,
  SCHEDULING_LINK_VISITOR_TOPIC_MAX,
  SCHEDULING_LINK_VISITOR_NOTES_MAX,
  SCHEDULING_LINK_VISITOR_PHONE_MAX,
  validateSchedulingLinkBooking,
  validateSchedulingLinkConfig,
  type SchedulingLinkBookingInput,
  type SchedulingLinkConfig,
} from '../index.js';

const goodConfig: SchedulingLinkConfig = {
  display_name: 'Mary Smith',
  instructions: 'Book a 30-minute consult.',
  success_message: "Confirmed; I'll email you shortly.",
  duration_options_minutes: [30, 60],
  available_window_definition: {
    tz: 'America/New_York',
    explicit_windows: [
      { day_of_week: 1, start_minute: 9 * 60, end_minute: 17 * 60 },
      { day_of_week: 2, start_minute: 9 * 60, end_minute: 17 * 60 },
    ],
  },
  required_visitor_fields: {
    name: 'required',
    email: 'required',
    topic: 'optional',
    phone: 'omit',
    notes: 'optional',
  },
  min_advance_notice_hours: 24,
  max_lead_time_days: 30,
  max_bookings_per_day: 0,
  on_booking: {
    create_calendar_event: true,
    create_commitment_entity: true,
  },
};

describe('D-149 P5 § A.5.2 — validateSchedulingLinkConfig', () => {
  it('accepts a minimal valid config', () => {
    expect(validateSchedulingLinkConfig(goodConfig)).toEqual([]);
  });

  it('rejects non-object input', () => {
    expect(validateSchedulingLinkConfig(null)[0]?.code).toBe('config_shape_invalid');
    expect(validateSchedulingLinkConfig(undefined as unknown)[0]?.code).toBe(
      'config_shape_invalid',
    );
    expect(validateSchedulingLinkConfig([])[0]?.code).toBe('config_shape_invalid');
    expect(validateSchedulingLinkConfig('mary')[0]?.code).toBe('config_shape_invalid');
  });

  it('rejects empty display_name', () => {
    const c = { ...goodConfig, display_name: '   ' } as unknown;
    const failures = validateSchedulingLinkConfig(c);
    expect(failures.some((f) => f.code === 'display_name_empty')).toBe(true);
  });

  it('rejects display_name over the cap', () => {
    const c = { ...goodConfig, display_name: 'A'.repeat(SCHEDULING_LINK_DISPLAY_NAME_MAX + 1) };
    const failures = validateSchedulingLinkConfig(c);
    expect(failures.some((f) => f.code === 'display_name_too_long')).toBe(true);
  });

  it('rejects instructions over the cap', () => {
    const c = {
      ...goodConfig,
      instructions: 'A'.repeat(SCHEDULING_LINK_INSTRUCTIONS_MAX + 1),
    };
    expect(validateSchedulingLinkConfig(c).some((f) => f.code === 'instructions_too_long')).toBe(
      true,
    );
  });

  it('rejects non-string instructions', () => {
    const c = { ...goodConfig, instructions: 42 as unknown };
    expect(validateSchedulingLinkConfig(c).some((f) => f.code === 'instructions_too_long')).toBe(
      true,
    );
  });

  it('rejects success_message over the cap', () => {
    const c = {
      ...goodConfig,
      success_message: 'A'.repeat(SCHEDULING_LINK_SUCCESS_MESSAGE_MAX + 1),
    };
    expect(
      validateSchedulingLinkConfig(c).some((f) => f.code === 'success_message_too_long'),
    ).toBe(true);
  });

  it('rejects duration_options not in the closed list', () => {
    const c = { ...goodConfig, duration_options_minutes: [7] };
    const failures = validateSchedulingLinkConfig(c);
    expect(failures.some((f) => f.code === 'duration_option_invalid')).toBe(true);
  });

  it('rejects empty duration_options', () => {
    const c = { ...goodConfig, duration_options_minutes: [] };
    expect(validateSchedulingLinkConfig(c).some((f) => f.code === 'duration_options_empty')).toBe(
      true,
    );
  });

  it('rejects too many duration options', () => {
    const c = { ...goodConfig, duration_options_minutes: [15, 30, 60, 90, 120] };
    expect(
      validateSchedulingLinkConfig(c).some((f) => f.code === 'duration_option_too_many'),
    ).toBe(true);
  });

  it('requires either standing_instructions_ref OR explicit_windows', () => {
    const c = {
      ...goodConfig,
      available_window_definition: { tz: 'America/New_York' },
    } as unknown;
    expect(
      validateSchedulingLinkConfig(c).some((f) => f.code === 'window_definition_empty'),
    ).toBe(true);
  });

  it('rejects empty explicit_windows array', () => {
    const c = {
      ...goodConfig,
      available_window_definition: {
        tz: 'America/New_York',
        explicit_windows: [],
      },
    };
    expect(
      validateSchedulingLinkConfig(c).some((f) => f.code === 'window_definition_empty'),
    ).toBe(true);
  });

  it('rejects explicit_window with invalid day_of_week / minutes', () => {
    const c = {
      ...goodConfig,
      available_window_definition: {
        tz: 'America/New_York',
        explicit_windows: [{ day_of_week: 8, start_minute: 540, end_minute: 1020 }],
      },
    };
    expect(
      validateSchedulingLinkConfig(c).some((f) => f.code === 'explicit_window_invalid'),
    ).toBe(true);
  });

  it('rejects explicit_window where end_minute ≤ start_minute', () => {
    const c = {
      ...goodConfig,
      available_window_definition: {
        tz: 'America/New_York',
        explicit_windows: [{ day_of_week: 1, start_minute: 540, end_minute: 540 }],
      },
    };
    expect(
      validateSchedulingLinkConfig(c).some((f) => f.code === 'explicit_window_invalid'),
    ).toBe(true);
  });

  it('rejects empty tz', () => {
    const c = {
      ...goodConfig,
      available_window_definition: { tz: '', explicit_windows: [{ day_of_week: 1, start_minute: 540, end_minute: 1020 }] },
    };
    expect(validateSchedulingLinkConfig(c).some((f) => f.code === 'tz_empty')).toBe(true);
  });

  it('rejects empty standing_instructions_ref when present', () => {
    const c = {
      ...goodConfig,
      available_window_definition: {
        tz: 'America/New_York',
        standing_instructions_ref: '',
      },
    };
    const failures = validateSchedulingLinkConfig(c);
    expect(
      failures.some(
        (f) =>
          f.code === 'window_definition_empty' || f.code === 'standing_instructions_ref_invalid',
      ),
    ).toBe(true);
  });

  it('rejects required_visitor_fields where name is not "required"', () => {
    const c = {
      ...goodConfig,
      required_visitor_fields: {
        name: 'optional',
        email: 'required',
        topic: 'optional',
        phone: 'omit',
        notes: 'optional',
      },
    } as unknown;
    expect(
      validateSchedulingLinkConfig(c).some((f) => f.code === 'visitor_fields_invalid'),
    ).toBe(true);
  });

  it('rejects required_visitor_fields with unknown enum value', () => {
    const c = {
      ...goodConfig,
      required_visitor_fields: {
        name: 'required',
        email: 'maybe',
        topic: 'optional',
        phone: 'omit',
        notes: 'optional',
      },
    } as unknown;
    expect(
      validateSchedulingLinkConfig(c).some((f) => f.code === 'visitor_fields_invalid'),
    ).toBe(true);
  });

  it('rejects min_advance_notice_hours out of range', () => {
    const negative = { ...goodConfig, min_advance_notice_hours: -1 };
    expect(
      validateSchedulingLinkConfig(negative).some(
        (f) => f.code === 'min_advance_notice_out_of_range',
      ),
    ).toBe(true);
    const too_big = { ...goodConfig, min_advance_notice_hours: 999 };
    expect(
      validateSchedulingLinkConfig(too_big).some(
        (f) => f.code === 'min_advance_notice_out_of_range',
      ),
    ).toBe(true);
  });

  it('rejects max_lead_time_days out of range', () => {
    expect(
      validateSchedulingLinkConfig({ ...goodConfig, max_lead_time_days: 0 }).some(
        (f) => f.code === 'max_lead_time_out_of_range',
      ),
    ).toBe(true);
    expect(
      validateSchedulingLinkConfig({ ...goodConfig, max_lead_time_days: 9999 }).some(
        (f) => f.code === 'max_lead_time_out_of_range',
      ),
    ).toBe(true);
  });

  it('rejects max_bookings_per_day out of range', () => {
    expect(
      validateSchedulingLinkConfig({ ...goodConfig, max_bookings_per_day: -1 }).some(
        (f) => f.code === 'max_bookings_per_day_out_of_range',
      ),
    ).toBe(true);
  });

  it('rejects on_booking with non-boolean flags', () => {
    const c = {
      ...goodConfig,
      on_booking: { ...goodConfig.on_booking, create_calendar_event: 'true' as unknown },
    } as unknown;
    expect(validateSchedulingLinkConfig(c).some((f) => f.code === 'on_booking_flag_invalid')).toBe(
      true,
    );
  });

  it('REFUSES on_booking.notification_target — retired, not merely closed-list-gated', () => {
    // ⚠ D-210 Phase C RE-AIMED. This pinned "reject a value outside the closed
    // list". The list is gone: it was a per-endpoint copy of the D-158 channel
    // vocabulary that never dispatched. Channels are chosen in Settings and the
    // inbox fanout mode picks the surface, so ANY value here is now refused.

    const c = {
      ...goodConfig,
      // ⚠ was `discord` — a real channel now. Name something that can never be one.
      on_booking: { ...goodConfig.on_booking, notification_target: 'webclient' as unknown },
    } as unknown;
    expect(
      validateSchedulingLinkConfig(c).some((f) => f.code === 'notification_target_unknown'),
    ).toBe(true);
  });

  it('rejects retired auto_confirm_via_standing_instruction for every value', () => {
    const c = {
      ...goodConfig,
      on_booking: {
        ...goodConfig.on_booking,
        auto_confirm_via_standing_instruction: 'standing.always-confirm',
      },
    };
    expect(
      validateSchedulingLinkConfig(c).some((f) => f.code === 'auto_confirm_ref_invalid'),
    ).toBe(true);
  });

  it('bounds and rejects blank approval-notification sender ids', () => {
    for (const notify_visitor_sender of ['   ', 'x'.repeat(201)]) {
      const c = {
        ...goodConfig,
        on_booking: { ...goodConfig.on_booking, notify_visitor_sender },
      };
      expect(
        validateSchedulingLinkConfig(c).some((f) => f.code === 'on_booking_flag_invalid'),
      ).toBe(true);
    }
  });
});

describe('D-149 P5 § A.5.2 — closed-list ratchets', () => {
  it('SCHEDULING_LINK_DURATION_OPTION_MINUTES_ALLOWED is the substrate-frozen list', () => {
    expect([...SCHEDULING_LINK_DURATION_OPTION_MINUTES_ALLOWED]).toEqual([
      15, 30, 45, 60, 90, 120,
    ]);
    for (const d of SCHEDULING_LINK_DURATION_OPTION_MINUTES_ALLOWED) {
      expect(SCHEDULING_LINK_DURATION_OPTION_MINUTES_SET.has(d)).toBe(true);
    }
  });

  it('SCHEDULING_LINK_BOOKING_PROCESSING_OUTCOMES matches spec § A.5.2 line 671', () => {
    expect([...SCHEDULING_LINK_BOOKING_PROCESSING_OUTCOMES]).toEqual([
      'pending',
      'processed',
      'auto_confirmed',
      'requires_review',
      'rejected',
    ]);
    for (const o of SCHEDULING_LINK_BOOKING_PROCESSING_OUTCOMES) {
      expect(SCHEDULING_LINK_BOOKING_PROCESSING_OUTCOME_SET.has(o)).toBe(true);
    }
  });

  it('rpc error codes contain `scheduling_link_config_invalid`', () => {
    expect(RECEPTION_RPC_ERROR_CODE_SET.has('scheduling_link_config_invalid')).toBe(true);
  });
});

describe('D-149 P5 § A.5.2 — validateSchedulingLinkBooking', () => {
  const NOW = 1_700_000_000_000; // 2023-11-14 UTC
  const HOUR_MS = 60 * 60 * 1000;
  const DAY_MS = 24 * HOUR_MS;

  const validBooking: SchedulingLinkBookingInput = {
    visitor_name: 'Visitor Q',
    visitor_email: 'q@example.com',
    visitor_topic: 'intro call',
    selected_slot_start_at: NOW + 48 * HOUR_MS,
    selected_slot_end_at: NOW + 48 * HOUR_MS + 30 * 60 * 1000,
    selected_duration_minutes: 30,
  };

  it('accepts a complete booking', () => {
    expect(validateSchedulingLinkBooking(validBooking, goodConfig, NOW)).toEqual([]);
  });

  it('rejects missing visitor_name', () => {
    const b = { ...validBooking, visitor_name: '' };
    expect(
      validateSchedulingLinkBooking(b, goodConfig, NOW).some(
        (f) => f.code === 'visitor_name_required',
      ),
    ).toBe(true);
  });

  it('rejects visitor_name over the cap', () => {
    const b = { ...validBooking, visitor_name: 'A'.repeat(SCHEDULING_LINK_VISITOR_NAME_MAX + 1) };
    expect(
      validateSchedulingLinkBooking(b, goodConfig, NOW).some(
        (f) => f.code === 'visitor_name_too_long',
      ),
    ).toBe(true);
  });

  it('rejects missing visitor_email when required', () => {
    const b: SchedulingLinkBookingInput = {
      visitor_name: 'V',
      visitor_topic: 'topic',
      selected_slot_start_at: validBooking.selected_slot_start_at,
      selected_slot_end_at: validBooking.selected_slot_end_at,
      selected_duration_minutes: 30,
    };
    expect(
      validateSchedulingLinkBooking(b, goodConfig, NOW).some(
        (f) => f.code === 'visitor_email_required',
      ),
    ).toBe(true);
  });

  it('rejects malformed visitor_email', () => {
    const b = { ...validBooking, visitor_email: 'no-at-sign' };
    expect(
      validateSchedulingLinkBooking(b, goodConfig, NOW).some(
        (f) => f.code === 'visitor_email_invalid',
      ),
    ).toBe(true);
  });

  it('rejects visitor_email over the cap', () => {
    const b = {
      ...validBooking,
      visitor_email: `${'a'.repeat(SCHEDULING_LINK_VISITOR_EMAIL_MAX)}@x.io`,
    };
    expect(
      validateSchedulingLinkBooking(b, goodConfig, NOW).some(
        (f) => f.code === 'visitor_email_too_long',
      ),
    ).toBe(true);
  });

  it('rejects slot in the past', () => {
    const b = {
      ...validBooking,
      selected_slot_start_at: NOW - 60_000,
      selected_slot_end_at: NOW - 30_000,
    };
    expect(
      validateSchedulingLinkBooking(b, goodConfig, NOW).some(
        (f) => f.code === 'slot_violates_advance_notice',
      ),
    ).toBe(true);
  });

  it('rejects slot violating min_advance_notice_hours', () => {
    const b = {
      ...validBooking,
      selected_slot_start_at: NOW + HOUR_MS,
      selected_slot_end_at: NOW + HOUR_MS + 30 * 60 * 1000,
    };
    expect(
      validateSchedulingLinkBooking(b, goodConfig, NOW).some(
        (f) => f.code === 'slot_violates_advance_notice',
      ),
    ).toBe(true);
  });

  it('rejects slot beyond max_lead_time_days', () => {
    const b = {
      ...validBooking,
      selected_slot_start_at: NOW + 365 * DAY_MS,
      selected_slot_end_at: NOW + 365 * DAY_MS + 30 * 60 * 1000,
    };
    expect(
      validateSchedulingLinkBooking(b, goodConfig, NOW).some(
        (f) => f.code === 'slot_violates_lead_time',
      ),
    ).toBe(true);
  });

  it('rejects duration not in config options', () => {
    const b = { ...validBooking, selected_duration_minutes: 45 };
    expect(
      validateSchedulingLinkBooking(b, goodConfig, NOW).some(
        (f) => f.code === 'duration_not_offered',
      ),
    ).toBe(true);
  });

  it('rejects visitor_phone when config says omit', () => {
    const b = { ...validBooking, visitor_phone: '+1-555-5555' };
    expect(
      validateSchedulingLinkBooking(b, goodConfig, NOW).some((f) => f.code === 'unknown_field'),
    ).toBe(true);
  });

  it('rejects oversized visitor_topic / visitor_notes', () => {
    const b1 = { ...validBooking, visitor_topic: 'A'.repeat(SCHEDULING_LINK_VISITOR_TOPIC_MAX + 1) };
    expect(
      validateSchedulingLinkBooking(b1, goodConfig, NOW).some(
        (f) => f.code === 'visitor_topic_too_long',
      ),
    ).toBe(true);
    const b2 = { ...validBooking, visitor_notes: 'A'.repeat(SCHEDULING_LINK_VISITOR_NOTES_MAX + 1) };
    expect(
      validateSchedulingLinkBooking(b2, goodConfig, NOW).some(
        (f) => f.code === 'visitor_notes_too_long',
      ),
    ).toBe(true);
  });

  it('rejects oversized visitor_phone when the field is enabled', () => {
    const phoneOk: SchedulingLinkConfig = {
      ...goodConfig,
      required_visitor_fields: {
        ...goodConfig.required_visitor_fields,
        phone: 'optional',
      },
    };
    const b = { ...validBooking, visitor_phone: '5'.repeat(SCHEDULING_LINK_VISITOR_PHONE_MAX + 1) };
    expect(
      validateSchedulingLinkBooking(b, phoneOk, NOW).some(
        (f) => f.code === 'visitor_phone_too_long',
      ),
    ).toBe(true);
  });

  it('rejects slot_end_at ≤ slot_start_at', () => {
    const b = {
      ...validBooking,
      selected_slot_end_at: validBooking.selected_slot_start_at,
    };
    expect(
      validateSchedulingLinkBooking(b, goodConfig, NOW).some((f) => f.code === 'slot_end_invalid'),
    ).toBe(true);
  });
});
