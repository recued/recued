/** D-117 — calendar contracts tests.
 *
 *  Phase 1 Commit 1 surface: calendar warehouse shared types live in
 *  `packages/contracts/src/calendar.ts`. These tests exercise the
 *  exported constants, the canonical event shape, the caps shape, the
 *  watcher item shape, and the adapter-error class.
 *
 *  Runtime behavior tests (warehouse writes, sync cursor handling,
 *  etc.) land in later phases. Phase 1 Commit 1 is type-level
 *  scaffolding plus a handful of shape assertions.
 */

import { describe, expect, it } from 'vitest';

import {
  CALENDAR_EXPANSION_FUTURE_DAYS_DEFAULT,
  CALENDAR_EXPANSION_PAST_DAYS_DEFAULT,
  CALENDAR_POLL_SECONDS_DEFAULT,
  CALENDAR_QUOTA_BYTES_DEFAULT,
  CALENDAR_RETENTION_DAYS_DEFAULT,
  CalendarAdapterError,
  type CalendarAdapterErrorCode,
  type CalendarCollectionCaps,
  type CalendarCollectionHealth,
  type CalendarRecordHotFields,
  type CalendarRecordStat,
  type CanonicalEvent,
  type CollectionHealth,
  type CollectionPlatform,
} from '../index.js';

describe('D-117 calendar constants', () => {
  it('expansion window defaults span a practical meeting-scale horizon', () => {
    expect(CALENDAR_EXPANSION_PAST_DAYS_DEFAULT).toBe(30);
    expect(CALENDAR_EXPANSION_FUTURE_DAYS_DEFAULT).toBe(90);
  });

  it('poll cadence default is five minutes', () => {
    expect(CALENDAR_POLL_SECONDS_DEFAULT).toBe(300);
  });

  it('retention default is 365 days', () => {
    expect(CALENDAR_RETENTION_DAYS_DEFAULT).toBe(365);
  });

  it('quota default is 512 MB', () => {
    expect(CALENDAR_QUOTA_BYTES_DEFAULT).toBe(512 * 1024 * 1024);
  });
});

describe('CollectionPlatform union', () => {
  it('includes calendar alongside mail / file / webhook', () => {
    const platforms: CollectionPlatform[] = [
      'mail',
      'file',
      'webhook',
      'calendar',
    ];
    expect(platforms.length).toBe(4);
  });
});

describe('CanonicalEvent shape', () => {
  const baseEvent: CanonicalEvent = {
    source_id: 'abc123',
    ical_uid: '1234@example.com',
    calendar_id: 'primary',
    summary: 'Sync',
    start_at: 1_700_000_000_000,
    end_at: 1_700_003_600_000,
    timezone: 'America/New_York',
    is_all_day: false,
    status: 'confirmed',
    created_at: 1_699_000_000_000,
    updated_at: 1_700_000_000_000,
  };

  it('accepts a minimal one-off event', () => {
    expect(baseEvent.recurrence_rule).toBeUndefined();
    expect(baseEvent.recurring_event_id).toBeUndefined();
    expect(baseEvent.attendees).toBeUndefined();
  });

  it('accepts an expanded series instance with full attendee data', () => {
    const instance: CanonicalEvent = {
      ...baseEvent,
      recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO',
      recurring_event_id: 'parent-source-id',
      attendees: [
        {
          email: 'a@b.com',
          display_name: 'Alice',
          response_status: 'accepted',
          is_self: true,
        },
        {
          email: 'c@d.com',
          response_status: 'needs_action',
        },
      ],
      organizer: { email: 'a@b.com', display_name: 'Alice' },
      conference_url: 'https://meet.example/abc',
      reminders: [{ method: 'popup', minutes: 10 }],
    };
    expect(instance.attendees?.[0].is_self).toBe(true);
    expect(instance.recurring_event_id).toBe('parent-source-id');
  });
});

describe('CalendarRecordHotFields shape', () => {
  it('mirrors the columns populated on the SQLite row', () => {
    const hot: CalendarRecordHotFields = {
      calendar_id: 'primary',
      summary: 'Q3 review',
      start_at: 1_700_000_000_000,
      end_at: 1_700_003_600_000,
      status: 'confirmed',
      organizer: 'alice@example.com',
      ical_uid: 'uid-1',
      location: 'Room 42',
      is_all_day: false,
      is_recurring: true,
    };
    // Hot fields carry the derived `is_recurring` flag so watcher
    // queries can filter series vs one-off without parsing the
    // JSON payload.
    expect(hot.is_recurring).toBe(true);
  });
});

