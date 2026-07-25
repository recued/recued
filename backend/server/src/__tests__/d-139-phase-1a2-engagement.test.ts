/** D-139 Phase 1a.2 — engagement substrate test suite.
 *
 *  Covers:
 *    - hubspot.{meeting,note,call,task} reconcilers' Pass-4 derivation
 *      surfaces (authorship + direction + lifecycle_state + event_at +
 *      due_at_is_date_only for tasks + calendar_link body-state for
 *      meetings + per-state event_at NULL discipline)
 *    - calendar-twin matcher with TZ preservation per § A.3.7
 *    - meeting reschedule-forward reverts event_at + lifecycle_state
 *    - task pending → completed flips event_at to completed_at
 *    - per-connection rate-control substrate (§ A.6.2): daily budget,
 *      auto-degrade thresholds, page cap, 429 backoff per-tuple,
 *      cursor checkpoints per (connection_id, vendor, entity), two-
 *      portal independent budgets
 *    - per-cycle association-rescan substrate (§ A.6.3): eligibility,
 *      diff-against-persisted-edges + tombstone-on-disappear, skip-on-
 *      streaming-healthy, flip-back-on-degraded, sources_degraded
 *      population
 *    - capability map: per-entity association_rescan_required flag
 *
 *  Spec: docs/d-139-spec.md § A.1, § A.3, § A.3.1, § A.3.2, § A.3.3,
 *  § A.3.6, § A.3.7, § A.6.2, § A.6.3, § P1a.2 acceptance. */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { createEngagementStore } from '../storage/engagement-store.js';
import {
  createEngagementCapabilityStore,
  ensureEngagementCapabilitySchema,
  ENGAGEMENT_CAPABILITY_TABLE,
} from '../storage/engagement-capability-store.js';
import {
  createEngagementRateControlStore,
  computeNextAttemptAt,
  deriveRateControlState,
  ensureEngagementRateControlSchema,
  HUBSPOT_DAILY_BUDGET_DEFAULT,
  RATE_CONTROL_429_BACKOFF,
  RATE_CONTROL_THRESHOLDS,
} from '../storage/engagement-rate-control-store.js';
import {
  HubSpotMeetingEngagementReconciler,
  deriveMeetingDirection,
  deriveMeetingEventAt,
  projectMeetingEngagementRow,
  type CalendarTwinFinder,
} from '../data/hubspot/meeting-engagement-reconciler.js';
import {
  HubSpotNoteEngagementReconciler,
  projectNoteEngagementRow,
} from '../data/hubspot/note-engagement-reconciler.js';
import {
  HubSpotCallEngagementReconciler,
  deriveCallDirection,
  deriveCallEventAt,
  projectCallEngagementRow,
} from '../data/hubspot/call-engagement-reconciler.js';
import {
  HubSpotTaskEngagementReconciler,
  projectTaskEngagementRow,
} from '../data/hubspot/task-engagement-reconciler.js';
import {
  deriveAuthorshipBase,
  deriveCallLifecycleState,
  deriveMeetingLifecycleState,
  deriveNoteLifecycleState,
  deriveTaskDirectionFromSubject,
  deriveTaskLifecycleState,
  isDateOnlyHubSpotTimestamp,
} from '../data/hubspot/engagement-shared.js';
import { buildHubSpotMeetingEngagementWebhookProcessor } from '../data/hubspot/meeting-engagement-webhook-processor.js';
import { buildHubSpotNoteEngagementWebhookProcessor } from '../data/hubspot/note-engagement-webhook-processor.js';
import { buildHubSpotCallEngagementWebhookProcessor } from '../data/hubspot/call-engagement-webhook-processor.js';
import { buildHubSpotTaskEngagementWebhookProcessor } from '../data/hubspot/task-engagement-webhook-processor.js';
import {
  RESCAN_ELIGIBLE_LIFECYCLE_STATES,
  runAssociationRescan,
} from '../data/hubspot/association-rescan.js';
import type { RawHubSpotRecord } from '../data/hubspot/_hubspot-search.js';

// ────────────────────────────────────────────────────────────────
// Test harness
// ────────────────────────────────────────────────────────────────

const inMemoryDb = (): Database.Database => new Database(':memory:');

const FIXED_NOW = 1_714_867_200_000; // 2026-05-04 00:00:00 UTC ish

const makeStores = (): {
  db: Database.Database;
  store: ReturnType<typeof createEngagementStore>;
  capStore: ReturnType<typeof createEngagementCapabilityStore>;
  rcStore: ReturnType<typeof createEngagementRateControlStore>;
} => {
  const db = inMemoryDb();
  return {
    db,
    store: createEngagementStore(db),
    capStore: createEngagementCapabilityStore(db),
    rcStore: createEngagementRateControlStore(db),
  };
};

const rawMeeting = (
  overrides: Partial<RawHubSpotRecord['properties']> = {},
  id = '301',
): RawHubSpotRecord => ({
  id,
  properties: {
    hs_meeting_title: 'Quarterly review',
    hs_meeting_body: 'Quick check-in on pipeline.',
    hs_meeting_start_time: '1714780800000', // 2026-05-04 00:00 UTC (past relative to FIXED_NOW)
    hs_meeting_end_time: '1714784400000',
    hs_meeting_outcome: 'COMPLETED',
    hs_meeting_location: 'Zoom',
    hs_meeting_external_url: 'https://zoom.us/j/12345',
    attendee_emails: 'bob@acme.com;alice@recued.com',
    hs_lastmodifieddate: '1714867200500',
    hs_createdate: '1714000000000',
    hs_timestamp: '1714780800000',
    hubspot_owner_id: '777',
    hs_created_by_workflow_id: '',
    hs_created_via_workflow: '',
    hs_import_id: '',
    ...overrides,
  },
});

const rawNote = (
  overrides: Partial<RawHubSpotRecord['properties']> = {},
  id = '402',
): RawHubSpotRecord => ({
  id,
  properties: {
    hs_note_body: 'Customer is interested in the enterprise plan.',
    hs_lastmodifieddate: '1714867200500',
    hs_createdate: '1714867200000',
    hs_timestamp: '1714867200000',
    hubspot_owner_id: '777',
    hs_created_by_workflow_id: '',
    hs_created_via_workflow: '',
    hs_import_id: '',
    ...overrides,
  },
});

const rawCall = (
  overrides: Partial<RawHubSpotRecord['properties']> = {},
  id = '503',
): RawHubSpotRecord => ({
  id,
  properties: {
    hs_call_title: 'Discovery call',
    hs_call_body: 'Discussed budget + timeline. Next step: technical review.',
    hs_call_direction: 'OUTBOUND',
    hs_call_status: 'COMPLETED',
    hs_call_duration: '900000',
    hs_call_disposition: 'connected',
    hs_call_recording_url: 'https://example.com/rec/1',
    hs_timestamp: '1714867200000',
    hs_lastmodifieddate: '1714867200500',
    hs_createdate: '1714867200000',
    hubspot_owner_id: '777',
    hs_created_by_workflow_id: '',
    hs_created_via_workflow: '',
    hs_import_id: '',
    ...overrides,
  },
});

const rawTask = (
  overrides: Partial<RawHubSpotRecord['properties']> = {},
  id = '604',
): RawHubSpotRecord => ({
  id,
  properties: {
    hs_task_subject: 'Email Bob about renewal',
    hs_task_body: 'Follow up before EOQ.',
    hs_task_status: 'NOT_STARTED',
    hs_task_priority: 'HIGH',
    hs_task_type: 'EMAIL',
    hs_task_completion_date: '1715040000000', // due-date when not completed
    hs_lastmodifieddate: '1714867200500',
    hs_createdate: '1714867200000',
    hs_timestamp: '1714867200000',
    hubspot_owner_id: '777',
    hs_created_by_workflow_id: '',
    hs_created_via_workflow: '',
    hs_import_id: '',
    ...overrides,
  },
});

// ────────────────────────────────────────────────────────────────
// Shared derivation helpers (§ A.3.2 / § A.3.3 / § A.3.6)
// ────────────────────────────────────────────────────────────────