describe('CalendarCollectionCaps', () => {
  const gcal: CalendarCollectionCaps = {
    read: 'yes',
    list_calendars: 'yes',
    create_event: 'yes',
    update_event: 'yes',
    delete_event: 'yes',
    rsvp: 'yes',
    search: 'remote',
    watch: 'poll',
    auth: 'oauth',
    recurrence: 'server',
  };
  const caldav: CalendarCollectionCaps = {
    read: 'yes',
    list_calendars: 'yes',
    create_event: 'yes',
    update_event: 'yes',
    delete_event: 'yes',
    rsvp: 'no',
    search: 'local',
    watch: 'poll',
    auth: 'app_password',
    recurrence: 'client',
  };

  it('gcal-shaped caps probe to server-expanded + remote search', () => {
    expect(gcal.recurrence).toBe('server');
    expect(gcal.search).toBe('remote');
  });

  it('caldav-shaped caps probe to client-expanded + local search', () => {
    // caldav falls back to warehouse FTS5 because the protocol has no
    // remote full-text search. Rsvp probed off for iCloud-class
    // providers that lack iTIP.
    expect(caldav.recurrence).toBe('client');
    expect(caldav.search).toBe('local');
    expect(caldav.rsvp).toBe('no');
  });

  it('read is always yes (the floor for the calendar model)', () => {
    expect(gcal.read).toBe('yes');
    expect(caldav.read).toBe('yes');
  });

  it('watch = none is legal (e.g. read-only published-feed adapter)', () => {
    // Not shipped in first wave, but the type must allow it so future
    // read-only adapters plug in without widening the cap union.
    const readOnly: CalendarCollectionCaps = {
      ...gcal,
      watch: 'none',
      create_event: 'no',
      update_event: 'no',
      delete_event: 'no',
      rsvp: 'no',
    };
    expect(readOnly.watch).toBe('none');
  });
});

describe('CalendarRecordStat', () => {
  it('event_not_found collapses to exists:false with no other fields', () => {
    const absent: CalendarRecordStat = { exists: false };
    expect(absent.exists).toBe(false);
    expect(absent.start_at).toBeUndefined();
  });

  it('exists:true carries the derived stat fields', () => {
    const present: CalendarRecordStat = {
      exists: true,
      start_at: 1_700_000_000_000,
      end_at: 1_700_003_600_000,
      status: 'confirmed',
      attendee_count: 3,
      last_modified_at: 1_700_000_000_000,
    };
    expect(present.attendee_count).toBe(3);
  });
});

describe('CalendarAdapterError', () => {
  it('preserves the structured code alongside the message', () => {
    const err = new CalendarAdapterError('event_not_found', 'missing');
    expect(err.code).toBe('event_not_found');
    expect(err.message).toBe('missing');
    expect(err.name).toBe('CalendarAdapterError');
    expect(err).toBeInstanceOf(Error);
  });

  it('io_error carries the unverified-outcome semantic', () => {
    // io_error is the only code under which the provider may have
    // mutated state — recipes gate on it explicitly in fail_on when
    // they care about the verified-vs-ambiguous distinction.
    const err = new CalendarAdapterError('io_error', 'socket hang up');
    expect(err.code).toBe('io_error');
  });

  it('retains the cause for upstream error telemetry', () => {
    const upstream = new Error('ECONNRESET');
    const err = new CalendarAdapterError(
      'io_error',
      'network error',
      upstream,
    );
    expect(err.cause).toBe(upstream);
  });

  it('code surface covers every taxonomy member', () => {
    const codes: CalendarAdapterErrorCode[] = [
      'event_not_found',
      'calendar_not_found',
      'permission_denied',
      'quota_exceeded',
      'rrule_unsupported',
      'attendee_not_self',
      'auth_expired',
      'io_error',
    ];
    expect(codes.length).toBe(8);
  });
});

describe('CollectionHealth extensions for calendar', () => {
  it('calendar-specific fields are optional on the base interface', () => {
    // Existing mail/file/webhook emitters do not populate the
    // calendar-specific counters. The base shape must remain
    // backward-compatible.
    const mailHealth: CollectionHealth = {
      platform: 'mail',
      slug: 'work',
      last_indexed_at: 0,
      pending_queue_size: 0,
      error_count_24h: 0,
      state: 'idle',
    };
    expect(mailHealth.event_count).toBeUndefined();
    expect(mailHealth.upcoming_count_24h).toBeUndefined();
  });

  it('calendar emitters fill event_count + upcoming_count_24h', () => {
    const calHealth: CalendarCollectionHealth = {
      platform: 'calendar',
      slug: 'work',
      last_indexed_at: 1_700_000_000_000,
      pending_queue_size: 0,
      error_count_24h: 0,
      state: 'connected',
      auth_state: 'healthy',
      event_count: 42,
      upcoming_count_24h: 3,
    };
    expect(calHealth.event_count).toBe(42);
    expect(calHealth.upcoming_count_24h).toBe(3);
  });

  it('CalendarCollectionHealth is assignable to CollectionHealth', () => {
    const calHealth: CalendarCollectionHealth = {
      platform: 'calendar',
      slug: 'work',
      last_indexed_at: 0,
      pending_queue_size: 0,
      error_count_24h: 0,
      state: 'idle',
      event_count: 0,
      upcoming_count_24h: 0,
    };
    const asBase: CollectionHealth = calHealth;
    expect(asBase.platform).toBe('calendar');
  });
});