describe('D-139 P1a.2 — shared derivation helpers', () => {
  it('deriveAuthorshipBase: owner matches connection user → user', () => {
    const raw = rawMeeting();
    expect(deriveAuthorshipBase(raw, '777')).toBe('user');
  });
  it('deriveAuthorshipBase: workflow id populated (no owner-match) → crm_automation', () => {
    // Owner-match wins when set; substrate flips to crm_automation
    // only when the owner doesn't match the connection user (the
    // workflow stamped the row under a different owner).
    const raw = rawMeeting({
      hubspot_owner_id: '888',
      hs_created_by_workflow_id: '999',
    });
    expect(deriveAuthorshipBase(raw, '777')).toBe('crm_automation');
  });
  it('deriveAuthorshipBase: created_via_workflow populated (no owner-match) → crm_automation', () => {
    const raw = rawMeeting({
      hubspot_owner_id: '888',
      hs_created_by_workflow_id: '',
      hs_created_via_workflow: 'workflow-555',
    });
    expect(deriveAuthorshipBase(raw, '777')).toBe('crm_automation');
  });
  it('deriveAuthorshipBase: owner-match wins over workflow (rep-edited workflow-created row stays user)', () => {
    const raw = rawMeeting({
      hubspot_owner_id: '777',
      hs_created_by_workflow_id: '999',
    });
    expect(deriveAuthorshipBase(raw, '777')).toBe('user');
  });
  it('deriveAuthorshipBase: import_id populated (no owner-match, no workflow) → import', () => {
    const raw = rawMeeting({
      hubspot_owner_id: '888',
      hs_import_id: 'import-1',
    });
    expect(deriveAuthorshipBase(raw, '777')).toBe('import');
  });
  it('deriveAuthorshipBase: different owner without workflow/import → crm_user', () => {
    const raw = rawMeeting({ hubspot_owner_id: '888' });
    expect(deriveAuthorshipBase(raw, '777')).toBe('crm_user');
  });
  it('deriveAuthorshipBase: empty owner → unknown', () => {
    const raw = rawMeeting({ hubspot_owner_id: '' });
    expect(deriveAuthorshipBase(raw, '777')).toBe('unknown');
  });

  it('isDateOnlyHubSpotTimestamp: ISO date string → true', () => {
    expect(isDateOnlyHubSpotTimestamp('2026-05-04')).toBe(true);
  });
  it('isDateOnlyHubSpotTimestamp: unix-ms string → false', () => {
    expect(isDateOnlyHubSpotTimestamp('1714867200000')).toBe(false);
  });
  it('isDateOnlyHubSpotTimestamp: ISO datetime → false (only YYYY-MM-DD is date-only)', () => {
    expect(isDateOnlyHubSpotTimestamp('2026-05-04T17:00:00Z')).toBe(false);
  });
  it('isDateOnlyHubSpotTimestamp: empty / null → false', () => {
    expect(isDateOnlyHubSpotTimestamp('')).toBe(false);
    expect(isDateOnlyHubSpotTimestamp(null)).toBe(false);
    expect(isDateOnlyHubSpotTimestamp(undefined)).toBe(false);
  });

  it('deriveTaskDirectionFromSubject: Email/Send/Call/Follow up prefixes → outbound', () => {
    expect(deriveTaskDirectionFromSubject('Email Bob')).toBe('outbound');
    expect(deriveTaskDirectionFromSubject('Send proposal')).toBe('outbound');
    expect(deriveTaskDirectionFromSubject('Call Acme')).toBe('outbound');
    expect(deriveTaskDirectionFromSubject('Follow up with prospect')).toBe(
      'outbound',
    );
    expect(deriveTaskDirectionFromSubject('Reply to RFP')).toBe('outbound');
  });
  it('deriveTaskDirectionFromSubject: non-verb subject → unknown', () => {
    expect(deriveTaskDirectionFromSubject('Quarterly review')).toBe('unknown');
    expect(deriveTaskDirectionFromSubject('')).toBe('unknown');
    expect(deriveTaskDirectionFromSubject(null)).toBe('unknown');
  });

  it('deriveNoteLifecycleState: always point_in_time', () => {
    expect(deriveNoteLifecycleState()).toBe('point_in_time');
  });

  it('deriveMeetingLifecycleState: outcome=CANCELED → cancelled', () => {
    expect(deriveMeetingLifecycleState('CANCELED', null, FIXED_NOW)).toBe(
      'cancelled',
    );
    expect(deriveMeetingLifecycleState('CANCELLED', null, FIXED_NOW)).toBe(
      'cancelled',
    );
  });
  it('deriveMeetingLifecycleState: outcome=RESCHEDULED → scheduled (future start)', () => {
    expect(
      deriveMeetingLifecycleState('RESCHEDULED', FIXED_NOW + 86400000, FIXED_NOW),
    ).toBe('scheduled');
  });
  it('deriveMeetingLifecycleState: start_time future → scheduled', () => {
    expect(
      deriveMeetingLifecycleState('SCHEDULED', FIXED_NOW + 3600000, FIXED_NOW),
    ).toBe('scheduled');
  });
  it('deriveMeetingLifecycleState: start_time past + outcome=COMPLETED → completed', () => {
    expect(
      deriveMeetingLifecycleState('COMPLETED', FIXED_NOW - 3600000, FIXED_NOW),
    ).toBe('completed');
  });
  it('deriveMeetingLifecycleState: start_time past + no outcome → completed (substrate default)', () => {
    expect(deriveMeetingLifecycleState('', FIXED_NOW - 1, FIXED_NOW)).toBe(
      'completed',
    );
    expect(deriveMeetingLifecycleState(null, FIXED_NOW - 1, FIXED_NOW)).toBe(
      'completed',
    );
  });

  it('deriveTaskLifecycleState: COMPLETED → completed', () => {
    expect(deriveTaskLifecycleState('COMPLETED')).toBe('completed');
  });
  it('deriveTaskLifecycleState: DEFERRED / CANCELED → cancelled', () => {
    expect(deriveTaskLifecycleState('DEFERRED')).toBe('cancelled');
    expect(deriveTaskLifecycleState('CANCELED')).toBe('cancelled');
    expect(deriveTaskLifecycleState('CANCELLED')).toBe('cancelled');
  });
  it('deriveTaskLifecycleState: NOT_STARTED / IN_PROGRESS / WAITING / empty → pending', () => {
    expect(deriveTaskLifecycleState('NOT_STARTED')).toBe('pending');
    expect(deriveTaskLifecycleState('IN_PROGRESS')).toBe('pending');
    expect(deriveTaskLifecycleState('WAITING')).toBe('pending');
    expect(deriveTaskLifecycleState('')).toBe('pending');
    expect(deriveTaskLifecycleState(null)).toBe('pending');
  });

  it('deriveCallLifecycleState: QUEUED / IN_PROGRESS → pending (Pass-5 R5.4)', () => {
    expect(deriveCallLifecycleState('QUEUED')).toBe('pending');
    expect(deriveCallLifecycleState('IN_PROGRESS')).toBe('pending');
  });
  it('deriveCallLifecycleState: COMPLETED → point_in_time', () => {
    expect(deriveCallLifecycleState('COMPLETED')).toBe('point_in_time');
  });
  it('deriveCallLifecycleState: NO_ANSWER → no_answer', () => {
    expect(deriveCallLifecycleState('NO_ANSWER')).toBe('no_answer');
  });
  it('deriveCallLifecycleState: FAILED → failed; CANCELED → cancelled', () => {
    expect(deriveCallLifecycleState('FAILED')).toBe('failed');
    expect(deriveCallLifecycleState('CANCELED')).toBe('cancelled');
    expect(deriveCallLifecycleState('CANCELLED')).toBe('cancelled');
  });
});

// ────────────────────────────────────────────────────────────────
// Meeting reconciler — projection + lifecycle + direction + calendar twin
// ────────────────────────────────────────────────────────────────

describe('D-139 P1a.2 — meeting reconciler projection', () => {
  it('completed past meeting populates event_at = start_time + lifecycle = completed', () => {
    const raw = rawMeeting();
    const row = projectMeetingEngagementRow('acme-hubspot', raw, {
      now: FIXED_NOW,
      calendarTwinMatch: null,
      connectionUserOwnerId: '777',
      defaultTzHint: 'UTC',
    });
    expect(row.lifecycle_state).toBe('completed');
    expect(row.event_at).toBe(1_714_780_800_000);
    expect(row.scheduled_start_at).toBe(1_714_780_800_000);
    expect(row.target_id).toBe('hubspot_meeting_301');
    expect(row.entity).toBe('meeting');
    expect(row.authorship).toBe('user');
  });
  it('upcoming meeting → lifecycle = scheduled + event_at = NULL per § A.3.1', () => {
    const raw = rawMeeting({
      hs_meeting_start_time: String(FIXED_NOW + 3600000),
      hs_meeting_outcome: 'SCHEDULED',
    });
    const row = projectMeetingEngagementRow('acme-hubspot', raw, {
      now: FIXED_NOW,
      calendarTwinMatch: null,
      defaultTzHint: 'UTC',
    });
    expect(row.lifecycle_state).toBe('scheduled');
    expect(row.event_at).toBeNull();
    expect(row.scheduled_start_at).toBe(FIXED_NOW + 3600000);
  });
  it('cancelled meeting → lifecycle = cancelled + event_at = NULL', () => {
    const raw = rawMeeting({
      hs_meeting_start_time: String(FIXED_NOW - 3600000),
      hs_meeting_outcome: 'CANCELED',
    });
    const row = projectMeetingEngagementRow('acme-hubspot', raw, {
      now: FIXED_NOW,
      calendarTwinMatch: null,
      defaultTzHint: 'UTC',
    });
    expect(row.lifecycle_state).toBe('cancelled');
    expect(row.event_at).toBeNull();
  });
  it('rescheduled-forward flips lifecycle back to scheduled + event_at to NULL', () => {
    // Past start_time + RESCHEDULED outcome means the meeting was
    // pushed forward; the row's start_time has been updated to the
    // new future time. Substrate sees the new start_time + the
    // RESCHEDULED outcome → back to 'scheduled'.
    const raw = rawMeeting({
      hs_meeting_start_time: String(FIXED_NOW + 86400000),
      hs_meeting_outcome: 'RESCHEDULED',
    });
    const row = projectMeetingEngagementRow('acme-hubspot', raw, {
      now: FIXED_NOW,
      calendarTwinMatch: null,
      defaultTzHint: 'UTC',
    });
    expect(row.lifecycle_state).toBe('scheduled');
    expect(row.event_at).toBeNull();
  });
  it('calendar-twin match flips body_state to calendar_link + propagates tz_hint', () => {
    const raw = rawMeeting();
    const match = {
      calendar_id: 'cal-row-1',
      match_key: 'external_url',
      tz_hint: 'America/New_York',
    };
    const row = projectMeetingEngagementRow('acme-hubspot', raw, {
      now: FIXED_NOW,
      calendarTwinMatch: match,
      defaultTzHint: 'UTC',
    });
    expect(row.body_state).toBe('calendar_link');
    expect(row.event_at_tz_hint).toBe('America/New_York');
  });
  it('no calendar twin + non-empty body → inline_body', () => {
    const row = projectMeetingEngagementRow('acme-hubspot', rawMeeting(), {
      now: FIXED_NOW,
      calendarTwinMatch: null,
      defaultTzHint: 'UTC',
    });
    expect(row.body_state).toBe('inline_body');
    expect(row.body_inline).toBe('Quick check-in on pipeline.');
  });
  it('vendor_modstamp + vendor_raw_timestamp populated', () => {
    const row = projectMeetingEngagementRow('acme-hubspot', rawMeeting(), {
      now: FIXED_NOW,
      calendarTwinMatch: null,
      defaultTzHint: 'UTC',
    });
    expect(row.vendor_modstamp).toBe('1714867200500');
    expect(row.vendor_raw_timestamp).toBe('1714780800000');
  });

  it('direction: all-internal attendees → internal', () => {
    const raw = rawMeeting({
      attendee_emails: 'alice@recued.com;carol@recued.com',
    });
    expect(
      deriveMeetingDirection(raw, '777', ['recued.com']),
    ).toBe('internal');
  });
  it('direction: external attendees + connection user owner → outbound', () => {
    const raw = rawMeeting();
    expect(
      deriveMeetingDirection(raw, '777', ['recued.com']),
    ).toBe('outbound');
  });
  it('direction: external attendees + non-connection-user owner with id → outbound (rep scheduled)', () => {
    const raw = rawMeeting({ hubspot_owner_id: '888' });
    expect(
      deriveMeetingDirection(raw, '777', ['recued.com']),
    ).toBe('outbound');
  });
  it('direction: empty attendees → unknown', () => {
    const raw = rawMeeting({ attendee_emails: '' });
    expect(
      deriveMeetingDirection(raw, '777', ['recued.com']),
    ).toBe('unknown');
  });

  it('event_at: deriveMeetingEventAt returns NULL for non-completed states', () => {
    expect(deriveMeetingEventAt('scheduled', 12345)).toBeNull();
    expect(deriveMeetingEventAt('cancelled', 12345)).toBeNull();
    expect(deriveMeetingEventAt('completed', 12345)).toBe(12345);
    expect(deriveMeetingEventAt('completed', null)).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// Note reconciler — projection
// ────────────────────────────────────────────────────────────────

describe('D-139 P1a.2 — note reconciler projection', () => {
  it('note → lifecycle = point_in_time + direction = unknown + event_at = createdate', () => {
    const row = projectNoteEngagementRow('acme-hubspot', rawNote(), {
      now: FIXED_NOW,
      connectionUserOwnerId: '777',
      defaultTzHint: 'UTC',
    });
    expect(row.lifecycle_state).toBe('point_in_time');
    expect(row.direction).toBe('unknown');
    expect(row.event_at).toBe(1_714_867_200_000);
    expect(row.target_id).toBe('hubspot_note_402');
    expect(row.entity).toBe('note');
  });
  it('inline body → body_state = inline_body + body_inline populated', () => {
    const row = projectNoteEngagementRow('acme-hubspot', rawNote(), {
      now: FIXED_NOW,
      defaultTzHint: 'UTC',
    });
    expect(row.body_state).toBe('inline_body');
    expect(row.body_inline).toContain('enterprise plan');
  });
  it('empty body → body_state = none', () => {
    const row = projectNoteEngagementRow('acme-hubspot', rawNote({ hs_note_body: '' }), {
      now: FIXED_NOW,
      defaultTzHint: 'UTC',
    });
    expect(row.body_state).toBe('none');
  });
  it('large body → body_state = truncated_inline + body_truncation_offset populated', () => {
    const big = 'A'.repeat(20 * 1024);
    const row = projectNoteEngagementRow(
      'acme-hubspot',
      rawNote({ hs_note_body: big }),
      { now: FIXED_NOW, defaultTzHint: 'UTC' },
    );
    expect(row.body_state).toBe('truncated_inline');
    expect(row.body_truncation_offset).toBe(20 * 1024);
  });
  it('authorship: workflow-created note (different owner) → crm_automation', () => {
    const row = projectNoteEngagementRow(
      'acme-hubspot',
      rawNote({
        hubspot_owner_id: '888',
        hs_created_by_workflow_id: '999',
      }),
      { now: FIXED_NOW, connectionUserOwnerId: '777', defaultTzHint: 'UTC' },
    );
    expect(row.authorship).toBe('crm_automation');
  });
});

// ────────────────────────────────────────────────────────────────
// Call reconciler — projection + per-status event_at + direction
// ────────────────────────────────────────────────────────────────

describe('D-139 P1a.2 — call reconciler projection', () => {
  it('COMPLETED call → lifecycle = point_in_time + event_at populated + direction = outbound', () => {
    const row = projectCallEngagementRow('acme-hubspot', rawCall(), {
      now: FIXED_NOW,
      connectionUserOwnerId: '777',
      defaultTzHint: 'UTC',
    });
    expect(row.lifecycle_state).toBe('point_in_time');
    expect(row.event_at).toBe(1_714_867_200_000);
    expect(row.direction).toBe('outbound');
  });
  it('NO_ANSWER call → lifecycle = no_answer + event_at populated (attempt happened)', () => {
    const row = projectCallEngagementRow(
      'acme-hubspot',
      rawCall({ hs_call_status: 'NO_ANSWER' }),
      { now: FIXED_NOW, defaultTzHint: 'UTC' },
    );
    expect(row.lifecycle_state).toBe('no_answer');
    expect(row.event_at).toBe(1_714_867_200_000);
  });
  it('QUEUED call → lifecycle = pending + event_at = NULL', () => {
    const row = projectCallEngagementRow(
      'acme-hubspot',
      rawCall({ hs_call_status: 'QUEUED' }),
      { now: FIXED_NOW, defaultTzHint: 'UTC' },
    );
    expect(row.lifecycle_state).toBe('pending');
    expect(row.event_at).toBeNull();
  });
  it('FAILED call → lifecycle = failed + event_at = NULL', () => {
    const row = projectCallEngagementRow(
      'acme-hubspot',
      rawCall({ hs_call_status: 'FAILED' }),
      { now: FIXED_NOW, defaultTzHint: 'UTC' },
    );
    expect(row.lifecycle_state).toBe('failed');
    expect(row.event_at).toBeNull();
  });
  it('CANCELED call → lifecycle = cancelled + event_at = NULL', () => {
    const row = projectCallEngagementRow(
      'acme-hubspot',
      rawCall({ hs_call_status: 'CANCELED' }),
      { now: FIXED_NOW, defaultTzHint: 'UTC' },
    );
    expect(row.lifecycle_state).toBe('cancelled');
    expect(row.event_at).toBeNull();
  });
  it('direction: INBOUND → inbound', () => {
    const raw = rawCall({ hs_call_direction: 'INBOUND' });
    expect(deriveCallDirection(raw)).toBe('inbound');
  });
  it('direction: empty → unknown', () => {
    const raw = rawCall({ hs_call_direction: '' });
    expect(deriveCallDirection(raw)).toBe('unknown');
  });
  it('event_at: derive returns null for FAILED', () => {
    const raw = rawCall({ hs_call_status: 'FAILED' });
    expect(deriveCallEventAt(raw, 'failed')).toBeNull();
  });
  it('event_at: derive returns timestamp for NO_ANSWER (attempt occurred)', () => {
    const raw = rawCall({ hs_call_status: 'NO_ANSWER' });
    expect(deriveCallEventAt(raw, 'no_answer')).toBe(1_714_867_200_000);
  });
  it('meta carries duration_ms parsed as number', () => {
    const row = projectCallEngagementRow('acme-hubspot', rawCall(), {
      now: FIXED_NOW,
      defaultTzHint: 'UTC',
    });
    expect((row.meta as { duration_ms?: number }).duration_ms).toBe(900_000);
  });
});

// ────────────────────────────────────────────────────────────────
// Task reconciler — projection + lifecycle + due_at_is_date_only
// ────────────────────────────────────────────────────────────────

describe('D-139 P1a.2 — task reconciler projection', () => {
  it('pending task → lifecycle = pending + event_at = NULL + due_at populated', () => {
    const row = projectTaskEngagementRow('acme-hubspot', rawTask(), {
      now: FIXED_NOW,
      connectionUserOwnerId: '777',
      defaultTzHint: 'UTC',
    });
    expect(row.lifecycle_state).toBe('pending');
    expect(row.event_at).toBeNull();
    expect(row.due_at).toBe(1_715_040_000_000);
    expect(row.completed_at).toBeUndefined();
    expect(row.due_at_is_date_only).toBe(false); // unix-ms-as-string
  });
  it('completed task → lifecycle = completed + event_at = completed_at', () => {
    const row = projectTaskEngagementRow(
      'acme-hubspot',
      rawTask({ hs_task_status: 'COMPLETED' }),
      { now: FIXED_NOW, defaultTzHint: 'UTC' },
    );
    expect(row.lifecycle_state).toBe('completed');
    expect(row.event_at).toBe(1_715_040_000_000);
    expect(row.completed_at).toBe(1_715_040_000_000);
    expect(row.due_at).toBeUndefined();
  });
  it('cancelled task → lifecycle = cancelled + event_at = NULL', () => {
    const row = projectTaskEngagementRow(
      'acme-hubspot',
      rawTask({ hs_task_status: 'DEFERRED' }),
      { now: FIXED_NOW, defaultTzHint: 'UTC' },
    );
    expect(row.lifecycle_state).toBe('cancelled');
    expect(row.event_at).toBeNull();
  });
  it('date-only due-date → due_at_is_date_only = true', () => {
    const row = projectTaskEngagementRow(
      'acme-hubspot',
      rawTask({ hs_task_completion_date: '2026-05-04' }),
      { now: FIXED_NOW, defaultTzHint: 'UTC' },
    );
    expect(row.due_at_is_date_only).toBe(true);
    expect(row.due_at).toBe(Date.parse('2026-05-04'));
  });
  it('date-only on completed task does NOT set due_at_is_date_only (transitions to completed_at)', () => {
    const row = projectTaskEngagementRow(
      'acme-hubspot',
      rawTask({
        hs_task_status: 'COMPLETED',
        hs_task_completion_date: '2026-05-04',
      }),
      { now: FIXED_NOW, defaultTzHint: 'UTC' },
    );
    expect(row.lifecycle_state).toBe('completed');
    expect(row.completed_at).toBe(Date.parse('2026-05-04'));
    expect(row.due_at).toBeUndefined();
    expect(row.due_at_is_date_only).toBeUndefined();
  });
  it('subject "Email Bob about renewal" → direction = outbound', () => {
    const row = projectTaskEngagementRow('acme-hubspot', rawTask(), {
      now: FIXED_NOW,
      defaultTzHint: 'UTC',
    });
    expect(row.direction).toBe('outbound');
  });
  it('non-verb subject → direction = unknown', () => {
    const row = projectTaskEngagementRow(
      'acme-hubspot',
      rawTask({ hs_task_subject: 'Quarterly review' }),
      { now: FIXED_NOW, defaultTzHint: 'UTC' },
    );
    expect(row.direction).toBe('unknown');
  });
});

// ────────────────────────────────────────────────────────────────
// Reconciler ingest end-to-end (per-type)
// ────────────────────────────────────────────────────────────────

describe('D-139 P1a.2 — reconciler ingest end-to-end', () => {
  it('meeting reconciler writes row + owner edge + calendar_twin edge when matcher hits', () => {
    const { store } = makeStores();
    const finder: CalendarTwinFinder = () => ({
      calendar_id: 'cal-row-1',
      match_key: 'external_url',
      tz_hint: 'UTC',
    });
    const reconciler = new HubSpotMeetingEngagementReconciler({
      search: { refreshAuth: async () => ({ type: 'oauth2_refresh' } as never) },
      engagementStore: store,
      calendarTwinFinder: finder,
      connectionUserOwnerId: '777',
      internalEmailDomains: ['recued.com'],
      now: () => FIXED_NOW,
    });
    const slim = {
      id: 'hubspot_meeting_301',
      modified_at: 1_714_867_200_500,
      _raw: rawMeeting(),
    };
    const { row, emittedEdgeCount } = reconciler.ingest(
      'acme-hubspot',
      slim,
    );
    expect(row.body_state).toBe('calendar_link');
    expect(emittedEdgeCount).toBeGreaterThanOrEqual(3); // contact x2 + owner + calendar
    const edges = store.listEdges({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_meeting_301',
    });
    const types = edges.map((e) => e.edge_type).sort();
    expect(types).toContain('owner');
    expect(types).toContain('calendar_twin');
    expect(types).toContain('contact');
  });

  it('note reconciler writes row + owner edge', () => {
    const { store } = makeStores();
    const reconciler = new HubSpotNoteEngagementReconciler({
      search: { refreshAuth: async () => ({ type: 'oauth2_refresh' } as never) },
      engagementStore: store,
      connectionUserOwnerId: '777',
      now: () => FIXED_NOW,
    });
    const slim = {
      id: 'hubspot_note_402',
      modified_at: 1_714_867_200_500,
      _raw: rawNote(),
    };
    const { row, emittedEdgeCount } = reconciler.ingest('acme-hubspot', slim);
    expect(row.entity).toBe('note');
    expect(emittedEdgeCount).toBe(1);
    const edges = store.listEdges({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_note_402',
    });
    expect(edges.map((e) => e.edge_type)).toEqual(['owner']);
  });

  it('call reconciler writes row + owner edge', () => {
    const { store } = makeStores();
    const reconciler = new HubSpotCallEngagementReconciler({
      search: { refreshAuth: async () => ({ type: 'oauth2_refresh' } as never) },
      engagementStore: store,
      connectionUserOwnerId: '777',
      now: () => FIXED_NOW,
    });
    const slim = {
      id: 'hubspot_call_503',
      modified_at: 1_714_867_200_500,
      _raw: rawCall(),
    };
    const { row, emittedEdgeCount } = reconciler.ingest('acme-hubspot', slim);
    expect(row.entity).toBe('call');
    expect(row.lifecycle_state).toBe('point_in_time');
    expect(emittedEdgeCount).toBe(1);
  });

  it('task reconciler writes row + owner edge', () => {
    const { store } = makeStores();
    const reconciler = new HubSpotTaskEngagementReconciler({
      search: { refreshAuth: async () => ({ type: 'oauth2_refresh' } as never) },
      engagementStore: store,
      connectionUserOwnerId: '777',
      now: () => FIXED_NOW,
    });
    const slim = {
      id: 'hubspot_task_604',
      modified_at: 1_714_867_200_500,
      _raw: rawTask(),
    };
    const { row, emittedEdgeCount } = reconciler.ingest('acme-hubspot', slim);
    expect(row.entity).toBe('task');
    expect(row.lifecycle_state).toBe('pending');
    expect(emittedEdgeCount).toBe(1);
  });

  it('connection_id namespacing: same target_id under two portals stay separate (4 entity types)', () => {
    const { store } = makeStores();
    for (const portal of ['acme-hubspot', 'partner-hubspot']) {
      const note = new HubSpotNoteEngagementReconciler({
        search: { refreshAuth: async () => ({ type: 'oauth2_refresh' } as never) },
        engagementStore: store,
        now: () => FIXED_NOW,
      });
      note.ingest(portal, {
        id: 'hubspot_note_402',
        modified_at: 1_714_867_200_500,
        _raw: rawNote(),
      });
    }
    expect(store.get('acme-hubspot', 'hubspot_note_402')).not.toBeNull();
    expect(store.get('partner-hubspot', 'hubspot_note_402')).not.toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// Webhook processors — idempotency-ledger gating per-type
// ────────────────────────────────────────────────────────────────

describe('D-139 P1a.2 — webhook processor idempotency gating per-type', () => {
  interface ProcessorCase {
    label: string;
    build: (input: {
      search: { refreshAuth: () => Promise<unknown> };
      engagementStore: ReturnType<typeof createEngagementStore>;
      lookupConnection: () => Promise<null>;
      now: () => number;
    }) => ReturnType<typeof buildHubSpotMeetingEngagementWebhookProcessor>;
    objectType: string;
    targetIdPrefix: string;
  }
  const cases: ReadonlyArray<ProcessorCase> = [
    {
      label: 'meeting',
      build: buildHubSpotMeetingEngagementWebhookProcessor as never,
      objectType: 'meeting',
      targetIdPrefix: 'hubspot_meeting_',
    },
    {
      label: 'note',
      build: buildHubSpotNoteEngagementWebhookProcessor as never,
      objectType: 'note',
      targetIdPrefix: 'hubspot_note_',
    },
    {
      label: 'call',
      build: buildHubSpotCallEngagementWebhookProcessor as never,
      objectType: 'call',
      targetIdPrefix: 'hubspot_call_',
    },
    {
      label: 'task',
      build: buildHubSpotTaskEngagementWebhookProcessor as never,
      objectType: 'task',
      targetIdPrefix: 'hubspot_task_',
    },
  ];

  for (const c of cases) {
    it(`${c.label}: deletion event ledgered + duplicate eventId-subscriptionType is no-op`, async () => {
      const { store } = makeStores();
      const processor = c.build({
        search: { refreshAuth: async () => ({ type: 'oauth2_refresh' }) },
        engagementStore: store,
        lookupConnection: async () => null,
        now: () => 1,
      });
      const subscription = `${c.objectType}.deletion`;
      const payload = [
        { subscriptionType: subscription, objectId: 99_999, eventId: 7777 },
      ];
      const first = await processor.parseEvents(payload, {}, 'acme-hubspot');
      expect(first.length).toBe(1);
      expect(first[0]).toMatchObject({
        kind: 'deleted',
        target_id: `${c.targetIdPrefix}99999`,
      });
      const second = await processor.parseEvents(payload, {}, 'acme-hubspot');
      expect(second.length).toBe(0);
    });
    it(`${c.label}: associationChange event passes through unledgered (deferred to rescan substrate)`, async () => {
      const { store, db } = makeStores();
      const processor = c.build({
        search: { refreshAuth: async () => ({ type: 'oauth2_refresh' }) },
        engagementStore: store,
        lookupConnection: async () => null,
        now: () => 1,
      });
      const payload = [
        {
          subscriptionType: `${c.objectType}.associationChange`,
          objectId: 99_999,
          eventId: 7777,
        },
      ];
      const out = await processor.parseEvents(payload, {}, 'acme-hubspot');
      expect(out.length).toBe(0);
      // Ledger MUST stay empty for associationChange — the rescan
      // substrate at § A.6.3 handles it on its own cadence.
      const ledgerCount = (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM engagement_inbound_event_ledger`,
          )
          .get() as { n: number }
      ).n;
      expect(ledgerCount).toBe(0);
    });
    it(`${c.label}: non-${c.objectType} subscription type filtered out`, async () => {
      const { store } = makeStores();
      const processor = c.build({
        search: { refreshAuth: async () => ({ type: 'oauth2_refresh' }) },
        engagementStore: store,
        lookupConnection: async () => null,
        now: () => 1,
      });
      const payload = [
        { subscriptionType: 'deal.creation', objectId: 1, eventId: 1 },
      ];
      const out = await processor.parseEvents(payload, {}, 'acme-hubspot');
      expect(out.length).toBe(0);
    });
  }
});

// ────────────────────────────────────────────────────────────────
// Capability store — schema + crud
// ────────────────────────────────────────────────────────────────

describe('D-139 P1a.2 — engagement capability store', () => {
  it('schema bootstrap creates engagement_capability table', () => {
    const db = inMemoryDb();
    ensureEngagementCapabilitySchema(db);
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain(ENGAGEMENT_CAPABILITY_TABLE);
  });
  it('upsert + get round-trips per (connection, vendor, entity)', () => {
    const db = inMemoryDb();
    const caps = createEngagementCapabilityStore(db);
    caps.upsert({
      connection_id: 'acme-hubspot',
      vendor: 'hubspot',
      entity: 'meeting',
      available: true,
      association_rescan_required: true,
      last_probed_at: FIXED_NOW,
    });
    const row = caps.get('acme-hubspot', 'hubspot', 'meeting');
    expect(row).not.toBeNull();
    expect(row?.association_rescan_required).toBe(true);
    expect(row?.available).toBe(true);
  });
  it('listRescanRequired returns only rows with the flag set', () => {
    const db = inMemoryDb();
    const caps = createEngagementCapabilityStore(db);
    caps.upsert({
      connection_id: 'acme-hubspot',
      vendor: 'hubspot',
      entity: 'email',
      available: true,
      association_rescan_required: false,
      last_probed_at: FIXED_NOW,
    });
    caps.upsert({
      connection_id: 'acme-hubspot',
      vendor: 'hubspot',
      entity: 'meeting',
      available: true,
      association_rescan_required: true,
      last_probed_at: FIXED_NOW,
    });
    caps.upsert({
      connection_id: 'partner-hubspot',
      vendor: 'hubspot',
      entity: 'note',
      available: true,
      association_rescan_required: true,
      last_probed_at: FIXED_NOW,
    });
    const rescanRows = caps.listRescanRequired();
    expect(rescanRows.length).toBe(2);
    expect(rescanRows.every((r) => r.association_rescan_required)).toBe(true);
  });
  it('removeForConnection drops every capability row under a connection', () => {
    const db = inMemoryDb();
    const caps = createEngagementCapabilityStore(db);
    for (const entity of ['email', 'meeting', 'note', 'call', 'task']) {
      caps.upsert({
        connection_id: 'acme-hubspot',
        vendor: 'hubspot',
        entity,
        available: true,
        association_rescan_required: false,
        last_probed_at: FIXED_NOW,
      });
    }
    expect(caps.removeForConnection('acme-hubspot')).toBe(5);
    expect(caps.listByConnection('acme-hubspot')).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// Rate-control store — daily budget + auto-degrade + 429 backoff
// ────────────────────────────────────────────────────────────────

describe('D-139 P1a.2 — engagement rate-control store', () => {
  it('schema bootstrap creates budget + rate-control tables', () => {
    const db = inMemoryDb();
    ensureEngagementRateControlSchema(db);
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('engagement_budget');
    expect(names).toContain('engagement_rate_control');
  });

  it('readUsage seeds a fresh row + reports normal state', () => {
    const db = inMemoryDb();
    const rc = createEngagementRateControlStore(db);
    const usage = rc.readUsage({
      connection_id: 'acme-hubspot',
      vendor: 'hubspot',
      now: FIXED_NOW,
    });
    expect(usage.daily_budget).toBe(HUBSPOT_DAILY_BUDGET_DEFAULT);
    expect(usage.calls_today).toBe(0);
    expect(usage.rate_control_state).toBe('normal');
  });

  it('recordUsage increments calls_today + transitions through degrade tiers', () => {
    const db = inMemoryDb();
    const rc = createEngagementRateControlStore(db);
    rc.setBudget({
      connection_id: 'acme-hubspot',
      vendor: 'hubspot',
      daily_budget: 100,
      now: FIXED_NOW,
    });
    rc.recordUsage({
      connection_id: 'acme-hubspot',
      vendor: 'hubspot',
      n: 79,
      now: FIXED_NOW,
    });
    expect(
      rc.readUsage({
        connection_id: 'acme-hubspot',
        vendor: 'hubspot',
        now: FIXED_NOW,
      }).rate_control_state,
    ).toBe('normal');
    rc.recordUsage({
      connection_id: 'acme-hubspot',
      vendor: 'hubspot',
      n: 5,
      now: FIXED_NOW,
    });
    expect(
      rc.readUsage({
        connection_id: 'acme-hubspot',
        vendor: 'hubspot',
        now: FIXED_NOW,
      }).rate_control_state,
    ).toBe('degraded_30m');
    rc.recordUsage({
      connection_id: 'acme-hubspot',
      vendor: 'hubspot',
      n: 12,
      now: FIXED_NOW,
    });
    expect(
      rc.readUsage({
        connection_id: 'acme-hubspot',
        vendor: 'hubspot',
        now: FIXED_NOW,
      }).rate_control_state,
    ).toBe('degraded_1h');
    rc.recordUsage({
      connection_id: 'acme-hubspot',
      vendor: 'hubspot',
      n: 4,
      now: FIXED_NOW,
    });
    expect(
      rc.readUsage({
        connection_id: 'acme-hubspot',
        vendor: 'hubspot',
        now: FIXED_NOW,
      }).rate_control_state,
    ).toBe('suspended');
  });

  it('two HubSpot portals enforce budgets independently', () => {
    const db = inMemoryDb();
    const rc = createEngagementRateControlStore(db);
    rc.setBudget({
      connection_id: 'acme-hubspot',
      vendor: 'hubspot',
      daily_budget: 100,
      now: FIXED_NOW,
    });
    rc.setBudget({
      connection_id: 'partner-hubspot',
      vendor: 'hubspot',
      daily_budget: 100,
      now: FIXED_NOW,
    });
    rc.recordUsage({
      connection_id: 'acme-hubspot',
      vendor: 'hubspot',
      n: 100,
      now: FIXED_NOW,
    });
    expect(
      rc.readUsage({
        connection_id: 'acme-hubspot',
        vendor: 'hubspot',
        now: FIXED_NOW,
      }).rate_control_state,
    ).toBe('suspended');
    expect(
      rc.readUsage({
        connection_id: 'partner-hubspot',
        vendor: 'hubspot',
        now: FIXED_NOW,
      }).rate_control_state,
    ).toBe('normal');
  });

  it('bucket rolls over after 24h elapsed since bucket_started_at', () => {
    const db = inMemoryDb();
    const rc = createEngagementRateControlStore(db);
    rc.setBudget({
      connection_id: 'acme-hubspot',
      vendor: 'hubspot',
      daily_budget: 10,
      now: FIXED_NOW,
    });
    rc.recordUsage({
      connection_id: 'acme-hubspot',
      vendor: 'hubspot',
      n: 10,
      now: FIXED_NOW,
    });
    expect(
      rc.readUsage({
        connection_id: 'acme-hubspot',
        vendor: 'hubspot',
        now: FIXED_NOW,
      }).rate_control_state,
    ).toBe('suspended');
    // Advance past 24h.
    const tomorrow = FIXED_NOW + 25 * 60 * 60 * 1000;
    const refreshed = rc.readUsage({
      connection_id: 'acme-hubspot',
      vendor: 'hubspot',
      now: tomorrow,
    });
    expect(refreshed.calls_today).toBe(0);
    expect(refreshed.rate_control_state).toBe('normal');
  });

  it('recordTooManyRequests doubles backoff per consecutive 429 (per-tuple)', () => {
    const db = inMemoryDb();
    const rc = createEngagementRateControlStore(db);
    const t1 = FIXED_NOW;
    const first = rc.recordTooManyRequests({
      connection_id: 'acme-hubspot',
      vendor: 'hubspot',
      entity: 'meeting',
      now: t1,
    });
    expect(first.consecutive_429s).toBe(1);
    expect(first.next_attempt_at).toBe(t1 + RATE_CONTROL_429_BACKOFF.base_ms);
    const second = rc.recordTooManyRequests({
      connection_id: 'acme-hubspot',
      vendor: 'hubspot',
      entity: 'meeting',
      now: t1 + 1000,
    });
    expect(second.consecutive_429s).toBe(2);
    expect(second.next_attempt_at).toBe(
      t1 + 1000 + RATE_CONTROL_429_BACKOFF.base_ms * 2,
    );
  });
  it('recordTooManyRequests clamps backoff at max_ms', () => {
    const db = inMemoryDb();
    const rc = createEngagementRateControlStore(db);
    for (let i = 0; i < 12; i++) {
      rc.recordTooManyRequests({
        connection_id: 'acme-hubspot',
        vendor: 'hubspot',
        entity: 'meeting',
        now: FIXED_NOW + i,
      });
    }
    const state = rc.readBackoff({
      connection_id: 'acme-hubspot',
      vendor: 'hubspot',
      entity: 'meeting',
    });
    expect(state.consecutive_429s).toBe(12);
    expect(state.next_attempt_at - FIXED_NOW - 11).toBe(
      RATE_CONTROL_429_BACKOFF.max_ms,
    );
  });
  it('recordSuccess resets consecutive_429s', () => {
    const db = inMemoryDb();
    const rc = createEngagementRateControlStore(db);
    rc.recordTooManyRequests({
      connection_id: 'acme-hubspot',
      vendor: 'hubspot',
      entity: 'task',
      now: FIXED_NOW,
    });
    rc.recordSuccess({
      connection_id: 'acme-hubspot',
      vendor: 'hubspot',
      entity: 'task',
    });
    const state = rc.readBackoff({
      connection_id: 'acme-hubspot',
      vendor: 'hubspot',
      entity: 'task',
    });
    expect(state.consecutive_429s).toBe(0);
    expect(state.next_attempt_at).toBe(0);
  });
  it('429 backoff is per-tuple — one entity hitting 429 doesn’t pause its siblings', () => {
    const db = inMemoryDb();
    const rc = createEngagementRateControlStore(db);
    rc.recordTooManyRequests({
      connection_id: 'acme-hubspot',
      vendor: 'hubspot',
      entity: 'meeting',
      now: FIXED_NOW,
    });
    expect(
      rc.readBackoff({
        connection_id: 'acme-hubspot',
        vendor: 'hubspot',
        entity: 'note',
      }).consecutive_429s,
    ).toBe(0);
  });

  it('deriveRateControlState pure function maps utilization → state', () => {
    expect(deriveRateControlState(0.5)).toBe('normal');
    expect(deriveRateControlState(RATE_CONTROL_THRESHOLDS.degraded_30m)).toBe(
      'degraded_30m',
    );
    expect(deriveRateControlState(0.95)).toBe('degraded_1h');
    expect(deriveRateControlState(1.0)).toBe('suspended');
    expect(deriveRateControlState(2.0)).toBe('suspended');
  });

  it('computeNextAttemptAt: zero counter → 0 (no backoff)', () => {
    expect(computeNextAttemptAt(0, null)).toBe(0);
    expect(computeNextAttemptAt(0, 1234567890)).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// Per-cycle association-rescan substrate (§ A.6.3)
// ────────────────────────────────────────────────────────────────

describe('D-139 P1a.2 — per-cycle association-rescan substrate', () => {
  const seedMeetingRow = (
    store: ReturnType<typeof createEngagementStore>,
    target_id = 'hubspot_meeting_301',
    overrides: Parameters<typeof projectMeetingEngagementRow>[2] = {
      now: FIXED_NOW,
      calendarTwinMatch: null,
      defaultTzHint: 'UTC',
    },
  ): void => {
    const row = projectMeetingEngagementRow(
      'acme-hubspot',
      rawMeeting({}, target_id.replace('hubspot_meeting_', '')),
      overrides,
    );
    store.upsert({ row });
  };

  it('P1a.1.1 — capability gate honored: skips when association_rescan_required = false AND streaming_active = true (healthy-streaming connection)', async () => {
    // P1a.1.1 posture (Codex P1 #2 fold-back): edge-only webhook
    // write path lands; rescan gate is now honored ONLY when:
    //   (a) capability map says `association_rescan_required: false`
    //   (b) caller asserts `streaming_active: true` (applier wired +
    //       recent ledger evidence)
    // The capability flag alone is not sufficient — without an
    // applier the webhook still drops associationChange unledgered
    // and only the rescan can recover the missing edges.
    const { store, capStore, rcStore } = makeStores();
    capStore.upsert({
      connection_id: 'acme-hubspot',
      vendor: 'hubspot',
      entity: 'meeting',
      available: true,
      association_rescan_required: false,
      last_probed_at: FIXED_NOW,
    });
    seedMeetingRow(store);
    const out = await runAssociationRescan(
      {
        connection: { _id: 'c1' } as never,
        connection_id: 'acme-hubspot',
        vendor: 'hubspot',
        entity: 'meeting',
        fetcher: () => ({ edges: [], api_calls_consumed: 1 }),
        now: FIXED_NOW,
        resolveContactRedirect: () => null,
        streaming_active: true,
      },
      {
        engagementStore: store,
        capabilityStore: capStore,
        rateControlStore: rcStore,
      },
    );
    // Sweep skipped — capability + streaming-active both green.
    expect(out.engagements_scanned).toBe(0);
    expect(out.engagements_fetched).toBe(0);
    expect(out.api_calls_consumed).toBe(0);
  });

  it('P1a.1.1 — capability flag alone insufficient: rescan runs when streaming_active is omitted (Codex P1 #2 fold-back)', async () => {
    // Without a `streaming_active: true` assertion, the rescan does
    // NOT trust the capability flag. This guards the no-applier-
    // wired case where the webhook drops associationChange + only
    // the rescan recovers the missing edges.
    const { store, capStore, rcStore } = makeStores();
    capStore.upsert({
      connection_id: 'acme-hubspot',
      vendor: 'hubspot',
      entity: 'meeting',
      available: true,
      association_rescan_required: false,
      last_probed_at: FIXED_NOW,
    });
    seedMeetingRow(store);
    const out = await runAssociationRescan(
      {
        connection: { _id: 'c1' } as never,
        connection_id: 'acme-hubspot',
        vendor: 'hubspot',
        entity: 'meeting',
        fetcher: () => ({ edges: [], api_calls_consumed: 1 }),
        now: FIXED_NOW,
        resolveContactRedirect: () => null,
        // streaming_active omitted (defaults to false).
      },
      {
        engagementStore: store,
        capabilityStore: capStore,
        rateControlStore: rcStore,
      },
    );
    expect(out.engagements_scanned).toBe(1);
    expect(out.engagements_fetched).toBe(1);
  });

  it('P1a.1.1 — force_run override bypasses the capability gate (manual / diagnostic rescan flow)', async () => {
    const { store, capStore, rcStore } = makeStores();
    capStore.upsert({
      connection_id: 'acme-hubspot',
      vendor: 'hubspot',
      entity: 'meeting',
      available: true,
      association_rescan_required: false,
      last_probed_at: FIXED_NOW,
    });
    seedMeetingRow(store);
    const out = await runAssociationRescan(
      {
        connection: { _id: 'c1' } as never,
        connection_id: 'acme-hubspot',
        vendor: 'hubspot',
        entity: 'meeting',
        fetcher: () => ({ edges: [], api_calls_consumed: 1 }),
        now: FIXED_NOW,
        resolveContactRedirect: () => null,
        force_run: true,
      },
      {
        engagementStore: store,
        capabilityStore: capStore,
        rateControlStore: rcStore,
      },
    );
    // force_run bypasses the gate.
    expect(out.engagements_scanned).toBe(1);
    expect(out.engagements_fetched).toBe(1);
  });

  it('runs sweep when association_rescan_required = true; emits new edges', async () => {
    const { store, capStore, rcStore } = makeStores();
    capStore.upsert({
      connection_id: 'acme-hubspot',
      vendor: 'hubspot',
      entity: 'meeting',
      available: true,
      association_rescan_required: true,
      last_probed_at: FIXED_NOW,
    });
    seedMeetingRow(store);
    const out = await runAssociationRescan(
      {
        connection: { _id: 'c1' } as never,
        connection_id: 'acme-hubspot',
        vendor: 'hubspot',
        entity: 'meeting',
        fetcher: () => ({
          edges: [
            {
              edge_type: 'contact',
              target_kind: 'data.contact',
              target_id: 'bob@acme.com',
            },
            {
              edge_type: 'contact',
              target_kind: 'data.contact',
              target_id: 'newperson@acme.com',
            },
          ],
          api_calls_consumed: 1,
        }),
        now: FIXED_NOW,
        resolveContactRedirect: () => null,
      },
      {
        engagementStore: store,
        capabilityStore: capStore,
        rateControlStore: rcStore,
      },
    );
    expect(out.engagements_fetched).toBe(1);
    expect(out.edges_created).toBe(2);
    expect(out.edges_tombstoned).toBe(0);
    expect(out.api_calls_consumed).toBe(1);
    const edges = store.listEdges({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_meeting_301',
    });
    expect(edges.length).toBeGreaterThanOrEqual(2);
  });

  it('tombstones edges that disappeared between cycles', async () => {
    const { store, capStore, rcStore } = makeStores();
    capStore.upsert({
      connection_id: 'acme-hubspot',
      vendor: 'hubspot',
      entity: 'meeting',
      available: true,
      association_rescan_required: true,
      last_probed_at: FIXED_NOW,
    });
    seedMeetingRow(store);
    // Seed an existing edge.
    store.upsertEdge({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_meeting_301',
      edge_type: 'contact',
      target_kind: 'data.contact',
      target_id: 'olduser@acme.com',
      vendor: 'hubspot',
      created_at: FIXED_NOW - 1000,
      resolveContactRedirect: () => null,
    });
    // Sweep returns NO edges — substrate must tombstone the existing.
    const out = await runAssociationRescan(
      {
        connection: { _id: 'c1' } as never,
        connection_id: 'acme-hubspot',
        vendor: 'hubspot',
        entity: 'meeting',
        fetcher: () => ({ edges: [], api_calls_consumed: 1 }),
        now: FIXED_NOW,
        resolveContactRedirect: () => null,
      },
      {
        engagementStore: store,
        capabilityStore: capStore,
        rateControlStore: rcStore,
      },
    );
    expect(out.edges_tombstoned).toBe(1);
    const active = store.listEdges({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_meeting_301',
    });
    expect(active.length).toBe(0);
  });

  it('skips engagement when budget already suspended', async () => {
    const { store, capStore, rcStore } = makeStores();
    capStore.upsert({
      connection_id: 'acme-hubspot',
      vendor: 'hubspot',
      entity: 'meeting',
      available: true,
      association_rescan_required: true,
      last_probed_at: FIXED_NOW,
    });
    rcStore.setBudget({
      connection_id: 'acme-hubspot',
      vendor: 'hubspot',
      daily_budget: 1,
      now: FIXED_NOW,
    });
    rcStore.recordUsage({
      connection_id: 'acme-hubspot',
      vendor: 'hubspot',
      n: 1,
      now: FIXED_NOW,
    });
    seedMeetingRow(store);
    const out = await runAssociationRescan(
      {
        connection: { _id: 'c1' } as never,
        connection_id: 'acme-hubspot',
        vendor: 'hubspot',
        entity: 'meeting',
        fetcher: () => ({ edges: [], api_calls_consumed: 1 }),
        now: FIXED_NOW,
        resolveContactRedirect: () => null,
      },
      {
        engagementStore: store,
        capabilityStore: capStore,
        rateControlStore: rcStore,
      },
    );
    expect(out.suspended).toBe(true);
    expect(out.engagements_fetched).toBe(0);
  });

  it('respects per-invocation page cap; remainder lands in pending_target_ids', async () => {
    const { store, capStore, rcStore } = makeStores();
    capStore.upsert({
      connection_id: 'acme-hubspot',
      vendor: 'hubspot',
      entity: 'meeting',
      available: true,
      association_rescan_required: true,
      last_probed_at: FIXED_NOW,
    });
    for (let i = 1; i <= 15; i++) {
      seedMeetingRow(store, `hubspot_meeting_${i}`);
    }
    const fetched: string[] = [];
    const out = await runAssociationRescan(
      {
        connection: { _id: 'c1' } as never,
        connection_id: 'acme-hubspot',
        vendor: 'hubspot',
        entity: 'meeting',
        fetcher: ({ target_id }) => {
          fetched.push(target_id);
          return { edges: [], api_calls_consumed: 1 };
        },
        now: FIXED_NOW,
        page_cap: 5,
        resolveContactRedirect: () => null,
      },
      {
        engagementStore: store,
        capabilityStore: capStore,
        rateControlStore: rcStore,
      },
    );
    expect(out.engagements_fetched).toBe(5);
    expect(out.pending_target_ids.length).toBe(10);
    expect(fetched.length).toBe(5);
  });

  it('eligibility filter excludes cancelled + tombstoned + out-of-window engagements', async () => {
    const { store, capStore, rcStore } = makeStores();
    capStore.upsert({
      connection_id: 'acme-hubspot',
      vendor: 'hubspot',
      entity: 'meeting',
      available: true,
      association_rescan_required: true,
      last_probed_at: FIXED_NOW,
    });
    // One eligible, one cancelled, one out-of-window.
    seedMeetingRow(store, 'hubspot_meeting_eligible');
    const cancelledRow = projectMeetingEngagementRow(
      'acme-hubspot',
      rawMeeting(
        { hs_meeting_outcome: 'CANCELED' },
        'cancelled',
      ),
      { now: FIXED_NOW, calendarTwinMatch: null, defaultTzHint: 'UTC' },
    );
    store.upsert({ row: cancelledRow });
    const oldRow = projectMeetingEngagementRow(
      'acme-hubspot',
      rawMeeting(
        { hs_lastmodifieddate: String(FIXED_NOW - 30 * 86400000) },
        'old',
      ),
      { now: FIXED_NOW, calendarTwinMatch: null, defaultTzHint: 'UTC' },
    );
    store.upsert({ row: oldRow });
    // Force at least one edge so the listEdges fallback enumerator
    // surfaces all candidates.
    store.upsertEdge({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_meeting_eligible',
      edge_type: 'owner',
      target_kind: 'user',
      target_id: 'user-1',
      vendor: 'hubspot',
      created_at: FIXED_NOW,
    });
    store.upsertEdge({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_meeting_cancelled',
      edge_type: 'owner',
      target_kind: 'user',
      target_id: 'user-1',
      vendor: 'hubspot',
      created_at: FIXED_NOW,
    });
    store.upsertEdge({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_meeting_old',
      edge_type: 'owner',
      target_kind: 'user',
      target_id: 'user-1',
      vendor: 'hubspot',
      created_at: FIXED_NOW,
    });
    const fetched: string[] = [];
    const out = await runAssociationRescan(
      {
        connection: { _id: 'c1' } as never,
        connection_id: 'acme-hubspot',
        vendor: 'hubspot',
        entity: 'meeting',
        fetcher: ({ target_id }) => {
          fetched.push(target_id);
          return { edges: [], api_calls_consumed: 1 };
        },
        now: FIXED_NOW,
        resolveContactRedirect: () => null,
      },
      {
        engagementStore: store,
        capabilityStore: capStore,
        rateControlStore: rcStore,
      },
    );
    expect(fetched).toContain('hubspot_meeting_eligible');
    expect(fetched).not.toContain('hubspot_meeting_cancelled');
    expect(fetched).not.toContain('hubspot_meeting_old');
    expect(out.engagements_scanned).toBe(1);
  });

  it('skips when per-tuple 429 backoff is active', async () => {
    const { store, capStore, rcStore } = makeStores();
    capStore.upsert({
      connection_id: 'acme-hubspot',
      vendor: 'hubspot',
      entity: 'meeting',
      available: true,
      association_rescan_required: true,
      last_probed_at: FIXED_NOW,
    });
    rcStore.recordTooManyRequests({
      connection_id: 'acme-hubspot',
      vendor: 'hubspot',
      entity: 'meeting',
      now: FIXED_NOW,
    });
    seedMeetingRow(store);
    const out = await runAssociationRescan(
      {
        connection: { _id: 'c1' } as never,
        connection_id: 'acme-hubspot',
        vendor: 'hubspot',
        entity: 'meeting',
        fetcher: () => ({ edges: [], api_calls_consumed: 1 }),
        now: FIXED_NOW + 1, // still inside the 30s backoff window
        resolveContactRedirect: () => null,
      },
      {
        engagementStore: store,
        capabilityStore: capStore,
        rateControlStore: rcStore,
      },
    );
    expect(out.backoff_active).toBe(true);
    expect(out.engagements_fetched).toBe(0);
  });

  it('rescan eligibility constants surface', () => {
    expect(RESCAN_ELIGIBLE_LIFECYCLE_STATES).toContain('point_in_time');
    expect(RESCAN_ELIGIBLE_LIFECYCLE_STATES).toContain('completed');
    expect(RESCAN_ELIGIBLE_LIFECYCLE_STATES).toContain('scheduled');
  });

  it('Codex fold P1 #2 — page-capped sweep returns next_cursor; subsequent invocation resumes the tail', async () => {
    const { store, capStore, rcStore } = makeStores();
    capStore.upsert({
      connection_id: 'acme-hubspot',
      vendor: 'hubspot',
      entity: 'meeting',
      available: true,
      association_rescan_required: true,
      last_probed_at: FIXED_NOW,
    });
    for (let i = 1; i <= 12; i++) {
      seedMeetingRow(store, `hubspot_meeting_${String(i).padStart(3, '0')}`);
    }
    const fetcher = ({
      target_id,
    }: {
      target_id: string;
    }): { edges: never[]; api_calls_consumed: number } => {
      void target_id;
      return { edges: [], api_calls_consumed: 1 };
    };
    const first = await runAssociationRescan(
      {
        connection: { _id: 'c1' } as never,
        connection_id: 'acme-hubspot',
        vendor: 'hubspot',
        entity: 'meeting',
        fetcher,
        now: FIXED_NOW,
        page_cap: 5,
        resolveContactRedirect: () => null,
      },
      {
        engagementStore: store,
        capabilityStore: capStore,
        rateControlStore: rcStore,
      },
    );
    expect(first.engagements_fetched).toBe(5);
    expect(first.next_cursor).toBe('hubspot_meeting_005');
    expect(first.pending_target_ids.length).toBe(7);

    const second = await runAssociationRescan(
      {
        connection: { _id: 'c1' } as never,
        connection_id: 'acme-hubspot',
        vendor: 'hubspot',
        entity: 'meeting',
        fetcher,
        now: FIXED_NOW,
        page_cap: 5,
        cursor: first.next_cursor!,
        resolveContactRedirect: () => null,
      },
      {
        engagementStore: store,
        capabilityStore: capStore,
        rateControlStore: rcStore,
      },
    );
    // Second cycle picks up rows after target_id 005.
    expect(second.engagements_fetched).toBe(5);
    expect(second.next_cursor).toBe('hubspot_meeting_010');

    const third = await runAssociationRescan(
      {
        connection: { _id: 'c1' } as never,
        connection_id: 'acme-hubspot',
        vendor: 'hubspot',
        entity: 'meeting',
        fetcher,
        now: FIXED_NOW,
        page_cap: 5,
        cursor: second.next_cursor!,
        resolveContactRedirect: () => null,
      },
      {
        engagementStore: store,
        capabilityStore: capStore,
        rateControlStore: rcStore,
      },
    );
    // Third cycle picks up the last 2 rows + exhausts; next_cursor null.
    expect(third.engagements_fetched).toBe(2);
    expect(third.pending_target_ids.length).toBe(0);
    expect(third.next_cursor).toBeNull();
  });

  it('Codex fold P1 #3 — contact-edge diff routes incoming target_id through D-138 BEFORE diff-key match (no spurious tombstone)', async () => {
    const { store, capStore, rcStore } = makeStores();
    capStore.upsert({
      connection_id: 'acme-hubspot',
      vendor: 'hubspot',
      entity: 'meeting',
      available: true,
      association_rescan_required: true,
      last_probed_at: FIXED_NOW,
    });
    seedMeetingRow(store);
    // Seed an existing contact edge under the survivor canonical
    // (matching what the engagement-store already wrote on first
    // ingest after D-138 routing).
    store.upsertEdge({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_meeting_301',
      edge_type: 'contact',
      target_kind: 'data.contact',
      target_id: 'robert@acme.com', // survivor
      vendor: 'hubspot',
      created_at: FIXED_NOW - 1000,
      resolveContactRedirect: () => null,
    });
    // Vendor still surfaces the loser email (HubSpot doesn't know
    // about Recued's local D-138 merge); rescan must resolve before
    // diffing.
    const out = await runAssociationRescan(
      {
        connection: { _id: 'c1' } as never,
        connection_id: 'acme-hubspot',
        vendor: 'hubspot',
        entity: 'meeting',
        fetcher: () => ({
          edges: [
            {
              edge_type: 'contact',
              target_kind: 'data.contact',
              target_id: 'bob@acme.com', // loser
            },
          ],
          api_calls_consumed: 1,
        }),
        now: FIXED_NOW,
        resolveContactRedirect: (canonical) =>
          canonical === 'bob@acme.com'
            ? { merged_into: 'robert@acme.com' }
            : null,
      },
      {
        engagementStore: store,
        capabilityStore: capStore,
        rateControlStore: rcStore,
      },
    );
    // Survivor edge stays (incomingKeys built post-resolution
    // matches existingKeys); zero tombstones, zero new creates.
    expect(out.edges_tombstoned).toBe(0);
    expect(out.edges_created).toBe(0);
    const survivorEdges = store.listEdges({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_meeting_301',
      edge_type: 'contact',
    });
    expect(survivorEdges.map((e) => e.target_id)).toContain('robert@acme.com');
    expect(survivorEdges.map((e) => e.target_id)).not.toContain('bob@acme.com');
  });

  it('Codex fold P1 #4 — diff scoped to CRM edge_types; local owner/calendar_twin edges stay alone', async () => {
    const { store, capStore, rcStore } = makeStores();
    capStore.upsert({
      connection_id: 'acme-hubspot',
      vendor: 'hubspot',
      entity: 'meeting',
      available: true,
      association_rescan_required: true,
      last_probed_at: FIXED_NOW,
    });
    seedMeetingRow(store);
    // Seed a local-only owner edge + calendar_twin edge — these are
    // written by the reconciler at row-ingest, not through HubSpot
    // associations API.
    store.upsertEdge({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_meeting_301',
      edge_type: 'owner',
      target_kind: 'user',
      target_id: 'hubspot_owner_id:777',
      vendor: 'hubspot',
      created_at: FIXED_NOW - 1000,
    });
    store.upsertEdge({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_meeting_301',
      edge_type: 'calendar_twin',
      target_kind: 'data.calendar',
      target_id: 'cal-row-1',
      vendor: 'hubspot',
      created_at: FIXED_NOW - 1000,
    });
    // Sweep returns ONLY CRM edges (contact). owner + calendar_twin
    // are NOT in the fetcher result because the vendor association
    // API doesn't expose them.
    const out = await runAssociationRescan(
      {
        connection: { _id: 'c1' } as never,
        connection_id: 'acme-hubspot',
        vendor: 'hubspot',
        entity: 'meeting',
        fetcher: () => ({ edges: [], api_calls_consumed: 1 }),
        now: FIXED_NOW,
        resolveContactRedirect: () => null,
      },
      {
        engagementStore: store,
        capabilityStore: capStore,
        rateControlStore: rcStore,
      },
    );
    // No tombstones — local edges stayed out of scope.
    expect(out.edges_tombstoned).toBe(0);
    const surviving = store.listEdges({
      connection_id: 'acme-hubspot',
      engagement_target_id: 'hubspot_meeting_301',
    });
    const types = surviving.map((e) => e.edge_type).sort();
    expect(types).toContain('owner');
    expect(types).toContain('calendar_twin');
  });
});

describe('D-139 P1a.2 Codex fold-back — projection corrections', () => {
  it('Codex fold P2 #5 — task hs_timestamp fallback for due_at when hs_task_completion_date is empty', () => {
    const row = projectTaskEngagementRow(
      'acme-hubspot',
      rawTask({
        hs_task_completion_date: '',
        hs_timestamp: '1715040000000',
      }),
      { now: FIXED_NOW, defaultTzHint: 'UTC' },
    );
    expect(row.lifecycle_state).toBe('pending');
    expect(row.due_at).toBe(1_715_040_000_000);
  });

  it('Codex fold P2 #6 — call event_at returns NULL (not hs_createdate) when hs_timestamp is missing', () => {
    const row = projectCallEngagementRow(
      'acme-hubspot',
      rawCall({
        hs_call_status: 'COMPLETED',
        hs_timestamp: '',
      }),
      { now: FIXED_NOW, defaultTzHint: 'UTC' },
    );
    // hs_createdate is populated in the fixture but the spec is
    // hs_timestamp-only for call event_at.
    expect(row.event_at).toBeNull();
  });
});
